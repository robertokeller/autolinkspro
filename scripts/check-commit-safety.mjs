#!/usr/bin/env node
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const cwd = process.cwd();

const exactBlocked = new Set([
  ".credential-cipher-salt",
]);

const prefixBlocked = [
  ".private/env/",
  ".private/secrets/",
  ".agents/",
  ".ai/",
  ".copilot/",
  ".claude/",
  ".synnacode/",
  ".ops/",
];

const regexBlocked = [
  /(^|\/)\.env(\.[^/]+)?$/i,
  /(^|\/)\.envrc$/i,
  /\.secrets?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

function isAllowedEnvExample(normalizedPath) {
  return /(^|\/)\.env(\.coolify)?\.example$/i.test(normalizedPath);
}

function normalizeGitPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function isBlocked(filePath) {
  const normalized = normalizeGitPath(filePath);
  if (
    normalized === ".private/env/.gitkeep"
    || normalized === ".private/secrets/.gitkeep"
    || normalized === ".private/.gitkeep"
  ) {
    return false;
  }
  if (isAllowedEnvExample(normalized)) return false;
  if (exactBlocked.has(normalized)) return true;
  if (prefixBlocked.some((prefix) => normalized.startsWith(prefix))) return true;
  return regexBlocked.some((pattern) => pattern.test(normalized));
}

function safeExecGit(args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function getGitTrackedFiles() {
  const output = safeExecGit(["ls-files", "-z"]);
  return output
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getGitStagedFiles() {
  const output = safeExecGit(["diff", "--cached", "--name-only", "-z"]);
  return output
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean);
}

function listLocalSensitiveCandidates(baseDir) {
  const findings = [];
  const stack = [baseDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = normalizeGitPath(path.relative(baseDir, fullPath));

      if (relative.startsWith("node_modules/") || relative.startsWith("dist/")) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (isBlocked(relative)) findings.push(relative);
    }
  }

  return findings.sort();
}

function main() {
  let insideGitRepo = false;
  try {
    const output = safeExecGit(["rev-parse", "--is-inside-work-tree"]).trim();
    insideGitRepo = output === "true";
  } catch {
    insideGitRepo = false;
  }

  if (!insideGitRepo) {
    console.log("[commit-safety] git repo nao detectado neste diretório; executando varredura local simples.");
    const localFindings = listLocalSensitiveCandidates(cwd);
    if (localFindings.length === 0) {
      console.log("[commit-safety] ok: nenhum arquivo sensivel detectado nos padrões monitorados.");
      process.exit(0);
    }
    console.log("[commit-safety] alerta: arquivos sensiveis encontrados localmente:");
    for (const item of localFindings) {
      console.log(`- ${item}`);
    }
    console.log("[commit-safety] confirme que esses arquivos permanecem ignorados antes de publicar.");
    process.exit(0);
  }

  const trackedFindings = getGitTrackedFiles().filter((filePath) => isBlocked(filePath));
  const stagedFindings = getGitStagedFiles().filter((filePath) => isBlocked(filePath));

  if (trackedFindings.length === 0 && stagedFindings.length === 0) {
    console.log("[commit-safety] ok: nenhum arquivo sensivel rastreado ou staged.");
    process.exit(0);
  }

  console.error("[commit-safety] bloqueado: arquivos sensiveis detectados no git.");
  if (trackedFindings.length > 0) {
    console.error("Tracked:");
    for (const item of trackedFindings) {
      console.error(`- ${item}`);
    }
  }

  if (stagedFindings.length > 0) {
    console.error("Staged:");
    for (const item of stagedFindings) {
      console.error(`- ${item}`);
    }
  }

  console.error("[commit-safety] remova do index e mantenha apenas em .private/ ou no secret manager.");
  process.exit(1);
}

main();
