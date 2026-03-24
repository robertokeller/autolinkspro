import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pino from "pino";
import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

type SessionStatus = "offline" | "connecting" | "awaiting_code" | "awaiting_password" | "online";

interface SessionConfig {
  sessionId: string;
  userId: string;
  phone: string;
  webhookUrl?: string;
  apiId: number;
  apiHash: string;
}

interface SessionMetadata extends SessionConfig {
  sessionString: string;
}

interface SessionState {
  config: SessionConfig;
  client: TelegramClient | null;
  sessionString: string;
  status: SessionStatus;
  lastAuthCallbackError: string;
  authFlow: Promise<void> | null;
  codeResolver: ((value: string) => void) | null;
  codeRejecter: ((reason?: unknown) => void) | null;
  passwordResolver: ((value: string) => void) | null;
  passwordRejecter: ((reason?: unknown) => void) | null;
  heartbeatTimer: NodeJS.Timeout | null;
  messageHandlerBound: boolean;
  manualStop: boolean;
  recentInboundMessageKeys: Map<string, number>;
  ingestion: {
    updatesSeen: number;
    messagesSeen: number;
    accepted: number;
    duplicates: number;
    dropped: Record<string, number>;
    lastAcceptedAt: string | null;
    lastDroppedAt: string | null;
    lastDropReason: string;
  };
  events: Array<{
    id: string;
    event: string;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
}

interface ActionBody {
  sessionId?: string;
  userId?: string;
  phone?: string;
  webhookUrl?: string;
  apiId?: string | number;
  apiHash?: string;
  sessionString?: string;
  code?: string;
  password?: string;
  clearSession?: boolean;
}

interface SendMessageBody {
  sessionId?: string;
  chatId?: string;
  message?: string;
  media?: {
    kind?: "image";
    token?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
  };
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "3112");
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "12mb";
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_INSECURE_NO_SECRET = process.env.ALLOW_INSECURE_NO_SECRET === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const MEDIA_CAPTURE_DEBUG = new Set(["1", "true", "yes", "on"]).has(
  String(process.env.MEDIA_CAPTURE_DEBUG || process.env.ROUTE_MEDIA_DEBUG || "").trim().toLowerCase(),
);
const SESSIONS_ROOT = path.resolve(process.env.TELEGRAM_SESSIONS_DIR || path.join(process.cwd(), ".sessions"));
const SESSION_DIR_PREFIX = "tg_";
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const AUTO_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_AUTO_IMAGE_FILE_NAME = "route_image.jpg";
const OUTBOUND_ECHO_WINDOW_MS = Math.max(10_000, Number(process.env.TELEGRAM_OUTBOUND_ECHO_WINDOW_MS || "120000"));
// Telegram API credentials — stored in the service .env, never in the frontend bundle
const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID ?? 0);
const DEFAULT_API_HASH = String(process.env.TELEGRAM_API_HASH ?? "");

const logger = pino({ level: LOG_LEVEL });
const app = express();
const sessionStates = new Map<string, SessionState>();
const inFlightSends = new Map<string, Promise<{ id: number | null }>>();
const mediaStore = new Map<string, {
  token: string;
  userId: string;
  data: Buffer;
  mimeType: string;
  fileName: string;
  createdAt: number;
  deleteAt: number | null;
}>();
const recentOutboundEchoes = new Map<string, number>();
let httpServer: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;
const MAX_SESSION_EVENTS = Math.max(200, Number(process.env.MAX_SESSION_EVENTS || "2000"));
const TELEGRAM_INBOUND_DEDUPE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.TELEGRAM_INBOUND_DEDUPE_WINDOW_MS || "900000"),
);
const TELEGRAM_INBOUND_DEDUPE_MAX_KEYS = Math.max(
  500,
  Number(process.env.TELEGRAM_INBOUND_DEDUPE_MAX_KEYS || "5000"),
);

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

// --- Security headers -----------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

// --- Rate limiting (in-memory, per IP) -----------------------------------
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_REQUESTS = 300;
const RATE_LIMIT_TRUSTED_REQUESTS = 1200;
const RATE_LIMIT_WINDOW_MS = 60_000;

function isTrustedInternalRequest(req: Request): boolean {
  if (!WEBHOOK_SECRET) return insecureSecretBypass;
  const received = req.header("x-webhook-secret") || "";
  return received.length > 0 && safeCompare(received, WEBHOOK_SECRET);
}

