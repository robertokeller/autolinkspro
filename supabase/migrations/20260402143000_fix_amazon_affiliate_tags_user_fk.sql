-- Align amazon_affiliate_tags.user_id with the application's custom auth model.
--
-- Root cause:
--   The app authenticates against public.users via the self-hosted API.
--   amazon_affiliate_tags was the only user-owned table referencing auth.users,
--   causing inserts to fail with FK violations when the backend forced user_id
--   from the authenticated JWT subject.
--
-- Fix:
--   Repoint the foreign key from auth.users(id) to public.users(id), matching
--   every other user-scoped table in this schema.

DO $$
DECLARE
  existing_fk_name text;
BEGIN
  SELECT tc.constraint_name
    INTO existing_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
   WHERE tc.table_schema = 'public'
     AND tc.table_name = 'amazon_affiliate_tags'
     AND tc.constraint_type = 'FOREIGN KEY'
     AND kcu.column_name = 'user_id'
   LIMIT 1;

  IF existing_fk_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.amazon_affiliate_tags DROP CONSTRAINT %I',
      existing_fk_name
    );
  END IF;
END $$;

ALTER TABLE public.amazon_affiliate_tags
  ADD CONSTRAINT amazon_affiliate_tags_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.users(id)
  ON DELETE CASCADE;
