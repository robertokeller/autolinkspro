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

const sensitiveEnvKeys = new Set([
  "RESEND_API_KEY",
  "HOSTINGER_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "COOLIFY_API_TOKEN",
  "JWT_SECRET",
  "SERVICE_TOKEN",
  "WEBHOOK_SECRET",
  "OPS_CONTROL_TOKEN",
  "DATABASE_URL",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CREDENTIAL_CIPHER_SALT",
  "SESSION_ENCRYPTION_KEY",
  "SESSION_CIPHER_SALT",
  "BACKUP_ENCRYPTION_KEY",
  "OPENROUTER_API_KEY",
]);

const highConfidenceSecretPatterns = [
  { type: "coolify-api-token", regex: /\b2\|[A-Za-z0-9]{20,}\b/ },
  { type: "cloudflare-api-token", regex: /\bcf(?:at|ut)_[A-Za-z0-9]{20,}\b/i },
  { type: "resend-api-key", regex: /\bre_[A-Za-z0-9_]{20,}\b/ },
  { type: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "postgres-url-with-password", regex: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i },
  { type: "private-key-block", regex: /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) PRIVATE KEY-----/ },
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

function parseStagedAddedLines() {
  const patch = safeExecGit(["diff", "--cached", "--no-color", "--unified=0", "--", "."]);
  const lines = patch.split(/\r?\n/);
  const added = [];

  let currentFile = "";
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      currentLine = match ? Number(match[1]) - 1 : currentLine;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine += 1;
      added.push({ file: currentFile || "<unknown>", line: currentLine, text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (line.startsWith(" ")) {
      currentLine += 1;
    }
  }

  return added;
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

function normalizeCandidateValue(rawValue) {
  const value = String(rawValue || "")
    .replace(/\s+#.*$/, "")
    .trim();
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isLikelyPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("troque-por")) return true;
  if (normalized.includes("placeholder")) return true;
  if (normalized.includes("changeme")) return true;
  if (normalized.includes("example")) return true;
  if (normalized.includes("${")) return true;
  if (/^re_x+$/i.test(normalized)) return true;
  if (/^cf(?:at|ut)_x+$/i.test(normalized)) return true;
  if (/^[x*]{16,}$/i.test(normalized)) return true;
  return false;
}

function findSensitiveContentInStagedDiff() {
  const findings = [];
  const seen = new Set();
  const addedLines = parseStagedAddedLines();

  for (const entry of addedLines) {
    const text = String(entry.text || "").trim();
    if (!text || text.startsWith("#")) continue;

    for (const pattern of highConfidenceSecretPatterns) {
      const match = text.match(pattern.regex);
      if (!match) continue;
      const candidate = normalizeCandidateValue(match[0]);
      if (isLikelyPlaceholder(candidate)) continue;

      const key = `${entry.file}:${entry.line}:${pattern.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file: entry.file,
        line: entry.line,
        type: pattern.type,
      });
    }

    const envAssignment = text.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!envAssignment) continue;
    const envKey = envAssignment[1];
    if (!sensitiveEnvKeys.has(envKey)) continue;

    const candidateValue = normalizeCandidateValue(envAssignment[2]);
    if (candidateValue.length < 16 || isLikelyPlaceholder(candidateValue)) continue;

    const findingKey = `${entry.file}:${entry.line}:env:${envKey}`;
    if (seen.has(findingKey)) continue;
    seen.add(findingKey);
    findings.push({
      file: entry.file,
      line: entry.line,
      type: `sensitive-env-${envKey.toLowerCase()}`,
    });
  }

  return findings;
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
  const contentFindings = findSensitiveContentInStagedDiff();

  if (
    trackedFindings.length === 0
    && stagedFindings.length === 0
    && contentFindings.length === 0
  ) {
    console.log("[commit-safety] ok: nenhum arquivo sensivel rastreado ou staged.");
    process.exit(0);
  }

  console.error("[commit-safety] bloqueado: risco de segredo detectado no git.");
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

  if (contentFindings.length > 0) {
    console.error("Staged diff (possible secret values):");
    for (const item of contentFindings) {
      console.error(`- ${item.file}:${item.line} [${item.type}]`);
    }
  }

  console.error("[commit-safety] remova do index e mantenha apenas em .private/ ou no secret manager.");
  process.exit(1);
}

main();
