const baseApp = {
  cwd: ".",
  autorestart: true,
  max_restarts: 1000,
  restart_delay: 3000,
  exp_backoff_restart_delay: 100,
  min_uptime: "10s",
  time: true,
  // Log to files so that logs survive container restarts and are not lost
  // if an attacker deletes the PM2 daemon log. Use pm2-logrotate module to
  // rotate these files periodically (pm2 install pm2-logrotate).
  out_file: "./logs/pm2-out.log",
  error_file: "./logs/pm2-error.log",
  merge_logs: true,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  env: {
    NODE_ENV: "production",
    // Do NOT provide fallback secrets here: if WEBHOOK_SECRET or OPS_CONTROL_TOKEN
    // are missing from the environment, the services fail fast at startup via
    // ensureRequiredEnvVars() rather than silently running with a weak default.
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",
    OPS_CONTROL_TOKEN: process.env.OPS_CONTROL_TOKEN || process.env.WEBHOOK_SECRET || "",
  },
};

const fs = require("fs");
const path = require("path");

const DEFAULT_PORTS = {
  whatsapp: 3111,
  telegram: 3112,
  shopee: 3113,
  meli: 3114,
};

function isValidPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function readServicePortOverrides() {
  try {
    const filePath = path.join(__dirname, ".ops", "service-ports.json");
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const portOverrides = readServicePortOverrides();
const effectivePorts = {
  whatsapp: isValidPort(portOverrides.whatsapp) ? Number(portOverrides.whatsapp) : DEFAULT_PORTS.whatsapp,
  telegram: isValidPort(portOverrides.telegram) ? Number(portOverrides.telegram) : DEFAULT_PORTS.telegram,
  shopee: isValidPort(portOverrides.shopee) ? Number(portOverrides.shopee) : DEFAULT_PORTS.shopee,
  meli: isValidPort(portOverrides.meli) ? Number(portOverrides.meli) : DEFAULT_PORTS.meli,
};

const isWindows = process.platform === "win32";

function npmRunConfig(scriptName) {
  if (isWindows) {
    // Use the full cmd.exe path (ComSpec) so PM2 never tries to parse a .cmd
    // batch file as JavaScript. interpreter: "none" tells PM2 to exec directly.
    const comSpec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    return {
      script: comSpec,
      args: `/c npm run ${scriptName}`,
      interpreter: "none",
    };
  }

  return {
    script: "npm",
    args: `run ${scriptName}`,
  };
}

function shouldEnableDispatchScheduler() {
  const mode = String(process.env.SCHEDULER_MODE || "auto").toLowerCase();
  const hasRemoteBase = String(process.env.SCHEDULER_RPC_BASE_URL || "").trim().length > 0;
  if (mode === "remote") return true;
  if (mode === "local") return false;
  return hasRemoteBase;
}

// ─── DB connection budget ─────────────────────────────────────────────────────
// Each PM2 cluster worker gets its own pg.Pool.
// Total DB connections = DB_POOL_MAX * API_INSTANCES (≤ Postgres max_connections).
// DB_MAX_TOTAL_CONN: the connection budget reserved for the API cluster (default 40).
// If API_INSTANCES is set explicitly, divide evenly; otherwise derive from CPU count
// capped by the DB budget so we never exceed the Postgres connection limit.
// Example: 16-core machine, DB_MAX_TOTAL_CONN=40, pool=5 → safeMaxInstances=8
//   → 8 × 5 = 40 API connections + ~15 internal = 55 (fits Supabase free tier: 60).
const os = require("os");
const apiInstances = Number(process.env.API_INSTANCES) || 0;
const dbTotalBudget = Number(process.env.DB_MAX_TOTAL_CONN || 40);
const dbPoolMaxPerWorker = process.env.DB_POOL_MAX
  ? Number(process.env.DB_POOL_MAX)
  : apiInstances > 0
    ? Math.max(2, Math.floor(dbTotalBudget / apiInstances))
    : 5;
// When API_INSTANCES is not set, cap workers so total pool ≤ DB_MAX_TOTAL_CONN.
// This prevents connection exhaustion on high-core-count machines.
const safeMaxInstances = apiInstances > 0
  ? apiInstances
  : Math.max(1, Math.min(os.cpus().length, Math.floor(dbTotalBudget / Math.max(dbPoolMaxPerWorker, 1))));

const apps = [
  {
    ...baseApp,
    name: "autolinks-api",
    // Point directly at the compiled entry so PM2 cluster mode can fork Node workers.
    // On Windows (local dev), fall back to fork mode with a single instance because
    // cluster mode requires PM2 to own the process, not cmd.exe.
    ...(isWindows
      ? npmRunConfig("svc:api:start")
      : { script: "services/api/dist/index.js" }),
    exec_mode: isWindows ? "fork" : "cluster",
    instances: isWindows ? 1 : safeMaxInstances,
    env: { ...baseApp.env, PORT: "3116", DB_POOL_MAX: String(dbPoolMaxPerWorker) },
    restart_delay: 5000,
  },
  {
    ...baseApp,
    name: "autolinks-web",
    ...npmRunConfig("start"),
    restart_delay: 5000,
  },
  {
    ...baseApp,
    name: "autolinks-whatsapp",
    ...npmRunConfig("svc:wa:start"),
    env: { ...baseApp.env, PORT: String(effectivePorts.whatsapp) },
  },
  {
    ...baseApp,
    name: "autolinks-telegram",
    ...npmRunConfig("svc:tg:start"),
    env: { ...baseApp.env, PORT: String(effectivePorts.telegram) },
  },
  {
    ...baseApp,
    name: "autolinks-shopee",
    ...npmRunConfig("svc:shopee:start"),
    env: { ...baseApp.env, PORT: String(effectivePorts.shopee) },
  },
  {
    ...baseApp,
    name: "autolinks-meli",
    ...npmRunConfig("svc:meli:start"),
    env: { ...baseApp.env, MELI_RPA_PORT: String(effectivePorts.meli) },
  },
  {
    ...baseApp,
    name: "autolinks-ops-control",
    ...npmRunConfig("svc:ops:start"),
  },
  {
    ...baseApp,
    name: "autolinks-health-guardian",
    script: "node",
    args: "scripts/health-guardian.mjs",
    restart_delay: 5000,
  },
];

if (shouldEnableDispatchScheduler()) {
  apps.push({
    ...baseApp,
    name: "autolinks-dispatch-scheduler",
    ...npmRunConfig("scheduler:start"),
  });
}

module.exports = {
  apps,
};
