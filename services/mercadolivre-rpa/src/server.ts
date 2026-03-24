import express from "express";
import cors from "cors";
import pino from "pino";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionService } from "./session.js";
import { converter } from "./converter.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const app = express();
const PORT = Number(process.env.MELI_RPA_PORT ?? 3114);
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_INSECURE_NO_SECRET = process.env.ALLOW_INSECURE_NO_SECRET === "true";

function isMercadoLivreUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "meli.la" ||
    host.endsWith(".meli.la") ||
    host === "mlb.am" ||
    host.endsWith(".mlb.am") ||
    host.includes("mercadolivre") ||
    host.includes("mercadolibre") ||
    host.includes("mercadopago") ||
    host.includes("mlstatic")
  );
}

const rawCorsOrigin = process.env.CORS_ORIGIN ?? "";
const corsOriginList = rawCorsOrigin.split(",").map((s) => s.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server).
    if (!origin) {
      callback(null, true);
      return;
    }

    // If user configured explicit origins, enforce that list.
    if (corsOriginList.length > 0) {
      callback(null, corsOriginList.includes(origin));
      return;
    }

    // Safe local default for dev/preview across localhost and 127.0.0.1 ports.
    const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    callback(null, isLocalhostOrigin);
  },
}));
app.use(express.json({ limit: "2mb" }));

// ─── Security headers ─────────────────────────────────────────────────────
app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

// ─── Rate limiting (in-memory, per IP) ───────────────────────────────────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const rateLimitByUser = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_REQUESTS = 60;
const USER_RATE_LIMIT_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function rateLimitScopeKey(req: express.Request): string {
  const userId = String(req.header("x-autolinks-user-id") || "").trim().toLowerCase();
  if (userId && isUuid(userId)) return `user:${userId}`;
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return `ip:${ip}`;
}

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.path === "/health") { next(); return; }
  const key = rateLimitScopeKey(req);
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
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
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
  for (const [userId, entry] of rateLimitByUser) {
    if (now > entry.resetAt) rateLimitByUser.delete(userId);
  }
}, 5 * 60_000).unref();

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
  logger.warn("WEBHOOK_SECRET is set to the default placeholder 'change-me' \u2014 replace it with a strong secret.");
}
function requireWebhookSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
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

function sanitizeScopePart(value: string, max = 24): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, max) || "x";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readRequestUserId(req: express.Request, res: express.Response): string | null {
  const userId = String(req.header("x-autolinks-user-id") || "").trim();
  if (!userId) {
    res.status(400).json({ error: "x-autolinks-user-id obrigatorio" });
    return null;
  }
  if (userId.length > 64 || !isUuid(userId)) {
    res.status(400).json({ error: "x-autolinks-user-id invalido" });
    return null;
  }
  return userId.toLowerCase();
}

function ensureScopedSessionOwnership(sessionId: string, userId: string): boolean {
  const scopedPrefix = `${sanitizeScopePart(userId, 64)}__`;
  return String(sessionId || "").startsWith(scopedPrefix);
}

