import { useEffect, useMemo, useState } from "react";
import {
  loadAdminControlPlaneState,
  saveAdminControlPlaneState,
  subscribeAdminControlPlane,
  type AdminControlPlaneState,
} from "@/lib/admin-control-plane";

export function useAdminControlPlane() {
  const [state, setState] = useState<AdminControlPlaneState>(() => loadAdminControlPlaneState());

  useEffect(() => {
    setState(loadAdminControlPlaneState());
    return subscribeAdminControlPlane(() => {
      setState(loadAdminControlPlaneState());
    });
  }, []);

  const saveState = async (next: AdminControlPlaneState) => {
    const saved = await saveAdminControlPlaneState(next);
    setState(saved);
  };

  const value = useMemo(() => ({ state, saveState }), [state]);
  return value;
}
