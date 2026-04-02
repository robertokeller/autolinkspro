-- AutoLinks — Migration 017: Mark api_credentials.secret_key as encrypted
-- This migration adds a comment to document that secret_key values are now
-- encrypted at the application layer with AES-256-GCM.
-- Existing plaintext values continue to work (transparent fallback in the
-- application's decryptCredential function) but new writes will be encrypted.

COMMENT ON COLUMN api_credentials.secret_key IS
  'Encrypted with AES-256-GCM at the application layer (prefix enc:v1:). Legacy plaintext values are accepted transparently.';
