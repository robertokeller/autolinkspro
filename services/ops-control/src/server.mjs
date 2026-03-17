import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const PORT = Number.parseInt(process.env.PORT || "3115", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MEM_WARN_PERCENT = Number.parseFloat(process.env.OPS_MEM_WARN_PERCENT || "80");
const MEM_CRITICAL_PERCENT = Number.parseFloat(process.env.OPS_MEM_CRITICAL_PERCENT || "90");
const LOAD_WARN_PER_CPU = Number.parseFloat(process.env.OPS_LOAD_WARN_PER_CPU || "1.5");
const LOAD_CRITICAL_PER_CPU = Number.parseFloat(process.env.OPS_LOAD_CRITICAL_PER_CPU || "2.0");
const OPS_CONTROL_TOKEN = String(process.env.OPS_CONTROL_TOKEN || process.env.WEBHOOK_SECRET || "").trim();
const SERVICE_HEALTH_SECRET = String(process.env.WEBHOOK_SECRET || process.env.OPS_CONTROL_TOKEN || "").trim();
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const allowInsecureFlag = String(process.env.ALLOW_INSECURE_NO_TOKEN || "").toLowerCase() === "true";
const ALLOW_INSECURE_NO_TOKEN = allowInsecureFlag || (NODE_ENV !== "production" && !OPS_CONTROL_TOKEN);
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
};

const LOCAL_SERVICE_CONFIG = {
  whatsapp: { serviceCwd: "services/whatsapp-baileys", distEntry: "services/whatsapp-baileys/dist/server.js", healthPath: "/health", defaultPort: 3111, portEnvKey: "PORT" },
  telegram: { serviceCwd: "services/telegram-telegraph", distEntry: "services/telegram-telegraph/dist/server.js", healthPath: "/health", defaultPort: 3112, portEnvKey: "PORT" },
  shopee: { serviceCwd: "services/shopee-affiliate", distEntry: "services/shopee-affiliate/dist/server.js", healthPath: "/health", defaultPort: 3113, portEnvKey: "PORT" },
  meli: { serviceCwd: "services/mercadolivre-rpa", distEntry: "services/mercadolivre-rpa/dist/server.js", healthPath: "/api/meli/health", defaultPort: 3114, portEnvKey: "MELI_RPA_PORT" },
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
  const overrides = loadPortOverrides();
  const override = overrides?.[serviceId];
  if (isValidPort(override)) return Number(override);
  return Number(cfg.defaultPort);
}

function getEffectiveHealthUrl(serviceId) {
  const cfg = LOCAL_SERVICE_CONFIG[serviceId];
  if (!cfg) return "";
  const port = getEffectivePort(serviceId);
  const p = isValidPort(port) ? port : cfg.defaultPort;
  return `http://127.0.0.1:${p}${cfg.healthPath}`;
}

function getEffectivePortsSnapshot() {
  const overrides = loadPortOverrides();
  const out = {};
  for (const [id, cfg] of Object.entries(LOCAL_SERVICE_CONFIG)) {
    out[id] = {
      port: getEffectivePort(id),
      defaultPort: cfg.defaultPort,
      override: isValidPort(overrides?.[id]) ? Number(overrides[id]) : null,
      healthUrl: getEffectiveHealthUrl(id),
      portEnvKey: cfg.portEnvKey,
    };
  }
  return out;
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
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_REQUESTS;
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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // Frontend local RPC sends x-autolinks-user-id; include it to satisfy browser preflight.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-ops-token,x-webhook-secret,x-autolinks-user-id");
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  if (ALLOW_INSECURE_NO_TOKEN) return true;
  if (!OPS_CONTROL_TOKEN) return false;

  const token = String(req.headers["x-ops-token"] || req.headers["x-webhook-secret"] || "").trim();
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(OPS_CONTROL_TOKEN);
  if (tokenBuf.length === 0 || tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
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
    sendJson(res, 400, { ok: false, error: "Requisicao invalida" });
    return;
  }

  // Per-IP rate limit — applied before any authentication or processing.
  if (checkRateLimit(req)) {
    sendJson(res, 429, { ok: false, error: "Too Many Requests" });
    return;
  }

  // Reject oversized bodies (POST/PUT/PATCH) before they are read.
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > 50_000) {
    sendJson(res, 413, { ok: false, error: "Payload Too Large" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" && req.method === "GET") {
    // F11: require the same token as all other /api routes.
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "Token invalido ou ausente (x-ops-token)" });
      return;
    }
    try {
      const pm2Available = await isPm2Available();
      if (pm2Available) {
        await pm2Jlist();
      }
      const system = readSystemSnapshot();
      sendJson(res, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        mode: pm2Available ? "pm2" : "local",
        system,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, 200, {
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
    sendJson(res, 401, {
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
      sendJson(res, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, 200, {
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
      sendJson(res, 200, {
        ok: true,
        checkedAt: nowIso(),
        ports: getEffectivePortsSnapshot(),
      });
    } catch (error) {
      sendJson(res, 500, {
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
        sendJson(res, 400, { ok: false, error: "Servico invalido" });
        return;
      }
      if (!isValidPort(portRaw)) {
        sendJson(res, 400, { ok: false, error: "Porta invalida" });
        return;
      }

      const overrides = loadPortOverrides({ force: true });
      const next = { ...(overrides && typeof overrides === "object" ? overrides : {}) };
      next[service] = Number(portRaw);
      savePortOverrides(next);

      sendJson(res, 200, {
        ok: true,
        checkedAt: nowIso(),
        service,
        port: getEffectivePort(service),
        ports: getEffectivePortsSnapshot(),
      });
    } catch (error) {
      sendJson(res, 500, {
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
      sendJson(res, 200, {
        online: true,
        service: "ops-control",
        checkedAt: nowIso(),
        system,
        services,
      });
    } catch (error) {
      const system = readSystemSnapshot();
      sendJson(res, 200, {
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
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      const result = await controlService(service, action);
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        service,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Rota nao encontrada" });
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
});
