import { useMemo } from "react";
import type { Group, MasterGroup } from "@/lib/types";

interface UseSessionScopedGroupsInput {
  sessionId: string;
  groups: Group[];
  masterGroups: MasterGroup[];
  excludeGroupId?: string;
}

export function useSessionScopedGroups({
  sessionId,
  groups,
  masterGroups,
  excludeGroupId,
}: UseSessionScopedGroupsInput) {
  const filteredGroups = useMemo(() => {
    if (!sessionId) return [];
    return groups.filter((group) => group.sessionId === sessionId && group.id !== excludeGroupId);
  }, [sessionId, groups, excludeGroupId]);

  const filteredGroupIds = useMemo(() => new Set(filteredGroups.map((group) => group.id)), [filteredGroups]);

  const filteredMasterGroups = useMemo(() => {
    if (!sessionId) return [];
    return masterGroups.filter((masterGroup) =>
      masterGroup.groupIds.some((groupId) => filteredGroupIds.has(groupId)),
    );
  }, [sessionId, masterGroups, filteredGroupIds]);

  return {
    filteredGroups,
    filteredGroupIds,
    filteredMasterGroups,
  };
}
