-- Migration: Compound indexes for parent-scoped RLS performance at scale.
-- These indexes optimize the EXISTS sub-queries in RLS policies for
-- master_group_links, route_destinations, and scheduled_post_destinations.
-- All statements are idempotent (IF NOT EXISTS).

-- master_groups: RLS EXISTS checks do WHERE user_id=$1 AND id=$2.
-- Existing idx_master_groups_user_id covers (user_id) but not (user_id, id) compound.
CREATE INDEX IF NOT EXISTS idx_master_groups_user_id_id
  ON master_groups(user_id, id);

-- routes: RLS EXISTS checks do WHERE user_id=$1 AND id=$2.
-- Existing idx_routes_user_id covers (user_id) alone.
CREATE INDEX IF NOT EXISTS idx_routes_user_id_id
  ON routes(user_id, id);

-- scheduled_posts: RLS EXISTS checks do WHERE user_id=$1 AND id=$2.
-- Existing idx_sp_user_status covers (user_id, status) but not (user_id, id).
CREATE INDEX IF NOT EXISTS idx_sp_user_id_id
  ON scheduled_posts(user_id, id);

-- groups: Parent-scoped validation checks WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL.
-- Existing idx_groups_active covers (user_id, id) WHERE deleted_at IS NULL — already optimal.
-- No additional index needed.

-- history_entries: Cursor-based pagination index for (user_id, created_at DESC, id).
-- Supports keyset pagination: WHERE user_id=$1 AND (created_at, id) < ($cursor_ts, $cursor_id)
CREATE INDEX IF NOT EXISTS idx_history_cursor
  ON history_entries(user_id, created_at DESC, id DESC);

-- scheduled_posts: Same cursor pagination pattern
CREATE INDEX IF NOT EXISTS idx_sp_cursor
  ON scheduled_posts(user_id, created_at DESC, id DESC);

-- routes: User-scoped list with sort by created_at
CREATE INDEX IF NOT EXISTS idx_routes_cursor
  ON routes(user_id, created_at DESC, id DESC);

-- admin_audit_logs: Compound index for admin list queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_compound
  ON admin_audit_logs(created_at DESC, id DESC);
