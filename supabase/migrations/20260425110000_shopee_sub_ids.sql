BEGIN;

CREATE TABLE IF NOT EXISTS public.shopee_sub_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  value text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT shopee_sub_ids_value_len_chk
    CHECK (char_length(trim(value)) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS shopee_sub_ids_user_idx
  ON public.shopee_sub_ids (user_id);

CREATE INDEX IF NOT EXISTS shopee_sub_ids_user_default_idx
  ON public.shopee_sub_ids (user_id, is_default, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS shopee_sub_ids_user_value_uq
  ON public.shopee_sub_ids (
    user_id,
    lower(trim(value))
  );

CREATE UNIQUE INDEX IF NOT EXISTS shopee_sub_ids_one_default_per_user_uq
  ON public.shopee_sub_ids (user_id)
  WHERE is_default = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'shopee_sub_ids_updated_at'
  ) THEN
    CREATE TRIGGER shopee_sub_ids_updated_at
      BEFORE UPDATE ON public.shopee_sub_ids
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at();
  END IF;
END
$$;

ALTER TABLE public.shopee_sub_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopee_sub_ids FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_shopee_sub_ids_select_own_or_admin ON public.shopee_sub_ids;
DROP POLICY IF EXISTS p_shopee_sub_ids_insert_own_or_admin ON public.shopee_sub_ids;
DROP POLICY IF EXISTS p_shopee_sub_ids_update_own_or_admin ON public.shopee_sub_ids;
DROP POLICY IF EXISTS p_shopee_sub_ids_delete_own_or_admin ON public.shopee_sub_ids;

CREATE POLICY p_shopee_sub_ids_select_own_or_admin
ON public.shopee_sub_ids
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_shopee_sub_ids_insert_own_or_admin
ON public.shopee_sub_ids
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_shopee_sub_ids_update_own_or_admin
ON public.shopee_sub_ids
FOR UPDATE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin())
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_shopee_sub_ids_delete_own_or_admin
ON public.shopee_sub_ids
FOR DELETE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

COMMIT;
