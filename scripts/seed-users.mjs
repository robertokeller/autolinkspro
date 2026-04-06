/**
 * seed-users.mjs - Upsert operational users in Supabase PostgreSQL.
 *
 * Usage:
 *   node scripts/seed-users.mjs
 *
 * Required env vars:
 *   DATABASE_URL      Supabase Postgres connection string
 *
 * Optional:
 *   DB_SSL=true|false (default true)
 *
 * Users seeded (passwords via env):
 *   admin : SEED_ADMIN_PASSWORD (fallback: SEED_DEFAULT_PASSWORD)
 *   normal: SEED_USER_PASSWORD  (fallback: SEED_DEFAULT_PASSWORD)
 */

import pg from "pg";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_SSL = String(process.env.DB_SSL || "true").toLowerCase() !== "false";

if (!DATABASE_URL) {
  console.error("[seed] DATABASE_URL is required. Load it via .env or .env.local.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: USE_SSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 8000,
});

const GENERATED_SEED_PASSWORD = randomBytes(18).toString("hex");
const SEED_DEFAULT_PASSWORD = String(process.env.SEED_DEFAULT_PASSWORD || GENERATED_SEED_PASSWORD).trim();

if (!String(process.env.SEED_DEFAULT_PASSWORD || "").trim()) {
  console.warn("[seed] SEED_DEFAULT_PASSWORD not provided. Using a generated one for this run.");
}

const USERS = [
  {
    email: String(process.env.SEED_ADMIN_EMAIL || "admin@localhost.local"),
    password: String(process.env.SEED_ADMIN_PASSWORD || SEED_DEFAULT_PASSWORD).trim(),
    name: "Admin",
    role: "admin",
    plan: "admin",
  },
  {
    email: String(process.env.SEED_USER_EMAIL || "user@localhost.local"),
    password: String(process.env.SEED_USER_PASSWORD || SEED_DEFAULT_PASSWORD).trim(),
    name: "User",
    role: "user",
    plan: "plan-starter",
  },
];

async function upsertUser(client, { email, password, name, role, plan }) {
  const hash = await bcrypt.hash(password, 10);
  const metadata = JSON.stringify({
    name,
    account_status: "active",
    status_updated_at: new Date().toISOString(),
  });

  await client.query(
    `INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       metadata      = users.metadata || EXCLUDED.metadata,
       token_invalidated_before = NOW(),
       updated_at    = NOW()`,
    [randomUUID(), email, hash, metadata],
  );

  const row = await client.query("SELECT id FROM users WHERE email = $1", [email]);
  const userId = row.rows[0].id;

  await client.query(
    `INSERT INTO user_roles (id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
    [randomUUID(), userId, role],
  );

  await client.query(
    `INSERT INTO profiles (id, user_id, name, email, plan_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       name       = EXCLUDED.name,
       email      = EXCLUDED.email,
       plan_id    = EXCLUDED.plan_id,
       updated_at = NOW()`,
    [randomUUID(), userId, name, email, plan],
  );

  console.log(`[seed] OK  ${role.padEnd(5)}  ${email}  (userId=${userId})`);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const user of USERS) {
    await upsertUser(client, user);
  }
  await client.query("COMMIT");
  console.log("[seed] All users seeded successfully.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("[seed] ERROR - rolled back:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
