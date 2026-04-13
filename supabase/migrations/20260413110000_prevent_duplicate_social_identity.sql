-- AutoLinks — Prevent duplicate signup identities and cross-account social linking
-- This migration is intentionally non-destructive: it blocks new duplicates without
-- failing on historical duplicated rows that may already exist.

-- Helpful indexes for duplicate checks (if they do not already exist)
CREATE INDEX IF NOT EXISTS whatsapp_sessions_phone_status_idx
  ON whatsapp_sessions(phone, status)
  WHERE phone <> '';

CREATE INDEX IF NOT EXISTS telegram_sessions_phone_status_idx
  ON telegram_sessions(phone, status)
  WHERE phone <> '';

-- Profiles: one WhatsApp phone must belong to one account globally.
-- Enforced for new writes through trigger + advisory lock.
CREATE OR REPLACE FUNCTION enforce_unique_profiles_phone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone := COALESCE(BTRIM(NEW.phone), '');
  IF NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('profiles:' || NEW.phone));

  IF EXISTS (
    SELECT 1
      FROM profiles p
     WHERE p.phone = NEW.phone
       AND p.user_id <> NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Phone already linked to another account'
      USING ERRCODE = '23505',
            CONSTRAINT = 'profiles_phone_unique_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_unique_profiles_phone ON profiles;
CREATE TRIGGER trg_enforce_unique_profiles_phone
BEFORE INSERT OR UPDATE OF phone ON profiles
FOR EACH ROW
EXECUTE FUNCTION enforce_unique_profiles_phone();

-- WhatsApp sessions: block active cross-account linking for same phone.
CREATE OR REPLACE FUNCTION enforce_unique_whatsapp_phone_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone := COALESCE(BTRIM(NEW.phone), '');
  NEW.status := COALESCE(BTRIM(NEW.status), 'offline');

  IF NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('online', 'connecting', 'qr_code', 'pairing_code') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('whatsapp:' || NEW.phone));

  IF EXISTS (
    SELECT 1
      FROM whatsapp_sessions ws
     WHERE ws.phone = NEW.phone
       AND ws.user_id <> NEW.user_id
       AND ws.status IN ('online', 'connecting', 'qr_code', 'pairing_code')
       AND ws.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) THEN
    RAISE EXCEPTION 'WhatsApp already linked to another account'
      USING ERRCODE = '23505',
            CONSTRAINT = 'whatsapp_phone_active_unique_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_unique_whatsapp_phone_active ON whatsapp_sessions;
CREATE TRIGGER trg_enforce_unique_whatsapp_phone_active
BEFORE INSERT OR UPDATE OF phone, status ON whatsapp_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_unique_whatsapp_phone_active();

-- Telegram sessions: block active cross-account linking for same phone.
CREATE OR REPLACE FUNCTION enforce_unique_telegram_phone_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone := COALESCE(BTRIM(NEW.phone), '');
  NEW.status := COALESCE(BTRIM(NEW.status), 'offline');

  IF NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('online', 'connecting', 'awaiting_code', 'awaiting_password') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('telegram:' || NEW.phone));

  IF EXISTS (
    SELECT 1
      FROM telegram_sessions ts
     WHERE ts.phone = NEW.phone
       AND ts.user_id <> NEW.user_id
       AND ts.status IN ('online', 'connecting', 'awaiting_code', 'awaiting_password')
       AND ts.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) THEN
    RAISE EXCEPTION 'Telegram already linked to another account'
      USING ERRCODE = '23505',
            CONSTRAINT = 'telegram_phone_active_unique_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_unique_telegram_phone_active ON telegram_sessions;
CREATE TRIGGER trg_enforce_unique_telegram_phone_active
BEFORE INSERT OR UPDATE OF phone, status ON telegram_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_unique_telegram_phone_active();
