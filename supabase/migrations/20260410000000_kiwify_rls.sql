-- Migration: Enable Row-Level Security on Kiwify integration tables
-- Security: H-2 — Kiwify tables were created without RLS, allowing any authenticated
-- PostgREST caller to read OAuth credentials (kiwify_config), customer PII
-- (kiwify_transactions) and full payment history (kiwify_webhooks_log).
-- This migration adds ENABLE ROW LEVEL SECURITY + policies for all 4 tables.

-- ── kiwify_config ───────────────────────────────────────────────────────────────
-- Stores client_secret, webhook_secret, oauth_token_cache — admin-only
ALTER TABLE kiwify_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_config FORCE ROW LEVEL SECURITY;

CREATE POLICY kiwify_config_admin_only ON kiwify_config
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- Backend service role bypasses RLS automatically via app_is_trusted_backend()
-- which is incorporated into app_is_admin(). Explicit grant not needed.

-- ── kiwify_transactions ──────────────────────────────────────────────────────────
-- Stores per-user purchase records + customer PII (email, name)
ALTER TABLE kiwify_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_transactions FORCE ROW LEVEL SECURITY;

-- Users may only read their own transactions; admins see all
CREATE POLICY kiwify_tx_select ON kiwify_transactions
  FOR SELECT
  TO authenticated
  USING (user_id = app_current_user_id() OR app_is_admin());

-- Only backend service role may insert/update/delete (webhook handler)
CREATE POLICY kiwify_tx_backend_write ON kiwify_transactions
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- ── kiwify_plan_mappings ─────────────────────────────────────────────────────────
-- Maps Kiwify products to internal plans — pricing config, admin-only
ALTER TABLE kiwify_plan_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_plan_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY kiwify_plan_mappings_admin_only ON kiwify_plan_mappings
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- ── kiwify_webhooks_log ──────────────────────────────────────────────────────────
-- Full audit trail of all incoming webhook events — admin-only
ALTER TABLE kiwify_webhooks_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_webhooks_log FORCE ROW LEVEL SECURITY;

CREATE POLICY kiwify_webhooks_log_admin_only ON kiwify_webhooks_log
  FOR ALL
  TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());
