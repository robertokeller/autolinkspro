-- Migration 021: Supabase hardening (RLS + policies + privilege boundaries)
-- Security goals:
-- 1) Strong tenant isolation by user
-- 2) No self privilege escalation (user -> admin)
-- 3) Explicit admin-only write surfaces
-- 4) Backend/service compatibility for trusted DB roles

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_try_parse_uuid(raw_value TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF raw_value IS NULL OR btrim(raw_value) = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw_value::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    auth.uid(),
    app_try_parse_uuid(NULLIF(current_setting('request.jwt.claim.sub', true), '')),
    app_try_parse_uuid(NULLIF(current_setting('app.user_id', true), ''))
  )
$$;

CREATE OR REPLACE FUNCTION app_is_trusted_backend()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    -- Supabase PostgREST service JWT (role claim)
    COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
    OR
    -- Trusted role context (uses GUC "role" to preserve invoker role inside SECURITY DEFINER)
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

CREATE OR REPLACE FUNCTION app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT app_is_trusted_backend() OR EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE ur.user_id = app_current_user_id()
      AND ur.role = 'admin'
  )
$$;

REVOKE ALL ON FUNCTION app_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION app_is_trusted_backend() TO authenticated;

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
     OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at THEN
    RAISE EXCEPTION 'Nao e permitido alterar plano sem permissao administrativa';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON profiles;
CREATE TRIGGER trg_protect_profile_privileged_columns
BEFORE UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION protect_profile_privileged_columns();

CREATE OR REPLACE FUNCTION protect_user_roles_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF app_is_trusted_backend() OR app_is_admin() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Somente administradores podem alterar user_roles';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_user_roles_mutation ON user_roles;
CREATE TRIGGER trg_protect_user_roles_mutation
BEFORE INSERT OR UPDATE OR DELETE ON user_roles
FOR EACH ROW
EXECUTE FUNCTION protect_user_roles_mutation();

-- Enable and force RLS for all application tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users',
    'profiles',
    'user_roles',
    'auth_email_tokens',
    'whatsapp_sessions',
    'telegram_sessions',
    'groups',
    'master_groups',
    'master_group_links',
    'routes',
    'route_destinations',
    'templates',
    'scheduled_posts',
    'scheduled_post_destinations',
    'history_entries',
    'link_hub_pages',
    'shopee_automations',
    'meli_sessions',
    'meli_vitrine_products',
    'meli_vitrine_sync_runs',
    'api_credentials',
    'admin_audit_logs',
    'system_announcements',
    'user_notifications',
    'app_runtime_flags',
    'system_settings',
    'admin_wa_broadcasts',
    'admin_message_automations',
    'runtime_rate_limits',
    'rpc_idempotency_keys'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Users table: own profile read only; writes are admin/service controlled.
DROP POLICY IF EXISTS p_users_select_own_or_admin ON users;
CREATE POLICY p_users_select_own_or_admin
ON users
FOR SELECT
TO authenticated
USING (id = app_current_user_id() OR app_is_admin());

DROP POLICY IF EXISTS p_users_insert_admin_only ON users;
CREATE POLICY p_users_insert_admin_only
ON users
FOR INSERT
TO authenticated
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_users_update_admin_only ON users;
CREATE POLICY p_users_update_admin_only
ON users
FOR UPDATE
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_users_delete_admin_only ON users;
CREATE POLICY p_users_delete_admin_only
ON users
FOR DELETE
TO authenticated
USING (app_is_admin());

-- Generic owner policies for user_id scoped tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles',
    'whatsapp_sessions',
    'telegram_sessions',
    'groups',
    'master_groups',
    'routes',
    'templates',
    'scheduled_posts',
    'history_entries',
    'link_hub_pages',
    'shopee_automations',
    'meli_sessions',
    'api_credentials',
    'user_notifications',
    'rpc_idempotency_keys'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS p_select_own_or_admin ON %I', t);
    EXECUTE format('CREATE POLICY p_select_own_or_admin ON %I FOR SELECT TO authenticated USING (user_id = app_current_user_id() OR app_is_admin())', t);

    EXECUTE format('DROP POLICY IF EXISTS p_insert_own_or_admin ON %I', t);
    EXECUTE format('CREATE POLICY p_insert_own_or_admin ON %I FOR INSERT TO authenticated WITH CHECK (user_id = app_current_user_id() OR app_is_admin())', t);

    EXECUTE format('DROP POLICY IF EXISTS p_update_own_or_admin ON %I', t);
    EXECUTE format('CREATE POLICY p_update_own_or_admin ON %I FOR UPDATE TO authenticated USING (user_id = app_current_user_id() OR app_is_admin()) WITH CHECK (user_id = app_current_user_id() OR app_is_admin())', t);

    EXECUTE format('DROP POLICY IF EXISTS p_delete_own_or_admin ON %I', t);
    EXECUTE format('CREATE POLICY p_delete_own_or_admin ON %I FOR DELETE TO authenticated USING (user_id = app_current_user_id() OR app_is_admin())', t);
  END LOOP;
