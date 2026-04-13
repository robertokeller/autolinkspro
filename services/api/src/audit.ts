// Audit logging for sensitive operations
// Inserts into admin_audit_logs table with structured data

import { execute } from "./db.js";
import { randomUUID } from "node:crypto";

export type AuditAction =
  | "user.created"
  | "user.updated"
  | "user.email_verified"
  | "user.deleted"
  | "user.plan_changed"
  | "user.role_changed"
  | "user.password_reset"
  | "user.email_changed"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "route.created"
  | "route.updated"
  | "route.deleted"
  | "template.created"
  | "template.updated"
  | "template.deleted"
  | "scheduled_post.created"
  | "scheduled_post.updated"
  | "scheduled_post.deleted"
  | "settings.changed"
  | "system.announcement.created"
  | "system.announcement.updated"
  | "system.announcement.deleted"
  | "api_credential.created"
  | "api_credential.updated"
  | "api_credential.deleted"
  | "session.created"
  | "session.failed"
  | "session.revoked"
  | "webhook.received"
  | "integration.sync"
  | "file.uploaded"
  | "file.deleted";

interface AuditLogEntry {
  action: AuditAction;
  actor_user_id?: string; // who performed the action (null for system)
  target_user_id?: string; // who the action affects (if different from actor)
  resource_type?: string; // e.g., "user", "group", "route"
  resource_id?: string; // UUID of the resource
  details?: Record<string, unknown>; // additional context
  ip_address?: string;
  user_agent?: string;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    const detailsPayload: Record<string, unknown> = entry.details && typeof entry.details === "object"
      ? { ...entry.details }
      : {};

    if (entry.actor_user_id) detailsPayload.actor_user_id = entry.actor_user_id;
    if (entry.resource_type) detailsPayload.resource_type = entry.resource_type;
    if (entry.resource_id) detailsPayload.resource_id = entry.resource_id;
    if (entry.ip_address) detailsPayload.ip_address = entry.ip_address;
    if (entry.user_agent) detailsPayload.user_agent = entry.user_agent;

    await execute(
      `INSERT INTO admin_audit_logs (
        id, user_id, action, target_user_id, details, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, NOW()
      )`,
      [
        globalThis.crypto?.randomUUID?.() || randomUUID(),
        entry.actor_user_id ?? null,
        entry.action,
        entry.target_user_id ?? null,
        JSON.stringify(detailsPayload),
      ]
    );
  } catch (error) {
    // Audit failures should NOT break the main operation.
    // Log to console for visibility but don't throw.
    console.error("[audit] Failed to write audit log:", error instanceof Error ? error.message : String(error));
  }
}

// Helper to get IP address from request
export function getRequestIp(req: { ip?: string; connection?: { remoteAddress?: string } }): string | undefined {
  return req.ip ?? req.connection?.remoteAddress;
}

// Helper to get user agent
export function getUserAgent(req: { headers?: { "user-agent"?: string } }): string | undefined {
  return req.headers?.["user-agent"];
}
