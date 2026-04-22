#!/usr/bin/env node
import process from "node:process";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const args = new Set(process.argv.slice(2));
const applyChanges = args.has("--apply");
const verbose = args.has("--verbose");

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 20_000;

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const zoneIdFromEnv = String(process.env.CLOUDFLARE_ZONE_ID || "").trim();
const zoneNameFromEnv = String(process.env.CLOUDFLARE_ZONE_NAME || "").trim().toLowerCase();
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const originIp = String(process.env.CLOUDFLARE_ORIGIN_IPV4 || "").trim();
const proxyMode = String(process.env.CLOUDFLARE_PROXY_MODE || "edge").trim().toLowerCase();
const includeServiceHosts = String(process.env.CLOUDFLARE_INCLUDE_SERVICE_HOSTS || "true").trim().toLowerCase() !== "false";
const ttlRaw = Number(process.env.CLOUDFLARE_DNS_TTL || "1");
const ttl = Number.isFinite(ttlRaw) ? Math.max(1, Math.min(86400, Math.floor(ttlRaw))) : 1;

const validIpv4Pattern =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function fail(message) {
  console.error(`[cloudflare-bootstrap] ${message}`);
  process.exit(1);
}

if (!token) {
  fail("CLOUDFLARE_API_TOKEN is required.");
}

if (!zoneIdFromEnv && !zoneNameFromEnv && !process.env.APP_PUBLIC_URL) {
  fail("Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME (or APP_PUBLIC_URL) to resolve the zone.");
}

if (!originIp || !validIpv4Pattern.test(originIp)) {
  fail("CLOUDFLARE_ORIGIN_IPV4 must be a valid IPv4 address.");
}

if (!["edge", "all", "dns-only"].includes(proxyMode)) {
  fail("CLOUDFLARE_PROXY_MODE must be one of: edge, all, dns-only.");
}

function parseZoneNameFromAppUrl() {
  try {
    const appUrl = String(process.env.APP_PUBLIC_URL || "").trim();
    if (!appUrl) return "";
    const hostname = new URL(appUrl).hostname.toLowerCase();
    return hostname;
  } catch {
    return "";
  }
}

function zoneNameFallback() {
  const fromUrl = parseZoneNameFromAppUrl();
  if (!fromUrl) return "";
  if (fromUrl.split(".").length <= 2) return fromUrl;
  return fromUrl.split(".").slice(-2).join(".");
}

function fqdn(zoneName, host) {
  if (host === "@") return zoneName;
  return `${host}.${zoneName}`;
}

function desiredProxy(host) {
  if (proxyMode === "dns-only") return false;
  if (proxyMode === "all") return true;
  return host === "@" || host === "www" || host === "api";
}

function desiredRecords(zoneName) {
  const hosts = ["@", "api", "www"];
  if (includeServiceHosts) {
    hosts.push("wa-api", "tg-api", "shopee-api", "meli-api", "amazon-api", "ops-api");
  }

  return hosts.map((host) => {
    if (host === "www") {
      return {
        type: "CNAME",
        name: fqdn(zoneName, host),
        content: zoneName,
        proxied: desiredProxy(host),
        ttl,
      };
    }
    return {
      type: "A",
      name: fqdn(zoneName, host),
      content: originIp,
      proxied: desiredProxy(host),
      ttl,
    };
  });
}

async function cfRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const errorMessage = Array.isArray(payload.errors)
        ? payload.errors.map((item) => item?.message || String(item)).join("; ")
        : `HTTP ${response.status}`;
      throw new Error(`${method} ${path}: ${errorMessage || `HTTP ${response.status}`}`);
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveZone() {
  if (zoneIdFromEnv) {
    const zone = await cfRequest(`/zones/${zoneIdFromEnv}`);
    if (accountId && String(zone.account?.id || "") !== accountId) {
      fail(`Zone ${zoneIdFromEnv} does not belong to CLOUDFLARE_ACCOUNT_ID ${accountId}.`);
    }
    return zone;
  }

  const lookupName = zoneNameFromEnv || zoneNameFallback();
  if (!lookupName) {
    fail("Unable to resolve zone name. Set CLOUDFLARE_ZONE_NAME explicitly.");
  }
  const query = new URLSearchParams({ name: lookupName, per_page: "50" }).toString();
  const zones = await cfRequest(`/zones?${query}`);
  const match = Array.isArray(zones)
    ? zones.find((zone) => String(zone.name || "").toLowerCase() === lookupName)
    : null;
  if (!match) {
    fail(`Cloudflare zone not found for ${lookupName}.`);
  }
  if (accountId && String(match.account?.id || "") !== accountId) {
    fail(`Zone ${lookupName} does not belong to CLOUDFLARE_ACCOUNT_ID ${accountId}.`);
  }
  return match;
}

