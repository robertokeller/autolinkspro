-- AutoLinks — PostgreSQL schema (self-hosted, no Supabase dependencies)
-- Run once on first deploy. Idempotent (uses IF NOT EXISTS / OR REPLACE).

-- ─── Extensions ──────────────────────────────────────────────────────────────
-- gen_random_uuid() is builtin from PG 13+; pgcrypto is a fallback
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
  email_confirmed_at       TIMESTAMPTZ DEFAULT NOW(),
  token_invalidated_before TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_token_invalidated
  ON users(id, token_invalidated_before)
  WHERE token_invalidated_before IS NOT NULL;

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

-- Auth e-mail tokens (verification + password reset)
CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('email_verification', 'password_reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_user_type_active
  ON auth_email_tokens (user_id, type, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_expires_at
  ON auth_email_tokens (expires_at);

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
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'whatsapp_sessions_updated_at') THEN
  CREATE TRIGGER whatsapp_sessions_updated_at BEFORE UPDATE ON whatsapp_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_wa_sessions_user
  ON whatsapp_sessions(user_id, status);

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
CREATE INDEX IF NOT EXISTS idx_tg_sessions_user
  ON telegram_sessions(user_id, status);

-- ─── Groups ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT 'whatsapp' CHECK (platform IN ('whatsapp','telegram')),
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
CREATE INDEX IF NOT EXISTS idx_groups_session_id
  ON groups(session_id);
CREATE INDEX IF NOT EXISTS idx_groups_user_id
  ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_groups_active
  ON groups(user_id, id)
  WHERE deleted_at IS NULL;

-- ─── Master groups ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS master_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  slug         TEXT,
  distribution TEXT NOT NULL DEFAULT 'sequential',
  member_limit INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'master_groups_updated_at') THEN
  CREATE TRIGGER master_groups_updated_at BEFORE UPDATE ON master_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_master_groups_user_id
  ON master_groups(user_id);

-- ─── Master group links ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS master_group_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_group_id UUID NOT NULL REFERENCES master_groups(id) ON DELETE CASCADE,
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (master_group_id, group_id)
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'master_group_links_updated_at') THEN
  CREATE TRIGGER master_group_links_updated_at BEFORE UPDATE ON master_group_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_mgl_master_group_id
  ON master_group_links(master_group_id);
CREATE INDEX IF NOT EXISTS idx_mgl_group_id
  ON master_group_links(group_id);

-- ─── Routes ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  source_group_id TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','paused','error')),
  rules           JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'routes_updated_at') THEN
  CREATE TRIGGER routes_updated_at BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_routes_user_status
  ON routes(user_id, status)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_routes_user_id
  ON routes(user_id);

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
  category   TEXT NOT NULL DEFAULT 'geral',
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
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','cancelled','failed')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  recurrence   TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly')),
  metadata     JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'scheduled_posts_updated_at') THEN
  CREATE TRIGGER scheduled_posts_updated_at BEFORE UPDATE ON scheduled_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_sp_status_scheduled_at
  ON scheduled_posts(status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sp_user_status
  ON scheduled_posts(user_id, status)
  WHERE status = 'pending';

-- ─── Scheduled post destinations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_post_destinations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_spd_post_id
  ON scheduled_post_destinations(post_id);

-- ─── History entries ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS history_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT '',
  destination       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'success',
  details           JSONB NOT NULL DEFAULT '{}',
  direction         TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound','system')),
  message_type      TEXT NOT NULL DEFAULT 'text',
  processing_status TEXT NOT NULL DEFAULT 'processed' CHECK (processing_status IN ('processed','sent','skipped','error','blocked')),
  block_reason      TEXT NOT NULL DEFAULT '',
  error_step        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS history_entries_user_idx ON history_entries(user_id);
CREATE INDEX IF NOT EXISTS history_entries_created_idx ON history_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user_created
  ON history_entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_route_sent_user_created
  ON history_entries(user_id, created_at DESC)
  WHERE type = 'route_forward' AND processing_status = 'sent';

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
CREATE INDEX IF NOT EXISTS idx_link_hub_pages_user_id
  ON link_hub_pages(user_id);

-- ─── Shopee automations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee_automations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','paused')),
  -- Flat operational columns (match frontend types.ts Row shape)
  interval_minutes      INTEGER NOT NULL DEFAULT 60,
  min_discount          NUMERIC NOT NULL DEFAULT 0,
  min_commission        NUMERIC NOT NULL DEFAULT 0,
  min_price             NUMERIC NOT NULL DEFAULT 0,
  max_price             NUMERIC NOT NULL DEFAULT 999999,
  categories            TEXT[],
  destination_group_ids TEXT[],
  master_group_ids      TEXT[] NOT NULL DEFAULT '{}',
  template_id           UUID REFERENCES templates(id) ON DELETE SET NULL,
  session_id            UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL,
  active_hours_start    TEXT NOT NULL DEFAULT '08:00',
  active_hours_end      TEXT NOT NULL DEFAULT '20:00',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Legacy JSONB config (kept for backwards compat / data migration reference)
  config                JSONB NOT NULL DEFAULT '{}',
  last_run_at           TIMESTAMPTZ,
  products_sent         INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'shopee_automations_updated_at') THEN
  CREATE TRIGGER shopee_automations_updated_at BEFORE UPDATE ON shopee_automations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_shopee_automations_user_id
  ON shopee_automations(user_id);

-- ─── MeLi sessions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meli_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  account_name    TEXT NOT NULL DEFAULT '',
  ml_user_id      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','error','untested','not_found','no_affiliate')),
  last_checked_at TIMESTAMPTZ,
  error_message   TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meli_sessions_updated_at') THEN
  CREATE TRIGGER meli_sessions_updated_at BEFORE UPDATE ON meli_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_meli_sessions_user_id
  ON meli_sessions(user_id);

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
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
  ON admin_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user_id
  ON admin_audit_logs(target_user_id);

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
CREATE INDEX IF NOT EXISTS idx_notif_user_status
  ON user_notifications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_announcement
  ON user_notifications(announcement_id);

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

-- Seed default settings
INSERT INTO system_settings (key, value) VALUES
  ('admin_config', '{"plans":[],"features":{},"limits":{}}'::jsonb),
  ('runtime_control', '{"enabled":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
