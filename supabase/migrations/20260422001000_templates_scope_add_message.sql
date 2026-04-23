-- Migration: add dedicated scope for /modelos message templates.
-- Keeps the existing templates table and RLS model, adding only enum parity.

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('shopee', 'meli', 'amazon', 'message')) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_templates_user_scope_created_at
  ON templates(user_id, scope, created_at DESC);
