-- Align meli_sessions status constraint with statuses returned by Mercado Livre RPA.
ALTER TABLE meli_sessions DROP CONSTRAINT IF EXISTS meli_sessions_status_check;
ALTER TABLE meli_sessions ADD CONSTRAINT meli_sessions_status_check
  CHECK (status IN ('active', 'expired', 'error', 'untested', 'not_found', 'no_affiliate')) NOT VALID;
