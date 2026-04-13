-- Migration 026: Restrict system_settings SELECT to known safe keys for regular users.
--
-- Previously, all authenticated users could SELECT any row from system_settings.
-- This is safe for the current key set (admin_config, runtime_control) but would
-- expose any future sensitive keys added without a matching RLS update.
--
-- New policy: regular users can only read the whitelist of keys the frontend
-- legitimately needs. Admins and the trusted backend can read all rows.

DROP POLICY IF EXISTS p_system_settings_select_authenticated ON system_settings;

CREATE POLICY p_system_settings_select_authenticated
ON system_settings
FOR SELECT
TO authenticated
USING (
  -- Trusted backend readers (API service) can read everything.
  app_is_trusted_backend()
  OR
  -- Admins can read everything.
  app_is_admin()
  OR
  -- Regular authenticated users may only read keys the frontend
  -- explicitly requires: plan configs and runtime enable/disable state.
  key IN ('admin_config', 'runtime_control')
);
