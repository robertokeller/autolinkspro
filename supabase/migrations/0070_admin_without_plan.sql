-- Migration 007 — Admins do not carry operational plans
-- Admin accounts only access the admin panel, so keep profile plan as "admin"
-- and clear plan expiry.

UPDATE profiles p
SET
  plan_id = 'admin',
  plan_expires_at = NULL,
  updated_at = NOW()
FROM user_roles r
WHERE r.user_id = p.user_id
  AND r.role = 'admin'
  AND (
    p.plan_id IS DISTINCT FROM 'admin'
    OR p.plan_expires_at IS NOT NULL
  );
