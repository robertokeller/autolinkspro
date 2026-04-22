#!/usr/bin/env node
import process from "node:process";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const args = new Set(process.argv.slice(2));
const expectActive = args.has("--expect-active");
const strict = args.has("--strict");
const verbose = args.has("--verbose");

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const zoneIdFromEnv = String(process.env.CLOUDFLARE_ZONE_ID || "").trim();
const zoneNameFromEnv = String(process.env.CLOUDFLARE_ZONE_NAME || "").trim().toLowerCase();
const includeServiceHosts = String(process.env.CLOUDFLARE_INCLUDE_SERVICE_HOSTS || "true").trim().toLowerCase() !== "false";

const appPublicUrl = String(process.env.APP_PUBLIC_URL || "").trim();
const apiPublicUrl = String(process.env.API_PUBLIC_URL || "").trim();
const webhookSecret = String(process.env.SMOKE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "").trim();
const opsToken = String(process.env.SMOKE_OPS_TOKEN || process.env.OPS_CONTROL_TOKEN || "").trim();

let failures = 0;
let warnings = 0;

function fail(message) {
  failures += 1;
  console.error(`[cloudflare-verify] FAIL ${message}`);
}

function warn(message) {
  warnings += 1;
  console.warn(`[cloudflare-verify] WARN ${message}`);
}

function ok(message) {
  console.log(`[cloudflare-verify] OK ${message}`);
}

if (!token) {
  fail("CLOUDFLARE_API_TOKEN is required.");
}

if (token.startsWith("cfut_")) {
  warn("token prefix cfut_ indicates a user token. For durable automation, prefer account-owned tokens (cfat_).");
}

if (!zoneIdFromEnv && !zoneNameFromEnv && !appPublicUrl) {
  fail("Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME (or APP_PUBLIC_URL) to resolve the zone.");
}

function parseZoneFromAppUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.split(".").length <= 2) return hostname;
    return hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}

function zoneNameFallback() {
  if (zoneNameFromEnv) return zoneNameFromEnv;
  return parseZoneFromAppUrl(appPublicUrl);
}

function expectedHosts(zoneName) {
  const hosts = [
    zoneName,
    `www.${zoneName}`,
    `api.${zoneName}`,
  ];
  if (includeServiceHosts) {
    hosts.push(
      `wa-api.${zoneName}`,
      `tg-api.${zoneName}`,
      `shopee-api.${zoneName}`,
      `meli-api.${zoneName}`,
      `amazon-api.${zoneName}`,
      `ops-api.${zoneName}`,
    );
  }
  return hosts;
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
    return await cfRequest(`/zones/${zoneIdFromEnv}`);
  }
  const zoneName = zoneNameFallback();
  if (!zoneName) {
    throw new Error("Could not resolve zone name.");
  }
  const query = new URLSearchParams({ name: zoneName, per_page: "50" }).toString();
  const zones = await cfRequest(`/zones?${query}`);
  const match = Array.isArray(zones)
    ? zones.find((zone) => String(zone.name || "").toLowerCase() === zoneName)
    : null;
  if (!match) {
    throw new Error(`Zone not found for ${zoneName}.`);
  }
  return match;
}

async function getSetting(zoneId, key) {
  const result = await cfRequest(`/zones/${zoneId}/settings/${key}`);
  return result?.value;
}

async function verifyDns(zone) {
  const hosts = expectedHosts(zone.name);
  for (const host of hosts) {
    const query = new URLSearchParams({ name: host, per_page: "50" }).toString();
    const records = await cfRequest(`/zones/${zone.id}/dns_records?${query}`);
    const list = Array.isArray(records) ? records : [];
    if (list.length === 0) {
      fail(`DNS record missing for ${host}`);
      continue;
    }
    const record = list[0];
    ok(`DNS ${host} type=${record.type} content=${record.content} proxied=${record.proxied}`);
    if (verbose && list.length > 1) {
      warn(`DNS ${host} has ${list.length} records; using first for validation output.`);
    }
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHttp(label, url, options = {}) {
  if (!url) {
    warn(`${label}: URL not configured, skipping.`);
    return;
  }
  try {
    const res = await fetchWithTimeout(url, options);
    const cfRay = res.headers.get("cf-ray");
    const via = res.headers.get("server");
    const hasCloudflare = Boolean(cfRay) || String(via || "").toLowerCase().includes("cloudflare");
    ok(`${label}: status=${res.status}${hasCloudflare ? " via-cloudflare" : " origin-direct"}`);
    if (!hasCloudflare) {
      warn(`${label}: response does not contain Cloudflare edge headers yet.`);
    }
    if (strict && !hasCloudflare) {
      fail(`${label}: strict mode requires Cloudflare edge headers.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${label}: ${message}`);
  }
}

async function main() {
  if (failures > 0) {
    process.exit(1);
  }

  const zone = await resolveZone();
  ok(`zone=${zone.name} id=${zone.id} status=${zone.status}`);
  if (Array.isArray(zone.name_servers) && zone.name_servers.length > 0) {
    ok(`nameservers=${zone.name_servers.join(", ")}`);
  }

  if (expectActive && zone.status !== "active") {
    fail(`zone status is ${zone.status}, expected active`);
  } else if (zone.status !== "active") {
    warn(`zone status is ${zone.status}. Keep going, but cutover is not active yet.`);
  }

  await verifyDns(zone);

  const settings = [
    "ssl",
    "always_use_https",
    "min_tls_version",
    "tls_1_3",
    "automatic_https_rewrites",
  ];
  for (const key of settings) {
    const value = await getSetting(zone.id, key);
    ok(`setting ${key}=${value}`);
  }

  await checkHttp("web /", appPublicUrl ? `${appPublicUrl.replace(/\/+$/, "")}/` : "");
  await checkHttp("api /health", apiPublicUrl ? `${apiPublicUrl.replace(/\/+$/, "")}/health` : "");

  if (includeServiceHosts && zone.status === "active") {
    await checkHttp("wa-api /health", `https://wa-api.${zone.name}/health`);
    await checkHttp("tg-api /health", `https://tg-api.${zone.name}/health`);
    await checkHttp("shopee-api /health", `https://shopee-api.${zone.name}/health`);
    await checkHttp(
      "meli-api /api/meli/health",
      `https://meli-api.${zone.name}/api/meli/health`,
      webhookSecret ? { headers: { "x-webhook-secret": webhookSecret } } : {},
    );
    await checkHttp(
      "amazon-api /health",
      `https://amazon-api.${zone.name}/health`,
      webhookSecret ? { headers: { "x-webhook-secret": webhookSecret } } : {},
    );
    await checkHttp(
      "ops-api /health",
      `https://ops-api.${zone.name}/health`,
      opsToken ? { headers: { "x-ops-token": opsToken } } : {},
    );
  }

  if (failures > 0) {
    console.error(`[cloudflare-verify] failed with ${failures} error(s) and ${warnings} warning(s).`);
    process.exit(1);
  }

  console.log(`[cloudflare-verify] completed with ${warnings} warning(s).`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
  console.error(`[cloudflare-verify] failed with ${failures} error(s) and ${warnings} warning(s).`);
  process.exit(1);
});
