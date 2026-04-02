-- AutoLinks — Migration 018: Admin WhatsApp broadcasts
-- Tracks broadcast messages sent by admin to users via WhatsApp.

CREATE TABLE IF NOT EXISTS admin_wa_broadcasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       TEXT NOT NULL DEFAULT '',
  filter_plan   TEXT[] NOT NULL DEFAULT '{}',
  filter_status TEXT NOT NULL DEFAULT 'all',
  filter_user_ids UUID[] NOT NULL DEFAULT '{}',
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count    INT NOT NULL DEFAULT 0,
  failed_count  INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','sent','partial','failed','cancelled','scheduled')),
  scheduled_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_details JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_wa_broadcasts_admin
  ON admin_wa_broadcasts(admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_wa_broadcasts_status
  ON admin_wa_broadcasts(status) WHERE status IN ('pending', 'scheduled');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'admin_wa_broadcasts_updated_at'
  ) THEN
    CREATE TRIGGER admin_wa_broadcasts_updated_at
      BEFORE UPDATE ON admin_wa_broadcasts
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
