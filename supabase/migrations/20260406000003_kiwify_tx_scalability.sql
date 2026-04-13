-- Migration 20260406000003: kiwify_transactions scalability indexes
-- Addresses paginated admin list query that sorts by created_at after filtering by user_id.
-- The existing kiwify_tx_user_id_idx covers user_id lookups but forces an in-memory sort
-- for ORDER BY created_at DESC. This composite index lets Postgres return rows in order
-- directly from the index, eliminating the sort step for the common admin list case.

-- Admin paginated list: SELECT * FROM kiwify_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT X OFFSET X
CREATE INDEX IF NOT EXISTS kiwify_tx_user_created_idx
  ON kiwify_transactions (user_id, created_at DESC);

-- Admin list without user filter (full list sorted by date): ORDER BY created_at DESC
-- Also benefits the daily reconciler which scans recent transactions.
CREATE INDEX IF NOT EXISTS kiwify_tx_created_idx
  ON kiwify_transactions (created_at DESC);

-- Admin search by customer_email uses LOWER(customer_email) LIKE $n.
-- The plain kiwify_tx_customer_email_idx cannot be used because of the LOWER() wrap.
-- A functional expression index on LOWER(customer_email) allows Postgres to satisfy
-- the predicate directly from the index instead of scanning the full table.
CREATE INDEX IF NOT EXISTS kiwify_tx_customer_email_lower_idx
  ON kiwify_transactions (LOWER(customer_email));
