-- Improve route counter/history scans under load.
-- Matches frequent filter: user + type=route_forward + processing_status=sent.
CREATE INDEX IF NOT EXISTS idx_history_route_sent_user_created
  ON history_entries(user_id, created_at DESC)
  WHERE type = 'route_forward' AND processing_status = 'sent';
