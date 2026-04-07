import express from "express";
import compression from "compression";
import cors from "cors";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { pool, execute, queryOne } from "./db.js";
import { authMiddleware, authRouter, requireTrustedOriginForSessionWrite } from "./auth.js";
import { restRouter } from "./rest.js";
import { rpcRouter } from "./rpc.js";
import { consumeRateLimit, cleanupMemoryRateLimits, cleanupDistributedRateLimits } from "./rate-limit-store.js";
import { handleKiwifyWebhook } from "./kiwify/webhook-handler.js";
import { scheduleKiwifyReconciler } from "./kiwify/reconciler.js";

const app = express();
app.set("trust proxy", 1); // trust first-hop proxy (Coolify/nginx) so req.ip reflects the real client IP
app.disable("x-powered-by");
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3116);
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? (IS_PRODUCTION ? undefined : "*");
const ENFORCE_RATE_LIMIT = String(process.env.ENFORCE_RATE_LIMIT || "true").trim().toLowerCase() !== "false";
const BURST_SHED_ENABLED = String(process.env.BURST_SHED_ENABLED || (IS_PRODUCTION ? "true" : "false")).trim().toLowerCase() !== "false";
const LOG_HASH_SALT = String(process.env.LOG_HASH_SALT || process.env.JWT_SECRET || "autolinks-log-salt").trim() || "autolinks-log-salt";
const DEV_LOG_RPC_SUCCESS = String(process.env.DEV_LOG_RPC_SUCCESS || "").trim().toLowerCase() === "true";

function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(process.env[name] ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function hashUserIdForLogs(userId: string | undefined): string {
  const value = String(userId || "").trim();
  if (!value || value === "-") return "-";
  return `u_${createHash("sha256").update(`${LOG_HASH_SALT}:${value}`).digest("hex").slice(0, 16)}`;
}

function isLoopbackOrPrivateIp(rawIp: string | undefined): boolean {
  const normalized = String(rawIp || "").trim().toLowerCase();
  if (!normalized) return false;

  if (
    normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1"
    || normalized === "localhost"
  ) {
    return true;
  }

  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const parts = ipv4.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

// ─── Rate limiters (DB-backed in production, in-memory in dev) ───────────────
// In production, consumeRateLimit uses the runtime_rate_limits table so limits
// survive restarts and are shared across PM2 cluster instances.
// Auth endpoints: 20 req / 15 min  — brute-force guard
// RPC endpoint:  500 req / 60 s    — DoS guard for authenticated calls

const AUTH_RATE_MAX = envInt("AUTH_RATE_MAX", 20, 5, 200);
const AUTH_RATE_WINDOW = envInt("AUTH_RATE_WINDOW_MS", 15 * 60_000, 30_000, 24 * 60 * 60_000);

const RPC_RATE_MAX = envInt("RPC_RATE_MAX", 500, 20, 10_000);
const RPC_RATE_WINDOW = envInt("RPC_RATE_WINDOW_MS", 60_000, 5_000, 24 * 60 * 60_000);

const PUBLIC_RPC_FUNCTIONS = new Set(["link-hub-public", "master-group-invite"]);
const PUBLIC_RPC_RATE_MAX = envInt("PUBLIC_RPC_RATE_MAX", 60, 10, 5_000);
const PUBLIC_RPC_RATE_WINDOW = envInt("PUBLIC_RPC_RATE_WINDOW_MS", 60_000, 5_000, 24 * 60 * 60_000);

// Independent of IP-based limits. Prevents a single authenticated user from
// monopolising the API even when requests come from multiple IPs/devices.
const USER_RPC_RATE_MAX = envInt("USER_RPC_RATE_MAX", 300, 10, 10_000);
const USER_RPC_RATE_WINDOW = envInt("USER_RPC_RATE_WINDOW_MS", 60_000, 5_000, 24 * 60 * 60_000);

// ─── Burst/spike detection ───────────────────────────────────────────────────
// Tracks global request count in a 10-second sliding bucket. When the rate
// exceeds the threshold, new requests from non-trusted sources are rejected
// with 503 to shed load gracefully. Helps identify organic spikes vs attacks.
const _burstBuckets: number[] = [];     // ring buffer of 10s bucket counts
const BURST_BUCKET_MS = 10_000;
const BURST_HISTORY_BUCKETS = 6;        // keep 60s of history (6 × 10s)
const BURST_THRESHOLD_PER_BUCKET = envInt("BURST_THRESHOLD_PER_BUCKET", 200, 20, 20_000);
let _burstCurrentCount = 0;
let _burstBucketStart = Date.now();

function recordBurstRequest(): boolean {
  const now = Date.now();
  if (now - _burstBucketStart >= BURST_BUCKET_MS) {
    _burstBuckets.push(_burstCurrentCount);
    if (_burstBuckets.length > BURST_HISTORY_BUCKETS) _burstBuckets.shift();
    _burstCurrentCount = 0;
    _burstBucketStart = now;
  }
  _burstCurrentCount++;
  return _burstCurrentCount > BURST_THRESHOLD_PER_BUCKET;
}

async function authRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ENFORCE_RATE_LIMIT) { next(); return; }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  try {
    const result = await consumeRateLimit({
      namespace: "auth",
      scopeKey: ip,
      max: AUTH_RATE_MAX,
      windowMs: AUTH_RATE_WINDOW,
    });
    if (!result.allowed) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "rate_limited", ip, count: result.count, rid }));
      res.setHeader("Retry-After", String(result.retryAfterSec));
      res.status(429).json({ data: null, error: { message: "Muitas tentativas. Aguarde 15 minutos." } });
      return;
    }
    next();
  } catch {
    // Rate limit store unavailable — fail open to avoid blocking legitimate traffic
    next();
  }
}

