/**
 * seed-users.mjs — Upsert operational users directly into PostgreSQL.
 *
 * Usage:
 *   node scripts/seed-users.mjs
 *
 * Reads connection from env vars (defaults match docker-compose.dev.yml):
 *   POSTGRES_HOST     default: localhost
 *   POSTGRES_PORT     default: 5432
 *   POSTGRES_DB       default: autolinks
 *   POSTGRES_USER     default: autolinks
 *   POSTGRES_PASSWORD default: autolinks
 *
 * Users seeded:
 *   admin : robertokellercontato@gmail.com  / abacate1  (role=admin, plan=admin)
 *   normal: aliancaslovely@gmail.com         / abacate1  (role=user,  plan=plan-starter)
 */

import pg from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.POSTGRES_HOST     ?? "localhost",
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB       ?? "autolinks",
  user:     process.env.POSTGRES_USER     ?? "autolinks",
  password: process.env.POSTGRES_PASSWORD ?? "autolinks",
  connectionTimeoutMillis: 8000,
});

const USERS = [
  {
    email:    "robertokellercontato@gmail.com",
    password: "abacate1",
    name:     "Roberto Keller",
    role:     "admin",
    plan:     "admin",
  },
  {
    email:    "aliancaslovely@gmail.com",
    password: "abacate1",
    name:     "Aliancas Lovely",
    role:     "user",
    plan:     "plan-starter",
  },
];

async function upsertUser(client, { email, password, name, role, plan }) {
  const hash = await bcrypt.hash(password, 10);
  const metadata = JSON.stringify({
    name,
    account_status: "active",
    status_updated_at: new Date().toISOString(),
  });

  // Upsert user
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

  const row = await client.query(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  const userId = row.rows[0].id;

  // Upsert role
  await client.query(
    `INSERT INTO user_roles (id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
    [randomUUID(), userId, role],
  );

  // Upsert profile
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
  console.error("[seed] ERROR — rolled back:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
