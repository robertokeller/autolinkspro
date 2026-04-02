-- Migration 009: schedule contract sync (frontend, backend and database)
-- Keeps scheduled_posts aligned with the current scheduling model.

ALTER TABLE scheduled_posts
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN recurrence SET DEFAULT 'none',
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')) NOT VALID;

ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_recurrence_check;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_recurrence_check
  CHECK (recurrence IN ('none', 'daily', 'weekly')) NOT VALID;

ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_metadata_object_check;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

CREATE INDEX IF NOT EXISTS idx_sp_status_scheduled_at
  ON scheduled_posts(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sp_user_status
  ON scheduled_posts(user_id, status)
  WHERE status = 'pending';