async function publicRpcRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ENFORCE_RATE_LIMIT) { next(); return; }
  const funcName = String((req.body as { name?: unknown } | undefined)?.name || "").trim();
  if (!PUBLIC_RPC_FUNCTIONS.has(funcName)) { next(); return; }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  try {
    const result = await consumeRateLimit({
      namespace: "public_rpc",
      scopeKey: `${funcName}:${ip}`,
      max: PUBLIC_RPC_RATE_MAX,
      windowMs: PUBLIC_RPC_RATE_WINDOW,
    });
    if (!result.allowed) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "public_rpc_rate_limited", function: funcName, ip, rid, count: result.count }));
      res.setHeader("Retry-After", String(result.retryAfterSec));
      res.status(429).json({ data: null, error: { message: "Limite de consultas publicas excedido. Aguarde alguns segundos." } });
      return;
    }
    next();
  } catch {
    next();
  }
}

async function rpcRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ENFORCE_RATE_LIMIT) { next(); return; }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const bypassBurstShed = !IS_PRODUCTION && isLoopbackOrPrivateIp(ip);

  // ── Burst/spike detection (global, in-memory — intentional) ──────────────────
  // In-memory is fine here: burst detection is a per-instance safety valve,
  // not a shared state mechanism. Each instance sheds load independently.
  const isBurst = BURST_SHED_ENABLED && !bypassBurstShed && recordBurstRequest();
  if (isBurst) {
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "burst_shed", ip, rid, bucket: _burstCurrentCount }));
    res.setHeader("Retry-After", "10");
    res.status(503).json({ data: null, error: { message: "Servidor sobrecarregado. Tente novamente em alguns segundos." } }); return;
  }

  try {
    const result = await consumeRateLimit({
      namespace: "rpc",
      scopeKey: ip,
      max: RPC_RATE_MAX,
      windowMs: RPC_RATE_WINDOW,
    });
    if (!result.allowed) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "rpc_rate_limited", ip, count: result.count, rid }));
      res.setHeader("Retry-After", String(result.retryAfterSec));
      res.status(429).json({ data: null, error: { message: "Limite de chamadas excedido. Aguarde 1 minuto." } }); return;
    }
    next();
  } catch {
    next();
  }
}