END $$;

-- user_roles: users can read own role, but writes are admin-only.
DROP POLICY IF EXISTS p_user_roles_select_own_or_admin ON user_roles;
CREATE POLICY p_user_roles_select_own_or_admin
ON user_roles
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

DROP POLICY IF EXISTS p_user_roles_insert_admin_only ON user_roles;
CREATE POLICY p_user_roles_insert_admin_only
ON user_roles
FOR INSERT
TO authenticated
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_user_roles_update_admin_only ON user_roles;
CREATE POLICY p_user_roles_update_admin_only
ON user_roles
FOR UPDATE
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_user_roles_delete_admin_only ON user_roles;
CREATE POLICY p_user_roles_delete_admin_only
ON user_roles
FOR DELETE
TO authenticated
USING (app_is_admin());

-- Parent-scoped tables.
DROP POLICY IF EXISTS p_master_group_links_select ON master_group_links;
CREATE POLICY p_master_group_links_select
ON master_group_links
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM master_groups mg
    WHERE mg.id = master_group_links.master_group_id
      AND mg.user_id = app_current_user_id()
  )
);

DROP POLICY IF EXISTS p_master_group_links_insert ON master_group_links;
CREATE POLICY p_master_group_links_insert
ON master_group_links
FOR INSERT
TO authenticated
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM master_groups mg
      WHERE mg.id = master_group_links.master_group_id
        AND mg.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = master_group_links.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_master_group_links_update ON master_group_links;
CREATE POLICY p_master_group_links_update
ON master_group_links
FOR UPDATE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM master_groups mg
    WHERE mg.id = master_group_links.master_group_id
      AND mg.user_id = app_current_user_id()
  )
)
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM master_groups mg
      WHERE mg.id = master_group_links.master_group_id
        AND mg.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = master_group_links.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_master_group_links_delete ON master_group_links;
CREATE POLICY p_master_group_links_delete
ON master_group_links
FOR DELETE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM master_groups mg
    WHERE mg.id = master_group_links.master_group_id
      AND mg.user_id = app_current_user_id()
  )
);

DROP POLICY IF EXISTS p_route_destinations_select ON route_destinations;
CREATE POLICY p_route_destinations_select
ON route_destinations
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM routes r
    WHERE r.id = route_destinations.route_id
      AND r.user_id = app_current_user_id()
  )
);

DROP POLICY IF EXISTS p_route_destinations_insert ON route_destinations;
CREATE POLICY p_route_destinations_insert
ON route_destinations
FOR INSERT
TO authenticated
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM routes r
      WHERE r.id = route_destinations.route_id
        AND r.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = route_destinations.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_route_destinations_update ON route_destinations;
CREATE POLICY p_route_destinations_update
ON route_destinations
FOR UPDATE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM routes r
    WHERE r.id = route_destinations.route_id
      AND r.user_id = app_current_user_id()
  )
)
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM routes r
      WHERE r.id = route_destinations.route_id
        AND r.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = route_destinations.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_route_destinations_delete ON route_destinations;
CREATE POLICY p_route_destinations_delete
ON route_destinations
FOR DELETE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM routes r
    WHERE r.id = route_destinations.route_id
      AND r.user_id = app_current_user_id()
  )
);

DROP POLICY IF EXISTS p_spd_select ON scheduled_post_destinations;
CREATE POLICY p_spd_select
ON scheduled_post_destinations
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM scheduled_posts sp
    WHERE sp.id = scheduled_post_destinations.post_id
      AND sp.user_id = app_current_user_id()
  )
);

