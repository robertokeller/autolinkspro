-- AutoLinks — Migration: Kiwify integration fixes (column constraints)
-- Adds UNIQUE to kiwify_transactions.kiwify_order_id (required for ON CONFLICT)
-- Drops UNIQUE on kiwify_plan_mappings.kiwify_product_id (same product can map to multiple plan variants)

-- ── kiwify_transactions: unique on kiwify_order_id for idempotency ────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kiwify_transactions_kiwify_order_id_key'
      AND conrelid = 'kiwify_transactions'::regclass
  ) THEN
    ALTER TABLE kiwify_transactions ADD CONSTRAINT kiwify_transactions_kiwify_order_id_key UNIQUE (kiwify_order_id);
  END IF;
END $$;

-- ── kiwify_plan_mappings: drop UNIQUE on kiwify_product_id ────────────────────
-- (allows one Kiwify product to map to monthly + annual variants)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kiwify_plan_mappings_kiwify_product_id_key'
      AND conrelid = 'kiwify_plan_mappings'::regclass
  ) THEN
    ALTER TABLE kiwify_plan_mappings DROP CONSTRAINT kiwify_plan_mappings_kiwify_product_id_key;
  END IF;
END $$;
