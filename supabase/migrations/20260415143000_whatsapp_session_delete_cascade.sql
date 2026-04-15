-- Ensure WhatsApp session deletion removes all related collected data.
-- This applies even when the session row is deleted outside the app flow.

CREATE OR REPLACE FUNCTION cleanup_whatsapp_session_related_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Routes keep source_group_id as text (no FK), so we clear stale sources explicitly.
  UPDATE routes r
     SET source_group_id = '',
         status = CASE WHEN r.status = 'active' THEN 'inactive' ELSE r.status END,
         updated_at = NOW()
   WHERE r.user_id = OLD.user_id
     AND r.source_group_id IN (
       SELECT g.id::text
         FROM groups g
        WHERE g.user_id = OLD.user_id
          AND g.platform = 'whatsapp'
          AND g.session_id = OLD.id
     );

  -- Remove automation session scope when it points to the deleted session.
  UPDATE shopee_automations sa
     SET session_id = NULL,
         config = CASE
           WHEN jsonb_typeof(sa.config) = 'object' THEN sa.config - 'deliverySessionId'
           ELSE sa.config
         END,
         updated_at = NOW()
   WHERE sa.user_id = OLD.user_id
     AND (
       sa.session_id = OLD.id
       OR COALESCE(sa.config->>'deliverySessionId', '') = OLD.id::text
     );

  -- Remove history rows tied to the deleted session id.
  DELETE FROM history_entries h
   WHERE h.user_id = OLD.user_id
     AND (
       COALESCE(h.details->>'sessionId', '') = OLD.id::text
       OR COALESCE(h.details->>'sourceSessionId', '') = OLD.id::text
       OR COALESCE(h.details->>'destinationSessionId', '') = OLD.id::text
       OR COALESCE(h.details->>'deliverySessionId', '') = OLD.id::text
     );

  -- Remove all WhatsApp groups owned by this session.
  -- Child tables with FK to groups are automatically cleaned by ON DELETE CASCADE.
  DELETE FROM groups g
   WHERE g.user_id = OLD.user_id
     AND g.platform = 'whatsapp'
     AND g.session_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_sessions_delete_cleanup ON whatsapp_sessions;

CREATE TRIGGER whatsapp_sessions_delete_cleanup
AFTER DELETE ON whatsapp_sessions
FOR EACH ROW
EXECUTE FUNCTION cleanup_whatsapp_session_related_data();
