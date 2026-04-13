import pg from "pg";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_SSL = String(process.env.DB_SSL || "true").toLowerCase() !== "false";
const DRY_RUN = String(process.env.BACKFILL_TRIAL_DRY_RUN || "false").toLowerCase() === "true";

if (!DATABASE_URL) {
  console.error("[backfill-trial] DATABASE_URL ausente.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: USE_SSL ? { rejectUnauthorized: false } : false,
});

const TARGET_SQL = `
  SELECT p.user_id, p.created_at
  FROM profiles p
  WHERE p.plan_id = 'plan-starter'
    AND p.plan_expires_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM user_roles r
      WHERE r.user_id = p.user_id
        AND r.role = 'admin'
    )
`;

const UPDATE_SQL = `
  WITH targets AS (
    SELECT p.user_id,
           COALESCE(p.created_at, NOW()) + INTERVAL '7 days' AS new_expiry
    FROM profiles p
    WHERE p.plan_id = 'plan-starter'
      AND p.plan_expires_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_roles r
        WHERE r.user_id = p.user_id
          AND r.role = 'admin'
      )
  )
  UPDATE profiles p
     SET plan_expires_at = t.new_expiry,
         updated_at = NOW()
    FROM targets t
   WHERE p.user_id = t.user_id
   RETURNING p.user_id, p.plan_expires_at
`;

async function run() {
  const before = await pool.query(TARGET_SQL);
  console.log(`[backfill-trial] candidatos encontrados: ${before.rowCount}`);

  if (before.rowCount === 0) {
    console.log("[backfill-trial] nada para atualizar.");
    return;
  }

  if (DRY_RUN) {
    console.log("[backfill-trial] modo dry-run ativo. Nenhuma alteração aplicada.");
    return;
  }

  const updated = await pool.query(UPDATE_SQL);
  console.log(`[backfill-trial] linhas atualizadas: ${updated.rowCount}`);
  const preview = updated.rows.slice(0, 10);
  if (preview.length > 0) {
    console.log("[backfill-trial] preview das atualizações:");
    console.log(JSON.stringify(preview, null, 2));
  }
}

run()
  .catch((error) => {
    console.error("[backfill-trial] erro:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
