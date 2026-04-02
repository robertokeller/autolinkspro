-- Migration 008: email verification and password reset tokens
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('email_verification', 'password_reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_user_type_active
  ON auth_email_tokens (user_id, type, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_expires_at
  ON auth_email_tokens (expires_at);
