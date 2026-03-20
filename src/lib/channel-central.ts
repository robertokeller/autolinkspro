import { invokeBackendRpc } from "@/integrations/backend/rpc";

type ChannelPlatform = "whatsapp" | "telegram";

type WhatsAppAction = "connect" | "disconnect" | "sync_groups" | "group_invite" | "send_message" | "poll_events" | "poll_events_all" | "health";
type TelegramAction =
  | "send_code"
  | "verify_code"
  | "verify_password"
  | "disconnect"
  | "sync_groups"
  | "send_message"
  | "poll_events"
  | "poll_events_all"
  | "refresh_status"
  | "health";

export interface ChannelHealth {
  platform: ChannelPlatform;
  url: string;
  online: boolean;
  uptimeSec: number | null;
  error: string | null;
  checkedAt: string;
  sessionsTotal?: number;
}

const CHANNEL_RPC = {
  whatsapp: "whatsapp-connect",
  telegram: "telegram-connect",
} as const;

async function invokeChannelRpc<T = Record<string, unknown>>(
  platform: ChannelPlatform,
  action: string,
  payload: Record<string, unknown> = {},
) {
  return invokeBackendRpc<T>(CHANNEL_RPC[platform], {
    body: { action, ...payload },
  });
}

export function invokeWhatsAppAction<T = Record<string, unknown>>(
  action: WhatsAppAction,
  payload: Record<string, unknown> = {},
) {
  return invokeChannelRpc<T>("whatsapp", action, payload);
}

export function invokeTelegramAction<T = Record<string, unknown>>(
  action: TelegramAction,
  payload: Record<string, unknown> = {},
) {
  return invokeChannelRpc<T>("telegram", action, payload);
}

function normalizeHealth(platform: ChannelPlatform, raw: Record<string, unknown> | null | undefined): ChannelHealth {
  const checkedAt = new Date().toISOString();
  const url = String(raw?.url || "");
  const online = raw?.online === true || raw?.ok === true;
  const uptimeRaw = Number(raw?.uptimeSec);
  const uptimeSec = Number.isFinite(uptimeRaw) ? uptimeRaw : null;
  const error = raw?.error ? String(raw.error) : null;

  const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];

  return {
    platform,
    url,
    online,
    uptimeSec,
    error,
    checkedAt,
    sessionsTotal: sessions.length,
  };
}

async function getWhatsAppHealth() {
  try {
    const res = await invokeWhatsAppAction<Record<string, unknown>>("health");
    return normalizeHealth("whatsapp", res);
  } catch (error) {
    return {
      platform: "whatsapp" as const,
      url: "",
      online: false,
      uptimeSec: null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function getTelegramHealth() {
  try {
    const res = await invokeTelegramAction<Record<string, unknown>>("health");
    return normalizeHealth("telegram", res);
  } catch (error) {
    return {
      platform: "telegram" as const,
      url: "",
      online: false,
      uptimeSec: null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function getAllChannelHealth() {
  const [whatsapp, telegram] = await Promise.all([getWhatsAppHealth(), getTelegramHealth()]);
  return { whatsapp, telegram };
}

export async function pollAllChannelEvents() {
  const [whatsapp, telegram] = await Promise.allSettled([
    invokeWhatsAppAction("poll_events_all"),
    invokeTelegramAction("poll_events_all"),
  ]);

  return {
    whatsapp: whatsapp.status === "fulfilled",
    telegram: telegram.status === "fulfilled",
  };
}

export async function syncChannelGroups(platform: ChannelPlatform, sessionId: string) {
  if (platform === "whatsapp") {
    return invokeWhatsAppAction("sync_groups", { sessionId });
  }
  return invokeTelegramAction("sync_groups", { sessionId });
}
