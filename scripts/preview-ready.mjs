import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const WA_HEALTH_URL = "http://127.0.0.1:3111/health";
const TELEGRAM_HEALTH_URL = "http://127.0.0.1:3112/health";
const SHOPEE_HEALTH_URL = "http://127.0.0.1:3113/health";
const MELI_HEALTH_URL = "http://127.0.0.1:3114/api/meli/health";
const OPS_HEALTH_URL = "http://127.0.0.1:3115/health";
const API_HEALTH_URL = "http://127.0.0.1:3116/health";
const npmCliPath = process.env.npm_execpath || "";
const LOCAL_HOST = "127.0.0.1";
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const ALLOW_PARTIAL_SERVICES = String(process.env.PREVIEW_ALLOW_PARTIAL_SERVICES || "").trim() === "1";
const PREVIEW_WEBHOOK_SECRET = String(
  process.env.WEBHOOK_SECRET
  || process.env.PREVIEW_WEBHOOK_SECRET
  || "autolinks-preview-webhook-local",
).trim();
const PREVIEW_JWT_SECRET = String(process.env.JWT_SECRET || randomBytes(32).toString("hex")).trim();
const PREVIEW_SERVICE_TOKEN = String(process.env.SERVICE_TOKEN || randomBytes(24).toString("hex")).trim();
const PREVIEW_OPS_CONTROL_TOKEN = String(process.env.OPS_CONTROL_TOKEN || randomBytes(24).toString("hex")).trim();
const PREVIEW_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || randomBytes(18).toString("hex")).trim();
const USING_FALLBACK_PREVIEW_WEBHOOK_SECRET = !String(process.env.WEBHOOK_SECRET || "").trim()
  && !String(process.env.PREVIEW_WEBHOOK_SECRET || "").trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDockerEngineUnavailableMessage(message) {
  const value = String(message || "").toLowerCase();
  const markers = [
    "dockerdesktoplinuxengine",
    "cannot find the file specified",
    "error during connect",
    "is the docker daemon running",
    "cannot connect to the docker daemon",
    "open //./pipe/dockerdesktoplinuxengine",
    "open \\\\.\\pipe\\dockerdesktoplinuxengine",
  ];
  return markers.some((marker) => value.includes(marker));
}

function findDockerDesktopExe() {
  const candidates = [
    process.env.DOCKER_DESKTOP_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Docker", "Docker", "Docker Desktop.exe") : "",
    process.env.LocalAppData ? path.join(process.env.LocalAppData, "Docker", "Docker", "Docker Desktop.exe") : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

async function isDockerEngineReady() {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info"], {
      stdio: "ignore",
      shell: false,
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, 4000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function maybeStartDockerDesktop(lastErrorMessage, logPrefix = "[preview:ready]") {
  if (process.platform !== "win32") return false;
  const dockerEngineReady = await isDockerEngineReady();
  if (dockerEngineReady) return false;

  const likelyEngineOffline = isDockerEngineUnavailableMessage(lastErrorMessage);
  if (!likelyEngineOffline) {
    console.warn(`${logPrefix} Docker compose falhou e o engine não respondeu ao 'docker info'. Tentando iniciar Docker Desktop...`);
  }

  const dockerDesktopExe = findDockerDesktopExe();
  if (!dockerDesktopExe) {
    console.warn(`${logPrefix} Docker Desktop executable not found. Install Docker Desktop or set DOCKER_DESKTOP_PATH.`);
    return false;
  }

  console.warn(`${logPrefix} Docker engine unavailable. Trying to start Docker Desktop...`);
  try {
    const desktop = spawn(dockerDesktopExe, [], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    desktop.unref();
  } catch (error) {
    console.warn(`${logPrefix} Failed to start Docker Desktop automatically: ${errorMessage(error)}`);
    return false;
  }

  console.warn(`${logPrefix} Waiting Docker engine to become ready...`);
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    if (await isDockerEngineReady()) {
      console.log(`${logPrefix} Docker engine is ready.`);
      return true;
    }
    await sleep(2000);
  }

  console.warn(`${logPrefix} Docker Desktop did not become ready in time.`);
  return false;
}

function parseArgValue(name) {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return null;
}

function parsePositionalHost() {
  const positional = process.argv.slice(2);
  const candidate = positional.find((arg) => typeof arg === "string" && arg.includes("."));
  return candidate || null;
}

function parsePositionalPort() {
  const positional = process.argv.slice(2);
  const candidate = positional.find((arg) => /^\d+$/.test(String(arg)));
  return candidate ? Number(candidate) : null;
}

async function canBindPort(port, host = null) {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));

    const listenOptions = host ? { host, port } : { port };
    server.listen(listenOptions, () => server.close(() => resolve(true)));
  });
}

