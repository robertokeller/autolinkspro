#!/usr/bin/env node
// scripts/check-rls-coverage.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Validates that ALL public schema tables have RLS enabled + forced + policies.
// Run via: node scripts/check-rls-coverage.mjs
// Requires DATABASE_URL env var.
// Exit code 0 = all good, 1 = gaps found.
// ─────────────────────────────────────────────────────────────────────────────

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is required");
  process.exit(1);
}

const ssl =
  String(process.env.DB_SSL || "true").toLowerCase() !== "false"
    ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "false").toLowerCase() !== "false" }
    : false;

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl, max: 1 });

try {
  // ─── 1. Check RLS coverage on all public tables ────────────────────────────
  const { rows: tables } = await pool.query(`
    SELECT
      c.relname::text          AS table_name,
      c.relrowsecurity         AS rls_enabled,
      c.relforcerowsecurity    AS rls_forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE 'pg_%'
      AND c.relname NOT LIKE 'sql_%'
    ORDER BY c.relname
  `);

  console.log(`\n📋 Found ${tables.length} tables in public schema\n`);

  const issues = [];
  for (const t of tables) {
    const flags = [];
    if (!t.rls_enabled) flags.push("RLS NOT ENABLED");
    if (!t.rls_forced) flags.push("RLS NOT FORCED");
    if (Number(t.policy_count) === 0) flags.push("NO POLICIES");

    const status = flags.length === 0 ? "✅" : "❌";
    const detail = flags.length > 0 ? ` — ${flags.join(", ")}` : "";
    console.log(`  ${status} ${t.table_name} (${t.policy_count} policies)${detail}`);

    if (flags.length > 0) issues.push({ table: t.table_name, flags });
  }

  // ─── 2. Check anon role privileges ─────────────────────────────────────────
  const { rows: anonPrivs } = await pool.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee = 'anon'
      AND table_schema = 'public'
    LIMIT 10
  `);

  console.log("");
  if (anonPrivs.length > 0) {
    console.log(`⚠️  anon role has ${anonPrivs.length}+ privileges on public tables:`);
    for (const p of anonPrivs) {
      console.log(`    ${p.table_name}: ${p.privilege_type}`);
    }
    issues.push({ table: "(anon role)", flags: ["HAS PRIVILEGES ON PUBLIC TABLES"] });
  } else {
    console.log("✅ anon role has no privileges on public schema tables");
  }

  // ─── 3. Check for USING(TRUE) policies (overly permissive) ─────────────────
  const { rows: permissivePolicies } = await pool.query(`
    SELECT
      schemaname,
      tablename,
      policyname,
      cmd,
      qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'SELECT'
      AND qual = 'true'
  `);

  console.log("");
  if (permissivePolicies.length > 0) {
    console.log(`⚠️  ${permissivePolicies.length} SELECT policies use USING(TRUE) (overly permissive):`);
    for (const p of permissivePolicies) {
      console.log(`    ${p.tablename}.${p.policyname}`);
    }
  } else {
    console.log("✅ No SELECT policies use USING(TRUE)");
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  if (issues.length === 0) {
    console.log("🟢 All tables pass RLS coverage check\n");
    process.exit(0);
  } else {
    console.log(`🔴 ${issues.length} issue(s) found:\n`);
    for (const i of issues) {
      console.log(`  - ${i.table}: ${i.flags.join(", ")}`);
    }
    console.log("");
    process.exit(1);
  }
} catch (err) {
  console.error("❌ Error:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
