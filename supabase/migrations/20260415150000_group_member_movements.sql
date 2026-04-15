-- Track granular group member movements (join / left / removed) in real-time.
-- One row per participant event. Enables history feed, permanence calculation
-- and recapture automation.

CREATE TABLE IF NOT EXISTS group_member_movements (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id             UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  event_type           TEXT        NOT NULL CHECK (event_type IN ('member_joined', 'member_left', 'member_removed')),
  member_phone         TEXT        NOT NULL DEFAULT '',
  author_phone         TEXT        NOT NULL DEFAULT '',  -- who removed (only for member_removed)
  event_timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- permanence: populated when a matching entry event is found for a leaving member
  time_permanence_minutes INTEGER,
  entry_event_id       UUID        REFERENCES group_member_movements(id) ON DELETE SET NULL,
  -- informational, no FK (matches project pattern from groups.session_id)
  session_id           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to keep updated_at current is not needed for append-only movements.
-- Indexes optimised for the three main access patterns:
-- 1. History feed: order by event within group
CREATE INDEX IF NOT EXISTS idx_group_member_movements_group_time
  ON group_member_movements(group_id, event_timestamp DESC);

-- 2. Global user scoped queries
CREATE INDEX IF NOT EXISTS idx_group_member_movements_user_time
  ON group_member_movements(user_id, event_timestamp DESC);

-- 3. Permanence correlation: find prior join for same phone in same group
CREATE INDEX IF NOT EXISTS idx_group_member_movements_phone_group
  ON group_member_movements(member_phone, group_id, event_type, event_timestamp DESC);

-- 4. Recapture dispatch: filter pending exits that need follow-up
CREATE INDEX IF NOT EXISTS idx_group_member_movements_exits
  ON group_member_movements(group_id, event_type, event_timestamp DESC)
  WHERE event_type IN ('member_left', 'member_removed');

-- RLS is enabled automatically by the trigger from migration 20260410200000.
-- Explicit policies are still required so rows can actually be read/written.
ALTER TABLE public.group_member_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_member_movements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_group_member_movements_select_own_or_admin ON public.group_member_movements;
DROP POLICY IF EXISTS p_group_member_movements_insert_own_or_admin ON public.group_member_movements;
DROP POLICY IF EXISTS p_group_member_movements_update_own_or_admin ON public.group_member_movements;
DROP POLICY IF EXISTS p_group_member_movements_delete_own_or_admin ON public.group_member_movements;

CREATE POLICY p_group_member_movements_select_own_or_admin
ON public.group_member_movements
FOR SELECT
TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_movements.group_id
       AND g.user_id = group_member_movements.user_id
  )
);

CREATE POLICY p_group_member_movements_insert_own_or_admin
ON public.group_member_movements
FOR INSERT
TO authenticated
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_movements.group_id
       AND g.user_id = group_member_movements.user_id
  )
);

CREATE POLICY p_group_member_movements_update_own_or_admin
ON public.group_member_movements
FOR UPDATE
TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_movements.group_id
       AND g.user_id = group_member_movements.user_id
  )
)
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_movements.group_id
       AND g.user_id = group_member_movements.user_id
  )
);

CREATE POLICY p_group_member_movements_delete_own_or_admin
ON public.group_member_movements
FOR DELETE
TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1
      FROM public.groups g
     WHERE g.id = group_member_movements.group_id
       AND g.user_id = group_member_movements.user_id
  )
);
