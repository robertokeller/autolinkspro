-- Plan sync governance: allow explicit admin manual override over automatic billing sync.
-- This keeps Kiwify automation enabled by default, while allowing admin to lock a user's
-- plan/expiry when operationally required.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS plan_sync_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS plan_sync_note TEXT NOT NULL DEFAULT '';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS plan_sync_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_plan_sync_mode_check'
      AND conrelid = 'profiles'::regclass
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_plan_sync_mode_check
      CHECK (plan_sync_mode IN ('auto', 'manual_override'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_profiles_plan_sync_mode
  ON profiles (plan_sync_mode);

-- Extend profile protection trigger: non-admin users cannot mutate billing-critical
-- fields, including sync governance columns.
CREATE OR REPLACE FUNCTION protect_profile_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF app_is_trusted_backend() OR app_is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Nao e permitido alterar owner do profile';
  END IF;

  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at
     OR NEW.plan_sync_mode IS DISTINCT FROM OLD.plan_sync_mode
     OR NEW.plan_sync_note IS DISTINCT FROM OLD.plan_sync_note
     OR NEW.plan_sync_updated_at IS DISTINCT FROM OLD.plan_sync_updated_at THEN
    RAISE EXCEPTION 'Nao e permitido alterar plano sem permissao administrativa';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN profiles.plan_sync_mode IS
  'Billing sync governance: auto (integration-managed) or manual_override (admin lock).';

