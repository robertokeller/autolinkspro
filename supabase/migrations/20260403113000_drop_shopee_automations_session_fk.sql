-- Allow shopee_automations.session_id to scope both WhatsApp and Telegram groups.
-- The automation runner treats this field as a generic session identifier, not as
-- a direct relationship to whatsapp_sessions.

ALTER TABLE shopee_automations ADD COLUMN IF NOT EXISTS session_id UUID;

DO $$
DECLARE
  fk_record RECORD;
BEGIN
  FOR fk_record IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND nsp.nspname = 'public'
      AND rel.relname = 'shopee_automations'
      AND att.attname = 'session_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.shopee_automations DROP CONSTRAINT IF EXISTS %I',
      fk_record.conname
    );
  END LOOP;
END $$;