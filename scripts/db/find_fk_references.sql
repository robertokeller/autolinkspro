-- Encontrar chaves estrangeiras que referenciam ou são referenciadas por uma tabela
-- Uso (psql): psql -v tbl='stripe' -f find_fk_references.sql

SELECT
  tc.table_schema AS referencing_schema,
  tc.table_name AS referencing_table,
  kcu.column_name AS referencing_column,
  ccu.table_schema AS referenced_schema,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column,
  tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND (ccu.table_name = :'tbl' OR tc.table_name = :'tbl')
ORDER BY referencing_table, referencing_column;
