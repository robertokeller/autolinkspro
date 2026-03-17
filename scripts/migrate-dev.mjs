/**
 * migrate-dev.mjs — Apply SQL migrations from database/migrations to local dev Postgres.
 *
 * Usage:
 *   node scripts/migrate-dev.mjs
 *
 * Connection env vars (defaults match docker-compose.dev.yml):
 *   POSTGRES_HOST     default: localhost
 *   POSTGRES_PORT     default: 5432
 *   POSTGRES_DB       default: autolinks
 *   POSTGRES_USER     default: autolinks
 *   POSTGRES_PASSWORD default: autolinks
 */

import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const { Pool } = pg;

const MIGRATIONS_DIR = path.resolve("database", "migrations");
const MIGRATIONS_TABLE = "public.schema_migrations";

const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB ?? "autolinks",
  user: process.env.POSTGRES_USER ?? "autolinks",
  password: process.env.POSTGRES_PASSWORD ?? "autolinks",
  connectionTimeoutMillis: 8000,
});

async function ensureMigrationsTable(client) {
  const columnsRes = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'schema_migrations'
    `
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
    `
  );
  const cols = new Set(res.rows.map((r) => String(r.column_name)));
  if (cols.has("version")) return "version";
  if (cols.has("name")) return "name";
  throw new Error(
    "schema_migrations exists but has neither 'version' nor 'name' column; cannot record applied migrations"
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
      [version]
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
  console.error("[migrate] ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