// ─── User-level RPC rate limiter (post-auth) ─────────────────────────────────
// Applied after authentication so we have the userId. Prevents a single user
// from consuming disproportionate resources regardless of how many IPs they use.
async function userRpcRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ENFORCE_RATE_LIMIT) { next(); return; }
  const userId = (req as { currentUser?: { sub?: string } }).currentUser?.sub;
  if (!userId) { next(); return; } // unauthenticated — handled by authMiddleware
  try {
    const result = await consumeRateLimit({
      namespace: "user_rpc",
      scopeKey: userId,
      max: USER_RPC_RATE_MAX,
      windowMs: USER_RPC_RATE_WINDOW,
    });
    if (!result.allowed) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "user_rpc_rate_limited", userId: hashUserIdForLogs(userId), count: result.count, rid }));
      res.setHeader("Retry-After", String(result.retryAfterSec));
      res.status(429).json({ data: null, error: { message: "Limite de chamadas por usuário excedido. Aguarde 1 minuto." } }); return;
    }
    next();
  } catch {
    next();
  }
}

// Periodic cleanup: memory stores (always) + DB expired rows (in production)
setInterval(() => {
  cleanupMemoryRateLimits();
  cleanupDistributedRateLimits().catch(() => { /* non-fatal */ });
}, 5 * 60_000).unref();

scheduleKiwifyReconciler();

function ensureRequiredEnvVars() {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") return;

  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "SERVICE_TOKEN",
    "CREDENTIAL_ENCRYPTION_KEY",
    "WEBHOOK_SECRET",
    "OPS_CONTROL_TOKEN",
    "CORS_ORIGIN",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "RESEND_API_KEY",
    "RESEND_FROM",
    "APP_PUBLIC_URL",
    "API_PUBLIC_URL",
  ] as const;

  const missing = required.filter((key) => !String(process.env[key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(`[api] Missing required env vars: ${missing.join(", ")}`);
  }

  const weakEnv: string[] = [];
  const jwtSecret = String(process.env.JWT_SECRET || "").trim();
  const serviceToken = String(process.env.SERVICE_TOKEN || "").trim();
  const webhookSecret = String(process.env.WEBHOOK_SECRET || "").trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "").trim();

  if (jwtSecret.length < 32 || /^changeme|^dev-|local-only/i.test(jwtSecret)) weakEnv.push("JWT_SECRET");
  if (serviceToken.length < 24 || /^dev-|local-only/i.test(serviceToken)) weakEnv.push("SERVICE_TOKEN");
  if (webhookSecret.length < 24 || /^change-me$|^preview-|local-dev|autolinks-local/i.test(webhookSecret)) weakEnv.push("WEBHOOK_SECRET");
  if (adminPassword.length < 12 || /^(abacate1|123456|admin|admin123)$/i.test(adminPassword)) weakEnv.push("ADMIN_PASSWORD");

  if (weakEnv.length > 0) {
    throw new Error(`[api] Weak production secrets detected for: ${weakEnv.join(", ")}. Rotate and use strong values before startup.`);
  }

  if (CORS_ORIGIN === "*") {
    throw new Error("[api] CORS_ORIGIN='*' is not allowed in production");
  }
}

function normalizeCorsOriginEntry(rawValue: string): string {
  const trimmed = String(rawValue || "")
    .trim()
    .replace(/^["']+|["']+$/g, "");
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return "";
    }
  }

  return trimmed.replace(/\/+$/, "");
}

function normalizeExtensionOrigin(value: string): string {
  const trimmed = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("chrome-extension://") || trimmed.startsWith("moz-extension://")) {
    return trimmed;
  }
  return "";
}

