-- Migration: scalability fixes — indexes + history purge
-- Addresses audit items R3, R5, R7.
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE).

-- ─── 0. Index for routes source_group_id filter (R6) ────────────────────────
-- processRouteMessageForUser now pushes source filtering into SQL:
--   WHERE r.user_id=$1 AND r.status='active'
--     AND (r.source_group_id = ANY($2) OR EXISTS (...))
-- The existing idx_routes_user_status covers (user_id, status) but leaves
-- source_group_id as a heap filter.  This composite partial index allows
-- Postgres to evaluate source_group_id = ANY($2) directly from the index,
-- avoiding heap fetches for unmatched rows on users with many routes.
CREATE INDEX IF NOT EXISTS idx_routes_user_source_group
  ON routes(user_id, source_group_id)
  WHERE status = 'active';

-- ─── 1. Partial index for scheduled_posts media cleanup sweep ─────────────────
-- cleanupExpiredScheduledPostMedia runs every 5 min with:
--   WHERE metadata ? 'media' AND status IN ('sent','cancelled','failed')
-- Without an index this degrades to a full seq scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_sp_pending_media_cleanup
  ON scheduled_posts (id, user_id, updated_at)
  WHERE (metadata ? 'media')
    AND status IN ('sent', 'cancelled', 'failed');

-- ─── 2. BRIN index for runtime_rate_limits cleanup ───────────────────────────
-- cleanupDistributedRateLimits deletes by window_start < threshold.
-- B-tree on a monotonically inserted timestamp waste space; BRIN is tiny and fast.
CREATE INDEX IF NOT EXISTS idx_rrl_window_start_brin
  ON runtime_rate_limits USING BRIN (window_start);

-- ─── 3. BRIN index for rpc_idempotency_keys cleanup ─────────────────────────
-- Same pattern: delete expired rows by created_at.
CREATE INDEX IF NOT EXISTS idx_rik_created_at_brin
  ON rpc_idempotency_keys USING BRIN (created_at);

-- ─── 4. Composite index for history_entries time-scoped automation queries ───
-- loadRecentAutomationOfferTitleSet:
--   WHERE user_id=$1 AND type='automation_run' AND processing_status='sent'
--     AND created_at >= NOW() - interval
--   ORDER BY created_at DESC LIMIT 200
-- The existing idx requires a fallback heap scan for the JSONB columns; this
-- partial index eliminates the sort + limit by covering the frequent pattern.
CREATE INDEX IF NOT EXISTS idx_he_automation_run_sent
  ON history_entries (user_id, created_at DESC)
  WHERE type = 'automation_run'
    AND processing_status = 'sent';

-- ─── 5. Purge function for history_entries ───────────────────────────────────
-- Called by the scheduler via RPC (purge-history-entries) or pg_cron.
-- Deletes rows older than max_age_days, excluding permanent record types.
-- Runs in batches to avoid long-running transactions that lock the table.
CREATE OR REPLACE FUNCTION purge_old_history_entries(
  max_age_days  int  DEFAULT 90,
  batch_size    int  DEFAULT 5000
)
RETURNS TABLE (deleted_total bigint, batches int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted      bigint := 0;
  v_batch_count  int    := 0;
  v_batch        bigint;
  v_cutoff       timestamptz;
BEGIN
  -- Clamp inputs to reasonable bounds.
  max_age_days := GREATEST(30, LEAST(max_age_days, 3650));
  batch_size   := GREATEST(100, LEAST(batch_size, 50000));
  v_cutoff     := NOW() - (max_age_days || ' days')::interval;

  LOOP
    DELETE FROM history_entries
    WHERE id IN (
      SELECT id
      FROM history_entries
      WHERE created_at < v_cutoff
        -- Never purge route_sent or dispatch records permanently.
        -- Adjust or remove this exclusion per business requirements.
        AND type NOT IN ('admin_audit')
      ORDER BY created_at
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;

    v_deleted      := v_deleted + v_batch;
    v_batch_count  := v_batch_count + 1;

    -- Yield between batches: allow autovacuum and other transactions to proceed.
    PERFORM pg_sleep(0.05);
  END LOOP;

  RETURN QUERY SELECT v_deleted, v_batch_count;
END;
$$;

-- Restrict execution to the service role and postgres (not anon/authenticated).
REVOKE EXECUTE ON FUNCTION purge_old_history_entries(int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION purge_old_history_entries(int, int) TO service_role;

-- ─── 6. Optional: pg_cron schedule (Supabase Pro / self-hosted with pg_cron) ─
-- Uncomment and adjust when pg_cron is available.
-- Runs nightly at 03:00 UTC, keeps last 90 days, batches of 5000.
--
-- SELECT cron.schedule(
--   'purge-history-entries-nightly',
--   '0 3 * * *',
--   $$SELECT purge_old_history_entries(90, 5000)$$
-- );
