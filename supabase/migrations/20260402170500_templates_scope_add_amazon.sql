-- Allow Amazon-specific templates in the shared templates table scope.
-- Keeps backward compatibility for existing rows while enabling isolation
-- between Shopee, Mercado Livre and Amazon template sets.

UPDATE templates
SET scope = 'shopee'
WHERE scope IS NULL
   OR scope NOT IN ('shopee', 'meli', 'amazon');

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('shopee', 'meli', 'amazon')) NOT VALID;
