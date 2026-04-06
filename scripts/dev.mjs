import { spawn } from "node:child_process";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const npmCliPath = process.env.npm_execpath || "";

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

function runNpm(args, label) {
  return new Promise((resolve, reject) => {
    const command = npmCliPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const commandArgs = npmCliPath ? [npmCliPath, ...args] : args;

    const child = spawn(command, commandArgs, {
      stdio: "inherit",
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

async function main() {
  console.log("[dev] Delegating to preview-ready so local boot waits for API + microservices before opening the app.");
  await runNpm(["run", "preview:ready", "--", "--host", "127.0.0.1", "--port", "5173"], "preview-ready");
}

main().catch((error) => {
  console.error(`[dev] ${errorMessage(error)}`);
  process.exit(1);
});