function getRateLimitKey(req: Request): { key: string; trusted: boolean } {
  const trusted = isTrustedInternalRequest(req);
  const scopedUserId = trusted ? String(req.header("x-autolinks-user-id") || "").trim() : "";
  if (scopedUserId) {
    return { key: `user:${scopedUserId}`, trusted: true };
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return { key: `ip:${ip}`, trusted };
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    next();
    return;
  }
  const { key, trusted } = getRateLimitKey(req);
  const limit = trusted ? RATE_LIMIT_TRUSTED_REQUESTS : RATE_LIMIT_REQUESTS;
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
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

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

function pruneRecentInboundKeys(state: SessionState, nowMs: number): void {
  for (const [key, seenAt] of state.recentInboundMessageKeys.entries()) {
    if (nowMs - seenAt > TELEGRAM_INBOUND_DEDUPE_WINDOW_MS) {
      state.recentInboundMessageKeys.delete(key);
    }
  }

  if (state.recentInboundMessageKeys.size <= TELEGRAM_INBOUND_DEDUPE_MAX_KEYS) return;
  const overflow = state.recentInboundMessageKeys.size - TELEGRAM_INBOUND_DEDUPE_MAX_KEYS;
  if (overflow <= 0) return;
  const ordered = [...state.recentInboundMessageKeys.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < overflow && i < ordered.length; i += 1) {
    state.recentInboundMessageKeys.delete(ordered[i][0]);
  }
}

function markInboundMessageSeen(state: SessionState, dedupeKey: string): boolean {
  const key = String(dedupeKey || "").trim();
  if (!key) return true;
  const nowMs = Date.now();
  pruneRecentInboundKeys(state, nowMs);
  if (state.recentInboundMessageKeys.has(key)) {
    return false;
  }
  state.recentInboundMessageKeys.set(key, nowMs);
  return true;
}

function isFatalAuthError(error: unknown): boolean {
  const message = sanitizeError(error).toUpperCase();
  return [
    "API_ID_INVALID",
    "API_HASH_INVALID",
    "PHONE_NUMBER_INVALID",
    "PHONE_NUMBER_BANNED",
    "USER_DEACTIVATED",
    "AUTH_KEY_UNREGISTERED",
    "SESSION_REVOKED",
  ].some((token) => message.includes(token));
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

function normalizePhone(phone: string): string {
  return phone.trim();
}

async function readMetadata(sessionId: string): Promise<SessionMetadata | null> {
  for (const sessionDir of getSessionDirCandidates(sessionId)) {
    try {
      const raw = await fs.readFile(path.join(sessionDir, "metadata.json"), "utf-8");
      const parsed = JSON.parse(raw) as SessionMetadata;

      if (!parsed.sessionId || !parsed.userId || !parsed.apiId || !parsed.apiHash) {
        continue;
      }

      return {
        sessionId: parsed.sessionId,
        userId: parsed.userId,
        phone: parsed.phone || "",
        webhookUrl: parsed.webhookUrl || "",
        apiId: Number(parsed.apiId),
        apiHash: parsed.apiHash,
        sessionString: parsed.sessionString || "",
      };
    } catch {
      // try next path candidate
    }
  }

  return null;
}

async function writeMetadata(state: SessionState): Promise<void> {
  await migrateLegacySessionDir(state.config.sessionId);
  const metadata: SessionMetadata = {
    ...state.config,
    sessionString: state.sessionString || "",
  };

  const metadataPath = getMetadataPath(state.config.sessionId);
  await ensureDir(path.dirname(metadataPath));
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

async function removeMetadata(sessionId: string): Promise<void> {
  for (const sessionDir of getSessionDirCandidates(sessionId)) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

async function emitConnectionUpdate(
  state: SessionState,
  status: SessionStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  state.status = status;

  await emitWebhook(state, "connection_update", {
    status,
    phone: state.config.phone,
    ...extra,
  });
}

function getEntityName(entity: unknown, fallback: string): string {
  const maybe = entity as Record<string, unknown>;

  if (typeof maybe.title === "string" && maybe.title.trim()) {
    return maybe.title;
  }

  if (typeof maybe.firstName === "string" && maybe.firstName.trim()) {
    const lastName = typeof maybe.lastName === "string" ? maybe.lastName : "";
    return `${maybe.firstName}${lastName ? ` ${lastName}` : ""}`.trim();
  }

  if (typeof maybe.username === "string" && maybe.username.trim()) {
    return `@${maybe.username}`;
  }

  return fallback;
}

function isGroupLike(entity: unknown): boolean {
  const maybe = entity as { className?: string };
  return maybe?.className === "Channel" || maybe?.className === "Chat";
}

function formatEntityId(entity: unknown): string {
  const maybe = entity as { className?: string; id?: bigint | number | string };
  const idRaw = maybe.id;

  if (idRaw === undefined || idRaw === null) return "";

  const id = typeof idRaw === "bigint" ? idRaw.toString() : String(idRaw);

  if (maybe.className === "Channel") {
    return `-100${id}`;
  }

  if (maybe.className === "Chat") {
    return `-${id}`;
  }

  return id;
}

function formatPeerId(peerId: unknown): string {
  const maybe = peerId as { className?: string; channelId?: bigint | number | string; chatId?: bigint | number | string };
  if (maybe.className === "PeerChannel" && maybe.channelId != null) {
    return `-100${String(maybe.channelId)}`;
  }
  if (maybe.className === "PeerChat" && maybe.chatId != null) {
    return `-${String(maybe.chatId)}`;
  }
  return "";
}

function readTelegramMediaMimeType(media: unknown): string {
  if (!media || typeof media !== "object") return "";
  const row = media as Record<string, unknown>;
  if (typeof row.mimeType === "string" && row.mimeType.trim()) {
    return row.mimeType.trim().toLowerCase();
  }
  const document = row.document;
  if (document && typeof document === "object") {
    const doc = document as Record<string, unknown>;
    if (typeof doc.mimeType === "string" && doc.mimeType.trim()) {
      return doc.mimeType.trim().toLowerCase();
    }
  }
  return "";
}

type TelegramInboundMediaKind = "image" | "video" | "audio" | "voice" | "sticker" | "document" | "other";

type TelegramInboundMediaInfo = {
  kind: TelegramInboundMediaKind;
  mimeType: string;
};

function classifyTelegramDocumentMimeType(mimeTypeRaw: string): TelegramInboundMediaKind {
  const mimeType = String(mimeTypeRaw || "").trim().toLowerCase();
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/ogg")) return "voice";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/x-tgsticker" || mimeType === "image/webp") return "sticker";
  return "document";
}

function extractTelegramMediaInfo(media: unknown): TelegramInboundMediaInfo | null {
  if (!media || typeof media !== "object") return null;
  const row = media as Record<string, unknown>;
  const className = String(row.className || "").trim();
  if (className === "MessageMediaPhoto") {
    return { kind: "image", mimeType: readTelegramMediaMimeType(media) || "image/jpeg" };
  }
  if (className === "MessageMediaDocument") {
    const mimeType = readTelegramMediaMimeType(media);
    return { kind: classifyTelegramDocumentMimeType(mimeType), mimeType };
  }
  if (className.startsWith("MessageMedia")) {
    return { kind: "other", mimeType: readTelegramMediaMimeType(media) };
  }
  return null;
}

function isTelegramImageMedia(media: unknown): boolean {
  const info = extractTelegramMediaInfo(media);
  return Boolean(info && info.kind === "image");
}

function hasTelegramMedia(media: unknown): boolean {
  return Boolean(extractTelegramMediaInfo(media));
}

function coerceBinaryToBuffer(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) {
    if (value.length === 0) return null;
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    try {
      const asNumbers = value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
      if (!asNumbers || value.length === 0) return null;
      return Buffer.from(value as number[]);
    } catch {
      return null;
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const dataUri = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
    const base64Payload = (dataUri ? dataUri[1] : trimmed).replace(/\s+/g, "");
    if (!base64Payload || base64Payload.length < 16) return null;
    if (!/^[a-z0-9+/=]+$/i.test(base64Payload)) return null;
    try {
      const decoded = Buffer.from(base64Payload, "base64");
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return coerceBinaryToBuffer(row.bytes ?? row.data ?? row.buffer ?? row.thumbnail ?? row.jpegThumbnail);
  }
  return null;
}

function extractTelegramThumbnailBuffer(media: unknown): Buffer | null {
  if (!media || typeof media !== "object") return null;
  const stack: unknown[] = [media];
  const visited = new Set<object>();
  const thumbnailKeys = new Set(["thumb", "thumbs", "thumbnail", "jpegThumbnail", "strippedThumb", "bytes"]);

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

function shouldAttemptTelegramMediaDownloadForImage(info: TelegramInboundMediaInfo | null): boolean {
  if (!info) return false;
  if (info.kind === "image" || info.kind === "sticker") return true;
  return info.mimeType.startsWith("image/");
}

async function downloadIncomingTelegramImageBuffer(args: {
  client: TelegramClient;
  message: Api.Message;
  media: unknown;
  sessionId: string;
}): Promise<Buffer | null> {
  const { client, message, media, sessionId } = args;
  const attempts: Array<() => Promise<unknown>> = [
    () => client.downloadMedia(message, {}),
    () => client.downloadMedia(media as Api.TypeMessageMedia, {}),
  ];

  for (const attempt of attempts) {
    try {
      const downloaded = await attempt();
      if (Buffer.isBuffer(downloaded) && downloaded.length > 0 && downloaded.length <= AUTO_IMAGE_MAX_BYTES) {
        return downloaded;
      }
    } catch (error) {
      logger.warn({ sessionId, error: sanitizeError(error) }, "failed to download incoming telegram image on one attempt");
    }
  }

  return null;
}

async function resolveTelegramInboundImage(args: {
  client: TelegramClient;
  message: Api.Message;
  media: unknown;
  mediaInfo: TelegramInboundMediaInfo | null;
  sessionId: string;
}): Promise<{ buffer: Buffer; mimeType: string; origin: "full_media" | "thumbnail" } | null> {
  const { client, message, media, mediaInfo, sessionId } = args;

  const thumb = extractTelegramThumbnailBuffer(media);
  if (thumb && thumb.length > 0) {
    const thumbMime = detectImageMimeTypeFromBuffer(thumb) || "image/jpeg";
    return {
      buffer: thumb,
      mimeType: thumbMime,
      origin: "thumbnail",
    };
  }

  if (!shouldAttemptTelegramMediaDownloadForImage(mediaInfo)) return null;
  const downloaded = await downloadIncomingTelegramImageBuffer({
    client,
    message,
    media,
    sessionId,
  });
  if (!downloaded || downloaded.length === 0) return null;

  const detectedMime = detectImageMimeTypeFromBuffer(downloaded);
  const hintMime = String(mediaInfo?.mimeType || "").trim().toLowerCase();
  const mimeType = detectedMime || (hintMime.startsWith("image/") ? hintMime : "image/jpeg");
  return {
    buffer: downloaded,
    mimeType,
    origin: "full_media",
  };
}

function parseChatTarget(chatId: string): string {
  return chatId.trim();
}

function normalizeEchoText(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, 2048);
}

function makeOutboundEchoKey(sessionId: string, groupId: string, message: string, hasImage: boolean): string {
  return `${sessionId}|${groupId}|${normalizeEchoText(message)}|${hasImage ? "image" : "text"}`;
}

function pruneOutboundEchoes(nowMs: number): void {
  for (const [key, expiresAt] of recentOutboundEchoes.entries()) {
    if (expiresAt <= nowMs) {
      recentOutboundEchoes.delete(key);
    }
  }
}

function rememberOutboundEcho(sessionId: string, groupId: string, message: string, hasImage: boolean): void {
  const nowMs = Date.now();
  pruneOutboundEchoes(nowMs);
  recentOutboundEchoes.set(
    makeOutboundEchoKey(sessionId, groupId, message, hasImage),
    nowMs + OUTBOUND_ECHO_WINDOW_MS,
  );
}

function isRecentOutboundEcho(sessionId: string, groupId: string, message: string, hasImage: boolean): boolean {
  const nowMs = Date.now();
  const key = makeOutboundEchoKey(sessionId, groupId, message, hasImage);
  const expiresAt = recentOutboundEchoes.get(key);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= nowMs) {
    recentOutboundEchoes.delete(key);
    return false;
  }
  return true;
}

function extractUrlsFromMessage(message: string): string[] {
  const rawMatches = message.match(URL_REGEX) || [];
  const urls: string[] = [];

  for (const raw of rawMatches) {
    const normalized = raw.replace(/[),.!?]+$/g, "").trim();
    if (!normalized) continue;
    if (!/^https?:\/\//i.test(normalized)) continue;
    if (urls.includes(normalized)) continue;
    urls.push(normalized);
  }

  return urls;
}

function mimeTypeToFileExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/bmp") return "bmp";
  if (normalized === "image/tiff") return "tiff";
  return "jpg";
}

function detectImageMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

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

  return null;
}

function generateMediaToken(): string {
  return `tgm_${randomBytes(18).toString("hex")}`;
}

function storeTemporaryImage(
  buffer: Buffer,
  userId: string,
  mimeType: string,
  fileName?: string,
): { token: string; fileName: string } {
  const token = generateMediaToken();
  const nowMs = Date.now();
  const safeMimeType = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  const extension = mimeTypeToFileExtension(safeMimeType);
  const rawName = (fileName || DEFAULT_AUTO_IMAGE_FILE_NAME).trim();
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(rawName);
  const finalFileName = hasExtension ? rawName : `${rawName || "route_image"}.${extension}`;

  mediaStore.set(token, {
    token,
    userId,
    data: buffer,
    mimeType: safeMimeType,
    fileName: finalFileName,
    createdAt: nowMs,
    deleteAt: null,
  });

  return { token, fileName: finalFileName };
}

function scheduleMediaDeletion(token: string, delayMs = 120_000): boolean {
  const current = mediaStore.get(token);
  if (!current) return false;
  const deleteAt = Date.now() + Math.max(1_000, Number(delayMs) || 120_000);
  current.deleteAt = deleteAt;
  mediaStore.set(token, current);
  return true;
}

setInterval(() => {
  const nowMs = Date.now();
  for (const [token, item] of mediaStore.entries()) {
    if (item.deleteAt && item.deleteAt <= nowMs) {
      mediaStore.delete(token);
    }
  }
}, 30_000).unref();

function getFileNameFromUrl(imageUrl: string, mimeType: string): string {
  try {
    const parsed = new URL(imageUrl);
    const nameFromPath = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const safeName = nameFromPath.replace(/[^a-zA-Z0-9._-]/g, "");
    if (safeName && /\.[a-zA-Z0-9]+$/.test(safeName)) {
      return safeName;
    }

    const ext = mimeTypeToFileExtension(mimeType);
    if (safeName) {
      return `${safeName}.${ext}`;
    }

    return DEFAULT_AUTO_IMAGE_FILE_NAME;
  } catch {
    return DEFAULT_AUTO_IMAGE_FILE_NAME;
  }
}

async function downloadImageFromUrl(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > AUTO_IMAGE_MAX_BYTES) {
      return null;
    }

    const mimeTypeHeader = response.headers.get("content-type") || "";
    const mimeTypeFromHeader = mimeTypeHeader.split(";")[0].trim().toLowerCase();
    if (mimeTypeFromHeader && !mimeTypeFromHeader.startsWith("image/")) {
      return null;
    }

    const binary = await response.arrayBuffer();
    const buffer = Buffer.from(binary);
    if (!buffer.length || buffer.length > AUTO_IMAGE_MAX_BYTES) {
      return null;
    }

    const mimeTypeFromSignature = detectImageMimeTypeFromBuffer(buffer);
    if (!mimeTypeFromSignature && !mimeTypeFromHeader.startsWith("image/")) {
      return null;
    }

    const effectiveMimeType = mimeTypeFromSignature || mimeTypeFromHeader || "image/jpeg";
    const fileName = getFileNameFromUrl(response.url || imageUrl, effectiveMimeType);
    return { buffer, mimeType: effectiveMimeType, fileName };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function removeUrlFromMessage(message: string, imageUrl: string): string {
  return message
    .split(imageUrl)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createOrGetState(config: SessionConfig, sessionString = ""): SessionState {
  const existing = sessionStates.get(config.sessionId);
  if (existing) {
    existing.config = config;
    if (sessionString) existing.sessionString = sessionString;
    return existing;
  }

  const state: SessionState = {
    config,
    client: null,
    sessionString,
    status: "offline",
    lastAuthCallbackError: "",
    authFlow: null,
    codeResolver: null,
    codeRejecter: null,
    passwordResolver: null,
    passwordRejecter: null,
    heartbeatTimer: null,
    messageHandlerBound: false,
    manualStop: false,
    recentInboundMessageKeys: new Map<string, number>(),
    ingestion: {
      updatesSeen: 0,
      messagesSeen: 0,
      accepted: 0,
      duplicates: 0,
      dropped: {},
      lastAcceptedAt: null,
      lastDroppedAt: null,
      lastDropReason: "",
    },
    events: [],
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

  return createOrGetState(
    {
      sessionId: metadata.sessionId,
      userId: metadata.userId,
      phone: metadata.phone,
      webhookUrl: metadata.webhookUrl,
      apiId: metadata.apiId,
      apiHash: metadata.apiHash,
    },
    metadata.sessionString,
  );
}

function resetAuthResolvers(state: SessionState): void {
  state.codeResolver = null;
  state.codeRejecter = null;
  state.passwordResolver = null;
  state.passwordRejecter = null;
}

function clearPendingAuth(state: SessionState, reason?: string): void {
  if (reason && state.codeRejecter) {
    state.codeRejecter(new Error(reason));
  }

  if (reason && state.passwordRejecter) {
    state.passwordRejecter(new Error(reason));
  }

  resetAuthResolvers(state);
}

function waitForCode(state: SessionState): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (state.codeRejecter === reject) {
        resetAuthResolvers(state);
      }
      reject(new Error("Tempo esgotado para enviar codigo"));
    }, 5 * 60 * 1000);

    state.codeResolver = (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    };

    state.codeRejecter = (reason?: unknown) => {
      clearTimeout(timeout);
      reject(reason instanceof Error ? reason : new Error("Codigo cancelado"));
    };
  });
}