function consumeUserRateLimit(userId: string, amount = 1): boolean {
  const now = Date.now();
  const increment = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  const entry = rateLimitByUser.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitByUser.set(userId, { count: increment, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return increment <= USER_RATE_LIMIT_REQUESTS;
  }

  entry.count += increment;
  return entry.count <= USER_RATE_LIMIT_REQUESTS;
}

// ─── Health ────────────────────────────────────────────────────────────────
app.get("/api/meli/health", requireWebhookSecret, (_req, res) => {
  res.json({ ok: true, service: "mercadolivre-rpa", port: PORT, stats: converter.getStats() });
});

app.use("/api/meli", requireWebhookSecret);

// ─── Sessions ─────────────────────────────────────────────────────────────

/**
 * POST /api/meli/sessions
 * Body: { sessionId: string, cookies: string | object }
 */
app.post("/api/meli/sessions", async (req, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const { sessionId, cookies } = req.body as { sessionId?: string; cookies?: unknown };

  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    res.status(400).json({ error: "sessionId é obrigatório" });
    return;
  }
  if (!cookies) {
    res.status(400).json({ error: "cookies é obrigatório" });
    return;
  }
  if (!ensureScopedSessionOwnership(sessionId.trim(), requestUserId)) {
    res.status(403).json({ error: "sessionId não pertence ao usuário informado" });
    return;
  }

  try {
    const result = await sessionService.saveCookies(cookies as string | object, sessionId.trim());
    if (result.status === "error") {
      res.status(422).json(result);
      return;
    }
    res.status(201).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "POST /sessions error");
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/meli/sessions/:id/test
 * Runs a lightweight HTTP test (no browser) by default.
 * Pass ?full=1 for a full Playwright test.
 */
app.post("/api/meli/sessions/:id/test", async (req, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.id;
  if (!ensureScopedSessionOwnership(sessionId, requestUserId)) {
    res.status(403).json({ error: "sessionId não pertence ao usuário informado" });
    return;
  }
  const full = req.query.full === "1" || req.query.full === "true";

  try {
    const result = full
      ? await sessionService.testSessionFull(sessionId)
      : await sessionService.testSessionLight(sessionId);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, sessionId }, "POST /sessions/:id/test error");
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /api/meli/sessions/:id
 */
app.delete("/api/meli/sessions/:id", async (req, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const sessionId = req.params.id;
  if (!ensureScopedSessionOwnership(sessionId, requestUserId)) {
    res.status(403).json({ error: "sessionId não pertence ao usuário informado" });
    return;
  }
  try {
    const result = await sessionService.clearSession(sessionId);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, sessionId }, "DELETE /sessions/:id error");
    res.status(500).json({ error: message });
  }
});

// ─── Link Conversion ───────────────────────────────────────────────────────

/**
 * POST /api/meli/convert
 * Body: { productUrl: string, sessionId: string }
 */
app.post("/api/meli/convert", async (req, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;
  if (!consumeUserRateLimit(requestUserId, 1)) {
    res.status(429).json({ error: "Too Many Requests" });
    return;
  }

  const { productUrl, sessionId } = req.body as { productUrl?: string; sessionId?: string };

  if (!productUrl || typeof productUrl !== "string") {
    res.status(400).json({ error: "productUrl é obrigatório" });
    return;
  }
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId é obrigatório" });
    return;
  }
  if (!ensureScopedSessionOwnership(sessionId, requestUserId)) {
    res.status(403).json({ error: "sessionId não pertence ao usuário informado" });
    return;
  }

  // Basic URL validation
  let parsed: URL;
  try {
    parsed = new URL(productUrl);
    if (!isMercadoLivreUrl(parsed)) {
      res.status(400).json({ error: "URL não parece ser do Mercado Livre" });
      return;
    }
  } catch {
    res.status(400).json({ error: "productUrl não é uma URL válida" });
    return;
  }

  try {
    const result = await converter.convertLink(productUrl, sessionId);
    if (result.success) {
      res.json(result);
    } else {
      res.status(422).json(result);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, productUrl, sessionId }, "POST /convert error");
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/meli/convert/batch
 * Body: { urls: string[], sessionId: string }
 */
app.post("/api/meli/convert/batch", async (req, res) => {
  const requestUserId = readRequestUserId(req, res);
  if (!requestUserId) return;

  const { urls, sessionId } = req.body as { urls?: string[]; sessionId?: string };

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "urls deve ser um array não vazio" });
    return;
  }
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId é obrigatório" });
    return;
  }
  if (!ensureScopedSessionOwnership(sessionId, requestUserId)) {
    res.status(403).json({ error: "sessionId não pertence ao usuário informado" });
    return;
  }
  if (urls.length > 50) {
    res.status(400).json({ error: "Máximo de 50 URLs por lote" });
    return;
  }
  if (!consumeUserRateLimit(requestUserId, urls.length)) {
    res.status(429).json({ error: "Too Many Requests" });
    return;
  }

  try {
    const results = await Promise.allSettled(urls.map((url) => converter.convertLink(url, sessionId)));
    const responses = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { success: false, originalUrl: urls[i], error: String((r as PromiseRejectedResult).reason) };
    });
    res.json({ results: responses, total: urls.length, successful: responses.filter((r) => r.success).length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "POST /convert/batch error");
    res.status(500).json({ error: message });
  }
});

// ─── Startup ───────────────────────────────────────────────────────────────

await sessionService.init();

app.listen(PORT, () => {
  logger.info({ port: PORT }, "mercadolivre-rpa service started");
});

export default app;
