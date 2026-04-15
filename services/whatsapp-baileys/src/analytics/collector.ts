// services/whatsapp-baileys/src/analytics/collector.ts

import type { SessionState } from "../server.js";
import type { WASocket } from "@whiskeysockets/baileys";
import { storeEvent, captureSnapshot, persistMovementToSQL } from "./store.js";
import {
  extractPhoneFromJid,
  getMemberDDD,
  normalizePhoneCandidate,
  dddToState,
} from "./ddd-to-state.js";
import type { GroupEvent, GroupSnapshot } from "./types.js";
import pino from "pino";
import type { GroupParticipant } from "@whiskeysockets/baileys";

const logger = pino({ level: "error" });

function resolveParticipantPhone(participant: GroupParticipant | string): string {
  if (typeof participant === "string") {
    return normalizePhoneCandidate(extractPhoneFromJid(participant));
  }

  // Prefer explicit phoneNumber from Baileys metadata when available.
  const fromPhoneNumber = normalizePhoneCandidate(extractPhoneFromJid(String(participant.phoneNumber || "")));
  if (fromPhoneNumber.startsWith("55")) return fromPhoneNumber;

  const fromId = normalizePhoneCandidate(extractPhoneFromJid(String((participant as { id?: string }).id || "")));
  if (fromId.startsWith("55")) return fromId;

  const fromLid = normalizePhoneCandidate(extractPhoneFromJid(String(participant.lid || "")));
  if (fromLid.startsWith("55")) return fromLid;

  return fromPhoneNumber || fromId || fromLid;
}

async function resolveGroupName(
  socket: WASocket | null,
  groupId: string,
  cache: Map<string, string>
): Promise<string> {
  if (cache.has(groupId)) return cache.get(groupId)!;

  if (!socket) {
    cache.set(groupId, groupId);
    return groupId;
  }

  try {
    const metadata = await socket.groupMetadata(groupId);
    const name = metadata.subject || groupId;
    cache.set(groupId, name);
    return name;
  } catch {
    cache.set(groupId, groupId);
    return groupId;
  }
}

export function setupAnalyticsCollector(
  state: SessionState,
  socket: WASocket
): void {
  const nameCache = new Map<string, string>();

  socket.ev.on("group-participants.update", async (update) => {
    try {
      const { id: groupId, author, participants, action } = update;
      if (!participants || participants.length === 0) return;

      const groupName = await resolveGroupName(socket, groupId, nameCache);
      const authorPhone = author ? normalizePhoneCandidate(extractPhoneFromJid(author)) : undefined;

      for (const participant of participants) {
        const phone = resolveParticipantPhone(participant as GroupParticipant | string);
        const ddd = getMemberDDD(phone);
        const participantState = dddToState(ddd);

        const event: GroupEvent = {
          type:
            action === "add"
              ? "member_joined"
              : action === "remove"
              ? "member_removed"
              : "member_left",
          groupId,
          groupName,
          participantPhone: phone,
          participantDDD: ddd,
          participantState,
          authorPhone,
          timestamp: new Date().toISOString(),
        };

        await storeEvent(event);

        // Persist to SQL for UI history feed, permanence calc and recapture
        // (fire-and-forget — never blocks real-time event flow)
        void persistMovementToSQL({
          ...event,
          sessionId: state.config.sessionId,
        });
      }

      // Capture snapshot after change
      await captureSnapshotForGroup(state, groupId, socket, nameCache);
    } catch (error) {
      logger.warn(
        { sessionId: state.config.sessionId, error: String(error) },
        "analytics collector failed on group-participants.update"
      );
    }
  });

  socket.ev.on("groups.update", async (updates) => {
    try {
      for (const update of updates as Array<{ id?: string; subject?: string }>) {
        if (update.id && update.subject) {
          nameCache.set(update.id, update.subject);
        }
      }
    } catch {
      // best effort
    }
  });
}

export async function captureSnapshotForGroup(
  state: SessionState,
  groupId: string,
  socket: WASocket | null,
  nameCache?: Map<string, string>
): Promise<void> {
  if (!socket) return;

  try {
    const metadata = await socket.groupMetadata(groupId);
    const groupName = nameCache?.get(groupId) || metadata.subject || groupId;

    const members = (metadata.participants || []).map((p: GroupParticipant) => {
      const phone = resolveParticipantPhone(p);
      const ddd = getMemberDDD(phone);
      const memberState = dddToState(ddd);
      const isAdmin = (p as any).admin !== null && (p as any).admin !== undefined;

      return {
        phone,
        ddd,
        state: memberState,
        isAdmin,
        joinedAt: new Date().toISOString(),
      };
    });

    const snapshot: GroupSnapshot = {
      groupId,
      groupName,
      date: new Date().toISOString().slice(0, 10),
      totalMembers: members.length,
      members,
    };

    await captureSnapshot(snapshot);
  } catch (error) {
    logger.warn(
      { sessionId: state.config.sessionId, groupId, error: String(error) },
      "failed to capture group snapshot"
    );
  }
}

export async function captureAllGroupSnaphots(state: SessionState): Promise<void> {
  if (!state.socket || state.status !== "online") return;

  try {
    const groups = await state.socket.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);

    for (const groupId of groupIds) {
      await captureSnapshotForGroup(state, groupId, state.socket, undefined);
    }
  } catch (error) {
    logger.warn(
      { sessionId: state.config.sessionId, error: String(error) },
      "failed to capture all group snapshots"
    );
  }
}

export function scheduleDailySnapshots(state: SessionState): void {
  const now = new Date();
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    1
  );
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  const timer = setTimeout(async () => {
    await captureAllGroupSnaphots(state);
    scheduleDailySnapshots(state);
  }, msUntilMidnight);

  timer.unref();
}
