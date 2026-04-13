import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.HEALTHCHECK_INTERVAL_MS ?? "30000", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS ?? "6000", 10);
const MAX_FAILS = Number.parseInt(process.env.HEALTHCHECK_FAILS ?? "3", 10);
const RESTART_COOLDOWN_MS = Number.parseInt(process.env.HEALTHCHECK_RESTART_COOLDOWN_MS ?? "120000", 10);
const MAX_RESTARTS_PER_WINDOW = Number.parseInt(process.env.HEALTHCHECK_MAX_RESTARTS_PER_WINDOW ?? "6", 10);
const RESTART_WINDOW_MS = Number.parseInt(process.env.HEALTHCHECK_RESTART_WINDOW_MS ?? "600000", 10);
const MEM_WARN_PERCENT = Number.parseFloat(process.env.HEALTHCHECK_MEM_WARN_PERCENT ?? "80");
const MEM_CRITICAL_PERCENT = Number.parseFloat(process.env.HEALTHCHECK_MEM_CRITICAL_PERCENT ?? "90");
const LOAD_WARN_PER_CPU = Number.parseFloat(process.env.HEALTHCHECK_LOAD_WARN_PER_CPU ?? "1.5");
const LOAD_CRITICAL_PER_CPU = Number.parseFloat(process.env.HEALTHCHECK_LOAD_CRITICAL_PER_CPU ?? "2.0");

const services = [
  {
    label: "whatsapp",
    appName: "autolinks-whatsapp",
    url: process.env.WA_HEALTH_URL ?? "http://127.0.0.1:3111/health",
    headers: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
  },
  {
    label: "telegram",
    appName: "autolinks-telegram",
    url: process.env.TG_HEALTH_URL ?? "http://127.0.0.1:3112/health",
    headers: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
  },
  {
    label: "shopee",
    appName: "autolinks-shopee",
    url: process.env.SHOPEE_HEALTH_URL ?? "http://127.0.0.1:3113/health",
    headers: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
  },
  {
    label: "meli",
    appName: "autolinks-meli",
    url: process.env.MELI_HEALTH_URL ?? "http://127.0.0.1:3114/api/meli/health",
    headers: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
  },
  {
    label: "amazon",
    appName: "autolinks-amazon",
    url: process.env.AMAZON_HEALTH_URL ?? "http://127.0.0.1:3117/health",
    headers: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
  },
];

const state = new Map(
  services.map((service) => [service.appName, { failures: 0, lastRestartTs: 0, lastStatus: "unknown" }]),
);

let restartWindowStartedAt = Date.now();
let restartCountInWindow = 0;

function log(message) {
  console.log(`[health-guardian] ${message}`);
}

function readHostPressure() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(totalMem - freeMem, 0);
  const usedMemPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
  const cpuCount = Math.max(os.cpus().length, 1);
  const load1 = os.loadavg()[0] || 0;
  const loadPerCpu = load1 / cpuCount;

  const memoryCritical = usedMemPercent >= MEM_CRITICAL_PERCENT;
  const memoryWarn = !memoryCritical && usedMemPercent >= MEM_WARN_PERCENT;
  const loadCritical = loadPerCpu >= LOAD_CRITICAL_PER_CPU;
  const loadWarn = !loadCritical && loadPerCpu >= LOAD_WARN_PER_CPU;

  const level = memoryCritical || loadCritical
    ? "critical"
    : memoryWarn || loadWarn
      ? "warn"
      : "ok";

  const intervalMultiplier = level === "critical" ? 2.5 : level === "warn" ? 1.5 : 1;

  return {
    level,
    usedMemPercent,
    loadPerCpu,
    cpuCount,
    intervalMultiplier,
  };
}

function canRestartNow(now, pressure) {
  if (now - restartWindowStartedAt > RESTART_WINDOW_MS) {
    restartWindowStartedAt = now;
    restartCountInWindow = 0;
  }

  if (restartCountInWindow >= MAX_RESTARTS_PER_WINDOW) {
    return { ok: false, reason: "restart_budget_exhausted" };
  }

  if (pressure.level === "critical") {
    return { ok: false, reason: "host_pressure_critical" };
  }

  return { ok: true, reason: "ok" };
}

function markRestart(now) {
  if (now - restartWindowStartedAt > RESTART_WINDOW_MS) {
    restartWindowStartedAt = now;
    restartCountInWindow = 0;
  }
  restartCountInWindow += 1;
}

async function checkHealth(url, timeoutMs, headers = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const IS_WINDOWS = process.platform === "win32";

async function restartPm2Process(appName) {
  // On Windows, pm2 is a .cmd batch script; execFile needs to go through cmd.
  if (IS_WINDOWS) {
    await execFileAsync("cmd", ["/c", "pm2", "restart", appName, "--update-env"]);
  } else {
    await execFileAsync("pm2", ["restart", appName, "--update-env"]);
  }
}

async function runCycle() {
  const now = Date.now();
  const pressure = readHostPressure();

  if (pressure.level !== "ok") {
    log(
      `host pressure=${pressure.level} mem=${pressure.usedMemPercent.toFixed(1)}% load/cpu=${pressure.loadPerCpu.toFixed(2)} (cpus=${pressure.cpuCount})`,
    );
  }

  for (const service of services) {
    const serviceState = state.get(service.appName);
    if (!serviceState) {
      continue;
    }

    const health = await checkHealth(service.url, DEFAULT_TIMEOUT_MS, service.headers);

    if (health.ok) {
      if (serviceState.lastStatus !== "ok") {
        log(`${service.label} recovered (${service.url}).`);
      }
      serviceState.failures = 0;
      serviceState.lastStatus = "ok";
      continue;
    }

    serviceState.failures += 1;
    serviceState.lastStatus = "down";
    log(`${service.label} health check failed (${serviceState.failures}/${MAX_FAILS}): ${health.error}`);

    const shouldRestart = serviceState.failures >= MAX_FAILS;
    const inCooldown = now - serviceState.lastRestartTs < RESTART_COOLDOWN_MS;

    if (!shouldRestart || inCooldown) {
      continue;
    }

    const restartPolicy = canRestartNow(now, pressure);
    if (!restartPolicy.ok) {
      log(`restart skipped for ${service.appName}: ${restartPolicy.reason}`);
      continue;
    }

    try {
      log(`restarting ${service.appName} after ${serviceState.failures} consecutive failures.`);
      await restartPm2Process(service.appName);
      serviceState.lastRestartTs = Date.now();
      serviceState.failures = 0;
      markRestart(now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`failed to restart ${service.appName}: ${reason}`);
    }
  }

  return pressure;
}

let running = false;

async function safeCycle() {
  if (running) {
    return null;
  }

  running = true;
  try {
    return await runCycle();
  } finally {
    running = false;
  }
}

log(
  `started with interval=${DEFAULT_INTERVAL_MS}ms timeout=${DEFAULT_TIMEOUT_MS}ms maxFails=${MAX_FAILS} cooldown=${RESTART_COOLDOWN_MS}ms`,
);

async function loop() {
  const pressure = await safeCycle();
  const multiplier = pressure?.intervalMultiplier ?? 1;
  const nextInMs = Math.max(Math.floor(DEFAULT_INTERVAL_MS * multiplier), 5000);
  setTimeout(() => {
    void loop();
  }, nextInMs);
}

void loop();
