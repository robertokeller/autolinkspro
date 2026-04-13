-- Migration 026: Fix RLS policies for amazon_affiliate_tags and add RLS for
-- amazon_vitrine tables (created in 024/025 without the unified policy pattern).
--
-- Root cause:
--   024_create_amazon_affiliate_tags.sql used auth.uid() directly.
--   auth.uid() is Supabase PostgREST-only and returns NULL when the self-hosted
--   API backend connects directly via PostgreSQL pool (autolinks_app / postgres).
--   All other application tables (migration 021) use app_current_user_id() and
--   app_is_admin(), which handle both PostgREST and direct pool contexts.
--
-- Fix:
--   1. Drop old auth.uid() policies from amazon_affiliate_tags.
--   2. Enable FORCE ROW LEVEL SECURITY (consistent with migration 021).
--   3. Re-create policies using the unified app_current_user_id()/app_is_admin() pattern.
--   4. Enable + configure RLS on amazon_vitrine_products and amazon_vitrine_sync_runs
--      (which had no RLS at all) following the same read-all / write-admin pattern
--      already established for meli_vitrine tables.
--   5. Ensure authenticated role has explicit grants (ALTER DEFAULT PRIVILEGES
--      applied at migration 021 covers newly created tables only when the same role
--      runs DDL, so an explicit GRANT here is idempotent and safe).

-- ─── amazon_affiliate_tags ────────────────────────────────────────────────────

-- Drop old policies that used auth.uid()
DROP POLICY IF EXISTS "Users can view their own amazon affiliate tags"   ON public.amazon_affiliate_tags;
DROP POLICY IF EXISTS "Users can insert their own amazon affiliate tags" ON public.amazon_affiliate_tags;
DROP POLICY IF EXISTS "Users can update their own amazon affiliate tags" ON public.amazon_affiliate_tags;
DROP POLICY IF EXISTS "Users can delete their own amazon affiliate tags" ON public.amazon_affiliate_tags;

-- Ensure RLS is enabled and forced (consistent with migration 021)
ALTER TABLE public.amazon_affiliate_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_affiliate_tags FORCE ROW LEVEL SECURITY;

-- Owner-scoped policies: mirrors the generic pattern applied to all user_id tables in 021
DROP POLICY IF EXISTS p_amazon_affiliate_tags_select ON public.amazon_affiliate_tags;
CREATE POLICY p_amazon_affiliate_tags_select
  ON public.amazon_affiliate_tags
  FOR SELECT
  TO authenticated
  USING (user_id = app_current_user_id() OR app_is_admin());

DROP POLICY IF EXISTS p_amazon_affiliate_tags_insert ON public.amazon_affiliate_tags;
CREATE POLICY p_amazon_affiliate_tags_insert
  ON public.amazon_affiliate_tags
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

DROP POLICY IF EXISTS p_amazon_affiliate_tags_update ON public.amazon_affiliate_tags;
CREATE POLICY p_amazon_affiliate_tags_update
  ON public.amazon_affiliate_tags
  FOR UPDATE
  TO authenticated
  USING  (user_id = app_current_user_id() OR app_is_admin())
  WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

DROP POLICY IF EXISTS p_amazon_affiliate_tags_delete ON public.amazon_affiliate_tags;
CREATE POLICY p_amazon_affiliate_tags_delete
  ON public.amazon_affiliate_tags
  FOR DELETE
  TO authenticated
  USING (user_id = app_current_user_id() OR app_is_admin());

-- ─── amazon_vitrine_products ──────────────────────────────────────────────────

ALTER TABLE public.amazon_vitrine_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_vitrine_products FORCE ROW LEVEL SECURITY;

-- Read: any authenticated user can browse the shared product catalog.
DROP POLICY IF EXISTS p_amazon_vitrine_products_select_authenticated ON public.amazon_vitrine_products;
CREATE POLICY p_amazon_vitrine_products_select_authenticated
  ON public.amazon_vitrine_products
  FOR SELECT
  TO authenticated
  USING (TRUE);

-- Writes: admin/service only (backend scheduler fills this table).
DROP POLICY IF EXISTS p_amazon_vitrine_products_write_admin_only ON public.amazon_vitrine_products;
CREATE POLICY p_amazon_vitrine_products_write_admin_only
  ON public.amazon_vitrine_products
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- ─── amazon_vitrine_sync_runs ─────────────────────────────────────────────────

ALTER TABLE public.amazon_vitrine_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_vitrine_sync_runs FORCE ROW LEVEL SECURITY;

-- Read: any authenticated user can view sync history.
DROP POLICY IF EXISTS p_amazon_vitrine_sync_runs_select_authenticated ON public.amazon_vitrine_sync_runs;
CREATE POLICY p_amazon_vitrine_sync_runs_select_authenticated
  ON public.amazon_vitrine_sync_runs
  FOR SELECT
  TO authenticated
  USING (TRUE);

-- Writes: admin/service only.
DROP POLICY IF EXISTS p_amazon_vitrine_sync_runs_write_admin_only ON public.amazon_vitrine_sync_runs;
CREATE POLICY p_amazon_vitrine_sync_runs_write_admin_only
  ON public.amazon_vitrine_sync_runs
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- ─── Grants (idempotent) ──────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.amazon_affiliate_tags    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.amazon_vitrine_products   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.amazon_vitrine_sync_runs  TO authenticated;
