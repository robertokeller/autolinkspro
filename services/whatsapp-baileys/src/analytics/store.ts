// services/whatsapp-baileys/src/analytics/store.ts

import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import type { GroupEvent, GroupSnapshot } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANALYTICS_ROOT = path.resolve(
  process.env.ANALYTICS_DIR || path.join(__dirname, "../../../.analytics")
);

const EVENTS_DIR = path.join(ANALYTICS_ROOT, "events");
const GROUPS_DIR = path.join(ANALYTICS_ROOT, "groups");

export async function ensureAnalyticsDirs(): Promise<void> {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  await fs.mkdir(GROUPS_DIR, { recursive: true });
}

export async function storeEvent(event: GroupEvent): Promise<void> {
  await ensureAnalyticsDirs();
  const date = event.timestamp.slice(0, 10);
  const file = path.join(EVENTS_DIR, `${date}.jsonl`);
  await fs.appendFile(file, JSON.stringify(event) + "\n", "utf-8");
}

export async function captureSnapshot(snapshot: GroupSnapshot): Promise<void> {
  await ensureAnalyticsDirs();
  const dir = path.join(GROUPS_DIR, snapshot.groupId, "snapshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${snapshot.date}.json`);
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf-8");
}

export async function loadEventsForDays(days: number): Promise<GroupEvent[]> {
  const events: GroupEvent[] = [];
  const today = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(EVENTS_DIR, `${dateStr}.jsonl`);

    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as GroupEvent);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file doesn't exist, skip
    }
  }

  return events;
}

export async function loadAllEvents(): Promise<GroupEvent[]> {
  try {
    await ensureAnalyticsDirs();
    const files = await fs.readdir(EVENTS_DIR);
    const events: GroupEvent[] = [];

    for (const file of files.sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const content = await fs.readFile(path.join(EVENTS_DIR, file), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as GroupEvent);
        } catch {
          // skip
        }
      }
    }

    return events;
  } catch {
    return [];
  }
}

export async function loadSnapshots(groupId: string, days?: number): Promise<GroupSnapshot[]> {
  const dir = path.join(GROUPS_DIR, groupId, "snapshots");
  const snapshots: GroupSnapshot[] = [];

  try {
    const files = await fs.readdir(dir);
    const sorted = files.filter(f => f.endsWith(".json")).sort();

    let filtered = sorted;
    if (days !== undefined) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      filtered = sorted.filter(f => f.replace(".json", "") >= cutoffStr);
    }

    for (const file of filtered) {
      try {
        const content = await fs.readFile(path.join(dir, file), "utf-8");
        snapshots.push(JSON.parse(content) as GroupSnapshot);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // directory doesn't exist
  }

  return snapshots;
}

export async function getLatestSnapshot(groupId: string): Promise<GroupSnapshot | null> {
  const snapshots = await loadSnapshots(groupId);
  if (snapshots.length === 0) return null;
  return snapshots[snapshots.length - 1];
}

export async function getAllGroupIds(): Promise<string[]> {
  try {
    await ensureAnalyticsDirs();
    const entries = await fs.readdir(GROUPS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

export async function getAllLatestSnapshots(): Promise<Map<string, GroupSnapshot>> {
  const groupIds = await getAllGroupIds();
  const result = new Map<string, GroupSnapshot>();

  for (const groupId of groupIds) {
    const snapshot = await getLatestSnapshot(groupId);
    if (snapshot) {
      result.set(groupId, snapshot);
    }
  }

  return result;
}

// ── Movement SQL persistence ─────────────────────────────────────────────────

const API_URL = process.env.API_URL || process.env.INTERNAL_API_URL || "";
const SERVICE_SECRET = process.env.SERVICE_SECRET || "";

/**
 * Persist a granular movement event to the API (which writes to group_member_movements).
 * Fire-and-forget: any error is swallowed so it never disrupts the collector.
 */
export async function persistMovementToSQL(event: GroupEvent & { groupUUID?: string; userId?: string; sessionId?: string }): Promise<void> {
  if (!API_URL || !SERVICE_SECRET) return;

  try {
    const body = JSON.stringify({
      name: "analytics-store-movement",
      groupExternalId: event.groupId,
      groupUUID: event.groupUUID,
      userId: event.userId,
      eventType: event.type,
      memberPhone: event.participantPhone,
      authorPhone: event.authorPhone || "",
      eventTimestamp: event.timestamp,
      sessionId: event.sessionId || null,
    });

    await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-secret": SERVICE_SECRET,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // intentionally silent — movement storage must not block real-time event flow
  }
}
