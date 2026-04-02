-- Migration 015: Scalability indexes — fill gaps found during scale audit
-- All statements are idempotent (IF NOT EXISTS).

-- templates: ownership checks currently scan all records without index.
-- Used by REST generic queries and RPC ownership validation.
CREATE INDEX IF NOT EXISTS idx_templates_user_id
  ON templates(user_id);

-- api_credentials: REST ownership validation scans the table.
CREATE INDEX IF NOT EXISTS idx_api_credentials_user_id
  ON api_credentials(user_id);

-- route_destinations: cascading deletes + dispatch-messages join.
-- Without this, every route delete triggers a sequential scan.
CREATE INDEX IF NOT EXISTS idx_route_destinations_route_id
  ON route_destinations(route_id);

-- route_destinations: route validation queries that check group membership.
CREATE INDEX IF NOT EXISTS idx_route_destinations_group_id
  ON route_destinations(group_id);

-- scheduled_post_destinations: post-to-group lookups during dispatch.
CREATE INDEX IF NOT EXISTS idx_spd_group_id
  ON scheduled_post_destinations(group_id);

-- history_entries: automation-run deduplication queries do
--   WHERE user_id=$1 AND type='automation_run' AND processing_status='sent'
--   ORDER BY created_at DESC LIMIT 200
-- The existing idx_history_user_created covers (user_id, created_at DESC) but
-- forces a filter on type+status after scan. This composite partial index lets
-- Postgres jump directly to the relevant rows.
CREATE INDEX IF NOT EXISTS idx_history_automation_recent
  ON history_entries(user_id, created_at DESC)
  WHERE type = 'automation_run' AND processing_status = 'sent';
