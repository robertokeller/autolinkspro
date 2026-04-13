-- AutoLinks — Migration: Kiwify payment integration
-- Tables: kiwify_config, kiwify_plan_mappings, kiwify_transactions, kiwify_webhooks_log

-- ─── Kiwify config (singleton) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kiwify_config (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           TEXT NOT NULL DEFAULT '',
  client_secret       TEXT NOT NULL DEFAULT '',
  account_id          TEXT NOT NULL DEFAULT '',
  webhook_secret      TEXT NOT NULL DEFAULT '',
  oauth_token_cache   TEXT NOT NULL DEFAULT '',
  affiliate_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  grace_period_days   INTEGER NOT NULL DEFAULT 3,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kiwify_config_updated_at') THEN
  CREATE TRIGGER kiwify_config_updated_at BEFORE UPDATE ON kiwify_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Kiwify plan mappings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kiwify_plan_mappings (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                     TEXT NOT NULL,
  kiwify_product_id           TEXT NOT NULL DEFAULT '',
  kiwify_product_name         TEXT NOT NULL DEFAULT '',
  kiwify_checkout_url         TEXT NOT NULL DEFAULT '',
  affiliate_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  affiliate_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id),
  UNIQUE (kiwify_product_id)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kiwify_plan_mappings_updated_at') THEN
  CREATE TRIGGER kiwify_plan_mappings_updated_at BEFORE UPDATE ON kiwify_plan_mappings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

-- ─── Kiwify transactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kiwify_transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
  kiwify_order_id           TEXT NOT NULL,
  kiwify_product_id         TEXT NOT NULL DEFAULT '',
  plan_id                   TEXT NOT NULL DEFAULT '',
  event_type                TEXT NOT NULL DEFAULT '',
  status                    TEXT NOT NULL DEFAULT 'pending',
  amount_cents              INTEGER NOT NULL DEFAULT 0,
  payment_method            TEXT NOT NULL DEFAULT '',
  customer_email            TEXT NOT NULL DEFAULT '',
  customer_name             TEXT NOT NULL DEFAULT '',
  customer_cpf              TEXT NOT NULL DEFAULT '',
  affiliate_id              TEXT NOT NULL DEFAULT '',
  affiliate_name            TEXT NOT NULL DEFAULT '',
  affiliate_commission_cents INTEGER NOT NULL DEFAULT 0,
  tracking_data             JSONB NOT NULL DEFAULT '{}',
  raw_payload               JSONB NOT NULL DEFAULT '{}',
  processed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kiwify_tx_user_id_idx ON kiwify_transactions(user_id);
CREATE INDEX IF NOT EXISTS kiwify_tx_order_id_idx ON kiwify_transactions(kiwify_order_id);
CREATE INDEX IF NOT EXISTS kiwify_tx_customer_email_idx ON kiwify_transactions(customer_email);
CREATE INDEX IF NOT EXISTS kiwify_tx_event_type_idx ON kiwify_transactions(event_type);
CREATE INDEX IF NOT EXISTS kiwify_tx_status_idx ON kiwify_transactions(status);

-- ─── Kiwify webhooks log (audit + idempotency) ──────────────────────────────
CREATE TABLE IF NOT EXISTS kiwify_webhooks_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type            TEXT NOT NULL DEFAULT '',
  kiwify_order_id       TEXT NOT NULL DEFAULT '',
  payload_hash          TEXT NOT NULL DEFAULT '',
  http_status_returned  INTEGER NOT NULL DEFAULT 200,
  processing_result     TEXT NOT NULL DEFAULT '',
  error_message         TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kiwify_wh_log_hash_idx ON kiwify_webhooks_log(payload_hash);
CREATE INDEX IF NOT EXISTS kiwify_wh_log_order_idx ON kiwify_webhooks_log(kiwify_order_id);
