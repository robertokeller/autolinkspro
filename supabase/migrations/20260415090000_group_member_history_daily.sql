-- Track daily member-count evolution per WhatsApp group.
-- Data is upserted during group sync (first connection and manual updates).

CREATE TABLE IF NOT EXISTS group_member_history_daily (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id      UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  member_count  INTEGER NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  session_id    UUID,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'sync',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, snapshot_date)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_member_history_daily_updated_at') THEN
    CREATE TRIGGER group_member_history_daily_updated_at
    BEFORE UPDATE ON group_member_history_daily
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_group_member_history_daily_user_date
  ON group_member_history_daily(user_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_group_member_history_daily_group_date
  ON group_member_history_daily(group_id, snapshot_date DESC);
