import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v4 as uuid } from "uuid";
import { queryOne, execute } from "./db.js";
import { getPasswordPolicyError } from "./password-policy.js";
import { isEmailDeliveryConfigured, sendEmail } from "./mailer.js";

const SECRET = process.env.JWT_SECRET ?? "changeme-jwt-secret-32chars-minimum";
const EXPIRES_IN = "7d";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || "autolinks_at").trim() || "autolinks_at";
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function resolveCookieSameSite(): "Strict" | "Lax" | "None" {
  const raw = String(process.env.AUTH_COOKIE_SAMESITE || "lax").trim().toLowerCase();
  if (raw === "strict") return "Strict";
  if (raw === "none") return "None";
  return "Lax";
}

const AUTH_COOKIE_SAME_SITE = resolveCookieSameSite();

// Cookie Domain — set to ".seudominio.com" in production so the cookie is
// shared between app.seudominio.com (frontend) and api.seudominio.com (API).
// Leave empty for localhost/dev environments.
const APP_PUBLIC_URL = resolvePublicUrl(process.env.APP_PUBLIC_URL || "");
const API_PUBLIC_URL = resolvePublicUrl(process.env.API_PUBLIC_URL || "");
const AUTH_COOKIE_DOMAIN = normalizeCookieDomain(process.env.AUTH_COOKIE_DOMAIN || "", API_PUBLIC_URL);
const EMAIL_VERIFY_ROUTE = "/auth/verificacao-email";
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
    <p>Ola, ${safeName}.</p>
    <p>Confirme seu e-mail para ativar sua conta no Auto Links:</p>
    <p><a href="${verifyUrl}">Confirmar e-mail</a></p>
    <p>Se voce nao criou essa conta, ignore esta mensagem.</p>
  `;
  const text = `Ola, ${user.name}. Confirme seu e-mail: ${verifyUrl}`;

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
    <p>Ola, ${safeName}.</p>
    <p>Recebemos uma solicitacao para redefinir sua senha no Auto Links.</p>
    <p><a href="${resetUrl}">Redefinir senha</a></p>
    <p>Se voce nao solicitou essa troca, ignore este e-mail.</p>
  `;
  const text = `Ola, ${user.name}. Redefina sua senha: ${resetUrl}`;

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

