-- AutoLinks — Migration: Drop incorrect UNIQUE(kiwify_order_id) from kiwify_transactions
-- Reason: One Kiwify order can have multiple lifecycle events:
--   compra_aprovada → compra_reembolsada → chargeback
-- The UNIQUE constraint wrongly prevents inserting a refund/chargeback for an already-approved order.
-- Idempotency is handled by kiwify_webhooks_log.payload_hash, not by transaction uniqueness.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kiwify_transactions_kiwify_order_id_key'
      AND conrelid = 'kiwify_transactions'::regclass
  ) THEN
    ALTER TABLE kiwify_transactions DROP CONSTRAINT kiwify_transactions_kiwify_order_id_key;
  END IF;
END $$;
