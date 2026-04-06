import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISPOSABLE_EMAIL_BLOCKING_ENABLED = String(process.env.DISPOSABLE_EMAIL_BLOCKING ?? "true").trim().toLowerCase() !== "false";
const DEFAULT_BLOCKLIST_PATH = path.resolve(__dirname, "data", "disposable_email_blocklist.conf");
const FALLBACK_BLOCKLIST_PATH = path.resolve(__dirname, "..", "src", "data", "disposable_email_blocklist.conf");

let cachedBlocklist: Set<string> | null = null;

function splitDomainList(rawValue: string) {
  return rawValue
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function resolveBlocklistPath() {
  const customPath = String(process.env.DISPOSABLE_EMAIL_BLOCKLIST_PATH || "").trim();
  if (customPath) return path.resolve(customPath);
  return DEFAULT_BLOCKLIST_PATH;
}

function readBlocklistFile() {
  const locations = [resolveBlocklistPath(), FALLBACK_BLOCKLIST_PATH];
  for (const location of locations) {
    try {
      return readFileSync(location, "utf-8");
    } catch {
      // try next location
    }
  }
  throw new Error("Disposable email blocklist file not found");
}

function loadBlocklist() {
  if (cachedBlocklist) return cachedBlocklist;

  const entries = readBlocklistFile()
    .split(/\r?\n/g)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("//"));

  const allowlist = new Set(splitDomainList(String(process.env.EMAIL_DOMAIN_ALLOWLIST || "")));
  const customBlocklist = splitDomainList(String(process.env.EMAIL_DOMAIN_BLOCKLIST || ""));

  cachedBlocklist = new Set(entries.filter((entry) => !allowlist.has(entry)));
  for (const entry of customBlocklist) {
    if (!allowlist.has(entry)) cachedBlocklist.add(entry);
  }

  return cachedBlocklist;
}

function extractEmailDomain(email: string) {
  const normalized = String(email || "").trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return "";
  return normalized.slice(atIndex + 1);
}

function normalizeDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

export function isDisposableEmailDomain(email: string) {
  if (!DISPOSABLE_EMAIL_BLOCKING_ENABLED) return false;

  const domain = normalizeDomain(extractEmailDomain(email));
  if (!domain || !domain.includes(".")) return false;

  const allowlist = new Set(splitDomainList(String(process.env.EMAIL_DOMAIN_ALLOWLIST || "")));
  if (allowlist.has(domain)) return false;

  const blocklist = loadBlocklist();
  const domainParts = domain.split(".");
  for (let index = 0; index < domainParts.length - 1; index += 1) {
    const candidate = domainParts.slice(index).join(".");
    if (allowlist.has(candidate)) return false;
    if (blocklist.has(candidate)) return true;
  }

  return false;
}

export function getDisposableEmailError(email: string) {
  if (!isDisposableEmailDomain(email)) return "";
  return "Use um e-mail permanente. E-mails temporários ou descartáveis não são aceitos.";
}