async function isPortFree(port) {
  // Probe both wildcard and loopback bindings to avoid false positives on dual-stack listeners.
  if (!await canBindPort(port)) return false;
  if (!await canBindPort(port, LOCAL_HOST)) return false;
  return true;
}

async function findFreePort(startPort, maxAttempts = 50) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Não foi possivel encontrar porta livre a partir de ${startPort}`);
}

async function fetchHealth(url, timeoutMs = 2500, headers = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: headers || undefined });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(url, attempts = 25, delayMs = 1000, headers = null) {
  for (let i = 0; i < attempts; i += 1) {
    if (await fetchHealth(url, 2500, headers)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function runNpm(args, label) {
  return new Promise((resolve, reject) => {
    const command = npmCliPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const commandArgs = npmCliPath ? [npmCliPath, ...args] : args;

    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} falhou com codigo ${code ?? "desconhecido"}`));
    });

    child.on("error", (error) => {
      reject(new Error(`${label} não iniciou: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

function runCommand(command, args, label, options = {}) {
  const envOverrides = options.envOverrides || {};
  const stdio = options.stdio || "inherit";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio,
      shell: false,
      env: buildSpawnEnv(envOverrides),
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} falhou com codigo ${code ?? "desconhecido"}`));
    });

    child.on("error", (error) => {
      reject(new Error(`${label} não iniciou: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

async function ensureDatabaseReady() {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL não configurado. Crie .env ou .env.local a partir de .env.example. " +
      "Em modo Supabase, local e deploy devem usar o mesmo banco remoto.",
    );
  }

  console.log("[preview:ready] DATABASE_URL detectado. Usando banco Supabase compartilhado.");
  console.log("[preview:ready] Validando conectividade e schema do banco...");
  await runNpm(["run", "db:check"], "válidação do banco");

  try {
    console.log("[preview:ready] Aplicando migracoes no banco Supabase...");
    await runNpm(["run", "db:migrate:dev"], "migracoes do banco");

    console.log("[preview:ready] Sincronizando usuarios seed...");
    await runNpm(["run", "seed:dev"], "seed de usuarios");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preview:ready] Bootstrap de migrate/seed ignorado: ${message}`);
    console.warn("[preview:ready] Continuando com o schema já existente do banco compartilhado.");
  }
}

function buildSpawnEnv(envOverrides = {}) {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.startsWith("=") || value == null) continue;
    env[key] = String(value);
  }

  for (const [key, value] of Object.entries(envOverrides)) {
    if (!key || key.startsWith("=") || value == null) continue;
    env[key] = String(value);
  }

  return env;
}

function startNpm(args, envOverrides = {}) {
  const command = npmCliPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCliPath ? [npmCliPath, ...args] : args;

  return spawn(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    env: buildSpawnEnv(envOverrides),
  });
}

function startNodeService(distRelativePath, envOverrides = {}) {
  const scriptPath = path.resolve(process.cwd(), distRelativePath);
  return spawn(process.execPath, [scriptPath], {
    stdio: "inherit",
    shell: false,
    env: buildSpawnEnv(envOverrides),
  });
}

