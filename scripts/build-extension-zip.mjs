#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import archiver from "archiver";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const extensionDirName = "autolinks-mercado-livre";

// Source directory with extension files
const sourceDir = resolve(rootDir, "public", "downloads", extensionDirName);
const manifestPath = resolve(sourceDir, "manifest.json");

async function readExtensionVersion() {
  try {
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw);
    const version = String(manifest?.version || "").trim();
    if (!version) throw new Error("Campo version ausente no manifest.");
    return version;
  } catch (error) {
    console.error("❌ Erro ao ler a versão da extensão:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const extensionVersion = await readExtensionVersion();

// Output zip files
const outputZip = resolve(rootDir, "public", "downloads", `${extensionDirName}.zip`);
const outputVersionedZip = resolve(rootDir, "public", "downloads", `${extensionDirName}-v${extensionVersion}.zip`);

// Create the zip file
const output = createWriteStream(outputZip);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", async () => {
  try {
    await copyFile(outputZip, outputVersionedZip);
    console.log("✅ Extensão empacotada com sucesso!");
    console.log(`📦 Arquivo: ${outputZip}`);
    console.log(`📦 Arquivo versionado: ${outputVersionedZip}`);
    console.log(`🏷️ Versão: ${extensionVersion}`);
    console.log(`📊 Tamanho: ${(archive.pointer() / 1024).toFixed(2)} KB`);
  } catch (err) {
    console.error("❌ Erro ao gerar zip versionado:", err);
    process.exit(1);
  }
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
