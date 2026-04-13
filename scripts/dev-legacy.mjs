import { spawn } from "node:child_process";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const API_HEALTH_URL = "http://127.0.0.1:3116/health";
const OPS_HEALTH_URL = "http://127.0.0.1:3115/health";
const WEB_HEALTH_URL = "http://127.0.0.1:5173/";
const npmCliPath = process.env.npm_execpath || "";
const SKIP_DOCKER = String(process.env.DEV_SKIP_DOCKER || process.env.PREVIEW_SKIP_DOCKER || "").trim() === "1";
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildSpawnEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.startsWith("=") || value == null) continue;
    env[key] = String(value);
  }
  return env;
}

function runCommand(command, args, label, options = {}) {
  const stdio = options.stdio || "inherit";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio,
      shell: false,
      env: buildSpawnEnv(),
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with code ${code ?? "unknown"}`));
    });

    child.on("error", (error) => {
      reject(new Error(`${label} could not start: ${errorMessage(error)}`));
    });
  });
}

function runNpm(args, label) {
  const command = npmCliPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCliPath ? [npmCliPath, ...args] : args;
  return runCommand(command, commandArgs, label);
}

async function fetchHealth(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureDockerComposePostgres() {
  if (!DATABASE_URL) {
    return "DATABASE_URL not configured";
  }
  console.log("[dev:legacy] DATABASE_URL detected. Using shared Supabase database.");
  if (SKIP_DOCKER) {
    console.log("[dev:legacy] DEV_SKIP_DOCKER/PREVIEW_SKIP_DOCKER ignored (database is remote Supabase).");
  }
  return null;
}

async function runMigrationsAndSeed() {
  console.log("[dev:legacy] Applying local DB migrations...");
  await runNpm(["run", "db:migrate:dev"], "db migrations");

  console.log("[dev:legacy] Syncing local seed users...");
  await runNpm(["run", "seed:dev"], "db seed");
}

async function ensureDatabaseReady() {
  const apiHealthyBefore = await fetchHealth(API_HEALTH_URL);
  const composeError = await ensureDockerComposePostgres();

  try {
    await runMigrationsAndSeed();

    if (composeError) {
      console.warn(`[dev:legacy] Docker compose skipped: ${composeError}`);
      console.warn("[dev:legacy] Continuing with existing API runtime.");
    }

    return true;
  } catch (error) {
    const bootstrapError = errorMessage(error);
    const apiHealthyAfter = await fetchHealth(API_HEALTH_URL);

    if (apiHealthyBefore || apiHealthyAfter) {
      if (composeError) {
        console.warn(`[dev:legacy] Docker compose skipped: ${composeError}`);
      }
      console.warn(`[dev:legacy] DB migrate/seed skipped: ${bootstrapError}`);
      console.warn("[dev:legacy] Existing API is healthy on port 3116, continuing with OPS + API standby + WEB.");
      return true;
    }

    if (composeError) {
      console.warn(`[dev:legacy] Docker/bootstrap skipped: ${composeError}`);
    }
    console.warn(`[dev:legacy] DB bootstrap failed: ${bootstrapError}`);

    if (!DATABASE_URL) {
      console.warn("[dev:legacy] Configure DATABASE_URL before running dev.");
    }

    console.warn("[dev:legacy] API is not healthy on port 3116. Starting degraded mode (OPS + WEB only).");
    return false;
  }
}

async function startRuntime(withApi) {
  if (!withApi) {
    await runNpm(["run", "dev:runtime:degraded"], "runtime services (degraded)");
    return;
  }

  const [apiHealthy, opsHealthy, webHealthy] = await Promise.all([
    fetchHealth(API_HEALTH_URL),
    fetchHealth(OPS_HEALTH_URL),
    fetchHealth(WEB_HEALTH_URL),
  ]);

  if (apiHealthy && opsHealthy && webHealthy) {
    console.log("[dev:legacy] API (:3116), Ops (:3115) and WEB (:5173) are already healthy. Reusing existing stack.");
    console.log("[dev:legacy] Open: http://127.0.0.1:5173/");
    return;
  }

  if (apiHealthy && opsHealthy) {
    console.log("[dev:legacy] Existing API (:3116) and Ops (:3115) are healthy. Starting attach mode (SCHED + WEB).");
    await runNpm(["run", "dev:runtime:attach"], "runtime services (attach)");
    return;
  }

  await runNpm(["run", "dev:runtime"], "runtime services");
}

async function main() {
  const withApi = await ensureDatabaseReady();
  await startRuntime(withApi);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
