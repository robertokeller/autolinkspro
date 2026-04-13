#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import archiver from "archiver";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");

// Source directory with extension files
const sourceDir = resolve(rootDir, "public", "downloads", "autolinks-mercado-livre");

// Output zip file
const outputZip = resolve(rootDir, "public", "downloads", "autolinks-mercado-livre.zip");

// Create the zip file
const output = createWriteStream(outputZip);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`✅ Extensão empacotada com sucesso!`);
  console.log(`📦 Arquivo: ${outputZip}`);
  console.log(`📊 Tamanho: ${(archive.pointer() / 1024).toFixed(2)} KB`);
});

output.on("error", (err) => {
  console.error("❌ Erro ao criar o zip:", err);
  process.exit(1);
});

archive.on("error", (err) => {
  console.error("❌ Erro no arquivador:", err);
  process.exit(1);
});

archive.pipe(output);

// Add all files from the extension directory
// Excluding the directory itself, only add the contents
archive.directory(sourceDir + "/", "autolinks-mercado-livre/");

archive.finalize();
