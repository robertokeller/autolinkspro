import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  type proto,
  type WASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

type AuthMethod = "qr" | "pairing";

type SessionStatus = "offline" | "connecting" | "qr_code" | "pairing_code" | "online";

interface SessionConfig {
  sessionId: string;
  userId: string;
  webhookUrl?: string;
  phone: string;
  authMethod: AuthMethod;
  sessionName: string;
}

interface IntegrationEvent {
  id: string;
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface SessionState {
  config: SessionConfig;
  socket: WASocket | null;
  status: SessionStatus;
  connecting: boolean;
  generation: number;
  reconnectAttempts: number;
  manualStop: boolean;
  pairingCooldownUntil: number;
  groupNames: Map<string, string>;
  events: IntegrationEvent[];
  recentInboundMessageKeys: Map<string, number>;
  ingestion: {
    upserts: number;
    messagesSeen: number;
    accepted: number;
    duplicates: number;
    dropped: Record<string, number>;
    lastAcceptedAt: string | null;
    lastDroppedAt: string | null;
    lastDropReason: string;
  };
}

interface ConnectBody {
  userId?: string;
  webhookUrl?: string;
  phone?: string;
  authMethod?: AuthMethod;
  sessionName?: string;
}

interface SendBody {
  sessionId?: string;
  jid?: string;
  content?: string;
  media?: {
    kind?: "image";
    token?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
  };
}

interface SendResponsePayload {
  id: string | null;
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "3111");
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "12mb";
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_INSECURE_NO_SECRET = process.env.ALLOW_INSECURE_NO_SECRET === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const MEDIA_CAPTURE_DEBUG = new Set(["1", "true", "yes", "on"]).has(
  String(process.env.MEDIA_CAPTURE_DEBUG || process.env.ROUTE_MEDIA_DEBUG || "").trim().toLowerCase(),
);
const SESSIONS_ROOT = path.resolve(process.env.BAILEYS_SESSIONS_DIR || path.join(process.cwd(), ".sessions"));
const SESSION_DIR_PREFIX = "wa_";

const logger = pino({ level: LOG_LEVEL });
const baileysLogger = pino({ level: "error" });
const app = express();
const sessionStates = new Map<string, SessionState>();
const inFlightSends = new Map<string, Promise<SendResponsePayload>>();
const mediaStore = new Map<string, {
  token: string;
  userId: string;
  data: Buffer;
  mimeType: string;
  fileName: string;
  createdAt: number;
  deleteAt: number | null;
}>();
let httpServer: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;
const MAX_SESSION_EVENTS = Math.max(200, Number(process.env.MAX_SESSION_EVENTS || "2000"));
const INBOUND_MESSAGE_DEDUPE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.WA_INBOUND_DEDUPE_WINDOW_MS || "900000"),
);
const INBOUND_MESSAGE_DEDUPE_MAX_KEYS = Math.max(
  500,
  Number(process.env.WA_INBOUND_DEDUPE_MAX_KEYS || "5000"),
);
const AUTO_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const rawCorsOrigin = process.env.CORS_ORIGIN ?? "";
const corsOriginList = rawCorsOrigin.split(",").map((s) => s.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server / non-browser requests (no Origin header).
    if (!origin) { callback(null, true); return; }
    // When an explicit allowlist is configured, enforce it.
    if (corsOriginList.length > 0) {
      callback(null, corsOriginList.includes(origin));
      return;
    }
    // Fail-closed by default: only allow localhost origins when no CORS_ORIGIN is set.
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    callback(null, isLocalhost);
  },
}));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// ─── Security headers ─────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

// ─── Rate limiting (in-memory, per IP) ───────────────────────────────────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_REQUESTS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;

function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    next();
    return;
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_REQUESTS) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too Many Requests" });
    return;
  }
  next();
}

app.use(rateLimit);

// Evict expired entries every 5 minutes to prevent unbounded Map growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60_000).unref();

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function logMediaCaptureDebug(event: string, payload: Record<string, unknown>): void {
  if (!MEDIA_CAPTURE_DEBUG) return;
  logger.info({ event, ...payload }, "media capture debug");
}

function bumpIngestionDrop(state: SessionState, reason: string): void {
  const key = String(reason || "unknown").trim() || "unknown";
  state.ingestion.dropped[key] = (state.ingestion.dropped[key] || 0) + 1;
  state.ingestion.lastDroppedAt = new Date().toISOString();
  state.ingestion.lastDropReason = key;
}

function bumpIngestionAccepted(state: SessionState): void {
  state.ingestion.accepted += 1;
  state.ingestion.lastAcceptedAt = new Date().toISOString();
}

function pruneRecentInboundMessageKeys(state: SessionState, nowMs: number): void {
  for (const [key, seenAt] of state.recentInboundMessageKeys.entries()) {
    if (nowMs - seenAt > INBOUND_MESSAGE_DEDUPE_WINDOW_MS) {
      state.recentInboundMessageKeys.delete(key);
    }
  }

  if (state.recentInboundMessageKeys.size <= INBOUND_MESSAGE_DEDUPE_MAX_KEYS) return;
  const overflow = state.recentInboundMessageKeys.size - INBOUND_MESSAGE_DEDUPE_MAX_KEYS;
  if (overflow <= 0) return;
  const ordered = [...state.recentInboundMessageKeys.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < overflow && i < ordered.length; i += 1) {
    state.recentInboundMessageKeys.delete(ordered[i][0]);
  }
}

function buildInboundDedupeKey(message: {
  key?: { id?: string | null; remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null };
  messageTimestamp?: unknown;
  pushName?: string | null;
}): string {
  const key = message.key || {};
  const id = String(key.id || "").trim();
  const remoteJid = String(key.remoteJid || "").trim();
  const participant = String(key.participant || "").trim();
  const fromMe = key.fromMe ? "1" : "0";
  const timestamp = String(message.messageTimestamp ?? "").trim();
  const pushName = String(message.pushName || "").trim();
  const primary = `${remoteJid}|${id}|${participant}|${fromMe}`;
  if (id && remoteJid) return primary;
  return `${primary}|${timestamp}|${pushName}`;
}

function markInboundMessageSeen(state: SessionState, dedupeKey: string): boolean {
  const key = String(dedupeKey || "").trim();
  if (!key) return true;
  const nowMs = Date.now();
  pruneRecentInboundMessageKeys(state, nowMs);
  if (state.recentInboundMessageKeys.has(key)) {
    return false;
  }
  state.recentInboundMessageKeys.set(key, nowMs);
  return true;
}

