-- Migration 007: Rename api_credentials.encrypted_secret → secret_key
-- The column name "encrypted_secret" was misleading — the value is stored as
-- plaintext (the user's own Shopee API secret key). Renaming to "secret_key"
-- reflects reality and removes the false implication of encryption at rest.
-- Encryption at rest is a future improvement (requires key management).

ALTER TABLE api_credentials RENAME COLUMN encrypted_secret TO secret_key;
