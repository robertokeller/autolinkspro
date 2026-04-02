-- Migration 006 — Seed operational users
-- Upserts:
--   - admin:  robertokellercontato@gmail.com  (role=admin, plan=admin)
--   - normal: aliancaslovely@gmail.com         (role=user, plan=plan-starter)
--
-- Passwords are bcrypt(10) hashes of 'abacate1'.
-- NOTE: this password does not meet the 12-character minimum enforced by the
-- API — it is intentionally short for the initial seed. If you change the
-- password through the UI you will need to use 12+ characters.
--
-- Safe to re-run: uses ON CONFLICT DO UPDATE throughout.

DO $$
DECLARE
  admin_id  UUID := gen_random_uuid();
  normal_id UUID := gen_random_uuid();
BEGIN

  -- ── Admin user ─────────────────────────────────────────────────────────────
  INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at)
  VALUES (
    admin_id,
    'robertokellercontato@gmail.com',
    '$2a$10$OLO1yxRoM8wDeA/3fVM9u.0WRWWQvCyfec8hdryAEfqlpT0pQxYQG',
    '{"name":"Roberto Keller","account_status":"active","status_updated_at":"2026-03-14T00:00:00.000Z"}'::jsonb,
    NOW()
  )
  ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    metadata      = users.metadata || EXCLUDED.metadata,
    updated_at    = NOW()
  RETURNING id INTO admin_id;

  -- Resolve actual id in case of conflict (RETURNING only works on INSERT path)
  SELECT id INTO admin_id FROM users WHERE email = 'robertokellercontato@gmail.com';

  INSERT INTO user_roles (id, user_id, role)
  VALUES (gen_random_uuid(), admin_id, 'admin')
  ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

  INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at)
  VALUES (gen_random_uuid(), admin_id, 'Roberto Keller', 'robertokellercontato@gmail.com', 'admin', NULL)
  ON CONFLICT (user_id) DO UPDATE SET
    name           = EXCLUDED.name,
    email          = EXCLUDED.email,
    plan_id        = EXCLUDED.plan_id,
    plan_expires_at = EXCLUDED.plan_expires_at,
    updated_at = NOW();

  -- Force fresh login for admin (requires migration 003)
  UPDATE users SET token_invalidated_before = NOW() WHERE id = admin_id;

  -- ── Normal user ────────────────────────────────────────────────────────────
  INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at)
  VALUES (
    normal_id,
    'aliancaslovely@gmail.com',
    '$2a$10$7qvl7pIb97T.vBLLHsOcaeokUgnjrxor8r5MBcbQ2hnstQPqLUbxu',
    '{"name":"Aliancas Lovely","account_status":"active","status_updated_at":"2026-03-14T00:00:00.000Z"}'::jsonb,
    NOW()
  )
  ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    metadata      = users.metadata || EXCLUDED.metadata,
    updated_at    = NOW()
  RETURNING id INTO normal_id;

  SELECT id INTO normal_id FROM users WHERE email = 'aliancaslovely@gmail.com';

  INSERT INTO user_roles (id, user_id, role)
  VALUES (gen_random_uuid(), normal_id, 'user')
  ON CONFLICT (user_id) DO UPDATE SET role = 'user';

  INSERT INTO profiles (id, user_id, name, email, plan_id)
  VALUES (gen_random_uuid(), normal_id, 'Aliancas Lovely', 'aliancaslovely@gmail.com', 'plan-starter')
  ON CONFLICT (user_id) DO UPDATE SET
    name     = EXCLUDED.name,
    email    = EXCLUDED.email,
    plan_id  = EXCLUDED.plan_id,
    updated_at = NOW();

  -- Force fresh login for normal user (requires migration 003)
  UPDATE users SET token_invalidated_before = NOW() WHERE id = normal_id;

END $$;
