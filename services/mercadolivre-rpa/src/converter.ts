import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import { readEncryptedStorageState } from "./session-cipher.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

interface ConversionCache {
  affiliateLink: string;
  timestamp: number;
}

interface QueueTask {
  productUrl: string;
  sessionId: string;
  scopeId: string;
  queuedAt: number;
  expiresAt: number;
  started: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  resolve: (result: ConversionResult) => void;
  reject: (reason: unknown) => void;
}

export interface ConversionResult {
  success: boolean;
  originalUrl: string;
  resolvedUrl?: string;
  affiliateLink?: string;
  error?: string;
  cached?: boolean;
  conversionTimeMs?: number;
}

type PlaywrightStorageState = {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "None" | "Lax" | "Strict";
  }[];
  origins: {
    origin: string;
    localStorage: {
      name: string;
      value: string;
    }[];
  }[];
};

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const LINKBUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder#hub";
const MAX_FAILURES_BEFORE_COOLDOWN = 5;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_CONVERSIONS = readPositiveIntEnv("MELI_QUEUE_MAX_CONCURRENCY", 2);
const QUEUE_BATCH_DELAY_MS = readPositiveIntEnv("MELI_QUEUE_BATCH_DELAY_MS", 15_000);
const MAX_PENDING_PER_SCOPE = readPositiveIntEnv("MELI_QUEUE_MAX_PENDING_PER_USER", 12);
const JOB_QUEUE_TIMEOUT_MS = readPositiveIntEnv("MELI_QUEUE_JOB_TIMEOUT_MS", 300_000);

export class MercadoLivreLinkConverter {
  private static instance: MercadoLivreLinkConverter;

  private queue: QueueTask[] = [];
  private activeCount = 0;
  private maxConcurrency: number;
  private batchDelayMs: number;
  private nextDispatchAt = 0;
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private cache = new Map<string, ConversionCache>();
  private pendingByScope = new Map<string, number>();
  private maxPendingPerScope: number;
  private queueTimeoutMs: number;
  private consecutiveFailuresByScope = new Map<string, number>();
  private cooldownUntilByScope = new Map<string, number>();
  private sessionsDir: string;
  private legacySessionsDir: string;
  private workspaceSessionsDir: string;

  private constructor() {
    this.maxConcurrency = MAX_CONCURRENT_CONVERSIONS;
    this.batchDelayMs = QUEUE_BATCH_DELAY_MS;
    this.maxPendingPerScope = MAX_PENDING_PER_SCOPE;
    this.queueTimeoutMs = JOB_QUEUE_TIMEOUT_MS;
    // Keep session lookup stable across different launch contexts.
    this.sessionsDir = path.resolve(__dirname, "..", ".sessions");
    this.legacySessionsDir = path.join(process.cwd(), ".sessions");
    this.workspaceSessionsDir = path.resolve(__dirname, "..", "..", "..", ".sessions");
    this.startHeartbeat();
    logger.info(
      {
        maxConcurrency: this.maxConcurrency,
        batchDelayMs: this.batchDelayMs,
        maxPendingPerScope: this.maxPendingPerScope,
        queueTimeoutMs: this.queueTimeoutMs,
      },
      "MercadoLivreLinkConverter initialized",
    );
  }

  private getQueueScope(sessionId: string): string {
    const split = String(sessionId || "").split("__", 1)[0]?.trim();
    return split || "global";
  }

  private incPendingScope(scopeId: string): void {
    this.pendingByScope.set(scopeId, (this.pendingByScope.get(scopeId) || 0) + 1);
  }

  private decPendingScope(scopeId: string): void {
    const next = (this.pendingByScope.get(scopeId) || 0) - 1;
    if (next > 0) this.pendingByScope.set(scopeId, next);
    else this.pendingByScope.delete(scopeId);
  }

  private removeQueuedTask(task: QueueTask): boolean {
    const idx = this.queue.indexOf(task);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.decPendingScope(task.scopeId);
    return true;
  }

  private isScopeInCooldown(scopeId: string): boolean {
    const until = this.cooldownUntilByScope.get(scopeId) || 0;
    if (Date.now() >= until) {
      this.cooldownUntilByScope.delete(scopeId);
      return false;
    }
    return true;
  }

