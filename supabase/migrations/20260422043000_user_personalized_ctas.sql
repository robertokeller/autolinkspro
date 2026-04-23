BEGIN;

CREATE TABLE IF NOT EXISTS public.user_personalized_ctas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  phrase text NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT user_personalized_ctas_phrase_len_chk
    CHECK (char_length(trim(phrase)) BETWEEN 3 AND 280)
);

CREATE INDEX IF NOT EXISTS user_personalized_ctas_user_idx
  ON public.user_personalized_ctas (user_id);

CREATE INDEX IF NOT EXISTS user_personalized_ctas_user_active_idx
  ON public.user_personalized_ctas (user_id, is_active, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS user_personalized_ctas_user_phrase_uq
  ON public.user_personalized_ctas (
    user_id,
    lower(regexp_replace(trim(phrase), '\\s+', ' ', 'g'))
  );

ALTER TABLE public.user_personalized_ctas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_personalized_ctas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_personalized_ctas_select_own_or_admin ON public.user_personalized_ctas;
DROP POLICY IF EXISTS p_user_personalized_ctas_insert_own_or_admin ON public.user_personalized_ctas;
DROP POLICY IF EXISTS p_user_personalized_ctas_update_own_or_admin ON public.user_personalized_ctas;
DROP POLICY IF EXISTS p_user_personalized_ctas_delete_own_or_admin ON public.user_personalized_ctas;

CREATE POLICY p_user_personalized_ctas_select_own_or_admin
ON public.user_personalized_ctas
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_personalized_ctas_insert_own_or_admin
ON public.user_personalized_ctas
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_personalized_ctas_update_own_or_admin
ON public.user_personalized_ctas
FOR UPDATE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin())
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_personalized_ctas_delete_own_or_admin
ON public.user_personalized_ctas
FOR DELETE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

COMMIT;
