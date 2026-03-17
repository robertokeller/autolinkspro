-- Migration 007: rename api_credentials.encrypted_secret -> secret_key
-- Idempotent: only rename on legacy schema where old column exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_credentials'
      AND column_name = 'encrypted_secret'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_credentials'
      AND column_name = 'secret_key'
  ) THEN
    ALTER TABLE api_credentials RENAME COLUMN encrypted_secret TO secret_key;
  END IF;
END $$;
