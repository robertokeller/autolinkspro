import { spawn } from "node:child_process";
import path from "node:path";

const WA_HEALTH_URL = "http://127.0.0.1:3111/health";
const TELEGRAM_HEALTH_URL = "http://127.0.0.1:3112/health";
const SHOPEE_HEALTH_URL = "http://127.0.0.1:3113/health";
const MELI_HEALTH_URL = "http://127.0.0.1:3114/api/meli/health";
const OPS_HEALTH_URL = "http://127.0.0.1:3115/health";
const API_HEALTH_URL = "http://127.0.0.1:3116/health";
const npmCliPath = process.env.npm_execpath || "";
const LOCAL_HOST = "127.0.0.1";

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

async function isPortFree(host, port) {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findFreePort(host, startPort, maxAttempts = 50) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (await isPortFree(host, candidate)) {
      return candidate;
    }
  }
  throw new Error(`Nao foi possivel encontrar porta livre a partir de ${startPort}`);
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
      reject(new Error(`${label} nao iniciou: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

function runCommand(command, args, label, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: buildSpawnEnv(envOverrides),
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} falhou com codigo ${code ?? "desconhecido"}`));
    });

    child.on("error", (error) => {
      reject(new Error(`${label} nao iniciou: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

async function ensureDatabaseReady() {
  const skipDocker = String(process.env.PREVIEW_SKIP_DOCKER || "").trim() === "1";
  if (!skipDocker) {
    console.log("[preview:ready] Garantindo PostgreSQL local (docker compose dev)...");
    await runCommand(
      "docker",
      ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "--wait"],
      "subir postgres local",
    );
  } else {
    console.log("[preview:ready] PREVIEW_SKIP_DOCKER=1 detectado. Pulando docker compose.");
  }

  console.log("[preview:ready] Aplicando migracoes no banco local...");
  await runNpm(["run", "db:migrate:dev"], "migracoes do banco");

  console.log("[preview:ready] Sincronizando usuarios seed...");
  await runNpm(["run", "seed:dev"], "seed de usuarios");
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
  } = serviceConfig;

  if (await fetchHealth(healthUrl, 2500, healthHeaders || null)) {
    console.log(`[preview:ready] ${name} ja estava online`);
    return {
      name,
      ok: true,
      endpoint: `http://${LOCAL_HOST}:${defaultPort}`,
      envKey,
      process: null,
      startedHere: false,
    };
  }

  let servicePort = defaultPort;
  const portFree = await isPortFree(LOCAL_HOST, defaultPort);

  if (!portFree) {
    servicePort = await findFreePort(LOCAL_HOST, defaultPort + 1);
    console.warn(`[preview:ready] Porta ${defaultPort} ocupada. ${name} sera iniciado na porta ${servicePort}.`);
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
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "preview-local-dev-secret",
    ...runtimeEnv(servicePort),
  };

  const serviceProcess = startNodeService(distPath, processEnv);
  const online = await waitForHealth(resolvedHealthUrl, 30, 1000, healthHeaders || null);

  if (!online) {
    if (!serviceProcess.killed) {
      serviceProcess.kill("SIGTERM");
    }
    throw new Error(`${name}: nao respondeu em ${resolvedHealthUrl}`);
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
    throw new Error("Porta inicial invalida para preview");
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
          if (!ok) console.warn(`[preview:ready] ${name} reiniciou mas nao respondeu health check`);
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
      healthHeaders: { "x-webhook-secret": process.env.WEBHOOK_SECRET || "preview-local-dev-secret" },
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
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "preview-local-dev-secret",
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
    console.warn(
      `[preview:ready] Alguns servicos nao iniciaram automaticamente: ${failures.join(" | ")}`,
    );
    console.warn("[preview:ready] O frontend sera iniciado mesmo assim. Funcionalidades desses servicos podem ficar indisponiveis.");
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
    runtimeEnv: () => ({
      NODE_ENV: process.env.NODE_ENV || "development",
      HOST: "0.0.0.0",
      POSTGRES_HOST: process.env.POSTGRES_HOST || "localhost",
      POSTGRES_PORT: process.env.POSTGRES_PORT || "5432",
      POSTGRES_DB: process.env.POSTGRES_DB || "autolinks",
      POSTGRES_USER: process.env.POSTGRES_USER || "autolinks",
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "autolinks",
      JWT_SECRET: process.env.JWT_SECRET || "dev-jwt-secret-local-only-32chars!!",
      SERVICE_TOKEN: process.env.SERVICE_TOKEN || "dev-service-token-local-only",
      CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
      ADMIN_EMAIL: process.env.ADMIN_EMAIL || "robertokellercontato@gmail.com",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "abacate1",
      OPS_CONTROL_TOKEN: process.env.OPS_CONTROL_TOKEN || "preview-ops-token",
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
    throw new Error(`API indisponivel para preview: ${error instanceof Error ? error.message : String(error)}`);
  }

  registerStartedProcess(apiConfig, apiResult);

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
