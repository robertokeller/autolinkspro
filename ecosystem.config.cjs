const baseApp = {
  cwd: ".",
  autorestart: true,
  max_restarts: 1000,
  restart_delay: 3000,
  exp_backoff_restart_delay: 100,
  min_uptime: "10s",
  time: true,
  env: {
    NODE_ENV: "production",
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "autolinks-local-webhook-secret",
    OPS_CONTROL_TOKEN: process.env.OPS_CONTROL_TOKEN || process.env.WEBHOOK_SECRET || "autolinks-local-webhook-secret",
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

const apps = [
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
