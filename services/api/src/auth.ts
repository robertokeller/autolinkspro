import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "node:crypto";
import { v4 as uuid } from "uuid";
import { query, queryOne, execute } from "./db.js";

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
const AUTH_COOKIE_DOMAIN = String(process.env.AUTH_COOKIE_DOMAIN || "").trim();

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

function buildUserPayload(user: { id: string; email: string; role: string; metadata: Record<string, unknown>; created_at: string }) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    user_metadata: user.metadata ?? {},
    app_metadata: { role: user.role },
    aud: "authenticated",
    created_at: user.created_at,
  };
}

function buildSessionPayload(
  user: { id: string; email: string; role: string; metadata: Record<string, unknown>; created_at: string },
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
  user: { id: string; email: string; role: string; metadata: Record<string, unknown>; created_at: string },
) {
  const accessToken = signToken({ sub: user.id, email: user.email, role: user.role });
  const decoded = jwt.decode(accessToken) as { exp?: number } | null;
  const expiresAt = decoded?.exp ?? Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  setAuthCookie(res, accessToken);
  return buildSessionPayload(user, expiresAt);
}

function buildSessionFromRequestAuth(
  user: { id: string; email: string; role: string; metadata: Record<string, unknown>; created_at: string },
  req: Request,
) {
  const expiresAt = req.currentUser?.exp ?? Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  return buildSessionPayload(user, expiresAt);
}

async function getUserWithRole(id: string) {
  // Single JOIN instead of two separate queries (avoids N+1 on every auth action)
  return queryOne<{ id: string; email: string; role: string; metadata: Record<string, unknown>; created_at: string }>(
    `SELECT u.id, u.email, u.metadata, u.created_at, COALESCE(r.role, 'user') AS role
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

authRouter.post("/signup", async (req, res) => {
  if (SIGNUP_DISABLED) {
    res.status(403).json({ data: { user: null, session: null }, error: { message: "Cadastro desativado. Contate o administrador." } }); return;
  }
  try {
    const { email, password, options } = req.body as { email: string; password: string; options?: { data?: { name?: string } } };
    if (!email || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email e senha obrigatórios" } }); return; }
    if (password.length < 12) { res.json({ data: { user: null, session: null }, error: { message: "Senha deve ter ao menos 12 caracteres" } }); return; }

    const exists = await queryOne("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (exists) { res.json({ data: { user: null, session: null }, error: { message: "Email já cadastrado" } }); return; }

    const hash = await bcrypt.hash(password, 10);
    const name = options?.data?.name ?? email.split("@")[0];
    const metadata = { name, account_status: "active", status_updated_at: new Date().toISOString() } as Record<string, unknown>;
    const id = uuid();
    const signupPlanId = await getSignupPlanId();

    await execute("INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4,NOW())", [id, email.toLowerCase().trim(), hash, JSON.stringify(metadata)]);
    await execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,'user')", [uuid(), id]);
    await execute("INSERT INTO profiles (id, user_id, name, email, plan_id) VALUES ($1,$2,$3,$4,$5)", [uuid(), id, name, email.toLowerCase().trim(), signupPlanId]);

    const user = await getUserWithRole(id);
    if (!user) { res.json({ data: { user: null, session: null }, error: { message: "Erro ao criar conta" } }); return; }
    const session = issueSessionForCookie(res, user);
    res.json({ data: { user: session.user, session }, error: null });
  } catch (e) {
    console.error("[auth] signup error:", e);
    res.json({ data: { user: null, session: null }, error: { message: "Erro interno" } });
  }
});

// POST /auth/signin
authRouter.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) { res.json({ data: { user: null, session: null }, error: { message: "Email e senha obrigatórios" } }); return; }

    const user = await queryOne<{ id: string; email: string; password_hash: string; metadata: Record<string, unknown>; created_at: string }>(
      "SELECT id, email, password_hash, metadata, created_at FROM users WHERE email = $1", [email.toLowerCase().trim()]
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
      if (password.length < 12) { res.json({ data: { user: null }, error: { message: "Senha deve ter ao menos 12 caracteres" } }); return; }
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