function serializeAuthCookie(value: string, clear = false): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${AUTH_COOKIE_SAME_SITE}`,
  ];

  if (AUTH_COOKIE_DOMAIN) {
    parts.push(`Domain=${AUTH_COOKIE_DOMAIN}`);
  }

  // SameSite=None requires Secure in browsers; production should always be Secure.
  if (IS_PRODUCTION || AUTH_COOKIE_SAME_SITE === "None") {
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
  res.setHeader("Set-Cookie", serializeAuthCookie(token));
}

function clearAuthCookie(res: Response) {
  res.setHeader("Set-Cookie", serializeAuthCookie("", true));
}

if (!SERVICE_TOKEN) {
  console.warn("[auth] SERVICE_TOKEN is not set — scheduler/service-to-service auth is disabled. Set SERVICE_TOKEN in the environment.");
}

// Pre-computed dummy hash for timing-safe "user not found" path in signin — prevents email enumeration.
// bcrypt.hashSync runs once at startup (~80–120ms total cost).
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
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN, algorithm: "HS256" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as TokenPayload;
  } catch {
    return null;
  }
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
          // Token was revoked (user blocked or signed out) — log before dropping
          console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "token_revoked_detected", userId: payload.sub, ip: req.ip ?? "-", tokenIat: payload.iat, rid }));
          next(); return;
        }
      }
    } catch {
      // DB unavailable — fail open to avoid locking out all users during restarts
    }
    req.currentUser = payload;
  } else if (payload) {
    req.currentUser = payload;
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

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser || req.currentUser.role !== "admin") {
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "forbidden", userId: req.currentUser?.sub ?? "-", path: req.path, ip: req.ip ?? "-", rid }));
    res.status(403).json({ data: null, error: { message: "Acesso negado" } }); return;
  }
  next();
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

async function getSignupPlanId(): Promise<string> {
  try {
    const row = await queryOne<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'admin_config'");
    return resolveDefaultSignupPlanId(row?.value ?? {});
  } catch {
    return "plan-starter";
  }
}

function resolveUserName(metadata: Record<string, unknown> | null | undefined, email: string) {
  const value = typeof metadata?.name === "string" ? metadata.name.trim() : "";
  return value || email.split("@")[0] || "Usuario";
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
      res.status(503).json({ data: { user: null, session: null }, error: { message: "Servico de e-mail indisponivel. Tente novamente mais tarde." } }); return;
    }

    const { email, password, options } = req.body as { email: string; password: string; options?: { data?: { name?: string } } };
    if (!email || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email e senha obrigatórios" } }); return; }
    const passwordPolicyError = getPasswordPolicyError(password);
    if (passwordPolicyError) { res.json({ data: { user: null, session: null }, error: { message: passwordPolicyError } }); return; }
    const normalizedEmail = email.toLowerCase().trim();

    const exists = await queryOne("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (exists) { res.json({ data: { user: null, session: null }, error: { message: "Email já cadastrado" } }); return; }

    const hash = await bcrypt.hash(password, 10);
    const name = options?.data?.name ?? email.split("@")[0];
    const metadata = { name, account_status: "active", status_updated_at: new Date().toISOString() } as Record<string, unknown>;
    const id = uuid();
    const signupPlanId = await getSignupPlanId();

    await execute("INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4,$5)", [id, normalizedEmail, hash, JSON.stringify(metadata), null]);
    await execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,'user')", [uuid(), id]);
    await execute("INSERT INTO profiles (id, user_id, name, email, plan_id) VALUES ($1,$2,$3,$4,$5)", [uuid(), id, name, normalizedEmail, signupPlanId]);
    const verifyToken = await createAuthEmailToken(id, "email_verification", VERIFY_TOKEN_TTL_MINUTES);

    const user = await getUserWithRole(id);
    if (!user) { res.json({ data: { user: null, session: null }, error: { message: "Erro ao criar conta" } }); return; }
    const emailResult = await dispatchVerificationEmail(req, { id, email: normalizedEmail, name }, verifyToken.rawToken);
    if ("error" in emailResult) {
      console.error("[auth] signup verification email error:", emailResult.error);
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
      res.status(503).json({ data: { sent: false }, error: { message: "Servico de e-mail indisponivel no momento." } }); return;
    }

    const { email } = req.body as { email?: string };
    const normalizedEmail = String(email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      res.json({ data: { sent: true }, error: null }); return;
    }

    const user = await queryOne<{ id: string; email: string; metadata: Record<string, unknown>; email_confirmed_at: string | null }>(
      "SELECT id, email, metadata, email_confirmed_at FROM users WHERE email = $1",
      [normalizedEmail],
    );

    if (user && !user.email_confirmed_at) {
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
      res.status(503).json({ data: { sent: false }, error: { message: "Servico de e-mail indisponivel no momento." } }); return;
    }

    const { email, options } = req.body as { email?: string; options?: { redirectTo?: string } };
    const normalizedEmail = String(email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      res.json({ data: { sent: true }, error: null }); return;
    }

    const user = await queryOne<{ id: string; email: string; metadata: Record<string, unknown> }>(
      "SELECT id, email, metadata FROM users WHERE email = $1",
      [normalizedEmail],
    );

    if (user) {
      const name = resolveUserName(user.metadata, user.email);
      const result = await dispatchPasswordResetEmail({ id: user.id, email: user.email, name }, options);
      if ("error" in result) {
        console.error("[auth] forgot-password email error:", result.error);
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
    const { token, password } = req.body as { token?: string; password?: string };
    const rawToken = String(token || "").trim();
    const nextPassword = String(password || "");
    if (!rawToken || !nextPassword) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: "Token e nova senha sao obrigatorios" } }); return;
    }

    const passwordPolicyError = getPasswordPolicyError(nextPassword);
    if (passwordPolicyError) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: passwordPolicyError } }); return;
    }

    const consumed = await consumeAuthEmailToken(rawToken, "password_reset");
    if (!consumed) {
      res.status(400).json({ data: { user: null, session: null }, error: { message: "Link invalido ou expirado" } }); return;
    }

    const hash = await bcrypt.hash(nextPassword, 10);
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
      res.status(404).json({ data: { user: null, session: null }, error: { message: "Usuario nao encontrado" } }); return;
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
    respondVerificationRedirect(res, "invalid", "Token de verificacao ausente");
    return;
  }

  try {
    const consumed = await consumeAuthEmailToken(token, "email_verification");
    if (!consumed) {
      respondVerificationRedirect(res, "invalid", "Link invalido ou expirado");
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

    respondVerificationRedirect(res, "success", "");
  } catch (error) {
    console.error("[auth] verify-email error:", error);
    respondVerificationRedirect(res, "error", "Falha ao confirmar e-mail");
  }
});

// POST /auth/signin
authRouter.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email e senha obrigatórios" } }); return; }

    const user = await queryOne<{ id: string; email: string; password_hash: string; metadata: Record<string, unknown>; created_at: string; email_confirmed_at: string | null }>(
      "SELECT id, email, password_hash, metadata, created_at, email_confirmed_at FROM users WHERE email = $1", [email.toLowerCase().trim()]
    );
    if (!user) {
      await bcrypt.compare(password, SIGNIN_DUMMY_HASH); // constant-time — prevents email enumeration via timing oracle
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "user_not_found", email: email.toLowerCase().trim(), ip: req.ip ?? "-", rid }));
      res.json({ data: { user: null, session: null }, error: { message: "Email ou senha inválidos" } }); return;
    }

    const meta = user.metadata ?? {};
    if (meta.account_status === "blocked" || meta.account_status === "archived") {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "account_blocked", email: email.toLowerCase().trim(), ip: req.ip ?? "-", rid }));
      res.json({ data: { user: null, session: null }, error: { message: "Conta bloqueada ou arquivada" } }); return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "wrong_password", email: email.toLowerCase().trim(), ip: req.ip ?? "-", rid }));
      res.json({ data: { user: null, session: null }, error: { message: "Email ou senha inválidos" } }); return;
    }

    if (!user.email_confirmed_at) {
      const rid = (req as { rid?: string }).rid ?? "-";
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_failed", reason: "email_not_confirmed", email: email.toLowerCase().trim(), ip: req.ip ?? "-", rid }));
      res.json({ data: { user: null, session: null }, error: { message: "E-mail ainda nao confirmado. Verifique sua caixa de entrada." } }); return;
    }

    const roleRow = await queryOne<{ role: string }>("SELECT role FROM user_roles WHERE user_id = $1", [user.id]);
    const role = roleRow?.role ?? "user";
    const rid = (req as { rid?: string }).rid ?? "-";
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "api", event: "signin_success", userId: user.id, ip: req.ip ?? "-", rid }));
    const session = issueSessionForCookie(res, { ...user, role });
    res.json({ data: { user: session.user, session }, error: null });
  } catch (e) {
    console.error("[auth] signin error:", e);
    res.json({ data: { user: null, session: null }, error: { message: "Erro interno" } });
  }
});

// POST /auth/signout
authRouter.post("/signout", async (req, res) => {
  // Invalidate all existing tokens for this user so that concurrent sessions
  // and any stolen tokens are immediately rejected by authMiddleware.
  const userId = req.currentUser?.sub;
  if (userId && userId !== "service") {
    try {
      await execute("UPDATE users SET token_invalidated_before = NOW() WHERE id = $1", [userId]);
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

// POST /auth/update-user
authRouter.post("/update-user", requireAuth, async (req, res) => {
  try {
    const { password, current_password, data: metadata } = req.body as { password?: string; current_password?: string; data?: Record<string, unknown> };
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
      const hash = await bcrypt.hash(password, 10);
      // Update password and immediately invalidate all existing tokens (including stolen ones)
      await execute("UPDATE users SET password_hash = $1, token_invalidated_before = NOW(), updated_at = NOW() WHERE id = $2", [hash, userId]);
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
      }
    }

    const user = await getUserWithRole(userId);
    if (!user) { res.json({ data: { user: null }, error: { message: "Usuário não encontrado" } }); return; }
    const session = issueSessionForCookie(res, user);
    res.json({ data: { user: session.user }, error: null });
  } catch (e) {
    console.error("[auth] updateUser error:", e);
    res.json({ data: { user: null }, error: { message: "Erro interno" } });
  }
});
