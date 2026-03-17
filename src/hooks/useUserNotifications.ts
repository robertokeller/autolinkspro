import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";

export interface UserAnnouncementView {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  channel: "bell" | "modal" | "both";
  auto_popup_on_login: boolean;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface UserNotificationItem {
  id: string;
  status: "unread" | "read" | "dismissed";
  read_at: string | null;
  dismissed_at: string | null;
  delivered_at: string;
  announcement: UserAnnouncementView | null;
}

interface UserNotificationsResponse {
  items: UserNotificationItem[];
  unread_count: number;
}

export function useUserNotifications() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["user-notifications"],
    queryFn: async () => {
      const data = await invokeBackendRpc<UserNotificationsResponse>("user-notifications", {
        body: { action: "list", status: "all", limit: 100 },
      });
      return {
        items: Array.isArray(data.items) ? data.items : [],
        unreadCount: Number(data.unread_count || 0),
      };
    },
  });

  useEffect(() => {
    return subscribeLocalDbChanges(() => {
      queryClient.invalidateQueries({ queryKey: ["user-notifications"] });
    });
  }, [queryClient]);

  return {
    items: query.data?.items || [],
    unreadCount: query.data?.unreadCount || 0,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
