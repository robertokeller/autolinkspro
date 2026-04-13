import { execute, queryOne } from "./db.js";

export type PlanSyncMode = "auto" | "manual_override";

export interface PlanSyncState {
  mode: PlanSyncMode;
  note: string;
  updated_at: string | null;
}

export async function getPlanSyncState(userId: string): Promise<PlanSyncState> {
  const row = await queryOne<{ plan_sync_mode: string | null; plan_sync_note: string | null; plan_sync_updated_at: string | null }>(
    `SELECT plan_sync_mode, plan_sync_note, plan_sync_updated_at
       FROM profiles
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );

  const mode = String(row?.plan_sync_mode ?? "auto").trim() === "manual_override"
    ? "manual_override"
    : "auto";

  return {
    mode,
    note: String(row?.plan_sync_note ?? "").trim(),
    updated_at: row?.plan_sync_updated_at ?? null,
  };
}

export async function isManualPlanOverride(userId: string): Promise<boolean> {
  const state = await getPlanSyncState(userId);
  return state.mode === "manual_override";
}

async function setPlanSyncMode(userId: string, mode: PlanSyncMode, note: string): Promise<void> {
  await execute(
    `UPDATE profiles
        SET plan_sync_mode = $1,
            plan_sync_note = $2,
            plan_sync_updated_at = NOW(),
            updated_at = NOW()
      WHERE user_id = $3`,
    [mode, note, userId],
  );
}

export async function setManualPlanOverride(userId: string, reason: string): Promise<void> {
  const note = String(reason || "").trim() || "admin_manual_override";
  await setPlanSyncMode(userId, "manual_override", note);
}

export async function setAutoPlanSync(userId: string, reason: string): Promise<void> {
  const note = String(reason || "").trim() || "admin_auto_sync";
  await setPlanSyncMode(userId, "auto", note);
}

