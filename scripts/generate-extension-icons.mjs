import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const rootDir = process.cwd();
const iconDir = path.join(rootDir, "public", "downloads", "autolinks-mercado-livre", "icons");
const sourcePngPath = path.join(iconDir, "icon-source.png");
const sourceSvgPath = path.join(iconDir, "icon-source.svg");

const outputTargets = [16, 32, 48, 128];

let sourcePath = sourcePngPath;
try {
  await access(sourcePngPath);
} catch {
  sourcePath = sourceSvgPath;
}

await Promise.all(
  outputTargets.map(async (size) => {
    const outPath = path.join(iconDir, `icon-${size}.png`);
    await sharp(sourcePath)
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(outPath);
  }),
);

await Promise.all(
  outputTargets.map(async (size) => {
    const outPath = path.join(iconDir, `icon-mono-${size}.png`);
    await sharp(sourcePath)
      .resize(size, size)
      .grayscale()
      .png({ compressionLevel: 9, palette: true })
      .toFile(outPath);
  }),
);

const manifestHintPath = path.join(iconDir, "README-icons.txt");
await writeFile(
  manifestHintPath,
  [
    "AutoLinks - Sistema de icones da extensao",
    "",
    "Fonte oficial:",
    "- icon-source.png (preferencial)",
    "- icon-source.svg (fallback legado)",
    "",
    "Arquivos gerados para o manifest:",
    "- icon-16.png",
    "- icon-32.png",
    "- icon-48.png",
    "- icon-128.png",
    "",
    "Variantes monocromaticas:",
    "- icon-mono-16.png",
    "- icon-mono-32.png",
    "- icon-mono-48.png",
    "- icon-mono-128.png",
    "",
    "Regenerar:",
    "- node scripts/generate-extension-icons.mjs",
  ].join("\n"),
  "utf8",
);

console.log("Icones da extensao gerados com sucesso.");
