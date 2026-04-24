import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v4 as uuid } from "uuid";
import { query, queryOne, execute, transaction } from "./db.js";
import { getPasswordPolicyError } from "./password-policy.js";
import { isEmailDeliveryConfigured, sendEmail } from "./mailer.js";
import { getDisposableEmailError } from "./disposable-email.js";
import { activatePendingKiwifyPurchases } from "./kiwify/webhook-handler.js";
import { logAudit } from "./audit.js";
import { consumeRateLimit } from "./rate-limit-store.js";

const SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s || s === "changeme-jwt-secret-32chars-minimum") {
    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
      throw new Error("JWT_SECRET é obrigatório em produção. Defina uma chave forte com pelo menos 32 caracteres.");
    }
    console.warn("[auth] JWT_SECRET não definido — usando placeholder de desenvolvimento. NÃO use em produção.");
    return "changeme-jwt-secret-32chars-minimum";
  }
  // SECURITY: Enforce minimum 32 characters for JWT secret strength
  if (s.length < 32) {
    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
      throw new Error("JWT_SECRET must be at least 32 characters long. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    }
    console.warn("[auth] JWT_SECRET is too short (<32 chars) — use a stronger secret.");
  }
  return s;
})();
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "2h";

/** Strip everything except digits and leading '+'. E.g. "+55 (11) 9 1234-5678" → "+5511912345678" */
function sanitizePhone(raw: string): string {
  const stripped = raw.replace(/[^\d+]/g, "");
  return /^\+?\d{10,15}$/.test(stripped) ? stripped : "";
}

function isUniqueViolation(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "23505";
}

const SIGNUP_IDENTITY_EXISTS_MESSAGE = "E-mail ou WhatsApp já cadastrado. Faça login ou recupere sua conta.";

const SERVICE_TOKEN_RAW = String(process.env.SERVICE_TOKEN ?? "");
const SERVICE_TOKEN = SERVICE_TOKEN_RAW.trim();

// Validate SERVICE_TOKEN format in all environments
if (!SERVICE_TOKEN) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("SERVICE_TOKEN é obrigatório em produção. Defina um token forte (mínimo 32 caracteres).");
  }
  console.warn("[auth] SERVICE_TOKEN não definido — scheduler/service-to-service auth desabilitado. Defina SERVICE_TOKEN para produção.");
} else if (SERVICE_TOKEN.length < 32) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("SERVICE_TOKEN muito curto (mínimo 32 caracteres). Use um token forte.");
  }
  console.warn("[auth] SERVICE_TOKEN muito curto (<32 chars) — pode ser inseguro.");
} else if (/^changeme|^dev-|local-only/i.test(SERVICE_TOKEN)) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("SERVICE_TOKEN está com valor placeholder ('changeme', 'dev-', 'local-only'). Use um token forte.");
  }
  console.warn("[auth] SERVICE_TOKEN está com valor de exemplo — NÃO use em produção.");
}
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Cookie Secure — always enabled in production for security.
// Only disable explicitly via AUTH_SECURE_COOKIE=false for local dev.
const AUTH_SECURE_COOKIE = (() => {
  const envVal = process.env.AUTH_SECURE_COOKIE;
  if (envVal !== undefined && envVal !== null) {
    // Explicit override: allow disabling only for local dev
    return String(envVal).trim().toLowerCase() !== "false";
  }
  // Default: Secure in production, lax for localhost dev
  return IS_PRODUCTION;
})();

