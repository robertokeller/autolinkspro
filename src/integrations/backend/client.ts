// AutoLinks self-hosted API client — mirrors the @supabase/supabase-js surface
// so all existing hooks and pages work without modification.

// ─── Test-mode shim ─────────────────────────────────────────────────────────
// ONLY under Vitest (MODE === "test") do we bypass HTTP and use the in-memory
// database. In development AND production the real API is always used.
import {
  authApi as _legacyAuth,
  LocalQueryBuilder as _LegacyQB,
  resetLocalDb as _legacyReset,
  storageBucket as _legacyStorageBucket,
} from "./_local-core-legacy";
import { invokeLocalFunction as _legacyInvoke } from "./local-functions";

const _IS_TEST: boolean = (import.meta.env as Record<string, unknown>)?.MODE === "test";

function isLoopbackHost(host: string): boolean {
  const normalized = String(host || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isPrivateIpv4Host(host: string): boolean {
  const parts = String(host || "")
    .trim()
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isDevReachableHost(host: string): boolean {
  return isLoopbackHost(host) || isPrivateIpv4Host(host);
}

const SESSION_COOKIE_HELP = "Login nao persistiu sessao (cookie bloqueado). Em local, abra o app no mesmo host da API (localhost/127.0.0.1/IP). Em producao, verifique AUTH_COOKIE_DOMAIN, CORS_ORIGIN, APP_PUBLIC_URL e API_PUBLIC_URL.";

function resolveApiUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (typeof window === "undefined") return trimmed;

  try {
    const parsed = new URL(trimmed, window.location.origin);
    const pageHost = window.location.hostname;

    // Keep API host aligned with the current page host in local/LAN dev to
    // avoid SameSite cookie drops caused by mixed hosts (localhost/127/LAN IP).
    if (isLoopbackHost(parsed.hostname) && isDevReachableHost(pageHost) && parsed.hostname !== pageHost) {
      parsed.hostname = pageHost;
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

const API_URL: string = resolveApiUrl((import.meta.env.VITE_API_URL as string | undefined) ?? "");
// O backend local (in-memory/local-core) fica disponível apenas em testes.
// Em desenvolvimento e produção, sempre usar API + PostgreSQL.
const _USE_LOCAL_BACKEND = _IS_TEST;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  role?: string;
  aud?: string;
  user_metadata: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface Session {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  refresh_token?: string;
  user: User;
}

// ─── Session storage ──────────────────────────────────────────────────────────
let inMemorySession: Session | null = null;
type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "INITIAL_SESSION" | "PASSWORD_RECOVERY";
type AuthCallback = (event: AuthEvent, session: Session | null) => void;

const authListeners = new Set<AuthCallback>();

function getRuntimeSession(): Session | null {
  return inMemorySession;
}

function isSameSession(a: Session | null, b: Session | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.user?.id === b.user?.id
    && a.expires_at === b.expires_at
    && a.expires_in === b.expires_in
    && a.token_type === b.token_type
    && (a.access_token || "") === (b.access_token || "")
    && (a.refresh_token || "") === (b.refresh_token || "")
  );
}

function setRuntimeSession(session: Session | null) {
  // Avoid auth-event storms: many callers poll getSession(), and emitting SIGNED_IN
  // for identical sessions creates feedback loops (session -> cache sync -> session...).
  if (isSameSession(inMemorySession, session)) return;
  inMemorySession = session;
  const event: AuthEvent = session ? "SIGNED_IN" : "SIGNED_OUT";
  authListeners.forEach((cb) => { try { cb(event, session); } catch { /* ignore */ } });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiFetch(path: string, options: RequestInit = {}, timeoutMs = 15_000) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: { ...headers, ...((options.headers as Record<string, string>) ?? {}) },
      signal: controller.signal,
    });
    clearTimeout(tid);
    const text = await res.text();
    if (!text || !text.trim()) {
      // Empty body with error status (e.g. proxy 500/502 when API is down) — treat as offline.
      if (!res.ok) throw new Error("Serviço API offline — verifique se está rodando");
      // Empty body with success status (e.g. 204 No Content) — treat as success with no payload.
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Resposta inválida do servidor (${res.status}): ${text.slice(0, 120)}`);
    }
  } catch (e) {
    clearTimeout(tid);
    // Invalid JSON from a live server — rethrow as-is (server is up, don't mark offline).
    if (e instanceof Error && e.message.startsWith("Resposta inválida")) throw e;
    const msg = e instanceof Error && e.name === "AbortError" ? "Servidor indisponível (timeout)" : "Serviço API offline — verifique se está rodando";
    throw new Error(msg);
  }
}

// ─── Query builder ────────────────────────────────────────────────────────────
type Filter = { type: string; col: string; val: unknown };
type OrderOpt = { col: string; ascending: boolean };

interface QueryResult<T = unknown> {
  data: T | null;
  count: number | null;
  error: { message: string; code?: string } | null;
}

class QueryBuilder<T = unknown> {
  private _table: string;
  private _op = "select";
  private _columns = "*";
  private _data: unknown = null;
  private _filters: Filter[] = [];
  private _order: OrderOpt[] = [];
  private _limit: number | null = null;
  private _single = false;
  private _maybeSingle = false;
  private _count: string | null = null;
  private _head = false;
  private _onConflict: string | null = null;
  private _ignoreDuplicates = false;

  constructor(table: string) { this._table = table; }

  select(columns?: string, opts?: { count?: string; head?: boolean }): this {
    // Only set op to "select" when NOT chained after a mutation (insert/update/upsert/delete).
    // Chaining .select() after a mutation is the Supabase pattern for requesting RETURNING columns.
    if (this._op === "select") this._op = "select";
    this._columns = columns?.trim() || "*";
    if (opts?.count) this._count = opts.count;
    if (opts?.head) this._head = true;
    return this;
  }
  insert(data: unknown): this { this._op = "insert"; this._data = data; return this; }
  update(data: unknown): this { this._op = "update"; this._data = data; return this; }
  delete(): this { this._op = "delete"; return this; }
  upsert(data: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this._op = "upsert"; this._data = data;
    if (opts?.onConflict) this._onConflict = opts.onConflict;
    if (opts?.ignoreDuplicates !== undefined) this._ignoreDuplicates = opts.ignoreDuplicates;
    return this;
  }

  eq(col: string, val: unknown): this { this._filters.push({ type: "eq", col, val }); return this; }
  neq(col: string, val: unknown): this { this._filters.push({ type: "neq", col, val }); return this; }
  is(col: string, val: unknown): this { this._filters.push({ type: "is", col, val }); return this; }
  in(col: string, arr: unknown[]): this { this._filters.push({ type: "in", col, val: arr }); return this; }
  lte(col: string, val: unknown): this { this._filters.push({ type: "lte", col, val }); return this; }
  gte(col: string, val: unknown): this { this._filters.push({ type: "gte", col, val }); return this; }
  like(col: string, val: string): this { this._filters.push({ type: "like", col, val }); return this; }

  order(col: string, opts?: { ascending?: boolean }): this {
    this._order.push({ col, ascending: opts?.ascending ?? true }); return this;
  }
  limit(n: number): this { this._limit = n; return this; }

  async maybeSingle(): Promise<QueryResult<T>> { this._maybeSingle = true; return this._execute(); }
  async single(): Promise<QueryResult<T>> { this._single = true; return this._execute(); }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    resolve?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this._execute().then(resolve, reject) as Promise<TResult1 | TResult2>;
  }

  private async _execute(): Promise<QueryResult<T>> {
    const options: Record<string, unknown> = {};
    if (this._order.length) options.order = this._order;
    if (this._limit !== null) options.limit = this._limit;
    if (this._single) options.single = true;
    if (this._maybeSingle) options.maybeSingle = true;
    if (this._count) options.count = this._count;
    if (this._head) options.head = true;
    if (this._onConflict) options.onConflict = this._onConflict;
    if (this._ignoreDuplicates) options.ignoreDuplicates = this._ignoreDuplicates;

    const body = JSON.stringify({ op: this._op, columns: this._columns, data: this._data, filters: this._filters, options });
    try {
      const result = await apiFetch(`/api/rest/${this._table}`, { method: "POST", body });
      return result as QueryResult<T>;
    } catch (e) {
      // Retorna erro estruturado — não relança para não travar useQuery com retries
      return { data: null, count: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }
}

// ─── Auth object ──────────────────────────────────────────────────────────────
let passwordRecoveryPending = false;

const auth = {
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    try {
      const res = await apiFetch("/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) });
      if (!res.error && res.data?.session) {
        passwordRecoveryPending = false;
        setRuntimeSession(res.data.session as Session);

        // Validate that the HttpOnly cookie was actually persisted by the browser.
        // If cookie/domain/CORS is misconfigured, /auth/signin can return a session
        // but subsequent authenticated requests fail and user gets bounced to login.
        try {
          const sessionCheck = await apiFetch("/auth/session", { method: "GET" });
          if (sessionCheck.error || !sessionCheck.data?.session) {
            setRuntimeSession(null);
            return {
              data: { user: null, session: null },
              error: {
                message: SESSION_COOKIE_HELP,
              },
            };
          }
        } catch {
          setRuntimeSession(null);
          return {
            data: { user: null, session: null },
            error: {
              message: SESSION_COOKIE_HELP,
            },
          };
        }
      }
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Serviço indisponível - verifique se o servidor está rodando";
      return { data: { user: null, session: null }, error: { message: msg } };
    }
  },

  async signUp({
    email,
    password,
    options,
  }: {
    email: string;
    password: string;
    options?: {
      data?: Record<string, unknown>;
      emailRedirectTo?: string;
    };
  }) {
    try {
      const res = await apiFetch("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, options }) });
      if (!res.error && res.data?.session) {
        passwordRecoveryPending = false;
        setRuntimeSession(res.data.session as Session);
      }
      return res;
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: String(e) } };
    }
  },

  async signOut() {
    try {
      await apiFetch("/auth/signout", { method: "POST", body: "{}" });
    } catch {
      // ignore
    }
    passwordRecoveryPending = false;
    setRuntimeSession(null);
    return { error: null };
  },

  async getSession() {
    try {
      const res = await apiFetch("/auth/session", { method: "GET" });
      if (res.error || !res.data?.session) {
        setRuntimeSession(null);
        return { data: { session: null }, error: null };
      }
      const session = res.data.session as Session;
      setRuntimeSession(session);
      return { data: { session }, error: null };
    } catch {
      return { data: { session: getRuntimeSession() }, error: null };
    }
  },

  async validateSession() {
    return auth.getSession();
  },

  async getUser() {
    try {
      const res = await apiFetch("/auth/user", { method: "GET" });
      if (res.error) {
        return { data: { user: null }, error: res.error ?? null };
      }
      const user = res.data?.user ?? null;
      if (!user) {
        setRuntimeSession(null);
        return { data: { user: null }, error: null };
      }
      const current = getRuntimeSession();
      if (current) {
        setRuntimeSession({ ...current, user });
      }
      return { data: { user }, error: null };
    } catch {
      return { data: { user: getRuntimeSession()?.user ?? null }, error: null };
    }
  },

  onAuthStateChange(callback: AuthCallback): { data: { subscription: { unsubscribe: () => void } } } {
    authListeners.add(callback);

    setTimeout(() => {
      const cached = getRuntimeSession();
      try { callback("INITIAL_SESSION", cached); } catch { /* ignore */ }
      if (passwordRecoveryPending) {
        try { callback("PASSWORD_RECOVERY", cached); } catch { /* ignore */ }
      }

      void auth.getSession().then(({ data: { session: serverSession } }) => {
        try { callback("INITIAL_SESSION", serverSession); } catch { /* ignore */ }
        if (passwordRecoveryPending) {
          try { callback("PASSWORD_RECOVERY", serverSession); } catch { /* ignore */ }
        }
      }).catch(() => undefined);
    }, 0);

    return {
      data: {
        subscription: {
          unsubscribe: () => {
            authListeners.delete(callback);
          },
        },
      },
    };
  },

  async updateUser(updates: { password?: string; current_password?: string; data?: Record<string, unknown>; email?: string }) {
    try {
      const res = await apiFetch("/auth/update-user", { method: "POST", body: JSON.stringify(updates) });
      const user = res.data?.user ?? null;
      if (!res.error && user) {
        const current = getRuntimeSession();
        if (current) {
          setRuntimeSession({ ...current, user });
        }
      }
      return { data: { user }, error: res.error ?? null };
    } catch (e) {
      return { data: { user: null }, error: { message: String(e) } };
    }
  },

  async resetPasswordForEmail(email: string, options?: { redirectTo?: string }) {
    try {
      const res = await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email, options }),
      });
      return { data: res.data ?? {}, error: res.error ?? null };
    } catch (e) {
      return { data: {}, error: { message: String(e) } };
    }
  },

  async resetPasswordWithToken({ token, password }: { token: string; password: string }) {
    try {
      const res = await apiFetch("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      if (!res.error && res.data?.session) {
        passwordRecoveryPending = false;
        setRuntimeSession(res.data.session as Session);
      }
      return { data: { user: res.data?.user ?? null, session: res.data?.session ?? null }, error: res.error ?? null };
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: String(e) } };
    }
  },

  async resendVerificationEmail(email: string) {
    try {
      const res = await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      return { data: res.data ?? {}, error: res.error ?? null };
    } catch (e) {
      return { data: {}, error: { message: String(e) } };
    }
  },
};

function makeChannel(_name: string) {
  return {
    on(_event: string, _filter: unknown, _cb?: unknown) { return this; },
    subscribe(_cb?: (status: string) => void) { _cb?.("SUBSCRIBED"); return this; },
    unsubscribe() { return Promise.resolve("ok" as const); },
  };
}

// ─── Functions invoker ────────────────────────────────────────────────────────
const functions = {
  async invoke(name: string, options?: { body?: Record<string, unknown> }) {
    // Keep RPC function selector authoritative even when the payload also has
    // a business field called "name" (for example, "user name" in admin forms).
    const body = JSON.stringify({ ...(options?.body ?? {}), name });
    const timeoutMs = name === "ops-service-control"
      ? 120_000
      : name === "ops-bootstrap"
        ? 45_000
        : name === "admin-system-observability"
          ? 45_000
          : name === "admin-export-diagnostics"
            ? 60_000
          : name === "admin-maintenance"
            ? 20_000
            : 15_000;
    try {
      const res = await apiFetch("/functions/v1/rpc", { method: "POST", body }, timeoutMs);
      return { data: res.data ?? null, error: res.error ?? null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  },
};

type StorageBucket = {
  upload: (path: string, file: Blob, options?: { upsert?: boolean }) => Promise<{
    data: { path: string } | null;
    error: { message: string; code?: string } | null;
  }>;
  getPublicUrl: (path: string) => { data: { publicUrl: string } };
  remove: (paths: string[]) => Promise<{
    data: string[] | null;
    error: { message: string; code?: string } | null;
  }>;
};

function normalizeStoragePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

async function blobToDataUrl(file: Blob): Promise<string> {
  if (typeof FileReader === "undefined") {
    throw new Error("File upload is not available in this runtime");
  }
  const reader = new FileReader();
  return await new Promise<string>((resolve, reject) => {
    reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

const inMemoryStorageBuckets = new Map<string, Map<string, string>>();

function getInMemoryBucket(bucket: string): Map<string, string> {
  if (!inMemoryStorageBuckets.has(bucket)) {
    inMemoryStorageBuckets.set(bucket, new Map<string, string>());
  }
  return inMemoryStorageBuckets.get(bucket)!;
}

function createInMemoryStorageBucket(bucket: string): StorageBucket {
  return {
    upload: async (path: string, file: Blob) => {
      try {
        const normalizedPath = normalizeStoragePath(path);
        if (!normalizedPath) {
          return { data: null, error: { message: "Caminho de arquivo inválido", code: "invalid_path" } };
        }
        const content = await blobToDataUrl(file);
        getInMemoryBucket(bucket).set(normalizedPath, content);
        return { data: { path: normalizedPath }, error: null };
      } catch (error) {
        return {
          data: null,
          error: {
            message: error instanceof Error ? error.message : "Erro ao enviar arquivo",
            code: "upload_failed",
          },
        };
      }
    },

    getPublicUrl: (path: string) => {
      const normalizedPath = normalizeStoragePath(path);
      return {
        data: {
          publicUrl: getInMemoryBucket(bucket).get(normalizedPath) || "",
        },
      };
    },

    remove: async (paths: string[]) => {
      const bucketStore = getInMemoryBucket(bucket);
      for (const rawPath of paths) {
        bucketStore.delete(normalizeStoragePath(rawPath));
      }
      return { data: [], error: null };
    },
  };
}

const storage = {
  from(bucket: string): StorageBucket {
    if (_USE_LOCAL_BACKEND) {
      return _legacyStorageBucket(bucket) as unknown as StorageBucket;
    }
    return createInMemoryStorageBucket(bucket);
  },
};

// ─── Main export ──────────────────────────────────────────────────────────────
export const backend = {
  auth: _USE_LOCAL_BACKEND ? (_legacyAuth as unknown as typeof auth) : auth,
  from<T = unknown>(table: string) {
    if (_USE_LOCAL_BACKEND) return new _LegacyQB<T>(table) as unknown as QueryBuilder<T>;
    return new QueryBuilder<T>(table);
  },
  channel(name: string) { return makeChannel(name); },
  functions: _USE_LOCAL_BACKEND
    ? { invoke: _legacyInvoke as (name: string, opts?: { body?: Record<string, unknown> }) => Promise<{ data: unknown; error: unknown }> }
    : functions,
  storage,
  removeChannel(_ch: unknown) { /* no-op */ },
  removeAllChannels() { /* no-op */ },
};

/** Resets the local in-memory database between tests. No-op outside test mode. */
export function __resetLocalDatabase() {
  if (_USE_LOCAL_BACKEND) _legacyReset();
}
