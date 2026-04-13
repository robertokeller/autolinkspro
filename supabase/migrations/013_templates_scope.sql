-- Align templates schema with scoped template module usage (Shopee vs Mercado Livre).
-- Keeps existing rows compatible by inferring scope from legacy tags when possible.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'shopee';

UPDATE templates
SET scope = CASE
  WHEN tags @> ARRAY['scope:meli']::text[] THEN 'meli'
  ELSE 'shopee'
END
WHERE scope IS NULL
   OR scope NOT IN ('shopee', 'meli');

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('shopee', 'meli')) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_templates_user_scope_created_at
  ON templates(user_id, scope, created_at DESC);