const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || "autolinks_at").trim() || "autolinks_at";
const AUTH_COOKIE_MAX_AGE_SECONDS = (() => {
  const envVal = Number(process.env.AUTH_COOKIE_MAX_AGE_SECONDS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  // Default: 2 hours (matches JWT expiry)
  return 2 * 60 * 60;
})();

function resolveCookieSameSite(): "Strict" | "Lax" | "None" {
  const raw = String(process.env.AUTH_COOKIE_SAMESITE || "strict").trim().toLowerCase();
  if (raw === "strict") return "Strict";
  if (raw === "none") return "None";
  return "Lax";
}

const AUTH_COOKIE_SAME_SITE = resolveCookieSameSite();
const BCRYPT_COST = (() => {
  const parsed = Number(process.env.BCRYPT_COST ?? "12");
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(10, Math.min(14, Math.trunc(parsed)));
})();

// Cookie Domain — set to ".seudominio.com" in production so the cookie is
// shared between the frontend domain and api.seudominio.com (API).
// Leave empty for localhost/dev environments.
const APP_PUBLIC_URL = resolvePublicUrl(process.env.APP_PUBLIC_URL || "");
const API_PUBLIC_URL = resolvePublicUrl(process.env.API_PUBLIC_URL || "");
const AUTH_COOKIE_DOMAIN = normalizeCookieDomain(process.env.AUTH_COOKIE_DOMAIN || "", API_PUBLIC_URL);
const EMAIL_VERIFY_ROUTE = "/auth/verificação-email";
const PASSWORD_RESET_ROUTE = "/auth/resetar-senha";
const VERIFY_TOKEN_TTL_MINUTES = normalizeMinutes(process.env.EMAIL_VERIFY_TOKEN_TTL_MINUTES, 24 * 60);
const PASSWORD_RESET_TOKEN_TTL_MINUTES = normalizeMinutes(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 30);

type AuthEmailTokenType = "email_verification" | "password_reset";

function normalizeMinutes(rawValue: unknown, fallbackMinutes: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMinutes;
  return Math.min(Math.floor(parsed), 7 * 24 * 60);
}

function resolvePublicUrl(rawValue: unknown) {
  const value = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeCookieDomain(rawValue: unknown, apiPublicUrl: string) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  const firstEntry = raw
    .split(",")
    .map((part) => part.trim())
    .find(Boolean) ?? "";
  if (!firstEntry) return "";

  let candidate = firstEntry
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!candidate) return "";

  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      console.warn(`[auth] AUTH_COOKIE_DOMAIN='${raw}' is invalid. Falling back to host-only cookie.`);
      return "";
    }
  }

  candidate = candidate
    .split("/")[0]
    .split(":")[0]
    .replace(/^\.+/, "")
    .toLowerCase()
    .trim();

  if (!candidate) return "";
  if (!/^[a-z0-9.-]+$/.test(candidate)) {
    console.warn(`[auth] AUTH_COOKIE_DOMAIN='${raw}' contains invalid characters. Falling back to host-only cookie.`);
    return "";
  }

  if (candidate === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return "";
  }

  const apiHost = (() => {
    if (!apiPublicUrl) return "";
    try {
      return new URL(apiPublicUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (apiHost && apiHost !== candidate && !apiHost.endsWith(`.${candidate}`)) {
    console.warn(
      `[auth] AUTH_COOKIE_DOMAIN='${raw}' is incompatible with API host '${apiHost}'. Falling back to host-only cookie.`,
    );
    return "";
  }

  if (raw !== candidate && raw !== `.${candidate}`) {
    console.warn(`[auth] AUTH_COOKIE_DOMAIN sanitized from '${raw}' to '${candidate}'.`);
  }

  return candidate;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) return false;

  if (
    normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1"
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

function resolveCookieDomainForRequest(req: Request): string {
  if (!AUTH_COOKIE_DOMAIN) return "";

  const requestOrigin = inferRequestOrigin(req);
  if (!requestOrigin) return AUTH_COOKIE_DOMAIN;

  let requestHost = "";
  try {
    requestHost = new URL(requestOrigin).hostname.toLowerCase();
  } catch {
    return AUTH_COOKIE_DOMAIN;
  }

  if (!requestHost || isPrivateOrLoopbackHost(requestHost)) {
    return "";
  }

  if (requestHost === AUTH_COOKIE_DOMAIN || requestHost.endsWith(`.${AUTH_COOKIE_DOMAIN}`)) {
    return AUTH_COOKIE_DOMAIN;
  }

  return "";
}

function inferRequestOrigin(req: Request) {
  const xForwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const xForwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = xForwardedProto || req.protocol || "http";
  const host = xForwardedHost || req.get("host") || "";
  if (!host) return "";
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function getApiPublicUrl(req: Request) {
  return API_PUBLIC_URL || inferRequestOrigin(req);
}

function getAppPublicUrl() {
  return APP_PUBLIC_URL;
}

function getTrustedBrowserOrigins() {
  const values = new Set<string>();
  const addValue = (rawValue: string) => {
    const value = resolvePublicUrl(rawValue);
    if (!value) return;
    try {
      values.add(new URL(value).origin);
    } catch {
      // ignore invalid origin
    }
  };

  addValue(APP_PUBLIC_URL);
  addValue(API_PUBLIC_URL);
  for (const rawEntry of String(process.env.CORS_ORIGIN || "").split(",")) {
    addValue(rawEntry);
  }
  if (!IS_PRODUCTION) {
    values.add("http://localhost:5173");
    values.add("http://127.0.0.1:5173");
  }
  return values;
}

function buildAppUrl(pathname: string, params?: Record<string, string>) {
  const base = getAppPublicUrl();
  if (!base) return "";
  const url = new URL(pathname, `${base}/`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildApiUrl(req: Request, pathname: string, params?: Record<string, string>) {
  const base = getApiPublicUrl(req);
  if (!base) return "";
  const url = new URL(pathname, `${base}/`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function generateEmailToken() {
  return randomBytes(32).toString("hex");
}

function hashEmailToken(rawToken: string) {
  return createHash("sha256").update(rawToken).digest("hex");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function invalidateActiveEmailTokens(userId: string, type: AuthEmailTokenType) {
  await execute(
    `UPDATE auth_email_tokens
        SET consumed_at = NOW()
      WHERE user_id = $1
        AND type = $2
        AND consumed_at IS NULL`,
    [userId, type],
  );
}

async function createAuthEmailToken(userId: string, type: AuthEmailTokenType, ttlMinutes: number) {
  const rawToken = generateEmailToken();
  const tokenHash = hashEmailToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await invalidateActiveEmailTokens(userId, type);
  await execute(
    `INSERT INTO auth_email_tokens (id, user_id, token_hash, type, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuid(), userId, tokenHash, type, expiresAt],
  );

  return { rawToken, expiresAt };
}

async function consumeAuthEmailToken(rawToken: string, type: AuthEmailTokenType) {
  const tokenHash = hashEmailToken(rawToken);
  return queryOne<{ id: string; user_id: string }>(
    `UPDATE auth_email_tokens
        SET consumed_at = NOW()
      WHERE token_hash = $1
        AND type = $2
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id, user_id`,
    [tokenHash, type],
  );
}

async function dispatchVerificationEmail(
  req: Request,
  user: { id: string; email: string; name: string },
  rawToken?: string,
) {
  const safeName = escapeHtml(user.name);
  const verifyToken = rawToken || (await createAuthEmailToken(user.id, "email_verification", VERIFY_TOKEN_TTL_MINUTES)).rawToken;
  const verifyUrl = buildApiUrl(req, "/auth/verify-email", { token: verifyToken });
  if (!verifyUrl) {
    return { ok: false as const, error: "API_PUBLIC_URL not configured" };
  }

  const html = `
    <p>Olá, ${safeName}.</p>
    <p>Confirme seu e-mail para ativar sua conta no Auto Links:</p>
    <p><a href="${verifyUrl}">Confirmar e-mail</a></p>
    <p>Se você não criou essa conta, ignore esta mensagem.</p>
  `;
  const text = `Olá, ${user.name}. Confirme seu e-mail: ${verifyUrl}`;

  return sendEmail({
    to: user.email,
    subject: "Confirme seu e-mail - Auto Links",
    html,
    text,
  });
}

async function dispatchPasswordResetEmail(
  user: { id: string; email: string; name: string },
  options?: { redirectTo?: string },
) {
  const safeName = escapeHtml(user.name);
  const resetToken = await createAuthEmailToken(user.id, "password_reset", PASSWORD_RESET_TOKEN_TTL_MINUTES);
  const appBase = getAppPublicUrl();
  if (!appBase) {
    return { ok: false as const, error: "APP_PUBLIC_URL not configured" };
  }

  const redirectPath = String(options?.redirectTo || "").trim();
  const defaultResetUrl = buildAppUrl(PASSWORD_RESET_ROUTE, { token: resetToken.rawToken });
  const resetUrl = (() => {
    if (!redirectPath) return defaultResetUrl;
    try {
      const candidate = new URL(redirectPath);
      const allowedOrigin = new URL(appBase).origin;
      if (candidate.origin !== allowedOrigin) return defaultResetUrl;
      candidate.searchParams.set("token", resetToken.rawToken);
      return candidate.toString();
    } catch {
      return defaultResetUrl;
    }
  })();

  const html = `
    <p>Olá, ${safeName}.</p>
    <p>Recebemos uma solicitação para redefinir sua senha no Auto Links.</p>
    <p><a href="${resetUrl}">Redefinir senha</a></p>
    <p>Se você não solicitou essa troca, ignore este e-mail.</p>
  `;
  const text = `Olá, ${user.name}. Redefina sua senha: ${resetUrl}`;

  return sendEmail({
    to: user.email,
    subject: "Redefinicao de senha - Auto Links",
    html,
    text,
  });
}

function parseCookies(rawCookieHeader: string | undefined): Record<string, string> {
  if (!rawCookieHeader) return {};
  const map: Record<string, string> = {};
  for (const chunk of rawCookieHeader.split(";")) {
    const item = chunk.trim();
    if (!item) continue;
    const sepIndex = item.indexOf("=");
    if (sepIndex <= 0) continue;
    const key = item.slice(0, sepIndex).trim();
    const value = item.slice(sepIndex + 1).trim();
    if (!key) continue;
    map[key] = value;
  }
  return map;
}

function serializeAuthCookie(value: string, clear = false, domain = ""): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${AUTH_COOKIE_SAME_SITE}`,
  ];

  if (domain) {
    parts.push(`Domain=${domain}`);
  }

  // Secure flag: enabled by default in production via AUTH_SECURE_COOKIE constant.
  if (AUTH_SECURE_COOKIE) {
    parts.push("Secure");
  }

  if (clear) {
    parts.push("Max-Age=0");
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else {
    parts.push(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`);
  }

  return parts.join("; ");
}

function setAuthCookie(res: Response, token: string) {
  const req = res.req as Request;
  const domain = resolveCookieDomainForRequest(req);
  res.setHeader("Set-Cookie", serializeAuthCookie(token, false, domain));
}

export function setSessionCookie(res: Response, token: string) {
  setAuthCookie(res, token);
}

function clearAuthCookie(res: Response) {
  const req = res.req as Request;
  const domain = resolveCookieDomainForRequest(req);
  const clearValues = [serializeAuthCookie("", true, domain)];
  if (AUTH_COOKIE_DOMAIN && AUTH_COOKIE_DOMAIN !== domain) {
    clearValues.push(serializeAuthCookie("", true, AUTH_COOKIE_DOMAIN));
  }
  res.setHeader("Set-Cookie", clearValues);
}

if (SERVICE_TOKEN_RAW && SERVICE_TOKEN_RAW !== SERVICE_TOKEN) {
  console.warn("[auth] SERVICE_TOKEN had leading/trailing whitespace and was normalized.");
}


// Pre-computed dummy hash for timing-safe "user not found" path in signin — prevents email enumeration.
// IMPORTANT: use a fixed low cost (10) here, NOT BCRYPT_COST.
// This hash is never checked for real security — it only exists to consume the same CPU time as a real
// bcrypt.compare() call so an attacker can't distinguish "user not found" from "wrong password" via timing.
// Using BCRYPT_COST (12-14) would block the Node.js event loop for 300-1000ms at startup per instance.
const SIGNIN_DUMMY_HASH = bcrypt.hashSync("__autolinks_dummy_no_real_credential__", 10);

// ─── JWT helpers ─────────────────────────────────────────────────────────────
export interface TokenPayload {
  sub: string;  // user id
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<TokenPayload, "iat" | "exp">): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN as any, algorithm: "HS256" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as TokenPayload;
  } catch {
    return null;
  }
}

function shouldAllowAuthBootstrapWithRevokedToken(req: Request): boolean {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || "");

  if (
    method === "POST"
    && (
      path === "/auth/signin"
      || path === "/auth/signup"
      || path === "/auth/forgot-password"
      || path === "/auth/reset-password"
      || path === "/auth/resend-verification"
    )
  ) {
    return true;
  }

  if (method === "GET" && path === "/auth/verify-email") {
    return true;
  }

  return false;
}

// ─── Middleware: attach user from JWT ────────────────────────────────────────


export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const rid = (req as { rid?: string }).rid ?? "-";
  const authHeader = req.headers.authorization ?? "";
  const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cookieMap = parseCookies(req.headers.cookie);
  let cookieToken = "";
  if (cookieMap[AUTH_COOKIE_NAME]) {
    try {
      cookieToken = decodeURIComponent(cookieMap[AUTH_COOKIE_NAME]);
    } catch {
      cookieToken = cookieMap[AUTH_COOKIE_NAME];
    }
  }
  const token = (headerToken || cookieToken).trim();
  if (!token) { next(); return; }
  const usingCookieTokenOnly = !headerToken && !!cookieToken;

  // Service token shortcut (used by scheduler) — timing-safe comparison
  if (SERVICE_TOKEN) {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(SERVICE_TOKEN);
    if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
      req.currentUser = { sub: "service", email: "service@internal", role: "admin", isService: true };
      next(); return;
    }
  }

  const payload = verifyToken(token);
  if (payload && payload.sub !== "service") {
    // Check JWT revocation: reject tokens issued before token_invalidated_before
    try {
      const iatMs = (payload.iat ?? 0) * 1000;
      const row = await queryOne<{ token_invalidated_before: string | null }>(
        "SELECT token_invalidated_before FROM users WHERE id = $1",
        [payload.sub]
      );
      if (row?.token_invalidated_before) {
        const invalidatedMs = Date.parse(row.token_invalidated_before);
        if (Number.isFinite(invalidatedMs) && iatMs < invalidatedMs) {
          if (shouldAllowAuthBootstrapWithRevokedToken(req)) {
            // If a stale cookie blocks sign-in/recovery endpoints, users get stuck in a
            // "sessao expirada" loop. Clear it and continue anonymously for bootstrap.
            clearAuthCookie(res);
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              svc: "api",
              event: "token_revoked_ignored_for_auth_bootstrap",
              userId: payload.sub,
              path: req.path,
              ip: req.ip ?? "-",
              rid,
            }));
            next();
            return;
          }
          if (usingCookieTokenOnly) {
            // Keep browser clients from getting stuck retrying with a revoked cookie.
            clearAuthCookie(res);
          }
          // Token was revoked (user blocked or signed out) — reject explicitly with 401.
          console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "token_revoked_detected", userId: payload.sub, ip: req.ip ?? "-", tokenIat: payload.iat, rid }));
          res.status(401).json({ data: null, error: { message: "Sessão expirada. Faça login novamente." } }); return;
        }
      }
    } catch (error) {
      // DB unavailable — fail CLOSED: reject the token rather than silently dropping auth context.
      // Calling next() without setting req.currentUser would silently treat the user as anonymous,
      // which may bypass route-level guards that only check for the presence of currentUser.
      console.warn("[auth] token revocation check failed; rejecting request for safety", error);
      res.status(503).json({ data: null, error: { message: "Serviço temporariamente indisponível. Tente novamente em instantes." } }); return;
    }
    req.currentUser = payload;
  } else if (payload) {
    req.currentUser = payload;
  } else if (usingCookieTokenOnly) {
    // Malformed/expired JWT in cookie: clear it so next requests are anonymous.
    clearAuthCookie(res);
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) {
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "unauthorized", path: req.path, ip: req.ip ?? "-", rid }));
    res.status(401).json({ data: null, error: { message: "Não autenticado" } }); return;
  }
  next();
}

function extractRequestOrigin(req: Request) {
  const origin = String(req.headers.origin || "").trim();
  if (origin) return origin;

  const referer = String(req.headers.referer || "").trim();
  if (!referer) return "";
  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

function isTrustedLocalDevOrigin(origin: string) {
  if (IS_PRODUCTION) return false;
  try {
    const parsed = new URL(String(origin || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isPrivateOrLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function requireTrustedOriginForSessionWrite(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }

  const authHeader = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    next();
    return;
  }

  const cookieMap = parseCookies(req.headers.cookie);
  if (!cookieMap[AUTH_COOKIE_NAME]) {
    next();
    return;
  }

  const requestOrigin = extractRequestOrigin(req);
  const trustedOrigins = getTrustedBrowserOrigins();
  if (requestOrigin && (trustedOrigins.has(requestOrigin) || isTrustedLocalDevOrigin(requestOrigin))) {
    next();
    return;
  }

  const rid = (req as { rid?: string }).rid ?? "-";
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "api",
    event: "csrf_blocked",
    path: req.path,
    ip: req.ip ?? "-",
    rid,
    hasOrigin: Boolean(requestOrigin),
  }));
  res.status(403).json({ data: null, error: { message: "Origem da requisição não autorizada" } });
}

// ─── Auth router ─────────────────────────────────────────────────────────────
export const authRouter = Router();

interface AuthUserWithRole {
  id: string;
  email: string;
  role: string;
  metadata: Record<string, unknown>;
  created_at: string;
  email_confirmed_at?: string | null;
}

function buildUserPayload(user: AuthUserWithRole) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    user_metadata: user.metadata ?? {},
    app_metadata: { role: user.role },
    aud: "authenticated",
    created_at: user.created_at,
    email_confirmed_at: user.email_confirmed_at ?? null,
  };
}

function buildSessionPayload(
  user: AuthUserWithRole,
  expiresAt: number,
) {
  return {
    // JWT is transported only via HttpOnly cookie.
    access_token: "",
    token_type: "bearer",
    expires_in: AUTH_COOKIE_MAX_AGE_SECONDS,
    expires_at: expiresAt,
    user: buildUserPayload(user),
  };
}

function issueSessionForCookie(
  res: Response,
  user: AuthUserWithRole,
) {
  const accessToken = signToken({ sub: user.id, email: user.email, role: user.role });
  const decoded = jwt.decode(accessToken) as { exp?: number } | null;
  const expiresAt = decoded?.exp ?? Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  setAuthCookie(res, accessToken);
  return buildSessionPayload(user, expiresAt);
}

function buildSessionFromRequestAuth(
  user: AuthUserWithRole,
  req: Request,
) {
  const expiresAt = req.currentUser?.exp ?? Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  return buildSessionPayload(user, expiresAt);
}

async function getUserWithRole(id: string) {
  // Single JOIN instead of two separate queries (avoids N+1 on every auth action)
  return queryOne<AuthUserWithRole>(
    `SELECT u.id, u.email, u.metadata, u.created_at, u.email_confirmed_at, COALESCE(r.role, 'user') AS role
     FROM users u
     LEFT JOIN user_roles r ON r.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
}

// POST /auth/signup
// Set DISABLE_SIGNUP=true in production when user creation is managed via
// the admin panel. Default is false so local dev and first-boot seeding work.
const SIGNUP_DISABLED = String(process.env.DISABLE_SIGNUP ?? "false").toLowerCase() === "true";

class SignupIdentityExistsError extends Error {
  constructor() {
    super("signup_identity_exists");
    this.name = "SignupIdentityExistsError";
  }
}

function resolveDefaultSignupPlanId(configValue: unknown): string {
  const source = configValue && typeof configValue === "object" && !Array.isArray(configValue)
    ? configValue as Record<string, unknown>
    : {};
  const plansRaw = Array.isArray(source.plans) ? source.plans : [];
  const plans = plansRaw
    .map((row) => (row && typeof row === "object" ? row as Record<string, unknown> : {}))
    .map((plan) => ({
      id: String(plan.id ?? "").trim(),
      isActive: plan.isActive !== false,
    }))
    .filter((plan) => plan.id.length > 0);

  const preferred = String(source.defaultSignupPlanId ?? "").trim();
  if (preferred) {
    const preferredActive = plans.find((plan) => plan.id === preferred && plan.isActive);
    if (preferredActive) return preferredActive.id;
  }

  const firstActive = plans.find((plan) => plan.isActive);
  if (firstActive) return firstActive.id;
  if (preferred) return preferred;
  if (plans[0]?.id) return plans[0].id;
  return "plan-starter";
}

function resolvePlanPeriodMs(periodRaw: string): number | null {
  const period = String(periodRaw || "").toLowerCase().trim();
  if (!period) return null;

  const day = 24 * 60 * 60 * 1000;
  const month = 30 * day;
  const year = 365 * day;

  const m = period.match(/(\d+)\s*(dia|dias|mes|m[êe]s|meses|ano|anos)/i);
  if (m) {
    const value = Number(m[1]);
    const unit = String(m[2]).toLowerCase();
    if (unit.startsWith("dia")) return value * day;
    if (unit.startsWith("mes") || unit.startsWith("mês")) return value * month;
    if (unit.startsWith("ano")) return value * year;
  }

  if (period.includes("dia")) return 7 * day;
  if (period.includes("mes") || period.includes("mês")) return month;
  if (period.includes("ano")) return year;
  return null;
}

function fallbackPlanPeriodMs(planId: string): number {
  const day = 24 * 60 * 60 * 1000;
  if (planId === "plan-starter") return 7 * day;
  return 30 * day;
}

function resolveSignupPlanAssignment(configValue: unknown): { planId: string; planExpiresAt: string | null } {
  const source = configValue && typeof configValue === "object" && !Array.isArray(configValue)
    ? configValue as Record<string, unknown>
    : {};
  const plansRaw = Array.isArray(source.plans) ? source.plans : [];
  const plans = plansRaw
    .map((row) => (row && typeof row === "object" ? row as Record<string, unknown> : {}))
    .map((plan) => ({
      id: String(plan.id ?? "").trim(),
      isActive: plan.isActive !== false,
      period: String(plan.period ?? "").trim(),
    }))
    .filter((plan) => plan.id.length > 0);

  const planId = resolveDefaultSignupPlanId(configValue);
  const selectedPlan = plans.find((plan) => plan.id === planId) || null;
  const periodMs = selectedPlan?.period
    ? resolvePlanPeriodMs(selectedPlan.period)
    : fallbackPlanPeriodMs(planId);

  return {
    planId,
    planExpiresAt: periodMs ? new Date(Date.now() + periodMs).toISOString() : null,
  };
}

async function getSignupPlanAssignment(): Promise<{ planId: string; planExpiresAt: string | null }> {
  try {
    const row = await queryOne<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'admin_config'");
    return resolveSignupPlanAssignment(row?.value ?? {});
  } catch {
    const fallbackPlanId = "plan-starter";
    return {
      planId: fallbackPlanId,
      planExpiresAt: new Date(Date.now() + fallbackPlanPeriodMs(fallbackPlanId)).toISOString(),
    };
  }
}

function resolveUserName(metadata: Record<string, unknown> | null | undefined, email: string) {
  const value = typeof metadata?.name === "string" ? metadata.name.trim() : "";
  return value || email.split("@")[0] || "Usuario";
}

function readBodyObject(req: Request): Record<string, unknown> {
  const candidate = req.body;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return {};
}

function maskEmailForLog(value: string) {
  const normalized = String(value || "").toLowerCase().trim();
  const [local = "", domain = ""] = normalized.split("@");
  if (!local || !domain) return "invalid_email";

  const localMasked = local.length <= 2
    ? `${local.slice(0, 1)}*`
    : `${local.slice(0, 2)}***`;

  const domainParts = domain.split(".");
  const root = domainParts[0] || "";
  const suffix = domainParts.length > 1 ? `.${domainParts.slice(1).join(".")}` : "";
  const rootMasked = root.length <= 2
    ? `${root.slice(0, 1)}*`
    : `${root.slice(0, 2)}***`;

  return `${localMasked}@${rootMasked}${suffix}`;
}

function buildVerificationRedirectUrl(status: "success" | "invalid" | "error") {
  return buildAppUrl(EMAIL_VERIFY_ROUTE, { status });
}

function respondVerificationRedirect(
  res: Response,
  status: "success" | "invalid" | "error",
  fallbackMessage: string,
) {
  const target = buildVerificationRedirectUrl(status);
  if (target) {
    res.redirect(302, target);
    return;
  }
  res.status(status === "success" ? 200 : 400).json({
    data: { status },
    error: status === "success" ? null : { message: fallbackMessage },
  });
}

authRouter.post("/signup", async (req, res) => {
  if (SIGNUP_DISABLED) {
    res.status(403).json({ data: { user: null, session: null }, error: { message: "Cadastro desativado. Contate o administrador." } }); return;
  }
  try {
    if (!isEmailDeliveryConfigured()) {
      res.status(503).json({ data: { user: null, session: null }, error: { message: "Servico de e-mail indisponível. Tente novamente mais tarde." } }); return;
    }

    const body = readBodyObject(req);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    const options = (body.options && typeof body.options === "object" && !Array.isArray(body.options))
      ? body.options as { data?: { name?: string; phone?: string } }
      : undefined;
    const phone = sanitizePhone(String(options?.data?.phone ?? ""));
    if (!email || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email e senha obrigatórios" } }); return; }
    if (!phone) { res.json({ data: { user: null, session: null }, error: { message: "Telefone (WhatsApp) obrigatório" } }); return; }
    const passwordPolicyError = getPasswordPolicyError(password);
    if (passwordPolicyError) { res.json({ data: { user: null, session: null }, error: { message: passwordPolicyError } }); return; }
    const normalizedEmail = email.toLowerCase().trim();
    const disposableEmailError = getDisposableEmailError(normalizedEmail);
    if (disposableEmailError) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: disposableEmailError } }); return;
    }

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const name = options?.data?.name ?? email.split("@")[0];
    const metadata = { name, account_status: "active", status_updated_at: new Date().toISOString() } as Record<string, unknown>;
    const id = uuid();
    const signupPlan = await getSignupPlanAssignment();
    const signupPlanId = signupPlan.planId;

    try {
      await transaction(async (client) => {
        // Serialize signup writes by identity to avoid duplicate trials under race.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`signup-email:${normalizedEmail}`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`signup-phone:${phone}`]);

        const emailExists = await client.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
        if ((emailExists.rowCount ?? 0) > 0) {
          throw new SignupIdentityExistsError();
        }

        const phoneExists = await client.query("SELECT user_id FROM profiles WHERE phone = $1 LIMIT 1", [phone]);
        if ((phoneExists.rowCount ?? 0) > 0) {
          throw new SignupIdentityExistsError();
        }

        await client.query(
          "INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4,$5)",
          [id, normalizedEmail, hash, JSON.stringify(metadata), null],
        );
        await client.query("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,'user')", [uuid(), id]);
        await client.query(
          "INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at, phone) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [uuid(), id, name, normalizedEmail, signupPlanId, signupPlan.planExpiresAt, phone],
        );
      });
    } catch (signupError) {
      if (signupError instanceof SignupIdentityExistsError || isUniqueViolation(signupError)) {
        await bcrypt.compare(password, SIGNIN_DUMMY_HASH);
        res.status(409).json({ data: { user: null, session: null }, error: { message: SIGNUP_IDENTITY_EXISTS_MESSAGE } }); return;
      }
      throw signupError;
    }

    // Activate any pending Kiwify purchases for this email
    try { await activatePendingKiwifyPurchases(id, normalizedEmail); } catch (e) { console.error("[auth] kiwify pending activation error:", e); }

    const verifyToken = await createAuthEmailToken(id, "email_verification", VERIFY_TOKEN_TTL_MINUTES);

    const user = await getUserWithRole(id);
    if (!user) { res.json({ data: { user: null, session: null }, error: { message: "Erro ao criar conta" } }); return; }
    const emailResult = await dispatchVerificationEmail(req, { id, email: normalizedEmail, name }, verifyToken.rawToken);
    if ("error" in emailResult) {
      console.error("[auth] signup verification email error:", emailResult.error);
    }

    // Audit log: user created
    try {
      const actorUserId = req.currentUser?.sub; // anonymous signup => null
      await logAudit({
        action: "user.created",
        actor_user_id: actorUserId,
        target_user_id: id,
        resource_type: "user",
        resource_id: id,
        details: { email: normalizedEmail, name, plan_id: signupPlanId, phone },
        ip_address: req.ip,
        user_agent: req.headers?.["user-agent"],
      });
    } catch (auditErr) {
      console.error("[auth] failed to write audit log for signup:", auditErr);
    }

    res.json({
      data: {
        user: buildUserPayload(user),
        session: null,
        verification_email_sent: emailResult.ok,
      },
      error: null,
    });
  } catch (e) {
    console.error("[auth] signup error:", e);
    res.json({ data: { user: null, session: null }, error: { message: "Erro interno" } });
  }
});

// POST /auth/resend-verification
authRouter.post("/resend-verification", async (req, res) => {
  try {
    if (!isEmailDeliveryConfigured()) {
      res.status(503).json({ data: { sent: false }, error: { message: "Servico de e-mail indisponível no momento." } }); return;
    }

    const body = readBodyObject(req);
    const email = String(body.email ?? "");
    const normalizedEmail = String(email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      res.json({ data: { sent: true }, error: null }); return;
    }

    const user = await queryOne<{ id: string; email: string; metadata: Record<string, unknown>; email_confirmed_at: string | null }>(
      "SELECT id, email, metadata, email_confirmed_at FROM public.users WHERE email = $1",
      [normalizedEmail],
    );

    if (user && !user.email_confirmed_at) {
      // Security M-8: per-email cooldown prevents email harassment / cost abuse via multi-IP
      const emailLimit = await consumeRateLimit({ namespace: "email-send", scopeKey: normalizedEmail, max: 3, windowMs: 60 * 60 * 1000 }).catch(() => null);
      if (emailLimit && !emailLimit.allowed) {
        // Return success silently — do not reveal the email state to unauthenticated callers
        res.json({ data: { sent: true }, error: null }); return;
      }
      const name = resolveUserName(user.metadata, user.email);
      const result = await dispatchVerificationEmail(req, { id: user.id, email: user.email, name });
      if ("error" in result) {
        console.error("[auth] resend verification email error:", result.error);
      }
    }

    res.json({ data: { sent: true }, error: null });
  } catch (e) {
    console.error("[auth] resend verification error:", e);
    res.json({ data: { sent: false }, error: { message: "Erro interno" } });
  }
});

// POST /auth/forgot-password
authRouter.post("/forgot-password", async (req, res) => {
  try {
    if (!isEmailDeliveryConfigured()) {
      res.status(503).json({ data: { sent: false }, error: { message: "Servico de e-mail indisponível no momento." } }); return;
    }

    const body = readBodyObject(req);
    const email = String(body.email ?? "");
    const options = (body.options && typeof body.options === "object" && !Array.isArray(body.options))
      ? body.options as { redirectTo?: string }
      : undefined;
    const normalizedEmail = String(email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      res.json({ data: { sent: true }, error: null }); return;
    }

    const user = await queryOne<{ id: string; email: string; metadata: Record<string, unknown> }>(
      "SELECT id, email, metadata FROM public.users WHERE email = $1",
      [normalizedEmail],
    );

    if (user) {
      // Security M-8: per-email cooldown prevents email harassment / cost abuse
      const emailLimit = await consumeRateLimit({ namespace: "email-send", scopeKey: normalizedEmail, max: 3, windowMs: 60 * 60 * 1000 }).catch(() => null);
      if (!emailLimit || emailLimit.allowed) {
        const name = resolveUserName(user.metadata, user.email);
        const result = await dispatchPasswordResetEmail({ id: user.id, email: user.email, name }, options);
        if ("error" in result) {
          console.error("[auth] forgot-password email error:", result.error);
        }
      }
    }

    // Intentionally always return success to avoid account enumeration.
    res.json({ data: { sent: true }, error: null });
  } catch (e) {
    console.error("[auth] forgot-password error:", e);
    res.json({ data: { sent: false }, error: { message: "Erro interno" } });
  }
});

// POST /auth/reset-password
authRouter.post("/reset-password", async (req, res) => {
  try {
    const body = readBodyObject(req);
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");
    const rawToken = String(token || "").trim();
    const nextPassword = String(password || "");
    if (!rawToken || !nextPassword) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: "Token e nova senha sao obrigatórios" } }); return;
    }

    const passwordPolicyError = getPasswordPolicyError(nextPassword);
    if (passwordPolicyError) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: passwordPolicyError } }); return;
    }

    const consumed = await consumeAuthEmailToken(rawToken, "password_reset");
    if (!consumed) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: "Link inválido ou expirado" } }); return;
    }

    const hash = await bcrypt.hash(nextPassword, BCRYPT_COST);
    await execute(
      `UPDATE users
          SET password_hash = $1,
              token_invalidated_before = NOW(),
              updated_at = NOW()
        WHERE id = $2`,
      [hash, consumed.user_id],
    );
    await invalidateActiveEmailTokens(consumed.user_id, "password_reset");

    const user = await getUserWithRole(consumed.user_id);
    if (!user) {
      res.status(404).json({ data: { user: null, session: null }, error: { message: "Usuário não encontrado" } }); return;
    }

    // Audit log: password reset successful
    try {
      await logAudit({
        action: "user.password_reset",
        actor_user_id: consumed.user_id,
        target_user_id: consumed.user_id,
        resource_type: "user",
        resource_id: consumed.user_id,
        details: { method: "token" },
        ip_address: req.ip,
        user_agent: req.headers?.["user-agent"],
      });
    } catch (auditErr) {
      console.error("[auth] failed to write audit log for password reset:", auditErr);
    }

    const session = issueSessionForCookie(res, user);
    res.json({ data: { user: session.user, session }, error: null });
  } catch (e) {
    console.error("[auth] reset-password error:", e);
    res.status(500).json({ data: { user: null, session: null }, error: { message: "Erro interno" } });
  }
});

