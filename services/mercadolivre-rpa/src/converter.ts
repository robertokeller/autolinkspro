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
  resolvedUrl?: string;
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

type ConvertLinkOptions = {
  forceResolve?: boolean;
};

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

type PageDestinationCandidate = {
  href: string;
  text: string;
  className: string;
  source: string;
  index: number;
};

type PageDestinationSnapshot = {
  currentUrl: string;
  canonicalUrl: string;
  ogUrl: string;
  candidates: PageDestinationCandidate[];
};

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const LINKBUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder#hub";
const BROWSER_LIKE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REDIRECT_FETCH_HEADERS: Record<string, string> = {
  "user-agent": BROWSER_LIKE_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
};
const MAX_FAILURES_BEFORE_COOLDOWN = readPositiveIntEnv("MELI_COOLDOWN_MAX_FAILURES", 5);
const COOLDOWN_MS = readPositiveIntEnv("MELI_COOLDOWN_MS", 10 * 60 * 1000);
const FAILURE_STREAK_WINDOW_MS = readPositiveIntEnv("MELI_COOLDOWN_FAILURE_WINDOW_MS", 3 * 60 * 1000);
const MAX_CONCURRENT_CONVERSIONS = readPositiveIntEnv("MELI_QUEUE_MAX_CONCURRENCY", 2);
const QUEUE_BATCH_DELAY_MS = readPositiveIntEnv("MELI_QUEUE_BATCH_DELAY_MS", 15_000);
const MAX_PENDING_PER_SCOPE = readPositiveIntEnv("MELI_QUEUE_MAX_PENDING_PER_USER", 12);
const JOB_QUEUE_TIMEOUT_MS = readPositiveIntEnv("MELI_QUEUE_JOB_TIMEOUT_MS", 600_000);

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
  private failureStreakWindowMs: number;
  private consecutiveFailuresByScope = new Map<string, number>();
  private lastFailureAtByScope = new Map<string, number>();
  private cooldownUntilByScope = new Map<string, number>();
  private sessionsDir: string;
  private legacySessionsDir: string;
  private workspaceSessionsDir: string;
  private conversionTracePath: string;

  private constructor() {
    this.maxConcurrency = MAX_CONCURRENT_CONVERSIONS;
    this.batchDelayMs = QUEUE_BATCH_DELAY_MS;
    this.maxPendingPerScope = MAX_PENDING_PER_SCOPE;
    this.queueTimeoutMs = JOB_QUEUE_TIMEOUT_MS;
    this.failureStreakWindowMs = FAILURE_STREAK_WINDOW_MS;
    // Keep session lookup stable across different launch contexts.
    this.sessionsDir = path.resolve(__dirname, "..", ".sessions");
    this.legacySessionsDir = path.join(process.cwd(), ".sessions");
    this.workspaceSessionsDir = path.resolve(__dirname, "..", "..", "..", ".sessions");
    this.conversionTracePath = path.resolve(__dirname, "..", "..", "..", "logs", "meli-conversion-trace.log");
    this.startHeartbeat();
    logger.info(
      {
        maxConcurrency: this.maxConcurrency,
        batchDelayMs: this.batchDelayMs,
        maxPendingPerScope: this.maxPendingPerScope,
        queueTimeoutMs: this.queueTimeoutMs,
        cooldownMaxFailures: MAX_FAILURES_BEFORE_COOLDOWN,
        cooldownMs: COOLDOWN_MS,
        cooldownFailureWindowMs: this.failureStreakWindowMs,
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
    if (until <= 0) return false;

    if (Date.now() >= until) {
      this.cooldownUntilByScope.delete(scopeId);
      this.consecutiveFailuresByScope.delete(scopeId);
      this.lastFailureAtByScope.delete(scopeId);
      logger.info({ scopeId }, "Cooldown expired; reset failure state for scope");
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
    this.lastFailureAtByScope.delete(scopeId);
    this.cooldownUntilByScope.delete(scopeId);
  }

  private normalizeComparableMessage(raw: unknown): string {
    return String(raw || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  private shouldCountFailureForCooldown(errorMessage?: string): { count: boolean; category: string } {
    const normalized = this.normalizeComparableMessage(errorMessage);
    if (!normalized) return { count: true, category: "unknown-empty-error" };

    const ignoredPatterns: Array<{ category: string; pattern: RegExp }> = [
      {
        category: "session-state",
        pattern: /(reenvie os cookies|sessao.*(expirad|inval|nao encontrad)|session.*not found|storagestate_meli_)/,
      },
      {
        category: "no-affiliate-access",
        pattern: /(programa de afiliados|sem acesso ao programa de afiliados|no_affiliate|link afiliado nao encontrado)/,
      },
      {
        category: "queue-overload",
        pattern: /(fila cheia para esta conta|tempo limite na fila excedido|queue timeout|queue full)/,
      },
      {
        category: "linkbuilder-selector",
        pattern: /nao foi possivel encontrar o campo de url na pagina do linkbuilder/,
      },
    ];

    for (const rule of ignoredPatterns) {
      if (rule.pattern.test(normalized)) {
        return { count: false, category: rule.category };
      }
    }

    const cooldownPatterns: Array<{ category: string; pattern: RegExp }> = [
      {
        category: "upstream-rate-limit",
        pattern: /(http 429|too many requests|rate limit|captcha|challenge|security check)/,
      },
      {
        category: "upstream-instability",
        pattern: /(service unavailable|http 50[0-9]|timeout|timed out|temporar|econnreset|socket hang up|net::)/,
      },
      {
        category: "runtime-browser-error",
        pattern: /(target closed|browser has been closed|execution context was destroyed|navigation failed)/,
      },
    ];

    for (const rule of cooldownPatterns) {
      if (rule.pattern.test(normalized)) {
        return { count: true, category: rule.category };
      }
    }

    return { count: true, category: "generic-error" };
  }

  resetScopeStateForSession(sessionId: string): void {
    const scopeId = this.getQueueScope(sessionId);
    this.registerScopeSuccess(scopeId);
    logger.info({ scopeId }, "Reset cooldown/failure state for scope");
  }

  private registerScopeFailure(scopeId: string, errorMessage?: string): void {
    const decision = this.shouldCountFailureForCooldown(errorMessage);
    if (!decision.count) {
      logger.info({ scopeId, category: decision.category, errorMessage }, "Failure ignored for cooldown streak");
      return;
    }

    const now = Date.now();
    const lastFailureAt = this.lastFailureAtByScope.get(scopeId) || 0;
    const withinFailureWindow = lastFailureAt > 0 && (now - lastFailureAt) <= this.failureStreakWindowMs;
    const previousFailures = withinFailureWindow ? (this.consecutiveFailuresByScope.get(scopeId) || 0) : 0;
    const failures = previousFailures + 1;

    this.lastFailureAtByScope.set(scopeId, now);
    this.consecutiveFailuresByScope.set(scopeId, failures);

    if (failures >= MAX_FAILURES_BEFORE_COOLDOWN) {
      this.cooldownUntilByScope.set(scopeId, Date.now() + COOLDOWN_MS);
      logger.warn(
        { scopeId, consecutiveFailures: failures, category: decision.category, errorMessage },
        "Entering cooldown for scope",
      );
      return;
    }

    logger.info(
      { scopeId, consecutiveFailures: failures, category: decision.category, withinFailureWindow },
      "Registered cooldown-eligible failure",
    );
  }

  private traceConversionStep(step: string, payload: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      step,
      ...payload,
    };
    try {
      logger.info(entry, "Conversion trace step");
      // Persist step-by-step execution so we can audit real runtime behavior
      // even when the parent process stdio is not attached to local log files.
      void fs.mkdir(path.dirname(this.conversionTracePath), { recursive: true })
        .then(() => fs.appendFile(this.conversionTracePath, `${JSON.stringify(entry)}\n`, "utf8"))
        .catch(() => undefined);
    } catch {
      // Tracing should never block conversion flow.
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
        u.pathname.includes("/social/lapromotion") ||
        u.pathname.includes("/social/promozonevip") ||
        u.pathname.includes("/social/promo") ||
        (u.pathname.includes("/social/") && (u.searchParams.has("ref") || u.searchParams.has("forceInApp"))) ||
        u.searchParams.has("matt_word") ||
        u.searchParams.has("matt_tool")
      );
    } catch {
      return false;
    }
  }

  private decodeMercadoLivrePathname(pathname: string): string {
    const raw = String(pathname || "");
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  private isIntermediateMercadoLivrePath(pathname: string): boolean {
    const normalized = this.decodeMercadoLivrePathname(pathname).toLowerCase();
    if (!normalized) return false;
    return (
      normalized.includes("/social/")
      || normalized.includes("/sec/")
      || normalized.includes("/afiliados/")
      || normalized.includes("/noindex/services/")
      || normalized.includes("/authentication")
      || normalized.includes("/login")
    );
  }

  private hasMercadoLivreProductPathHint(pathname: string): boolean {
    const decoded = this.decodeMercadoLivrePathname(pathname);
    if (!decoded) return false;
    return (
      /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(decoded)
      || /\/(p|up|item)\//i.test(decoded)
    );
  }

  private extractMercadoLivreItemId(parsed: URL): string | null {
    const pathname = this.decodeMercadoLivrePathname(parsed.pathname);

    const pathMatch = pathname.match(/(?:^|\/)(ML[A-Z]{1,4}-?\d+)(?:[/_-]|$)/i);
    if (pathMatch && pathMatch[1]) {
      return String(pathMatch[1]).toUpperCase();
    }

    const queryCandidates = [
      parsed.searchParams.get("item_id"),
      parsed.searchParams.get("item"),
      parsed.searchParams.get("id"),
      parsed.searchParams.get("productId"),
    ];
    for (const candidate of queryCandidates) {
      const match = String(candidate || "").trim().match(/(ML[A-Z]{1,4}-?\d+)/i);
      if (match && match[1]) {
        return String(match[1]).toUpperCase();
      }
    }

    return null;
  }

  private buildCanonicalMercadoLivreHost(hostname: string): string | null {
    const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
    if (!host) return null;

    if (host.startsWith("produto.mercadolivre.") || host.startsWith("produto.mercadolibre.")) {
      return host;
    }

    const mercadoLivreToken = "mercadolivre.";
    const mercadoLivreIndex = host.indexOf(mercadoLivreToken);
    if (mercadoLivreIndex >= 0) {
      const suffix = host.slice(mercadoLivreIndex + mercadoLivreToken.length).trim();
      if (suffix) return `produto.mercadolivre.${suffix}`;
    }

    const mercadoLibreToken = "mercadolibre.";
    const mercadoLibreIndex = host.indexOf(mercadoLibreToken);
    if (mercadoLibreIndex >= 0) {
      const suffix = host.slice(mercadoLibreIndex + mercadoLibreToken.length).trim();
      if (suffix) return `produto.mercadolibre.${suffix}`;
    }

    return null;
  }

  private toCanonicalMercadoLivreProductUrl(rawUrl: string): string | null {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(rawUrl);
    if (!parsed) return null;

    parsed.hash = "";
    const itemId = this.extractMercadoLivreItemId(parsed);
    const hasPathHint = this.hasMercadoLivreProductPathHint(parsed.pathname);
    const isIntermediatePath = this.isIntermediateMercadoLivrePath(parsed.pathname);

    if (itemId && hasPathHint && !isIntermediatePath) {
      return parsed.toString();
    }

    if (itemId && isIntermediatePath) {
      const canonicalHost = this.buildCanonicalMercadoLivreHost(parsed.hostname);
      if (!canonicalHost) return null;
      return `https://${canonicalHost}/${itemId}`;
    }

    return null;
  }

  private isStrictMercadoLivreProductUrl(url: string): boolean {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return false;

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!(host.includes("mercadolivre.") || host.includes("mercadolibre."))) {
      return false;
    }

    if (this.isIntermediateMercadoLivrePath(parsed.pathname)) return false;
    if (!this.hasMercadoLivreProductPathHint(parsed.pathname)) return false;

    return this.extractMercadoLivreItemId(parsed) !== null;
  }

  private normalizeCandidateMercadoLivreUrl(rawUrl: string, baseUrl: string): string | null {
    const raw = String(rawUrl || "").trim();
    if (!raw) return null;
    try {
      const absolute = new URL(raw, baseUrl).toString();
      const parsed = this.parseAllowedMercadoLivreHttpUrl(absolute);
      if (!parsed) return null;
      // Linkbuilder does not need recommendation fragments and they can vary per render.
      parsed.hash = "";
      return this.toCanonicalMercadoLivreProductUrl(parsed.toString()) || parsed.toString();
    } catch {
      return null;
    }
  }

  private isLikelyProductUrl(url: string): boolean {
    return this.toCanonicalMercadoLivreProductUrl(url) !== null;
  }

  private normalizeTextForMatch(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  private normalizeActionLabel(value: string): string {
    return this.normalizeTextForMatch(value)
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isPolyActionLinkClass(className: string): boolean {
    const normalized = String(className || "").toLowerCase();
    return (
      normalized.includes("poly-component__link--action-link")
      || normalized.includes("poly-action-links__action")
    );
  }

  private hrefLooksLikeMeliProductPath(href: string): boolean {
    const normalized = String(href || "");
    return (
      /produto\.mercadolivre\.com\.br/i.test(normalized)
      || /\/(p|up|item)\//i.test(normalized)
      || /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(normalized)
    );
  }

  private isGoToProductActionLabel(value: string): boolean {
    const label = this.normalizeActionLabel(value);
    if (!label) return false;

    const strongPatterns = [
      /(^| )ir para (o )?produto( |$)/,
      /(^| )ir ao produto( |$)/,
      /(^| )ver (o )?produto( |$)/,
      /(^| )abrir (o )?produto( |$)/,
      /(^| )ir al producto( |$)/,
      /(^| )ver producto( |$)/,
      /(^| )go to product( |$)/,
      /(^| )view product( |$)/,
    ];
    if (strongPatterns.some((pattern) => pattern.test(label))) return true;

    const hasProductWord = /(^| )(produto|producto|product)( |$)/.test(label);
    const hasActionVerb = /(^| )(ir|ver|abrir|acessar|comprar|go|view|open)( |$)/.test(label);

    return (
      hasProductWord
      && hasActionVerb
    );
  }

  private scoreDestinationCandidate(
    candidateUrl: string,
    candidate: Pick<PageDestinationCandidate, "text" | "className" | "source" | "index">,
  ): number {
    let score = 0;
    const text = this.normalizeTextForMatch(candidate.text);
    const className = String(candidate.className || "").toLowerCase();
    const source = String(candidate.source || "").toLowerCase();

    if (this.isLikelyProductUrl(candidateUrl)) score += 120;
    if (candidateUrl.includes("produto.mercadolivre.com.br")) score += 50;
    if (/\/social\//i.test(candidateUrl)) score -= 90;
    if (/\/lists\//i.test(candidateUrl)) score -= 40;
    if (/\/afiliados\//i.test(candidateUrl)) score -= 60;

    if (source === "canonical") score += 35;
    if (source === "og:url") score += 25;
    if (source.includes("action")) score += 30;
    if (source.includes("title")) score += 10;

    if (className.includes("action-link")) score += 25;
    if (this.isPolyActionLinkClass(className)) score += 15;
    if (className.includes("poly-component__title")) score += 12;

    if (this.isGoToProductActionLabel(candidate.text)) {
      score += 45;
    }

    if (Number.isFinite(candidate.index) && candidate.index >= 0) {
      score -= Math.min(15, candidate.index);
    }

    return score;
  }

  private async collectPageDestinationSnapshot(page: Page): Promise<PageDestinationSnapshot> {
    return await page.evaluate(() => {
      const selectors: Array<{ source: string; selector: string }> = [
        { source: "action-link", selector: "div.poly-action-links__action a.poly-component__link--action-link" },
        { source: "action-link", selector: "div.poly-action-links__action a" },
        { source: "action-link", selector: "a.poly-component__link--action-link" },
        { source: "title-link", selector: "a.poly-component__title" },
        { source: "title-link", selector: "a[class*='poly-component__title']" },
        { source: "product-link", selector: "a[href*='produto.mercadolivre.com.br']" },
        { source: "product-link", selector: "a[href*='/p/'], a[href*='/up/'], a[href*='/MLA'], a[href*='/MLB'], a[href*='/MLC'], a[href*='/MLM'], a[href*='/MLU']" },
      ];

      const candidates: PageDestinationCandidate[] = [];
      const seen = new Set<string>();
      let index = 0;

      for (const { source, selector } of selectors) {
        const anchors = Array.from(document.querySelectorAll(selector)).slice(0, 30);
        for (const anchor of anchors) {
          const href = String(anchor.getAttribute("href") || "").trim();
          if (!href) continue;

          const text = String(anchor.textContent || "").replace(/\s+/g, " ").trim();
          const className = String(anchor.getAttribute("class") || "").trim();
          const dedupeKey = `${href}::${text}::${className}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          candidates.push({ href, text, className, source, index });
          index += 1;
        }
      }

      const canonicalUrl = String(document.querySelector("link[rel='canonical']")?.getAttribute("href") || "").trim();
      const ogUrl = String(document.querySelector("meta[property='og:url'], meta[name='og:url']")?.getAttribute("content") || "").trim();

      return {
        currentUrl: location.href,
        canonicalUrl,
        ogUrl,
        candidates,
      };
    });
  }

  private chooseBestDestinationUrl(snapshot: PageDestinationSnapshot, baseUrl: string): string | null {
    const rawCandidates: Array<Pick<PageDestinationCandidate, "href" | "text" | "className" | "source" | "index">> = [
      { href: snapshot.currentUrl, text: "", className: "", source: "current", index: -1 },
      { href: snapshot.canonicalUrl, text: "", className: "", source: "canonical", index: -1 },
      { href: snapshot.ogUrl, text: "", className: "", source: "og:url", index: -1 },
      ...snapshot.candidates,
    ];

    let bestUrl: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const seenUrls = new Set<string>();

    for (const candidate of rawCandidates) {
      const normalized = this.normalizeCandidateMercadoLivreUrl(candidate.href, baseUrl);
      if (!normalized) continue;
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);

      const score = this.scoreDestinationCandidate(normalized, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestUrl = normalized;
      }
    }

    if (!bestUrl) return null;
    if (this.isLikelyProductUrl(bestUrl)) return bestUrl;
    if (!this.isPromozoneUrl(bestUrl) && bestScore >= 45) return bestUrl;
    return null;
  }

  private getDestinationHintSelectors(): string[] {
    return [
      "div.poly-action-links__action a",
      "a.poly-component__link--action-link",
      "a.poly-component__title",
      "a[href*='produto.mercadolivre.com.br']",
      "a[href*='/up/']",
      "a[href*='/p/']",
    ];
  }

  private getActionClickSelectors(): string[] {
    return [
      "div.poly-action-links__action a.poly-component__link--action-link",
      "div.poly-action-links__action a",
      "a.poly-component__link--action-link",
      "a.poly-component__title",
      "a[href*='produto.mercadolivre.com.br']",
      "a[href*='/up/']",
      "a[href*='/p/']",
    ];
  }

  private async waitForGoToProductHref(page: Page, baseUrl: string): Promise<string | null> {
    const deadlinesMs = [1200, 2400, 4000, 6000, 8500, 11000, 14000];
    let elapsedPrevious = 0;

    for (const elapsed of deadlinesMs) {
      const waitMs = Math.max(0, elapsed - elapsedPrevious);
      elapsedPrevious = elapsed;
      if (waitMs > 0) await page.waitForTimeout(waitMs);

      const href = await page.evaluate(() => {
        const normalize = (value: string) => String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const isGoToProductLabel = (value: string): boolean => {
          if (!value) return false;
          if (
            /(^| )ir para (o )?produto( |$)/.test(value)
            || /(^| )ir ao produto( |$)/.test(value)
            || /(^| )ver (o )?produto( |$)/.test(value)
            || /(^| )abrir (o )?produto( |$)/.test(value)
            || /(^| )ir al producto( |$)/.test(value)
            || /(^| )ver producto( |$)/.test(value)
            || /(^| )go to product( |$)/.test(value)
            || /(^| )view product( |$)/.test(value)
          ) {
            return true;
          }
          const hasProductWord = /(^| )(produto|producto|product)( |$)/.test(value);
          const hasActionVerb = /(^| )(ir|ver|abrir|acessar|comprar|go|view|open)( |$)/.test(value);
          return hasProductWord && hasActionVerb;
        };

        const hrefLooksLikeProduct = (href: string): boolean => (
          /produto\.mercadolivre\.com\.br/i.test(href)
          || /\/(p|up|item)\//i.test(href)
          || /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(href)
        );

        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const anchor of anchors) {
          const href = String(anchor.getAttribute("href") || "").trim();
          if (!href) continue;
          const text = normalize(String(anchor.textContent || ""));
          const className = String(anchor.getAttribute("class") || "").toLowerCase();
          const isActionLink = className.includes("poly-component__link--action-link")
            || className.includes("poly-action-links__action");
          const isGoToProduct = isGoToProductLabel(text) || (isActionLink && hrefLooksLikeProduct(href));
          if (!isGoToProduct) continue;
          return href;
        }
        return "";
      });

      const normalized = this.normalizeCandidateMercadoLivreUrl(this.decodeHtmlEntities(href), baseUrl);
      if (normalized && this.isLikelyProductUrl(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  private async resolveProductUrlByClickingGoToProduct(page: Page, baseUrl: string): Promise<string | null> {
    const hasCandidate = await page.evaluate(() => {
      const normalize = (value: string) => String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const isGoToProductLabel = (value: string): boolean => {
        if (!value) return false;
        if (
          /(^| )ir para (o )?produto( |$)/.test(value)
          || /(^| )ir ao produto( |$)/.test(value)
          || /(^| )ver (o )?produto( |$)/.test(value)
          || /(^| )abrir (o )?produto( |$)/.test(value)
          || /(^| )ir al producto( |$)/.test(value)
          || /(^| )ver producto( |$)/.test(value)
          || /(^| )go to product( |$)/.test(value)
          || /(^| )view product( |$)/.test(value)
        ) {
          return true;
        }
        const hasProductWord = /(^| )(produto|producto|product)( |$)/.test(value);
        const hasActionVerb = /(^| )(ir|ver|abrir|acessar|comprar|go|view|open)( |$)/.test(value);
        return hasProductWord && hasActionVerb;
      };

      const hrefLooksLikeProduct = (href: string): boolean => (
        /produto\.mercadolivre\.com\.br/i.test(href)
        || /\/(p|up|item)\//i.test(href)
        || /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(href)
      );

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        anchor.removeAttribute("data-codex-go-to-product");
      }

      for (const anchor of anchors) {
        const href = String(anchor.getAttribute("href") || "").trim();
        if (!href) continue;

        const text = normalize(String(anchor.textContent || ""));
        const className = String(anchor.getAttribute("class") || "").toLowerCase();
        const isActionLink = className.includes("poly-component__link--action-link")
          || className.includes("poly-action-links__action");

        if (isGoToProductLabel(text) || (isActionLink && hrefLooksLikeProduct(href))) {
          anchor.setAttribute("data-codex-go-to-product", "1");
          return true;
        }
      }

      return false;
    });
    if (!hasCandidate) return null;

    const goToProductLocator = page.locator("a[data-codex-go-to-product='1']").first();

    const directHref = this.decodeHtmlEntities(String(await goToProductLocator.getAttribute("href").catch(() => "") || "").trim());
    const normalizedHref = this.normalizeCandidateMercadoLivreUrl(directHref, baseUrl);
    if (normalizedHref && this.isLikelyProductUrl(normalizedHref)) {
      return normalizedHref;
    }

    const beforeClickUrl = this.normalizeCandidateMercadoLivreUrl(page.url(), baseUrl) || page.url();
    const popupPromise = page.waitForEvent("popup", { timeout: 6500 }).catch(() => null);
    const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 6500 }).catch(() => null);

    await goToProductLocator.scrollIntoViewIfNeeded().catch(() => undefined);
    await goToProductLocator.click({ timeout: 3000, force: true }).catch(() => undefined);
    await page.waitForTimeout(900);

    const afterClickUrl = this.normalizeCandidateMercadoLivreUrl(page.url(), baseUrl);
    if (afterClickUrl && afterClickUrl !== beforeClickUrl && this.isLikelyProductUrl(afterClickUrl)) {
      return afterClickUrl;
    }

    const popup = await popupPromise;
    if (popup) {
      try {
        await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
        const popupUrl = this.normalizeCandidateMercadoLivreUrl(popup.url(), baseUrl);
        if (popupUrl && this.isLikelyProductUrl(popupUrl)) {
          return popupUrl;
        }
      } finally {
        await popup.close().catch(() => undefined);
      }
    }

    await navPromise.catch(() => undefined);
    return null;
  }

  private async resolveProductUrlFromPageContent(page: Page, baseUrl: string): Promise<string | null> {
    const goToProductHref = await this.waitForGoToProductHref(page, baseUrl);
    if (goToProductHref) {
      return goToProductHref;
    }

    await page.waitForSelector(this.getDestinationHintSelectors().join(", "), { timeout: 8000 }).catch(() => undefined);

    const snapshot = await this.collectPageDestinationSnapshot(page);
    const snapshotBest = this.chooseBestDestinationUrl(snapshot, baseUrl);
    if (snapshotBest && this.isLikelyProductUrl(snapshotBest)) {
      return snapshotBest;
    }

    // Explicitly target anchors labeled "Ir para produto", independent of class changes.
    const labeledHref = await page.evaluate(() => {
      const normalize = (value: string) => value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const isGoToProductLabel = (value: string): boolean => {
        if (!value) return false;
        if (
          /(^| )ir para (o )?produto( |$)/.test(value)
          || /(^| )ir ao produto( |$)/.test(value)
          || /(^| )ver (o )?produto( |$)/.test(value)
          || /(^| )abrir (o )?produto( |$)/.test(value)
          || /(^| )ir al producto( |$)/.test(value)
          || /(^| )ver producto( |$)/.test(value)
          || /(^| )go to product( |$)/.test(value)
          || /(^| )view product( |$)/.test(value)
        ) {
          return true;
        }
        const hasProductWord = /(^| )(produto|producto|product)( |$)/.test(value);
        const hasActionVerb = /(^| )(ir|ver|abrir|acessar|comprar|go|view|open)( |$)/.test(value);
        return hasProductWord && hasActionVerb;
      };

      const hrefLooksLikeProduct = (href: string): boolean => (
        /produto\.mercadolivre\.com\.br/i.test(href)
        || /\/(ml[a-z]-|item\/|p\/)/i.test(href)
      );

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const href = String(anchor.getAttribute("href") || "").trim();
        if (!href) continue;

        const text = normalize(String(anchor.textContent || ""));
        const className = String(anchor.getAttribute("class") || "").toLowerCase();
        const isActionLink = className.includes("poly-component__link--action-link")
          || className.includes("poly-action-links__action");

        if (isGoToProductLabel(text) || (isActionLink && hrefLooksLikeProduct(href))) {
          return href;
        }
      }
      return "";
    });

    const normalizedLabeledHref = this.normalizeCandidateMercadoLivreUrl(
      this.decodeHtmlEntities(labeledHref),
      baseUrl,
    );
    if (normalizedLabeledHref && this.isLikelyProductUrl(normalizedLabeledHref)) {
      return normalizedLabeledHref;
    }

    return null;
  }

  private async resolveProductUrlByClickingAction(page: Page, baseUrl: string): Promise<string | null> {
    const goToProductByLabel = await this.resolveProductUrlByClickingGoToProduct(page, baseUrl);
    if (goToProductByLabel) {
      return goToProductByLabel;
    }

    for (const selector of this.getActionClickSelectors()) {
      try {
        const link = await page.$(selector);
        if (!link) continue;

        const hrefAttr = this.decodeHtmlEntities(String(await link.getAttribute("href") || "").trim());
        const hrefNormalized = this.normalizeCandidateMercadoLivreUrl(hrefAttr, baseUrl);
        if (hrefNormalized && this.isLikelyProductUrl(hrefNormalized)) {
          return hrefNormalized;
        }

        const beforeClickUrl = this.normalizeCandidateMercadoLivreUrl(page.url(), baseUrl) || page.url();
        const popupPromise = page
          .waitForEvent("popup", { timeout: 6000 })
          .catch(() => null);
        const navPromise = page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 6000 })
          .catch(() => null);

        await link.click({ timeout: 2500 }).catch(() => undefined);
        await page.waitForTimeout(900);

        const afterClickUrl = this.normalizeCandidateMercadoLivreUrl(page.url(), baseUrl);
        if (
          afterClickUrl
          && afterClickUrl !== beforeClickUrl
          && this.isLikelyProductUrl(afterClickUrl)
        ) {
          return afterClickUrl;
        }

        const popup = await popupPromise;
        if (popup) {
          try {
            await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
            const popupUrl = this.normalizeCandidateMercadoLivreUrl(popup.url(), baseUrl);
            if (popupUrl && this.isLikelyProductUrl(popupUrl)) {
              return popupUrl;
            }
          } finally {
            await popup.close().catch(() => undefined);
          }
        }

        await navPromise.catch(() => undefined);
      } catch {
        // Keep trying fallback action selectors.
      }
    }

    return null;
  }

  private prepareUrlForLinkbuilder(url: string): string {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return url;

    // Always remove fragments from candidate URLs before sending to Linkbuilder.
    parsed.hash = "";

    return parsed.toString();
  }

  private normalizeUrlForComparison(url: string): string {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return String(url || "").trim();
    parsed.hash = "";
    return parsed.toString();
  }

  private isLikelyAffiliateOutputUrl(candidateUrl: string, originalUrl: string): boolean {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(candidateUrl);
    if (!parsed) return false;

    const normalizedCandidate = this.normalizeUrlForComparison(parsed.toString());
    const normalizedOriginal = this.normalizeUrlForComparison(originalUrl);
    if (!normalizedCandidate || normalizedCandidate === normalizedOriginal) {
      return false;
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (this.isMercadoLivreShortHost(host)) return true;
    if (host === "s.mercadolivre.com.br" || host === "s.mercadolibre.com") return true;

    const path = parsed.pathname.toLowerCase();
    if (path.startsWith("/sec/")) return true;
    if (path.includes("/social/")) return true;

    const search = parsed.searchParams;
    if (
      search.has("ref")
      || search.has("matt_word")
      || search.has("matt_tool")
      || search.has("matt_event_ts")
      || search.has("matt_tracing_id")
      || search.has("tracking_id")
      || search.has("c_id")
      || search.has("c_uid")
    ) {
      return true;
    }

    // If it is still a Mercado Livre URL but no longer looks like a raw product URL,
    // it is likely the generated tracking/deeplink output.
    if (!this.isLikelyProductUrl(parsed.toString())) {
      return true;
    }

    return false;
  }

  private toCanonicalProductUrlForLinkbuilder(url: string): string {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return this.prepareUrlForLinkbuilder(url);

    parsed.hash = "";

    // Retry with canonical product path (without tracking query params). Some
    // linkbuilder renders accept only the clean product URL on second attempt.
    if (this.isLikelyProductUrl(parsed.toString())) {
      parsed.search = "";
    }

    return parsed.toString();
  }

  private async fillLinkbuilderInput(page: Page, inputUrl: string): Promise<boolean> {
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

    for (const selector of inputSelectors) {
      try {
        const el = await page.$(selector);
        if (!el) continue;
        await el.fill("");
        await el.fill(inputUrl);
        logger.debug({ selector }, "Filled linkbuilder input");
        return true;
      } catch {
        // Ignore selector lookup failure and try next selector.
      }
    }

    // Fallback: any visible textarea/input.
    try {
      const textareas = await page.$$("textarea:visible");
      if (textareas.length > 0) {
        await textareas[0].fill("");
        await textareas[0].fill(inputUrl);
        return true;
      }
    } catch {
      // Ignore fallback failure.
    }

    try {
      const inputs = await page.$$("input:visible");
      for (const input of inputs) {
        await input.fill("");
        await input.fill(inputUrl);
        return true;
      }
    } catch {
      // Ignore fallback failure.
    }

    return false;
  }

  private async triggerLinkbuilderGeneration(page: Page): Promise<void> {
    await page.waitForFunction(
      () => {
        const btn =
          document.querySelector("button.links-form__button")
          || document.querySelector(".andes-button--loud");
        return btn && !btn.hasAttribute("disabled");
      },
      { timeout: 6000 },
    ).catch(() => {
      // Non-fatal: proceed even if button stays disabled (might already be ready).
    });

    const buttonSelectors = [
      "button.links-form__button:not([disabled])",
      'button:has-text("Gerar")',
      'button:has-text("Gerar link")',
      'button[type="submit"]:not([disabled])',
      'button:has-text("Converter")',
      '[data-testid="generate-button"]',
    ];

    for (const sel of buttonSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        logger.debug({ selector: sel }, "Clicked generate button");
        return;
      } catch {
        // Ignore click selector failure and try next selector.
      }
    }

    // Last fallback.
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  /**
   * Strip `forceInApp` from a URL before opening in headless browser.
   * That parameter triggers a JS redirect to the meli:// native app deep link,
   * which causes ERR_UNKNOWN_URL_SCHEME in Playwright and prevents the product
   * content from rendering — even though the page works fine without it.
   */
  private stripForceInApp(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has("forceInApp")) {
        parsed.searchParams.delete("forceInApp");
        return parsed.toString();
      }
    } catch {
      // ignore
    }
    return url;
  }

  private decodeHtmlEntities(value: string): string {
    return String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&#38;/gi, "&")
      .replace(/&#x26;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#34;/gi, "\"")
      .replace(/&#x22;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'");
  }

  private extractLikelyProductUrlFromHtml(html: string, baseUrl: string): string | null {
    const rawHtml = String(html || "");
    if (!rawHtml) return null;

    const absoluteMatches = rawHtml.match(/https?:\/\/produto\.mercadolivre\.com\.br\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi) || [];
    for (const candidate of absoluteMatches) {
      const normalized = this.normalizeCandidateMercadoLivreUrl(this.decodeHtmlEntities(candidate), baseUrl);
      if (normalized && this.isLikelyProductUrl(normalized)) {
        return normalized;
      }
    }

    const hrefPattern = /href\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null = null;
    let fallback: string | null = null;
    let processed = 0;

    while ((match = hrefPattern.exec(rawHtml)) !== null) {
      processed += 1;
      if (processed > 600) break;

      const hrefRaw = this.decodeHtmlEntities(String(match[1] || "").trim());
      if (!hrefRaw) continue;

      const normalized = this.normalizeCandidateMercadoLivreUrl(hrefRaw, baseUrl);
      if (!normalized || !this.isLikelyProductUrl(normalized)) continue;

      const snippet = this.normalizeTextForMatch(rawHtml.slice(Math.max(0, match.index - 220), match.index + 220));
      const snippetHasGoToProductLabel = (
        /(?:^| )(?:ir para(?: o)?|ir ao|ver|abrir) (?:[a-z0-9]+ )?produto(?: |$)/.test(snippet)
        || snippet.includes("ir al producto")
        || snippet.includes("ver producto")
        || snippet.includes("go to product")
        || snippet.includes("view product")
      );
      if (
        snippetHasGoToProductLabel
        || snippet.includes("action-link")
        || snippet.includes("poly-component__title")
      ) {
        return normalized;
      }

      if (!fallback) fallback = normalized;
    }

    return fallback;
  }

  private async resolveLandingUrlViaHttp(url: string): Promise<string | null> {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed) return null;

    const cleanUrl = this.stripForceInApp(parsed.toString());
    try {
      const response = await fetch(cleanUrl, {
        method: "GET",
        redirect: "follow",
        headers: REDIRECT_FETCH_HEADERS,
        signal: AbortSignal.timeout(12000),
      });

      const finalUrl = this.normalizeCandidateMercadoLivreUrl(response.url || cleanUrl, cleanUrl) || cleanUrl;
      if (this.isLikelyProductUrl(finalUrl)) {
        return finalUrl;
      }

      const html = await response.text();
      const extracted = this.extractLikelyProductUrlFromHtml(html, finalUrl);
      if (extracted) {
        return extracted;
      }
    } catch (error) {
      logger.debug({ url: cleanUrl, error: String(error) }, "resolveLandingUrlViaHttp failed");
    }

    return null;
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
          headers: REDIRECT_FETCH_HEADERS,
          signal: AbortSignal.timeout(8000),
        });

        // Some edge/CDN routes reject HEAD. Fallback to GET with the same redirect guards.
        if (response.status === 403 || response.status === 405 || response.status === 501) {
          response = await fetch(current.toString(), {
            method: "GET",
            redirect: "manual",
            headers: REDIRECT_FETCH_HEADERS,
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
   * Fallback for short links that are blocked in raw HTTP redirect resolution
   * or need client-side redirects to reach the final Mercado Livre URL.
   *
   * If the short link resolves to a promozone/lapromotion page, we also try to
   * extract the real product URL from the page content here — avoiding a second
   * full browser load in resolvePromozone.
   */
  private async resolveShortLinkInBrowser(url: string, context: BrowserContext): Promise<string> {
    const parsed = this.parseAllowedMercadoLivreHttpUrl(url);
    if (!parsed || !this.isMercadoLivreShortHost(parsed.hostname)) return url;

    const tempPage = await context.newPage();
    try {
      await this.applyAntiBotPatches(tempPage);
      await tempPage.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css,mp4,mp3,webm,avi}", (route) => route.abort());
      await tempPage.route("**/analytics*", (route) => route.abort());
      await tempPage.route("**/beacon*", (route) => route.abort());

      // "commit" fires when the HTTP response is committed — after all server-side redirects
      // but BEFORE any HTML is parsed or JS runs. tempPage.url() at this point is guaranteed
      // to be the final HTTP URL, so we can safely strip forceInApp before JS has a chance to
      // redirect to meli:// (ERR_UNKNOWN_URL_SCHEME in headless Chrome).
      await tempPage.goto(parsed.toString(), { waitUntil: "commit", timeout: 30000 });

      const urlAfterCommit = tempPage.url();
      const urlAfterCommitParsed = this.parseAllowedMercadoLivreHttpUrl(urlAfterCommit);
      if (urlAfterCommitParsed) {
        const cleanUrl = this.stripForceInApp(urlAfterCommit);
        if (cleanUrl !== urlAfterCommit) {
          logger.debug({ shortUrl: parsed.toString(), original: urlAfterCommit, clean: cleanUrl }, "Short link resolved to forceInApp URL; reloading without it");
          try {
            await tempPage.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          } catch {
            // Keep going.
          }
        } else {
          await tempPage.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});
        }
      } else {
        await tempPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      }

      await tempPage.waitForTimeout(2000);

      const currentUrl = tempPage.url();
      const expanded = this.parseAllowedMercadoLivreHttpUrl(currentUrl);

      if (!expanded) {
        logger.warn({ shortUrl: parsed.toString(), currentUrl }, "Short link resolved to non-HTTP URL after all retries; returning original");
        return parsed.toString();
      }

      const expandedUrl = expanded.toString();

      // If we landed on a promozone/lapromotion page, attempt to pull the real
      // product URL directly from the page content while the page is still open.
      // This saves a second full browser navigation in resolvePromozone.
      if (this.isPromozoneUrl(expandedUrl)) {
        try {
          // Strict flow: click action first, then read href/content fallback.
          const productUrlFromClick = await this.resolveProductUrlByClickingAction(tempPage, expandedUrl);
          if (productUrlFromClick) {
            logger.debug(
              { shortUrl: parsed.toString(), expandedUrl, productUrl: productUrlFromClick },
              "Resolved product URL from short-link action click",
            );
            return productUrlFromClick;
          }

          const productUrlFromContent = await this.resolveProductUrlFromPageContent(tempPage, expandedUrl);
          if (productUrlFromContent) {
            logger.debug(
              { shortUrl: parsed.toString(), expandedUrl, productUrl: productUrlFromContent },
              "Resolved product URL from short-link page content",
            );
            return productUrlFromContent;
          }
        } catch (snapshotErr) {
          logger.debug({ error: String(snapshotErr) }, "Short-link promozone snapshot failed; falling back to promozone URL");
        }
      }

      logger.debug({ shortUrl: parsed.toString(), expandedUrl }, "Resolved short link with browser fallback");
      return expandedUrl;
    } catch (error) {
      logger.debug({ url: parsed.toString(), error: String(error) }, "Browser short-link resolution failed");
      return parsed.toString();
    } finally {
      await tempPage.close().catch((closeError) => {
        logger.debug({ error: String(closeError) }, "Failed to close temp short-link page");
      });
    }
  }

  /**
    * Open landing pages that may hide the product URL and resolve destination dynamically
    * based on rendered page content (CTA/title/canonical/meta).
   */
  private async resolvePromozone(url: string, context: BrowserContext): Promise<string> {
    const tempPage = await context.newPage();
    try {
      await this.applyAntiBotPatches(tempPage);
      await tempPage.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css,mp4,mp3,webm,avi}", (route) => route.abort());
      await tempPage.route("**/analytics*", (route) => route.abort());
      await tempPage.route("**/beacon*", (route) => route.abort());

      // "commit" fires after all server-side redirects, before any HTML parsing or JS execution.
      // This is the earliest reliable point where tempPage.url() reflects the final HTTP URL,
      // so we can strip forceInApp before JS has a chance to redirect to meli://.
      let openUrl = url;
      try {
        await tempPage.goto(openUrl, { waitUntil: "commit", timeout: 30000 });
      } catch (gotoErr) {
        logger.debug({ url: openUrl, error: String(gotoErr) }, "resolvePromozone: initial goto failed, retrying");
        try {
          await tempPage.goto(openUrl, { waitUntil: "commit", timeout: 20000 });
        } catch {
          // Will proceed with whatever state the page is in.
        }
      }

      const urlAfterCommit = tempPage.url();
      const cleanUrl = this.stripForceInApp(urlAfterCommit);
      if (cleanUrl !== urlAfterCommit && this.parseAllowedMercadoLivreHttpUrl(cleanUrl)) {
        openUrl = cleanUrl;
        logger.debug({ original: urlAfterCommit, clean: cleanUrl }, "resolvePromozone: stripped forceInApp; reloading clean URL");
        try {
          await tempPage.goto(openUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (retryErr) {
          logger.debug({ url: openUrl, error: String(retryErr) }, "resolvePromozone: clean-URL goto failed");
        }
      } else {
        await tempPage.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});
      }

      await tempPage.waitForTimeout(1800);

      // Safety net: if the page still drifted to a non-HTTP URL (any remaining
      // JS redirect we didn't catch), re-navigate to the last known clean URL.
      const urlAfterWait = tempPage.url();
      if (!this.parseAllowedMercadoLivreHttpUrl(urlAfterWait)) {
        logger.debug({ urlAfterWait, openUrl }, "resolvePromozone: page left HTTP domain after wait, re-navigating");
        try {
          await tempPage.goto(openUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await tempPage.waitForTimeout(1500);
        } catch {
          // Keep going with whatever content is available.
        }
      }

      // Strict flow: click action first, then read href/content fallback.
      const clickedUrl = await this.resolveProductUrlByClickingAction(tempPage, tempPage.url());
      if (clickedUrl) {
        logger.debug(
          { promozoneUrl: url, realUrl: clickedUrl },
          "Resolved promozone/social via action click",
        );
        return clickedUrl;
      }

      const snapshotBest = await this.resolveProductUrlFromPageContent(tempPage, tempPage.url());
      if (snapshotBest) {
        logger.debug(
          { promozoneUrl: url, realUrl: snapshotBest },
          "Resolved destination URL from page-content snapshot",
        );
        return snapshotBest;
      }

      logger.warn({ url }, "Could not resolve destination URL from promozone/social page — using original URL");
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
        if (val && this.isLikelyAffiliateOutputUrl(val, originalUrl)) return val;
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 1: aria-label result input (copy-to-share wording ML uses)
    try {
      const el = await page.$('[aria-label*="Copie o link"], [aria-label*="Link gerado"], [aria-label*="affiliate"], [aria-label*="resultado"]');
      if (el) {
        const val = await el.inputValue();
        if (val && this.isLikelyAffiliateOutputUrl(val, originalUrl)) return val;
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
          if (val && typeof val === "string" && this.isLikelyAffiliateOutputUrl(val, originalUrl)) return val;
        }
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 3: scan URLs from page markup and validate probable affiliate outputs.
    try {
      const content = await page.content();
      const matches = content.match(/https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{8,}/g) || [];
      for (const rawMatch of matches.slice(0, 500)) {
        const candidate = this.decodeHtmlEntities(String(rawMatch || "").trim());
        if (!candidate) continue;
        if (this.isLikelyAffiliateOutputUrl(candidate, originalUrl)) {
          return candidate;
        }
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    // Strategy 4: any readonly input/textarea that appeared after clicking "Gerar"
    try {
      const inputs = await page.$$("input[readonly], textarea[readonly]");
      for (const input of inputs) {
        const val = await input.inputValue();
        if (val && this.isLikelyAffiliateOutputUrl(val, originalUrl)) return val;
      }
    } catch {
      // Ignore this strategy failure and continue extraction cascade.
    }

    return null;
  }

  private async waitForAffiliateLink(page: Page, originalUrl: string): Promise<string | null> {
    const deadlinesMs = [2500, 4000, 5500, 7000, 8500, 10000, 12000, 14000, 17000, 20000];
    let lastElapsed = 0;

    for (const elapsed of deadlinesMs) {
      const waitMs = Math.max(0, elapsed - lastElapsed);
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }
      lastElapsed = elapsed;

      const link = await this.extractAffiliateLink(page, originalUrl);
      if (link) return link;
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
    let resolvedDestinationUrl = await this.resolveRedirect(productUrl);
    this.traceConversionStep("initial_redirect_resolution", {
      productUrl,
      resolvedDestinationUrl,
      sessionId,
    });

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
          "--disable-blink-features=AutomationControlled",
        ],
      });
      context = await browser.newContext({
        storageState: decryptedState,
        viewport: { width: 800, height: 600 },
        userAgent: BROWSER_LIKE_USER_AGENT,
        locale: "pt-BR",
      });

      const originalInputParsed = this.parseAllowedMercadoLivreHttpUrl(productUrl);
      const originalInputIsShortLink = Boolean(
        originalInputParsed && this.isMercadoLivreShortHost(originalInputParsed.hostname),
      );
      if (originalInputIsShortLink) {
        this.traceConversionStep("resolve_short_url_browser_start", { productUrl, sessionId });
        // Strict flow for short links: always open the ORIGINAL short URL in browser,
        // then click/resolve to product before any linkbuilder interaction.
        resolvedDestinationUrl = await this.resolveShortLinkInBrowser(productUrl, context);
        this.traceConversionStep("resolve_short_url_browser_done", {
          productUrl,
          resolvedDestinationUrl,
          sessionId,
        });
      } else {
        const shortParsed = this.parseAllowedMercadoLivreHttpUrl(resolvedDestinationUrl);
        if (shortParsed && this.isMercadoLivreShortHost(shortParsed.hostname)) {
          this.traceConversionStep("resolve_redirected_short_url_browser_start", {
            sourceUrl: resolvedDestinationUrl,
            sessionId,
          });
          resolvedDestinationUrl = await this.resolveShortLinkInBrowser(resolvedDestinationUrl, context);
          this.traceConversionStep("resolve_redirected_short_url_browser_done", {
            productUrl,
            resolvedDestinationUrl,
            sessionId,
          });
        }
      }

      // Step 1b: Dynamically resolve landing pages when input is not clearly a product URL.
      if (this.isPromozoneUrl(resolvedDestinationUrl) || !this.isLikelyProductUrl(resolvedDestinationUrl)) {
        this.traceConversionStep("resolve_landing_browser_start", {
          productUrl,
          currentUrl: resolvedDestinationUrl,
          sessionId,
        });
        resolvedDestinationUrl = await this.resolvePromozone(resolvedDestinationUrl, context);
        this.traceConversionStep("resolve_landing_browser_done", {
          productUrl,
          resolvedDestinationUrl,
          sessionId,
        });
      }

      // Step 1c: Last-resort HTTP parse of landing HTML. This catches short/social pages
      // where browser automation did not expose the "Ir para produto" anchor in time.
      if (!this.isLikelyProductUrl(resolvedDestinationUrl)) {
        this.traceConversionStep("resolve_http_fallback_start", {
          productUrl,
          currentUrl: resolvedDestinationUrl,
          sessionId,
        });
        const resolvedViaHttp = await this.resolveLandingUrlViaHttp(resolvedDestinationUrl);
        if (resolvedViaHttp) {
          resolvedDestinationUrl = resolvedViaHttp;
          this.traceConversionStep("resolve_http_fallback_done", {
            productUrl,
            resolvedDestinationUrl,
            sessionId,
          });
        }
      }

      if (!this.isLikelyProductUrl(resolvedDestinationUrl)) {
        this.traceConversionStep("resolution_failed_non_product_url", {
          productUrl,
          resolvedDestinationUrl,
          sessionId,
        });
        return {
          success: false,
          originalUrl: productUrl,
          resolvedUrl: resolvedDestinationUrl,
          error: "Nao foi possivel resolver o link informado para o link real do produto antes da conversao.",
        };
      }

      resolvedDestinationUrl = this.normalizeCandidateMercadoLivreUrl(
        resolvedDestinationUrl,
        resolvedDestinationUrl,
      ) || resolvedDestinationUrl;
      const canonicalResolvedDestinationUrl = this.toCanonicalMercadoLivreProductUrl(resolvedDestinationUrl);
      if (!canonicalResolvedDestinationUrl || !this.isStrictMercadoLivreProductUrl(canonicalResolvedDestinationUrl)) {
        this.traceConversionStep("resolution_failed_non_canonical_product_url", {
          productUrl,
          resolvedDestinationUrl,
          sessionId,
        });
        return {
          success: false,
          originalUrl: productUrl,
          resolvedUrl: resolvedDestinationUrl,
          error: "Nao foi possivel resolver o link informado para a pagina real do produto (produto.mercadolivre.../MLB-...).",
        };
      }
      resolvedDestinationUrl = canonicalResolvedDestinationUrl;
      const linkbuilderInputUrl = this.prepareUrlForLinkbuilder(resolvedDestinationUrl);
      this.traceConversionStep("linkbuilder_start", {
        productUrl,
        resolvedDestinationUrl,
        linkbuilderInputUrl,
        sessionId,
      });

      logger.debug(
        { originalUrl: productUrl, resolvedDestinationUrl, linkbuilderInputUrl, sessionId },
        "Starting conversion",
      );

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
      const inputFilled = await this.fillLinkbuilderInput(page, linkbuilderInputUrl);

      if (!inputFilled) {
        return {
          success: false,
          originalUrl: productUrl,
          error: `Não foi possível encontrar o campo de URL na página do linkbuilder (URL atual: ${page.url()}).`,
        };
      }

      await page.waitForTimeout(200 + Math.floor(Math.random() * 200));
      await this.triggerLinkbuilderGeneration(page);
      this.traceConversionStep("linkbuilder_generation_triggered", { linkbuilderInputUrl, sessionId });

      // Wait/poll for result to appear. Some ML pages take longer when the
      // input URL comes from social/short-link flows and needs server-side resolve.
      let affiliateLink = await this.waitForAffiliateLink(page, linkbuilderInputUrl);

      // Retry with canonical product URL (without tracking query params) when the
      // first generation did not expose any affiliate output.
      const canonicalRetryInput = this.toCanonicalProductUrlForLinkbuilder(resolvedDestinationUrl);
      if (!affiliateLink && canonicalRetryInput && canonicalRetryInput !== linkbuilderInputUrl) {
        logger.debug(
          { linkbuilderInputUrl, canonicalRetryInput },
          "Affiliate link not found on first pass; retrying with canonical product URL",
        );

        const retryFilled = await this.fillLinkbuilderInput(page, canonicalRetryInput);
        if (retryFilled) {
          this.traceConversionStep("linkbuilder_canonical_retry_start", {
            canonicalRetryInput,
            sessionId,
          });
          await page.waitForTimeout(220 + Math.floor(Math.random() * 240));
          await this.triggerLinkbuilderGeneration(page);
          affiliateLink = await this.waitForAffiliateLink(page, canonicalRetryInput);
        }
      }

      if (!affiliateLink) {
        this.traceConversionStep("affiliate_not_found_after_attempts", {
          productUrl,
          resolvedDestinationUrl,
          linkbuilderInputUrl,
          canonicalRetryInput,
          pageUrl: page.url(),
          sessionId,
        });
        return {
          success: false,
          originalUrl: productUrl,
          resolvedUrl: resolvedDestinationUrl,
          error: "Link afiliado nao encontrado na resposta do linkbuilder. Verifique se sua conta tem acesso ao programa de afiliados.",
        };
      }

      const conversionTimeMs = Date.now() - startTime;
      this.traceConversionStep("conversion_success", {
        productUrl,
        resolvedDestinationUrl,
        affiliateLink,
        conversionTimeMs,
        sessionId,
      });
      logger.info({ productUrl, affiliateLink, conversionTimeMs, sessionId }, "Conversion successful");

      return {
        success: true,
        originalUrl: productUrl,
        resolvedUrl: resolvedDestinationUrl,
        affiliateLink,
        conversionTimeMs,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.traceConversionStep("conversion_exception", {
        productUrl,
        resolvedDestinationUrl,
        sessionId,
        error: message,
      });
      logger.error({ productUrl, sessionId, error: message }, "Conversion error");
      return { success: false, originalUrl: productUrl, resolvedUrl: resolvedDestinationUrl, error: message };
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
  async convertLink(productUrl: string, sessionId: string, options?: ConvertLinkOptions): Promise<ConversionResult> {
    const forceResolve = options?.forceResolve === true;
    const cacheKey = `${sessionId}::${productUrl}`;
    const cached = forceResolve ? null : this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const cachedResolvedUrl = this.toCanonicalMercadoLivreProductUrl(
        String(cached.resolvedUrl || "").trim(),
      );
      const fallbackResolvedUrl = this.toCanonicalMercadoLivreProductUrl(productUrl);
      const effectiveResolvedUrl = [cachedResolvedUrl, fallbackResolvedUrl]
        .find((candidate) => candidate && this.isStrictMercadoLivreProductUrl(candidate)) || null;

      if (effectiveResolvedUrl) {
        return {
          success: true,
          originalUrl: productUrl,
          resolvedUrl: effectiveResolvedUrl,
          affiliateLink: cached.affiliateLink,
          cached: true,
        };
      }

      // Legacy cache entries (or stale corrupted cache) may miss the resolved
      // product URL. Drop them so the full resolver pipeline recomputes safely.
      this.cache.delete(cacheKey);
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
        const normalizedResolvedUrl = this.toCanonicalMercadoLivreProductUrl(
          String(result.resolvedUrl || result.originalUrl || productUrl),
        );
        this.cache.set(cacheKey, {
          affiliateLink: result.affiliateLink,
          resolvedUrl: normalizedResolvedUrl && this.isStrictMercadoLivreProductUrl(normalizedResolvedUrl)
            ? normalizedResolvedUrl
            : undefined,
          timestamp: Date.now(),
        });
      } else {
        this.registerScopeFailure(scopeId, result.error);
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
    const lastFailureAgeSecondsByScope = Object.fromEntries(
      [...this.lastFailureAtByScope.entries()]
        .map(([scopeId, at]) => [scopeId, Math.max(0, Math.floor((now - at) / 1000))]),
    );
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
      cooldownMaxFailures: MAX_FAILURES_BEFORE_COOLDOWN,
      cooldownMs: COOLDOWN_MS,
      cooldownFailureWindowMs: this.failureStreakWindowMs,
      pendingTotal,
      pendingByScope,
      nextDispatchInMs: Math.max(0, this.nextDispatchAt - Date.now()),
      cooldownActive,
      consecutiveFailures,
      activeCooldownByScope,
      consecutiveFailuresByScope,
      lastFailureAgeSecondsByScope,
    };
  }
}

export const converter = MercadoLivreLinkConverter.getInstance();
