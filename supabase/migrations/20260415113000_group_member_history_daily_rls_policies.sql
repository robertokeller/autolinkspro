-- Ensure tenant-safe RLS policies for group_member_history_daily.
-- The table is created after the global auto-RLS trigger, so policies must
-- be declared explicitly or all writes fail with "row-level security policy".

ALTER TABLE public.group_member_history_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_member_history_daily FORCE ROW LEVEL SECURITY;

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
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_history_daily.group_id
       AND g.user_id = group_member_history_daily.user_id
  )
);

CREATE POLICY p_group_member_history_daily_insert_own_or_admin
ON public.group_member_history_daily
FOR INSERT
TO authenticated
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_history_daily.group_id
       AND g.user_id = group_member_history_daily.user_id
  )
);

CREATE POLICY p_group_member_history_daily_update_own_or_admin
ON public.group_member_history_daily
FOR UPDATE
TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_history_daily.group_id
       AND g.user_id = group_member_history_daily.user_id
  )
)
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_history_daily.group_id
       AND g.user_id = group_member_history_daily.user_id
  )
);

CREATE POLICY p_group_member_history_daily_delete_own_or_admin
ON public.group_member_history_daily
FOR DELETE
TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_history_daily.group_id
       AND g.user_id = group_member_history_daily.user_id
  )
);