async function ensureServiceOnline(serviceConfig) {
  const {
    name,
    healthUrl,
    healthHeaders,
    defaultPort,
    buildScript,
    distPath,
    healthPath,
    envKey,
    runtimeEnv,
    forceFreshStartWhenOnline = false,
  } = serviceConfig;

  const alreadyOnline = await fetchHealth(healthUrl, 2500, healthHeaders || null);
  if (alreadyOnline && !forceFreshStartWhenOnline) {
    console.log(`[preview:ready] ${name} já estava online`);
    return {
      name,
      ok: true,
      endpoint: `http://${LOCAL_HOST}:${defaultPort}`,
      envKey,
      process: null,
      startedHere: false,
    };
  }

  if (alreadyOnline && forceFreshStartWhenOnline) {
    console.warn(`[preview:ready] ${name} já estava online, mas será iniciado um runtime novo para evitar código stale.`);
  }

  let servicePort = defaultPort;
  const portFree = await isPortFree(defaultPort);

  if (!portFree) {
    servicePort = await findFreePort(defaultPort + 1);
    console.warn(`[preview:ready] Porta ${defaultPort} ocupada. ${name} será iniciado na porta ${servicePort}.`);
  }

  const endpoint = `http://${LOCAL_HOST}:${servicePort}`;
  const resolvedHealthUrl = `${endpoint}${healthPath}`;

  console.log(`[preview:ready] ${name} offline. Build + start automatico em paralelo...`);

  if (buildScript) {
    try {
      await runNpm(["run", buildScript], `build do servico ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name}: falha no build (${message})`);
    }
  }

  const processEnv = {
    PORT: String(servicePort),
    ALLOW_INSECURE_NO_SECRET: process.env.ALLOW_INSECURE_NO_SECRET || "false",
    WEBHOOK_SECRET: PREVIEW_WEBHOOK_SECRET,
    ...runtimeEnv(servicePort),
  };

  const serviceProcess = startNodeService(distPath, processEnv);
  const online = await waitForHealth(resolvedHealthUrl, 30, 1000, healthHeaders || null);

  if (online && serviceProcess.exitCode !== null) {
    console.warn(
      `[preview:ready] ${name} respondeu health em ${resolvedHealthUrl}, `
      + `mas o processo iniciado encerrou (code=${serviceProcess.exitCode}). Reutilizando runtime já existente.`,
    );
    return {
      name,
      ok: true,
      endpoint,
      envKey,
      process: null,
      startedHere: false,
    };
  }

  if (!online) {
    if (!serviceProcess.killed) {
      serviceProcess.kill("SIGTERM");
    }
    throw new Error(`${name}: não respondeu em ${resolvedHealthUrl}`);
  }

  return {
    name,
    ok: true,
    endpoint,
    envKey,
    process: serviceProcess,
    startedHere: true,
  };
}