function waitForPassword(state: SessionState): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (state.passwordRejecter === reject) {
        resetAuthResolvers(state);
      }
      reject(new Error("Tempo esgotado para enviar senha 2FA"));
    }, 5 * 60 * 1000);

    state.passwordResolver = (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    };

    state.passwordRejecter = (reason?: unknown) => {
      clearTimeout(timeout);
      reject(reason instanceof Error ? reason : new Error("Senha 2FA cancelada"));
    };
  });
}

function stopHeartbeat(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function buildClient(state: SessionState): TelegramClient {
  const stringSession = new StringSession(state.sessionString || "");
  const client = new TelegramClient(stringSession, state.config.apiId, state.config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  state.client = client;
  state.messageHandlerBound = false;

  return client;
}

async function bindMessageHandler(state: SessionState): Promise<void> {
  if (!state.client || state.messageHandlerBound) return;

  // ── Regular message handler (NewMessage provides getChat / getSender) ──
  state.client.addEventHandler(async (event: unknown) => {
    try {
      if (state.status !== "online" && state.status !== "connecting") {
        bumpIngestionDrop(state, `state_not_ready_${state.status}`);
        return;
      }
      state.ingestion.updatesSeen += 1;

      const msgEvent = event as {
        message: Api.Message & { out?: boolean; message?: string; media?: unknown };
        getChat?: () => Promise<unknown>;
        getSender?: () => Promise<unknown>;
      };
      const message = msgEvent.message;
      if (!message) {
        bumpIngestionDrop(state, "message_missing");
        return;
      }
      state.ingestion.messagesSeen += 1;

      const isOutgoing = Boolean(message.out);

      const content = typeof message.message === "string" ? message.message.trim() : "";

      const messageMedia = message.media;
      const mediaInfo = extractTelegramMediaInfo(messageMedia);
      const hasMedia = hasTelegramMedia(messageMedia);
      const hasImageMedia = isTelegramImageMedia(messageMedia);
      logMediaCaptureDebug("incoming_summary", {
        sessionId: state.config.sessionId,
        hasText: Boolean(content),
        textLength: content.length,
        hasMedia,
        mediaKind: mediaInfo?.kind || "",
        hasImageMedia,
        mediaMimeTypeHint: mediaInfo?.mimeType || readTelegramMediaMimeType(messageMedia),
      });

      if (!content && !hasMedia) {
        bumpIngestionDrop(state, "empty_message_payload");
        return;
      }
      if (isOutgoing) {
        bumpIngestionDrop(state, "from_me");
        return;
      }

      const chat = msgEvent.getChat ? await msgEvent.getChat() : undefined;
      if (!chat || !isGroupLike(chat)) {
        bumpIngestionDrop(state, "not_group_chat");
        return;
      }

      const groupId = formatEntityId(chat);
      if (!groupId) {
        bumpIngestionDrop(state, "group_id_missing");
        return;
      }
      const groupName = getEntityName(chat, groupId);

      const rawMessageId = String((message as { id?: unknown }).id ?? "").trim();
      const dedupeKey = rawMessageId
        ? `${groupId}|${rawMessageId}`
        : `${groupId}|${normalizeEchoText(content)}|${hasMedia ? (mediaInfo?.kind || "media") : "text"}`;
      if (!markInboundMessageSeen(state, dedupeKey)) {
        state.ingestion.duplicates += 1;
        bumpIngestionDrop(state, "duplicate_message_id");
        return;
      }

      let from = "";
      if (msgEvent.getSender) {
        try {
          const sender = await msgEvent.getSender();
          from = getEntityName(sender, groupName);
        } catch {
          // ignore sender lookup errors
        }
      }

      let mediaData: Record<string, unknown> | undefined;
      const resolvedImage = hasMedia && state.client
        ? await resolveTelegramInboundImage({
            client: state.client,
            message: message as Api.Message,
            media: messageMedia,
            mediaInfo,
            sessionId: state.config.sessionId,
          })
        : null;
      if (resolvedImage) {
        const stored = storeTemporaryImage(resolvedImage.buffer, state.config.userId, resolvedImage.mimeType);
        logMediaCaptureDebug("incoming_image_stored", {
          sessionId: state.config.sessionId,
          groupId,
          bytes: resolvedImage.buffer.length,
          mimeType: resolvedImage.mimeType,
          origin: resolvedImage.origin,
          tokenPrefix: stored.token.slice(0, 8),
        });
        mediaData = {
          kind: "image",
          token: stored.token,
          mimeType: resolvedImage.mimeType,
          fileName: stored.fileName,
          sourcePlatform: "telegram",
        };
      } else if (hasMedia) {
        logMediaCaptureDebug("incoming_image_download_failed", {
          sessionId: state.config.sessionId,
          groupId,
          hasText: Boolean(content),
          textLength: content.length,
          mediaKind: mediaInfo?.kind || "",
          mediaMimeTypeHint: readTelegramMediaMimeType(messageMedia),
        });
        logger.warn(
          { sessionId: state.config.sessionId, groupId, mediaKind: mediaInfo?.kind || "unknown" },
          "incoming telegram media detected but no image payload could be extracted",
        );
      }

      logMediaCaptureDebug("webhook_emit_message_received", {
        sessionId: state.config.sessionId,
        groupId,
        hasText: Boolean(content),
        textLength: content.length,
        hasMedia,
        mediaTokenPrefix: typeof mediaData?.token === "string" ? mediaData.token.slice(0, 8) : "",
        dedupeKey,
      });
      await emitWebhook(state, "message_received", {
        from: from || groupName,
        message: content,
        groupId,
        groupName,
        hasMedia,
        mediaKind: mediaInfo?.kind || undefined,
        mediaMimeType: mediaInfo?.mimeType || undefined,
        ...(mediaData ? { media: mediaData } : {}),
      });
      bumpIngestionAccepted(state);
    } catch (error) {
      logger.warn({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "failed to process incoming telegram message");
    }
  }, new NewMessage({}));

  // Raw update fallback: captures channel/group updates that may bypass NewMessage.
  state.client.addEventHandler(async (event: unknown) => {
    try {
      if (state.status !== "online" && state.status !== "connecting") {
        bumpIngestionDrop(state, `state_not_ready_raw_${state.status}`);
        return;
      }

      const raw = event as {
        className?: string;
        message?: Api.Message & {
          className?: string;
          out?: boolean;
          id?: unknown;
          message?: string;
          media?: unknown;
          peerId?: unknown;
          action?: { className?: string; title?: string };
        };
      };

      if (raw.className !== "UpdateNewMessage" && raw.className !== "UpdateNewChannelMessage") return;
      state.ingestion.updatesSeen += 1;

      const rawMessage = raw.message;
      if (!rawMessage) {
        bumpIngestionDrop(state, "raw_message_missing");
        return;
      }

      const messageClassName = String(rawMessage.className || "").trim();
      if (messageClassName === "MessageService") {
        const action = rawMessage.action;
        if (action?.className === "MessageActionChatEditTitle" && action.title) {
          const groupId = formatPeerId(rawMessage.peerId);
          if (groupId) {
            await emitWebhook(state, "group_name_update", { id: groupId, name: action.title });
          }
        }
        bumpIngestionDrop(state, "raw_service_message");
        return;
      }
      if (messageClassName && messageClassName !== "Message") {
        bumpIngestionDrop(state, `raw_class_${messageClassName}`);
        return;
      }

      const groupId = formatPeerId(rawMessage.peerId);
      if (!groupId) {
        bumpIngestionDrop(state, "raw_group_id_missing");
        return;
      }

      const content = typeof rawMessage.message === "string" ? rawMessage.message.trim() : "";
      const messageMedia = rawMessage.media;
      const mediaInfo = extractTelegramMediaInfo(messageMedia);
      const hasMedia = hasTelegramMedia(messageMedia);
      if (!content && !hasMedia) {
        bumpIngestionDrop(state, "raw_empty_message_payload");
        return;
      }
      state.ingestion.messagesSeen += 1;
      const isOutgoing = Boolean(rawMessage.out);
      if (isOutgoing) {
        bumpIngestionDrop(state, "from_me");
        return;
      }

      const rawMessageId = String(rawMessage.id ?? "").trim();
      const dedupeKey = rawMessageId
        ? `${groupId}|${rawMessageId}`
        : `${groupId}|${normalizeEchoText(content)}|${hasMedia ? (mediaInfo?.kind || "media") : "text"}`;
      if (!markInboundMessageSeen(state, dedupeKey)) {
        state.ingestion.duplicates += 1;
        bumpIngestionDrop(state, "duplicate_message_id");
        return;
      }

      let mediaData: Record<string, unknown> | undefined;
      const resolvedImage = hasMedia && state.client
        ? await resolveTelegramInboundImage({
            client: state.client,
            message: rawMessage as Api.Message,
            media: messageMedia,
            mediaInfo,
            sessionId: state.config.sessionId,
          })
        : null;
      if (resolvedImage) {
        const stored = storeTemporaryImage(resolvedImage.buffer, state.config.userId, resolvedImage.mimeType);
        mediaData = {
          kind: "image",
          token: stored.token,
          mimeType: resolvedImage.mimeType,
          fileName: stored.fileName,
          sourcePlatform: "telegram",
        };
      }

      await emitWebhook(state, "message_received", {
        from: groupId,
        message: content,
        groupId,
        groupName: groupId,
        hasMedia,
        mediaKind: mediaInfo?.kind || undefined,
        mediaMimeType: mediaInfo?.mimeType || undefined,
        ...(mediaData ? { media: mediaData } : {}),
      });
      bumpIngestionAccepted(state);
    } catch (error) {
      logger.warn({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "failed to process raw telegram update");
    }
  });

  state.messageHandlerBound = true;
}

async function syncGroups(state: SessionState): Promise<{
  count: number;
  groups: Array<{ id: string; name: string; memberCount: number }>;
}> {
  if (!state.client || state.status !== "online") {
    throw new Error("Sessão Telegram não está online");
  }

  const dialogs = await state.client.getDialogs({});
  const groupsMap = new Map<string, { id: string; name: string; memberCount: number }>();

  for (const dialog of dialogs) {
    const entity = (dialog as { entity?: unknown }).entity;
    if (!entity || !isGroupLike(entity)) continue;

    const id = formatEntityId(entity);
    if (!id) continue;

    const memberCountRaw = (entity as { participantsCount?: unknown }).participantsCount;
    const memberCount = typeof memberCountRaw === "number" ? memberCountRaw : 0;
    const name = (dialog as { title?: string }).title || getEntityName(entity, id);

    groupsMap.set(id, { id, name, memberCount });
  }

  const groups = Array.from(groupsMap.values());
  await emitWebhook(state, "groups_sync", { groups });
  return { count: groups.length, groups };
}

async function finalizeConnected(state: SessionState): Promise<void> {
  if (!state.client) {
    throw new Error("Client Telegram não inicializado");
  }

  state.sessionString = state.client.session.save() as unknown as string;
  await writeMetadata(state);
  await bindMessageHandler(state);

  let phone = state.config.phone;
  try {
    const me = await state.client.getMe();
    const mePhone = (me as { phone?: unknown }).phone;
    if (typeof mePhone === "string" && mePhone.trim()) {
      phone = mePhone.startsWith("+") ? mePhone : `+${mePhone}`;
    }
  } catch {
    // ignore getMe failures
  }

  await emitConnectionUpdate(state, "online", {
    phone,
    session_string: state.sessionString,
    error_message: "",
  });

  stopHeartbeat(state);
  state.heartbeatTimer = setInterval(async () => {
    if (state.manualStop || !state.client) return;

    try {
      const authorized = await state.client.checkAuthorization();
      if (authorized) {
        // Self-heal: keep message handlers attached if runtime drifts.
        if (state.status !== "online" || !state.messageHandlerBound) {
          await finalizeConnected(state);
        }
      } else {
        logger.warn({ sessionId: state.config.sessionId }, "telegram session unauthorized on heartbeat");
        await ensureConnected(state);
      }
    } catch (error) {
      logger.warn({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "heartbeat check failed, trying reconnect");
      await ensureConnected(state);
    }
  }, 60_000);

  try {
    await syncGroups(state);
  } catch (error) {
    logger.warn({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "automatic telegram group sync failed");
  }
}

async function ensureConnected(state: SessionState): Promise<boolean> {
  if (state.authFlow) return false;

  if (state.client) {
    try {
      const authorized = await state.client.checkAuthorization();
      if (authorized) {
        if (state.status !== "online" || !state.messageHandlerBound) {
          await finalizeConnected(state);
        }
        return true;
      }
    } catch {
      // will attempt restore below
    }
  }

  if (!state.sessionString) {
    return false;
  }

  try {
    if (state.client) {
      await state.client.disconnect().catch(() => undefined);
      state.client = null;
      state.messageHandlerBound = false;
    }

    await emitConnectionUpdate(state, "connecting", { error_message: "" });

    const client = buildClient(state);
    await client.connect();

    const authorized = await client.checkAuthorization();
    if (!authorized) {
      await client.disconnect().catch(() => undefined);
      state.client = null;
      state.messageHandlerBound = false;
      state.sessionString = "";
      await removeMetadata(state.config.sessionId);
      await emitConnectionUpdate(state, "offline", {
        error_message: "Sessão Telegram não autorizada",
        clear_session: true,
      });
      return false;
    }

    await finalizeConnected(state);
    return true;
  } catch (error) {
    logger.error({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "failed to restore telegram session");

    if (state.client) {
      await state.client.disconnect().catch(() => undefined);
      state.client = null;
      state.messageHandlerBound = false;
    }

    await emitConnectionUpdate(state, "offline", {
      error_message: sanitizeError(error),
    });
    return false;
  }
}

async function startAuthentication(state: SessionState): Promise<void> {
  if (state.authFlow) {
    return state.authFlow;
  }

  state.manualStop = false;
  state.lastAuthCallbackError = "";

  const flow = (async () => {
    await emitConnectionUpdate(state, "connecting", { error_message: "" });

    if (state.client) {
      await state.client.disconnect().catch(() => undefined);
      state.client = null;
      state.messageHandlerBound = false;
    }

    const client = buildClient(state);
    await client.connect();

    const alreadyAuthorized = await client.checkAuthorization();
    if (alreadyAuthorized) {
      await finalizeConnected(state);
      return;
    }

    await client.start({
      phoneNumber: async () => state.config.phone,
      phoneCode: async () => {
        await emitConnectionUpdate(state, "awaiting_code", { error_message: "" });
        return waitForCode(state);
      },
      password: async () => {
        await emitConnectionUpdate(state, "awaiting_password", { error_message: "" });
        return waitForPassword(state);
      },
      onError: async (error: unknown) => {
        const message = sanitizeError(error);
        state.lastAuthCallbackError = message;
        logger.warn({ sessionId: state.config.sessionId, error: message }, "telegram auth callback error");
        return isFatalAuthError(error);
      },
    });

    await finalizeConnected(state);
  })()
    .catch(async (error) => {
      const rawMessage = sanitizeError(error);
      const cancelLike = rawMessage.toUpperCase().includes("AUTH_USER_CANCEL");
      const callbackMessage = String(state.lastAuthCallbackError || "").trim();
      const message = cancelLike && callbackMessage
        ? callbackMessage
        : rawMessage;
      const upper = message.toUpperCase();
      const clearSession = upper.includes("AUTH_KEY_UNREGISTERED") || upper.includes("SESSION_REVOKED");

      logger.error({ sessionId: state.config.sessionId, error: message }, "telegram auth flow failed");

      stopHeartbeat(state);
      clearPendingAuth(state, message);

      if (state.client) {
        await state.client.disconnect().catch(() => undefined);
        state.client = null;
      }

      state.messageHandlerBound = false;

      if (clearSession) {
        state.sessionString = "";
        await removeMetadata(state.config.sessionId);
      } else {
        await writeMetadata(state).catch(() => undefined);
      }

      await emitConnectionUpdate(state, "offline", {
        error_message: message,
        clear_session: clearSession,
      });

      throw error;
    })
    .finally(() => {
      state.authFlow = null;
      clearPendingAuth(state);
    });

  state.authFlow = flow;
  return flow;
}

async function disconnectSession(state: SessionState, clearSession: boolean): Promise<void> {
  state.manualStop = true;

  clearPendingAuth(state, "Sessão desconectada pelo usuário");
  stopHeartbeat(state);

  if (state.client) {
    await state.client.disconnect().catch(() => undefined);
  }

  state.client = null;
  state.messageHandlerBound = false;
  state.authFlow = null;

  if (clearSession) {
    state.sessionString = "";
    await removeMetadata(state.config.sessionId);
  } else {
    await writeMetadata(state).catch(() => undefined);
  }

  try {
    await emitConnectionUpdate(state, "offline", {
      error_message: "",
      clear_session: clearSession,
    });
  } finally {
    if (clearSession) {
      sessionStates.delete(state.config.sessionId);
    }
  }
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
      hasClient: Boolean(state.client),
      messageHandlerBound: state.messageHandlerBound,
      hasSessionString: Boolean(state.sessionString),
      waitingCode: Boolean(state.codeResolver),
      waitingPassword: Boolean(state.passwordResolver),
      queuedEvents: state.events.length,
      ingestion: {
        updatesSeen: state.ingestion.updatesSeen,
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

app.get("/api/telegram/events/:sessionId", async (req: Request<{ sessionId: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.sessionId;
  const clear = req.query.clear !== "false";

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
});

app.get("/api/telegram/media/:token", async (req: Request<{ token: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const token = req.params.token;
  const item = mediaStore.get(token);
  if (!item) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }

  if (item.userId !== requestUserId) {
    res.status(403).json({ error: "Mídia não pertence ao usuário informado" });
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

app.post("/api/telegram/media/:token/schedule-delete", async (req: Request<{ token: string }>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const token = req.params.token;
  const item = mediaStore.get(token);
  if (!item) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }

  if (item.userId !== requestUserId) {
    res.status(403).json({ error: "Mídia não pertence ao usuário informado" });
    return;
  }

  const delayRaw = req.body && typeof req.body === "object"
    ? Number((req.body as Record<string, unknown>).delayMs)
    : NaN;
  const delayMs = Number.isFinite(delayRaw) ? Math.max(1_000, delayRaw) : 120_000;
  const ok = scheduleMediaDeletion(token, delayMs);
  if (!ok) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }

  res.json({ ok: true, token, deleteInMs: delayMs });
});

app.post("/api/telegram/send_code", async (req: Request<unknown, unknown, ActionBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const {
    sessionId = "",
    userId = "",
    phone = "",
    webhookUrl = "",
    apiId,
    apiHash = "",
    sessionString = "",
  } = req.body || {};

  // Fall back to service env vars when the client omits API credentials
  const apiIdNum = Number(apiId || DEFAULT_API_ID);
  const resolvedApiHash = String(apiHash || DEFAULT_API_HASH);

  if (!sessionId || !userId || !phone || !apiIdNum || !resolvedApiHash) {
    res.status(400).json({ error: "sessionId, userId e phone são obrigatórios; configure TELEGRAM_API_ID e TELEGRAM_API_HASH no .env do serviço" });
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

  const existing = await loadStateFromDisk(sessionId);
  if (existing && existing.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  const state = createOrGetState({
    sessionId,
    userId,
    phone: normalizePhone(phone),
    webhookUrl,
    apiId: apiIdNum,
    apiHash: resolvedApiHash,
  }, sessionString);

  await writeMetadata(state).catch(() => undefined);

  const restored = await ensureConnected(state);
  if (restored) {
    res.json({ ok: true, status: "online", session_string: state.sessionString });
    return;
  }

  if (state.authFlow) {
    res.json({ ok: true, status: state.status });
    return;
  }

  startAuthentication(state).catch((error) => {
    logger.error({ sessionId: state.config.sessionId, error: sanitizeError(error) }, "async send_code auth flow failed");
  });

  res.json({ ok: true, status: "connecting" });
});

app.post("/api/telegram/verify_code", async (req: Request<unknown, unknown, ActionBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.body?.sessionId || "";
  const code = req.body?.code?.trim() || "";

  if (!sessionId || !code) {
    res.status(400).json({ error: "sessionId e code são obrigatórios" });
    return;
  }

  const state = await loadStateFromDisk(sessionId);
  if (!state) {
    res.status(404).json({ error: "Sessão não encontrada" });
    return;
  }

  if (state.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  if (!state.codeResolver) {
    res.status(409).json({ error: "Sessão não está aguardando código", status: state.status });
    return;
  }

  const resolver = state.codeResolver;
  resetAuthResolvers(state);
  resolver(code);

  await emitConnectionUpdate(state, "connecting", { error_message: "" });

  res.json({ ok: true, status: "connecting" });
});

app.post("/api/telegram/verify_password", async (req: Request<unknown, unknown, ActionBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.body?.sessionId || "";
  const password = req.body?.password || "";

  if (!sessionId || !password) {
    res.status(400).json({ error: "sessionId e password são obrigatórios" });
    return;
  }

  const state = await loadStateFromDisk(sessionId);
  if (!state) {
    res.status(404).json({ error: "Sessão não encontrada" });
    return;
  }

  if (state.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  if (!state.passwordResolver) {
    res.status(409).json({ error: "Sessão não está aguardando senha 2FA", status: state.status });
    return;
  }

  const resolver = state.passwordResolver;
  resetAuthResolvers(state);
  resolver(password);

  await emitConnectionUpdate(state, "connecting", { error_message: "" });

  res.json({ ok: true, status: "connecting" });
});

app.post("/api/telegram/disconnect", async (req: Request<unknown, unknown, ActionBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.body?.sessionId || "";
  const clearSession = req.body?.clearSession === true
    || String(req.body?.clearSession || "").trim().toLowerCase() === "true";

  if (!sessionId) {
    res.status(400).json({ error: "sessionId é obrigatório" });
    return;
  }

  const state = await loadStateFromDisk(sessionId);
  if (!state) {
    if (clearSession) {
      await removeMetadata(sessionId);
    }
    res.json({ ok: true, status: "offline", clear_session: clearSession });
    return;
  }

  if (state.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  await disconnectSession(state, clearSession);
  res.json({ ok: true, status: "offline", clear_session: clearSession });
});

app.post("/api/telegram/sync_groups", async (req: Request<unknown, unknown, ActionBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.body?.sessionId || "";

  if (!sessionId) {
    res.status(400).json({ error: "sessionId é obrigatório" });
    return;
  }

  const state = await loadStateFromDisk(sessionId);
  if (!state) {
    res.status(404).json({ error: "Sessão não encontrada" });
    return;
  }

  if (state.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  const online = await ensureConnected(state);
  if (!online || !state.client || state.status !== "online") {
    res.status(409).json({ error: "Sessão Telegram não está online" });
    return;
  }

  try {
    const synced = await syncGroups(state);
    res.json({ ok: true, status: state.status, groups: synced.count, groupsData: synced.groups });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error) });
  }
});

app.post("/api/telegram/send-message", async (req: Request<unknown, unknown, SendMessageBody>, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const { sessionId = "", chatId = "", message = "", media } = req.body || {};
  const hasImageMedia = media?.kind === "image";

  if (!sessionId || !chatId || (!message.trim() && !hasImageMedia)) {
    res.status(400).json({ error: "sessionId e chatId são obrigatórios, com message ou media de imagem" });
    return;
  }

  const state = await loadStateFromDisk(sessionId);
  if (!state) {
    res.status(404).json({ error: "Sessão não encontrada" });
    return;
  }

  if (state.config.userId !== requestUserId) {
    res.status(403).json({ error: "Sessão não pertence ao usuário informado" });
    return;
  }

  const online = await ensureConnected(state);
  if (!online || !state.client || state.status !== "online") {
    res.status(409).json({ error: "Sessão Telegram não está online" });
    return;
  }

  const client = state.client;

  const trimmedMessage = message.trim();
  const mediaSignature = media?.kind === "image"
    ? [
      String(media.token || ""),
      String(media.fileName || ""),
      String(media.mimeType || ""),
      String(media.base64 || "").slice(0, 128),
    ].join("|")
    : "";
  const sendKey = `${sessionId}|${chatId}|${trimmedMessage}|${mediaSignature}`;

  const existing = inFlightSends.get(sendKey);
  if (existing) {
    try {
      const deduplicated = await existing;
      res.json({ ok: true, id: deduplicated.id, deduplicated: true });
      return;
    } catch (error) {
      logger.warn({ sessionId, chatId, error: sanitizeError(error) }, "telegram in-flight dedupe join failed");
    }
  }

  const sendPromise = (async () => {
    const target = parseChatTarget(chatId);
    const entity = await client.getInputEntity(target);
    let mediaKind = media?.kind === "image" ? "image" : "";
    let outboundMessage = trimmedMessage;
    let sent: { id?: number } | null = null;
    let mediaFileBuffer: Buffer | null = null;
    let mediaFileName = media?.fileName || DEFAULT_AUTO_IMAGE_FILE_NAME;
    let mediaMimeType = media?.mimeType || "image/jpeg";

    if (mediaKind === "image") {
      if (media?.token) {
        const stored = mediaStore.get(media.token);
        if (!stored) {
          throw new Error("Mídia temporária não encontrada para envio");
        }
        if (stored.userId !== state.config.userId) {
          throw new Error("Mídia temporária não pertence ao usuário da sessão");
        }
        mediaFileBuffer = stored.data;
        mediaMimeType = stored.mimeType || mediaMimeType;
        mediaFileName = stored.fileName || mediaFileName;
      } else if (media?.base64) {
        const fileBuffer = Buffer.from(media.base64, "base64");
        const detectedMimeType = detectImageMimeTypeFromBuffer(fileBuffer);
        const mimeTypeFromPayload = (media?.mimeType || "").trim().toLowerCase();
        if (detectedMimeType || mimeTypeFromPayload.startsWith("image/")) {
          mediaFileBuffer = fileBuffer;
          mediaMimeType = detectedMimeType || mimeTypeFromPayload || "image/jpeg";
        }
      }
    } else {
      const urls = extractUrlsFromMessage(outboundMessage);
      for (const url of urls) {
        const downloaded = await downloadImageFromUrl(url);
        if (!downloaded) continue;

        mediaKind = "image";
        mediaFileBuffer = downloaded.buffer;
        mediaFileName = downloaded.fileName;
        mediaMimeType = downloaded.mimeType;
        outboundMessage = removeUrlFromMessage(outboundMessage, url);
        break;
      }
    }

    if (mediaKind === "image" && mediaFileBuffer) {
      const extension = mimeTypeToFileExtension(mediaMimeType);
      const safeFileName = mediaFileName.trim() || DEFAULT_AUTO_IMAGE_FILE_NAME;
      const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeFileName);
      const finalFileName = hasExtension ? safeFileName : `${safeFileName}.${extension}`;
      const mediaFile = new CustomFile(finalFileName, mediaFileBuffer.length, "", mediaFileBuffer);

      sent = await client.sendFile(entity, {
        file: mediaFile,
        caption: outboundMessage || undefined,
        parseMode: "html",
        forceDocument: false,
      }) as { id?: number };
    } else {
      sent = await client.sendMessage(entity, {
        message: outboundMessage,
        parseMode: "html",
        linkPreview: false,
      }) as { id?: number };
    }

    let groupName = chatId;
    let groupId = chatId;
    try {
      const chat = await client.getEntity(entity);
      groupName = getEntityName(chat, chatId);
      const formattedChatId = formatEntityId(chat);
      if (formattedChatId) {
        groupId = formattedChatId;
      }
    } catch {
      // ignore entity name failures
    }

    rememberOutboundEcho(state.config.sessionId, groupId, outboundMessage, mediaKind === "image");

    await emitWebhook(state, "message_sent", {
      to: chatId,
      groupName,
      messageType: mediaKind === "image" ? "image" : "text",
      message: outboundMessage,
    });

    const messageId = (sent as { id?: number }).id || null;
    logger.info({
      sessionId,
      chatId,
      groupName,
      messageId,
      messageType: mediaKind === "image" ? "image" : "text",
      hasMedia: mediaKind === "image",
    }, "telegram message sent");
    return { id: messageId };
  })();

  inFlightSends.set(sendKey, sendPromise);

  try {
    const result = await sendPromise;
    res.json({ ok: true, id: result.id });
  } catch (error) {
    const messageError = sanitizeError(error);
    if (messageError === "Mídia temporária não encontrada para envio") {
      res.status(404).json({ error: messageError });
      return;
    }
    if (messageError === "Mídia temporária não pertence ao usuário da sessão") {
      res.status(403).json({ error: messageError });
      return;
    }
    logger.error({
      sessionId,
      chatId,
      error: messageError,
    }, "telegram send-message failed");
    res.status(500).json({ error: messageError });
  } finally {
    if (inFlightSends.get(sendKey) === sendPromise) {
      inFlightSends.delete(sendKey);
    }
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

    const state = createOrGetState(
      {
        sessionId: metadata.sessionId,
        userId: metadata.userId,
        phone: metadata.phone,
        webhookUrl: metadata.webhookUrl,
        apiId: metadata.apiId,
        apiHash: metadata.apiHash,
      },
      metadata.sessionString,
    );

    if (!state.sessionString) continue;

    const restored = await ensureConnected(state);
    if (restored) {
      logger.info({ sessionId: state.config.sessionId }, "telegram session restored from disk");
    } else {
      logger.warn({ sessionId: state.config.sessionId }, "telegram session restore failed");
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down telegram service");

  for (const state of sessionStates.values()) {
    stopHeartbeat(state);
    clearPendingAuth(state, "Service shutdown");

    if (state.client) {
      await state.client.disconnect().catch(() => undefined);
    }

    state.client = null;
    state.messageHandlerBound = false;
    state.authFlow = null;

    await writeMetadata(state).catch(() => undefined);
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
  await restoreSessionsOnStartup();

  httpServer = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, sessionsRoot: SESSIONS_ROOT }, "telegram telegraph service online");
  });

  httpServer.on("error", (error) => {
    logger.error({ error: sanitizeError(error), host: HOST, port: PORT }, "failed to bind telegram service");
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
