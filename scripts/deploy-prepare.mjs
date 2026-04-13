#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const cwd = process.cwd();

const steps = [
  { label: "private env bootstrap", script: "scripts/setup-private-env.mjs" },
  { label: "deploy docs generation", script: "scripts/generate-deploy-doc.mjs" },
  { label: "commit safety check", script: "scripts/check-commit-safety.mjs" },
  { label: "deploy preflight", script: "scripts/preflight-coolify.mjs" },
];

for (const step of steps) {
  console.log(`[deploy-prepare] ${step.label}...`);
  execFileSync(process.execPath, [path.join(cwd, step.script)], { stdio: "inherit" });
}

console.log("[deploy-prepare] ok: ambiente preparado para commit/deploy.");
