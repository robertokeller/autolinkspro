-- Migration 022: fix trusted backend detection for SECURITY DEFINER checks
-- Why:
-- - app_is_admin() runs as SECURITY DEFINER.
-- - app_is_trusted_backend() previously checked current_user.
-- - Inside SECURITY DEFINER, current_user resolves to function owner (postgres),
--   which incorrectly granted admin privileges to regular authenticated users.

CREATE OR REPLACE FUNCTION app_is_trusted_backend()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    -- Supabase service JWT role for PostgREST contexts
    COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
    OR
    -- Invoker role context preserved through SECURITY DEFINER boundaries
    COALESCE(
      NULLIF(NULLIF(current_setting('role', true), ''), 'none'),
      current_user
    ) IN (
      'postgres',
      'service_role',
      'supabase_admin',
      'supabase_auth_admin',
      'supabase_storage_admin'
    )
$$;

GRANT EXECUTE ON FUNCTION app_is_trusted_backend() TO authenticated;
