-- Migration: backend role compatibility with strict RLS policies
-- - Remove auth schema dependency from app_current_user_id() so DB app roles work.
-- - Ensure autolinks_app is member of authenticated to match policy TO clauses.

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    app_try_parse_uuid(NULLIF(current_setting('request.jwt.claim.sub', true), '')),
    app_try_parse_uuid(NULLIF(current_setting('app.user_id', true), ''))
  )
$$;

GRANT EXECUTE ON FUNCTION app_current_user_id() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolinks_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT authenticated TO autolinks_app;
  END IF;
END $$;
