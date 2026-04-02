-- Migration 002: Performance indexes for hot query paths
-- These indexes prevent full table scans on tables accessed every 30-60 seconds
-- by background workers (dispatch-messages, poll_events) and frequently by users.

-- scheduled_posts: dispatch-messages queries status='pending' every 45s
CREATE INDEX IF NOT EXISTS idx_sp_status_scheduled_at
  ON scheduled_posts(status, scheduled_at)
  WHERE status = 'pending';

-- groups: session-scoped queries (sync_groups, route_destinations)
CREATE INDEX IF NOT EXISTS idx_groups_session_id
  ON groups(session_id);

-- groups: user-scoped queries are frequent across all group operations
CREATE INDEX IF NOT EXISTS idx_groups_user_id
  ON groups(user_id);

-- history_entries: dashboard history queries ordered by date per user
CREATE INDEX IF NOT EXISTS idx_history_user_created
  ON history_entries(user_id, created_at DESC);

-- user_notifications: per-user unread count checked on every page load
CREATE INDEX IF NOT EXISTS idx_notif_user_status
  ON user_notifications(user_id, status);

-- user_notifications: per-announcement queries in deliverAnnouncement
CREATE INDEX IF NOT EXISTS idx_notif_announcement
  ON user_notifications(announcement_id);

-- whatsapp_sessions / telegram_sessions: status polling
CREATE INDEX IF NOT EXISTS idx_wa_sessions_user
  ON whatsapp_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_tg_sessions_user
  ON telegram_sessions(user_id, status);

-- admin_audit_logs: admin audit list (ORDER BY created_at DESC LIMIT 50)
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON admin_audit_logs(created_at DESC);

-- scheduled_post_destinations: join with scheduled_posts in dispatch-messages
CREATE INDEX IF NOT EXISTS idx_spd_post_id
  ON scheduled_post_destinations(post_id);

-- master_group_links: looked up by master_group_id in dispatch + link-hub
CREATE INDEX IF NOT EXISTS idx_mgl_master_group_id
  ON master_group_links(master_group_id);
