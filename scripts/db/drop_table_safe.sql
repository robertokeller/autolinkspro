-- Template safe DROP (edit table name before executing)
-- Example: replace <TABLE> with stripe and run with psql

BEGIN;
-- DROP TABLE IF EXISTS public.<TABLE> CASCADE;
COMMIT;
