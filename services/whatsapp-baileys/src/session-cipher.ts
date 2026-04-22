/**
 * AES-256-GCM encryption for WhatsApp session files stored on disk.
 *
 * Encrypts every session file written by Baileys' useMultiFileAuthState
 * so that raw credentials (noise keys, signal keys, etc.) are never stored
 * in plaintext on the volume.
 *
 * Key management:
 *   - Primary:  SESSION_ENCRYPTION_KEY  env var (64 hex chars = 32 bytes)
 *   - Salt:     SESSION_CIPHER_SALT     env var (64 hex chars = 32 bytes, required in prod)
 *   - Context:  "autolinks-session-encryption"
 *
 * Encrypted files start with the marker "enc:v1:" — any file that does NOT
 * start with this marker is treated as plaintext-legacy and will be rejected
 * (returns null → Baileys treats session as missing → re-auth flow starts).
 *
 * Migration:
 *   Existing plaintext session files become unreadable after this is deployed.
 *   Users will need to reconnect their WhatsApp accounts (scan QR / enter
 *   pairing code again). Plan a maintenance window before deploying.
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "enc:v1:";
const SALT_FILE_PATH = join(process.cwd(), ".private", "secrets", ".session-cipher-salt");

// ── Key loading ──────────────────────────────────────────────────────────────

const RAW_KEY = String(process.env.SESSION_ENCRYPTION_KEY || "").trim();

if (!RAW_KEY) {
  throw new Error(
    "[session-cipher] SESSION_ENCRYPTION_KEY é obrigatório. " +
    "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"  " +
    "e defina como variável de ambiente."
  );
}

if (!/^[0-9a-f]{64}$/i.test(RAW_KEY)) {
  throw new Error(
    "[session-cipher] SESSION_ENCRYPTION_KEY deve ter exatamente 64 caracteres hexadecimais (32 bytes)."
  );
}

function getInstallationSalt(): Buffer {
  const envSalt = String(process.env.SESSION_CIPHER_SALT || "").trim();
  if (envSalt) {
    if (!/^[0-9a-f]{64}$/i.test(envSalt)) {
      throw new Error(
        "[session-cipher] SESSION_CIPHER_SALT deve ter 64 caracteres hexadecimais (32 bytes)."
      );
    }
    return Buffer.from(envSalt, "hex");
  }

  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProduction) {
    throw new Error(
      "[session-cipher] SESSION_CIPHER_SALT é obrigatório em produção. " +
      "Sem ele, uma nova instância do container geraria um salt diferente e todas as sessões " +
      "seriam irrecuperáveis após redeploy. Gere e persista como variável de ambiente."
    );
  }

  // Fallback de desenvolvimento: salt persistido em arquivo local
  const saltDir = dirname(SALT_FILE_PATH);
  if (!existsSync(saltDir)) mkdirSync(saltDir, { recursive: true, mode: 0o700 });

  if (!existsSync(SALT_FILE_PATH)) {
    try {
      writeFileSync(SALT_FILE_PATH, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return Buffer.from(readFileSync(SALT_FILE_PATH, "utf8").trim(), "hex");
}

const KEY: Buffer = (() => {
  const salt = getInstallationSalt();
  return Buffer.from(hkdfSync("sha256", RAW_KEY, salt, "autolinks-session-encryption", 32));
})();

// ── Encrypt / Decrypt ────────────────────────────────────────────────────────

export function encryptSessionData(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a session file value.
 * Returns null if the file is plaintext (not encrypted) — caller should
 * treat this as a missing/corrupted session and trigger re-auth.
 * Throws on GCM authentication failure (tampered data).
 */
export function decryptSessionData(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) {
    // Plaintext legacy file — reject instead of silently reading plaintext.
    // This ensures we never operate on an unencrypted session after encryption is enabled.
    return null;
  }

  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("[session-cipher] Formato de arquivo de sessão inválido (corrompido?).");
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

// ── Encrypted file I/O helpers ───────────────────────────────────────────────

/**
 * Read an encrypted session file and return parsed JSON.
 * Returns null if the file does not exist, is not encrypted (plaintext legacy),
 * or fails GCM verification — all of these signal "session not found / expired".
 */
export async function readEncryptedJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const plaintext = decryptSessionData(raw);
    if (plaintext === null) {
      // Plaintext file found — treat as unreadable after encryption is enabled
      console.warn(
        `[session-cipher] Arquivo de sessão em plaintext detectado: ${filePath}. ` +
        "Tratando como sessão expirada — usuário precisará reconectar."
      );
      return null;
    }
    return JSON.parse(plaintext) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // arquivo não existe — normal
    // Qualquer outro erro (GCM failure, JSON parse) → session comprometida
    console.error(`[session-cipher] Falha ao ler arquivo de sessão ${filePath}:`, err);
    return null;
  }
}

/**
 * Serialize value to JSON, encrypt, and write to file atomically.
 */
export async function writeEncryptedJson(filePath: string, value: unknown): Promise<void> {
  const plaintext = JSON.stringify(value);
  const ciphertext = encryptSessionData(plaintext);
  // Atomic write: write to temp file then rename to prevent partial writes
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, ciphertext, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}