// GET /auth/verify-email?token=...
authRouter.get("/verify-email", async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) {
    respondVerificationRedirect(res, "invalid", "Token de verificação ausente");
    return;
  }

  try {
    const consumed = await consumeAuthEmailToken(token, "email_verification");
    if (!consumed) {
      respondVerificationRedirect(res, "invalid", "Link inválido ou expirado");
      return;
    }

    await execute(
      `UPDATE users
          SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [consumed.user_id],
    );
    await invalidateActiveEmailTokens(consumed.user_id, "email_verification");

    // Audit log: email verified
    try {
      await logAudit({
        action: "user.email_verified",
        actor_user_id: consumed.user_id,
        target_user_id: consumed.user_id,
        resource_type: "user",
        resource_id: consumed.user_id,
        details: { method: "email_token" },
        ip_address: req.ip,
        user_agent: req.headers?.["user-agent"],
      });
    } catch (auditErr) {
      console.error("[auth] failed to write audit log for email verify:", auditErr);
    }

    respondVerificationRedirect(res, "success", "");
  } catch (error) {
    console.error("[auth] verify-email error:", error);
    respondVerificationRedirect(res, "error", "Falha ao confirmar e-mail");
  }
});

// POST /auth/signin
authRouter.post("/signin", async (req, res) => {
  try {
    type SigninUser = {
      id: string;
      email: string;
      password_hash: string;
      metadata: Record<string, unknown>;
      created_at: string;
      email_confirmed_at: string | null;
    };

    const body = readBodyObject(req);
    const rawIdentifier = String(body.email ?? "");
    const password = String(body.password ?? "");
    if (!rawIdentifier || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email ou telefone e senha obrigatórios" } }); return; }
    const identifier = rawIdentifier.trim();
    // Detect whether the user typed a phone number or an email
    const isPhone = /^\+?\d[\d\s()-]{7,}$/.test(identifier);
    const lookupValue = isPhone ? sanitizePhone(identifier) : identifier.toLowerCase();
    if (isPhone && !lookupValue) {
      res.json({ data: { user: null, session: null }, error: { message: "Credenciais inválidas" } }); return;
    }
    const emailForLog = isPhone ? `phone:${lookupValue.slice(0, 4)}***` : maskEmailForLog(identifier);
    const user = await (async () => {
      if (isPhone) {
        const profiles = await query<{ user_id: string }>(
          "SELECT user_id FROM public.profiles WHERE phone = $1 ORDER BY created_at ASC, user_id ASC LIMIT 2",
          [lookupValue],
        );
        if (profiles.length === 0) return null;
        if (profiles.length > 1) return "AMBIGUOUS_PHONE";

        return queryOne<SigninUser>(
          "SELECT id, email, password_hash, metadata, created_at, email_confirmed_at FROM public.users WHERE id = $1",
          [profiles[0].user_id],
        );
      }
      return queryOne<SigninUser>(
        "SELECT id, email, password_hash, metadata, created_at, email_confirmed_at FROM public.users WHERE email = $1", [lookupValue],
      );
    })();

    if (user === "AMBIGUOUS_PHONE") {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "duplicate_phone_linked", email: emailForLog, ip: req.ip ?? "-", rid }));
      res.json({ data: { user: null, session: null }, error: { message: "Este WhatsApp está vinculado a mais de uma conta. Fale com o suporte para regularizar o acesso." } }); return;
    }

    if (!user) {
      await bcrypt.compare(password, SIGNIN_DUMMY_HASH); // constant-time — prevents email enumeration via timing oracle
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "user_not_found", email: emailForLog, ip: req.ip ?? "-", rid }));
      try { await logAudit({ action: "session.failed", details: { reason: "user_not_found", email: emailForLog }, ip_address: req.ip, user_agent: req.headers?.["user-agent"] }); } catch { /* non-blocking */ }
      res.json({ data: { user: null, session: null }, error: { message: "Credenciais inválidas" } }); return;
    }

    const meta = user.metadata ?? {};
    if (meta.account_status === "blocked" || meta.account_status === "archived") {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "account_blocked", email: emailForLog, ip: req.ip ?? "-", rid }));
      try { await logAudit({ action: "session.failed", actor_user_id: user.id, details: { reason: "account_blocked" }, ip_address: req.ip, user_agent: req.headers?.["user-agent"] }); } catch { /* non-blocking */ }
      res.json({ data: { user: null, session: null }, error: { message: "Conta bloqueada ou arquivada" } }); return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "wrong_password", email: emailForLog, ip: req.ip ?? "-", rid }));
      try { await logAudit({ action: "session.failed", actor_user_id: user.id, details: { reason: "wrong_password" }, ip_address: req.ip, user_agent: req.headers?.["user-agent"] }); } catch { /* non-blocking */ }
      res.json({ data: { user: null, session: null }, error: { message: "Credenciais inválidas" } }); return;
    }

    if (!user.email_confirmed_at) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "email_not_confirmed", email: emailForLog, ip: req.ip ?? "-", rid }));
      try { await logAudit({ action: "session.failed", actor_user_id: user.id, details: { reason: "email_not_confirmed" }, ip_address: req.ip, user_agent: req.headers?.["user-agent"] }); } catch { /* non-blocking */ }
      res.json({ data: { user: null, session: null }, error: { message: "E-mail ainda não confirmado. Verifique sua caixa de entrada." } }); return;
    }

    const roleRow = await queryOne<{ role: string }>("SELECT role FROM public.user_roles WHERE user_id = $1", [user.id]);
    const role = roleRow?.role ?? "user";
    const rid = (req as { rid?: string }).rid ?? "-";
    const uidHash = createHash("sha256").update(`${String(process.env.LOG_HASH_SALT || "autolinks-log-salt-v2")}:${user.id}`).digest("hex").slice(0, 16);
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_success", userId: `u_${uidHash}`, ip: req.ip ?? "-", rid }));

    // Audit log: user signed in
    try {
      await logAudit({
        action: "session.created",
        actor_user_id: user.id,
        target_user_id: user.id,
        resource_type: "session",
        details: { role, ip: req.ip },
        ip_address: req.ip,
        user_agent: req.headers?.["user-agent"],
      });
    } catch (auditErr) {
      console.error("[auth] failed to write audit log for signin:", auditErr);
    }

    const session = issueSessionForCookie(res, { ...user, role });
    res.json({ data: { user: session.user, session }, error: null });
  } catch (e) {
    console.error("[auth] signin error:", e);
    res.json({ data: { user: null, session: null }, error: { message: "Erro interno" } });
  }
});

// POST /auth/signout
authRouter.post("/signout", async (req, res) => {
  // Inválidate all existing tokens for this user so that concurrent sessions
  // and any stolen tokens are immediately rejected by authMiddleware.
  const userId = req.currentUser?.sub;
  if (userId && userId !== "service") {
    try {
      await execute("UPDATE users SET token_invalidated_before = NOW() WHERE id = $1", [userId]);

      // Audit log: session revoked
      try {
        await logAudit({
          action: "session.revoked",
          actor_user_id: userId,
          target_user_id: userId,
          resource_type: "session",
          details: { reason: "user_signout" },
          ip_address: req.ip,
          user_agent: req.headers?.["user-agent"],
        });
      } catch (auditErr) {
        console.error("[auth] failed to write audit log for signout:", auditErr);
      }
    } catch {
      // Non-fatal — the client will still clear its local session
    }
  }
  clearAuthCookie(res);
  res.json({ error: null });
});

// GET /auth/user
authRouter.get("/user", requireAuth, async (req, res) => {
  try {
    const user = await getUserWithRole(req.currentUser!.sub);
    if (!user) { res.json({ data: { user: null }, error: { message: "Usuário não encontrado" } }); return; }
    res.json({ data: { user: buildUserPayload(user) }, error: null });
  } catch (e) {
    console.error("[auth] getUser error:", e);
    res.json({ data: { user: null }, error: { message: "Erro interno" } });
  }
});

// GET /auth/session
authRouter.get("/session", requireAuth, async (req, res) => {
  try {
    const user = await getUserWithRole(req.currentUser!.sub);
    if (!user) { res.json({ data: { session: null }, error: null }); return; }
    const session = buildSessionFromRequestAuth(user, req);
    res.json({ data: { session }, error: null });
  } catch (e) {
    console.error("[auth] getSession error:", e);
    res.json({ data: { session: null }, error: null });
  }
});

// POST /auth/refresh — silently re-issue a fresh JWT + cookie before the current one expires.
// Called proactively by the client when the session is within 5 minutes of expiry.
// Requires a still-valid (non-expired, non-revoked) cookie — no password needed.
authRouter.post("/refresh", requireAuth, async (req, res) => {
  try {
    const user = await getUserWithRole(req.currentUser!.sub);
    if (!user) {
      res.status(401).json({ data: { session: null }, error: { message: "Usuário não encontrado" } });
      return;
    }
    const session = issueSessionForCookie(res, user);
    res.json({ data: { session }, error: null });
  } catch (e) {
    console.error("[auth] refresh error:", e);
    res.status(500).json({ data: { session: null }, error: { message: "Erro interno" } });
  }
});

// POST /auth/update-user
authRouter.post("/update-user", requireAuth, async (req, res) => {
  try {
    const body = readBodyObject(req);
    const password = typeof body.password === "string" ? body.password : String(body.password ?? "");
    const current_password = typeof body.current_password === "string" ? body.current_password : String(body.current_password ?? "");
    const metadata = (body.data && typeof body.data === "object" && !Array.isArray(body.data))
      ? body.data as Record<string, unknown>
      : undefined;
    const email = typeof body.email === "string" ? body.email : String(body.email ?? "");
    const rawPhone = typeof body.phone === "string" ? body.phone : String(body.phone ?? "");
    const userId = req.currentUser!.sub;

    if (password) {
      const passwordPolicyError = getPasswordPolicyError(password);
      if (passwordPolicyError) { res.json({ data: { user: null }, error: { message: passwordPolicyError } }); return; }
      // Require current password to prevent account takeover via stolen access token
      if (!current_password) { res.json({ data: { user: null }, error: { message: "Senha atual obrigatória para alterar a senha" } }); return; }
      const userRow = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
      if (!userRow) { res.json({ data: { user: null }, error: { message: "Usuário não encontrado" } }); return; }
      const currentValid = await bcrypt.compare(current_password, userRow.password_hash);
      if (!currentValid) { res.json({ data: { user: null }, error: { message: "Senha atual incorreta" } }); return; }
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      // Update password and immediately inválidate all existing tokens (including stolen ones)
      await execute("UPDATE users SET password_hash = $1, token_invalidated_before = NOW(), updated_at = NOW() WHERE id = $2", [hash, userId]);
    }

    if (email !== undefined) {
      const normalizedEmail = String(email || "").toLowerCase().trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!normalizedEmail || !emailRegex.test(normalizedEmail)) {
        res.json({ data: { user: null }, error: { message: "E-mail inválido" } }); return;
      }

      // Security: require current password to prevent account takeover via stolen session cookie
      if (!current_password) {
        res.json({ data: { user: null }, error: { message: "Senha atual obrigatória para alterar o e-mail" } }); return;
      }
      const userRowForEmail = await queryOne<{ password_hash: string; email: string; name: string }>(
        "SELECT password_hash, email, name FROM users WHERE id = $1",
        [userId],
      );
      if (!userRowForEmail) { res.json({ data: { user: null }, error: { message: "Usuário não encontrado" } }); return; }
      const emailPasswordValid = await bcrypt.compare(current_password, userRowForEmail.password_hash);
      if (!emailPasswordValid) {
        res.json({ data: { user: null }, error: { message: "Senha atual incorreta" } }); return;
      }

      if (normalizedEmail === userRowForEmail.email.toLowerCase().trim()) {
        res.json({ data: { user: null }, error: { message: "O novo e-mail deve ser diferente do atual" } }); return;
      }

      const duplicated = await queryOne<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1",
        [normalizedEmail, userId],
      );
      if (duplicated) {
        res.json({ data: { user: null }, error: { message: "Este e-mail já está em uso" } }); return;
      }

      const previousEmail = userRowForEmail.email;
      const userName = userRowForEmail.name;

      // Security: mark email unconfirmed, invalidate all existing sessions (including stolen tokens)
      await execute(
        "UPDATE users SET email = $1, email_confirmed_at = NULL, token_invalidated_before = NOW(), updated_at = NOW() WHERE id = $2",
        [normalizedEmail, userId],
      );
      await execute(
        "UPDATE profiles SET email = $1, updated_at = NOW() WHERE user_id = $2",
        [normalizedEmail, userId],
      );

      // Send verification email to the NEW address
      try {
        const fakeReq = req;
        await dispatchVerificationEmail(fakeReq, { id: userId, email: normalizedEmail, name: userName });
      } catch (emailErr) {
        console.error("[auth] failed to send verification email after email change:", emailErr);
      }

      // Notify the OLD address about the change (security alert)
      try {
        const safeName = escapeHtml(userName);
        await sendEmail({
          to: previousEmail,
          subject: "Seu e-mail foi alterado - Auto Links",
          html: `<p>Olá, ${safeName}.</p><p>O e-mail da sua conta Auto Links foi alterado para <strong>${escapeHtml(normalizedEmail)}</strong>.</p><p>Se você não fez esta alteração, entre em contato conosco imediatamente.</p>`,
          text: `Olá, ${userName}. O e-mail da sua conta Auto Links foi alterado para ${normalizedEmail}. Se você não fez esta alteração, entre em contato conosco imediatamente.`,
        });
      } catch (notifyErr) {
        console.error("[auth] failed to send old-email notification after email change:", notifyErr);
      }
    }

    if (rawPhone !== undefined) {
      const phone = sanitizePhone(String(rawPhone || ""));
      if (!phone) { res.json({ data: { user: null }, error: { message: "Telefone inválido. Use formato com DDD, ex: +5511912345678" } }); return; }

      const duplicatePhone = await queryOne<{ user_id: string }>(
        "SELECT user_id FROM profiles WHERE phone = $1 AND user_id <> $2 LIMIT 1",
        [phone, userId],
      );
      if (duplicatePhone) {
        res.status(409).json({ data: { user: null }, error: { message: SIGNUP_IDENTITY_EXISTS_MESSAGE } }); return;
      }

      try {
        await execute(
          "UPDATE profiles SET phone = $1, updated_at = NOW() WHERE user_id = $2",
          [phone, userId],
        );
      } catch (phoneUpdateError) {
        if (isUniqueViolation(phoneUpdateError)) {
          res.status(409).json({ data: { user: null }, error: { message: SIGNUP_IDENTITY_EXISTS_MESSAGE } }); return;
        }
        throw phoneUpdateError;
      }
    }

    if (metadata && typeof metadata === "object") {
      // Block admin-only fields from being set via self-service
      const ADMIN_ONLY_METADATA = new Set(["account_status", "archived_at", "status_updated_at"]);
      const safeMeta = Object.fromEntries(
        Object.entries(metadata).filter(([k]) => !ADMIN_ONLY_METADATA.has(k))
      );
      if (Object.keys(safeMeta).length > 0) {
        await execute(
          "UPDATE users SET metadata = metadata || $1::jsonb, updated_at = NOW() WHERE id = $2",
          [JSON.stringify(safeMeta), userId]
        );

        const profileName = typeof safeMeta.name === "string" ? safeMeta.name.trim() : "";
        if (profileName) {
          await execute(
            "UPDATE profiles SET name = $1, updated_at = NOW() WHERE user_id = $2",
            [profileName, userId],
          );
        }
      }
    }

    const user = await getUserWithRole(userId);
    if (!user) { res.json({ data: { user: null }, error: { message: "Usuário não encontrado" } }); return; }

    // Audit log: user updated
    try {
      const changes: Record<string, unknown> = {};
      if (password) changes.password_changed = true;
      if (email !== undefined) changes.email_changed = true;
      if (rawPhone !== undefined) changes.phone_changed = true;
      if (metadata && Object.keys(metadata).length > 0) changes.metadata_updated = true;

      await logAudit({
        action: "user.updated",
        actor_user_id: req.currentUser!.sub,
        target_user_id: userId,
        resource_type: "user",
        resource_id: userId,
        details: changes,
        ip_address: req.ip,
        user_agent: req.headers?.["user-agent"],
      });
    } catch (auditErr) {
      console.error("[auth] failed to write audit log for update-user:", auditErr);
    }

    const session = issueSessionForCookie(res, user);
    res.json({ data: { user: session.user }, error: null });
  } catch (e) {
    console.error("[auth] updateUser error:", e);
    res.json({ data: { user: null }, error: { message: "Erro interno" } });
  }
});
