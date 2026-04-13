-- Migration: enforce valid category values on templates table.
-- The category column was renamed from type in migration 005 but never got
-- an explicit CHECK constraint, allowing arbitrary strings to be stored.

-- Normalise any existing rows that may have drifted from the accepted set.
UPDATE templates
SET category = 'oferta'
WHERE category IS NULL
   OR category NOT IN ('oferta', 'cupom', 'geral');

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_category_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_category_check
  CHECK (category IN ('oferta', 'cupom', 'geral')) NOT VALID;

-- Validate the constraint against all current rows (safe: UPDATE above ensures compliance).
ALTER TABLE templates VALIDATE CONSTRAINT templates_category_check;
