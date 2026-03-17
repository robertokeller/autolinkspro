-- Migration 005: Schema alignment — self-hosted schema vs Supabase/frontend types
-- Idempotent: all statements use IF NOT EXISTS / DO $$ checks / OR REPLACE patterns.
-- These fixes resolve SCHEMA-1 through SCHEMA-7 divergences found in the consistency audit.

-- ─── SCHEMA-1: routes.filters → routes.rules ─────────────────────────────────
-- The frontend and all backend code reference this column as "rules".
-- init.sql mistakenly created it as "filters".
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'routes' AND column_name = 'filters'
  ) THEN
    ALTER TABLE routes RENAME COLUMN filters TO rules;
  END IF;
END $$;

-- ─── SCHEMA-2: routes.status CHECK — add 'paused' and 'error' ────────────────
-- The frontend sends status = 'paused' when pausing a route (useRotas.ts).
-- The original CHECK only allowed 'active' and 'inactive', causing constraint violations.
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_status_check;
ALTER TABLE routes ADD CONSTRAINT routes_status_check
  CHECK (status IN ('active', 'inactive', 'paused', 'error')) NOT VALID;

-- ─── SCHEMA-3: templates.type → templates.category ───────────────────────────
-- The frontend reads/writes "category" but init.sql created "type".
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'templates' AND column_name = 'type'
  ) THEN
    ALTER TABLE templates RENAME COLUMN type TO category;
  END IF;
END $$;

-- ─── SCHEMA-4: master_groups — add missing columns ───────────────────────────
ALTER TABLE master_groups ADD COLUMN IF NOT EXISTS slug              TEXT;
ALTER TABLE master_groups ADD COLUMN IF NOT EXISTS distribution      TEXT NOT NULL DEFAULT 'sequential';
ALTER TABLE master_groups ADD COLUMN IF NOT EXISTS member_limit      INTEGER NOT NULL DEFAULT 0;

-- ─── SCHEMA-5: master_group_links — add missing columns ──────────────────────
ALTER TABLE master_group_links ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE master_group_links ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill trigger for new updated_at column
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'master_group_links_updated_at') THEN
  CREATE TRIGGER master_group_links_updated_at
    BEFORE UPDATE ON master_group_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── SCHEMA-6: whatsapp_sessions — add is_default ────────────────────────────
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── SCHEMA-7: shopee_automations — add flat operational columns ──────────────
-- init.sql stored everything in config JSONB, but the frontend and all hooks
-- use flat columns matching the Supabase schema (types.ts Row type).
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS interval_minutes    INTEGER NOT NULL DEFAULT 60;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS min_discount         NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS min_commission       NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS min_price            NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS max_price            NUMERIC NOT NULL DEFAULT 999999;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS categories           TEXT[];
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS destination_group_ids TEXT[];
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS master_group_ids     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS template_id          UUID REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS session_id           UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL;
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS active_hours_start   TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS active_hours_end     TEXT NOT NULL DEFAULT '20:00';
ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS is_active            BOOLEAN NOT NULL DEFAULT TRUE;

-- Migrate existing config JSONB data to flat columns (best-effort, non-destructive)
UPDATE shopee_automations
SET
  interval_minutes     = COALESCE((config->>'intervalMinutes')::INTEGER, 60),
  min_discount         = COALESCE((config->>'minDiscount')::NUMERIC, 0),
  min_commission       = COALESCE((config->>'minCommission')::NUMERIC, 0),
  min_price            = COALESCE((config->>'minPrice')::NUMERIC, 0),
  max_price            = COALESCE((config->>'maxPrice')::NUMERIC, 999999),
  active_hours_start   = COALESCE(config->>'activeHoursStart', '08:00'),
  active_hours_end     = COALESCE(config->>'activeHoursEnd', '20:00'),
  is_active            = COALESCE((config->>'isActive')::BOOLEAN, TRUE)
WHERE config IS DISTINCT FROM '{}';

-- ─── SQL-5 prerequisite: scheduled_posts.status — add 'processing' ─────────
-- Required for the atomic dispatch claim (UPDATE … SET status='processing') that
-- prevents double-dispatch when frontend and scheduler call dispatch-messages concurrently.
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')) NOT VALID;

-- Update the partial index from migration 004 to reflect new constraint name (idempotent)
DROP INDEX IF EXISTS idx_sp_user_status;
CREATE INDEX IF NOT EXISTS idx_sp_user_status
  ON scheduled_posts(user_id, status)
  WHERE status = 'pending';

-- ─── Validate non-destructive constraints ────────────────────────────────────
-- These run immediately since the DEFAULT values cover all possible existing rows.
-- ALTER TABLE master_groups VALIDATE CONSTRAINT ... (no constraints added above)
-- VALIDATE the new NOT VALID constraints when ready:
-- ALTER TABLE routes VALIDATE CONSTRAINT routes_status_check;
-- ALTER TABLE scheduled_posts VALIDATE CONSTRAINT scheduled_posts_status_check;
