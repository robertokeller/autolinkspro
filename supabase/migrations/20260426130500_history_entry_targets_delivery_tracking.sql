-- Track provider-level outbound delivery acknowledgements without changing
-- existing processing_status semantics.

ALTER TABLE public.history_entry_targets
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_error TEXT,
  ADD COLUMN IF NOT EXISTS delivery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS history_entry_targets_user_platform_provider_msg_idx
  ON public.history_entry_targets (user_id, platform, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND provider_message_id <> '';

CREATE INDEX IF NOT EXISTS history_entry_targets_user_delivery_status_created_idx
  ON public.history_entry_targets (user_id, delivery_status, created_at DESC)
  WHERE delivery_status IS NOT NULL AND delivery_status <> '';

COMMENT ON COLUMN public.history_entry_targets.provider_message_id
  IS 'Provider message id returned by outbound connector (Baileys/Telegram).';

COMMENT ON COLUMN public.history_entry_targets.delivery_status
  IS 'Outbound delivery state (accepted, pending, server_ack, delivered, read, played, failed).';

COMMENT ON COLUMN public.history_entry_targets.delivery_metadata
  IS 'Raw delivery telemetry (ack code, provider status, source event payload).';