const allowedExtensionOrigins = new Set(
  String(process.env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map(normalizeExtensionOrigin)
    .filter(Boolean),
);

if (IS_PRODUCTION && allowedExtensionOrigins.size === 0) {
  console.warn("[api] ALLOWED_EXTENSION_ORIGINS is empty in production. Browser extension requests will be blocked by CORS.");
}

function isExtensionOrigin(origin: string): boolean {
  const normalized = normalizeExtensionOrigin(origin);
  if (!normalized) return false;
  if (!IS_PRODUCTION) return true;
  return allowedExtensionOrigins.has(normalized);
}

const corsOriginList = CORS_ORIGIN === "*"
  ? []
  : CORS_ORIGIN
    .split(",")
    .map(normalizeCorsOriginEntry)
    .filter(Boolean);
const corsOriginSet = new Set(corsOriginList);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) { callback(null, true); return; } // server-to-server
    if (isExtensionOrigin(origin)) { callback(null, true); return; }
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (corsOriginList.length > 0) {
      // In development, Vite may fall back to another port (5174, 5175, ...).
      // Allow any localhost origin even when CORS_ORIGIN is pinned.
      if (!IS_PRODUCTION && isLocal) { callback(null, true); return; }
      callback(null, corsOriginSet.has(normalizeCorsOriginEntry(origin)));
      return;
    }
    // CORS_ORIGIN='*' in development should not block Vite network URLs
    // (e.g. 192.168.x.x / 172.x.x.x) shown by `vite` startup output.
    if (!IS_PRODUCTION) {
      callback(null, true);
      return;
    }
    callback(null, isLocal);
  },
  credentials: true,
}));
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (String(req.headers["x-no-compression"] || "").trim().toLowerCase() === "true") {
      return false;
    }
    return compression.filter(req, res);
  },
}));
// 1 MB is more than sufficient for any legitimate RPC payload.
// 10 MB was excessive and creates a trivial DoS vector for authenticated users.
app.use(express.json({ limit: "1mb" }));
// ─── Security headers ────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ─── Request ID ── generate per-request UUID, echo back in header ─────────
// This ID must be added to every log line so that API ↔ microservice calls can
// be correlated when tracing an incident across multiple service logs.
function sanitizeRequestId(raw: string | undefined): string {
  if (!raw) return `api-${uuid()}`;
  const trimmed = String(raw).slice(0, 128);
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : `api-${uuid()}`;
}

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rid = sanitizeRequestId(req.headers["x-request-id"] as string | undefined);
  (req as { rid?: string }).rid = rid;
  res.setHeader("x-request-id", rid);
  next();
});

// ─── HTTP access log ─────────────────────────────────────────────────────────
// Logs every completed request: method, path, status, latency, userId, ip, rid.
// Skip /health to avoid noise from orchestrator probes.
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path === "/health") { next(); return; }
  const start = Date.now();
  res.on("finish", () => {
    if (!IS_PRODUCTION && !DEV_LOG_RPC_SUCCESS && req.method === "POST" && req.path === "/rpc" && res.statusCode < 400) {
      return;
    }

    const latencyMs = Date.now() - start;
    const userId = (req as { currentUser?: { sub?: string } }).currentUser?.sub ?? "-";
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      svc: "api",
      event: "http_request",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs,
      userId: hashUserIdForLogs(userId),
      ip: req.ip ?? "-",
      rid,
    }));
  });
  next();
});

app.use(authMiddleware);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/auth/signin", authRateLimiter);
app.use("/auth/signup", authRateLimiter);
app.use("/auth/forgot-password", authRateLimiter);
app.use("/auth/reset-password", authRateLimiter);
app.use("/auth/resend-verification", authRateLimiter);
app.use("/auth/signout", requireTrustedOriginForSessionWrite);
app.use("/auth/refresh", requireTrustedOriginForSessionWrite);
app.use("/auth/update-user", requireTrustedOriginForSessionWrite);
app.use("/auth", authRouter);
app.use("/api/rest", requireTrustedOriginForSessionWrite);
app.use("/api/rest", restRouter);
app.use("/functions/v1/rpc", publicRpcRateLimiter); // stricter limiter for explicit public RPC functions
app.use("/functions/v1/rpc", rpcRateLimiter); // per-IP DoS guard before auth is checked
app.use("/functions/v1/rpc", userRpcRateLimiter); // per-user fair-use guard (post-auth)
app.use("/functions/v1/rpc", requireTrustedOriginForSessionWrite);
app.use("/functions/v1", rpcRouter);

