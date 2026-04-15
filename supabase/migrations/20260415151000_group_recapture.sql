-- Recapture automation: stores per-group rules and the outbox of scheduled messages
-- for members who left. Workers poll group_recapture_queue to dispatch via WhatsApp.

-- ── Recapture rules ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_recapture_rules (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id         UUID    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  delay_hours      INTEGER NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),
  message_template TEXT    NOT NULL DEFAULT '',
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id)  -- one rule per group
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_recapture_rules_updated_at') THEN
    CREATE TRIGGER group_recapture_rules_updated_at
    BEFORE UPDATE ON group_recapture_rules
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_group_recapture_rules_user
  ON group_recapture_rules(user_id);

-- ── Recapture queue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_recapture_queue (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id     UUID    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  movement_id  UUID    NOT NULL REFERENCES group_member_movements(id) ON DELETE CASCADE,
  rule_id      UUID    NOT NULL REFERENCES group_recapture_rules(id) ON DELETE CASCADE,
  member_phone TEXT    NOT NULL DEFAULT '',
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message TEXT   NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker polling: pending items due right now
CREATE INDEX IF NOT EXISTS idx_group_recapture_queue_pending
  ON group_recapture_queue(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_group_recapture_queue_group_status
  ON group_recapture_queue(group_id, status, scheduled_at DESC);

-- ── RLS: group_recapture_rules ────────────────────────────────────────────────
ALTER TABLE public.group_recapture_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_recapture_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_group_recapture_rules_select_own_or_admin ON public.group_recapture_rules;
DROP POLICY IF EXISTS p_group_recapture_rules_insert_own_or_admin ON public.group_recapture_rules;
DROP POLICY IF EXISTS p_group_recapture_rules_update_own_or_admin ON public.group_recapture_rules;
DROP POLICY IF EXISTS p_group_recapture_rules_delete_own_or_admin ON public.group_recapture_rules;

CREATE POLICY p_group_recapture_rules_select_own_or_admin
ON public.group_recapture_rules FOR SELECT TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_rules.group_id
       AND g.user_id = group_recapture_rules.user_id
  )
);

CREATE POLICY p_group_recapture_rules_insert_own_or_admin
ON public.group_recapture_rules FOR INSERT TO authenticated
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_rules.group_id
       AND g.user_id = group_recapture_rules.user_id
  )
);

CREATE POLICY p_group_recapture_rules_update_own_or_admin
ON public.group_recapture_rules FOR UPDATE TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_rules.group_id
       AND g.user_id = group_recapture_rules.user_id
  )
)
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_rules.group_id
       AND g.user_id = group_recapture_rules.user_id
  )
);

CREATE POLICY p_group_recapture_rules_delete_own_or_admin
ON public.group_recapture_rules FOR DELETE TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_rules.group_id
       AND g.user_id = group_recapture_rules.user_id
  )
);

-- ── RLS: group_recapture_queue ────────────────────────────────────────────────
ALTER TABLE public.group_recapture_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_recapture_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_group_recapture_queue_select_own_or_admin ON public.group_recapture_queue;
DROP POLICY IF EXISTS p_group_recapture_queue_insert_own_or_admin ON public.group_recapture_queue;
DROP POLICY IF EXISTS p_group_recapture_queue_update_own_or_admin ON public.group_recapture_queue;
DROP POLICY IF EXISTS p_group_recapture_queue_delete_own_or_admin ON public.group_recapture_queue;

CREATE POLICY p_group_recapture_queue_select_own_or_admin
ON public.group_recapture_queue FOR SELECT TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_queue.group_id
       AND g.user_id = group_recapture_queue.user_id
  )
);

CREATE POLICY p_group_recapture_queue_insert_own_or_admin
ON public.group_recapture_queue FOR INSERT TO authenticated
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_queue.group_id
       AND g.user_id = group_recapture_queue.user_id
  )
);

CREATE POLICY p_group_recapture_queue_update_own_or_admin
ON public.group_recapture_queue FOR UPDATE TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_queue.group_id
       AND g.user_id = group_recapture_queue.user_id
  )
)
WITH CHECK (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_queue.group_id
       AND g.user_id = group_recapture_queue.user_id
  )
);

CREATE POLICY p_group_recapture_queue_delete_own_or_admin
ON public.group_recapture_queue FOR DELETE TO authenticated
USING (
  (user_id = app_current_user_id() OR app_is_admin())
  AND EXISTS (
    SELECT 1 FROM public.groups g
     WHERE g.id = group_recapture_queue.group_id
       AND g.user_id = group_recapture_queue.user_id
  )
);
