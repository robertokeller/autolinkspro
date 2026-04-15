-- Add admin tracking columns to groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_jid TEXT NOT NULL DEFAULT '';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT NOT NULL DEFAULT '';

-- Index for fast admin group lookup
CREATE INDEX IF NOT EXISTS idx_groups_admin ON groups(user_id, platform, is_admin) WHERE deleted_at IS NULL;
