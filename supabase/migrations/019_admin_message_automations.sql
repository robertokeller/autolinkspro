-- AutoLinks — Migration 019: Admin message automation rules
-- Stores triggered/recurring automation rules for admin messaging campaigns.

CREATE TABLE IF NOT EXISTS admin_message_automations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  trigger_type    TEXT NOT NULL
                  CHECK (trigger_type IN (
                    'plan_expiring',    -- N days before plan expires
                    'plan_expired',     -- N days after plan expired
                    'signup_welcome',   -- N days after signup
                    'remarketing',      -- N days since last activity / since signup
                    'cron'              -- Scheduled recurring (daily/weekly)
                  )),
  trigger_config  JSONB NOT NULL DEFAULT '{}',
  -- plan_expiring: { "days_before": 3 }
  -- plan_expired:  { "days_after": 1 }
  -- signup_welcome:{ "days_after": 0 }
  -- remarketing:   { "days_since_signup": 30 }
  -- cron:          { "cron_expr": "0 9 * * 1" } (not exec'd yet, reserved)
  message_template TEXT NOT NULL,
  filter_plan     TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  run_count       INT NOT NULL DEFAULT 0,
  last_run_sent   INT NOT NULL DEFAULT 0,
  last_run_failed INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_msg_automations_admin
  ON admin_message_automations(admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_msg_automations_active_trigger
  ON admin_message_automations(trigger_type, is_active) WHERE is_active = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_message_automations_updated_at') THEN
    CREATE TRIGGER admin_message_automations_updated_at
      BEFORE UPDATE ON admin_message_automations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
