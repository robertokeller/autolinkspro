import { createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

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

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host, startPort, maxAttempts = 30) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    const free = await canListen(host, port);
    if (free) return port;
  }
  throw new Error(`Nao foi possivel encontrar porta livre a partir de ${startPort}`);
}

async function findPreviewPort(host, startPort, maxAttempts = 30) {
  return findFreePort(host, startPort, maxAttempts);
}

async function main() {
  const host = parseArgValue("host") || parsePositionalHost() || process.env.PREVIEW_HOST || "0.0.0.0";
  const positionalPort = parsePositionalPort();
  const startPort = Number(parseArgValue("port") || positionalPort || process.env.PREVIEW_PORT || "5173");
  const strict = process.argv.includes("--strictPort");

  if (!Number.isFinite(startPort) || startPort <= 0) {
    throw new Error("Porta inicial invalida para preview");
  }

  const port = strict ? startPort : await findPreviewPort(host, startPort);
  const finalUrl = `http://${host}:${port}/`;

  console.log(`[preview:safe] Iniciando preview em ${finalUrl}`);
  if (!strict && port !== startPort) {
    console.log(`[preview:safe] Porta ${startPort} ocupada, usando ${port}`);
  }

  const viteCliPath = path.resolve(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  const viteArgs = [viteCliPath, "--host", host, "--port", String(port), "--open"];
  if (strict) viteArgs.push("--strictPort");

  const child = spawn(process.execPath, viteArgs, {
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(`[preview:safe] Falha ao iniciar Vite: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[preview:safe] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
