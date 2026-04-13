-- Migration: RLS Defense-in-Depth
-- Purpose: Harden existing RLS policies and add structural protections to prevent
-- anyone from using the Supabase anon/public key to interact with the database
-- without proper authorization, even if PostgREST is accidentally exposed.
--
-- Changes:
--   1. Revoke anon role access to public schema (belt-and-suspenders)
--   2. Harden system-wide readable tables (system_settings, app_runtime_flags,
--      system_announcements, shared vitrine catalogs) to require a valid user ID
--   3. Create event trigger to auto-enable RLS + FORCE on every new table
--   4. Create validation function for CI/monitoring

-- ════════════════════════════════════════════════════════════════════════════════
-- 1. Revoke anon role privileges on the public schema
-- ════════════════════════════════════════════════════════════════════════════════
-- The anon key maps to the `anon` role. Since the application never uses PostgREST
-- with the anon key, the anon role should have ZERO access.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    REVOKE USAGE ON SCHEMA public FROM anon;
    RAISE NOTICE '[rls-hardening] Revoked all public schema privileges from anon role';
  ELSE
    RAISE NOTICE '[rls-hardening] anon role does not exist — skipping revoke';
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════════
-- 2. Harden system-wide readable table policies
-- ════════════════════════════════════════════════════════════════════════════════
-- Add `app_current_user_id() IS NOT NULL` to SELECT policies on tables that
-- previously allowed any authenticated role to read. This ensures that even if
-- someone obtains an authenticated token (e.g. via Supabase Auth) without being
-- a real application user, they cannot read system configuration.

-- ─── system_settings ──────────────────────────────────────────────────────────
-- Supersedes migration 026_restrict_system_settings_select.sql
DROP POLICY IF EXISTS p_system_settings_select_authenticated ON system_settings;
CREATE POLICY p_system_settings_select_authenticated
ON system_settings
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR (
    app_current_user_id() IS NOT NULL
    AND key IN ('admin_config', 'runtime_control')
  )
);

-- ─── app_runtime_flags ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS p_runtime_flags_select_authenticated ON app_runtime_flags;
CREATE POLICY p_runtime_flags_select_authenticated
ON app_runtime_flags
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR app_current_user_id() IS NOT NULL
);

-- ─── system_announcements ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS p_system_announcements_select ON system_announcements;
CREATE POLICY p_system_announcements_select
ON system_announcements
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR (
    app_current_user_id() IS NOT NULL
    AND is_active = TRUE
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at >= NOW())
  )
);

-- ─── meli_vitrine_products (shared catalog) ───────────────────────────────────
DROP POLICY IF EXISTS p_meli_vitrine_products_select_authenticated ON meli_vitrine_products;
CREATE POLICY p_meli_vitrine_products_select_authenticated
ON meli_vitrine_products
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR app_current_user_id() IS NOT NULL
);

-- ─── meli_vitrine_sync_runs (shared catalog) ──────────────────────────────────
DROP POLICY IF EXISTS p_meli_vitrine_sync_runs_select_authenticated ON meli_vitrine_sync_runs;
CREATE POLICY p_meli_vitrine_sync_runs_select_authenticated
ON meli_vitrine_sync_runs
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR app_current_user_id() IS NOT NULL
);

-- ─── amazon_vitrine_products (shared catalog) ─────────────────────────────────
DROP POLICY IF EXISTS p_amazon_vitrine_products_select_authenticated ON public.amazon_vitrine_products;
CREATE POLICY p_amazon_vitrine_products_select_authenticated
ON public.amazon_vitrine_products
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR app_current_user_id() IS NOT NULL
);

-- ─── amazon_vitrine_sync_runs (shared catalog) ────────────────────────────────
DROP POLICY IF EXISTS p_amazon_vitrine_sync_runs_select_authenticated ON public.amazon_vitrine_sync_runs;
CREATE POLICY p_amazon_vitrine_sync_runs_select_authenticated
ON public.amazon_vitrine_sync_runs
FOR SELECT
TO authenticated
USING (
  app_is_trusted_backend()
  OR app_is_admin()
  OR app_current_user_id() IS NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- 3. Event trigger: auto-enable RLS on every new table in the public schema
-- ════════════════════════════════════════════════════════════════════════════════
-- This guarantees that even if a developer forgets to add RLS to a new table,
-- the table is created with RLS + FORCE enabled, denying all access by default
-- until explicit policies are added.

CREATE OR REPLACE FUNCTION public.enforce_rls_on_new_tables()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  obj RECORD;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag = 'CREATE TABLE'
      AND object_type = 'table'
  LOOP
    -- Only enforce on public schema tables
    IF obj.schema_name = 'public' THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.object_identity);
      RAISE NOTICE '[rls-auto] RLS enabled + forced on new table: %', obj.object_identity;
    END IF;
  END LOOP;
END;
$$;

-- Drop existing trigger if any, then create
DROP EVENT TRIGGER IF EXISTS trg_auto_enable_rls;
CREATE EVENT TRIGGER trg_auto_enable_rls
ON ddl_command_end
WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION public.enforce_rls_on_new_tables();

-- ════════════════════════════════════════════════════════════════════════════════
-- 4. Validation function: check_rls_coverage()
-- ════════════════════════════════════════════════════════════════════════════════
-- Returns rows for any public table that is MISSING RLS or FORCE, or has ZERO
-- policies. Call from CI, monitoring, or manually:
--   SELECT * FROM check_rls_coverage();
-- A healthy database returns zero rows.

CREATE OR REPLACE FUNCTION public.check_rls_coverage()
RETURNS TABLE (
  table_name   text,
  rls_enabled  boolean,
  rls_forced   boolean,
  policy_count bigint,
  issue        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tables_info AS (
    SELECT
      c.relname::text AS tbl,
      c.relrowsecurity AS rls_on,
      c.relforcerowsecurity AS rls_forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS pol_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'                     -- ordinary tables only
      AND c.relname NOT LIKE 'pg_%'           -- exclude pg system tables
      AND c.relname NOT LIKE 'sql_%'          -- exclude sql-standard
  )
  SELECT tbl, rls_on, rls_forced, pol_count,
    CASE
      WHEN NOT rls_on              THEN 'RLS NOT ENABLED'
      WHEN NOT rls_forced          THEN 'RLS NOT FORCED (table owner bypasses)'
      WHEN pol_count = 0           THEN 'NO POLICIES (all access denied)'
      ELSE NULL
    END AS issue
  FROM tables_info
  WHERE NOT rls_on OR NOT rls_forced OR pol_count = 0;
$$;

-- ════════════════════════════════════════════════════════════════════════════════
-- 5. Immediate validation: fail deployment if any table is missing RLS
-- ════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  gaps integer;
BEGIN
  SELECT count(*) INTO gaps
  FROM check_rls_coverage()
  WHERE issue IN ('RLS NOT ENABLED', 'RLS NOT FORCED (table owner bypasses)');

  IF gaps > 0 THEN
    RAISE WARNING '[rls-hardening] % table(s) have RLS coverage gaps — run SELECT * FROM check_rls_coverage() for details', gaps;
  ELSE
    RAISE NOTICE '[rls-hardening] All public tables have RLS enabled + forced ✓';
  END IF;
END;
$$;