async function main() {
  const host = parseArgValue("host") || parsePositionalHost() || "0.0.0.0";
  const startPort = Number(parseArgValue("port") || parsePositionalPort() || 5173);
  const strictPreviewPort = process.argv.includes("--strictPort") || process.argv.includes("strictPort");

  if (!Number.isFinite(startPort) || startPort <= 0) {
    throw new Error("Porta inicial inválida para preview");
  }

  if (USING_FALLBACK_PREVIEW_WEBHOOK_SECRET) {
    console.warn("[preview:ready] WEBHOOK_SECRET não definido. Usando fallback estável local para evitar conflito entre runtimes de preview.");
  }

  await ensureDatabaseReady();

  const runtimeEndpoints = {
    VITE_API_URL: "http://127.0.0.1:3116",
    VITE_WHATSAPP_MICROSERVICE_URL: "http://127.0.0.1:3111",
    VITE_TELEGRAM_MICROSERVICE_URL: "http://127.0.0.1:3112",
    VITE_SHOPEE_MICROSERVICE_URL: "http://127.0.0.1:3113",
    VITE_MELI_RPA_URL: "http://127.0.0.1:3114",
    VITE_OPS_CONTROL_URL: "http://127.0.0.1:3115",
  };

  const startedProcesses = [];
  let stopping = false;

  function attachAutoRestart(name, child, config, processEnv, port) {
    const entry = { config, env: processEnv, port, restarts: 0, lastRestart: Date.now() };

    child.on("exit", (code) => {
      if (stopping) return;
      entry.restarts += 1;
      const delay = Math.min(2000 * Math.pow(1.5, Math.min(entry.restarts - 1, 6)), 30000);
      console.warn(`[preview:ready] ${name} encerrou (code=${code ?? "?"}). Reiniciando em ${Math.round(delay / 1000)}s (tentativa #${entry.restarts})...`);

      setTimeout(async () => {
        if (stopping) return;
        try {
          const newChild = startNodeService(config.distPath, entry.env);
          const healthUrl = `http://${LOCAL_HOST}:${port}${config.healthPath}`;
          const ok = await waitForHealth(healthUrl, 20, 1000, config.healthHeaders || null);
          if (!ok) console.warn(`[preview:ready] ${name} reiniciou mas não respondeu health check`);
          else console.log(`[preview:ready] ${name} reiniciado com sucesso`);

          // Replace in startedProcesses
          const idx = startedProcesses.indexOf(child);
          if (idx >= 0) startedProcesses[idx] = newChild;
          else startedProcesses.push(newChild);

          attachAutoRestart(name, newChild, config, entry.env, port);
        } catch (err) {
          console.error(`[preview:ready] Falha ao reiniciar ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, delay);
    });
  }

  function attachAutoRestartScript(name, child, scriptRelativePath, processEnv) {
    const entry = { restarts: 0 };

    child.on("exit", (code) => {
      if (stopping) return;
      entry.restarts += 1;
      const delay = Math.min(2000 * Math.pow(1.5, Math.min(entry.restarts - 1, 6)), 30000);
      console.warn(`[preview:ready] ${name} encerrou (code=${code ?? "?"}). Reiniciando em ${Math.round(delay / 1000)}s (tentativa #${entry.restarts})...`);

      setTimeout(() => {
        if (stopping) return;
        try {
          const newChild = startNodeService(scriptRelativePath, processEnv);
          const idx = startedProcesses.indexOf(child);
          if (idx >= 0) startedProcesses[idx] = newChild;
          else startedProcesses.push(newChild);
          console.log(`[preview:ready] ${name} reiniciado com sucesso`);
          attachAutoRestartScript(name, newChild, scriptRelativePath, processEnv);
        } catch (err) {
          console.error(`[preview:ready] Falha ao reiniciar ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, delay);
    });
  }

  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    for (const proc of startedProcesses) {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
      }
    }
  };

  process.on("SIGINT", () => {
    stopAll();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    stopAll();
    process.exit(143);
  });

  const supportServiceConfigs = [
    {
      name: "Ops Control",
      healthUrl: OPS_HEALTH_URL,
      healthPath: "/health",
      healthHeaders: { "x-ops-token": process.env.OPS_CONTROL_TOKEN || "preview-ops-token" },
      defaultPort: 3115,
      buildScript: null,
      distPath: "services/ops-control/src/server.mjs",
      envKey: "VITE_OPS_CONTROL_URL",
      runtimeEnv: () => ({
        HOST: "0.0.0.0",
        ALLOW_INSECURE_NO_TOKEN: process.env.ALLOW_INSECURE_NO_TOKEN || "true",
        OPS_CONTROL_TOKEN: process.env.OPS_CONTROL_TOKEN || "preview-ops-token",
      }),
    },
    {
      name: "WhatsApp",
      healthUrl: WA_HEALTH_URL,
      healthPath: "/health",
      healthHeaders: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
      defaultPort: 3111,
      buildScript: "svc:wa:build",
      distPath: "services/whatsapp-baileys/dist/server.js",
      envKey: "VITE_WHATSAPP_MICROSERVICE_URL",
      runtimeEnv: () => ({
        HOST: "0.0.0.0",
        BAILEYS_SESSIONS_DIR: path.resolve(process.cwd(), "services/whatsapp-baileys/.sessions"),
      }),
    },
    {
      name: "Telegram",
      healthUrl: TELEGRAM_HEALTH_URL,
      healthPath: "/health",
      healthHeaders: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
      defaultPort: 3112,
      buildScript: "svc:tg:build",
      distPath: "services/telegram-telegraph/dist/server.js",
      envKey: "VITE_TELEGRAM_MICROSERVICE_URL",
      runtimeEnv: () => ({
        TELEGRAM_SESSIONS_DIR: path.resolve(process.cwd(), "services/telegram-telegraph/.sessions"),
      }),
    },
    {
      name: "Shopee",
      healthUrl: SHOPEE_HEALTH_URL,
      healthPath: "/health",
      healthHeaders: process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : undefined,
      defaultPort: 3113,
      buildScript: "svc:shopee:build",
      distPath: "services/shopee-affiliate/dist/server.js",
      envKey: "VITE_SHOPEE_MICROSERVICE_URL",
      runtimeEnv: () => ({}),
    },
    {
      name: "Mercado Livre",
      healthUrl: MELI_HEALTH_URL,
      healthPath: "/api/meli/health",
      healthHeaders: { "x-webhook-secret": PREVIEW_WEBHOOK_SECRET },
      defaultPort: 3114,
      buildScript: "svc:meli:build",
      distPath: "services/mercadolivre-rpa/dist/server.js",
      envKey: "VITE_MELI_RPA_URL",
      runtimeEnv: (servicePort) => ({
        MELI_RPA_PORT: String(servicePort),
        HOST: "0.0.0.0",
      }),
    },
  ];

  const registerStartedProcess = (serviceConfig, serviceResult) => {
    runtimeEndpoints[serviceResult.envKey] = serviceResult.endpoint;
    if (!serviceResult.startedHere || !serviceResult.process) return;

    startedProcesses.push(serviceResult.process);
    const port = Number(new URL(serviceResult.endpoint).port);
    const processEnv = {
      PORT: String(port),
      ALLOW_INSECURE_NO_SECRET: process.env.ALLOW_INSECURE_NO_SECRET || "false",
      WEBHOOK_SECRET: PREVIEW_WEBHOOK_SECRET,
      ...(serviceConfig.runtimeEnv ? serviceConfig.runtimeEnv(port) : {}),
    };
    attachAutoRestart(serviceConfig.name, serviceResult.process, serviceConfig, processEnv, port);
  };

  const supportResults = await Promise.allSettled(
    supportServiceConfigs.map((service) => ensureServiceOnline(service)),
  );

  const failures = [];

  for (let i = 0; i < supportResults.length; i++) {
    const result = supportResults[i];
    const config = supportServiceConfigs[i];
    if (result.status === "fulfilled") {
      registerStartedProcess(config, result.value);
    } else {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  if (failures.length > 0) {
    if (!ALLOW_PARTIAL_SERVICES) {
      stopAll();
      throw new Error(
        `Falha ao iniciar todos os servicos obrigatórios: ${failures.join(" | ")}. ` +
        "Corrijá o serviço com erro ou use PREVIEW_ALLOW_PARTIAL_SERVICES=1 apenas para diagnóstico.",
      );
    }
    console.warn(
      `[preview:ready] Alguns servicos não iniciaram automaticamente: ${failures.join(" | ")}`,
    );
    console.warn("[preview:ready] O frontend será iniciado mesmo assim. Funcionalidades desses servicos podem ficar indisponiveis.");
  }

  const apiConfig = {
    name: "API",
    healthUrl: API_HEALTH_URL,
    healthPath: "/health",
    healthHeaders: undefined,
    defaultPort: 3116,
    buildScript: "svc:api:build",
    distPath: "services/api/dist/index.js",
    envKey: "VITE_API_URL",
    forceFreshStartWhenOnline: String(process.env.PREVIEW_API_FORCE_FRESH_START || "0").trim() === "1",
    runtimeEnv: () => ({
      NODE_ENV: process.env.NODE_ENV || "development",
      HOST: "0.0.0.0",
      DATABASE_URL: process.env.DATABASE_URL || "",
      DB_SSL: process.env.DB_SSL || "true",
      DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED || "false",
      JWT_SECRET: PREVIEW_JWT_SECRET,
      SERVICE_TOKEN: PREVIEW_SERVICE_TOKEN,
      CORS_ORIGIN: process.env.CORS_ORIGIN || "http://127.0.0.1:5173",
      ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@localhost.local",
      ADMIN_PASSWORD: PREVIEW_ADMIN_PASSWORD,
      OPS_CONTROL_TOKEN: PREVIEW_OPS_CONTROL_TOKEN,
      OPS_CONTROL_URL: runtimeEndpoints.VITE_OPS_CONTROL_URL,
      WHATSAPP_MICROSERVICE_URL: runtimeEndpoints.VITE_WHATSAPP_MICROSERVICE_URL,
      TELEGRAM_MICROSERVICE_URL: runtimeEndpoints.VITE_TELEGRAM_MICROSERVICE_URL,
      SHOPEE_MICROSERVICE_URL: runtimeEndpoints.VITE_SHOPEE_MICROSERVICE_URL,
      MELI_RPA_URL: runtimeEndpoints.VITE_MELI_RPA_URL,
      DISABLE_SIGNUP: process.env.DISABLE_SIGNUP || "false",
    }),
  };

  let apiResult;
  try {
    apiResult = await ensureServiceOnline(apiConfig);
  } catch (error) {
    stopAll();
    throw new Error(`API indisponível para preview: ${error instanceof Error ? error.message : String(error)}`);
  }

  registerStartedProcess(apiConfig, apiResult);

  const schedulerDisabled = String(process.env.PREVIEW_DISABLE_SCHEDULER || "").trim() === "1";
  if (schedulerDisabled) {
    console.warn("[preview:ready] PREVIEW_DISABLE_SCHEDULER=1 detectado. Polling continuo de canais foi desativado.");
  } else {
    const schedulerScriptPath = "scripts/dispatch-scheduler.mjs";
    const schedulerServiceToken = process.env.SERVICE_TOKEN || PREVIEW_SERVICE_TOKEN;
    const schedulerBaseUrl = process.env.SCHEDULER_RPC_BASE_URL || runtimeEndpoints.VITE_API_URL;
    const schedulerEnv = {
      NODE_ENV: process.env.NODE_ENV || "development",
      SERVICE_TOKEN: schedulerServiceToken,
      SCHEDULER_MODE: "remote",
      SCHEDULER_RPC_BASE_URL: schedulerBaseUrl,
      SCHEDULER_RPC_TOKEN: process.env.SCHEDULER_RPC_TOKEN || schedulerServiceToken,
      DISPATCH_SOURCE: process.env.DISPATCH_SOURCE || "preview-ready-worker",
    };

    const schedulerProcess = startNodeService(schedulerScriptPath, schedulerEnv);
    startedProcesses.push(schedulerProcess);
    attachAutoRestartScript("Scheduler Worker", schedulerProcess, schedulerScriptPath, schedulerEnv);
    console.log(`[preview:ready] Scheduler local ativo em modo remote (${schedulerBaseUrl}).`);
  }

  console.log("[preview:ready] Servicos prontos. Abrindo preview...");
  const previewArgs = [
    "run",
    "preview:safe",
    "--",
    "--host",
    host,
    "--port",
    String(startPort),
  ];

  if (strictPreviewPort) {
    previewArgs.push("--strictPort");
  }

  const preview = startNpm(previewArgs, {
    ...runtimeEndpoints,
  });

  preview.on("exit", (code) => {
    stopAll();
    process.exit(code ?? 0);
  });

  preview.on("error", (error) => {
    stopAll();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[preview:ready] Falha ao iniciar preview: ${message}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[preview:ready] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
