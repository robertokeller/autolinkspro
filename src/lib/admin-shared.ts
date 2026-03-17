import { backend } from "@/integrations/backend/client";
import { LOCAL_DB_UPDATED_EVENT } from "@/integrations/backend/local-core";

export async function appendAdminAudit(action: string, details: Record<string, unknown>) {
  const { data } = await backend.auth.getSession();
  const actorId = data.session?.user?.id;
  if (!actorId) return;

  await backend.from("admin_audit_logs").insert({
    user_id: actorId,
    action,
    target_user_id: null,
    details,
  });
}

export function triggerGlobalResyncPulse(source: string) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(LOCAL_DB_UPDATED_EVENT, {
    detail: { at: new Date().toISOString(), source },
  }));
}