  private getCooldownRemainingSeconds(scopeId: string): number {
    const until = this.cooldownUntilByScope.get(scopeId) || 0;
    if (until <= Date.now()) return 0;
    return Math.ceil((until - Date.now()) / 1000);
  }

  private registerScopeSuccess(scopeId: string): void {
    this.consecutiveFailuresByScope.delete(scopeId);
    this.cooldownUntilByScope.delete(scopeId);
  }

  private registerScopeFailure(scopeId: string): void {
    const failures = (this.consecutiveFailuresByScope.get(scopeId) || 0) + 1;
    this.consecutiveFailuresByScope.set(scopeId, failures);

    if (failures >= MAX_FAILURES_BEFORE_COOLDOWN) {
      this.cooldownUntilByScope.set(scopeId, Date.now() + COOLDOWN_MS);
      logger.warn({ scopeId, consecutiveFailures: failures }, "Entering cooldown for scope");
    }
  }

  private expireQueuedTask(task: QueueTask): void {
    if (task.started) return;
    const removed = this.removeQueuedTask(task);
    if (!removed) return;
    task.timeoutHandle = null;
    task.resolve({
      success: false,
      originalUrl: task.productUrl,
      error: `Tempo limite na fila excedido (${Math.floor(this.queueTimeoutMs / 1000)}s).`,
    });
  }

  static getInstance(): MercadoLivreLinkConverter {
    if (!MercadoLivreLinkConverter.instance) {
      MercadoLivreLinkConverter.instance = new MercadoLivreLinkConverter();
    }
    return MercadoLivreLinkConverter.instance;
  }

  private startHeartbeat(): void {
    setInterval(
      () => {
        const now = Date.now();
        // Purge expired cache entries
        for (const [key, entry] of this.cache.entries()) {
          if (now - entry.timestamp > CACHE_TTL_MS) {
            this.cache.delete(key);
          }
        }
        logger.debug({ cacheSize: this.cache.size, queueLength: this.queue.length, activeCount: this.activeCount }, "Heartbeat");
      },
      10 * 60 * 1000,
    ).unref();
  }

  private buildSessionPath(baseDir: string, sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return path.join(baseDir, `storageState_meli_${safe}.json`);
  }

