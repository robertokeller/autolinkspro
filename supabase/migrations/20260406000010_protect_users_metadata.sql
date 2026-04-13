-- Migration 022: Protect users.metadata.account_status from self-service modification
-- This prevents users from escalating their own privileges by modifying account_status in metadata.

CREATE OR REPLACE FUNCTION protect_users_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Allow admins and trusted backend (service role) to modify anything
  IF app_is_trusted_backend() OR app_is_admin() THEN
    RETURN NEW;
  END IF;

  -- For non-admins, prevent modification of account_status in metadata
  IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
    IF NEW.metadata ? 'account_status' THEN
      -- Check if account_status is being changed
      IF OLD.metadata IS NULL OR NEW.metadata ? 'account_status' AND (OLD.metadata->>'account_status') IS DISTINCT FROM (NEW.metadata->>'account_status') THEN
        RAISE EXCEPTION 'Only administrators can modify account_status';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_users_account_status ON users;
CREATE TRIGGER trg_protect_users_account_status
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION protect_users_account_status();

-- Also protect other admin-only metadata fields if needed
-- This complements the existing protect_profile_privileged_columns() on profiles table.