function parseSessionIdFromDirName(dirName: string): string {
  return dirName.startsWith(SESSION_DIR_PREFIX) ? dirName.slice(SESSION_DIR_PREFIX.length) : dirName;
}

function getPrimarySessionDir(sessionId: string): string {
  return path.join(SESSIONS_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`);
}

function getLegacySessionDir(sessionId: string): string {
  return path.join(SESSIONS_ROOT, sessionId);
}

function getSessionDirCandidates(sessionId: string): string[] {
  return Array.from(new Set([getPrimarySessionDir(sessionId), getLegacySessionDir(sessionId)]));
}

async function resolveSessionDir(sessionId: string): Promise<string | null> {
  for (const candidate of getSessionDirCandidates(sessionId)) {
    const exists = await fs.access(candidate).then(() => true).catch(() => false);
    if (exists) return candidate;
  }
  return null;
}

async function migrateLegacySessionDir(sessionId: string): Promise<void> {
  const primaryDir = getPrimarySessionDir(sessionId);
  const legacyDir = getLegacySessionDir(sessionId);

  const hasPrimary = await fs.access(primaryDir).then(() => true).catch(() => false);
  if (hasPrimary) return;

  const hasLegacy = await fs.access(legacyDir).then(() => true).catch(() => false);
  if (!hasLegacy) return;

  await fs.rename(legacyDir, primaryDir).catch(() => undefined);
}

function getSessionDir(sessionId: string): string {
  return getPrimarySessionDir(sessionId);
}

function getMetadataPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "metadata.json");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeMetadata(config: SessionConfig): Promise<void> {
  await migrateLegacySessionDir(config.sessionId);
  const metadataPath = getMetadataPath(config.sessionId);
  await ensureDir(path.dirname(metadataPath));
  await fs.writeFile(metadataPath, JSON.stringify(config, null, 2), "utf-8");
}

async function readMetadata(sessionId: string): Promise<SessionConfig | null> {
  for (const sessionDir of getSessionDirCandidates(sessionId)) {
    try {
      const metadataPath = path.join(sessionDir, "metadata.json");
      const content = await fs.readFile(metadataPath, "utf-8");
      const parsed = JSON.parse(content) as SessionConfig;

      if (!parsed.sessionId || !parsed.userId) {
        continue;
      }

      return {
        sessionId: parsed.sessionId,
        userId: parsed.userId,
        webhookUrl: parsed.webhookUrl || "",
        phone: parsed.phone || "",
        authMethod: parsed.authMethod === "pairing" ? "pairing" : "qr",
        sessionName: parsed.sessionName || parsed.sessionId,
      };
    } catch {
      // try next path candidate
    }
  }

  return null;
}

async function clearSessionAuth(sessionId: string): Promise<void> {
  await migrateLegacySessionDir(sessionId);
  const sessionDir = (await resolveSessionDir(sessionId)) || getSessionDir(sessionId);
  try {
    const entries = await fs.readdir(sessionDir);
    await Promise.all(
      entries
        .filter((entry) => entry !== "metadata.json")
        .map((entry) => fs.rm(path.join(sessionDir, entry), { recursive: true, force: true })),
    );
  } catch {
    // ignore
  }
}

async function removeSessionCompletely(sessionId: string): Promise<void> {
  sessionStates.delete(sessionId);
  for (const sessionDir of getSessionDirCandidates(sessionId)) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extractDisconnectCode(error: unknown): number | undefined {
  const maybe = error as { output?: { statusCode?: number } };
  return maybe?.output?.statusCode;
}

function toPhoneFromJid(jid?: string | null): string {
  if (!jid) return "";
  const first = jid.split(":")[0] || jid;
  const number = first.split("@")[0] || "";
  if (!number) return "";
  return number.startsWith("+") ? number : `+${number}`;
}

function normalizePairingPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function normalizeJid(rawJid: string): string {
  if (rawJid.includes("@")) return rawJid;
  if (rawJid.includes("-")) return `${rawJid}@g.us`;
  const digits = rawJid.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function buildSendDedupKey(body: {
  sessionId: string;
  jid: string;
  content?: string;
  media?: SendBody["media"];
}): string {
  const content = String(body.content ?? "");
  const media = body.media;
  const mediaDescriptor = media
    ? [
      media.kind || "",
      media.token || "",
      media.mimeType || "",
      media.fileName || "",
      media.base64 ? media.base64.slice(0, 64) : "",
      media.base64 ? String(media.base64.length) : "",
    ].join("|")
    : "";

  return [body.sessionId, body.jid, content.trim(), mediaDescriptor].join("::");
}

type ExtendedBaileysMessage = proto.IMessage & {
  documentWithCaptionMessage?: { message?: proto.IMessage | null } | null;
  viewOnceMessageV2Extension?: { message?: proto.IMessage | null } | null;
};

function getExtendedNestedMessage(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  const extended = message as ExtendedBaileysMessage;
  if (extended.documentWithCaptionMessage?.message) return extended.documentWithCaptionMessage.message;
  if (extended.viewOnceMessageV2Extension?.message) return extended.viewOnceMessageV2Extension.message;
  return null;
}

function extractMessageText(message: proto.IMessage | null | undefined): string {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.templateButtonReplyMessage?.selectedDisplayText) return message.templateButtonReplyMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  if (message.ephemeralMessage?.message) return extractMessageText(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractMessageText(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return extractMessageText(message.viewOnceMessageV2.message);
  const nested = getExtendedNestedMessage(message);
  if (nested) return extractMessageText(nested);

  const contentType = getContentType(message);
  if (contentType && (message as Record<string, unknown>)[contentType]) {
    const payload = (message as Record<string, unknown>)[contentType] as Record<string, unknown>;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.caption === "string") return payload.caption;
  }

  return "";
}

type WhatsAppInboundMediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "contact"
  | "location"
  | "poll"
  | "other";

type WhatsAppInboundMediaInfo = {
  kind: WhatsAppInboundMediaKind;
  mimetype?: string | null;
  imagePayload?: { mimetype?: string | null } | null;
};

function readMessageMimeType(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.mimetype === "string" && row.mimetype.trim()) return row.mimetype.trim();
  return null;
}

function detectGenericMessagePayloadKind(contentType: string): WhatsAppInboundMediaKind | null {
  const normalized = String(contentType || "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("image")) return "image";
  if (normalized.includes("video")) return "video";
  if (normalized.includes("audio")) return "audio";
  if (normalized.includes("document")) return "document";
  if (normalized.includes("sticker")) return "sticker";
  if (normalized.includes("contact")) return "contact";
  if (normalized.includes("location")) return "location";
  if (normalized.includes("poll")) return "poll";
  return null;
}

function extractInboundMediaInfo(
  message: proto.IMessage | null | undefined,
): WhatsAppInboundMediaInfo | null {
  if (!message) return null;
  if (message.imageMessage) {
    return {
      kind: "image",
      mimetype: message.imageMessage.mimetype || null,
      imagePayload: message.imageMessage,
    };
  }
  if (message.videoMessage) return { kind: "video", mimetype: message.videoMessage.mimetype || null };
  if (message.audioMessage) return { kind: "audio", mimetype: message.audioMessage.mimetype || null };
  if (message.documentMessage) return { kind: "document", mimetype: message.documentMessage.mimetype || null };
  if (message.stickerMessage) return { kind: "sticker", mimetype: message.stickerMessage.mimetype || "image/webp" };
  if (message.contactMessage || message.contactsArrayMessage) return { kind: "contact", mimetype: null };
  if (message.locationMessage || message.liveLocationMessage) return { kind: "location", mimetype: null };
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3 || message.pollUpdateMessage) {
    return { kind: "poll", mimetype: null };
  }
  if (message.ephemeralMessage?.message) return extractInboundMediaInfo(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractInboundMediaInfo(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return extractInboundMediaInfo(message.viewOnceMessageV2.message);

  const nested = getExtendedNestedMessage(message);
  if (nested) return extractInboundMediaInfo(nested);

  const contentType = getContentType(message);
  if (!contentType) return null;
  const payload = (message as Record<string, unknown>)[contentType];
  if (!payload || typeof payload !== "object") return null;
  const genericKind = detectGenericMessagePayloadKind(contentType);
  const mimeType = readMessageMimeType(payload);
  if (genericKind === "image") {
    return {
      kind: "image",
      mimetype: mimeType,
      imagePayload: payload as { mimetype?: string | null },
    };
  }
  if (genericKind) {
    return {
      kind: genericKind,
      mimetype: mimeType,
    };
  }

  const row = payload as Record<string, unknown>;
  const hasMediaLikeShape = ("url" in row) || ("mediaKey" in row) || ("fileLength" in row) || ("jpegThumbnail" in row);
  if (!hasMediaLikeShape) return null;
  return {
    kind: "other",
    mimetype: mimeType,
  };
}

function extractImagePayload(
  message: proto.IMessage | null | undefined,
): { mimetype?: string | null } | null {
  const media = extractInboundMediaInfo(message);
  if (!media || media.kind !== "image") return null;
  return media.imagePayload || null;
}

function detectImageMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: GIF87a / GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }

  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  return null;
}

function coerceBinaryToBuffer(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) {
    if (value.length === 0) return null;
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const dataUri = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
    const base64Payload = (dataUri ? dataUri[1] : trimmed).replace(/\s+/g, "");
    if (!base64Payload || base64Payload.length < 16) return null;
    if (!/^[a-z0-9+/=]+$/i.test(base64Payload)) return null;
    try {
      const buffer = Buffer.from(base64Payload, "base64");
      return buffer.length > 0 ? buffer : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    const nested = coerceBinaryToBuffer(row.bytes ?? row.data ?? row.buffer ?? row.thumbnail ?? row.jpegThumbnail);
    if (nested) return nested;
  }
  return null;
}

function extractInboundThumbnailBuffer(message: proto.IMessage | null | undefined): Buffer | null {
  if (!message) return null;
  const stack: unknown[] = [message];
  const visited = new Set<object>();
  const thumbnailKeys = new Set(["jpegThumbnail", "thumbnail", "pngThumbnail", "thumbnailBytes"]);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const row = current as Record<string, unknown>;

    for (const key of thumbnailKeys) {
      const candidate = coerceBinaryToBuffer(row[key]);
      if (!candidate || candidate.length === 0 || candidate.length > AUTO_IMAGE_MAX_BYTES) continue;
      const detected = detectImageMimeTypeFromBuffer(candidate);
      if (detected) return candidate;
    }

    for (const value of Object.values(row)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return null;
}

function shouldAttemptFullMediaDownloadAsImageCandidate(media: WhatsAppInboundMediaInfo | null): boolean {
  if (!media) return false;
  if (media.kind === "image" || media.kind === "sticker") return true;
  const mime = String(media.mimetype || "").trim().toLowerCase();
  return mime.startsWith("image/");
}

async function downloadIncomingMediaBuffer(args: {
  message: { message?: proto.IMessage };
  socket: WASocket;
  sessionId: string;
}): Promise<Buffer | null> {
  const { message, socket, sessionId } = args;
  try {
    const downloaded = await downloadMediaMessage(
      message as unknown as any,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage },
    );
    if (downloaded && Buffer.isBuffer(downloaded) && downloaded.length > 0 && downloaded.length <= AUTO_IMAGE_MAX_BYTES) {
      return downloaded;
    }
  } catch (error) {
    logger.warn({ sessionId, error: sanitizeError(error) }, "generic media download failed while resolving inbound image");
  }
  return null;
}

async function resolveInboundMediaAsImage(args: {
  message: { message?: proto.IMessage };
  socket: WASocket;
  sessionId: string;
  inboundMedia: WhatsAppInboundMediaInfo | null;
  imagePayload: { mimetype?: string | null } | null;
}): Promise<{ buffer: Buffer; mimeType: string; origin: "image_payload" | "thumbnail" | "media_download" } | null> {
  const { message, socket, sessionId, inboundMedia, imagePayload } = args;

  if (imagePayload) {
    const downloaded = await downloadIncomingImageBuffer({
      message,
      socket,
      sessionId,
      mimeTypeHint: imagePayload.mimetype,
    });
    if (downloaded && downloaded.length > 0) {
      const detectedMime = detectImageMimeTypeFromBuffer(downloaded);
      const mimeTypeHint = String(imagePayload.mimetype || inboundMedia?.mimetype || "").trim().toLowerCase();
      return {
        buffer: downloaded,
        mimeType: detectedMime || (mimeTypeHint.startsWith("image/") ? mimeTypeHint : "image/jpeg"),
        origin: "image_payload",
      };
    }
  }

  const thumbnail = extractInboundThumbnailBuffer(message.message);
  if (thumbnail && thumbnail.length > 0) {
    const detectedMime = detectImageMimeTypeFromBuffer(thumbnail) || "image/jpeg";
    return {
      buffer: thumbnail,
      mimeType: detectedMime,
      origin: "thumbnail",
    };
  }

  if (shouldAttemptFullMediaDownloadAsImageCandidate(inboundMedia)) {
    const downloadedAny = await downloadIncomingMediaBuffer({ message, socket, sessionId });
    if (downloadedAny && downloadedAny.length > 0) {
      const detectedMime = detectImageMimeTypeFromBuffer(downloadedAny);
      if (detectedMime) {
        return {
          buffer: downloadedAny,
          mimeType: detectedMime,
          origin: "media_download",
        };
      }
    }
  }

  return null;
}

async function downloadIncomingImageBuffer(args: {
  message: { message?: proto.IMessage };
  socket: WASocket;
  sessionId: string;
  mimeTypeHint?: string | null;
}): Promise<Buffer | null> {
  const { message, socket, sessionId, mimeTypeHint } = args;

  try {
    const downloaded = await downloadMediaMessage(
      message as unknown as any,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage },
    );
    if (downloaded && Buffer.isBuffer(downloaded) && downloaded.length > 0 && downloaded.length <= AUTO_IMAGE_MAX_BYTES) {
      return downloaded;
    }
  } catch (error) {
    logger.warn({ sessionId, error: sanitizeError(error) }, "primary image download failed; trying fallback");
  }

  try {
    const imagePayload = extractImagePayload(message.message);
    if (!imagePayload) return null;
    const stream = await downloadContentFromMessage(imagePayload as unknown as any, "image");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length > 0 && buffer.length <= AUTO_IMAGE_MAX_BYTES) return buffer;
  } catch (error) {
    logger.warn({ sessionId, error: sanitizeError(error), mimeTypeHint: mimeTypeHint || "" }, "fallback image download failed");
  }

  return null;
}

function generateMediaToken(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const MEDIA_STALE_RETENTION_MS = 45 * 60 * 1000;

function detectImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
}

/** Strip path separators and control characters to prevent path traversal. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "_") // strip dangerous chars
    .replace(/^\.+/, "_") // disallow leading dots (hidden files / relative paths)
    .slice(0, 255) || "file";
}

function storeTemporaryImage(buffer: Buffer, userId: string, mimeType: string, fileName?: string): { token: string; fileName: string } {
  const token = generateMediaToken();
  const safeMimeType = mimeType || "image/jpeg";
  const rawName = fileName?.trim();
  const finalFileName = rawName
    ? sanitizeFileName(rawName)
    : `route_image_${Date.now()}.${detectImageExtension(safeMimeType)}`;
  const createdAt = Date.now();
  mediaStore.set(token, {
    token,
    userId,
    data: buffer,
    mimeType: safeMimeType,
    fileName: finalFileName,
    createdAt,
    deleteAt: null,
  });
  logger.info(
    {
      token,
      mimeType: safeMimeType,
      fileName: finalFileName,
      size: buffer.length,
      createdAt: new Date(createdAt).toISOString(),
    },
    "temporary media stored",
  );
  return { token, fileName: finalFileName };
}

function scheduleMediaDeletion(token: string, delayMs = 120_000): boolean {
  const current = mediaStore.get(token);
  if (!current) return false;
  const normalizedDelay = Math.max(1_000, Number(delayMs) || 120_000);
  const deleteAt = Date.now() + normalizedDelay;
  current.deleteAt = deleteAt;
  mediaStore.set(token, current);
  logger.info(
    {
      token,
      delayMs: normalizedDelay,
      deleteAt: new Date(deleteAt).toISOString(),
    },
    "temporary media deletion scheduled",
  );
  return true;
}

function startMediaCleanupLoop() {
  setInterval(() => {
    const now = Date.now();
    for (const [token, item] of mediaStore.entries()) {
      const expiredByDelete = item.deleteAt !== null && item.deleteAt <= now;
      const staleWithoutDelete = item.deleteAt === null && now - item.createdAt > MEDIA_STALE_RETENTION_MS;
      if (expiredByDelete || staleWithoutDelete) {
        mediaStore.delete(token);
        logger.info(
          {
            token,
            reason: expiredByDelete ? "scheduled_delete" : "stale_cleanup",
            createdAt: new Date(item.createdAt).toISOString(),
            deleteAt: item.deleteAt ? new Date(item.deleteAt).toISOString() : null,
          },
          "temporary media deleted",
        );
      }
    }
  }, 30_000);
}

async function emitWebhook(state: SessionState, event: string, data: Record<string, unknown>): Promise<void> {
  state.events.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event,
    timestamp: new Date().toISOString(),
    data,
  });

  if (state.events.length > MAX_SESSION_EVENTS) {
    const dropped = state.events.length - MAX_SESSION_EVENTS;
    if (dropped > 0) {
      logger.warn(
        {
          sessionId: state.config.sessionId,
          event,
          dropped,
          queuedBeforeTrim: state.events.length,
          limit: MAX_SESSION_EVENTS,
        },
        "session event buffer overflow; dropping oldest queued events",
      );
      state.events.splice(0, dropped);
    }
  }

  if (!state.config.webhookUrl) return;

  const payload = {
    event,
    sessionId: state.config.sessionId,
    userId: state.config.userId,
    data,
  };

  try {
    const response = await fetch(state.config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn({ sessionId: state.config.sessionId, event, status: response.status, body }, "webhook returned non-2xx");
    }
  } catch (error) {
    logger.error({ sessionId: state.config.sessionId, event, error: sanitizeError(error) }, "webhook dispatch failed");
  }
}

async function resolveGroupName(state: SessionState, groupJid: string): Promise<string | undefined> {
  const cached = state.groupNames.get(groupJid);
  if (cached) return cached;

  if (!state.socket) return undefined;

  try {
    const metadata = await state.socket.groupMetadata(groupJid);
    const name = metadata.subject || groupJid;
    state.groupNames.set(groupJid, name);
    return name;
  } catch {
    return undefined;
  }
}

async function syncGroups(state: SessionState): Promise<{ count: number; groups: Array<{ id: string; name: string; memberCount: number }> }> {
  if (!state.socket || state.status !== "online") {
    throw new Error("Session is not online");
  }

  const groupsRaw = await state.socket.groupFetchAllParticipating();
  const groups = Object.entries(groupsRaw).map(([id, group]) => {
    const groupData = group as { subject?: string; participants?: unknown[] };
    const name = groupData.subject || id;
    const memberCount = Array.isArray(groupData.participants) ? groupData.participants.length : 0;
    state.groupNames.set(id, name);
    return { id, name, memberCount };
  });

  await emitWebhook(state, "groups_sync", { groups });
  return { count: groups.length, groups };
}

async function createOrGetState(config: SessionConfig): Promise<SessionState> {
  const existing = sessionStates.get(config.sessionId);
  if (existing) {
    existing.config = config;
    return existing;
  }

  const state: SessionState = {
    config,
    socket: null,
    status: "offline",
    connecting: false,
    generation: 0,
    reconnectAttempts: 0,
    manualStop: false,
    pairingCooldownUntil: 0,
    groupNames: new Map<string, string>(),
    events: [],
    recentInboundMessageKeys: new Map<string, number>(),
    ingestion: {
      upserts: 0,
      messagesSeen: 0,
      accepted: 0,
      duplicates: 0,
      dropped: {},
      lastAcceptedAt: null,
      lastDroppedAt: null,
      lastDropReason: "",
    },
  };

  sessionStates.set(config.sessionId, state);
  return state;
}

async function loadStateFromDisk(sessionId: string): Promise<SessionState | null> {
  const existing = sessionStates.get(sessionId);
  if (existing) return existing;

  await migrateLegacySessionDir(sessionId);
  const metadata = await readMetadata(sessionId);
  if (!metadata) return null;

  return createOrGetState(metadata);
}

async function bootSocket(state: SessionState, reason: "manual" | "restore" | "reconnect" = "manual"): Promise<void> {
  if (state.connecting) return;

  state.connecting = true;
  state.manualStop = false;

  const generation = state.generation + 1;
  state.generation = generation;

  const sessionId = state.config.sessionId;

  try {
    await migrateLegacySessionDir(sessionId);
    await writeMetadata(state.config);
    const sessionDir = (await resolveSessionDir(sessionId)) || getSessionDir(sessionId);
    await ensureDir(sessionDir);

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      auth: authState,
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 120_000,
      defaultQueryTimeoutMs: 120_000,
    });

    state.socket = socket;
    state.status = "connecting";

    await emitWebhook(state, "connection_update", { status: "connecting", phone: state.config.phone || "" });

    socket.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (error) {
        logger.error({ sessionId, error: sanitizeError(error) }, "saveCreds failed");
      }
    });

    let pairingRequested = false;

    socket.ev.on("connection.update", async (update: Record<string, unknown>) => {
      if (state.generation !== generation) return;

      const connection = update.connection as string | undefined;
      const qr = update.qr as string | undefined;
      const lastDisconnect = update.lastDisconnect as { error?: unknown } | undefined;

      if (qr && state.config.authMethod !== "pairing") {
        try {
          const qrCode = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          state.status = "qr_code";
          await emitWebhook(state, "connection_update", {
            status: "qr_code",
            qrCode,
            phone: state.config.phone || "",
          });
        } catch (error) {
          logger.error({ sessionId, error: sanitizeError(error) }, "failed to render QR code");
        }
      }

      const isRegistered = Boolean((socket as unknown as { authState?: { creds?: { registered?: boolean } } }).authState?.creds?.registered);

      if (
        state.config.authMethod === "pairing" &&
        !pairingRequested &&
        !isRegistered &&
        state.config.phone
      ) {
        const now = Date.now();
        if (now >= state.pairingCooldownUntil) {
          pairingRequested = true;
          state.pairingCooldownUntil = now + 60_000;

          try {
            const code = await socket.requestPairingCode(normalizePairingPhone(state.config.phone));
            state.status = "pairing_code";
            await emitWebhook(state, "connection_update", {
              status: "pairing_code",
              pairingCode: code,
              phone: state.config.phone || "",
            });
          } catch (error) {
            pairingRequested = false;
            const errorMessage = sanitizeError(error);
            await emitWebhook(state, "connection_update", {
              status: "offline",
              errorMessage: `Erro ao gerar pairing code: ${errorMessage}`,
              phone: state.config.phone || "",
            });
          }
        }
      }

      if (connection === "open") {
        state.connecting = false;
        state.status = "online";
        state.reconnectAttempts = 0;

        await emitWebhook(state, "connection_update", {
          status: "online",
          phone: toPhoneFromJid((socket as unknown as { user?: { id?: string } }).user?.id) || state.config.phone || "",
        });

        try {
          await syncGroups(state);
        } catch (error) {
          logger.warn({ sessionId, error: sanitizeError(error) }, "automatic group sync failed");
        }

        return;
      }

      if (connection === "close") {
        const statusCode = extractDisconnectCode(lastDisconnect?.error);
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;

        state.socket = null;
        state.connecting = false;

        if (state.manualStop) {
          state.status = "offline";
          state.manualStop = false;
          await emitWebhook(state, "connection_update", { status: "offline", phone: state.config.phone || "" });
          return;
        }

        if (isLoggedOut) {
          state.status = "offline";
          state.reconnectAttempts = 0;
          await clearSessionAuth(sessionId);
          await emitWebhook(state, "connection_update", {
            status: "offline",
            errorMessage: "Sessão expirada ou logout no celular.",
            phone: state.config.phone || "",
          });
          return;
        }

        state.status = "connecting";
        if (!isRestartRequired) {
          state.reconnectAttempts += 1;
        }

        const delay = isRestartRequired
          ? 0
          : Math.min(30_000, 2_000 * (2 ** Math.max(0, state.reconnectAttempts - 1)));

        await emitWebhook(state, "connection_update", {
          status: "connecting",
          errorMessage: "Conexão perdida. Reconectando automaticamente.",
          phone: state.config.phone || "",
        });

        setTimeout(() => {
          const current = sessionStates.get(sessionId);
          if (!current) return;
          if (current.generation !== generation) return;
          bootSocket(current, "reconnect").catch((error) => {
            logger.error({ sessionId, error: sanitizeError(error) }, "reconnect failed");
          });
        }, delay);
      }
    });

    socket.ev.on("messages.upsert", async (upsert: Record<string, unknown>) => {
      if (state.generation !== generation) return;
      if (state.status !== "online" && state.status !== "connecting") {
        bumpIngestionDrop(state, `state_not_ready_${state.status}`);
        return;
      }

      const type = upsert.type as string | undefined;
      state.ingestion.upserts += 1;
      const allowedType = type === "notify" || type === "append";
      if (!allowedType) {
        bumpIngestionDrop(state, `upsert_type_${String(type || "unknown")}`);
        return;
      }

      const messages = (upsert.messages || []) as Array<{
        key?: { id?: string; remoteJid?: string; participant?: string; fromMe?: boolean };
        message?: proto.IMessage;
        messageTimestamp?: unknown;
        pushName?: string;
      }>;
      if (!Array.isArray(messages) || messages.length === 0) {
        bumpIngestionDrop(state, "upsert_without_messages");
        return;
      }

      for (const message of messages) {
        state.ingestion.messagesSeen += 1;
        const remoteJid = message.key?.remoteJid || "";
        if (!remoteJid.endsWith("@g.us")) {
          bumpIngestionDrop(state, "non_group_message");
          continue;
        }
        const fromMe = Boolean(message.key?.fromMe);
        if (fromMe) {
          bumpIngestionDrop(state, "from_me");
          continue;
        }

        const dedupeKey = buildInboundDedupeKey(message);
        if (!markInboundMessageSeen(state, dedupeKey)) {
          state.ingestion.duplicates += 1;
          bumpIngestionDrop(state, "duplicate_message_key");
          continue;
        }

        const text = extractMessageText(message.message).trim();
        const inboundMedia = extractInboundMediaInfo(message.message);
        const imagePayload = inboundMedia?.kind === "image"
          ? (inboundMedia.imagePayload || extractImagePayload(message.message))
          : null;
        logMediaCaptureDebug("incoming_summary", {
          sessionId,
          groupId: remoteJid,
          hasText: Boolean(text),
          textLength: text.length,
          hasMediaPayload: Boolean(inboundMedia),
          mediaKind: inboundMedia?.kind || "",
          hasImagePayload: Boolean(imagePayload),
          mimeTypeHint: imagePayload?.mimetype || inboundMedia?.mimetype || "",
          upsertType: type || "",
          dedupeKey,
        });
        if (!text && !inboundMedia) {
          bumpIngestionDrop(state, "empty_message_payload");
          continue;
        }

        const groupName = await resolveGroupName(state, remoteJid);
        let mediaData: Record<string, unknown> | null = null;

        const resolvedImage = await resolveInboundMediaAsImage({
          message,
          socket,
          sessionId,
          inboundMedia,
          imagePayload,
        });
        if (resolvedImage) {
          const stored = storeTemporaryImage(
            resolvedImage.buffer,
            state.config.userId,
            resolvedImage.mimeType || "image/jpeg",
          );
          logMediaCaptureDebug("incoming_image_stored", {
            sessionId,
            groupId: remoteJid,
            bytes: resolvedImage.buffer.length,
            mimeType: resolvedImage.mimeType || "image/jpeg",
            origin: resolvedImage.origin,
            tokenPrefix: stored.token.slice(0, 8),
          });
          mediaData = {
            kind: "image",
            token: stored.token,
            mimeType: resolvedImage.mimeType || "image/jpeg",
            fileName: stored.fileName,
            sourcePlatform: "whatsapp",
          };
        } else if (inboundMedia) {
          logMediaCaptureDebug("incoming_image_download_failed", {
            sessionId,
            groupId: remoteJid,
            hasText: Boolean(text),
            textLength: text.length,
            mediaKind: inboundMedia.kind,
            mimeTypeHint: imagePayload?.mimetype || inboundMedia.mimetype || "",
          });
          logger.warn(
            { sessionId, groupId: remoteJid, mediaKind: inboundMedia.kind },
            "incoming media detected but no image payload could be extracted",
          );
        }

        logMediaCaptureDebug("webhook_emit_message_received", {
          sessionId,
          groupId: remoteJid,
          hasText: Boolean(text),
          textLength: text.length,
          hasMedia: Boolean(mediaData),
          mediaTokenPrefix: typeof mediaData?.token === "string" ? mediaData.token.slice(0, 8) : "",
        });
        await emitWebhook(state, "message_received", {
          from: message.pushName || message.key?.participant || remoteJid,
          message: text,
          groupId: remoteJid,
          groupName,
          hasMedia: Boolean(inboundMedia),
          mediaKind: inboundMedia?.kind || undefined,
          mediaMimeType: inboundMedia?.mimetype || undefined,
          media: mediaData || undefined,
        });
        bumpIngestionAccepted(state);
      }
    });

    socket.ev.on("groups.update", async (updates) => {
      if (state.generation !== generation) return;
      for (const update of (updates as Array<{ id?: string; subject?: string }>)) {
        const jid = update.id;
        if (!jid || !update.subject) continue;
        // Invalidate in-memory cache so subsequent message_received events use the new name.
        state.groupNames.set(jid, update.subject);
        await emitWebhook(state, "group_name_update", { id: jid, name: update.subject });
      }
    });

    logger.info({ sessionId, reason }, "session socket started");
  } catch (error) {
    state.connecting = false;
    state.status = "offline";
    logger.error({ sessionId, error: sanitizeError(error) }, "failed to boot socket");

    await emitWebhook(state, "connection_update", {
      status: "offline",
      errorMessage: sanitizeError(error),
      phone: state.config.phone || "",
    });

    throw error;
  }
}

async function startSession(config: SessionConfig, reason: "manual" | "restore" | "reconnect" = "manual"): Promise<SessionState> {
  const normalized: SessionConfig = {
    sessionId: config.sessionId,
    userId: config.userId,
    webhookUrl: config.webhookUrl,
    phone: config.phone || "",
    authMethod: config.authMethod === "pairing" ? "pairing" : "qr",
    sessionName: config.sessionName || config.sessionId,
  };

  const state = await createOrGetState(normalized);
  state.config = normalized;
  await writeMetadata(normalized);

  if (state.socket && ["connecting", "qr_code", "pairing_code", "online"].includes(state.status)) {
    logger.info({ sessionId: state.config.sessionId, status: state.status, reason }, "session already active; skipped socket restart");
    return state;
  }

  await bootSocket(state, reason);
  return state;
}

function safeCompare(a: string, b: string): boolean {
  const key = Buffer.alloc(32);
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

const insecureSecretBypass = !WEBHOOK_SECRET && NODE_ENV !== "production" && ALLOW_INSECURE_NO_SECRET;

if (!WEBHOOK_SECRET && !insecureSecretBypass) {
  throw new Error("WEBHOOK_SECRET is required. To bypass only in development, set ALLOW_INSECURE_NO_SECRET=true.");
}

if (insecureSecretBypass) {
  logger.warn("WEBHOOK_SECRET not set — insecure development bypass is enabled via ALLOW_INSECURE_NO_SECRET=true.");
}

if (WEBHOOK_SECRET && WEBHOOK_SECRET.toLowerCase() === "change-me" && NODE_ENV === "production") {
  throw new Error("WEBHOOK_SECRET is set to the default placeholder 'change-me'. Set a strong secret before running in production.");
}
if (WEBHOOK_SECRET && WEBHOOK_SECRET.toLowerCase() === "change-me") {
  logger.warn("WEBHOOK_SECRET is set to the default placeholder 'change-me' — replace it with a strong secret.");
}

function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  if (!WEBHOOK_SECRET) {
    if (insecureSecretBypass) {
      next();
      return;
    }
    res.status(403).json({ error: "Forbidden: WEBHOOK_SECRET not configured" });
    return;
  }

  const received = req.header("x-webhook-secret") || "";
  if (!safeCompare(received, WEBHOOK_SECRET)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}

// Validate outbound webhook URL against internal/private network addresses (SSRF prevention)
function isAllowedWebhookUrl(url: string): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|::1$|0\.0\.0\.0$)/i.test(host)) return false;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    return true;
  } catch {
    return false;
  }
}

function readRequestUserId(req: Request<any, any, any, any>, res: Response): string | null {
  const userId = String(req.header("x-autolinks-user-id") || "").trim();
  if (!userId) {
    res.status(400).json({ error: "x-autolinks-user-id é obrigatório" });
    return null;
  }
  return userId;
}

app.get("/health", (req, res) => {
  // Determine whether the caller is authenticated.
  const received = req.header("x-webhook-secret") || "";
  const authenticated = WEBHOOK_SECRET
    ? (received.length > 0 && safeCompare(received, WEBHOOK_SECRET))
    : insecureSecretBypass;

  if (authenticated) {
    // Full session detail — only for trusted callers.
    const sessions = Array.from(sessionStates.values()).map((state) => ({
      sessionId: state.config.sessionId,
      userId: state.config.userId,
      status: state.status,
      reconnectAttempts: state.reconnectAttempts,
      queuedEvents: state.events.length,
      ingestion: {
        upserts: state.ingestion.upserts,
        messagesSeen: state.ingestion.messagesSeen,
        accepted: state.ingestion.accepted,
        duplicates: state.ingestion.duplicates,
        dropped: { ...state.ingestion.dropped },
        lastAcceptedAt: state.ingestion.lastAcceptedAt,
        lastDroppedAt: state.ingestion.lastDroppedAt,
        lastDropReason: state.ingestion.lastDropReason,
      },
    }));
    res.json({ ok: true, uptimeSec: Math.floor(process.uptime()), sessions });
  } else {
    // Unauthenticated: return only aggregate counts — no PII.
    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      sessionCount: sessionStates.size,
    });
  }
});

app.use("/api", requireWebhookSecret);

app.get("/api/media/:token", async (req: Request<{ token: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const token = req.params.token;
  const item = mediaStore.get(token);
  if (!item) {
    res.status(404).json({ error: "Mídia temporária não encontrada" });
    return;
  }

  if (item.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  res.json({
    ok: true,
    token: item.token,
    mimeType: item.mimeType,
    fileName: item.fileName,
    base64: item.data.toString("base64"),
    createdAt: item.createdAt,
    deleteAt: item.deleteAt,
  });
});

app.post("/api/media/:token/schedule-delete", async (req: Request<{ token: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const token = req.params.token;
  const item = mediaStore.get(token);
  if (!item) {
    res.status(404).json({ error: "Mídia temporária não encontrada" });
    return;
  }
  if (item.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  const delayMsRaw = Number(req.body?.delayMs);
  const delayMs = Number.isFinite(delayMsRaw) ? delayMsRaw : 120_000;
  const ok = scheduleMediaDeletion(token, delayMs);
  if (!ok) {
    res.status(404).json({ error: "Mídia temporária não encontrada" });
    return;
  }

  res.json({ ok: true, token, deleteInMs: delayMs });
});

app.get("/api/sessions/:sessionId/events", async (req: Request<{ sessionId: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;
  const clear = req.query.clear !== "false";

  try {
    const state = await loadStateFromDisk(sessionId);
    if (!state) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    if (state.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    const events = [...state.events];
    if (clear && events.length > 0) {
      const eventIds = new Set(
        events
          .map((item) => String(item?.id || "").trim())
          .filter(Boolean),
      );
      res.on("finish", () => {
        if (eventIds.size === 0) return;
        state.events = state.events.filter((item) => !eventIds.has(String(item?.id || "").trim()));
      });
    }

    res.json({ ok: true, events });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error) });
  }
});

app.post("/api/sessions/:sessionId/connect", async (req: Request<{ sessionId: string }, unknown, ConnectBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;
  const { userId, webhookUrl = "", phone = "", authMethod = "qr", sessionName } = req.body || {};

  if (!sessionId || !userId) {
    res.status(400).json({ error: "sessionId e userId são obrigatórios" });
    return;
  }

  if (userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
    res.status(400).json({ error: "webhookUrl inválida ou aponta para endereço interno não permitido" });
    return;
  }

  try {
    const existing = await loadStateFromDisk(sessionId);
    if (existing && existing.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    await startSession({
      sessionId,
      userId,
      webhookUrl,
      phone,
      authMethod,
      sessionName: sessionName || sessionId,
    });

    res.json({ ok: true, status: "connecting" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error) });
  }
});

app.post("/api/sessions/:sessionId/disconnect", async (req: Request<{ sessionId: string }, unknown, ConnectBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;

  try {
    const state = await loadStateFromDisk(sessionId);

    if (!state) {
      await removeSessionCompletely(sessionId);
      res.json({ ok: true, status: "offline" });
      return;
    }

    if (state.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    state.manualStop = true;
    state.reconnectAttempts = 0;
    state.generation += 1;

    const socket = state.socket;
    state.socket = null;
    state.status = "offline";

    if (socket) {
      try {
        socket.ev.removeAllListeners("creds.update");
        socket.ev.removeAllListeners("connection.update");
        socket.ev.removeAllListeners("messages.upsert");
        await socket.logout();
      } catch (error) {
        logger.warn({ sessionId, error: sanitizeError(error) }, "error while disconnecting socket");
      }
    }

    await emitWebhook(state, "connection_update", { status: "offline", phone: state.config.phone || "" });
    await removeSessionCompletely(sessionId);

    res.json({ ok: true, status: "offline" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error) });
  }
});

app.post("/api/sessions/:sessionId/sync-groups", async (req: Request<{ sessionId: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;

  try {
    const state = await loadStateFromDisk(sessionId);
    if (!state || !state.socket || state.status !== "online") {
      res.status(409).json({ error: "Sessão não está online" });
      return;
    }

    if (state.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    const result = await syncGroups(state);
    res.json({ ok: true, groups: result.groups, count: result.count });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error) });
  }
});

app.post("/api/sessions/:sessionId/group-invite", async (req: Request<{ sessionId: string }, unknown, { groupId?: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;
  const rawGroupId = String(req.body?.groupId ?? "").trim();
  if (!rawGroupId) {
    res.status(400).json({ error: "groupId é obrigatório" });
    return;
  }

  const normalizedGroupId = normalizeJid(rawGroupId);
  if (!normalizedGroupId.endsWith("@g.us")) {
    res.status(400).json({ error: "groupId inválido para grupo do WhatsApp" });
    return;
  }

  try {
    const state = await loadStateFromDisk(sessionId);
    if (!state || !state.socket || state.status !== "online") {
      res.status(409).json({ error: "Sessão não está online" });
      return;
    }

    if (state.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    const inviteCode = String(await state.socket.groupInviteCode(normalizedGroupId) || "").trim();
    if (!inviteCode) {
      res.status(404).json({ error: "Convite não disponível para este grupo" });
      return;
    }

    res.json({
      ok: true,
      groupId: normalizedGroupId,
      inviteCode,
      inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
    });
  } catch (error) {
    const message = sanitizeError(error);
    if (/not-authorized|forbidden|401|403|admin/i.test(message)) {
      res.status(403).json({ error: "Sem permissão para obter convite deste grupo" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/send-message", async (req: Request<unknown, unknown, SendBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const { sessionId, jid, content, media } = req.body || {};
  const messageContent = typeof content === "string" ? content : "";
  const hasImageMedia = media?.kind === "image";

  if (!sessionId || !jid || (!messageContent.trim() && !hasImageMedia)) {
    res.status(400).json({ error: "sessionId e jid são obrigatórios, com content ou media de imagem" });
    return;
  }

  try {
    const state = await loadStateFromDisk(sessionId);
    if (!state || !state.socket || state.status !== "online") {
      res.status(409).json({ error: "Sessão não está online" });
      return;
    }

    if (state.config.userId !== requestUserId) {
      res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
      return;
    }

    const targetJid = normalizeJid(jid);
    const mediaKind = media?.kind === "image" ? "image" : "";
    const sendKey = buildSendDedupKey({
      sessionId,
      jid: targetJid,
      content: messageContent,
      media,
    });

    const existing = inFlightSends.get(sendKey);
    if (existing) {
      const deduplicated = await existing;
      res.json({ ok: true, id: deduplicated.id, deduplicated: true });
      return;
    }

    const sendPromise: Promise<SendResponsePayload> = (async () => {
      let sendResult: any;

      if (mediaKind === "image") {
        let imageBuffer: Buffer | null = null;
        let imageMimeType = media?.mimeType || "image/jpeg";

        if (media?.token) {
          const item = mediaStore.get(media.token);
          if (!item) {
            throw new Error("Mídia temporária não encontrada para envio");
          }
          if (item.userId !== state.config.userId) {
            throw new Error("Mídia temporária não pertence ao usuário da sessão");
          }
          imageBuffer = item.data;
          imageMimeType = item.mimeType || imageMimeType;
        } else if (media?.base64) {
          imageBuffer = Buffer.from(media.base64, "base64");
        }

        if (!imageBuffer || imageBuffer.length === 0) {
          throw new Error("Imagem invalida para envio");
        }

        sendResult = await state.socket!.sendMessage(targetJid, {
          image: imageBuffer,
          caption: messageContent,
          mimetype: imageMimeType,
        });
      } else {
        sendResult = await state.socket!.sendMessage(targetJid, { text: messageContent });
      }

      const groupName = targetJid.endsWith("@g.us") ? await resolveGroupName(state, targetJid) : undefined;

      await emitWebhook(state, "message_sent", {
        to: targetJid,
        groupName,
        messageType: mediaKind === "image" ? "image" : "text",
        message: messageContent,
      });

      return { id: sendResult?.key?.id || null };
    })();

    inFlightSends.set(sendKey, sendPromise);

    try {
      const result = await sendPromise;
      res.json({ ok: true, id: result.id });
    } finally {
      if (inFlightSends.get(sendKey) === sendPromise) {
        inFlightSends.delete(sendKey);
      }
    }
  } catch (error) {
    const message = sanitizeError(error);
    if (message === "Mídia temporária não encontrada para envio") {
      res.status(404).json({ error: message });
      return;
    }
    if (message === "Mídia temporária não pertence ao usuário da sessão") {
      res.status(403).json({ error: message });
      return;
    }
    if (message === "Imagem invalida para envio") {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

async function restoreSessionsOnStartup(): Promise<void> {
  await ensureDir(SESSIONS_ROOT);
  const entries = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true }).catch(() => []);
  const sessionIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = parseSessionIdFromDirName(entry.name);
    if (sessionId) sessionIds.add(sessionId);
  }

  for (const sessionId of sessionIds) {
    const metadata = await readMetadata(sessionId);
    if (!metadata) continue;

    try {
      await startSession(metadata, "restore");
      logger.info({ sessionId: metadata.sessionId }, "session restored from disk");
    } catch (error) {
      logger.error({ sessionId: metadata.sessionId, error: sanitizeError(error) }, "failed to restore session");
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down whatsapp service");

  for (const state of sessionStates.values()) {
    state.manualStop = true;
    state.generation += 1;
    state.connecting = false;

    if (state.socket) {
      state.socket.ev.removeAllListeners("creds.update");
      state.socket.ev.removeAllListeners("connection.update");
      state.socket.ev.removeAllListeners("messages.upsert");
      state.socket = null;
    }

    await writeMetadata(state.config).catch(() => undefined);
  }

  await new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });

  process.exit(0);
}

async function main() {
  startMediaCleanupLoop();
  await restoreSessionsOnStartup();

  httpServer = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, sessionsRoot: SESSIONS_ROOT }, "whatsapp baileys service online");
  });

  httpServer.on("error", (error) => {
    logger.error({ error: sanitizeError(error), host: HOST, port: PORT }, "failed to bind whatsapp service");
    process.exit(1);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

main().catch((error) => {
  logger.error({ error: sanitizeError(error) }, "fatal startup error");
  process.exit(1);
});
