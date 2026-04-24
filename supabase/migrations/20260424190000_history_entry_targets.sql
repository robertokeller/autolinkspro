-- Parent-child history model: keep one parent entry in history_entries
-- and store per-destination details in history_entry_targets.

CREATE TABLE IF NOT EXISTS public.history_entry_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_entry_id UUID NOT NULL REFERENCES public.history_entries(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  destination_group_id UUID,
  destination TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'info',
  processing_status TEXT NOT NULL DEFAULT 'processed',
  block_reason TEXT NOT NULL DEFAULT '',
  error_step TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'text',
  send_order INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS history_entry_targets_entry_idx
  ON public.history_entry_targets (history_entry_id, send_order, created_at);

CREATE INDEX IF NOT EXISTS history_entry_targets_user_created_idx
  ON public.history_entry_targets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS history_entry_targets_user_processing_idx
  ON public.history_entry_targets (user_id, processing_status, created_at DESC);

ALTER TABLE public.history_entry_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history_entry_targets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_select_own_or_admin ON public.history_entry_targets;
DROP POLICY IF EXISTS p_insert_own_or_admin ON public.history_entry_targets;
DROP POLICY IF EXISTS p_update_own_or_admin ON public.history_entry_targets;
DROP POLICY IF EXISTS p_delete_own_or_admin ON public.history_entry_targets;

CREATE POLICY p_select_own_or_admin
ON public.history_entry_targets
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_insert_own_or_admin
ON public.history_entry_targets
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_update_own_or_admin
ON public.history_entry_targets
FOR UPDATE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin())
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_delete_own_or_admin
ON public.history_entry_targets
FOR DELETE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());