import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { timingSafeEqual, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const PORT = Number.parseInt(process.env.PORT || "3115", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MEM_WARN_PERCENT = Number.parseFloat(process.env.OPS_MEM_WARN_PERCENT || "80");
const MEM_CRITICAL_PERCENT = Number.parseFloat(process.env.OPS_MEM_CRITICAL_PERCENT || "90");
const LOAD_WARN_PER_CPU = Number.parseFloat(process.env.OPS_LOAD_WARN_PER_CPU || "1.5");
const LOAD_CRITICAL_PER_CPU = Number.parseFloat(process.env.OPS_LOAD_CRITICAL_PER_CPU || "2.0");
const OPS_CONTROL_TOKEN = String(process.env.OPS_CONTROL_TOKEN || "").trim();
const SERVICE_HEALTH_SECRET = String(process.env.WEBHOOK_SECRET || process.env.OPS_CONTROL_TOKEN || "").trim();
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
// Restrict CORS to explicit origin list. Accepts comma-separated origins (same format as the API service).
const CORS_ORIGIN_RAW = String(process.env.CORS_ORIGIN || "").trim();
const ALLOWED_ORIGINS = CORS_ORIGIN_RAW
  ? CORS_ORIGIN_RAW.split(",").map((o) => o.trim()).filter(Boolean)
  : [];
const ALLOW_WILDCARD_CORS = NODE_ENV !== "production" && ALLOWED_ORIGINS.length === 0;
if (NODE_ENV === "production" && ALLOWED_ORIGINS.length === 0) {
  throw new Error("[ops-control] CORS_ORIGIN is required in production");
}
if (NODE_ENV === "production" && ALLOWED_ORIGINS.includes("*")) {
  throw new Error("[ops-control] CORS_ORIGIN='*' is not allowed in production");
}
const allowInsecureFlag = String(process.env.ALLOW_INSECURE_NO_TOKEN || "").toLowerCase() === "true";
const ALLOW_INSECURE_NO_TOKEN = allowInsecureFlag || (NODE_ENV !== "production" && !OPS_CONTROL_TOKEN);
const OPS_RUNTIME_MODE = String(process.env.OPS_RUNTIME_MODE || "local").trim().toLowerCase();
const IS_DOCKER_MODE = OPS_RUNTIME_MODE === "docker";
const DOCKER_CONTROL_ENABLED = String(process.env.DOCKER_CONTROL_ENABLED || "true").trim().toLowerCase() !== "false";
const DOCKER_SERVICE_LABEL_KEY = String(process.env.DOCKER_SERVICE_LABEL_KEY || "com.docker.compose.service").trim() || "com.docker.compose.service";
const IS_WINDOWS = process.platform === "win32";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

function resolveBundledNpmCli() {
  // Most Node installs bundle npm at: <nodeDir>/node_modules/npm/bin/npm-cli.js
  // Using `node npm-cli.js` avoids relying on `npm` being available on PATH.
  try {
    const nodeDir = path.dirname(process.execPath);
    const candidate = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

const BUNDLED_NPM_CLI = resolveBundledNpmCli();

function makeNpmCommandArgs(args) {
  if (BUNDLED_NPM_CLI) {
    return { command: process.execPath, commandArgs: [BUNDLED_NPM_CLI, ...args], shell: false };
  }
  if (IS_WINDOWS) {
    return { command: "npm.cmd", commandArgs: args, shell: false };
  }
  return { command: "npm", commandArgs: args, shell: false };
}

const SERVICE_APP_MAP = {
  whatsapp: "autolinks-whatsapp",
  telegram: "autolinks-telegram",
  shopee: "autolinks-shopee",
  meli: "autolinks-meli",
  amazon: "autolinks-amazon",
};

const LOCAL_SERVICE_CONFIG = {
  whatsapp: { serviceCwd: "services/whatsapp-baileys", distEntry: "services/whatsapp-baileys/dist/server.js", healthPath: "/health", defaultPort: 3111, portEnvKey: "PORT" },
  telegram: { serviceCwd: "services/telegram-telegraph", distEntry: "services/telegram-telegraph/dist/server.js", healthPath: "/health", defaultPort: 3112, portEnvKey: "PORT" },
  shopee: { serviceCwd: "services/shopee-affiliate", distEntry: "services/shopee-affiliate/dist/server.js", healthPath: "/health", defaultPort: 3113, portEnvKey: "PORT" },
  meli: { serviceCwd: "services/mercadolivre-rpa", distEntry: "services/mercadolivre-rpa/dist/server.js", healthPath: "/api/meli/health", defaultPort: 3114, portEnvKey: "MELI_RPA_PORT" },
  amazon: { serviceCwd: "services/amazon-affiliate", distEntry: "services/amazon-affiliate/dist/server.js", healthPath: "/health", defaultPort: 3117, portEnvKey: "PORT" },
};

const DOCKER_SERVICE_HEALTH_URLS = {
  whatsapp: String(process.env.WHATSAPP_HEALTH_URL || "http://whatsapp:3111/health").trim(),
  telegram: String(process.env.TELEGRAM_HEALTH_URL || "http://telegram:3112/health").trim(),
  shopee: String(process.env.SHOPEE_HEALTH_URL || "http://shopee:3113/health").trim(),
  meli: String(process.env.MELI_HEALTH_URL || "http://meli:3114/api/meli/health").trim(),
  amazon: String(process.env.AMAZON_HEALTH_URL || "http://amazon:3117/health").trim(),
};

const OPS_CONFIG_DIR = process.env.OPS_CONFIG_DIR
  ? path.resolve(PROJECT_ROOT, process.env.OPS_CONFIG_DIR)
  : path.join(PROJECT_ROOT, ".ops");
const PORTS_CONFIG_PATH = path.join(OPS_CONFIG_DIR, "service-ports.json");
let lastPortsReadAt = 0;
let cachedPortOverrides = null;

function isValidPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function loadPortOverrides({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedPortOverrides && now - lastPortsReadAt < 1500) return cachedPortOverrides;

  try {
    if (!existsSync(PORTS_CONFIG_PATH)) {
      cachedPortOverrides = {};
      lastPortsReadAt = now;
      return cachedPortOverrides;
    }
    const raw = readFileSync(PORTS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    cachedPortOverrides = (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    cachedPortOverrides = {};
  }

  lastPortsReadAt = now;
  return cachedPortOverrides;
}

function savePortOverrides(next) {
  const safe = (next && typeof next === "object") ? next : {};
  try {
    mkdirSync(OPS_CONFIG_DIR, { recursive: true });
  } catch {
    // best effort
  }

  const tmpPath = `${PORTS_CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(safe, null, 2) + "\n", "utf8");
  renameSync(tmpPath, PORTS_CONFIG_PATH);
  cachedPortOverrides = safe;
  lastPortsReadAt = Date.now();
}

function getEffectivePort(serviceId) {
  const cfg = LOCAL_SERVICE_CONFIG[serviceId];
  if (!cfg) return null;

  if (IS_DOCKER_MODE) {
    const healthUrl = DOCKER_SERVICE_HEALTH_URLS[serviceId];
    if (!healthUrl) return Number(cfg.defaultPort);
    try {
      const parsed = new URL(healthUrl);
      const portRaw = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      return isValidPort(portRaw) ? portRaw : Number(cfg.defaultPort);
    } catch {
      return Number(cfg.defaultPort);
    }
  }

  const overrides = loadPortOverrides();
  const override = overrides?.[serviceId];
  if (isValidPort(override)) return Number(override);
  return Number(cfg.defaultPort);
}

function getEffectiveHealthUrl(serviceId) {
  const cfg = LOCAL_SERVICE_CONFIG[serviceId];
  if (!cfg) return "";

  if (IS_DOCKER_MODE) {
    return DOCKER_SERVICE_HEALTH_URLS[serviceId] || "";
  }

  const port = getEffectivePort(serviceId);
  const p = isValidPort(port) ? port : cfg.defaultPort;
  return `http://127.0.0.1:${p}${cfg.healthPath}`;
}

function getEffectivePortsSnapshot() {
  const overrides = loadPortOverrides();
  const out = {};
  for (const [id, cfg] of Object.entries(LOCAL_SERVICE_CONFIG)) {
    const dockerManaged = IS_DOCKER_MODE;
    out[id] = {
      port: getEffectivePort(id),
      defaultPort: cfg.defaultPort,
      override: dockerManaged ? null : (isValidPort(overrides?.[id]) ? Number(overrides[id]) : null),
      healthUrl: getEffectiveHealthUrl(id),
      portEnvKey: cfg.portEnvKey,
    };
  }
  return out;
}

function parseExecError(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  return stderr || stdout || error.message;
}

function parseDockerIds(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function findDockerServiceContainerIds(serviceId) {
  const ids = new Set();

  try {
    const byLabel = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_SERVICE_LABEL_KEY}=${serviceId}`,
      "--format",
      "{{.ID}}",
    ]);
    for (const id of parseDockerIds(byLabel.stdout)) ids.add(id);
  } catch {
    // best effort
  }

  if (ids.size === 0) {
    try {
      const byName = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${serviceId}`,
        "--format",
        "{{.ID}}",
      ]);
      for (const id of parseDockerIds(byName.stdout)) ids.add(id);
    } catch {
      // best effort
    }
  }

  return [...ids];
}

async function getDockerServiceRuntimeState(serviceId) {
  try {
    const allIds = await findDockerServiceContainerIds(serviceId);
    if (allIds.length === 0) {
      return { exists: false, running: false, ids: [] };
    }

    const runningByLabel = await execFileAsync("docker", [
      "ps",
      "--filter",
      `label=${DOCKER_SERVICE_LABEL_KEY}=${serviceId}`,
      "--format",
      "{{.ID}}",
    ]).catch(() => ({ stdout: "" }));

    const runningIds = new Set(parseDockerIds(runningByLabel.stdout));
    const running = allIds.some((id) => runningIds.has(id));
    return { exists: true, running, ids: allIds };
  } catch (error) {
    return {
      exists: false,
      running: false,
      ids: [],
      error: parseExecError(error),
    };
  }
}

async function runDockerServiceAction(serviceId, action) {
  const ids = await findDockerServiceContainerIds(serviceId);
  if (ids.length === 0) {
    throw new Error(`Container Docker não encontrado para '${serviceId}'.`);
  }

  if (action === "start") {
    await execFileAsync("docker", ["start", ...ids]);
    return ids;
  }

  if (action === "stop") {
    await execFileAsync("docker", ["stop", "--time", "20", ...ids]);
    return ids;
  }

  if (action === "restart") {
    await execFileAsync("docker", ["restart", ...ids]);
    return ids;
  }

  throw new Error(`Ação Docker inválida: ${action}`);
}

function detectPortConflict(serviceId, port) {
  const candidate = Number(port);
  if (!isValidPort(candidate)) {
    return { conflict: true, reason: "Porta inválida" };
  }

  // Ports owned by core runtime services outside LOCAL_SERVICE_CONFIG.
  const reserved = [
    { id: "ops-control", port: Number(PORT) },
    { id: "api", port: 3116 },
    { id: "web", port: 3000 },
  ];

  for (const item of reserved) {
    if (candidate === item.port) {
      return { conflict: true, reason: `Porta ${candidate} reservada para ${item.id}` };
    }
  }

  for (const id of Object.keys(LOCAL_SERVICE_CONFIG)) {
    if (id === serviceId) continue;
    if (Number(getEffectivePort(id)) === candidate) {
      return { conflict: true, reason: `Porta ${candidate} já está em uso por ${id}` };
    }
  }

  return { conflict: false, reason: "" };
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50_000) throw new Error("Payload Too Large");
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return (parsed && typeof parsed === "object") ? parsed : {};
}

const LOCAL_PROCESS_REGISTRY = new Map();

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // On some systems, a live process owned by another user may throw EPERM.
    // Treat that as alive to avoid false negatives.
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

// ─── Rate limiting (in-memory, per IP) ───────────────────────────────────────
const rateLimitStore = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Evict expired entries every 5 minutes to prevent unbounded Map growth under
// a sustained attack that uses many source IPs.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60_000).unref();

function checkRateLimit(req) {
  const ip = String(req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { blocked: false, retryAfterSec: 0 };
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_REQUESTS) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSystemSnapshot() {
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = Math.max(totalMemBytes - freeMemBytes, 0);
  const usedMemPercent = totalMemBytes > 0 ? (usedMemBytes / totalMemBytes) * 100 : 0;
  const cpuCount = Math.max(os.cpus().length, 1);
  const loadAvg = os.loadavg();
  const loadPerCpu = (loadAvg[0] || 0) / cpuCount;
  const processRssBytes = process.memoryUsage().rss;

  const memoryCritical = usedMemPercent >= MEM_CRITICAL_PERCENT;
  const memoryWarn = !memoryCritical && usedMemPercent >= MEM_WARN_PERCENT;
  const loadCritical = loadPerCpu >= LOAD_CRITICAL_PER_CPU;
  const loadWarn = !loadCritical && loadPerCpu >= LOAD_WARN_PER_CPU;

  const pressure = memoryCritical || loadCritical
    ? "critical"
    : memoryWarn || loadWarn
      ? "warn"
      : "ok";

  return {
    pressure,
    memory: {
      totalBytes: totalMemBytes,
      freeBytes: freeMemBytes,
      usedBytes: usedMemBytes,
      usedPercent: Number(usedMemPercent.toFixed(2)),
      warnPercent: MEM_WARN_PERCENT,
      criticalPercent: MEM_CRITICAL_PERCENT,
    },
    cpu: {
      count: cpuCount,
      loadAvg1m: Number((loadAvg[0] || 0).toFixed(3)),
      loadAvg5m: Number((loadAvg[1] || 0).toFixed(3)),
      loadAvg15m: Number((loadAvg[2] || 0).toFixed(3)),
      loadPerCpu1m: Number(loadPerCpu.toFixed(3)),
      warnPerCpu: LOAD_WARN_PER_CPU,
      criticalPerCpu: LOAD_CRITICAL_PER_CPU,
    },
    process: {
      rssBytes: processRssBytes,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
    },
  };
}

function resolveAllowedOrigin(req) {
  if (ALLOWED_ORIGINS.length === 0) return null;
  const origin = String(req.headers["origin"] || "").trim();
  if (!origin) return null;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function sendJson(res, req, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const allowedOrigin = resolveAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  } else if (ALLOW_WILDCARD_CORS) {
    // No origin whitelist configured in dev/local mode — allow all.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // Frontend local RPC sends x-autolinks-user-id; include it to satisfy browser preflight.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-ops-token,x-webhook-secret,x-autolinks-user-id");
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  if (ALLOW_INSECURE_NO_TOKEN) return true;
  if (!OPS_CONTROL_TOKEN) return false;

  const token = String(req.headers["x-ops-token"] || req.headers["x-webhook-secret"] || "").trim();
  // Security: use HMAC to produce fixed-length digests before comparison. This eliminates
  // the timing oracle that leaks OPS_CONTROL_TOKEN length when tokenBuf.length !== expectedBuf.length.
  const ha = createHmac("sha256", "ops-ctrl-hmac").update(token).digest();
  const hb = createHmac("sha256", "ops-ctrl-hmac").update(OPS_CONTROL_TOKEN).digest();
  return timingSafeEqual(ha, hb);
}

async function pm2Jlist() {
  const { stdout } = await execFileAsync("pm2", ["jlist"]);
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

async function isPm2Available() {
  try {
    await execFileAsync("pm2", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

async function probeServiceHealth(serviceId, timeoutMs = 3000) {
  const config = LOCAL_SERVICE_CONFIG[serviceId];
  if (!config) return { online: false, error: "Servico invalido" };
  const healthUrl = getEffectiveHealthUrl(serviceId);
  if (!healthUrl) return { online: false, error: "Health URL invalida" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: SERVICE_HEALTH_SECRET
        ? {
          "x-webhook-secret": SERVICE_HEALTH_SECRET,
          "x-ops-token": SERVICE_HEALTH_SECRET,
        }
        : undefined,
      signal: controller.signal,
    });
    return { online: response.ok, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { online: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildLocalSnapshot(serviceId) {
  const appName = SERVICE_APP_MAP[serviceId] || serviceId;
  let entry = LOCAL_PROCESS_REGISTRY.get(serviceId) || null;
  const health = await probeServiceHealth(serviceId);

  // If the tracked PID is no longer alive, drop it so the UI doesn't get stuck
  // reporting "starting-local" forever when the child crashed immediately.
  if (entry && Number.isFinite(Number(entry.pid)) && !isPidAlive(entry.pid)) {
    LOCAL_PROCESS_REGISTRY.delete(serviceId);
    entry = null;
  }

  const startedAt = Number(entry?.startedAt || 0);
  const uptimeSec = startedAt > 0 ? Math.max(Math.floor((Date.now() - startedAt) / 1000), 0) : null;
  const hasTrackedPid = Number.isFinite(Number(entry?.pid)) && Number(entry?.pid) > 0;
  const processOnline = health.online || hasTrackedPid;
  const processStatus = health.online
    ? "online-local"
    : processOnline
      ? "starting-local"
      : "offline-local";

  return {
    id: serviceId,
    appName,
    status: health.online ? "online" : "offline",
    online: health.online,
    pid: Number.isFinite(Number(entry?.pid)) ? Number(entry.pid) : null,
    uptimeSec,
    processStatus,
    processOnline,
    componentOnline: health.online,
    componentError: health.error,
    healthUrl: getEffectiveHealthUrl(serviceId),
    port: getEffectivePort(serviceId),
    mode: "local",
    error: health.error,
  };
}

async function buildDockerSnapshot(serviceId) {
  const appName = SERVICE_APP_MAP[serviceId] || serviceId;
  const runtimeState = await getDockerServiceRuntimeState(serviceId);
  const health = await probeServiceHealth(serviceId);

  const componentOnline = health.online === true;
  const runtimeError = runtimeState?.error ? String(runtimeState.error) : null;

  let processOnline = runtimeState.running === true;
  let processStatus = runtimeState.exists
    ? (runtimeState.running ? "online-docker" : "stopped-docker")
    : "missing-docker";

  // If Docker inspection is unavailable, fall back to health-only status.
  if (runtimeError) {
    processOnline = componentOnline;
    processStatus = componentOnline ? "online-docker" : "offline-docker";
  }

  const online = processOnline && componentOnline;
  const status = online
    ? "online"
    : processOnline && !componentOnline
      ? "degraded"
      : processStatus;

  return {
    id: serviceId,
    appName,
    status,
    online,
    pid: null,
    uptimeSec: null,
    processStatus,
    processOnline,
    componentOnline,
    componentError: componentOnline ? null : (health.error || runtimeError),
    healthUrl: getEffectiveHealthUrl(serviceId),
    port: getEffectivePort(serviceId),
    mode: "docker",
    error: componentOnline ? runtimeError : (health.error || runtimeError),
  };
}

function getPm2ProcessRow(rows, appName) {
  return rows.find((row) => String(row?.name || "") === appName) || null;
}

async function buildPm2Snapshot(id, appName, processRow) {
  const pm2Env = processRow && typeof processRow.pm2_env === "object" ? processRow.pm2_env : {};
  const processStatus = String(pm2Env.status || (processRow ? "unknown" : "not-found"));
  const processOnline = processStatus === "online";
  const pidRaw = Number(processRow?.pid);
  const pid = Number.isFinite(pidRaw) && pidRaw > 0 ? pidRaw : null;
  const pmUptimeRaw = Number(pm2Env.pm_uptime);
  const uptimeSec = Number.isFinite(pmUptimeRaw) && pmUptimeRaw > 0
    ? Math.max(Math.floor((Date.now() - pmUptimeRaw) / 1000), 0)
    : null;
  const health = await probeServiceHealth(id);
  const componentOnline = health.online;
  const online = processOnline && componentOnline;

  const status = online
    ? "online"
    : processOnline && !componentOnline
      ? "degraded"
      : !processOnline && componentOnline
        ? "port-conflict"
        : processStatus;

  return {
    id,
    appName,
    status,
    online,
    pid,
    uptimeSec,
    processStatus,
    processOnline,
    componentOnline,
    componentError: health.error,
    healthUrl: getEffectiveHealthUrl(id),
    port: getEffectivePort(id),
    mode: "pm2",
  };
}

async function buildServiceSnapshot(serviceId, rows = null) {
  const appName = SERVICE_APP_MAP[serviceId] || serviceId;
  if (IS_DOCKER_MODE) {
    return buildDockerSnapshot(serviceId);
  }
  const pm2Available = await isPm2Available();
  if (!pm2Available) {
    return buildLocalSnapshot(serviceId);
  }

  const pm2Rows = Array.isArray(rows) ? rows : await pm2Jlist();
  const row = getPm2ProcessRow(pm2Rows, appName);
  return buildPm2Snapshot(serviceId, appName, row);
}

async function waitForServiceConvergence(serviceId, action, timeoutMs = 30000) {
  const desiredOnline = action !== "stop";
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await buildServiceSnapshot(serviceId);

  while (Date.now() < deadline) {
    const processOk = desiredOnline
      ? lastSnapshot.processOnline === true
      : lastSnapshot.processOnline === false;
    const componentOk = desiredOnline
      ? lastSnapshot.componentOnline === true
      : lastSnapshot.componentOnline === false;

    if (processOk && componentOk) {
      return { ok: true, snapshot: lastSnapshot };
    }

    await sleep(1000);
    lastSnapshot = await buildServiceSnapshot(serviceId);
  }

  return { ok: false, snapshot: lastSnapshot };
}

// Build a service's TypeScript if the compiled output doesn't exist yet.
// This covers "fresh install" where `npm run prod:build` was never run.
async function ensureServiceBuilt(serviceId) {
  const config = LOCAL_SERVICE_CONFIG[serviceId];
  if (!config?.distEntry || !config?.serviceCwd) return;

  const distPath = path.join(PROJECT_ROOT, config.distEntry);
  if (existsSync(distPath)) return; // already built

  const serviceDir = path.join(PROJECT_ROOT, config.serviceCwd);
  console.log(`[ops-control] dist not found for ${serviceId}, running build in ${config.serviceCwd}: npm run build`);
  const { command, commandArgs } = makeNpmCommandArgs(["run", "build"]);
  await execFileAsync(command, commandArgs, { cwd: serviceDir });
}

function spawnDetachedService(serviceId) {
  const config = LOCAL_SERVICE_CONFIG[serviceId];
  if (!config) throw new Error("Servico invalido");
  if (!config.serviceCwd) throw new Error("Servico sem serviceCwd configurado");

  const env = { ...process.env };
  // IMPORTANT: child services must not inherit ops-control's PORT (3115),
  // otherwise they'll try to bind to 3115 and fail with EADDRINUSE.
  delete env.PORT;
  delete env.MELI_RPA_PORT;
  const effectivePort = getEffectivePort(serviceId);
  if (isValidPort(effectivePort) && config.portEnvKey) {
    env[config.portEnvKey] = String(effectivePort);
  }
  // Match root dev scripts: always allow local insecure boot in development.
  // Services still require a real WEBHOOK_SECRET in production.
  if (String(env.NODE_ENV || "").toLowerCase() !== "production") {
    env.ALLOW_INSECURE_NO_SECRET = "true";
  }

  const serviceDir = path.join(PROJECT_ROOT, config.serviceCwd);
  if (!existsSync(serviceDir)) {
    throw new Error(`Diretorio do servico nao encontrado: ${serviceDir}`);
  }

  const logsDir = path.join(PROJECT_ROOT, "logs", "ops-control");
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // best effort
  }
  const outLogPath = path.join(logsDir, `${serviceId}.out.log`);
  const errLogPath = path.join(logsDir, `${serviceId}.err.log`);
  try {
    appendFileSync(outLogPath, `\n\n--- spawn ${nowIso()} (pid=?) ---\n`);
    appendFileSync(errLogPath, `\n\n--- spawn ${nowIso()} (pid=?) ---\n`);
  } catch {
    // best effort
  }

  let outFd = null;
  let errFd = null;
  let stdio = "ignore";
  try {
    outFd = openSync(outLogPath, "a");
    errFd = openSync(errLogPath, "a");
    stdio = ["ignore", outFd, errFd];
  } catch {
    outFd = null;
    errFd = null;
    stdio = "ignore";
  }

  const { command, commandArgs, shell } = makeNpmCommandArgs(["run", "dev"]);
  const child = spawn(command, commandArgs, {
    cwd: serviceDir,
    detached: true,
    stdio,
    env,
    shell,
    windowsHide: true,
  });

  child.on("error", (error) => {
    LOCAL_PROCESS_REGISTRY.delete(serviceId);
    try {
      appendFileSync(errLogPath, `[ops-control] spawn error: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      // best effort
    }
  });

  try {
    if (typeof outFd === "number") closeSync(outFd);
    if (typeof errFd === "number") closeSync(errFd);
  } catch {
    // ignore
  }

  try {
    appendFileSync(outLogPath, `[ops-control] spawned pid=${child.pid}\n`);
    appendFileSync(errLogPath, `[ops-control] spawned pid=${child.pid}\n`);
  } catch {
    // best effort
  }

  child.unref();
  LOCAL_PROCESS_REGISTRY.set(serviceId, { pid: child.pid, startedAt: Date.now() });
  return child.pid;
}

async function killTrackedService(serviceId) {
  const entry = LOCAL_PROCESS_REGISTRY.get(serviceId);
  if (!entry || !Number.isFinite(Number(entry.pid))) return;

  const pid = Number(entry.pid);
  try {
    if (IS_WINDOWS) {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // best effort
  }
  LOCAL_PROCESS_REGISTRY.delete(serviceId);
}

async function killByPort(serviceId) {
  const config = LOCAL_SERVICE_CONFIG[serviceId];
  if (!config) return;
  const port = getEffectivePort(serviceId);
  if (!isValidPort(port)) return;

  if (IS_WINDOWS) {
    try {
      const { stdout } = await execFileAsync("cmd", ["/c", "netstat -ano -p tcp"]);
      const lines = String(stdout || "").split(/\r?\n/);
      const pids = new Set();
      for (const line of lines) {
        if (!line.includes(`:${port}`) || !line.toUpperCase().includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        const pidRaw = parts[parts.length - 1];
        const pid = Number(pidRaw);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }

      for (const pid of pids) {
        try {
          await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        } catch {
          // best effort
        }
      }
    } catch {
      // best effort
    }
    return;
  }

  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `lsof -ti tcp:${port}`]);
    const pids = String(stdout || "")
      .split(/\r?\n/)
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

async function listServices() {
  if (IS_DOCKER_MODE) {
    const serviceIds = Object.keys(SERVICE_APP_MAP);
    return Promise.all(serviceIds.map((serviceId) => buildDockerSnapshot(serviceId)));
  }

  const pm2Available = await isPm2Available();
  if (!pm2Available) {
    const serviceIds = Object.keys(SERVICE_APP_MAP);
    return Promise.all(serviceIds.map((serviceId) => buildLocalSnapshot(serviceId)));
  }

  const rows = await pm2Jlist();
  return Promise.all(Object.entries(SERVICE_APP_MAP).map(async ([id, appName]) => {
    const processRow = getPm2ProcessRow(rows, appName);
    return buildPm2Snapshot(id, appName, processRow);
  }));
}

async function controlService(service, action) {
  const appName = SERVICE_APP_MAP[service];
  if (!appName) {
    return { ok: false, error: "Servico invalido" };
  }

  if (!["start", "stop", "restart"].includes(action)) {
    return { ok: false, error: "Acao invalida" };
  }

  if (IS_DOCKER_MODE) {
    if (!DOCKER_CONTROL_ENABLED) {
      return {
        ok: false,
        service,
        action,
        mode: "docker",
        error: "Controles Docker desativados (DOCKER_CONTROL_ENABLED=false).",
      };
    }

    try {
      await runDockerServiceAction(service, action);
      const convergence = await waitForServiceConvergence(service, action, action === "stop" ? 45_000 : 60_000);
      if (!convergence.ok) {
        throw new Error(`Servico ${service} nao convergiu para o estado esperado apos ${action}`);
      }

      const snapshot = convergence.snapshot;
      return {
        ok: true,
        service,
        action,
        appName,
        status: snapshot.status,
        online: snapshot.online,
        pid: null,
        uptimeSec: snapshot.uptimeSec,
        mode: "docker",
      };
    } catch (error) {
      return {
        ok: false,
        service,
        action,
        mode: "docker",
        error: parseExecError(error),
      };
    }
  }

  const pm2Available = await isPm2Available();
  if (!pm2Available) {
    if (!LOCAL_SERVICE_CONFIG[service]) {
      return { ok: false, error: "Servico invalido" };
    }

    if (action === "start") {
      const current = await probeServiceHealth(service);
      if (!current.online) {
        await killByPort(service);
        await sleep(400);
        spawnDetachedService(service);
      }
    }

    if (action === "stop") {
      await killTrackedService(service);
      await killByPort(service);
      await sleep(400);
    }

    if (action === "restart") {
      await killTrackedService(service);
      await killByPort(service);
      await sleep(400);
      spawnDetachedService(service);
    }

    const convergence = await waitForServiceConvergence(service, action, action === "stop" ? 12000 : 30000);
    const snapshot = convergence.snapshot;
    if (!convergence.ok) {
      throw new Error(`Servico ${service} nao convergiu para o estado esperado apos ${action}`);
    }

    return {
      ok: true,
      service,
      action,
      appName,
      status: snapshot.status,
      online: snapshot.online,
      pid: snapshot.pid,
      uptimeSec: snapshot.uptimeSec,
      mode: "local",
    };
  }

  // Check if the app is already registered in PM2. On a fresh deploy or first
  // boot, PM2 has no entries for these apps – running "pm2 start appName" with
  // just the name (not a file path) would fail. In that case we bootstrap from
  // the ecosystem config which registers + starts the app in one shot.
  const pm2Rows = await pm2Jlist().catch(() => []);
  const existingRow = getPm2ProcessRow(pm2Rows, appName);
  const ecosystemPath = path.join(PROJECT_ROOT, "ecosystem.config.cjs");

  if (action === "stop") {
    if (existingRow) {
      await execFileAsync("pm2", ["stop", appName]);
    } else {
      // Not in PM2 at all – just kill anything listening on this port.
      await killByPort(service);
    }
  } else if (action === "start") {
    if (existingRow) {
      // Use ecosystem path so env (ports) is re-evaluated.
      await execFileAsync("pm2", ["start", ecosystemPath, "--only", appName, "--update-env"]);
    } else {
      // Fresh deploy: ensure compiled dist exists (PM2 uses the start script
      // which runs `node dist/server.js`); build if missing.
      await ensureServiceBuilt(service);
      await execFileAsync("pm2", ["start", ecosystemPath, "--only", appName, "--update-env"]);
    }
  } else {
    // restart
    if (existingRow) {
      // Use ecosystem path so env (ports) is re-evaluated.
      await execFileAsync("pm2", ["restart", ecosystemPath, "--only", appName, "--update-env"]);
    } else {
      // Not yet registered – build if needed then start fresh.
      await ensureServiceBuilt(service);
      await execFileAsync("pm2", ["start", ecosystemPath, "--only", appName, "--update-env"]);
    }
  }

  const convergence = await waitForServiceConvergence(service, action, action === "stop" ? 20000 : 45000);
  const snapshot = convergence.snapshot;
  if (!convergence.ok) {
    throw new Error(`Servico ${service} nao convergiu para o estado esperado apos ${action}`);
  }

  return {
    ok: true,
    service,
    action,
    appName,
    status: snapshot.status,
    online: snapshot.online,
    pid: snapshot.pid,
    uptimeSec: snapshot.uptimeSec,
  };
}

async function controlAllServices(action) {
  if (!["start", "stop", "restart"].includes(action)) {
    return { ok: false, error: "Acao invalida" };
  }

  const serviceIds = Object.keys(SERVICE_APP_MAP);

  // Run all service operations in parallel so "start/stop/restart all" finishes
  // in the time of the slowest single service (~30-45s) rather than N×30s.
  const settled = await Promise.allSettled(serviceIds.map((service) => controlService(service, action)));
  const results = settled.map((item, idx) => {
    if (item.status === "fulfilled") return item.value;
    return {
      ok: false,
      service: serviceIds[idx],
      action,
      error: item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });

  const ok = results.every((item) => item.ok === true);
  return {
    ok,
    service: "all",
    action,
    results,
  };
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, req, 400, { ok: false, error: "Requisicao invalida" });
    return;
  }

  // Per-IP rate limit — applied before any authentication or processing.
  const rlResult = checkRateLimit(req);
  if (rlResult.blocked) {
    res.setHeader("Retry-After", String(rlResult.retryAfterSec));
    sendJson(res, req, 429, { ok: false, error: "Too Many Requests" });
    return;
  }

  // Reject oversized bodies (POST/PUT/PATCH) before they are read.
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > 50_000) {
    sendJson(res, req, 413, { ok: false, error: "Payload Too Large" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, req, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" && req.method === "GET") {
    // F11: require the same token as all other /api routes.
    if (!isAuthorized(req)) {
      sendJson(res, req, 401, { ok: false, error: "Token invalido ou ausente (x-ops-token)" });
      return;
    }
    try {
      const pm2Available = await isPm2Available();
      if (pm2Available) {
        await pm2Jlist();
      }
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        mode: IS_DOCKER_MODE ? "docker" : (pm2Available ? "pm2" : "local"),
        system,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: false,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, req, 401, {
      ok: false,
      error: ALLOW_INSECURE_NO_TOKEN
        ? "Nao autorizado"
        : "Token invalido ou ausente (x-ops-token)",
    });
    return;
  }

  if (url.pathname === "/api/services" && req.method === "GET") {
    try {
      const services = await listServices();
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: false,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/config/ports" && req.method === "GET") {
    try {
      sendJson(res, req, 200, {
        ok: true,
        checkedAt: nowIso(),
        ports: getEffectivePortsSnapshot(),
      });
    } catch (error) {
      sendJson(res, req, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/config/ports" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const service = String(body.service || body.id || "").trim().toLowerCase();
      const portRaw = body.port;
      if (!service || !LOCAL_SERVICE_CONFIG[service]) {
        sendJson(res, req, 400, { ok: false, error: "Servico invalido" });
        return;
      }
      if (!isValidPort(portRaw)) {
        sendJson(res, req, 400, { ok: false, error: "Porta invalida" });
        return;
      }

      if (IS_DOCKER_MODE) {
        sendJson(res, req, 400, {
          ok: false,
          error: "Alteracao de porta nao suportada no modo Docker/Coolify. Ajuste as variaveis de ambiente do deploy.",
        });
        return;
      }

      const conflict = detectPortConflict(service, Number(portRaw));
      if (conflict.conflict) {
        sendJson(res, req, 400, {
          ok: false,
          error: conflict.reason || "Conflito de porta detectado",
        });
        return;
      }

      const overrides = loadPortOverrides({ force: true });
      const next = { ...(overrides && typeof overrides === "object" ? overrides : {}) };
      next[service] = Number(portRaw);
      savePortOverrides(next);

      sendJson(res, req, 200, {
        ok: true,
        checkedAt: nowIso(),
        service,
        port: getEffectivePort(service),
        ports: getEffectivePortsSnapshot(),
      });
    } catch (error) {
      sendJson(res, req, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/system/health" && req.method === "GET") {
    try {
      const services = await listServices();
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, req, 200, {
        online: false,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/services/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const service = parts[2] || "";
    const action = parts[3] || "";

    try {
      if (service === "all") {
        const result = await controlAllServices(action);
        if (!result.ok) {
          sendJson(res, req, 400, result);
          return;
        }
        sendJson(res, req, 200, result);
        return;
      }

      const result = await controlService(service, action);
      if (!result.ok) {
        sendJson(res, req, 400, result);
        return;
      }
      sendJson(res, req, 200, result);
    } catch (error) {
      sendJson(res, req, 500, {
        ok: false,
        service,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendJson(res, req, 404, { ok: false, error: "Rota nao encontrada" });
});

async function detectExistingOpsControl(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      headers: OPS_CONTROL_TOKEN ? { "x-ops-token": OPS_CONTROL_TOKEN } : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!text || !text.trim()) {
      return { ok: false, reason: `empty_response_http_${res.status}` };
    }

    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object") {
        if (json.service === "ops-control") return { ok: true, mode: "json_service" };
        const err = String(json.error || "").toLowerCase();
        if (err.includes("x-ops-token") || err.includes("ops-control")) {
          return { ok: true, mode: "json_error" };
        }
      }
    } catch {
      // ignore — fall back to substring detection
    }

    const lower = text.toLowerCase();
    if (lower.includes("ops-control") || lower.includes("x-ops-token")) {
      return { ok: true, mode: "text" };
    }

    return { ok: false, reason: `unexpected_response_http_${res.status}` };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

server.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    void detectExistingOpsControl(PORT).then((detected) => {
      if (detected.ok) {
        console.warn(`[ops-control] port ${PORT} already in use — existing ops-control detected; entering standby mode.`);
        console.warn("[ops-control] This prevents dev orchestrators (concurrently -k) from killing API/WEB when ops-control is already running.");

        // Keep this process alive but idle. The real ops-control instance
        // continues serving traffic on PORT.
        const standby = setInterval(() => undefined, 60_000);
        process.on("SIGINT", () => { clearInterval(standby); process.exit(0); });
        process.on("SIGTERM", () => { clearInterval(standby); process.exit(0); });
        return;
      }
      console.error(`[ops-control] port ${PORT} already in use and does not look like ops-control.`);
      console.error("[ops-control] Close the process using the port, or run ops-control with a different PORT.");
      console.error("[ops-control] Tip (PowerShell): Get-NetTCPConnection -LocalPort 3115 | Select LocalAddress,State,OwningProcess");
      process.exit(1);
    });
    return;
  }

  console.error("[ops-control] server error:", error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[ops-control] listening on http://${HOST}:${PORT}`);
  console.log(`[ops-control] secured=${ALLOW_INSECURE_NO_TOKEN ? "false (dev)" : "true"}`);
  console.log(`[ops-control] runtime_mode=${IS_DOCKER_MODE ? "docker" : "local/pm2"}`);
});
