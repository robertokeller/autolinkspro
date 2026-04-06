import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execSync } from "node:child_process";

const RELEVANT_DIRS = [
  ".planning",
  ".env.coolify.example",
  "docs",
  "scripts",
  "services",
  "src",
  "supabase",
  "public/downloads",
  "README.md",
  "ARCHITECTURE.md",
  "DATABASE.md"
];

const VALID_EXTENSIONS = [".md", ".tsx", ".ts", ".jsx", ".js", ".sql", ".html", ".mjs", ".cjs", ".ps1"];

function getAllFiles(dir, prefix = "") {
  const files = [];
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build", ".next"].includes(entry)) continue;
    
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...getAllFiles(fullPath, prefix));
    } else if (VALID_EXTENSIONS.includes(extname(entry))) {
      files.push(fullPath);
    }
  }
  
  return files;
}

const filesToProcess = [];

for (const dir of RELEVANT_DIRS) {
  const fullPath = join(".", dir);
  try {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      filesToProcess.push(...getAllFiles(fullPath));
    } else if (stat.isFile() && VALID_EXTENSIONS.includes(extname(dir))) {
      filesToProcess.push(fullPath);
    }
  } catch (e) {
    console.log(`Skip: ${fullPath} - not found`);
  }
}

console.log(`Found ${filesToProcess.length} files to process`);
console.log(`Running fix-mojibake.mjs on all files...`);

// Process in batches to avoid command line length limit
const batchSize = 50;
let processed = 0;

for (let i = 0; i < filesToProcess.length; i += batchSize) {
  const batch = filesToProcess.slice(i, i + batchSize);
  console.log(`\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToProcess.length / batchSize)}`);
  
  try {
    execSync(`node scripts/fix-mojibake.mjs ${batch.join(' ')}`, { stdio: 'inherit' });
    processed += batch.length;
  } catch (e) {
    console.error(`Error processing batch: ${e.message}`);
  }
}

console.log(`\n✓ Complete! Processed ${processed} files`);
