-- AutoLinks — Admin message event center deduplication log
-- Tracks per-recipient lifecycle event dispatches to avoid repeated sends
-- during high-frequency scheduler cycles.

CREATE TABLE IF NOT EXISTS admin_message_event_dispatches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id     UUID NOT NULL REFERENCES admin_message_automations(id) ON DELETE CASCADE,
  admin_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key         TEXT NOT NULL,
  schedule_date     DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent', 'failed')),
  error_message     TEXT NOT NULL DEFAULT '',
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_msg_event_dispatch_unique
  ON admin_message_event_dispatches(automation_id, recipient_user_id, event_key, schedule_date);

CREATE INDEX IF NOT EXISTS idx_admin_msg_event_dispatch_status_date
  ON admin_message_event_dispatches(status, schedule_date DESC);

CREATE INDEX IF NOT EXISTS idx_admin_msg_event_dispatch_admin_date
  ON admin_message_event_dispatches(admin_user_id, schedule_date DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_message_event_dispatches_updated_at') THEN
    CREATE TRIGGER admin_message_event_dispatches_updated_at
      BEFORE UPDATE ON admin_message_event_dispatches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE admin_message_event_dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_admin_message_event_dispatches_admin_only ON admin_message_event_dispatches;
CREATE POLICY p_admin_message_event_dispatches_admin_only
ON admin_message_event_dispatches
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());
