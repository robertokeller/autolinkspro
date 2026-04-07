-- Migration: Add period_type to kiwify_plan_mappings
-- Supports 4 billing periods per plan: monthly, quarterly, semiannual, annual
-- Changes UNIQUE from (plan_id) to (plan_id, period_type)

-- 1. Add period_type column (default 'monthly' for existing rows)
ALTER TABLE kiwify_plan_mappings
  ADD COLUMN IF NOT EXISTS period_type VARCHAR(20) NOT NULL DEFAULT 'monthly';

-- 2. Migrate existing annual plan rows
-- Plans ending in '-annual' were annual billing, update their period_type
UPDATE kiwify_plan_mappings
  SET period_type = 'annual'
  WHERE plan_id LIKE '%-annual';

-- 3. Drop the old name-based unique constraints
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kiwify_plan_mappings_plan_id_key'
      AND conrelid = 'kiwify_plan_mappings'::regclass
  ) THEN
    ALTER TABLE kiwify_plan_mappings DROP CONSTRAINT kiwify_plan_mappings_plan_id_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kiwify_plan_mappings_kiwify_product_id_key'
      AND conrelid = 'kiwify_plan_mappings'::regclass
  ) THEN
    ALTER TABLE kiwify_plan_mappings DROP CONSTRAINT kiwify_plan_mappings_kiwify_product_id_key;
  END IF;
END$$;

-- 4. Add new composite unique constraint (plan_id + period_type)
ALTER TABLE kiwify_plan_mappings
  ADD CONSTRAINT kiwify_plan_mappings_plan_period_key UNIQUE (plan_id, period_type);

-- 5. Add comment
COMMENT ON COLUMN kiwify_plan_mappings.period_type IS
  'Billing period for this mapping: monthly | quarterly | semiannual | annual';
