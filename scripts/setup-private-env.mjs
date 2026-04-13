#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const privateDir = path.join(cwd, ".private");
const privateEnvDir = path.join(privateDir, "env");
const privateSecretsDir = path.join(privateDir, "secrets");

const bootstrapRules = [
  {
    target: ".private/env/.env",
    sources: [".env", ".env.example"],
    label: "runtime env",
  },
  {
    target: ".private/env/.env.local",
    sources: [".env.local"],
    label: "local overrides",
  },
  {
    target: ".private/env/.env.coolify",
    sources: [".env.coolify", ".env.coolify.example"],
    label: "deploy env",
  },
];

function ensureDir(targetPath) {
  mkdirSync(targetPath, { recursive: true, mode: 0o700 });
}

function resolve(relativePath) {
  return path.join(cwd, relativePath);
}

function copyIfMissing(rule) {
  const targetPath = resolve(rule.target);
  if (existsSync(targetPath)) {
    console.log(`[env-private] skip  ${rule.target} (already exists)`);
    return false;
  }

  const source = rule.sources.find((candidate) => existsSync(resolve(candidate)));
  if (!source) {
    console.log(`[env-private] skip  ${rule.target} (no source found)`);
    return false;
  }

  copyFileSync(resolve(source), targetPath);
  console.log(`[env-private] create ${rule.target} <- ${source} (${rule.label})`);
  return true;
}

function main() {
  ensureDir(privateDir);
  ensureDir(privateEnvDir);
  ensureDir(privateSecretsDir);

  let createdCount = 0;
  for (const rule of bootstrapRules) {
    if (copyIfMissing(rule)) createdCount += 1;
  }

  const rootSensitiveFiles = [".env", ".env.local", ".env.coolify", ".credential-cipher-salt"]
    .filter((relativePath) => existsSync(resolve(relativePath)));
  if (rootSensitiveFiles.length > 0) {
    console.log("");
    console.log("[env-private] warning: arquivos sensiveis encontrados na raiz.");
    for (const file of rootSensitiveFiles) {
      console.log(`- ${file}`);
    }
    console.log("[env-private] recomendado: mover para .private/env (ou .private/secrets) e manter fora de commits.");
  }

  console.log("");
  console.log(`[env-private] concluido. novos arquivos criados: ${createdCount}`);
  console.log("[env-private] prioridade de leitura: shell > .private/env/.env.local > .private/env/.env > .env.local > .env");
}

main();
