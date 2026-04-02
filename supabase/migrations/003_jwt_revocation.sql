-- Migration 003: JWT revocation support
-- Adds token_invalidated_before column so that outstanding JWTs can be
-- invalidated immediately when a user is blocked, archived, or signs out.
-- Any JWT whose iat (issued-at) is BEFORE this timestamp will be rejected
-- by authMiddleware even if the signature is otherwise valid.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_invalidated_before TIMESTAMPTZ DEFAULT NULL;

-- Partial index: only rows with a non-null timestamp are ever queried during
-- revocation checks, so a partial index keeps it minimal.
CREATE INDEX IF NOT EXISTS idx_users_token_invalidated
  ON users(id, token_invalidated_before)
  WHERE token_invalidated_before IS NOT NULL;
