-- Migration: Security & Performance — Compound indexes missing from earlier migrations.
-- All statements are idempotent (IF NOT EXISTS). Safe to run multiple times.
-- Date: 2026-04-16

-- ── kiwify_webhooks_log ───────────────────────────────────────────────────────
-- The idempotency query hits payload_hash + kiwify_order_id + event_type together.
-- Two separate single-column indexes (kiwify_wh_log_hash_idx, kiwify_wh_log_order_idx)
-- exist but Postgres cannot combine them as efficiently as one compound index for this
-- three-column predicate.  This index also supports the new 48-hour window filter.
CREATE INDEX IF NOT EXISTS idx_kiwify_wh_log_idempotency
  ON kiwify_webhooks_log (payload_hash, kiwify_order_id, event_type, created_at DESC);

-- Duplicate-activation guard: fast lookup of order_id + status = 'activated'
CREATE INDEX IF NOT EXISTS idx_kiwify_tx_order_status
  ON kiwify_transactions (kiwify_order_id, status);

-- ── profiles ─────────────────────────────────────────────────────────────────
-- Partial index for the plan-expiry check that runs on every authenticated RPC call.
-- Covers only rows where a non-null expiry exists (small subset of the table).
CREATE INDEX IF NOT EXISTS idx_profiles_user_plan_expiry
  ON profiles (user_id, plan_expires_at)
  WHERE plan_expires_at IS NOT NULL;

-- ── whatsapp_groups / telegram_groups ────────────────────────────────────────
-- Group-sync and session-scoped lookups always filter on (user_id, session_id).
-- Single-column indexes on user_id exist but not the compound version.
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_user_session
  ON whatsapp_groups (user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_session
  ON telegram_groups (user_id, session_id);

-- ── admin_audit_logs ──────────────────────────────────────────────────────────
-- Admin user list includes a JOIN on target_user_id; add an index for that column.
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user
  ON admin_audit_logs (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;
