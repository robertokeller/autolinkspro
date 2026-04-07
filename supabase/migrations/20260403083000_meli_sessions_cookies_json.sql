-- Store Mercado Livre cookies in DB so sessions can be rehydrated across environments.
ALTER TABLE meli_sessions
  ADD COLUMN IF NOT EXISTS cookies_json JSONB;
