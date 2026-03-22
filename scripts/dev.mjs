import { spawn } from "node:child_process";

const API_HEALTH_URL = "http://127.0.0.1:3116/health";
const npmCliPath = process.env.npm_execpath || "";

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
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
      reject(new Error(`${label} could not start: ${error instanceof Error ? error.message : String(error)}`));
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

async function ensureDatabaseReady() {
  const apiHealthyBefore = await fetchHealth(API_HEALTH_URL);

  try {
    console.log("[dev] Ensuring local PostgreSQL with docker compose...");
    await runCommand("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "--wait"], "docker compose up");

    console.log("[dev] Applying local DB migrations...");
    await runNpm(["run", "db:migrate:dev"], "db migrations");

    console.log("[dev] Syncing local seed users...");
    await runNpm(["run", "seed:dev"], "db seed");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const apiHealthyAfter = await fetchHealth(API_HEALTH_URL);

    if (apiHealthyBefore || apiHealthyAfter) {
      console.warn(`[dev] Docker/bootstrap skipped: ${message}`);
      console.warn("[dev] Existing API is healthy on port 3116, continuing with OPS + API standby + WEB.");
      return true;
    }

    console.warn(`[dev] Docker/bootstrap skipped: ${message}`);
    if (message.includes("500 Internal Server Error") || message.includes("cannot find the file specified")) {
      console.warn("[dev] ⚠ Docker Desktop engine (WSL2) não está respondendo.");
      console.warn("[dev]   1. Feche o Docker Desktop (Quit)");
      console.warn("[dev]   2. Rode: wsl --shutdown && wsl --update");
      console.warn("[dev]   3. Reabra o Docker Desktop e espere ficar verde");
      console.warn("[dev]   4. Rode: npm run dev");
    }
    console.warn("[dev] API is not healthy on port 3116. Starting degraded mode (OPS + WEB only).");
    return false;
  }
}

async function startRuntime(withApi) {
  if (withApi) {
    await runNpm(["run", "dev:runtime"], "runtime services");
    return;
  }
  await runNpm(["run", "dev:runtime:degraded"], "runtime services (degraded)");
}

async function main() {
  const withApi = await ensureDatabaseReady();
  await startRuntime(withApi);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
