-- Lista tabelas de usuário com estimativa de linhas e tamanho
-- Execute com: psql "postgresql://user:pass@host:5432/dbname" -f inventory_tables.sql

SELECT
  ps.schemaname,
  ps.relname AS table_name,
  pg_size_pretty(pg_total_relation_size(quote_ident(ps.schemaname) || '.' || quote_ident(ps.relname))) AS total_size,
  ps.n_live_tup AS row_estimate,
  pa.last_vacuum,
  pa.last_autovacuum,
  pa.last_analyze,
  pa.last_autoanalyze
FROM pg_stat_user_tables ps
LEFT JOIN pg_stat_all_tables pa ON ps.relid = pa.relid
ORDER BY ps.n_live_tup ASC, pg_total_relation_size(quote_ident(ps.schemaname) || '.' || quote_ident(ps.relname)) ASC;
