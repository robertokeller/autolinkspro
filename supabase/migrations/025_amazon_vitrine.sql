-- Amazon Vitrine cache tables
-- HTTP extraction snapshots by tab with diff-based sync history.

CREATE TABLE IF NOT EXISTS amazon_vitrine_products (
  id               TEXT PRIMARY KEY,
  tab_key          TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  product_url      TEXT NOT NULL,
  asin             VARCHAR(15),
  title            TEXT NOT NULL DEFAULT '',
  image_url        TEXT NOT NULL DEFAULT '',
  price_cents      INTEGER NOT NULL DEFAULT 0,
  old_price_cents  INTEGER,
  discount_text    TEXT NOT NULL DEFAULT '',
  seller           TEXT NOT NULL DEFAULT 'Amazon',
  rating           NUMERIC(4,2),
  reviews_count    INTEGER,
  badge_text       TEXT NOT NULL DEFAULT '',
  payload_hash     TEXT NOT NULL DEFAULT '',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amazon_vitrine_products_unique_tab_url UNIQUE (tab_key, product_url)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'amazon_vitrine_products_updated_at') THEN
  CREATE TRIGGER amazon_vitrine_products_updated_at
  BEFORE UPDATE ON amazon_vitrine_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_amazon_vitrine_products_tab_active
  ON amazon_vitrine_products(tab_key, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_amazon_vitrine_products_active
  ON amazon_vitrine_products(is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_amazon_vitrine_products_collected_at
  ON amazon_vitrine_products(collected_at DESC);

CREATE TABLE IF NOT EXISTS amazon_vitrine_sync_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT NOT NULL DEFAULT 'manual',
  status           TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
  message          TEXT NOT NULL DEFAULT '',
  scanned_tabs     INTEGER NOT NULL DEFAULT 0,
  fetched_cards    INTEGER NOT NULL DEFAULT 0,
  added_count      INTEGER NOT NULL DEFAULT 0,
  updated_count    INTEGER NOT NULL DEFAULT 0,
  removed_count    INTEGER NOT NULL DEFAULT 0,
  unchanged_count  INTEGER NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amazon_vitrine_sync_runs_created_at
  ON amazon_vitrine_sync_runs(created_at DESC);