DROP POLICY IF EXISTS p_spd_insert ON scheduled_post_destinations;
CREATE POLICY p_spd_insert
ON scheduled_post_destinations
FOR INSERT
TO authenticated
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      WHERE sp.id = scheduled_post_destinations.post_id
        AND sp.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = scheduled_post_destinations.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_spd_update ON scheduled_post_destinations;
CREATE POLICY p_spd_update
ON scheduled_post_destinations
FOR UPDATE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM scheduled_posts sp
    WHERE sp.id = scheduled_post_destinations.post_id
      AND sp.user_id = app_current_user_id()
  )
)
WITH CHECK (
  app_is_admin()
  OR (
    EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      WHERE sp.id = scheduled_post_destinations.post_id
        AND sp.user_id = app_current_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM groups g
      WHERE g.id = scheduled_post_destinations.group_id
        AND g.user_id = app_current_user_id()
        AND g.deleted_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS p_spd_delete ON scheduled_post_destinations;
CREATE POLICY p_spd_delete
ON scheduled_post_destinations
FOR DELETE
TO authenticated
USING (
  app_is_admin()
  OR EXISTS (
    SELECT 1
    FROM scheduled_posts sp
    WHERE sp.id = scheduled_post_destinations.post_id
      AND sp.user_id = app_current_user_id()
  )
);

-- System/runtime surfaces.
DROP POLICY IF EXISTS p_system_settings_select_authenticated ON system_settings;
CREATE POLICY p_system_settings_select_authenticated
ON system_settings
FOR SELECT
TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS p_system_settings_write_admin_only ON system_settings;
CREATE POLICY p_system_settings_write_admin_only
ON system_settings
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_runtime_flags_select_authenticated ON app_runtime_flags;
CREATE POLICY p_runtime_flags_select_authenticated
ON app_runtime_flags
FOR SELECT
TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS p_runtime_flags_write_admin_only ON app_runtime_flags;
CREATE POLICY p_runtime_flags_write_admin_only
ON app_runtime_flags
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_system_announcements_select ON system_announcements;
CREATE POLICY p_system_announcements_select
ON system_announcements
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR (
    is_active = TRUE
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at >= NOW())
  )
);

DROP POLICY IF EXISTS p_system_announcements_write_admin_only ON system_announcements;
CREATE POLICY p_system_announcements_write_admin_only
ON system_announcements
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_admin_audit_logs_admin_only ON admin_audit_logs;
CREATE POLICY p_admin_audit_logs_admin_only
ON admin_audit_logs
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_admin_wa_broadcasts_admin_only ON admin_wa_broadcasts;
CREATE POLICY p_admin_wa_broadcasts_admin_only
ON admin_wa_broadcasts
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_admin_message_automations_admin_only ON admin_message_automations;
CREATE POLICY p_admin_message_automations_admin_only
ON admin_message_automations
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_runtime_rate_limits_admin_only ON runtime_rate_limits;
CREATE POLICY p_runtime_rate_limits_admin_only
ON runtime_rate_limits
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_auth_email_tokens_admin_only ON auth_email_tokens;
CREATE POLICY p_auth_email_tokens_admin_only
ON auth_email_tokens
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

-- Vitrine cache: read for authenticated users, writes admin/service only.
DROP POLICY IF EXISTS p_meli_vitrine_products_select_authenticated ON meli_vitrine_products;
CREATE POLICY p_meli_vitrine_products_select_authenticated
ON meli_vitrine_products
FOR SELECT
TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS p_meli_vitrine_products_write_admin_only ON meli_vitrine_products;
CREATE POLICY p_meli_vitrine_products_write_admin_only
ON meli_vitrine_products
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

DROP POLICY IF EXISTS p_meli_vitrine_sync_runs_select_authenticated ON meli_vitrine_sync_runs;
CREATE POLICY p_meli_vitrine_sync_runs_select_authenticated
ON meli_vitrine_sync_runs
FOR SELECT
TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS p_meli_vitrine_sync_runs_write_admin_only ON meli_vitrine_sync_runs;
CREATE POLICY p_meli_vitrine_sync_runs_write_admin_only
ON meli_vitrine_sync_runs
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

-- Base grants for PostgREST roles. RLS remains the real authorization boundary.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
