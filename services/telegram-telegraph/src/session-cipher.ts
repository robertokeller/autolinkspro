/**
 * AES-256-GCM encryption for Telegram session files stored on disk.
 * Encrypts metadata.json (which contains the session string and API credentials)
 * so that active Telegram sessions are never stored in plaintext on the volume.
 *
 * Key management:
 *   - Primary:  SESSION_ENCRYPTION_KEY  env var (64 hex chars = 32 bytes)
 *   - Salt:     SESSION_CIPHER_SALT     env var (64 hex chars, required in prod)
 *   - Context:  "autolinks-session-encryption"
 *
 * Migration:
 *   Existing plaintext metadata.json files will be rejected after this is deployed.
 *   Users will need to reconnect their Telegram accounts (enter phone + SMS code again).
 *   Plan a maintenance window before deploying.
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "enc:v1:";
const SALT_FILE_PATH = join(process.cwd(), ".private", "secrets", ".session-cipher-salt");

const RAW_KEY = String(process.env.SESSION_ENCRYPTION_KEY || "").trim();

if (!RAW_KEY) {
  throw new Error(
    "[session-cipher] SESSION_ENCRYPTION_KEY é obrigatório. " +
    "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

if (!/^[0-9a-f]{64}$/i.test(RAW_KEY)) {
  throw new Error(
    "[session-cipher] SESSION_ENCRYPTION_KEY deve ter 64 caracteres hexadecimais (32 bytes)."
  );
}

function getInstallationSalt(): Buffer {
  const envSalt = String(process.env.SESSION_CIPHER_SALT || "").trim();
  if (envSalt) {
    if (!/^[0-9a-f]{64}$/i.test(envSalt)) {
      throw new Error("[session-cipher] SESSION_CIPHER_SALT deve ter 64 caracteres hexadecimais.");
    }
    return Buffer.from(envSalt, "hex");
  }

  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProduction) {
    throw new Error(
      "[session-cipher] SESSION_CIPHER_SALT é obrigatório em produção. " +
      "Sem ele, um redeploy geraria salt diferente e todas as sessões seriam irrecuperáveis."
    );
  }

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

export function encryptSessionData(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt session data. Returns null for plaintext (unencrypted) files —
 * caller should treat this as session-not-found → trigger re-auth.
 */
export function decryptSessionData(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) {
    return null; // plaintext legacy — reject
  }

  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("[session-cipher] Formato de arquivo de sessão inválido.");
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

export async function readEncryptedJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const plaintext = decryptSessionData(raw);
    if (plaintext === null) {
      console.warn(
        `[session-cipher] Arquivo de sessão em plaintext: ${filePath}. ` +
        "Tratando como sessão expirada — usuário precisará reconectar."
      );
      return null;
    }
    return JSON.parse(plaintext) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(`[session-cipher] Falha ao ler ${filePath}:`, err);
    return null;
  }
}

export async function writeEncryptedJson(filePath: string, value: unknown): Promise<void> {
  const plaintext = JSON.stringify(value, null, 2);
  const ciphertext = encryptSessionData(plaintext);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, ciphertext, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}