  private getSessionPath(sessionId: string): string {
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
    const primary = this.getSessionPath(sessionId);
    const candidates = this.getSessionPathCandidates(sessionId);
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

  /**
   * Detect URLs that are already affiliate deep-links (promozonevip / social promo pages).
   * These hide the real product URL behind a portal — we must open the page and extract
   * the product title anchor to get the actual product URL before hitting linkbuilder.
   */
  private isPromozoneUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return (
        u.pathname.includes("/social/promozonevip") ||
        u.pathname.includes("/social/promo") ||
        u.searchParams.has("matt_word") ||
        u.searchParams.has("matt_tool")
      );
    } catch {
      return false;
    }
  }

  // Exact allowlist for outbound HEAD redirect-resolution.
  // Using .includes() was vulnerable to SSRF via hostnames like "evilmercadolivre.com".
  private static readonly REDIRECT_ALLOWED_HOSTS = new Set([
    "meli.la",
    "mlb.am",
    "mercadolivre.com",
    "mercadolivre.com.br",
    "mercadolibre.com",
    "mercadolibre.com.ar",
    "mercadolibre.com.mx",
    "mercadolibre.com.co",
    "mercadolibre.com.cl",
    "mercadolibre.com.uy",
    "mercadolibre.com.pe",
    "mercadolibre.com.ve",
    "mercadolibre.com.ec",
    "mercadolibre.com.bo",
    "mercadopago.com",
    "mercadopago.com.br",
    "mercadopago.com.ar",
    "mercadopago.com.mx",
    "mlstatic.com",
  ]);

  private isMercadoLivreRedirectHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    if (MercadoLivreLinkConverter.REDIRECT_ALLOWED_HOSTS.has(host)) return true;
    return [...MercadoLivreLinkConverter.REDIRECT_ALLOWED_HOSTS].some((d) => host.endsWith("." + d));
  }

  private isMercadoLivreShortHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    return host === "meli.la" || host.endsWith(".meli.la") || host === "mlb.am" || host.endsWith(".mlb.am");
  }

  private parseAllowedMercadoLivreHttpUrl(rawUrl: string): URL | null {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!this.isMercadoLivreRedirectHost(parsed.hostname)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Resolve short /sec/ redirect URLs before opening linkbuilder.
   * Done with a lightweight fetch — avoids loading a full browser page for it.
   */
  private async resolveRedirect(url: string): Promise<string> {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return url;

    // Resolve only short-link patterns to avoid unnecessary outbound requests.
    const shouldResolve = parsed.pathname.includes("/sec/") || this.isMercadoLivreShortHost(parsed.hostname);
    if (!shouldResolve) return parsed.toString();

    let current = parsed;
    const maxHops = 5;
    for (let hop = 0; hop < maxHops; hop += 1) {
      try {
        let response = await fetch(current.toString(), {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });

        // Some edge/CDN routes reject HEAD. Fallback to GET with the same redirect guards.
        if (response.status === 405 || response.status === 501) {
          response = await fetch(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          });
        }

        if (response.status < 300 || response.status >= 400) {
          return current.toString();
        }

        const location = String(response.headers.get("location") || "").trim();
        if (!location) return current.toString();

        const next = this.parseAllowedMercadoLivreHttpUrl(new URL(location, current).toString());
        if (!next) {
          logger.warn({ from: current.toString(), to: location }, "Blocked redirect to non-allowlisted host");
          return current.toString();
        }
        current = next;
      } catch {
        return current.toString();
      }
    }

    return current.toString();
  }

  /**
   * When the incoming URL is a promozonevip/social promo link, open the page in the
   * authenticated context, find the product title anchor and return its href.
   * The real product URL is always in `a.poly-component__title` on the portal page.
   */
  private async resolvePromozone(url: string, context: BrowserContext): Promise<string> {
    const tempPage = await context.newPage();
    try {
      await this.applyAntiBotPatches(tempPage);
      await tempPage.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css,mp4,mp3,webm,avi}", (route) => route.abort());
      await tempPage.route("**/analytics*", (route) => route.abort());
      await tempPage.route("**/beacon*", (route) => route.abort());
      await tempPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await tempPage.waitForTimeout(1500);

      // Try the known title anchor class, then any link containing the product path
      const selectors = [
        'a.poly-component__title',
        'a[class*="poly-component__title"]',
        'a[class*="title"][href*="mercadolivre.com.br"]',
      ];

      for (const sel of selectors) {
        try {
          const el = await tempPage.$(sel);
          if (el) {
            const href = await el.getAttribute("href");
            if (href && href.includes("mercadolivre.com.br")) {
              logger.debug({ promozoneUrl: url, realUrl: href }, "Resolved promozonevip → real product URL");
              return href;
            }
          }
        } catch {
          // Ignore selector miss and continue fallback cascade.
        }
      }

      logger.warn({ url }, "Could not find product title link on promozonevip page — using original URL");
      return url;
    } catch (e) {
      logger.warn({ url, error: String(e) }, "resolvePromozone failed — using original URL");
      return url;
    } finally {
      await tempPage.close().catch((closeError) => {
        logger.debug({ error: String(closeError) }, "Failed to close temp promozone page");
      });
    }
  }

  /**
   * Apply anti-bot patches to a page before navigation.
   */
  private async applyAntiBotPatches(page: Page): Promise<void> {
    await page.addInitScript(() => {
      // Mask Playwright/CDP fingerprints
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-expect-error non-standard playwright marker, safe to delete in browser context
      delete window.__playwright;
      // @ts-expect-error non-standard playwright marker, safe to delete in browser context
      delete window.__pw_manual;
    });
  }

  /**
   * 5-strategy extraction cascade for the affiliate link from linkbuilder.
   */
  private async extractAffiliateLink(page: Page, originalUrl: string): Promise<string | null> {
    // Strategy 0: Known ML linkbuilder result textarea (confirmed selector from live page)
    try {
      const el = await page.$("#textfield-copyLink-1");
      if (el) {
        const val = await el.inputValue();
        if (val && val.startsWith("https://")) return val;
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 1: aria-label result input (copy-to-share wording ML uses)
    try {
      const el = await page.$('[aria-label*="Copie o link"], [aria-label*="Link gerado"], [aria-label*="affiliate"], [aria-label*="resultado"]');
      if (el) {
        const val = await el.inputValue();
        if (val && val.startsWith("https://")) return val;
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 2: known result container IDs
    try {
      for (const id of ["generated-link", "affiliate-link", "result-link", "outputLink"]) {
        const el = await page.$(`#${id}`);
        if (el) {
          const val = await el.inputValue().catch(() => el.textContent());
          if (val && typeof val === "string" && val.startsWith("https://")) return val;
        }
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 3: regex from page content — meli.la short links and s.mercadolivre.com.br
    try {
      const content = await page.content();
      const match = content.match(/https:\/\/(meli\.la|s\.mercadolivre\.com\.br)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{5,}/);
      if (match) return match[0];
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 4: any readonly input/textarea that appeared after clicking "Gerar"
    try {
      const inputs = await page.$$("input[readonly], textarea[readonly]");
      for (const input of inputs) {
        const val = await input.inputValue();
        if (val && val.startsWith("https://") && !val.includes(new URL(originalUrl).hostname === "www.mercadolivre.com.br" ? "mercadolivre.com.br" : "x")) return val;
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    return null;
  }

  /**
   * Core Playwright conversion flow.
   */
  private async performConversion(productUrl: string, sessionId: string): Promise<ConversionResult> {
    const startTime = Date.now();
    const sessionPath = await this.resolveExistingSessionPath(sessionId);

    if (!sessionPath) {
      return { success: false, originalUrl: productUrl, error: `Sessão '${sessionId}' não encontrada` };
    }

    // Session files are encrypted at rest ("enc:v1:*"), so Playwright cannot
    // read them directly by file path. Decrypt in-memory first.
    const decryptedState = await readEncryptedStorageState<PlaywrightStorageState>(sessionPath);
    if (!decryptedState) {
      return {
        success: false,
        originalUrl: productUrl,
        error: "Sessao expirada ou invalida. Reenvie os cookies do Mercado Livre.",
      };
    }

    // Step 1a: Resolve /sec/ short redirect with a lightweight HTTP HEAD (no browser needed)
    let resolvedUrl = await this.resolveRedirect(productUrl);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          "--memory-pressure-off",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-sync",
          "--disable-translate",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--no-first-run",
        ],
      });
      context = await browser.newContext({
        storageState: decryptedState,
        viewport: { width: 800, height: 600 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        locale: "pt-BR",
      });

      // Step 1b: Resolve promozonevip / social promo URLs → extract real product URL
      // These are pre-converted affiliate deep-links; the browser needs session cookies to see
      // the product title anchor that holds the real product URL.
      if (this.isPromozoneUrl(resolvedUrl)) {
        resolvedUrl = await this.resolvePromozone(resolvedUrl, context);
      }

      logger.debug({ originalUrl: productUrl, resolvedUrl, sessionId }, "Starting conversion");

      const page = await context.newPage();

      // Block unnecessary resources for speed
      await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css,mp4,mp3,webm,avi}", (route) => route.abort());
      await page.route("**/analytics*", (route) => route.abort());
      await page.route("**/beacon*", (route) => route.abort());

      await this.applyAntiBotPatches(page);

      // Navigate to linkbuilder
      await page.goto(LINKBUILDER_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

      // Login redirects can happen a few seconds after DOMContentLoaded and can
      // bounce back to /afiliados when the session is still valid.
      const isLoginLikeUrl = (url: string): boolean => (
        url.includes("/login")
        || url.includes("/authentication")
        || url.includes("auth.mercadolivre")
      );

      await page.waitForTimeout(2200);
      let currentUrl = page.url();
      if (isLoginLikeUrl(currentUrl)) {
        await page.waitForTimeout(2600);
        currentUrl = page.url();
      }
      if (isLoginLikeUrl(currentUrl)) {
        await page.goto(LINKBUILDER_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
        await page.waitForTimeout(2200);
        currentUrl = page.url();
      }
      if (isLoginLikeUrl(currentUrl)) {
        return {
          success: false,
          originalUrl: productUrl,
          error: "Sessão Mercado Livre expirada ou inválida. Atualize os cookies em Configurações ML.",
        };
      }

      // Small random delay to avoid bot patterns (300-800ms)
      await page.waitForTimeout(300 + Math.floor(Math.random() * 500));

      // Find the URL input area — #url-0 is the known ID on the live ML linkbuilder page
      const inputSelectors = [
        "#url-0",
        'textarea[placeholder*="mercadolivre.com"]',
        'textarea[placeholder*="link"]',
        'textarea[placeholder*="url"]',
        'input[placeholder*="link"]',
        'input[placeholder*="url"]',
        'textarea[name="link"]',
        "#product-url",
        "#link-input",
        '[data-testid="link-input"]',
      ];

      let inputFilled = false;
      for (const selector of inputSelectors) {
        try {
          const el = await page.$(selector);
          if (el) {
            await el.fill(resolvedUrl);
            inputFilled = true;
            logger.debug({ selector }, "Filled input");
            break;
          }
        } catch {
          // Ignore selector lookup failure and try next selector.
        }
      }

      if (!inputFilled) {
        // Fallback: try any visible textarea
        const textareas = await page.$$("textarea:visible");
        if (textareas.length > 0) {
          await textareas[0].fill(resolvedUrl);
          inputFilled = true;
        }
      }

      if (!inputFilled) {
        return {
          success: false,
          originalUrl: productUrl,
          error: `Não foi possível encontrar o campo de URL na página do linkbuilder (URL atual: ${page.url()}).`,
        };
      }

      await page.waitForTimeout(200 + Math.floor(Math.random() * 200));

      // Wait for the Gerar button to become enabled — ML's JS enables it after input is filled
      // The button starts as disabled="" and the class andes-button--disabled is removed by ML's JS
      await page.waitForFunction(
        () => {
          const btn =
            document.querySelector("button.links-form__button") ||
            document.querySelector(".andes-button--loud");
          return btn && !btn.hasAttribute("disabled");
        },
        { timeout: 6000 },
      ).catch(() => {
        // Non-fatal: proceed even if button stays disabled (might already be ready)
      });

      // Click "Gerar" button — try the known class first, then fallbacks
      const buttonSelectors = [
        "button.links-form__button:not([disabled])",
        'button:has-text("Gerar")',
        'button:has-text("Gerar link")',
        'button[type="submit"]:not([disabled])',
        'button:has-text("Converter")',
        '[data-testid="generate-button"]',
      ];

      let buttonClicked = false;
      for (const sel of buttonSelectors) {
        try {
          await page.click(sel, { timeout: 3000 });
          buttonClicked = true;
          logger.debug({ selector: sel }, "Clicked generate button");
          break;
        } catch {
          // Ignore click selector failure and try next selector.
        }
      }

      if (!buttonClicked) {
        // Try pressing Enter on the input
        await page.keyboard.press("Enter");
        buttonClicked = true;
      }

      // Wait for result to appear (up to 15s)
      await page.waitForTimeout(2000);

      const affiliateLink = await this.extractAffiliateLink(page, resolvedUrl);

      if (!affiliateLink) {
        return {
          success: false,
          originalUrl: productUrl,
          error: "Link afiliado não encontrado na resposta do linkbuilder. Verifique se sua conta tem acesso ao programa de afiliados.",
        };
      }

      const conversionTimeMs = Date.now() - startTime;
      logger.info({ productUrl, affiliateLink, conversionTimeMs, sessionId }, "Conversion successful");

      return { success: true, originalUrl: productUrl, resolvedUrl, affiliateLink, conversionTimeMs };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ productUrl, sessionId, error: message }, "Conversion error");
      return { success: false, originalUrl: productUrl, resolvedUrl, error: message };
    } finally {
      await context?.close().catch((closeError) => {
        logger.debug({ error: String(closeError) }, "Failed to close browser context");
      });
      await browser?.close().catch((closeError) => {
        logger.debug({ error: String(closeError) }, "Failed to close browser");
      });
    }
  }

  /**
   * Public convert method — checks cache first, then queues.
   */
  async convertLink(productUrl: string, sessionId: string): Promise<ConversionResult> {
    const cacheKey = `${sessionId}::${productUrl}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return { success: true, originalUrl: productUrl, affiliateLink: cached.affiliateLink, cached: true };
    }

    const scopeId = this.getQueueScope(sessionId);

    // Cooldown check (isolated by queue scope/user)
    if (this.isScopeInCooldown(scopeId)) {
      const remaining = this.getCooldownRemainingSeconds(scopeId);
      return { success: false, originalUrl: productUrl, error: `Serviço em cooldown após erros consecutivos. Aguarde ${remaining}s.` };
    }

    const pendingForScope = this.pendingByScope.get(scopeId) || 0;
    if (pendingForScope >= this.maxPendingPerScope) {
      return {
        success: false,
        originalUrl: productUrl,
        error: `Fila cheia para esta conta (${this.maxPendingPerScope} pendências). Tente novamente em instantes.`,
      };
    }

    return new Promise<ConversionResult>((resolve, reject) => {
      const now = Date.now();
      const task: QueueTask = {
        productUrl,
        sessionId,
        scopeId,
        queuedAt: now,
        expiresAt: now + this.queueTimeoutMs,
        started: false,
        timeoutHandle: null,
        resolve,
        reject,
      };

      task.timeoutHandle = setTimeout(() => this.expireQueuedTask(task), this.queueTimeoutMs);
      this.queue.push(task);
      this.incPendingScope(scopeId);
      this.scheduleDrain();
    }).then((result) => {
      if (result.success && result.affiliateLink) {
        this.registerScopeSuccess(scopeId);
        this.cache.set(cacheKey, { affiliateLink: result.affiliateLink, timestamp: Date.now() });
      } else {
        this.registerScopeFailure(scopeId);
      }
      return result;
    });
  }

  private scheduleDrain(): void {
    if (this.activeCount > 0 || this.queue.length === 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.nextDispatchAt - now);
    if (waitMs === 0) {
      this.drain();
      return;
    }

    if (this.dispatchTimer) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.drain();
    }, waitMs);
  }

  private drain(): void {
    if (this.activeCount > 0 || this.queue.length === 0) return;
    if (Date.now() < this.nextDispatchAt) {
      this.scheduleDrain();
      return;
    }

    let startedNow = 0;
    while (startedNow < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.decPendingScope(task.scopeId);
      task.started = true;
      if (task.timeoutHandle) {
        clearTimeout(task.timeoutHandle);
        task.timeoutHandle = null;
      }

      if (Date.now() > task.expiresAt) {
        task.resolve({
          success: false,
          originalUrl: task.productUrl,
          error: `Tempo limite na fila excedido (${Math.floor(this.queueTimeoutMs / 1000)}s).`,
        });
        continue;
      }

      this.activeCount++;
      startedNow++;
      this.performConversion(task.productUrl, task.sessionId)
        .then(task.resolve)
        .catch(task.reject)
        .finally(() => {
          this.activeCount--;
          if (this.activeCount === 0 && this.queue.length > 0) {
            this.nextDispatchAt = Date.now() + this.batchDelayMs;
            this.scheduleDrain();
          }
        });
    }
  }

  getStats() {
    const pendingByScope = Object.fromEntries(this.pendingByScope.entries());
    const pendingTotal = Object.values(pendingByScope).reduce((acc, n) => acc + Number(n || 0), 0);
    const now = Date.now();
    const activeCooldownByScope = Object.fromEntries(
      [...this.cooldownUntilByScope.entries()]
        .filter(([, until]) => until > now)
        .map(([scopeId, until]) => [scopeId, Math.ceil((until - now) / 1000)]),
    );
    const consecutiveFailuresByScope = Object.fromEntries(this.consecutiveFailuresByScope.entries());
    const cooldownActive = Object.keys(activeCooldownByScope).length > 0;
    const consecutiveFailures = Math.max(0, ...Object.values(consecutiveFailuresByScope).map((n) => Number(n || 0)));

    return {
      cacheSize: this.cache.size,
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      maxConcurrency: this.maxConcurrency,
      batchDelayMs: this.batchDelayMs,
      queueTimeoutMs: this.queueTimeoutMs,
      maxPendingPerScope: this.maxPendingPerScope,
      pendingTotal,
      pendingByScope,
      nextDispatchInMs: Math.max(0, this.nextDispatchAt - Date.now()),
      cooldownActive,
      consecutiveFailures,
      activeCooldownByScope,
      consecutiveFailuresByScope,
    };
  }
}

export const converter = MercadoLivreLinkConverter.getInstance();
