import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const rootDir = process.cwd();
const iconDir = path.join(rootDir, "public", "downloads", "autolinks-mercado-livre", "icons");
const sourceSvgPath = path.join(iconDir, "icon-source.svg");

const outputTargets = [16, 32, 48, 128];

const svgBuffer = await readFile(sourceSvgPath);

await Promise.all(
  outputTargets.map(async (size) => {
    const outPath = path.join(iconDir, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(outPath);
  }),
);

const monochromeSvg = String(svgBuffer)
  .replace("url(#autolinksGradient)", "#161921")
  .replace("url(#autolinksGlow)", "transparent")
  .replace("#FFE7D6", "#EEF1F7");

await Promise.all(
  outputTargets.map(async (size) => {
    const outPath = path.join(iconDir, `icon-mono-${size}.png`);
    await sharp(Buffer.from(monochromeSvg))
      .resize(size, size)
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
    "- icon-source.svg",
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
