/** AES-256-GCM encryption for API credentials stored in the database.
 *
 * Encrypts sensitive fields (e.g. secret_key) before INSERT/UPDATE and
 * decrypts after SELECT.  The encryption key is derived from the
 * CREDENTIAL_ENCRYPTION_KEY env var using HKDF-SHA256 with a per-installation
 * salt (stored in `.private/secrets/.credential-cipher-salt`, 32 bytes hex).
 *
 * Encrypted values are stored as: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * so they can be distinguished from legacy plaintext values during migration.
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "enc:v1:";
const SALT_FILE_PATH = join(process.cwd(), ".private", "secrets", ".credential-cipher-salt");
const LEGACY_SALT_FILE_PATH = join(process.cwd(), ".credential-cipher-salt");
let warnedLegacySaltPath = false;

const RAW_KEY = String(process.env.CREDENTIAL_ENCRYPTION_KEY || "").trim();

// SECURITY: Always require encryption key, regardless of environment.
// Using same database for dev and prod means credentials are real even in dev.
if (!RAW_KEY) {
  throw new Error(
    "CREDENTIAL_ENCRYPTION_KEY is required. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

// Validate key format (must be 64 hex chars for 32-byte key)
if (!/^[0-9a-f]{64}$/i.test(RAW_KEY)) {
  throw new Error(
    "CREDENTIAL_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes). Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

/** Get or create a per-installation 32-byte hex salt.
 * Priority: CREDENTIAL_CIPHER_SALT env var → file-based fallback (dev only).
 * In production the env var MUST be set so the salt survives container replacements.
 */
function getInstallationSalt(): Buffer {
  const envSalt = String(process.env.CREDENTIAL_CIPHER_SALT || "").trim();
  if (envSalt) {
    if (!/^[0-9a-f]{64}$/i.test(envSalt)) {
      throw new Error(
        "CREDENTIAL_CIPHER_SALT must be 64 hexadecimal characters (32 bytes). " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    return Buffer.from(envSalt, "hex");
  }

  // SECURITY: In production, CREDENTIAL_CIPHER_SALT MUST be set as an env var.
  // Container filesystems are ephemeral — a new salt would make all previously
  // encrypted credentials irrecoverable. Fail closed in production.
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProduction) {
    throw new Error(
      "CREDENTIAL_CIPHER_SALT is required in production. Generate with: " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "and set it as an environment variable. This value must persist across deploys " +
      "to decrypt existing credentials."
    );
  }

  // File-based fallback — only acceptable for local development where BOTH
  // the DB and the API process share the same persistent filesystem.
  const saltDir = join(process.cwd(), ".private", "secrets");
  if (!existsSync(saltDir)) {
    mkdirSync(saltDir, { recursive: true, mode: 0o700 });
  }

  const saltFile = existsSync(SALT_FILE_PATH)
    ? SALT_FILE_PATH
    : (existsSync(LEGACY_SALT_FILE_PATH) ? LEGACY_SALT_FILE_PATH : SALT_FILE_PATH);

  if (saltFile === LEGACY_SALT_FILE_PATH && !warnedLegacySaltPath) {
    warnedLegacySaltPath = true;
    console.warn(
      "[credential-cipher] Legacy salt file detected at .credential-cipher-salt. " +
      "Move it to .private/secrets/.credential-cipher-salt or set CREDENTIAL_CIPHER_SALT.",
    );
  }
  if (!existsSync(saltFile)) {
    const s = randomBytes(32);
    // Security: use O_CREAT|O_EXCL equivalent via writeFile with flag wx to avoid
    // TOCTOU race when multiple PM2 workers start simultaneously.
    try {
      writeFileSync(saltFile, s.toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (err: unknown) {
      // Another worker created the file first — read the winner's value.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return Buffer.from(readFileSync(saltFile, "utf8").trim(), "hex");
}

// Derive a 32-byte key using HKDF-SHA256 with per-installation salt.
function deriveKey(rawKey: string): Buffer {
  const salt = getInstallationSalt();
  return Buffer.from(hkdfSync("sha256", rawKey, salt, "autolinks-credential-encryption", 32));
}

const KEY: Buffer | null = RAW_KEY ? deriveKey(RAW_KEY) : null;

/**
 * Encrypt a plaintext value.  Returns the prefixed ciphertext string.
 * If encryption is not configured (dev mode), returns the plaintext unchanged.
 */
export function encryptCredential(plaintext: string): string {
  if (!KEY) return plaintext;
  if (!plaintext) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

// Track already-warned encrypted payloads to avoid spamming logs every scheduler cycle.
const _warnedPayloads = new Set<string>();

/**
 * Decrypt a value.  Handles both encrypted (prefixed) and legacy plaintext values
 * transparently — this allows gradual migration of existing rows.
 */
export function decryptCredential(stored: string): string {
  if (!stored) return stored;
  // Legacy plaintext: return as-is 
  if (!stored.startsWith(PREFIX)) return stored;
  if (!KEY) {
    console.warn("[credential-cipher] Encrypted value found but CREDENTIAL_ENCRYPTION_KEY not set — returning raw value.");
    return stored;
  }

  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    console.warn("[credential-cipher] Malformed encrypted value — returning empty.");
    return "";
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  try {
    const decipher = createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Log once per unique encrypted payload to avoid flooding logs on repeated scheduler cycles.
    const fingerprint = ivHex.slice(0, 8);
    if (!_warnedPayloads.has(fingerprint)) {
      _warnedPayloads.add(fingerprint);
      console.warn(`[credential-cipher] Failed to decrypt credential payload (iv=${fingerprint}…): ${reason}`);
      if (_warnedPayloads.size === 1) {
        console.warn(
          "[credential-cipher] This usually means CREDENTIAL_ENCRYPTION_KEY or CREDENTIAL_CIPHER_SALT changed. " +
          "Re-encrypt affected credentials or restore the original key/salt.",
        );
      }
    }
    return "";
  }
}
