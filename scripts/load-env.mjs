import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvFile(content) {
  const entries = [];
  for (const rawLine of String(content || "").split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return entries;
}

export function loadProjectEnv(cwd = process.cwd()) {
  const lockedKeys = new Set(
    Object.entries(process.env)
      .filter(([, value]) => value != null && value !== "")
      .map(([key]) => key),
  );
  const envFiles = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, ".env.local"),
  ];

  for (const filePath of envFiles) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    for (const [key, value] of parseEnvFile(content)) {
      if (lockedKeys.has(key)) continue;
      process.env[key] = value;
    }
  }
}
