-- Migration: Strengthen templates table constraints for sync integrity
-- Adds category CHECK constraint (enum parity with frontend/API) and
-- a partial index to speed up the "fetch default template per user/scope" query.

-- Category enum constraint (matches TemplateCategory type in types.ts and templateSchema in validations.ts)
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_category_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_category_check
  CHECK (category IN ('oferta', 'cupom', 'geral')) NOT VALID;

-- Scope enum constraint already exists (013 + 20260402170500); refresh to ensure amazon is included
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('shopee', 'meli', 'amazon')) NOT VALID;

-- Partial index: fast lookup for "is there a default for user+scope?"
-- Used by useTemplates (defaultTemplate memo) and TemplateModuleContext (applyTemplate fallback)
CREATE INDEX IF NOT EXISTS idx_templates_user_scope_is_default
  ON templates(user_id, scope)
  WHERE is_default = TRUE;
