-- AutoLinks — Migration 001: Initial schema
-- Idempotent: safe to run on brand-new or existing databases.
-- All statements use IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING.

-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Utility: auto-update updated_at ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- ─── Auth: users ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  email_confirmed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_updated_at') THEN
  CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Profiles ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  plan_id          TEXT NOT NULL DEFAULT 'plan-starter',
  plan_expires_at  TIMESTAMPTZ,
  notification_prefs JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_updated_at') THEN
  CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── User roles ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── WhatsApp sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'offline',
  auth_method   TEXT NOT NULL DEFAULT 'qr',
  qr_code       TEXT NOT NULL DEFAULT '',
  connected_at  TIMESTAMPTZ,
  error_message TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'whatsapp_sessions_updated_at') THEN
  CREATE TRIGGER whatsapp_sessions_updated_at BEFORE UPDATE ON whatsapp_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Telegram sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'offline',
  session_string  TEXT NOT NULL DEFAULT '',
  phone_code_hash TEXT NOT NULL DEFAULT '',
  connected_at    TIMESTAMPTZ,
  error_message   TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'telegram_sessions_updated_at') THEN
  CREATE TRIGGER telegram_sessions_updated_at BEFORE UPDATE ON telegram_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Groups ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT 'whatsapp',
  invite_link  TEXT NOT NULL DEFAULT '',
  member_count INTEGER NOT NULL DEFAULT 0,
  session_id   UUID,
  external_id  TEXT NOT NULL DEFAULT '',
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, session_id, external_id)
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'groups_updated_at') THEN
  CREATE TRIGGER groups_updated_at BEFORE UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Master groups ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS master_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'master_groups_updated_at') THEN
  CREATE TRIGGER master_groups_updated_at BEFORE UPDATE ON master_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Master group links ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS master_group_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_group_id UUID NOT NULL REFERENCES master_groups(id) ON DELETE CASCADE,
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (master_group_id, group_id)
);

-- ─── Routes ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  source_group_id TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  filters         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'routes_updated_at') THEN
  CREATE TRIGGER routes_updated_at BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Route destinations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_destinations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id   UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (route_id, group_id)
);

-- ─── Templates ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'manual',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'templates_updated_at') THEN
  CREATE TRIGGER templates_updated_at BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Scheduled posts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','failed')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  recurrence   TEXT NOT NULL DEFAULT 'none',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'scheduled_posts_updated_at') THEN
  CREATE TRIGGER scheduled_posts_updated_at BEFORE UPDATE ON scheduled_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Scheduled post destinations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_post_destinations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, group_id)
);

-- ─── History entries ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS history_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT '',
  destination       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'success',
  details           JSONB NOT NULL DEFAULT '{}',
  direction         TEXT NOT NULL DEFAULT 'outbound',
  message_type      TEXT NOT NULL DEFAULT 'text',
  processing_status TEXT NOT NULL DEFAULT 'processed',
  block_reason      TEXT NOT NULL DEFAULT '',
  error_step        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS history_entries_user_idx ON history_entries(user_id);
CREATE INDEX IF NOT EXISTS history_entries_created_idx ON history_entries(created_at DESC);

-- ─── Link hub pages ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_hub_pages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  slug       TEXT UNIQUE NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'link_hub_pages_updated_at') THEN
  CREATE TRIGGER link_hub_pages_updated_at BEFORE UPDATE ON link_hub_pages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Shopee automations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee_automations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',
  config         JSONB NOT NULL DEFAULT '{}',
  last_run_at    TIMESTAMPTZ,
  products_sent  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'shopee_automations_updated_at') THEN
  CREATE TRIGGER shopee_automations_updated_at BEFORE UPDATE ON shopee_automations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── MeLi sessions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meli_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  account_name    TEXT NOT NULL DEFAULT '',
  ml_user_id      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  last_checked_at TIMESTAMPTZ,
  error_message   TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meli_sessions_updated_at') THEN
  CREATE TRIGGER meli_sessions_updated_at BEFORE UPDATE ON meli_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── API credentials ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_credentials (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  app_id           TEXT NOT NULL DEFAULT '',
  secret_key       TEXT NOT NULL DEFAULT '',
  region           TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'api_credentials_updated_at') THEN
  CREATE TRIGGER api_credentials_updated_at BEFORE UPDATE ON api_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Admin audit logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL DEFAULT '',
  target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON admin_audit_logs(created_at DESC);

-- ─── System announcements ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_announcements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL DEFAULT '',
  message               TEXT NOT NULL DEFAULT '',
  severity              TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  channel               TEXT NOT NULL DEFAULT 'bell' CHECK (channel IN ('bell','modal','both')),
  auto_popup_on_login   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at             TIMESTAMPTZ,
  ends_at               TIMESTAMPTZ,
  target_filter         JSONB NOT NULL DEFAULT '{}',
  last_delivered_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'system_announcements_updated_at') THEN
  CREATE TRIGGER system_announcements_updated_at BEFORE UPDATE ON system_announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── User notifications ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id UUID NOT NULL REFERENCES system_announcements(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','dismissed')),
  delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, announcement_id)
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_notifications_updated_at') THEN
  CREATE TRIGGER user_notifications_updated_at BEFORE UPDATE ON user_notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── App runtime flags ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_runtime_flags (
  id                   TEXT PRIMARY KEY DEFAULT 'global',
  maintenance_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_title    TEXT NOT NULL DEFAULT 'Sistema em manutenção',
  maintenance_message  TEXT NOT NULL DEFAULT 'Estamos realizando melhorias.',
  maintenance_eta      TEXT,
  allow_admin_bypass   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_runtime_flags (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- ─── System settings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'system_settings_updated_at') THEN
  CREATE TRIGGER system_settings_updated_at BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

INSERT INTO system_settings (key, value) VALUES
  ('admin_config', '{"plans":[],"features":{},"limits":{}}'::jsonb),
  ('runtime_control', '{"enabled":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
