import { backend } from "@/integrations/backend/client";
import { broadcastLocalDbChange } from "@/integrations/backend/local-core";

export async function appendAdminAudit(
  action: string,
  details: Record<string, unknown>,
  options?: { status?: "success" | "error" | "warning"; error?: string },
) {
  const { data } = await backend.auth.getSession();
  const actorId = data.session?.user?.id;
  if (!actorId) return;

  await backend.from("admin_audit_logs").insert({
    user_id: actorId,
    action,
    target_user_id: null,
    details: options?.error
      ? { ...details, _status: options.status ?? "error", _error: options.error }
      : options?.status && options.status !== "success"
        ? { ...details, _status: options.status }
        : details,
  });
}

/** Fires LOCAL_DB_UPDATED_EVENT in this tab AND broadcasts to all other tabs via BroadcastChannel. */
export function triggerGlobalResyncPulse(_source: string) {
  broadcastLocalDbChange();
}
