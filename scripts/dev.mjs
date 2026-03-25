import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const API_HEALTH_URL = "http://127.0.0.1:3116/health";
const OPS_HEALTH_URL = "http://127.0.0.1:3115/health";
const WEB_HEALTH_URL = "http://127.0.0.1:5173/";
const npmCliPath = process.env.npm_execpath || "";
const LOCAL_PG_HOST = process.env.POSTGRES_HOST || "localhost";
const LOCAL_PG_PORT = Number(process.env.POSTGRES_PORT || "5432");
const SKIP_DOCKER = String(process.env.DEV_SKIP_DOCKER || process.env.PREVIEW_SKIP_DOCKER || "").trim() === "1";

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

function runCommand(command, args, label, options = {}) {
  const stdio = options.stdio || "inherit";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio,
      shell: false,
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

async function isDockerEngineReady() {
  try {
    await runCommand("docker", ["info"], "docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

async function maybeStartDockerDesktop(lastErrorMessage) {
  if (process.platform !== "win32") return false;
  const dockerEngineReady = await isDockerEngineReady();
  if (dockerEngineReady) return false;

  const likelyEngineOffline = isDockerEngineUnavailableMessage(lastErrorMessage);
  if (!likelyEngineOffline) {
    console.warn("[dev] Docker compose failed and docker info is unavailable. Trying Docker Desktop auto-start...");
  }

  const dockerDesktopExe = findDockerDesktopExe();
  if (!dockerDesktopExe) {
    console.warn("[dev] Docker Desktop executable not found. Install Docker Desktop or set DOCKER_DESKTOP_PATH.");
    return false;
  }

  console.warn("[dev] Docker engine unavailable. Trying to start Docker Desktop...");
  try {
    const desktop = spawn(dockerDesktopExe, [], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    desktop.unref();
  } catch (error) {
    console.warn(`[dev] Failed to start Docker Desktop automatically: ${errorMessage(error)}`);
    return false;
  }

  console.warn("[dev] Waiting Docker engine to become ready...");
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    if (await isDockerEngineReady()) {
      console.log("[dev] Docker engine is ready.");
      return true;
    }
    await sleep(2000);
  }

  console.warn("[dev] Docker Desktop did not become ready in time.");
  return false;
}

async function ensureDockerComposePostgres() {
  if (SKIP_DOCKER) {
    console.log("[dev] DEV_SKIP_DOCKER=1/PREVIEW_SKIP_DOCKER=1 detected. Skipping docker compose.");
    return null;
  }

  try {
    console.log("[dev] Ensuring local PostgreSQL with docker compose...");
    await runCommand("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "--wait"], "docker compose up");
    return null;
  } catch (error) {
    let composeError = errorMessage(error);
    const dockerStarted = await maybeStartDockerDesktop(composeError);

    if (!dockerStarted) {
      return composeError;
    }

    try {
      console.log("[dev] Retrying docker compose after Docker Desktop startup...");
      await runCommand("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "--wait"], "docker compose up");
      return null;
    } catch (retryError) {
      composeError = errorMessage(retryError);
      return composeError;
    }
  }
}

async function runMigrationsAndSeed() {
  console.log("[dev] Applying local DB migrations...");
  await runNpm(["run", "db:migrate:dev"], "db migrations");

  console.log("[dev] Syncing local seed users...");
  await runNpm(["run", "seed:dev"], "db seed");
}

async function ensureDatabaseReady() {
  const apiHealthyBefore = await fetchHealth(API_HEALTH_URL);
  const composeError = await ensureDockerComposePostgres();

  try {
    await runMigrationsAndSeed();

    if (composeError) {
      console.warn(`[dev] Docker compose skipped: ${composeError}`);
      console.warn(`[dev] Continuing with PostgreSQL already reachable at ${LOCAL_PG_HOST}:${LOCAL_PG_PORT}.`);
    }

    return true;
  } catch (error) {
    const bootstrapError = errorMessage(error);
    const apiHealthyAfter = await fetchHealth(API_HEALTH_URL);

    if (apiHealthyBefore || apiHealthyAfter) {
      if (composeError) {
        console.warn(`[dev] Docker compose skipped: ${composeError}`);
      }
      console.warn(`[dev] DB migrate/seed skipped: ${bootstrapError}`);
      console.warn("[dev] Existing API is healthy on port 3116, continuing with OPS + API standby + WEB.");
      return true;
    }

    if (composeError) {
      console.warn(`[dev] Docker/bootstrap skipped: ${composeError}`);
    }
    console.warn(`[dev] DB bootstrap failed: ${bootstrapError}`);

    const dockerEngineOffline = !(await isDockerEngineReady());
    if (dockerEngineOffline || isDockerEngineUnavailableMessage(composeError || bootstrapError)) {
      console.warn("[dev] Docker Desktop engine is not responding yet.");
      console.warn("[dev]   1. Start Docker Desktop and wait for the engine to be ready");
      console.warn("[dev]   2. Or run with DEV_SKIP_DOCKER=1 when PostgreSQL is already running");
      console.warn("[dev]   3. Then run: npm run dev");
    }

    console.warn("[dev] API is not healthy on port 3116. Starting degraded mode (OPS + WEB only).");
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
    console.log("[dev] API (:3116), Ops (:3115) and WEB (:5173) are already healthy. Reusing existing stack.");
    console.log("[dev] Open: http://127.0.0.1:5173/");
    return;
  }

  if (apiHealthy && opsHealthy) {
    console.log("[dev] Existing API (:3116) and Ops (:3115) are healthy. Starting attach mode (SCHED + WEB).");
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
