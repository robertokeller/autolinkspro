-- Repair/reenforce RLS policies for group_member_history_daily.
-- Idempotent migration to recover environments where policies were dropped
-- or where earlier policy migrations were not applied.

ALTER TABLE public.group_member_history_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_member_history_daily FORCE ROW LEVEL SECURITY;

-- Remove any legacy generic policy names to avoid ambiguous policy sets.
DROP POLICY IF EXISTS p_select_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_insert_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_update_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_delete_own_or_admin ON public.group_member_history_daily;

DROP POLICY IF EXISTS p_group_member_history_daily_select_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_group_member_history_daily_insert_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_group_member_history_daily_update_own_or_admin ON public.group_member_history_daily;
DROP POLICY IF EXISTS p_group_member_history_daily_delete_own_or_admin ON public.group_member_history_daily;

CREATE POLICY p_group_member_history_daily_select_own_or_admin
ON public.group_member_history_daily
FOR SELECT
TO authenticated
USING (
  app_is_admin()
  OR (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id = group_member_history_daily.group_id
        AND g.user_id = group_member_history_daily.user_id
        AND g.deleted_at IS NULL
    )
  )
);

CREATE POLICY p_group_member_history_daily_insert_own_or_admin
ON public.group_member_history_daily
FOR INSERT
TO authenticated
WITH CHECK (
  app_is_admin()
  OR (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id = group_member_history_daily.group_id
        AND g.user_id = group_member_history_daily.user_id
        AND g.deleted_at IS NULL
    )
  )
);

CREATE POLICY p_group_member_history_daily_update_own_or_admin
ON public.group_member_history_daily
FOR UPDATE
TO authenticated
USING (
  app_is_admin()
  OR (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id = group_member_history_daily.group_id
        AND g.user_id = group_member_history_daily.user_id
        AND g.deleted_at IS NULL
    )
  )
)
WITH CHECK (
  app_is_admin()
  OR (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id = group_member_history_daily.group_id
        AND g.user_id = group_member_history_daily.user_id
        AND g.deleted_at IS NULL
    )
  )
);

CREATE POLICY p_group_member_history_daily_delete_own_or_admin
ON public.group_member_history_daily
FOR DELETE
TO authenticated
USING (
  app_is_admin()
  OR (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id = group_member_history_daily.group_id
        AND g.user_id = group_member_history_daily.user_id
        AND g.deleted_at IS NULL
    )
  )
);
