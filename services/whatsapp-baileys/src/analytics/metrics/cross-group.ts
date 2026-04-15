// services/whatsapp-baileys/src/analytics/metrics/cross-group.ts

import { getAllLatestSnapshots } from "../store.js";
import type { CrossGroupMetrics } from "../types.js";

export async function calculateCrossGroup(): Promise<CrossGroupMetrics> {
  const snapshots = await getAllLatestSnapshots();

  if (snapshots.size === 0) {
    return createEmptyCrossGroup();
  }

  // Map each phone to the groups they're in
  const memberGroups = new Map<string, Set<string>>();

  for (const [groupId, snapshot] of snapshots.entries()) {
    for (const member of snapshot.members) {
      if (!memberGroups.has(member.phone)) {
        memberGroups.set(member.phone, new Set());
      }
      memberGroups.get(member.phone)!.add(groupId);
    }
  }

  const totalUnique = memberGroups.size;
  const overlapping: CrossGroupMetrics["overlapDetails"] = [];
  let exclusiveCount = 0;

  for (const [phone, groups] of memberGroups.entries()) {
    if (groups.size > 1) {
      overlapping.push({
        phone,
        groups: Array.from(groups),
        groupCount: groups.size,
      });
    } else {
      exclusiveCount += 1;
    }
  }

  overlapping.sort((a, b) => b.groupCount - a.groupCount);

  return {
    totalUniqueMembers: totalUnique,
    overlappingMembers: overlapping.length,
    overlappingPercent: parseFloat(
      ((overlapping.length / Math.max(totalUnique, 1)) * 100).toFixed(1)
    ),
    overlapDetails: overlapping.slice(0, 100),
    exclusiveMembers: exclusiveCount,
  };
}

function createEmptyCrossGroup(): CrossGroupMetrics {
  return {
    totalUniqueMembers: 0,
    overlappingMembers: 0,
    overlappingPercent: 0,
    overlapDetails: [],
    exclusiveMembers: 0,
  };
}
