import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const cwd = process.cwd();

const requiredFiles = [
  "docker-compose.coolify.yml",
  ".env.coolify.example",
  "index.html",
  "src/main.tsx",
  "docker/web.Dockerfile",
  "docker/api.Dockerfile",
  "docker/whatsapp.Dockerfile",
  "docker/telegram.Dockerfile",
  "docker/shopee.Dockerfile",
  "docker/meli.Dockerfile",
  "docker/amazon.Dockerfile",
  "docker/ops-control.Dockerfile",
  "docker/scheduler.Dockerfile",
  "docker/sessions-backup.Dockerfile",
  "supabase/config.toml",
];

const requiredDirs = [
  "src",
  "services",
  "docker",
  "supabase",
  "scripts",
];

const requiredComposeServices = [
  "web",
  "api",
  "scheduler",
  "whatsapp",
  "telegram",
  "shopee",
  "meli",
  "amazon",
  "ops-control",
  "sessions-backup",
];

const requiredEnvVars = [
  "DATABASE_URL",
  "DB_SSL",
  "DB_SSL_REJECT_UNAUTHORIZED",
  "JWT_SECRET",
  "SERVICE_TOKEN",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CREDENTIAL_CIPHER_SALT",
  "CORS_ORIGIN",
  "APP_PUBLIC_URL",
  "API_PUBLIC_URL",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "WEBHOOK_SECRET",
  "OPS_CONTROL_TOKEN",
  "BACKUP_ENCRYPTION_KEY",
  "ALLOW_PUBLIC_RPC",
  "DISABLE_SIGNUP",
  "VITE_API_URL",
  "VITE_WHATSAPP_MICROSERVICE_URL",
  "VITE_TELEGRAM_MICROSERVICE_URL",
  "VITE_SHOPEE_MICROSERVICE_URL",
  "VITE_MELI_RPA_URL",
  "VITE_AMAZON_MICROSERVICE_URL",
  "VITE_OPS_CONTROL_URL",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "MELI_CORS_ORIGIN",
  "SCHEDULER_MODE",
  "SCHEDULER_RPC_BASE_URL",
];

const errors = [];
const warnings = [];

function exists(relativePath) {
  return fs.existsSync(path.join(cwd, relativePath));
}

function isDirectory(relativePath) {
  const target = path.join(cwd, relativePath);
  return exists(relativePath) && fs.statSync(target).isDirectory();
}

function read(relativePath) {
  return fs.readFileSync(path.join(cwd, relativePath), "utf8");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readEnvValue(content, key) {
  const envPattern = new RegExp(`^${escapeRegex(key)}=(.*)$`, "m");
  const match = content.match(envPattern);
  return match ? String(match[1] ?? "").trim() : "";
}

for (const file of requiredFiles) {
  if (!exists(file)) {
    errors.push(`Missing required file: ${file}`);
  }
}

for (const dir of requiredDirs) {
  if (!isDirectory(dir)) {
    errors.push(`Missing required directory: ${dir}`);
  }
}

if (exists("index.html") && exists("src/main.tsx")) {
  const indexHtml = read("index.html");
  const hasMainImport =
    indexHtml.includes('/src/main.tsx') || indexHtml.includes("./src/main.tsx");
  if (!hasMainImport) {
    warnings.push(
      "index.html does not reference /src/main.tsx (check your frontend entrypoint).",
    );
  }
}

if (exists("docker-compose.coolify.yml")) {
  const compose = read("docker-compose.coolify.yml");
  for (const service of requiredComposeServices) {
    const servicePattern = new RegExp(`^\\s{2}${escapeRegex(service)}:\\s*$`, "m");
    if (!servicePattern.test(compose)) {
      errors.push(`docker-compose.coolify.yml missing service: ${service}`);
    }
  }
}

if (exists(".env.coolify.example")) {
  const envExample = read(".env.coolify.example");
  for (const key of requiredEnvVars) {
    const envPattern = new RegExp(`^${key}=`, "m");
    if (!envPattern.test(envExample)) {
      errors.push(`.env.coolify.example missing variable: ${key}`);
    }
  }

  const seedEnabled = /^APPLY_SEED_MIGRATIONS\s*=\s*true\s*$/mi.test(envExample);
  if (seedEnabled) {
    warnings.push(
      "APPLY_SEED_MIGRATIONS=true found in .env.coolify.example. In production, keep it as false to avoid seeding demo users.",
    );
  }

  const dbSslRejectUnauthorized = readEnvValue(envExample, "DB_SSL_REJECT_UNAUTHORIZED").toLowerCase();
  if (dbSslRejectUnauthorized === "false") {
    warnings.push(
      "DB_SSL_REJECT_UNAUTHORIZED=false in .env.coolify.example. Prefer true in production to enforce DB TLS certificate validation.",
    );
  }

  const allowPublicRpc = readEnvValue(envExample, "ALLOW_PUBLIC_RPC").toLowerCase();
  if (allowPublicRpc === "true") {
    warnings.push(
      "ALLOW_PUBLIC_RPC=true in .env.coolify.example. This exposes public RPC routes without session; set false unless intentionally required.",
    );
  }

  const backupEncryptionKey = readEnvValue(envExample, "BACKUP_ENCRYPTION_KEY");
  if (!backupEncryptionKey) {
    warnings.push(
      "BACKUP_ENCRYPTION_KEY is empty in .env.coolify.example. Session backups must be encrypted in production.",
    );
  }
}

const envSensitiveFiles = [".env", ".env.local", ".env.coolify"];
for (const envFile of envSensitiveFiles) {
  if (exists(envFile)) {
    warnings.push(
      `${envFile} exists locally. Keep it out of GitHub and only configure values in Coolify.`,
    );
  }
}

if (!isDirectory(".private/env") || !isDirectory(".private/secrets")) {
  warnings.push(
    "Private env/secrets directories not found. Run `npm run env:private:setup` before commit/deploy.",
  );
}

const heading = "[preflight-coolify]";

if (warnings.length > 0) {
  console.log(`${heading} warnings:`);
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.error(`${heading} failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`${heading} ok: project is ready for manual upload and Coolify deploy.`);

// ─── security checklist (sempre executado ao final do preflight) ──────────────
try {
  execFileSync(
    process.execPath,
    [path.join(cwd, "scripts", "check-commit-safety.mjs")],
    { stdio: "inherit" },
  );
} catch {
  process.exit(1);
}

try {
  execFileSync(
    process.execPath,
    [path.join(cwd, "scripts", "generate-deploy-doc.mjs")],
    { stdio: "inherit" },
  );
} catch {
  process.exit(1);
}

try {
  execFileSync(
    process.execPath,
    [path.join(cwd, "scripts", "deploy-checklist.mjs")],
    { stdio: "inherit" },
  );
} catch {
  // deploy-checklist.mjs já imprimiu os erros e saiu com código != 0
  process.exit(1);
}
