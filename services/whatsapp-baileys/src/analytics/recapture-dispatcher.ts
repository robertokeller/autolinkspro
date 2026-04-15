// services/whatsapp-baileys/src/analytics/recapture-dispatcher.ts
//
// Polls the API every 60 s for recapture queue items that are due, then sends
// each one as a private WhatsApp message via the correct live session.
// Runs using the same recursive-setTimeout pattern as scheduleDailySnapshots.

import type { SessionState } from "../server.js";
import type { RecaptureDispatchItem } from "./types.js";
import pino from "pino";

const logger = pino({ level: "error" });

const API_URL = process.env.API_URL || process.env.INTERNAL_API_URL || "";
const SERVICE_SECRET = process.env.SERVICE_SECRET || "";
const POLL_INTERVAL_MS = 60_000;

// Template variable substitution. Supported tokens:
//   {{phone}}           – formatted phone  e.g. "+55 11 99999-9999"
//   {{tempo_no_grupo}}  – formatted permanence e.g. "3d 5h 40m" (or "" if unknown)
function renderTemplate(template: string, item: RecaptureDispatchItem): string {
  const phone = formatPhone(item.memberPhone);
  const tempo = item.timePermanenceMinutes != null
    ? formatMinutes(item.timePermanenceMinutes)
    : "";

  return template
    .replace(/\{\{phone\}\}/gi, phone)
    .replace(/\{\{telefone\}\}/gi, phone)
    .replace(/\{\{tempo_no_grupo\}\}/gi, tempo)
    .replace(/\{\{tempo\}\}/gi, tempo);
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) {
    const local = digits.slice(2);
    const ddd = local.slice(0, 2);
    const number = local.slice(2);
    if (number.length === 9) {
      return `+55 ${ddd} ${number.slice(0, 5)}-${number.slice(5)}`;
    }
    if (number.length === 8) {
      return `+55 ${ddd} ${number.slice(0, 4)}-${number.slice(4)}`;
    }
  }
  return `+${digits}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remainH = h % 24;
  return remainH > 0 ? `${d}d ${remainH}h` : `${d}d`;
}

async function fetchPendingBatch(): Promise<RecaptureDispatchItem[]> {
  if (!API_URL || !SERVICE_SECRET) return [];
  try {
    const res = await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-secret": SERVICE_SECRET,
      },
      body: JSON.stringify({ name: "analytics-recapture-process-batch" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = await res.json() as unknown;
    const data = (json && typeof json === "object" && "data" in json) ? (json as { data?: unknown }).data : json;
    return Array.isArray(data) ? (data as RecaptureDispatchItem[]) : [];
  } catch {
    return [];
  }
}

async function markSent(queueId: string, status: "sent" | "failed", errorMessage = ""): Promise<void> {
  if (!API_URL || !SERVICE_SECRET) return;
  try {
    await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-secret": SERVICE_SECRET,
      },
      body: JSON.stringify({
        name: "analytics-recapture-mark-sent",
        queueId,
        status,
        errorMessage,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // best effort
  }
}

async function sendOneRecapture(
  item: RecaptureDispatchItem,
  getSession: (sessionId: string) => SessionState | undefined,
  getAllSessions: () => SessionState[],
): Promise<void> {
  // Resolve the correct live session
  let state: SessionState | undefined;
  if (item.sessionId) {
    state = getSession(item.sessionId);
  }
  // Fallback: try any online session owned by the same user that has an online socket
  if (!state || state.status !== "online" || !state.socket) {
    state = getAllSessions().find(
      (s) =>
        s.status === "online" &&
        s.socket != null &&
        s.config.userId === (state?.config.userId || s.config.userId)
    );
  }

  if (!state || !state.socket) {
    await markSent(item.queueId, "failed", "No online session available");
    return;
  }

  // Build the JID for private messages (individual chat)
  const digits = item.memberPhone.replace(/\D/g, "");
  const jid = `${digits}@s.whatsapp.net`;
  const message = renderTemplate(item.messageTemplate, item);

  if (!message.trim()) {
    await markSent(item.queueId, "failed", "Empty message template");
    return;
  }

  try {
    await state.socket.sendMessage(jid, { text: message });
    await markSent(item.queueId, "sent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ queueId: item.queueId, jid }, `recapture send failed: ${msg}`);
    await markSent(item.queueId, "failed", msg.slice(0, 200));
  }
}

export function scheduleRecaptureDispatcher(
  getSession: (sessionId: string) => SessionState | undefined,
  getAllSessions: () => SessionState[],
): void {
  const run = (): void => {
    // Fire-and-forget; any unhandled rejection is logged not thrown
    fetchPendingBatch()
      .then(async (items) => {
        for (const item of items) {
          await sendOneRecapture(item, getSession, getAllSessions);
        }
      })
      .catch((err) => {
        logger.warn({ err: String(err) }, "recapture-dispatcher batch failed");
      })
      .finally(() => {
        const timer = setTimeout(run, POLL_INTERVAL_MS);
        timer.unref();
      });
  };

  // Start first tick after one interval so we don't fire immediately on boot
  const timer = setTimeout(run, POLL_INTERVAL_MS);
  timer.unref();
}
