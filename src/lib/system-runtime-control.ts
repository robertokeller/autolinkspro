import { loadRuntimeControl, saveRuntimeControl, subscribeLocalDbChanges } from "@/integrations/backend/local-core";

export interface SystemRuntimeControlState {
  enabled: boolean;
  updatedAt: string;
}

function nowIso() {
  return new Date().toISOString();
}

export function loadSystemRuntimeControlState(): SystemRuntimeControlState {
  const { enabled } = loadRuntimeControl();
  return { enabled, updatedAt: nowIso() };
}

export async function saveSystemRuntimeControlState(next: Partial<SystemRuntimeControlState>): Promise<SystemRuntimeControlState> {
  const current = loadRuntimeControl();
  const enabled = next.enabled !== undefined ? next.enabled : current.enabled;
  await saveRuntimeControl({ enabled });
  return { enabled, updatedAt: nowIso() };
}

export function subscribeSystemRuntimeControl(onChange: () => void) {
  return subscribeLocalDbChanges(onChange);
}
