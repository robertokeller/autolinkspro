/**
 * AES-256-GCM encryption for API credentials stored in the database.
 *
 * Encrypts sensitive fields (e.g. secret_key) before INSERT/UPDATE and
 * decrypts after SELECT.  The encryption key is derived from the
 * CREDENTIAL_ENCRYPTION_KEY env var using HKDF-SHA256.
 *
 * Encrypted values are stored as: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * so they can be distinguished from legacy plaintext values during migration.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "enc:v1:";

const RAW_KEY = String(process.env.CREDENTIAL_ENCRYPTION_KEY || "").trim();
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

if (IS_PRODUCTION && !RAW_KEY) {
  throw new Error(
    "CREDENTIAL_ENCRYPTION_KEY é obrigatório em produção. Gere uma chave com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

// Derive a 32-byte key using HMAC-SHA256 (deterministic, no salt needed since
// the raw key itself should be high-entropy).
function deriveKey(rawKey: string): Buffer {
  return createHmac("sha256", "autolinks-credential-encryption").update(rawKey).digest();
}

const KEY: Buffer | null = RAW_KEY ? deriveKey(RAW_KEY) : null;

/**
 * Returns true when encryption is configured and available.
 */
export function isEncryptionEnabled(): boolean {
  return KEY !== null;
}

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

  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
