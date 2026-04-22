-- Migration 006 — Seed operational users
-- Upserts:
--   - admin:  admin@localhost.local  (role=admin, plan=admin)
--   - normal: user@localhost.local         (role=user, plan=plan-starter)
--
-- Passwords are bcrypt(10) hashes of 'abacate1'.
-- NOTE: this password does not meet the 12-character minimum enforced by the
-- API — it is intentionally short for the initial seed. If you change the
-- password through the UI you will need to use 12+ characters.
--
-- SOMENTE DESENVOLVIMENTO — não executar em produção.
-- Em produção, o admin é criado via ADMIN_EMAIL / ADMIN_PASSWORD env vars
-- através da função seedAdminIfEmpty() em services/api/src/index.ts.
DO $$
BEGIN
  IF current_setting('app.env', true) = 'production' THEN
    RAISE EXCEPTION
      '[006_seed_users] Esta migração NÃO deve rodar em produção. '
      'O admin de produção é criado via variáveis de ambiente ADMIN_EMAIL/ADMIN_PASSWORD. '
      'Se você está rodando isso intencionalmente em dev, defina app.env=development na sessão.';
  END IF;
END $$;
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
    'admin@localhost.local',
    '$2a$10$OLO1yxRoM8wDeA/3fVM9u.0WRWWQvCyfec8hdryAEfqlpT0pQxYQG',
    '{"name":"Admin","account_status":"active","status_updated_at":"2026-03-14T00:00:00.000Z"}'::jsonb,
    NOW()
  )
  ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    metadata      = users.metadata || EXCLUDED.metadata,
    updated_at    = NOW()
  RETURNING id INTO admin_id;

  -- Resolve actual id in case of conflict (RETURNING only works on INSERT path)
  SELECT id INTO admin_id FROM users WHERE email = 'admin@localhost.local';

  INSERT INTO user_roles (id, user_id, role)
  VALUES (gen_random_uuid(), admin_id, 'admin')
  ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

  INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at)
  VALUES (gen_random_uuid(), admin_id, 'Admin', 'admin@localhost.local', 'admin', NULL)
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
    'user@localhost.local',
    '$2a$10$7qvl7pIb97T.vBLLHsOcaeokUgnjrxor8r5MBcbQ2hnstQPqLUbxu',
    '{"name":"User","account_status":"active","status_updated_at":"2026-03-14T00:00:00.000Z"}'::jsonb,
    NOW()
  )
  ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    metadata      = users.metadata || EXCLUDED.metadata,
    updated_at    = NOW()
  RETURNING id INTO normal_id;

  SELECT id INTO normal_id FROM users WHERE email = 'user@localhost.local';

  INSERT INTO user_roles (id, user_id, role)
  VALUES (gen_random_uuid(), normal_id, 'user')
  ON CONFLICT (user_id) DO UPDATE SET role = 'user';

  INSERT INTO profiles (id, user_id, name, email, plan_id)
  VALUES (gen_random_uuid(), normal_id, 'User', 'user@localhost.local', 'plan-starter')
  ON CONFLICT (user_id) DO UPDATE SET
    name     = EXCLUDED.name,
    email    = EXCLUDED.email,
    plan_id  = EXCLUDED.plan_id,
    updated_at = NOW();

  -- Force fresh login for normal user (requires migration 003)
  UPDATE users SET token_invalidated_before = NOW() WHERE id = normal_id;

END $$;
