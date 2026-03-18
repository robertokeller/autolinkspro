import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { pool, execute, queryOne } from "./db.js";
import { authMiddleware, authRouter } from "./auth.js";
import { restRouter } from "./rest.js";
import { rpcRouter } from "./rpc.js";

const app = express();
app.set("trust proxy", 1); // trust first-hop proxy (Coolify/nginx) so req.ip reflects the real client IP
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3116);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const DEV_LOG_RPC_SUCCESS = String(process.env.DEV_LOG_RPC_SUCCESS || "").trim().toLowerCase() === "true";

// ─── In-memory rate limiters (per IP) ───────────────────────────────────────
// Auth endpoints: 20 req / 15 min  — brute-force guard
// RPC endpoint:  200 req / 60 s    — DoS guard for authenticated calls
//
// Both stores are cleaned every 5 min to prevent unbounded memory growth.
// Note: these are in-process only — reset on restart. Acceptable for a
// single-instance deploy. Upgrade to Redis when running multiple API replicas.

const _authRateStore = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_MAX = 20;
const AUTH_RATE_WINDOW = 15 * 60_000;

const _rpcRateStore = new Map<string, { count: number; resetAt: number }>();
const RPC_RATE_MAX = 500;    // per IP per window — comfortably above admin dashboard burst patterns
const RPC_RATE_WINDOW = 60_000; // 60 seconds

function authRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = _authRateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    _authRateStore.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW });
    next(); return;
  }
  entry.count += 1;
  if (entry.count > AUTH_RATE_MAX) {
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "rate_limited", ip, count: entry.count, rid }));
    res.status(429).json({ data: null, error: { message: "Muitas tentativas. Aguarde 15 minutos." } }); return;
  }
  next();
}

function rpcRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  // In local/dev, admin dashboards can burst while services are booting.
  // Keep protection strict in production only.
  if (!IS_PRODUCTION) {
    next(); return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = _rpcRateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    _rpcRateStore.set(ip, { count: 1, resetAt: now + RPC_RATE_WINDOW });
    next(); return;
  }
  entry.count += 1;
  if (entry.count > RPC_RATE_MAX) {
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "rpc_rate_limited", ip, count: entry.count, rid }));
    res.status(429).json({ data: null, error: { message: "Limite de chamadas excedido. Aguarde 1 minuto." } }); return;
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _authRateStore) { if (now > e.resetAt) _authRateStore.delete(ip); }
  for (const [ip, e] of _rpcRateStore)  { if (now > e.resetAt) _rpcRateStore.delete(ip);  }
}, 5 * 60_000).unref();

function ensureRequiredEnvVars() {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") return;

  const required = [
    "POSTGRES_PASSWORD",
    "JWT_SECRET",
    "SERVICE_TOKEN",
    "WEBHOOK_SECRET",
    "OPS_CONTROL_TOKEN",
    "CORS_ORIGIN",
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
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (corsOriginList.length > 0) {
      // In development, Vite may fall back to another port (5174, 5175, ...).
      // Allow any localhost origin even when CORS_ORIGIN is pinned.
      if (!IS_PRODUCTION && isLocal) { callback(null, true); return; }
      callback(null, corsOriginSet.has(normalizeCorsOriginEntry(origin)));
      return;
    }
    callback(null, isLocal);
  },
  credentials: true,
}));
// 1 MB is more than sufficient for any legitimate RPC payload.
// 10 MB was excessive and creates a trivial DoS vector for authenticated users.
app.use(express.json({ limit: "1mb" }));
// ─── Security headers ─────────────────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ─── Request ID ── generate per-request UUID, echo back in header ─────────────
// This ID must be added to every log line so that API ↔ microservice calls can
// be correlated when tracing an incident across multiple service logs.
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rid = (req.headers["x-request-id"] as string | undefined) ?? `api-${uuid()}`;
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
      userId,
      ip: req.ip ?? "-",
      rid,
    }));
  });
  next();
});

app.use(authMiddleware);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth/signin", authRateLimiter);
app.use("/auth/signup", authRateLimiter);
app.use("/auth/forgot-password", authRateLimiter);
app.use("/auth/reset-password", authRateLimiter);
app.use("/auth/resend-verification", authRateLimiter);
app.use("/auth", authRouter);
app.use("/api/rest", restRouter);
app.use("/functions/v1/rpc", rpcRateLimiter); // per-IP DoS guard before auth is checked
app.use("/functions/v1", rpcRouter);

// Health check — pings DB so container orchestrators get real liveness signal
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "autolinks-api", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: "autolinks-api", timestamp: new Date().toISOString(), error: "DB unavailable" });
  }
});

// ─── Global error handler (must be last middleware) ──────────────────────────
// Catches errors thrown synchronously inside route handlers or passed via next(err).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api] Unhandled route error:", err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).json({ data: null, error: { message: "Erro interno do servidor" } });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function seedAdminIfEmpty() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@autolinks.local").toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn("[api] ADMIN_PASSWORD not set — skipping admin seed (set it via env to create the first admin).");
    return;
  }

  const existing = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  if (Number(existing?.count ?? 0) > 0) return;

  const id = uuid();
  const hash = await bcrypt.hash(adminPassword, 10);
  const metadata = JSON.stringify({
    name: "Admin",
    account_status: "active",
    status_updated_at: new Date().toISOString(),
  });

  await execute(
    "INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4::jsonb,NOW())",
    [id, adminEmail, hash, metadata],
  );
  await execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,'admin')", [uuid(), id]);
  await execute(
    "INSERT INTO profiles (id, user_id, name, email, plan_id) VALUES ($1,$2,'Admin',$3,'plan-pro')",
    [uuid(), id, adminEmail],
  );
  console.log(`[api] Admin user seeded: ${adminEmail}`);
}

async function main() {
  ensureRequiredEnvVars();

  // Verify DB connection
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log("[api] Database connected");
      break;
    } catch (e) {
      if (attempt === 10) throw e;
      console.warn(`[api] DB not ready (attempt ${attempt}/10), retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  await seedAdminIfEmpty();

  async function detectExistingApi(port: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET", signal: controller.signal });
      const text = await res.text();
      if (!text || !text.trim()) return { ok: false, reason: `empty_response_http_${res.status}` };
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && (json as { service?: string }).service === "autolinks-api") {
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

  const server = app.listen(PORT, HOST, () => {
    console.log(`[api] Listening on http://${HOST}:${PORT}`);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error?.code === "EADDRINUSE") {
      void detectExistingApi(PORT).then((detected) => {
        if (detected.ok) {
          console.warn(`[api] port ${PORT} already in use — existing autolinks-api detected; entering standby mode.`);

          const standby = setInterval(() => undefined, 60_000);
          process.on("SIGINT", () => { clearInterval(standby); process.exit(0); });
          process.on("SIGTERM", () => { clearInterval(standby); process.exit(0); });
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
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // On SIGTERM/SIGINT: stop accepting new connections, wait for in-flight requests
  // to finish, then drain the DB pool. Force-exit after 15s if not clean.
  function shutdown(signal: string) {
    console.log(`[api] ${signal} received — shutting down gracefully...`);
    server.close(() => {
      pool.end()
        .then(() => { console.log("[api] Shutdown complete"); process.exit(0); })
        .catch(() => process.exit(1));
    });
    setTimeout(() => { console.error("[api] Forced exit after timeout"); process.exit(1); }, 15_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  // Log unhandled rejections instead of crashing silently
  process.on("unhandledRejection", (reason) => {
    console.error("[api] Unhandled rejection:", reason);
  });
}

main().catch((err) => { console.error("[api] Fatal startup error:", err); process.exit(1); });
