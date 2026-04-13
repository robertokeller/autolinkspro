/**
 * migrate-dev.mjs - Apply SQL migrations from supabase/migrations.
 *
 * Usage:
 *   node scripts/migrate-dev.mjs
 *
 * Required env vars:
 *   DATABASE_URL      Supabase Postgres connection string
 *
 * Optional:
 *   DB_SSL=true|false (default true)
 */

import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const { Pool } = pg;

const MIGRATIONS_DIR = path.resolve("supabase", "migrations");
const MIGRATIONS_TABLE = "public.schema_migrations";

const DATABASE_URL = String(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "").trim();
const USE_SSL = String(process.env.DB_SSL || "true").toLowerCase() !== "false";

if (!DATABASE_URL) {
  console.error("[migrate] DATABASE_URL (or MIGRATION_DATABASE_URL) is required. Load it via .env or .env.local.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: USE_SSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 8000,
});

function shouldSkipDueToSharedSchemaPermissions(error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const schema = typeof error === "object" && error && "schema" in error ? String(error.schema || "") : "";
  const message = error instanceof Error ? error.message : String(error);
  const permissionDenied = code === "42501" || /permission denied/i.test(message);
  const referencesPublic = schema.toLowerCase() === "public" || /schema\s+public/i.test(message);
  return permissionDenied && referencesPublic;
}

async function ensureMigrationsTable(client) {
  const columnsRes = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'schema_migrations'
    `,
  );

  if (columnsRes.rowCount === 0) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
}

async function getMigrationsKeyColumn(client) {
  const res = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'schema_migrations'
        AND column_name IN ('version', 'name')
    `,
  );
  const cols = new Set(res.rows.map((r) => String(r.column_name)));
  if (cols.has("version")) return "version";
  if (cols.has("name")) return "name";
  throw new Error(
    "schema_migrations exists but has neither 'version' nor 'name' column; cannot record applied migrations",
  );
}

async function getAppliedMigrations(client, keyColumn) {
  if (keyColumn !== "version" && keyColumn !== "name") {
    throw new Error("Invalid migrations key column");
  }
  const res = await client.query(`SELECT ${keyColumn} AS key FROM ${MIGRATIONS_TABLE}`);
  return new Set(res.rows.map((r) => String(r.key)));
}

async function applyMigration(client, keyColumn, version, sql) {
  if (keyColumn !== "version" && keyColumn !== "name") {
    throw new Error("Invalid migrations key column");
  }

  await client.query("BEGIN");
  try {
    await client.query(sql);

    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (${keyColumn}) VALUES ($1) ON CONFLICT (${keyColumn}) DO NOTHING`,
      [version],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

const client = await pool.connect();
try {
  await ensureMigrationsTable(client);
  const keyColumn = await getMigrationsKeyColumn(client);
  const applied = await getAppliedMigrations(client, keyColumn);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.log(`[migrate] No .sql files found in ${MIGRATIONS_DIR}`);
    process.exitCode = 0;
  } else {
    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/i, "");

      if (applied.has(version)) {
        skippedCount += 1;
        continue;
      }

      const full = path.join(MIGRATIONS_DIR, file);
      const sql = await readFile(full, "utf8");
      if (!sql || !sql.trim()) {
        console.log(`[migrate] SKIP empty ${file}`);
        skippedCount += 1;
        continue;
      }

      const startedAt = Date.now();
      await applyMigration(client, keyColumn, version, sql);
      const ms = Date.now() - startedAt;
      console.log(`[migrate] OK   ${file}  (${ms}ms)`);
      appliedCount += 1;
    }

    console.log(`[migrate] Done. applied=${appliedCount} skipped=${skippedCount} total=${files.length}`);
  }
} catch (err) {
  if (shouldSkipDueToSharedSchemaPermissions(err)) {
    console.warn(
      "[migrate] WARNING: sem permissao para escrever no schema public. " +
      "Pulando migracoes locais e mantendo o schema remoto compartilhado.",
    );
    process.exitCode = 0;
  } else {
    console.error("[migrate] ERROR:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
} finally {
  client.release();
  await pool.end();
}
