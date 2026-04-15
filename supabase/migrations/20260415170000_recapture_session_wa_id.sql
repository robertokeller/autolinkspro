-- ── Recapture: add session_wa_id override ────────────────────────────────────
-- Allows choosing which WhatsApp session dispatches the recapture message.
-- NULL means "fall back to the group's own session_id" (existing default behaviour).

ALTER TABLE group_recapture_rules
  ADD COLUMN IF NOT EXISTS session_wa_id UUID
    REFERENCES whatsapp_sessions (id) ON DELETE SET NULL;

COMMENT ON COLUMN group_recapture_rules.session_wa_id IS
  'Override WhatsApp session for recapture dispatch. NULL = use the group''s session.';