async function listRecords(zoneId, name) {
  const query = new URLSearchParams({ name, per_page: "100" }).toString();
  const result = await cfRequest(`/zones/${zoneId}/dns_records?${query}`);
  return Array.isArray(result) ? result : [];
}

function hasDnsDrift(existing, desired) {
  const ttlMatches = desired.ttl === 1 || Number(existing.ttl) === Number(desired.ttl);
  return (
    String(existing.content || "") !== String(desired.content)
    || Boolean(existing.proxied) !== Boolean(desired.proxied)
    || !ttlMatches
  );
}

async function ensureDnsRecords(zone) {
  const desired = desiredRecords(zone.name);
  let creates = 0;
  let updates = 0;
  let unchanged = 0;

  for (const record of desired) {
    const existing = await listRecords(zone.id, record.name);
    const sameType = existing.filter((item) => String(item.type) === record.type);
    const differentType = existing.filter((item) => String(item.type) !== record.type);

    if (differentType.length > 0) {
      console.warn(
        `[cloudflare-bootstrap] warning: ${record.name} already has record(s) with different type (${differentType.map((item) => item.type).join(", ")}).`,
      );
    }

    if (sameType.length === 0) {
      creates += 1;
      console.log(`[cloudflare-bootstrap] DNS create ${record.type} ${record.name} -> ${record.content} proxied=${record.proxied}`);
      if (applyChanges) {
        await cfRequest(`/zones/${zone.id}/dns_records`, { method: "POST", body: record });
      }
      continue;
    }

    const winner = sameType[0];
    if (sameType.length > 1) {
      console.warn(`[cloudflare-bootstrap] warning: multiple ${record.type} records for ${record.name}; updating the first record id=${winner.id}.`);
    }

    if (!hasDnsDrift(winner, record)) {
      unchanged += 1;
      if (verbose) {
        console.log(`[cloudflare-bootstrap] DNS ok ${record.type} ${record.name}`);
      }
      continue;
    }

    updates += 1;
    console.log(`[cloudflare-bootstrap] DNS update ${record.type} ${record.name} -> ${record.content} proxied=${record.proxied}`);
    if (applyChanges) {
      await cfRequest(`/zones/${zone.id}/dns_records/${winner.id}`, { method: "PUT", body: { ...record, comment: winner.comment || undefined, tags: winner.tags || undefined } });
    }
  }

  return { creates, updates, unchanged };
}

async function ensureSetting(zoneId, key, expectedValue) {
  const current = await cfRequest(`/zones/${zoneId}/settings/${key}`);
  const currentValue = current?.value;
  if (String(currentValue) === String(expectedValue)) {
    if (verbose) {
      console.log(`[cloudflare-bootstrap] setting ok ${key}=${expectedValue}`);
    }
    return { changed: false };
  }
  console.log(`[cloudflare-bootstrap] setting ${key}: ${currentValue} -> ${expectedValue}`);
  if (applyChanges) {
    await cfRequest(`/zones/${zoneId}/settings/${key}`, { method: "PATCH", body: { value: expectedValue } });
  }
  return { changed: true };
}

async function ensureSettings(zoneId) {
  const desired = [
    ["ssl", "strict"],
    ["always_use_https", "on"],
    ["min_tls_version", "1.2"],
    ["tls_1_3", "on"],
    ["automatic_https_rewrites", "on"],
  ];

  let changed = 0;
  for (const [key, value] of desired) {
    const result = await ensureSetting(zoneId, key, value);
    if (result.changed) changed += 1;
  }
  return { changed, total: desired.length };
}

async function main() {
  console.log(`[cloudflare-bootstrap] mode=${applyChanges ? "apply" : "dry-run"} proxy_mode=${proxyMode}`);
  const zone = await resolveZone();
  console.log(`[cloudflare-bootstrap] zone=${zone.name} id=${zone.id} status=${zone.status}`);
  if (Array.isArray(zone.name_servers) && zone.name_servers.length > 0) {
    console.log(`[cloudflare-bootstrap] nameservers=${zone.name_servers.join(", ")}`);
  }
  if (zone.status !== "active") {
    console.warn("[cloudflare-bootstrap] warning: zone is not active yet. DNS/settings are staged and will apply after nameserver cutover.");
  }

  const dnsSummary = await ensureDnsRecords(zone);
  const settingsSummary = await ensureSettings(zone.id);

  console.log(
    `[cloudflare-bootstrap] summary dns(create=${dnsSummary.creates}, update=${dnsSummary.updates}, unchanged=${dnsSummary.unchanged}) settings(changed=${settingsSummary.changed}/${settingsSummary.total})`,
  );

  if (!applyChanges) {
    console.log("[cloudflare-bootstrap] dry-run completed. Re-run with --apply to persist changes.");
  } else {
    console.log("[cloudflare-bootstrap] apply completed successfully.");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
