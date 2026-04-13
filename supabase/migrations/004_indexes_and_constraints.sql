-- Migration 004: Missing indexes and CHECK constraints
-- Idempotent: all statements use IF NOT EXISTS / NOT VALID / DO NOTHING patterns.

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- routes: route-process-message scans by user_id+status='active' on every message
CREATE INDEX IF NOT EXISTS idx_routes_user_status
  ON routes(user_id, status)
  WHERE status = 'active';

-- routes: general user_id scoped queries
CREATE INDEX IF NOT EXISTS idx_routes_user_id
  ON routes(user_id);

-- meli_sessions: meli-list-sessions and ownership checks
CREATE INDEX IF NOT EXISTS idx_meli_sessions_user_id
  ON meli_sessions(user_id);

-- shopee_automations: shopee-automation-run ownership check
CREATE INDEX IF NOT EXISTS idx_shopee_automations_user_id
  ON shopee_automations(user_id);

-- master_groups: PARENT_SCOPED ownership check (WHERE id=$1 AND user_id=$2)
CREATE INDEX IF NOT EXISTS idx_master_groups_user_id
  ON master_groups(user_id);

-- link_hub_pages: REST generic select by user_id
CREATE INDEX IF NOT EXISTS idx_link_hub_pages_user_id
  ON link_hub_pages(user_id);

-- master_group_links: reverse lookup (which master_group contains this group?)
CREATE INDEX IF NOT EXISTS idx_mgl_group_id
  ON master_group_links(group_id);

-- admin_audit_logs: list_audit JOINs on actor and target
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
  ON admin_audit_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user_id
  ON admin_audit_logs(target_user_id);

-- groups: soft-delete queries (deleted_at IS NULL filter) — partial index for live rows
CREATE INDEX IF NOT EXISTS idx_groups_active
  ON groups(user_id, id)
  WHERE deleted_at IS NULL;

-- scheduled_posts: dispatch-messages claims ownership check
-- (complements existing idx_sp_status_scheduled_at — adds user_id for scoped dispatch)
CREATE INDEX IF NOT EXISTS idx_sp_user_status
  ON scheduled_posts(user_id, status)
  WHERE status = 'pending';

-- ─── CHECK constraints (NOT VALID — validates new rows only, safe on existing data) ──
-- Using DO blocks because PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shopee_automations_status_check') THEN
    ALTER TABLE shopee_automations ADD CONSTRAINT shopee_automations_status_check
      CHECK (status IN ('active', 'inactive', 'paused')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_sessions_status_check') THEN
    ALTER TABLE meli_sessions ADD CONSTRAINT meli_sessions_status_check
      CHECK (status IN ('active', 'expired', 'error', 'untested', 'not_found', 'no_affiliate')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_platform_check') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_platform_check
      CHECK (platform IN ('whatsapp', 'telegram')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_posts_recurrence_check') THEN
    ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_recurrence_check
      CHECK (recurrence IN ('none', 'daily', 'weekly')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_entries_direction_check') THEN
    ALTER TABLE history_entries ADD CONSTRAINT history_entries_direction_check
      CHECK (direction IN ('inbound', 'outbound', 'system')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_entries_processing_status_check') THEN
    ALTER TABLE history_entries ADD CONSTRAINT history_entries_processing_status_check
      CHECK (processing_status IN ('processed', 'sent', 'skipped', 'error', 'blocked')) NOT VALID;
  END IF;
END $$;
