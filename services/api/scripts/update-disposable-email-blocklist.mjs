import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const target = path.resolve(__dirname, "..", "src", "data", "disposable_email_blocklist.conf");
const sourceUrl = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";

const response = await fetch(sourceUrl, {
  headers: {
    "user-agent": "autolinks-security-updater/1.0",
    "accept": "text/plain",
  },
});

if (!response.ok) {
  throw new Error(`Failed to download disposable email blocklist: ${response.status} ${response.statusText}`);
}

const text = await response.text();
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, text, "utf-8");
console.log(`Updated disposable email blocklist from ${sourceUrl}`);
