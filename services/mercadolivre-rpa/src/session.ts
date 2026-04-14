import * as fs from "fs/promises";
import * as path from "path";
import { chromium } from "playwright";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type SessionStatus = "active" | "expired" | "error" | "untested" | "not_found" | "no_affiliate";

interface SessionLog {
  timestamp: string;
  level: "info" | "error" | "success" | "warn";
  message: string;
}

export interface SessionResult {
  status: SessionStatus;
  accountName?: string;
  mlUserId?: string;
  sessionPath?: string;
  lastChecked?: string;
  logs: SessionLog[];
}

interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
  sameSite?: string;
}

const AUTH_HINT_COOKIES = ["ssid", "nsa_rotok", "orguseridp", "orgnickp"];
const MAX_CAPTURED_COOKIES = 200;
const MAX_COOKIE_NAME_LENGTH = 128;
const MAX_COOKIE_VALUE_LENGTH = 8192;
const MAX_COOKIE_DOMAIN_LENGTH = 255;
const MAX_COOKIE_PATH_LENGTH = 512;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_DOMAIN_PATTERN = /^[A-Za-z0-9.-]+$/;
const COOKIE_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const COOKIE_VALUE_FORBIDDEN_PATTERN = /[;\r\n\u0000]/;
const COOKIE_RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class MercadoLivreSessionService {
  private sessionsDir: string;
  private legacySessionsDir: string;
  private workspaceSessionsDir: string;

  constructor() {
    // Keep session storage stable across start modes (dev from service folder or root scripts).
    this.sessionsDir = path.resolve(__dirname, "..", ".sessions");
    this.legacySessionsDir = path.join(process.cwd(), ".sessions");
    this.workspaceSessionsDir = path.resolve(__dirname, "..", "..", "..", ".sessions");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  private buildSessionPath(baseDir: string, sessionId: string): string {
    // Sanitize sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return path.join(baseDir, `storageState_meli_${safe}.json`);
  }

  getSessionPath(sessionId: string): string {
    return this.buildSessionPath(this.sessionsDir, sessionId);
  }

  private extractLegacySessionId(sessionId: string): string | null {
    const raw = String(sessionId || "").trim();
    const sep = raw.indexOf("__");
    if (sep <= 0 || sep >= raw.length - 2) return null;
    const legacy = raw.slice(sep + 2).trim();
    return legacy && legacy !== raw ? legacy : null;
  }

  private getSessionPathCandidates(sessionId: string): string[] {
    const primary = this.buildSessionPath(this.sessionsDir, sessionId);
    const ids = [String(sessionId || "").trim()];
    const legacyId = this.extractLegacySessionId(sessionId);
    if (legacyId) ids.push(legacyId);

    const candidates: string[] = [];
    for (const id of ids) {
      if (!id) continue;
      candidates.push(this.buildSessionPath(this.sessionsDir, id));
      candidates.push(this.buildSessionPath(this.legacySessionsDir, id));
      candidates.push(this.buildSessionPath(this.workspaceSessionsDir, id));
    }
    return Array.from(new Set(candidates));
  }

  private async resolveExistingSessionPath(sessionId: string): Promise<string | null> {
    const candidates = this.getSessionPathCandidates(sessionId);
    const primary = this.getSessionPath(sessionId);
    for (const candidate of candidates) {
      const exists = await fs.access(candidate).then(() => true).catch(() => false);
      if (!exists) continue;

      if (candidate !== primary) {
        try {
          await fs.mkdir(path.dirname(primary), { recursive: true });
          const primaryExists = await fs.access(primary).then(() => true).catch(() => false);
          if (!primaryExists) {
            await fs.copyFile(candidate, primary);
          }
          return primary;
        } catch {
          // Non-fatal: fallback to the discovered candidate.
        }
      }

      return candidate;
    }
    return null;
  }

  private addLog(logs: SessionLog[], message: string, level: SessionLog["level"] = "info"): SessionLog[] {
    return [{ timestamp: new Date().toISOString(), level, message }, ...logs].slice(0, 50);
  }

  private normalizeSameSite(value: unknown): "None" | "Lax" | "Strict" | undefined {
    if (!value) return undefined;
    const s = String(value);
    if (s.toLowerCase() === "none") return "None";
    if (s.toLowerCase() === "strict") return "Strict";
    return "Lax";
  }

  // Exact domain allowlist - prevents "mercadolivre.attacker.com" bypass via substring match.
  private static readonly ALLOWED_MELI_DOMAINS = new Set([
    "mercadolivre.com.br",
    "www.mercadolivre.com.br",
    "myaccount.mercadolivre.com.br",
    "auth.mercadolivre.com.br",
    "mercadopago.com.br",
    "www.mercadopago.com.br",
    "mercadolibre.com",
    "www.mercadolibre.com",
    "auth.mercadolibre.com",
    "meli.la",
    "www.meli.la",
  ]);

  private looksLikeMercadoLivreCookie(cookie: CookieInput): boolean {
    // Strip leading dot (cookie domains are sometimes ".mercadolivre.com.br")
    const host = String(cookie.domain || "").toLowerCase().replace(/^\./, "");
    if (MercadoLivreSessionService.ALLOWED_MELI_DOMAINS.has(host)) return true;
    for (const allowed of MercadoLivreSessionService.ALLOWED_MELI_DOMAINS) {
      if (host.endsWith("." + allowed)) return true;
    }
    return false;
  }

  /**
    * Extract account metadata directly from cookie values - no browser needed.
   */
  private extractMetadataFromCookies(cookies: CookieInput[]): { accountName?: string; mlUserId?: string } {
    const orgnickp = cookies.find((c) => c.name === "orgnickp");
    const orguseridp = cookies.find((c) => c.name === "orguseridp");
    return {
      accountName: orgnickp?.value || undefined,
      mlUserId: orguseridp?.value || undefined,
    };
  }

  /**
    * Parse incoming JSON - accepts { cookies: [...] } wrapper or [...] array directly.
   * Guards against prototype pollution and deeply nested payloads.
   */
  parseCookieJson(raw: string | object): CookieInput[] {
    let parsed: unknown;
    if (typeof raw === "string") {
      parsed = JSON.parse(raw);
    } else {
      parsed = raw;
    }

    // Reject prototype-polluting keys at the top level before any access.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as object);
      if (keys.some((k) => COOKIE_RESERVED_KEYS.has(k))) {
        throw new Error("Payload invalido: chaves reservadas detectadas.");
      }
    }

    let cookieArray: unknown[];
    if (Array.isArray(parsed)) {
      cookieArray = parsed;
    } else {
      const obj = parsed as Record<string, unknown>;
      if (obj && Array.isArray(obj.cookies)) {
        cookieArray = obj.cookies;
      } else {
        throw new Error("Formato invalido. Esperado { cookies: [...] } ou [...]");
      }
    }

    if (cookieArray.length === 0) {
      throw new Error("Array de cookies vazio");
    }
    if (cookieArray.length > MAX_CAPTURED_COOKIES) {
      throw new Error(`Quantidade de cookies excede o maximo de ${MAX_CAPTURED_COOKIES}.`);
    }

    return cookieArray.map((entry, idx): CookieInput => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Cookie [${idx}] invalido: esperado objeto.`);
      }

      const e = entry as Record<string, unknown>;
      if (Object.keys(e).some((k) => COOKIE_RESERVED_KEYS.has(k))) {
        throw new Error(`Cookie [${idx}] contem chaves reservadas invalidas.`);
      }

      const name = String(e.name ?? "").trim();
      const value = String(e.value ?? "");
      const domain = String(e.domain ?? "").trim().toLowerCase().replace(/^\./, "");
      const cookiePath = String(e.path ?? "/").trim() || "/";

      if (!name) throw new Error(`Cookie [${idx}]: nome obrigatorio.`);
      if (!domain) throw new Error(`Cookie [${idx}]: dominio obrigatorio.`);
      if (name.length > MAX_COOKIE_NAME_LENGTH) throw new Error(`Cookie [${idx}]: nome excede ${MAX_COOKIE_NAME_LENGTH} caracteres.`);
      if (value.length > MAX_COOKIE_VALUE_LENGTH) throw new Error(`Cookie [${idx}]: valor excede ${MAX_COOKIE_VALUE_LENGTH} caracteres.`);
      if (domain.length > MAX_COOKIE_DOMAIN_LENGTH) throw new Error(`Cookie [${idx}]: dominio excede ${MAX_COOKIE_DOMAIN_LENGTH} caracteres.`);
      if (cookiePath.length > MAX_COOKIE_PATH_LENGTH) throw new Error(`Cookie [${idx}]: path excede ${MAX_COOKIE_PATH_LENGTH} caracteres.`);
      if (!COOKIE_NAME_PATTERN.test(name)) throw new Error(`Cookie [${idx}]: nome invalido.`);
      if (COOKIE_VALUE_FORBIDDEN_PATTERN.test(value) || COOKIE_CONTROL_CHAR_PATTERN.test(value)) {
        throw new Error(`Cookie [${idx}]: valor contem caracteres invalidos.`);
      }
      if (!COOKIE_DOMAIN_PATTERN.test(domain)) throw new Error(`Cookie [${idx}]: dominio invalido.`);
      if (!cookiePath.startsWith("/") || COOKIE_CONTROL_CHAR_PATTERN.test(cookiePath)) {
        throw new Error(`Cookie [${idx}]: path invalido.`);
      }

      const result: CookieInput = { name, value, domain, path: cookiePath };
      if (typeof e.httpOnly === "boolean") result.httpOnly = e.httpOnly;
      if (typeof e.secure === "boolean") result.secure = e.secure;
      if (typeof e.expires === "number" && Number.isFinite(e.expires) && e.expires > 0) {
        result.expires = e.expires;
      }
      if (e.sameSite !== undefined) result.sameSite = String(e.sameSite);
      return result;
    });
  }

  /**
   * Save cookies as Playwright storageState and return session metadata.
    * No browser is launched here - metadata extracted from cookie values.
   */
  async saveCookies(rawInput: string | object, sessionId: string): Promise<SessionResult> {
    let logs: SessionLog[] = [];
    const sessionPath = this.getSessionPath(sessionId);

    try {
      logs = this.addLog(logs, "Processando cookies...", "info");

      const cookies = this.parseCookieJson(rawInput);

      if (!Array.isArray(cookies) || cookies.length === 0) {
        throw new Error("Array de cookies vazio ou inválido");
      }

      logs = this.addLog(logs, `${cookies.length} cookies recebidos`, "info");

      const mercadoLivreCookies = cookies.filter((cookie) => this.looksLikeMercadoLivreCookie(cookie));
      if (mercadoLivreCookies.length === 0) {
        throw new Error("Os cookies enviados nao parecem ser do Mercado Livre. Exporte os cookies da pagina mercadolivre.com.br/afiliados/linkbuilder.");
      }
      if (mercadoLivreCookies.length !== cookies.length) {
        logs = this.addLog(
          logs,
          `${cookies.length - mercadoLivreCookies.length} cookie(s) de dominios externos foram ignorados por seguranca.`,
          "warn",
        );
      }

      const dedupedCookies = Array.from(new Map(
        mercadoLivreCookies.map((cookie) => [
          `${cookie.name}::${cookie.domain}::${cookie.path || "/"}`,
          cookie,
        ]),
      ).values());
      if (dedupedCookies.length !== mercadoLivreCookies.length) {
        logs = this.addLog(logs, `${mercadoLivreCookies.length - dedupedCookies.length} cookie(s) duplicado(s) removido(s).`, "info");
      }

      const cookieNames = dedupedCookies.map((c) => c.name);
      const foundHints = AUTH_HINT_COOKIES.filter((name) => cookieNames.includes(name));
      if (foundHints.length > 0) {
        logs = this.addLog(logs, `Cookies de autenticacao detectados: ${foundHints.join(", ")}`, "success");
      } else {
        logs = this.addLog(logs, "Nenhum cookie de autenticacao conhecido foi detectado (ssid/nsa_rotok). O teste de sessao confirmara validade.", "warn");
      }

      // Build Playwright storageState format
      const storageState = {
        cookies: dedupedCookies.map((cookie) => {
          const normalized: Record<string, unknown> = {
            name: cookie.name || "",
            value: cookie.value || "",
            domain: cookie.domain || ".mercadolivre.com.br",
            path: cookie.path || "/",
            httpOnly: cookie.httpOnly || false,
            secure: cookie.secure || false,
          };

          // Only set expires if it's a valid positive number (not session cookie)
          if (typeof cookie.expires === "number" && cookie.expires > 0) {
            normalized.expires = cookie.expires;
          }

          const sameSite = this.normalizeSameSite(cookie.sameSite);
          if (sameSite) normalized.sameSite = sameSite;

          return normalized;
        }),
        origins: [],
      };

      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.writeFile(sessionPath, JSON.stringify(storageState, null, 2), "utf-8");

      logs = this.addLog(logs, "Cookies salvos com sucesso", "success");

      const { accountName, mlUserId } = this.extractMetadataFromCookies(dedupedCookies);
      if (accountName) logs = this.addLog(logs, `Conta: ${accountName}`, "info");

      return {
        status: "untested",
        accountName,
        mlUserId,
        sessionPath,
        logs,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logs = this.addLog(logs, `Erro: ${message}`, "error");
      return { status: "error", logs };
    }
  }

  /**
    * Lightweight session test via HTTP - no browser opened.
   * Checks ML API with session cookies.
   */
  async testSessionLight(sessionId: string): Promise<SessionResult> {
    let logs: SessionLog[] = [];
    const preferredSessionPath = this.getSessionPath(sessionId);

    try {
      const sessionPath = await this.resolveExistingSessionPath(sessionId);
      if (!sessionPath) {
        return { status: "not_found", logs: this.addLog(logs, "Arquivo de sessão não encontrado", "error") };
      }

      logs = this.addLog(logs, "Carregando sessão...", "info");
      const storageStateRaw = await fs.readFile(sessionPath, "utf-8");
      const storageState = JSON.parse(storageStateRaw) as { cookies: CookieInput[] };

      // Build Cookie header from stored cookies for .mercadolivre.com.br
      const cookieHeader = storageState.cookies
        .filter((c) => String(c.domain).includes("mercadolivre.com.br"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      if (!cookieHeader) {
        return { status: "error", logs: this.addLog(logs, "Nenhum cookie .mercadolivre.com.br encontrado", "error") };
      }

      logs = this.addLog(logs, "Verificando sessão na página de afiliados...", "info");

      // ML REST API (api.mercadolivre.com.br) requires OAuth Bearer tokens, not browser cookies.
      // We test against the actual affiliate web page instead.
      const response = await fetch("https://www.mercadolivre.com.br/afiliados/linkbuilder", {
        headers: {
          Cookie: cookieHeader,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });

      const finalUrl = response.url;
      logs = this.addLog(logs, `URL final: ${finalUrl}`, "info");

      // Redirected to login -> session expired or invalid
      if (
        finalUrl.includes("/login") ||
        finalUrl.includes("/authentication") ||
        finalUrl.includes("auth.mercadolivre")
      ) {
        logs = this.addLog(logs, "Sessão expirada - redirecionado para login. Cole os cookies novamente.", "error");
        return { status: "expired", sessionPath, lastChecked: new Date().toISOString(), logs };
      }

      // Landed on affiliate page -> active
      if (finalUrl.includes("linkbuilder") || finalUrl.includes("/afiliados")) {
        const { accountName, mlUserId } = this.extractMetadataFromCookies(storageState.cookies);
        logs = this.addLog(logs, `Sessão ativa${accountName ? `: ${accountName}` : ""}`, "success");
        return {
          status: "active",
          accountName: accountName || undefined,
          mlUserId: mlUserId || undefined,
          sessionPath,
          lastChecked: new Date().toISOString(),
          logs,
        };
      }

      // On some other ML page - session valid but no affiliate access
      if (response.status === 200 && finalUrl.includes("mercadolivre")) {
        logs = this.addLog(logs, `Sessão válida, mas sem acesso a afiliados. URL: ${finalUrl}`, "warn");
        return { status: "no_affiliate", sessionPath, lastChecked: new Date().toISOString(), logs };
      }

      logs = this.addLog(logs, `Resposta inesperada: HTTP ${response.status}, URL: ${finalUrl}`, "warn");
      return { status: "error", sessionPath: preferredSessionPath, lastChecked: new Date().toISOString(), logs };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logs = this.addLog(logs, `Erro ao testar: ${message}`, "error");
      return { status: "error", logs };
    }
  }

  /**
    * Full session test via Playwright - navigates to ML affiliate page.
   * Used to verify affiliate program access, not just authentication.
   */
  async testSessionFull(sessionId: string): Promise<SessionResult> {
    let logs: SessionLog[] = [];
    const sessionPath = await this.resolveExistingSessionPath(sessionId);
    if (!sessionPath) {
      return { status: "not_found", logs: this.addLog(logs, "Sessão não encontrada", "error") };
    }

    let browser = null;
    let context = null;
    try {
      logs = this.addLog(logs, "Iniciando verificação completa...", "info");
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      context = await browser.newContext({ storageState: sessionPath });
      const page = await context.newPage();

      await page.goto("https://www.mercadolivre.com.br/afiliados/linkbuilder", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Some login redirects happen a moment after initial DOMContentLoaded.
      await page.waitForTimeout(2200);

      const currentUrl = page.url();
      logs = this.addLog(logs, `URL carregada: ${currentUrl}`, "info");

      if (
        currentUrl.includes("/login") ||
        currentUrl.includes("/authentication") ||
        currentUrl.includes("auth.mercadolivre")
      ) {
        logs = this.addLog(logs, "Sessão expirada - redirecionado para login. Cole os cookies novamente.", "error");
        return { status: "expired", sessionPath, lastChecked: new Date().toISOString(), logs };
      }

      if (currentUrl.includes("linkbuilder") || currentUrl.includes("/afiliados")) {
        const hasBuilderUi =
          (await page.locator("#url-0").count()) > 0 ||
          (await page.locator("button.links-form__button").count()) > 0 ||
          (await page.locator("textarea[placeholder*='link'], textarea[placeholder*='url']").count()) > 0;

        if (!hasBuilderUi) {
          logs = this.addLog(
            logs,
            "Sessão autenticada em /afiliados, mas o formulário do Linkbuilder não foi detectado (layout pode ter mudado).",
            "warn",
          );
        }

        // Try to read account nickname from the page
        const accountName = await page
          .$eval("[class*=\"nav-logo-subtitle\"], [data-testid=\"nav-menu-user-name\"], .nav-menu-link-text", (el) => el.textContent?.trim())
          .catch(() => undefined);
        logs = this.addLog(
          logs,
          `Sessão ativa${hasBuilderUi ? " e com acesso a afiliados" : " (afiliados carregado, UI do linkbuilder não confirmada)"}${accountName ? `: ${accountName}` : ""}`,
          hasBuilderUi ? "success" : "warn",
        );
        return { status: "active", accountName, sessionPath, lastChecked: new Date().toISOString(), logs };
      }

      logs = this.addLog(logs, `URL inesperada: ${currentUrl}`, "warn");
      return { status: "no_affiliate", sessionPath, lastChecked: new Date().toISOString(), logs };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logs = this.addLog(logs, `Erro: ${message}`, "error");
      return { status: "error", logs };
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  async clearSession(sessionId: string): Promise<SessionResult> {
    const sessionPaths = this.getSessionPathCandidates(sessionId);
    let logs: SessionLog[] = [];
    try {
      let removed = 0;
      for (const sessionPath of sessionPaths) {
        await fs.unlink(sessionPath).then(() => {
          removed += 1;
        }).catch((error: unknown) => {
          const e = error as NodeJS.ErrnoException;
          if (e.code !== "ENOENT") throw error;
        });
      }

      if (removed === 0) {
        return { status: "not_found", logs: this.addLog(logs, "Nenhuma sessão para remover", "info") };
      }

      logs = this.addLog(logs, "Sessão removida", "success");
      return { status: "not_found", logs };
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { status: "not_found", logs: this.addLog(logs, "Nenhuma sessão para remover", "info") };
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", logs: this.addLog(logs, `Erro: ${message}`, "error") };
    }
  }
}

export const sessionService = new MercadoLivreSessionService();




