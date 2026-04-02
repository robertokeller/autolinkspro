-- AutoLinks — Migration 020: Security + scalability hardening
-- - Immutable admin audit logs
-- - Distributed rate-limit buckets (PostgreSQL-backed)
-- - RPC idempotency key store

CREATE TABLE IF NOT EXISTS runtime_rate_limits (
  scope_key     TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  window_ms     INTEGER NOT NULL CHECK (window_ms > 0),
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_runtime_rate_limits_expires_at
  ON runtime_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS rpc_idempotency_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  function_name  TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'completed', 'failed')),
  response_data  JSONB,
  error_message  TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, function_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_rpc_idempotency_expires_at
  ON rpc_idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_rpc_idempotency_user_function_created
  ON rpc_idempotency_keys (user_id, function_name, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rpc_idempotency_keys_updated_at') THEN
    CREATE TRIGGER rpc_idempotency_keys_updated_at
      BEFORE UPDATE ON rpc_idempotency_keys
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_admin_audit_logs_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_logs is immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_audit_logs_no_update') THEN
    CREATE TRIGGER admin_audit_logs_no_update
      BEFORE UPDATE ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_logs_mutation();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_audit_logs_no_delete') THEN
    CREATE TRIGGER admin_audit_logs_no_delete
      BEFORE DELETE ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_logs_mutation();
  END IF;
END $$;