app.post("/webhooks/kiwify", async (req, res) => {
  try {
    const payload = req.body ?? {};
    const webhookToken = String(
      payload.token
      ?? payload.webhook_token
      ?? req.query?.["token"]
      ?? req.headers["x-kiwify-webhook-token"]
      ?? "",
    ).trim();
    const result = await handleKiwifyWebhook(payload, webhookToken);
    if (result.success) {
      res.json({ ok: true });
      return;
    }
    res.status(result.message === "Invalid webhook token" ? 401 : 400).json({ ok: false, message: result.message });
  } catch (error) {
    console.error("[webhooks/kiwify] error:", error instanceof Error ? error.message : error);
    res.status(500).json({ ok: false, message: "Erro interno" });
  }
});

// Liveness check: process-level heartbeat for container healthchecks.
// Keep this DB-independent so transient database issues do not restart the API container.
app.get("/health", async (_req, res) => {
  res.json({ ok: true, service: "autolinks-api", timestamp: new Date().toISOString() });
});

// Readiness check: validates database reachability for diagnostics/observability.
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "autolinks-api", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: "autolinks-api" });
  }
});

// ─── Global error handler (must be last middleware) ───────────────────────────
// Catches errors thrown synchronously inside route handlers or passed via next(err).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api] Unhandled route error:", err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).json({ data: null, error: { message: "Erro interno do servidor" } });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function seedAdminIfEmpty() {
  const adminEmail = String(process.env.ADMIN_EMAIL ?? "").toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn("[api] ADMIN_PASSWORD not set — skipping admin seed (set ADMIN_EMAIL and ADMIN_PASSWORD in env to create the first admin).");
    return;
  }
  if (!adminEmail) {
    console.warn("[api] ADMIN_EMAIL not set — skipping admin seed (set ADMIN_EMAIL and ADMIN_PASSWORD in env to create the first admin).");
    return;
  }

  const existing = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  if (Number(existing?.count ?? 0) > 0) return;

  const id = uuid();
  const hash = await bcrypt.hash(adminPassword, envInt("BCRYPT_COST", 12, 10, 14));
  const metadata = JSON.stringify({
    name: "Admin",
    account_status: "active",
    status_updated_at: new Date().toISOString(),
  });
  await execute("INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4::jsonb,NOW())", [id, adminEmail, hash, metadata]);
  await execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,'admin')", [uuid(), id]);
  await execute("INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at) VALUES ($1,$2,'Admin',$3,'admin',NULL)", [uuid(), id, adminEmail]);
  console.log(`[api] Admin user seeded: ${adminEmail}`);
}

