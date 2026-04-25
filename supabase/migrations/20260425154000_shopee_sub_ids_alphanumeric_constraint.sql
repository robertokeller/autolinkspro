BEGIN;

ALTER TABLE public.shopee_sub_ids
  DROP CONSTRAINT IF EXISTS shopee_sub_ids_value_alnum_chk;

ALTER TABLE public.shopee_sub_ids
  ADD CONSTRAINT shopee_sub_ids_value_alnum_chk
  CHECK (trim(value) ~ '^[A-Za-z0-9]{1,80}$') NOT VALID;

COMMIT;
