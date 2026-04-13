-- Migration 023: trust application DB role for backend-only operations under RLS
-- Why:
-- - API runs with role autolinks_app in production.
-- - Startup bootstrap may need to create/update admin seed rows.
-- - Policies rely on app_is_trusted_backend()/app_is_admin() for privileged backend paths.

CREATE OR REPLACE FUNCTION app_is_trusted_backend()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
    OR
    COALESCE(
      NULLIF(NULLIF(current_setting('role', true), ''), 'none'),
      current_user
    ) IN (
      'postgres',
      'service_role',
      'supabase_admin',
      'supabase_auth_admin',
      'supabase_storage_admin',
      'autolinks_app'
    )
$$;

GRANT EXECUTE ON FUNCTION app_is_trusted_backend() TO authenticated;
