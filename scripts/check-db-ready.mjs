import pg from "pg";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_SSL = String(process.env.DB_SSL || "true").toLowerCase() !== "false";
const DB_CHECK_RETRIES = Math.max(1, Number(process.env.DB_CHECK_RETRIES || 4));
const DB_CHECK_RETRY_DELAY_MS = Math.max(250, Number(process.env.DB_CHECK_RETRY_DELAY_MS || 1200));

if (!DATABASE_URL) {
  console.error("[db:check] DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: USE_SSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 8000,
});

const REQUIRED_TABLES = [
  "users",
  "profiles",
  "user_roles",
  "system_settings",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error) {
  if (!error || typeof error !== "object") return "";
  const code = error.code;
  return typeof code === "string" ? code : "";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientConnectionError(error) {
  const code = getErrorCode(error).toUpperCase();
  const message = getErrorMessage(error).toLowerCase();

  if (code === "53300" || code === "57P03") return true;
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;

  return message.includes("maxclientsinsessionmode")
    || message.includes("too many clients")
    || message.includes("remaining connection slots are reserved")
    || message.includes("connection terminated unexpectedly");
}

try {
  let lastError = null;

  for (let attempt = 1; attempt <= DB_CHECK_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");

      const { rows } = await pool.query(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = ANY($1::text[])`,
        [REQUIRED_TABLES],
      );

      const found = new Set(rows.map((row) => String(row.table_name)));
      const missing = REQUIRED_TABLES.filter((name) => !found.has(name));
      if (missing.length > 0) {
        throw new Error(`Missing required tables: ${missing.join(", ")}`);
      }

      console.log("[db:check] Database is reachable and schema looks ready.");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < DB_CHECK_RETRIES && isTransientConnectionError(error)) {
        const delayMs = DB_CHECK_RETRY_DELAY_MS * attempt;
        console.warn(
          `[db:check] tentativa ${attempt}/${DB_CHECK_RETRIES} falhou por erro transitório: ${getErrorMessage(error)}. `
          + `Tentando novamente em ${delayMs}ms...`,
        );
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  if (lastError) {
    console.error(`[db:check] ${getErrorMessage(lastError)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`[db:check] ${getErrorMessage(error)}`);
  process.exit(1);
} finally {
  await pool.end();
}
