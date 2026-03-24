import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  "docker/ops-control.Dockerfile",
  "docker/scheduler.Dockerfile",
  "docker/migrate.Dockerfile",
];

const requiredDirs = [
  "src",
  "services",
  "docker",
  "database",
  "scripts",
];

const requiredComposeServices = [
  "web",
  "api",
  "postgres",
  "migrate",
  "scheduler",
  "whatsapp",
  "telegram",
  "shopee",
  "meli",
  "ops-control",
];

const requiredEnvVars = [
  "POSTGRES_PASSWORD",
  "APPLY_SEED_MIGRATIONS",
  "JWT_SECRET",
  "SERVICE_TOKEN",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CORS_ORIGIN",
  "APP_PUBLIC_URL",
  "API_PUBLIC_URL",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "WEBHOOK_SECRET",
  "OPS_CONTROL_TOKEN",
  "VITE_API_URL",
  "VITE_WHATSAPP_MICROSERVICE_URL",
  "VITE_TELEGRAM_MICROSERVICE_URL",
  "VITE_SHOPEE_MICROSERVICE_URL",
  "VITE_MELI_RPA_URL",
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
}

const envSensitiveFiles = [".env", ".env.local", ".env.coolify"];
for (const envFile of envSensitiveFiles) {
  if (exists(envFile)) {
    warnings.push(
      `${envFile} exists locally. Keep it out of GitHub and only configure values in Coolify.`,
    );
  }
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
