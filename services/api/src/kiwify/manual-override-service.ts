import { execute, query, queryOne } from "../db.js";

export interface ManualOverrideUserRow {
  user_id: string;
  name: string;
  email: string;
  plan_id: string;
  plan_expires_at: string | null;
  plan_sync_mode: "manual_override";
  plan_sync_note: string;
  plan_sync_updated_at: string | null;
}

export async function listManualOverrideUsers(input: {
  page?: unknown;
  limit?: unknown;
  search?: unknown;
}): Promise<{
  users: ManualOverrideUserRow[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, Number(input.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const offset = (page - 1) * limit;
  const search = String(input.search ?? "").trim().toLowerCase();

  const filters: string[] = [
    "COALESCE(ur.role, 'user') <> 'admin'",
    "p.plan_sync_mode = 'manual_override'",
  ];
  const values: unknown[] = [];
  let idx = 1;

  if (search) {
    filters.push(
      `(LOWER(u.email) LIKE $${idx} OR LOWER(COALESCE(NULLIF(p.name, ''), u.metadata->>'name', '')) LIKE $${idx})`,
    );
    values.push(`%${search}%`);
    idx++;
  }

  const whereSql = `WHERE ${filters.join(" AND ")}`;
  const rows = await query<ManualOverrideUserRow>(
    `SELECT
        p.user_id,
        COALESCE(NULLIF(p.name, ''), u.metadata->>'name', 'Usuário') AS name,
        u.email,
        COALESCE(p.plan_id, 'plan-starter') AS plan_id,
        p.plan_expires_at,
        p.plan_sync_mode,
        COALESCE(p.plan_sync_note, '') AS plan_sync_note,
        p.plan_sync_updated_at
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN user_roles ur ON ur.user_id = p.user_id
      ${whereSql}
      ORDER BY p.plan_sync_updated_at DESC NULLS LAST, p.updated_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );

  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN user_roles ur ON ur.user_id = p.user_id
      ${whereSql}`,
    values,
  );

  return {
    users: rows,
    total: Number(countRow?.total ?? 0),
    page,
    limit,
  };
}

export async function resumeAutoSyncForUsers(input: {
  userIds: unknown;
  reason?: unknown;
}): Promise<{
  updated: number;
}> {
  const ids = Array.isArray(input.userIds)
    ? input.userIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const dedupIds = Array.from(new Set(ids));
  if (!dedupIds.length) {
    return { updated: 0 };
  }

  const reason = String(input.reason ?? "").trim() || "admin_kiwify_bulk_resume_auto_sync";
  const result = await execute(
    `UPDATE profiles p
        SET plan_sync_mode = 'auto',
            plan_sync_note = $2,
            plan_sync_updated_at = NOW(),
            updated_at = NOW()
      WHERE p.user_id = ANY($1::uuid[])
        AND p.plan_sync_mode = 'manual_override'
        AND NOT EXISTS (
          SELECT 1
          FROM user_roles ur
          WHERE ur.user_id = p.user_id
            AND ur.role = 'admin'
        )`,
    [dedupIds, reason],
  );

  return { updated: Number(result.rowCount ?? 0) };
}