async function main() {
  ensureRequiredEnvVars();
  // Verify DB connection.
  // In production we keep the process alive even if DB is temporarily unavailable
  // so orchestrator healthchecks do not continuously restart the container.
  let dbConnected = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log("[api] Database connected");
      dbConnected = true;
      break;
    } catch (e) {
      if (attempt === 10) break;
      console.warn(`[api] DB not ready (attempt ${attempt}/10), retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!dbConnected) {
    console.error("[api] Database not reachable after startup retries. Continuing in degraded mode; /ready will return 503 until DB recovers.");
  }

  if (dbConnected) {
    await seedAdminIfEmpty();
  } else {
    console.warn("[api] Skipping admin seed while DB is unavailable.");
  }

  async function detectExistingApi(port: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET", signal: controller.signal });
      const text = await res.text();
      if (!text || !text.trim()) return { ok: false, reason: `empty_response_http_${res.status}` };
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && json.service === "autolinks-api") {
          return { ok: true };
        }
      } catch {
        // ignore
      }
      if (text.toLowerCase().includes("autolinks-api")) return { ok: true };
      return { ok: false, reason: `unexpected_response_http_${res.status}` };
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      return { ok: false, reason };
    } finally {
      clearTimeout(timeout);
    }
  }

  const DEV_STANDBY_PROBE_MS = 5_000;
  const DEV_STANDBY_MISS_LIMIT = 2;
  const STANDBY_RECOVERY_ENABLED = !IS_PRODUCTION;
  let standby: ReturnType<typeof setInterval> | null = null;
  let standbyProbeInFlight = false;
  let standbyMisses = 0;
  let shuttingDown = false;
  // eslint-disable-next-line prefer-const
  let server: ReturnType<typeof app.listen>;

  function clearStandby() {
    if (!standby) return;
    clearInterval(standby);
    standby = null;
    standbyMisses = 0;
  }

  function startServer() {
    clearStandby();
    server = app.listen(PORT, HOST, () => {
      console.log(`[api] Listening on http://${HOST}:${PORT}`);
    });
    server.on("error", onServerError);
  }

  function startStandbyMonitor(owner: ReturnType<typeof app.listen>) {
    if (!STANDBY_RECOVERY_ENABLED) return;
    if (standby) return;
    console.warn(`[api] dev standby monitor enabled (probe=${DEV_STANDBY_PROBE_MS}ms miss_limit=${DEV_STANDBY_MISS_LIMIT}).`);
    standby = setInterval(() => {
      if (shuttingDown || standbyProbeInFlight) return;
      standbyProbeInFlight = true;
      void detectExistingApi(PORT)
        .then((probe) => {
          if (probe.ok) {
            standbyMisses = 0;
            return;
          }
          standbyMisses += 1;
          console.warn(`[api] standby probe failed (${standbyMisses}/${DEV_STANDBY_MISS_LIMIT}): ${probe.reason ?? "unknown"}`);
          if (standbyMisses < DEV_STANDBY_MISS_LIMIT) return;
          console.warn(`[api] existing autolinks-api is unavailable; attempting to reclaim port ${PORT}...`);
          clearStandby();
          try { owner.close(); } catch { /* ignore: owner may not be in listening state */ }
          startServer();
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[api] standby monitor probe error: ${reason}`);
        })
        .finally(() => { standbyProbeInFlight = false; });
    }, DEV_STANDBY_PROBE_MS);
    standby.unref();
  }

  function onServerError(error: NodeJS.ErrnoException) {
    if (error?.code === "EADDRINUSE") {
      void detectExistingApi(PORT).then((detected) => {
        if (detected.ok) {
          console.warn(`[api] port ${PORT} already in use - existing autolinks-api detected; entering standby mode.`);
          startStandbyMonitor(server);
          return;
        }
        console.error(`[api] port ${PORT} already in use and does not look like autolinks-api.`);
        console.error("[api] Close the process using the port, or run the API with a different PORT.");
        console.error("[api] Tip (PowerShell): Get-NetTCPConnection -LocalPort 3116 | Select LocalAddress,State,OwningProcess");
        process.exit(1);
      });
      return;
    }
    console.error("[api] server error:", error);
    process.exit(1);
  }

  startServer();

  // On SIGTERM/SIGINT: stop accepting new connections, wait for in-flight requests
  // to finish, then drain the DB pool. Force-exit after 15s if not clean.
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearStandby();
    console.log(`[api] ${signal} received - shutting down gracefully...`);
    const finish = () => {
      pool.end()
        .then(() => { console.log("[api] Shutdown complete"); process.exit(0); })
        .catch(() => process.exit(1));
    };
    if (server && server.listening) {
      server.close(() => finish());
    } else {
      finish();
    }
    setTimeout(() => { console.error("[api] Forced exit after timeout"); process.exit(1); }, 15_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Log unhandled rejections instead of crashing silently
  process.on("unhandledRejection", (reason) => {
    console.error("[api] Unhandled rejection:", reason);
  });
}

main().catch((err) => { console.error("[api] Fatal startup error:", err); process.exit(1); });
