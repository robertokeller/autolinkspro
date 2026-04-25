import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import pg from "pg";
import { pool } from "./db.js";
import { requireAuth } from "./auth.js";
import { encryptCredential, decryptCredential } from "./credential-cipher.js";
import { cache, buildCacheKey, bustTableCache, getTtlForTable, isCacheable, cacheHit, cacheMiss } from "./cache.js";

// Columns that must be encrypted at rest per table
const ENCRYPTED_COLUMNS: Record<string, Set<string>> = {
  api_credentials: new Set(["secret_key"]),
};

// Columns that should NEVER be returned to the client — always masked in SELECT responses
const SENSITIVE_MASKED_COLUMNS: Record<string, Set<string>> = {
  api_credentials: new Set(["secret_key"]),
};

// Table-specific enum constraints validated before hitting the DB for clean error messages
const TABLE_ENUM_CONSTRAINTS: Record<string, Record<string, readonly string[]>> = {
  templates: {
    scope:    ["shopee", "meli", "amazon", "message"],
    category: ["oferta", "cupom", "geral"],
  },
};

// Per-table fields that must be present (non-empty) on INSERT
const TABLE_REQUIRED_INSERT_FIELDS: Record<string, readonly string[]> = {
  templates: ["name", "content"],
};

// Per-table string field max-length limits
const TABLE_FIELD_MAX_LENGTHS: Record<string, Record<string, number>> = {
  templates: { name: 100, content: 4000 },
};

const PLAN_SYNC_ERROR_MESSAGE = "Plano nao configurado para esta conta.";
const PLAN_EXPIRED_MESSAGE = "Plano expirado. Renove ou troque de plano para continuar usando este recurso.";
const SHOPEE_AUTOMATIONS_BLOCKED_MESSAGE = "Automacoes Shopee nao estao disponiveis no seu plano ou nivel de acesso.";
const TEMPLATES_BLOCKED_MESSAGE = "Templates nao estao disponiveis no seu plano ou nivel de acesso.";
const ROUTES_BLOCKED_MESSAGE = "Rotas nao estao disponiveis no seu plano ou nivel de acesso.";
const SCHEDULES_BLOCKED_MESSAGE = "Agendamentos nao estao disponiveis no seu plano ou nivel de acesso.";
const LINK_HUB_BLOCKED_MESSAGE = "Link Hub nao esta disponivel no seu plano ou nivel de acesso.";

type RestFeatureKey = "shopeeAutomations" | "templates" | "routes" | "schedules" | "linkHub";
type TemplateScope = "shopee" | "meli" | "amazon" | "message";
type AutomationMarketplace = "shopee" | "meli" | "amazon";

type RestPlanLimits = {
  automations: number;
  groupsPerAutomation: number;
  routes: number;
  groupsPerRoute: number;
  schedules: number;
  templates: number;
  linkHub: boolean;
};

type RestFeatureAccess = {
  enabled: boolean;
  blockedMessage: string;
};

type RestUserPlanState = {
  expired: boolean;
  limits: RestPlanLimits;
  featureAccess: Record<RestFeatureKey, RestFeatureAccess>;
};

const BUILTIN_PLAN_LIMITS: Record<string, RestPlanLimits> = {
  "plan-starter": { automations: -1, groupsPerAutomation: -1, routes: -1, groupsPerRoute: -1, schedules: -1, templates: -1, linkHub: true },
  "plan-start": { automations: 2, groupsPerAutomation: 6, routes: 2, groupsPerRoute: 6, schedules: -1, templates: 3, linkHub: true },
  "plan-pro": { automations: 5, groupsPerAutomation: 25, routes: 10, groupsPerRoute: 50, schedules: -1, templates: 10, linkHub: true },
  "plan-business": { automations: -1, groupsPerAutomation: -1, routes: -1, groupsPerRoute: -1, schedules: -1, templates: -1, linkHub: true },
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const normalized = String(item ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toSafeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function applyNumericLimit(baseValue: number, overrideValue: unknown): number {
  const parsedOverride = Number(overrideValue);
  if (!Number.isFinite(parsedOverride)) return baseValue;
  if (baseValue === -1) return Math.trunc(parsedOverride);
  if (parsedOverride === -1) return baseValue;
  return Math.min(baseValue, Math.trunc(parsedOverride));
}

function normalizeFeatureMode(value: unknown): "enabled" | "hidden" | "blocked" | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "enabled" || normalized === "hidden" || normalized === "blocked") {
    return normalized;
  }
  return null;
}

function normalizeTemplateScope(value: unknown): TemplateScope {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "message") return "message";
  if (normalized === "meli") return "meli";
  if (normalized === "amazon") return "amazon";
  return "shopee";
}

function extractTemplateScopeFromTags(tags: unknown): TemplateScope | null {
  const values = toStringArray(tags);
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (!normalized.startsWith("scope:")) continue;
    return normalizeTemplateScope(normalized.slice("scope:".length));
  }
  return null;
}

function inferTemplateScopeFromRow(row: Record<string, unknown> | null | undefined): TemplateScope {
  if (!row) return "shopee";
  const fromTags = extractTemplateScopeFromTags(row.tags);
  if (fromTags) return fromTags;
  return normalizeTemplateScope(row.scope);
}

function inferAutomationMarketplace(row: Record<string, unknown> | null | undefined): AutomationMarketplace {
  const config = row?.config && typeof row.config === "object" && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : {};
  const marketplace = String(config.marketplace || "").trim().toLowerCase();
  if (marketplace === "meli") return "meli";
  if (marketplace === "amazon") return "amazon";
  return "shopee";
}

function readAutomationDeliverySessionId(row: Record<string, unknown> | null | undefined): string {
  if (!row) return "";
  const config = row.config && typeof row.config === "object" && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : {};
  const configSessionId = String(config.deliverySessionId || "").trim();
  if (configSessionId) return configSessionId;
  return String(row.session_id || "").trim();
}

function getTemplateScopeLabel(scope: TemplateScope): string {
  if (scope === "message") return "Modelos de Mensagem";
  if (scope === "amazon") return "Amazon";
  if (scope === "meli") return "Mercado Livre";
  return "Shopee";
}

async function loadControlPlane(client: import("pg").PoolClient): Promise<Record<string, unknown>> {
  const result = await client.query<{ value?: unknown }>(
    "SELECT value FROM system_settings WHERE key = 'admin_config' LIMIT 1",
  );
  const row = result.rows[0];
  return row?.value && typeof row.value === "object" && !Array.isArray(row.value)
    ? row.value as Record<string, unknown>
    : {};
}

function resolveBasePlanLimits(planId: string, planRow: Record<string, unknown> | null): RestPlanLimits {
  const fallback = BUILTIN_PLAN_LIMITS[planId] || BUILTIN_PLAN_LIMITS["plan-starter"];
  const rawLimits = planRow?.limits && typeof planRow.limits === "object" && !Array.isArray(planRow.limits)
    ? planRow.limits as Record<string, unknown>
    : {};
  return {
    automations: toSafeInt(rawLimits.automations, fallback.automations),
    groupsPerAutomation: toSafeInt(rawLimits.groupsPerAutomation, fallback.groupsPerAutomation),
    routes: toSafeInt(rawLimits.routes, fallback.routes),
    groupsPerRoute: toSafeInt(rawLimits.groupsPerRoute, fallback.groupsPerRoute),
    schedules: toSafeInt(rawLimits.schedules, fallback.schedules),
    templates: toSafeInt(rawLimits.templates, fallback.templates),
    linkHub: Boolean(rawLimits.linkHub ?? fallback.linkHub),
  };
}

function resolveFeatureAccessRule(
  accessLevel: Record<string, unknown> | null,
  featureKey: RestFeatureKey,
  fallbackAvailability: number | boolean,
  fallbackMessage: string,
): RestFeatureAccess {
  const featureRules = accessLevel?.featureRules && typeof accessLevel.featureRules === "object" && !Array.isArray(accessLevel.featureRules)
    ? accessLevel.featureRules as Record<string, unknown>
    : null;
  const featureRule = featureRules?.[featureKey] && typeof featureRules[featureKey] === "object" && !Array.isArray(featureRules[featureKey])
    ? featureRules[featureKey] as Record<string, unknown>
    : null;
  const mode = normalizeFeatureMode(featureRule?.mode);
  const blockedMessage = String(featureRule?.blockedMessage || "").trim() || fallbackMessage;

  if (mode === "enabled") return { enabled: true, blockedMessage: "" };
  if (mode === "hidden" || mode === "blocked") return { enabled: false, blockedMessage };

  const fallbackEnabled = typeof fallbackAvailability === "boolean"
    ? fallbackAvailability
    : (fallbackAvailability === -1 || fallbackAvailability > 0);

  return {
    enabled: fallbackEnabled,
    blockedMessage: fallbackMessage,
  };
}

async function resolveUserPlanState(client: import("pg").PoolClient, userId: string): Promise<RestUserPlanState> {
  const profileResult = await client.query<{ plan_id: string | null; plan_expires_at: string | null }>(
    "SELECT plan_id, plan_expires_at FROM profiles WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  const profile = profileResult.rows[0];
  const planId = String(profile?.plan_id || "").trim();
  if (!planId) {
    throw new Error(PLAN_SYNC_ERROR_MESSAGE);
  }

  const planExpiresAt = String(profile?.plan_expires_at || "").trim();
  const expired = Boolean(planExpiresAt) && Number.isFinite(Date.parse(planExpiresAt)) && Date.parse(planExpiresAt) <= Date.now();

  const controlPlane = await loadControlPlane(client);
  const plans = Array.isArray(controlPlane.plans) ? controlPlane.plans : [];
  const accessLevels = Array.isArray(controlPlane.accessLevels) ? controlPlane.accessLevels : [];
  const plan = (plans.find((entry) => String((entry as { id?: unknown })?.id || "").trim() === planId) || null) as Record<string, unknown> | null;

  const baseLimits = resolveBasePlanLimits(planId, plan);
  const accessLevelId = String(plan?.accessLevelId || "").trim();
  const accessLevel = accessLevelId
    ? (accessLevels.find((entry) => String((entry as { id?: unknown })?.id || "").trim() === accessLevelId) || null) as Record<string, unknown> | null
    : null;
  const limitOverrides = accessLevel?.limitOverrides && typeof accessLevel.limitOverrides === "object" && !Array.isArray(accessLevel.limitOverrides)
    ? accessLevel.limitOverrides as Record<string, unknown>
    : {};

  return {
    expired,
    limits: {
      automations: applyNumericLimit(baseLimits.automations, limitOverrides.automations),
      groupsPerAutomation: applyNumericLimit(baseLimits.groupsPerAutomation, limitOverrides.groupsPerAutomation),
      routes: applyNumericLimit(baseLimits.routes, limitOverrides.routes),
      groupsPerRoute: applyNumericLimit(baseLimits.groupsPerRoute, limitOverrides.groupsPerRoute),
      schedules: applyNumericLimit(baseLimits.schedules, limitOverrides.schedules),
      templates: baseLimits.templates,
      linkHub: baseLimits.linkHub,
    },
    featureAccess: {
      shopeeAutomations: resolveFeatureAccessRule(accessLevel, "shopeeAutomations", baseLimits.automations, SHOPEE_AUTOMATIONS_BLOCKED_MESSAGE),
      templates: resolveFeatureAccessRule(accessLevel, "templates", baseLimits.templates, TEMPLATES_BLOCKED_MESSAGE),
      routes: resolveFeatureAccessRule(accessLevel, "routes", baseLimits.routes, ROUTES_BLOCKED_MESSAGE),
      schedules: resolveFeatureAccessRule(accessLevel, "schedules", baseLimits.schedules, SCHEDULES_BLOCKED_MESSAGE),
      linkHub: resolveFeatureAccessRule(accessLevel, "linkHub", baseLimits.linkHub, LINK_HUB_BLOCKED_MESSAGE),
    },
  };
}

function buildGroupLimitError(limit: number, usedWithoutCurrent: number, nextSelected: number): string {
  return `Limite de grupos atingido. Seu plano permite ${limit} grupo(s) no total entre todas as automacoes. Voce ja usa ${usedWithoutCurrent} e tentou configurar ${nextSelected}.`;
}

function buildRouteGroupLimitError(limit: number, usedWithoutCurrent: number, nextSelected: number): string {
  return `Limite de grupos atingido. Seu plano permite ${limit} grupo(s) no total entre todas as rotas. Voce ja usa ${usedWithoutCurrent} e tentou configurar ${nextSelected}.`;
}

async function validateShopeeAutomationRelations(
  client: import("pg").PoolClient,
  userId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const destinationGroupIds = toStringArray(row.destination_group_ids);
  const masterGroupIds = toStringArray(row.master_group_ids);
  const sessionId = readAutomationDeliverySessionId(row);
  const templateId = String(row.template_id || "").trim();

  if (destinationGroupIds.length === 0 && masterGroupIds.length === 0) {
    throw new Error("Escolha pelo menos um grupo de destino.");
  }

  if ((destinationGroupIds.length > 0 || masterGroupIds.length > 0) && !sessionId) {
    throw new Error("Selecione uma sessao de envio valida.");
  }

  let sessionPlatform = "";
  if (sessionId) {
    const [waSession, tgSession] = await Promise.all([
      client.query<{ id: string }>(
        "SELECT id FROM whatsapp_sessions WHERE user_id = $1 AND id::text = $2 LIMIT 1",
        [userId, sessionId],
      ),
      client.query<{ id: string }>(
        "SELECT id FROM telegram_sessions WHERE user_id = $1 AND id::text = $2 LIMIT 1",
        [userId, sessionId],
      ),
    ]);

    if ((waSession.rowCount ?? 0) > 0) sessionPlatform = "whatsapp";
    else if ((tgSession.rowCount ?? 0) > 0) sessionPlatform = "telegram";
    else throw new Error("Sessao de envio invalida para esta conta.");
  }

  if (destinationGroupIds.length > 0) {
    const destinationGroups = await client.query<{ id: string; platform: string; session_id: string | null }>(
      `SELECT id, platform, session_id
         FROM groups
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND id::text = ANY($2::text[])`,
      [userId, destinationGroupIds],
    );

    if ((destinationGroups.rowCount ?? 0) !== destinationGroupIds.length) {
      throw new Error("Um ou mais grupos de destino sao invalidos para esta conta.");
    }

    if (sessionId) {
      const hasMismatch = destinationGroups.rows.some((group) => {
        const groupPlatform = String(group.platform || "").trim();
        const groupSessionId = String(group.session_id || "").trim();
        return groupPlatform !== sessionPlatform || groupSessionId !== sessionId;
      });
      if (hasMismatch) {
        throw new Error("Os grupos selecionados nao pertencem a sessao de envio informada.");
      }
    }
  }

  if (masterGroupIds.length > 0) {
    const masterGroups = await client.query<{ id: string }>(
      `SELECT id
         FROM master_groups
        WHERE user_id = $1
          AND id::text = ANY($2::text[])`,
      [userId, masterGroupIds],
    );

    if ((masterGroups.rowCount ?? 0) !== masterGroupIds.length) {
      throw new Error("Um ou mais grupos-mestre sao invalidos para esta conta.");
    }

    const linkedGroups = await client.query<{ platform: string; session_id: string | null }>(
      `SELECT g.platform, g.session_id
         FROM master_group_links l
         JOIN master_groups mg
           ON mg.id = l.master_group_id
         JOIN groups g
           ON g.id = l.group_id
        WHERE mg.user_id = $1
          AND l.is_active <> FALSE
          AND g.deleted_at IS NULL
          AND l.master_group_id::text = ANY($2::text[])`,
      [userId, masterGroupIds],
    );

    if (sessionId && (linkedGroups.rowCount ?? 0) === 0) {
      throw new Error("Os grupos-mestre selecionados nao possuem grupos ativos na sessao informada.");
    }

    if (sessionId) {
      const hasMismatch = linkedGroups.rows.some((group) => {
        const groupPlatform = String(group.platform || "").trim();
        const groupSessionId = String(group.session_id || "").trim();
        return groupPlatform !== sessionPlatform || groupSessionId !== sessionId;
      });
      if (hasMismatch) {
        throw new Error("Os grupos-mestre selecionados nao pertencem a sessao de envio informada.");
      }
    }
  }

  if (templateId) {
    const templateResult = await client.query<{ id: string; scope: string | null; tags: unknown }>(
      "SELECT id, scope, tags FROM templates WHERE user_id = $1 AND id::text = $2 LIMIT 1",
      [userId, templateId],
    );
    const templateRow = templateResult.rows[0] as Record<string, unknown> | undefined;
    if (!templateRow) {
      throw new Error("O modelo selecionado e invalido para esta conta.");
    }
    const templateScope = inferTemplateScopeFromRow(templateRow);
    if (templateScope !== "shopee" && templateScope !== "message") {
      throw new Error("O modelo selecionado nao pertence ao escopo permitido para automacao Shopee.");
    }
  }
}

async function assertShopeeAutomationMutationAllowed(
  client: import("pg").PoolClient,
  userId: string,
  row: Record<string, unknown>,
  planState: RestUserPlanState,
  existingRow?: Record<string, unknown> | null,
): Promise<void> {
  if (planState.expired) throw new Error(PLAN_EXPIRED_MESSAGE);

  const featureAccess = planState.featureAccess.shopeeAutomations;
  if (!featureAccess.enabled) {
    throw new Error(featureAccess.blockedMessage || SHOPEE_AUTOMATIONS_BLOCKED_MESSAGE);
  }

  const automationsLimit = planState.limits.automations;
  if (!existingRow && automationsLimit !== -1) {
    const countResult = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM shopee_automations
        WHERE user_id = $1
          AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'shopee'`,
      [userId],
    );
    const currentTotal = toSafeInt(countResult.rows[0]?.total, 0);
    if (currentTotal >= automationsLimit) {
      throw new Error("Limite de automacoes Shopee atingido para o seu nivel de acesso.");
    }
  }

  const groupsPerAutomationLimit = planState.limits.groupsPerAutomation;
  if (groupsPerAutomationLimit !== -1) {
    const slotResult = await client.query<{ total: number }>(
      `SELECT COALESCE(SUM(COALESCE(array_length(destination_group_ids, 1), 0) + COALESCE(array_length(master_group_ids, 1), 0)), 0)::int AS total
         FROM shopee_automations
        WHERE user_id = $1`,
      [userId],
    );
    const currentTotalSlots = toSafeInt(slotResult.rows[0]?.total, 0);
    const existingSlots = existingRow
      ? toStringArray(existingRow.destination_group_ids).length + toStringArray(existingRow.master_group_ids).length
      : 0;
    const nextSlots = toStringArray(row.destination_group_ids).length + toStringArray(row.master_group_ids).length;
    const usedWithoutCurrent = Math.max(0, currentTotalSlots - existingSlots);
    if (usedWithoutCurrent + nextSlots > groupsPerAutomationLimit) {
      throw new Error(buildGroupLimitError(groupsPerAutomationLimit, usedWithoutCurrent, nextSlots));
    }
  }

  await validateShopeeAutomationRelations(client, userId, row);
}

async function assertTemplateMutationAllowed(
  client: import("pg").PoolClient,
  userId: string,
  row: Record<string, unknown>,
  planState: RestUserPlanState,
  existingRow?: Record<string, unknown> | null,
): Promise<void> {
  if (planState.expired) throw new Error(PLAN_EXPIRED_MESSAGE);

  const featureAccess = planState.featureAccess.templates;
  if (!featureAccess.enabled) {
    throw new Error(featureAccess.blockedMessage || TEMPLATES_BLOCKED_MESSAGE);
  }

  const templateLimit = planState.limits.templates;
  if (!existingRow && templateLimit !== -1) {
    const scope = inferTemplateScopeFromRow(row);
    const existingTemplates = await client.query<{ scope: string | null; tags: unknown }>(
      "SELECT scope, tags FROM templates WHERE user_id = $1",
      [userId],
    );
    const countInScope = existingTemplates.rows.filter((templateRow) => (
      inferTemplateScopeFromRow(templateRow as unknown as Record<string, unknown>) === scope
    )).length;
    if (countInScope >= templateLimit) {
      throw new Error(`Limite de templates ${getTemplateScopeLabel(scope)} atingido para o seu nivel de acesso.`);
    }
  }
}

async function assertRouteMutationAllowed(
  client: import("pg").PoolClient,
  userId: string,
  planState: RestUserPlanState,
  existingRow?: Record<string, unknown> | null,
): Promise<void> {
  if (planState.expired) throw new Error(PLAN_EXPIRED_MESSAGE);

  const featureAccess = planState.featureAccess.routes;
  if (!featureAccess.enabled) {
    throw new Error(featureAccess.blockedMessage || ROUTES_BLOCKED_MESSAGE);
  }

  const routeLimit = planState.limits.routes;
  if (!existingRow && routeLimit !== -1) {
    const countResult = await client.query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM routes WHERE user_id = $1",
      [userId],
    );
    const currentTotal = toSafeInt(countResult.rows[0]?.total, 0);
    if (currentTotal >= routeLimit) {
      throw new Error("Limite de rotas atingido para o seu nivel de acesso.");
    }
  }
}

async function assertRouteDestinationMutationAllowed(
  client: import("pg").PoolClient,
  userId: string,
  planState: RestUserPlanState,
  existingRow?: Record<string, unknown> | null,
): Promise<void> {
  if (planState.expired) throw new Error(PLAN_EXPIRED_MESSAGE);

  const featureAccess = planState.featureAccess.routes;
  if (!featureAccess.enabled) {
    throw new Error(featureAccess.blockedMessage || ROUTES_BLOCKED_MESSAGE);
  }

  const groupsPerRouteLimit = planState.limits.groupsPerRoute;
  if (groupsPerRouteLimit !== -1) {
    const slotResult = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM route_destinations rd
         JOIN routes r ON r.id = rd.route_id
        WHERE r.user_id = $1`,
      [userId],
    );
    const currentTotalSlots = toSafeInt(slotResult.rows[0]?.total, 0);
    const existingSlots = existingRow ? 1 : 0;
    const nextSlots = 1;
    const usedWithoutCurrent = Math.max(0, currentTotalSlots - existingSlots);
    if (usedWithoutCurrent + nextSlots > groupsPerRouteLimit) {
      throw new Error(buildRouteGroupLimitError(groupsPerRouteLimit, usedWithoutCurrent, nextSlots));
    }
  }
}

async function assertScheduleMutationAllowed(
  client: import("pg").PoolClient,
  userId: string,
  planState: RestUserPlanState,
  existingRow?: Record<string, unknown> | null,
): Promise<void> {
  if (planState.expired) throw new Error(PLAN_EXPIRED_MESSAGE);

  const featureAccess = planState.featureAccess.schedules;
  if (!featureAccess.enabled) {
    throw new Error(featureAccess.blockedMessage || SCHEDULES_BLOCKED_MESSAGE);
  }

  const schedulesLimit = planState.limits.schedules;
  if (!existingRow && schedulesLimit !== -1) {
    const countResult = await client.query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM scheduled_posts WHERE user_id = $1",
      [userId],
    );
    const currentTotal = toSafeInt(countResult.rows[0]?.total, 0);
    if (currentTotal >= schedulesLimit) {
      throw new Error("Limite de agendamentos atingido para o seu nivel de acesso.");
    }
  }
}

function getMutationAccessError(planState: RestUserPlanState, featureKey: RestFeatureKey): string | null {
  if (planState.expired) return PLAN_EXPIRED_MESSAGE;
  const featureAccess = planState.featureAccess[featureKey];
  if (!featureAccess.enabled) {
    if (featureKey === "templates") return featureAccess.blockedMessage || TEMPLATES_BLOCKED_MESSAGE;
    if (featureKey === "routes") return featureAccess.blockedMessage || ROUTES_BLOCKED_MESSAGE;
    if (featureKey === "schedules") return featureAccess.blockedMessage || SCHEDULES_BLOCKED_MESSAGE;
    if (featureKey === "linkHub") return featureAccess.blockedMessage || LINK_HUB_BLOCKED_MESSAGE;
    return featureAccess.blockedMessage || SHOPEE_AUTOMATIONS_BLOCKED_MESSAGE;
  }
  return null;
}

function touchesShopeeAutomationRelations(row: Record<string, unknown>): boolean {
  return ["destination_group_ids", "master_group_ids", "template_id", "config", "session_id"].some((key) => (
    Object.prototype.hasOwnProperty.call(row, key)
  ));
}

function validateRowEnums(table: string, row: Record<string, unknown>): string | null {
  const constraints = TABLE_ENUM_CONSTRAINTS[table];
  if (!constraints) return null;
  for (const [col, allowed] of Object.entries(constraints)) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) continue;
    const val = row[col];
    if (val === null || val === undefined) continue;
    if (!allowed.includes(String(val))) {
      return `Valor inválido para ${col}: "${val}". Permitidos: ${allowed.join(", ")}`;
    }
  }
  return null;
}

function validateRowFields(
  table: string,
  row: Record<string, unknown>,
  isInsert: boolean,
): string | null {
  // Required fields on INSERT
  if (isInsert) {
    for (const field of (TABLE_REQUIRED_INSERT_FIELDS[table] ?? [])) {
      if (!String(row[field] ?? "").trim()) return `${field} é obrigatório`;
    }
  }
  // Max-length for all present string fields
  const maxLengths = TABLE_FIELD_MAX_LENGTHS[table] ?? {};
  for (const [col, maxLen] of Object.entries(maxLengths)) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) continue;
    const str = String(row[col] ?? "");
    if (str.trim().length === 0) return `${col} não pode ser vazio`;
    if (str.length > maxLen) return `${col}: máximo ${maxLen} caracteres`;
  }
  return null;
}

function encryptRow(table: string, row: Record<string, unknown>): void {
  const cols = ENCRYPTED_COLUMNS[table];
  if (!cols) return;
  for (const col of cols) {
    if (typeof row[col] === "string") row[col] = encryptCredential(row[col] as string);
  }
}

function maskSensitiveColumns(table: string, rows: Record<string, unknown>[]): void {
  const cols = SENSITIVE_MASKED_COLUMNS[table];
  if (!cols) return;
  for (const row of rows) {
    for (const col of cols) {
      if (typeof row[col] === "string" && row[col]) {
        row[col] = "****redacted****";
      }
    }
  }
}

function decryptRows(table: string, rows: Record<string, unknown>[]): void {
  const cols = ENCRYPTED_COLUMNS[table];
  if (!cols) return;
  for (const row of rows) {
    for (const col of cols) {
      if (typeof row[col] === "string") row[col] = decryptCredential(row[col] as string);
    }
  }
}

export const restRouter = Router();
restRouter.use(requireAuth);

const MAX_SELECT_LIMIT = 500;
const MAX_MUTATION_ROWS = 200;
const MAX_FILTERS = 50;
const ALLOWED_OPS = new Set(["select", "insert", "update", "delete", "upsert"]);

// ─── Allowed tables and their ownership rules ─────────────────────────────────
// Tables with direct user_id column
const USER_OWNED = new Set([
  "groups", "master_groups", "routes", "templates",
  "scheduled_posts", "link_hub_pages", "shopee_automations",
  "meli_sessions", "api_credentials", "whatsapp_sessions",
  "telegram_sessions", "history_entries", "history_entry_targets", "user_notifications",
  "amazon_affiliate_tags", "shopee_sub_ids",
]);

const TABLE_ALIASES: Record<string, string> = {
  // Backward compatibility for legacy singular table name.
  shopee_sub_id: "shopee_sub_ids",
};

// Tables scoped via parent (no direct user_id)
const PARENT_SCOPED: Record<string, string> = {
  master_group_links: "master_group_id IN (SELECT id FROM master_groups WHERE user_id = $__uid__)",
  route_destinations: "route_id IN (SELECT id FROM routes WHERE user_id = $__uid__)",
  scheduled_post_destinations: "post_id IN (SELECT id FROM scheduled_posts WHERE user_id = $__uid__)",
};

function parentScopeClause(table: string, userParamIndex: number): string {
  if (table === "master_group_links") {
    return `"master_group_id" IN (SELECT "id" FROM "master_groups" WHERE "user_id" = $${userParamIndex})`;
  }
  if (table === "route_destinations") {
    return `"route_id" IN (SELECT "id" FROM "routes" WHERE "user_id" = $${userParamIndex})`;
  }
  return `"post_id" IN (SELECT "id" FROM "scheduled_posts" WHERE "user_id" = $${userParamIndex})`;
}

// Readable by authenticated user (own profile) 
const SELF_READABLE = new Set(["profiles", "user_roles", "system_announcements", "system_settings", "app_runtime_flags"]);

// Writable only by admin — non-admins can read but cannot INSERT/UPDATE/DELETE/UPSERT
// user_roles is included: non-admins must not self-assign roles (set at signup, managed by admin)
const SELF_WRITE_BLOCKED = new Set(["system_settings", "system_announcements", "user_roles", "app_runtime_flags"]);

// Admin only
const ADMIN_ONLY = new Set(["admin_audit_logs", "users"]);

// Columns that non-admin users cannot write — prevents self-service plan upgrades
const NON_ADMIN_WRITE_DENIED_COLUMNS: Record<string, Set<string>> = {
  profiles: new Set(["plan_id", "plan_expires_at", "plan_sync_mode", "plan_sync_note", "plan_sync_updated_at"]),
};

// Parent table ownership lookup for PARENT_SCOPED INSERT/UPSERT válidation
const PARENT_SCOPED_PARENT: Record<string, { key: string; table: string }> = {
  master_group_links:          { key: "master_group_id", table: "master_groups" },
  route_destinations:          { key: "route_id",        table: "routes" },
  scheduled_post_destinations: { key: "post_id",         table: "scheduled_posts" },
};

const ALL_ALLOWED = new Set([
  ...USER_OWNED, ...Object.keys(PARENT_SCOPED), ...SELF_READABLE, ...ADMIN_ONLY,
]);

// ─── Value serialization for pg ───────────────────────────────────────────────
// Arrays must pass through natively so node-postgres encodes them as PostgreSQL
// arrays (TEXT[], UUID[], etc.). Only plain objects are JSON.stringified (JSONB).
function pgValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v;               // pg handles JS arrays → TEXT[]
  if (typeof v === "object") return JSON.stringify(v); // JSONB
  return v;
}

// ─── Column identifier safety ─────────────────────────────────────────────────
function safeIdent(name: string): string {
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim())) throw new Error(`Invalid identifier: ${name}`);
  return `"${name.trim()}"`;
}

function safeCols(cols: string): string {
  if (cols.trim() === "*") return "*";
  return cols.split(",").map((c) => {
    const t = c.trim();
    // SECURITY: Only allow simple column names, never qualified (table.column).
    // Qualified names could be used to probe other tables or cause SQL injection.
    // The table is already specified in the query's FROM clause.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
      throw new Error(`Invalid column identifier: ${t}. Only unqualified column names are allowed.`);
    }
    return `"${t}"`;
  }).join(", ");
}

function toPositiveInt(value: unknown, min: number, max: number): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min) return null;
  return Math.min(parsed, max);
}

function appendWhereCondition(whereSql: string, extraCondition: string): string {
  if (!extraCondition) return whereSql;
  if (!whereSql || !whereSql.trim()) return `WHERE ${extraCondition}`;
  return `${whereSql} AND ${extraCondition}`;
}

function getNonAdminSystemVisibilityCondition(table: string): string {
  if (table === "system_settings") {
    return `"key" IN ('admin_config', 'runtime_control')`;
  }
  if (table === "app_runtime_flags") {
    return `"id" = 'global'`;
  }
  if (table === "system_announcements") {
    return `"is_active" = TRUE AND ("starts_at" IS NULL OR "starts_at" <= NOW()) AND ("ends_at" IS NULL OR "ends_at" >= NOW())`;
  }
  return "";
}

async function ensureOwnedActiveGroup(client: import("pg").PoolClient, userId: string, groupIdRaw: unknown) {
  const groupId = String(groupIdRaw ?? "").trim();
  if (!groupId) throw new Error("group_id obrigatório");
  const ownedGroup = await client.query<{ id: string; platform: string }>(
    `SELECT id, platform
       FROM "groups"
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL`,
    [groupId, userId],
  );
  if ((ownedGroup.rowCount ?? 0) === 0) throw new Error("Grupo não pertence ao usuário");
  return {
    groupId,
    platform: String(ownedGroup.rows[0]?.platform || "").trim(),
  };
}

async function ensureMasterGroupPlatformConsistency(
  client: import("pg").PoolClient,
  masterGroupIdRaw: unknown,
  nextPlatform: string,
) {
  const masterGroupId = String(masterGroupIdRaw ?? "").trim();
  if (!masterGroupId) throw new Error("master_group_id obrigatório");
  const existingPlatform = await client.query<{ platform: string }>(
    `SELECT g.platform
       FROM "master_group_links" l
       JOIN "groups" g
         ON g.id = l.group_id
      WHERE l.master_group_id = $1
        AND l.is_active <> FALSE
        AND g.deleted_at IS NULL
      LIMIT 1`,
    [masterGroupId],
  );
  if ((existingPlatform.rowCount ?? 0) === 0) return;
  const currentPlatform = String(existingPlatform.rows[0]?.platform || "").trim();
  if (currentPlatform && nextPlatform && currentPlatform !== nextPlatform) {
    throw new Error("Grupo mestre só pode conter grupos da mesma rede");
  }
}

// ─── Filter building ──────────────────────────────────────────────────────────
type Filter = { type: string; col: string; val: unknown };

function buildWhere(filters: Filter[], params: unknown[], offset = 1): { sql: string; nextOffset: number } {
  const parts: string[] = [];
  let i = offset;
  for (const f of filters) {
    const col = safeIdent(f.col);
    if (f.type === "eq")   { parts.push(`${col} = $${i++}`); params.push(f.val); }
    else if (f.type === "neq")  { parts.push(`${col} != $${i++}`); params.push(f.val); }
    else if (f.type === "is")   { parts.push(`${col} ${f.val === null ? "IS NULL" : `= $${i++}`}`); if (f.val !== null) params.push(f.val); }
    else if (f.type === "in")   {
      const arr = (Array.isArray(f.val) ? f.val : [f.val]).filter((item) => item !== undefined);
      if (arr.length === 0) {
        // Avoid generating invalid SQL such as: col IN ()
        parts.push("1 = 0");
      } else {
        const phs = arr.map(() => `$${i++}`).join(",");
        parts.push(`${col} IN (${phs})`);
        params.push(...arr);
      }
    }
    else if (f.type === "lte")  { parts.push(`${col} <= $${i++}`); params.push(f.val); }
    else if (f.type === "gte")  { parts.push(`${col} >= $${i++}`); params.push(f.val); }
    else if (f.type === "nin")  {
      const arr = (Array.isArray(f.val) ? f.val : [f.val]).filter((item) => item !== undefined);
      if (arr.length > 0) {
        const phs = arr.map(() => `$${i++}`).join(",");
        parts.push(`${col} NOT IN (${phs})`);
        params.push(...arr);
      }
    }
    else if (f.type === "like") {
      // SECURITY: Escape LIKE wildcards (% and _) to prevent wildcard scanning attacks
      const escapedVal = String(f.val ?? "").replace(/%/g, '\\%').replace(/_/g, '\\_');
      parts.push(`${col} ILIKE $${i++}`);
      params.push(escapedVal);
    }
  }
  return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", nextOffset: i };
}

// ─── POST /rest/:table — unified CRUD endpoint ────────────────────────────────
restRouter.post("/:table", async (req: Request, res: Response) => {
  const rawTable = String(req.params.table || "").trim();
  const table = TABLE_ALIASES[rawTable] || rawTable;
  if (!ALL_ALLOWED.has(table)) { res.json({ data: null, count: null, error: { message: `Tabela não encontrada: ${table}` } }); return; }

  const userId = req.currentUser!.sub;
  const isAdmin = req.currentUser!.role === "admin";
  const isService = !!(req.currentUser as { isService?: boolean })?.isService;
  const effectiveAdmin = isAdmin || isService;

  // Admin-only guard
  if (ADMIN_ONLY.has(table) && !effectiveAdmin) {
    res.status(403).json({ data: null, count: null, error: { message: "Acesso negado" } }); return;
  }

  const { op, columns, data, filters = [], options = {} } = req.body as {
    op: string;
    columns?: string;
    data?: unknown;
    filters?: Filter[];
    options?: Record<string, unknown>;
  };

  const normalizedFilters = Array.isArray(filters) ? filters : [];
  const normalizedOptions = (options && typeof options === "object" && !Array.isArray(options))
    ? options
    : {};

  if (!ALLOWED_OPS.has(String(op || "").trim())) {
    res.status(400).json({ data: null, count: null, error: { message: "Operação inválida" } }); return;
  }

  if (normalizedFilters.length > MAX_FILTERS) {
    res.status(400).json({ data: null, count: null, error: { message: `Quantidade maxima de filtros excedida (${MAX_FILTERS})` } }); return;
  }

  // Block writes to system tables for non-admins (reads remain accessible)
  if (SELF_WRITE_BLOCKED.has(table) && !effectiveAdmin && op !== "select") {
    res.status(403).json({ data: null, count: null, error: { message: "Acesso negado" } }); return;
  }

  const client = await pool.connect();
  let userPlanStatePromise: Promise<RestUserPlanState> | null = null;
  const getUserPlanState = () => {
    if (!userPlanStatePromise) {
      userPlanStatePromise = resolveUserPlanState(client, userId);
    }
    return userPlanStatePromise;
  };
  try {
    await client.query("SELECT set_config('app.user_id', $1, false)", [userId]);

    // ── SELECT ─────────────────────────────────────────────────────────────────
    if (op === "select") {
      const params: unknown[] = [];
      const whereFilters: Filter[] = [...normalizedFilters];

      // Inject user scoping
      if (USER_OWNED.has(table) && !effectiveAdmin) {
        whereFilters.push({ type: "eq", col: "user_id", val: userId });
      } else if (PARENT_SCOPED[table] && !effectiveAdmin) {
        // handled below as raw SQL
      } else if (table === "profiles" || table === "user_roles") {
        if (!effectiveAdmin) whereFilters.push({ type: "eq", col: "user_id", val: userId });
      } else if (table === "user_notifications") {
        if (!effectiveAdmin) whereFilters.push({ type: "eq", col: "user_id", val: userId });
      }

      let cols = "*";
      try { cols = columns && columns.trim() ? safeCols(columns) : "*"; } catch { /* fallback */ }

      const isCount = normalizedOptions.head === true || normalizedOptions.count === "exact";
      const selectExpr = isCount ? "COUNT(*)" : cols;

      let whereSql = "";
      if (PARENT_SCOPED[table] && !effectiveAdmin) {
        params.push(userId);
        const parentClause = parentScopeClause(table, 1);
        const { sql: extra, nextOffset } = buildWhere(whereFilters, params, 2);
        whereSql = `WHERE ${parentClause}` + (extra ? ` AND ${extra.replace(/^WHERE\s+/i, "")}` : "");
        void nextOffset;
      } else {
        const { sql } = buildWhere(whereFilters, params, 1);
        whereSql = sql;
      }

      if (!effectiveAdmin) {
        whereSql = appendWhereCondition(whereSql, getNonAdminSystemVisibilityCondition(table));
      }

      let sql = `SELECT ${selectExpr} FROM "${table}" ${whereSql}`;

      if (!isCount) {
        const ordArr = (Array.isArray(normalizedOptions.order) ? normalizedOptions.order : []).slice(0, 5);
        if (ordArr.length > 0) {
          sql += " ORDER BY " + ordArr.map((o: Record<string, unknown>) => `${safeIdent(String(o.col))} ${o.ascending === false ? "DESC" : "ASC"}`).join(", ");
        }

        // ── Cursor-based pagination ─────────────────────────────────────────
        // Client sends options.cursor = { created_at: "...", id: "..." } for keyset pagination.
        // Requires ORDER BY created_at DESC, id DESC (default for cursor-enabled queries).
        // Falls back to OFFSET-based if cursor is not provided.
        const cursorObj = normalizedOptions.cursor as { created_at?: string; id?: string } | undefined;
        if (cursorObj && typeof cursorObj === "object" && cursorObj.created_at && cursorObj.id) {
          const cursorTs = String(cursorObj.created_at);
          const cursorId = String(cursorObj.id);
          // Validate cursor values (ISO timestamp and UUID format)
          if (/^\d{4}-\d{2}-\d{2}/.test(cursorTs) && /^[0-9a-f-]{36}$/i.test(cursorId)) {
            params.push(cursorTs, cursorId);
            const cursorCondition = `("created_at" < $${params.length - 1} OR ("created_at" = $${params.length - 1} AND "id" < $${params.length}))`;
            sql = whereSql
              ? sql.replace(whereSql, `${whereSql} AND ${cursorCondition}`)
              : `SELECT ${selectExpr} FROM "${table}" WHERE ${cursorCondition}`;
            // Ensure ORDER BY is set for cursor pagination
            if (ordArr.length === 0) {
              sql += " ORDER BY \"created_at\" DESC, \"id\" DESC";
            }
          }
        }

        const safeLimit = toPositiveInt(normalizedOptions.limit, 1, MAX_SELECT_LIMIT);
        if (safeLimit) sql += ` LIMIT ${safeLimit}`;
        const safeOffset = toPositiveInt((normalizedOptions as { offset?: unknown }).offset, 0, 500_000);
        if (safeOffset !== null) sql += ` OFFSET ${safeOffset}`;
      }

      // ── Cache layer: check in-memory cache for user-scoped SELECT queries ──
      const canCache = !isCount && !effectiveAdmin && isCacheable(table);
      let cacheKey = "";
      if (canCache) {
        cacheKey = buildCacheKey(userId, table, sql + JSON.stringify(params));
        const cached = cache.get<{ data: unknown; count: number }>(cacheKey);
        if (cached) {
          cacheHit();
          if (normalizedOptions.maybeSingle) { res.json({ data: (cached.data as unknown[])?.[0] ?? null, count: null, error: null }); return; }
          if (normalizedOptions.single) {
            const arr = cached.data as unknown[];
            if (!arr || arr.length === 0) { res.json({ data: null, count: null, error: { message: "No rows found" } }); return; }
            res.json({ data: arr[0], count: null, error: null }); return;
          }
          res.json({ data: cached.data, count: cached.count, error: null }); return;
        }
        cacheMiss();
      }

      const result = await client.query(sql, params);

      if (isCount) {
        res.json({ data: null, count: Number(result.rows[0]?.count ?? 0), error: null }); return;
      }

      const rows = result.rows;
      decryptRows(table, rows as Record<string, unknown>[]);
      maskSensitiveColumns(table, rows as Record<string, unknown>[]);

      // Store in cache for subsequent reads
      if (canCache && cacheKey) {
        cache.set(cacheKey, { data: rows, count: rows.length }, getTtlForTable(table));
      }

      if (normalizedOptions.maybeSingle) { res.json({ data: rows[0] ?? null, count: null, error: null }); return; }
      if (normalizedOptions.single) {
        if (rows.length === 0) { res.json({ data: null, count: null, error: { message: "No rows found" } }); return; }
        res.json({ data: rows[0], count: null, error: null }); return;
      }

      // Build next_cursor for keyset pagination when cursor was requested
      let nextCursor: { created_at: string; id: string } | null = null;
      const requestedLimit = toPositiveInt(normalizedOptions.limit, 1, MAX_SELECT_LIMIT);
      if (rows.length > 0 && requestedLimit && rows.length >= requestedLimit) {
        const lastRow = rows[rows.length - 1] as Record<string, unknown>;
        if (lastRow.created_at && lastRow.id) {
          nextCursor = { created_at: String(lastRow.created_at), id: String(lastRow.id) };
        }
      }

      res.json({ data: rows, count: rows.length, next_cursor: nextCursor, error: null }); return;
    }

    // ── INSERT ─────────────────────────────────────────────────────────────────
    if (op === "insert") {
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length > MAX_MUTATION_ROWS) {
        res.status(400).json({ data: null, count: null, error: { message: `Limite maximo de ${MAX_MUTATION_ROWS} registros por insert` } }); return;
      }
      const inserted: unknown[] = [];
      const transactionalBatch = rows.length > 1;
      try {
        if (transactionalBatch) await client.query("BEGIN");

        for (const row of rows as Record<string, unknown>[]) {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Payload de insert inválido");
          if (!row.id) row.id = uuid();
          // Always force user_id from JWT — never trust client-supplied value
          if (USER_OWNED.has(table)) row.user_id = userId;
          // Scope self-owned tables (profiles) to current user for non-admins
          if (table === "profiles" && !effectiveAdmin) row.user_id = userId;
          // Strip admin-only columns to prevent privilege escalation via self-service
          if (!effectiveAdmin && NON_ADMIN_WRITE_DENIED_COLUMNS[table]) {
            for (const col of NON_ADMIN_WRITE_DENIED_COLUMNS[table]) delete row[col];
          }
          // For PARENT_SCOPED tables, verify that the parent record belongs to this user
          if (PARENT_SCOPED_PARENT[table] && !effectiveAdmin) {
            const { key, table: parentTbl } = PARENT_SCOPED_PARENT[table];
            const parentId = row[key];
            if (!parentId) throw new Error("Parent ID obrigatório");
            const owned = await client.query(`SELECT id FROM "${parentTbl}" WHERE id = $1 AND user_id = $2`, [parentId, userId]);
            if ((owned.rowCount ?? 0) === 0) throw new Error("Acesso negado");
          }
          if (!effectiveAdmin && (table === "master_group_links" || table === "route_destinations" || table === "scheduled_post_destinations")) {
            const owned = await ensureOwnedActiveGroup(client, userId, row.group_id);
            if (table === "master_group_links") {
              await ensureMasterGroupPlatformConsistency(client, row.master_group_id, owned.platform);
            }
          }

          if (!effectiveAdmin && table === "templates") {
            await assertTemplateMutationAllowed(client, userId, row, await getUserPlanState());
          }

          if (!effectiveAdmin && table === "shopee_automations" && inferAutomationMarketplace(row) === "shopee") {
            await assertShopeeAutomationMutationAllowed(client, userId, row, await getUserPlanState());
          }

          if (!effectiveAdmin && table === "routes") {
            await assertRouteMutationAllowed(client, userId, await getUserPlanState());
          }

          if (!effectiveAdmin && table === "route_destinations") {
            await assertRouteDestinationMutationAllowed(client, userId, await getUserPlanState());
          }

          if (!effectiveAdmin && table === "scheduled_posts") {
            await assertScheduleMutationAllowed(client, userId, await getUserPlanState());
          }

          if (!effectiveAdmin && table === "scheduled_post_destinations") {
            const accessError = getMutationAccessError(await getUserPlanState(), "schedules");
            if (accessError) throw new Error(accessError);
          }

          if (!effectiveAdmin && table === "link_hub_pages") {
            const accessError = getMutationAccessError(await getUserPlanState(), "linkHub");
            if (accessError) throw new Error(accessError);
          }

          const enumErr = validateRowEnums(table, row);
          if (enumErr) throw new Error(enumErr);
          const fieldErr = validateRowFields(table, row, true);
          if (fieldErr) throw new Error(fieldErr);

          encryptRow(table, row);
          const keys = Object.keys(row);
          const cols = keys.map(safeIdent).join(", ");
          const phs = keys.map((_, i) => `$${i + 1}`).join(", ");
          const vals = keys.map((k) => pgValue(row[k]));
          const result = await client.query(`INSERT INTO "${table}" (${cols}) VALUES (${phs}) RETURNING *`, vals);
          inserted.push(...result.rows);
        }

        if (transactionalBatch) await client.query("COMMIT");
      } catch (error) {
        if (transactionalBatch) await client.query("ROLLBACK");
        throw error;
      }
      decryptRows(table, inserted as Record<string, unknown>[]);
      maskSensitiveColumns(table, inserted as Record<string, unknown>[]);
      bustTableCache(userId, table);
      const ret = Array.isArray(data) ? inserted : (inserted[0] ?? null);
      res.json({ data: ret, count: inserted.length, error: null }); return;
    }

    // ── UPDATE ─────────────────────────────────────────────────────────────────
    if (op === "update") {
      const updateData = data as Record<string, unknown>;
      if (updateData && typeof updateData === "object" && !Array.isArray(updateData)) encryptRow(table, updateData);
      if (!updateData || typeof updateData !== "object" || Array.isArray(updateData)) {
        res.status(400).json({ data: null, count: null, error: { message: "Payload de update inválido" } }); return;
      }
      // Strip admin-only columns to prevent privilege escalation via self-service
      if (!effectiveAdmin && NON_ADMIN_WRITE_DENIED_COLUMNS[table]) {
        for (const col of NON_ADMIN_WRITE_DENIED_COLUMNS[table]) delete updateData[col];
      }
      // Prevent ownership transfer: user_id must never change on user-owned records
      if (USER_OWNED.has(table) && !effectiveAdmin) delete updateData.user_id;
      const updateEnumErr = validateRowEnums(table, updateData);
      if (updateEnumErr) { res.status(400).json({ data: null, count: null, error: { message: updateEnumErr } }); return; }
      const updateFieldErr = validateRowFields(table, updateData, false);
      if (updateFieldErr) { res.status(400).json({ data: null, count: null, error: { message: updateFieldErr } }); return; }
      if (!effectiveAdmin && (table === "master_group_links" || table === "route_destinations" || table === "scheduled_post_destinations")) {
        if (Object.prototype.hasOwnProperty.call(updateData, "group_id")) {
          try {
            const owned = await ensureOwnedActiveGroup(client, userId, updateData.group_id);
            if (table === "master_group_links") {
              const masterGroupId = Object.prototype.hasOwnProperty.call(updateData, "master_group_id")
                ? updateData.master_group_id
                : normalizedFilters.find((filter) => filter.col === "master_group_id" && filter.type === "eq")?.val;
              await ensureMasterGroupPlatformConsistency(client, masterGroupId, owned.platform);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Grupo inválido";
            res.status(403).json({ data: null, count: null, error: { message } }); return;
          }
        }
      }
      if (!effectiveAdmin && PARENT_SCOPED_PARENT[table]) {
        const { key, table: parentTbl } = PARENT_SCOPED_PARENT[table];
        if (Object.prototype.hasOwnProperty.call(updateData, key)) {
          const parentId = updateData[key];
          const owned = await client.query(`SELECT id FROM "${parentTbl}" WHERE id = $1 AND user_id = $2`, [parentId, userId]);
          if ((owned.rowCount ?? 0) === 0) {
            res.status(403).json({ data: null, count: null, error: { message: "Acesso negado" } }); return;
          }
        }
      }
      const setKeys = Object.keys(updateData);
      if (setKeys.length === 0) { res.json({ data: [], count: 0, error: null }); return; }

      const setParams: unknown[] = [];
      const setClause = setKeys.map((k) => {
        setParams.push(pgValue(updateData[k]));
        return `${safeIdent(k)} = $${setParams.length}`;
      }).join(", ");

      const whereFilters: Filter[] = [...normalizedFilters];
      if ((USER_OWNED.has(table) || table === "profiles") && !effectiveAdmin) whereFilters.push({ type: "eq", col: "user_id", val: userId });

      const buildUpdateWhereQuery = (seedParams: unknown[]) => {
        const scopedParams = [...seedParams];
        let scopedWhereSql: string;

        if (PARENT_SCOPED[table] && !effectiveAdmin) {
          scopedParams.push(userId);
          const parentClause = parentScopeClause(table, scopedParams.length);
          const { sql: extra } = buildWhere(whereFilters, scopedParams, scopedParams.length + 1);
          scopedWhereSql = `WHERE ${parentClause}` + (extra ? ` AND ${extra.replace(/^WHERE\s+/i, "")}` : "");
        } else {
          const { sql } = buildWhere(whereFilters, scopedParams, scopedParams.length + 1);
          scopedWhereSql = sql;
        }

        return {
          whereSql: scopedWhereSql,
          params: scopedParams,
        };
      };

      const { whereSql: precheckWhereSql, params: precheckParams } = buildUpdateWhereQuery([]);
      if (!precheckWhereSql) { res.json({ data: null, count: 0, error: { message: "UPDATE sem WHERE é proibido" } }); return; }

      if (!effectiveAdmin && table === "templates") {
        const targetTemplates = await client.query<Record<string, unknown>>(
          `SELECT id, scope, tags FROM "templates" ${precheckWhereSql}`,
          precheckParams,
        );
        if ((targetTemplates.rowCount ?? 0) > 0) {
          const planState = await getUserPlanState();
          const accessError = getMutationAccessError(planState, "templates");
          if (accessError) {
            res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
          }
          for (const existingRow of targetTemplates.rows as Record<string, unknown>[]) {
            const mergedRow = { ...existingRow, ...updateData };
            await assertTemplateMutationAllowed(client, userId, mergedRow, planState, existingRow);
          }
        }
      }

      if (!effectiveAdmin && table === "shopee_automations") {
        const targetAutomations = await client.query<Record<string, unknown>>(
          `SELECT id, config, session_id, destination_group_ids, master_group_ids, template_id FROM "shopee_automations" ${precheckWhereSql}`,
          precheckParams,
        );
        const mergedRows = (targetAutomations.rows as Record<string, unknown>[])
          .map((row) => ({ existingRow: row, mergedRow: { ...row, ...updateData } }));
        const shopeeRows = mergedRows
          .filter(({ mergedRow }) => inferAutomationMarketplace(mergedRow) === "shopee");
        if (shopeeRows.length > 0) {
          const planState = await getUserPlanState();
          const accessError = getMutationAccessError(planState, "shopeeAutomations");
          if (accessError) {
            res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
          }
          if (touchesShopeeAutomationRelations(updateData)) {
            for (const { existingRow, mergedRow } of shopeeRows) {
              await assertShopeeAutomationMutationAllowed(client, userId, mergedRow, planState, existingRow);
            }
          }
        }
      }

      if (!effectiveAdmin && table === "routes") {
        const targetRoutes = await client.query<Record<string, unknown>>(
          `SELECT id FROM "routes" ${precheckWhereSql}`,
          precheckParams,
        );
        if ((targetRoutes.rowCount ?? 0) > 0) {
          const planState = await getUserPlanState();
          const accessError = getMutationAccessError(planState, "routes");
          if (accessError) {
            res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
          }
          for (const existingRow of targetRoutes.rows as Record<string, unknown>[]) {
            await assertRouteMutationAllowed(client, userId, planState, existingRow);
          }
        }
      }

      if (!effectiveAdmin && table === "route_destinations") {
        const planState = await getUserPlanState();
        const accessError = getMutationAccessError(planState, "routes");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      if (!effectiveAdmin && table === "scheduled_posts") {
        const targetPosts = await client.query<Record<string, unknown>>(
          `SELECT id FROM "scheduled_posts" ${precheckWhereSql}`,
          precheckParams,
        );
        if ((targetPosts.rowCount ?? 0) > 0) {
          const planState = await getUserPlanState();
          const accessError = getMutationAccessError(planState, "schedules");
          if (accessError) {
            res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
          }
          for (const existingRow of targetPosts.rows as Record<string, unknown>[]) {
            await assertScheduleMutationAllowed(client, userId, planState, existingRow);
          }
        }
      }

      if (!effectiveAdmin && table === "scheduled_post_destinations") {
        const accessError = getMutationAccessError(await getUserPlanState(), "schedules");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      if (!effectiveAdmin && table === "link_hub_pages") {
        const accessError = getMutationAccessError(await getUserPlanState(), "linkHub");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      const { whereSql, params } = buildUpdateWhereQuery(setParams);
      const result = await client.query(`UPDATE "${table}" SET ${setClause} ${whereSql} RETURNING *`, params);
      decryptRows(table, result.rows as Record<string, unknown>[]);
      maskSensitiveColumns(table, result.rows as Record<string, unknown>[]);
      bustTableCache(userId, table);
      res.json({ data: result.rows, count: result.rowCount ?? 0, error: null }); return;
    }

    // ── DELETE ─────────────────────────────────────────────────────────────────
    if (op === "delete") {
      const params: unknown[] = [];
      const whereFilters: Filter[] = [...normalizedFilters];
      if ((USER_OWNED.has(table) || table === "profiles") && !effectiveAdmin) whereFilters.push({ type: "eq", col: "user_id", val: userId });
      let whereSql: string;
      if (PARENT_SCOPED[table] && !effectiveAdmin) {
        params.push(userId);
        const parentClause = parentScopeClause(table, 1);
        const { sql: extra } = buildWhere(whereFilters, params, 2);
        whereSql = `WHERE ${parentClause}` + (extra ? ` AND ${extra.replace(/^WHERE\s+/i, "")}` : "");
      } else {
        const { sql } = buildWhere(whereFilters, params, 1);
        whereSql = sql;
      }
      if (!whereSql) { res.json({ data: null, count: 0, error: { message: "DELETE sem WHERE é proibido" } }); return; }

      if (!effectiveAdmin && table === "templates") {
        const planState = await getUserPlanState();
        const accessError = getMutationAccessError(planState, "templates");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      if (!effectiveAdmin && table === "shopee_automations") {
        const targetAutomations = await client.query<Record<string, unknown>>(
          `SELECT config FROM "shopee_automations" ${whereSql}`,
          params,
        );
        const hasShopeeRows = (targetAutomations.rows as Record<string, unknown>[])
          .some((row) => inferAutomationMarketplace(row) === "shopee");
        if (hasShopeeRows) {
          const planState = await getUserPlanState();
          const accessError = getMutationAccessError(planState, "shopeeAutomations");
          if (accessError) {
            res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
          }
        }
      }

      if (!effectiveAdmin && (table === "routes" || table === "route_destinations")) {
        const accessError = getMutationAccessError(await getUserPlanState(), "routes");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      if (!effectiveAdmin && (table === "scheduled_posts" || table === "scheduled_post_destinations")) {
        const accessError = getMutationAccessError(await getUserPlanState(), "schedules");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      if (!effectiveAdmin && table === "link_hub_pages") {
        const accessError = getMutationAccessError(await getUserPlanState(), "linkHub");
        if (accessError) {
          res.status(403).json({ data: null, count: null, error: { message: accessError } }); return;
        }
      }

      const result = await client.query(`DELETE FROM "${table}" ${whereSql} RETURNING *`, params);
      decryptRows(table, result.rows as Record<string, unknown>[]);
      maskSensitiveColumns(table, result.rows as Record<string, unknown>[]);
      bustTableCache(userId, table);
      res.json({ data: result.rows, count: result.rowCount ?? 0, error: null }); return;
    }

    // ── UPSERT ─────────────────────────────────────────────────────────────────
    if (op === "upsert") {
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length > MAX_MUTATION_ROWS) {
        res.status(400).json({ data: null, count: null, error: { message: `Limite maximo de ${MAX_MUTATION_ROWS} registros por upsert` } }); return;
      }
      const onConflict = String(normalizedOptions.onConflict ?? "id");
      const ignoreDupes = normalizedOptions.ignoreDuplicates === true;
      const upserted: unknown[] = [];
      const transactionalBatch = rows.length > 1;
      try {
        if (transactionalBatch) await client.query("BEGIN");

        for (const row of rows as Record<string, unknown>[]) {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Payload de upsert inválido");
          if (!row.id) row.id = uuid();
          // Always force user_id from JWT — never trust client-supplied value
          if (USER_OWNED.has(table)) row.user_id = userId;
          // Scope self-owned tables (profiles) to current user for non-admins
          if (table === "profiles" && !effectiveAdmin) row.user_id = userId;
          // Strip admin-only columns to prevent privilege escalation via self-service
          if (!effectiveAdmin && NON_ADMIN_WRITE_DENIED_COLUMNS[table]) {
            for (const col of NON_ADMIN_WRITE_DENIED_COLUMNS[table]) delete row[col];
          }
          // For PARENT_SCOPED tables, verify that the parent record belongs to this user
          if (PARENT_SCOPED_PARENT[table] && !effectiveAdmin) {
            const { key, table: parentTbl } = PARENT_SCOPED_PARENT[table];
            const parentId = row[key];
            if (!parentId) throw new Error("Parent ID obrigatório");
            const owned = await client.query(`SELECT id FROM "${parentTbl}" WHERE id = $1 AND user_id = $2`, [parentId, userId]);
            if ((owned.rowCount ?? 0) === 0) throw new Error("Acesso negado");
          }
          if (!effectiveAdmin && (table === "master_group_links" || table === "route_destinations" || table === "scheduled_post_destinations")) {
            const owned = await ensureOwnedActiveGroup(client, userId, row.group_id);
            if (table === "master_group_links") {
              await ensureMasterGroupPlatformConsistency(client, row.master_group_id, owned.platform);
            }
          }

          const existingRow = (!effectiveAdmin && (table === "templates" || table === "shopee_automations"))
            ? ((await client.query<Record<string, unknown>>(
                `SELECT * FROM "${table}" WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
                [String(row.id || ""), userId],
              )).rows[0] ?? null)
            : null;

          if (!effectiveAdmin && table === "templates") {
            const mergedTemplateRow = existingRow ? { ...existingRow, ...row } : row;
            await assertTemplateMutationAllowed(client, userId, mergedTemplateRow, await getUserPlanState(), existingRow);
          }

          if (!effectiveAdmin && table === "shopee_automations") {
            const mergedAutomationRow = existingRow ? { ...existingRow, ...row } : row;
            if (inferAutomationMarketplace(mergedAutomationRow) === "shopee") {
              await assertShopeeAutomationMutationAllowed(client, userId, mergedAutomationRow, await getUserPlanState(), existingRow);
            }
          }

          if (!effectiveAdmin && table === "routes") {
            const routeRow = (await client.query<Record<string, unknown>>(
              `SELECT * FROM "routes" WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
              [String(row.id || ""), userId],
            )).rows[0] ?? null;
            const planState = await getUserPlanState();
            const accessError = getMutationAccessError(planState, "routes");
            if (accessError) throw new Error(accessError);
            await assertRouteMutationAllowed(client, userId, planState, routeRow);
          }

          if (!effectiveAdmin && table === "route_destinations") {
            const destinationRow = (await client.query<Record<string, unknown>>(
              `SELECT * FROM "route_destinations" WHERE id::text = $1 LIMIT 1`,
              [String(row.id || "")],
            )).rows[0] ?? null;
            const planState = await getUserPlanState();
            const accessError = getMutationAccessError(planState, "routes");
            if (accessError) throw new Error(accessError);
            await assertRouteDestinationMutationAllowed(client, userId, planState, destinationRow);
          }

          if (!effectiveAdmin && table === "scheduled_posts") {
            const scheduledRow = (await client.query<Record<string, unknown>>(
              `SELECT * FROM "scheduled_posts" WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
              [String(row.id || ""), userId],
            )).rows[0] ?? null;
            const planState = await getUserPlanState();
            const accessError = getMutationAccessError(planState, "schedules");
            if (accessError) throw new Error(accessError);
            await assertScheduleMutationAllowed(client, userId, planState, scheduledRow);
          }

          if (!effectiveAdmin && table === "scheduled_post_destinations") {
            const accessError = getMutationAccessError(await getUserPlanState(), "schedules");
            if (accessError) throw new Error(accessError);
          }

          if (!effectiveAdmin && table === "link_hub_pages") {
            const accessError = getMutationAccessError(await getUserPlanState(), "linkHub");
            if (accessError) throw new Error(accessError);
          }

          const upsertEnumErr = validateRowEnums(table, row);
          if (upsertEnumErr) throw new Error(upsertEnumErr);
          const upsertFieldErr = validateRowFields(table, row, true);
          if (upsertFieldErr) throw new Error(upsertFieldErr);

          encryptRow(table, row);
          const keys = Object.keys(row);
          const cols = keys.map(safeIdent).join(", ");
          const phs = keys.map((_, i) => `$${i + 1}`).join(", ");
          const vals = keys.map((k) => pgValue(row[k]));

          const conflictCols = onConflict.split(",").map((c) => safeIdent(c.trim())).join(", ");
          let onConflictClause: string;
          if (ignoreDupes) {
            onConflictClause = `ON CONFLICT (${conflictCols}) DO NOTHING`;
          } else {
            const conflictTargets = onConflict.split(",").map((c) => c.trim());
            const updateCols = keys.filter((k) => {
              if (conflictTargets.includes(k)) return false;
              // SECURITY: Never include user_id in DO UPDATE SET for user-owned tables.
              // Without this, an attacker with knowledge of a victim's record UUID could
              // UPSERT with their own user_id, triggering ON CONFLICT and overwriting
              // the victim's user_id — effectively stealing ownership of the record.
              if ((USER_OWNED.has(table) || table === "profiles") && !effectiveAdmin && k === "user_id") return false;
              return true;
            });
            if (updateCols.length === 0) {
              onConflictClause = `ON CONFLICT (${conflictCols}) DO NOTHING`;
            } else {
              const updateExpr = updateCols.map((k) => `${safeIdent(k)} = EXCLUDED.${safeIdent(k)}`).join(", ");
              // SECURITY: Add ownership guard for user-owned tables so that a conflict on a
              // record belonging to another user silently does nothing instead of corrupting
              // their data. EXCLUDED.user_id equals the current user's id (forced above), so
              // the WHERE condition only passes when the existing row already belongs to them.
              const ownershipWhere = (USER_OWNED.has(table) || table === "profiles") && !effectiveAdmin && keys.includes("user_id")
                ? ` WHERE "${table}"."user_id" = EXCLUDED."user_id"`
                : "";
              onConflictClause = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateExpr}${ownershipWhere}`;
            }
          }

          const result = await client.query(`INSERT INTO "${table}" (${cols}) VALUES (${phs}) ${onConflictClause} RETURNING *`, vals);
          upserted.push(...result.rows);
        }

        if (transactionalBatch) await client.query("COMMIT");
      } catch (error) {
        if (transactionalBatch) await client.query("ROLLBACK");
        throw error;
      }
      decryptRows(table, upserted as Record<string, unknown>[]);
      maskSensitiveColumns(table, upserted as Record<string, unknown>[]);
      bustTableCache(userId, table);
      const ret = Array.isArray(data) ? upserted : (upserted[0] ?? null);
      res.json({ data: ret, count: upserted.length, error: null }); return;
    }

    res.json({ data: null, count: null, error: { message: `Operação desconhecida: ${op}` } });
  } catch (e: unknown) {
    // Security: never return raw PostgreSQL errors to the client — they expose table names,
    // column names, constraint names, and other schema details useful for reconnaissance.
    if (e instanceof pg.DatabaseError) {
      console.error("[rest] pg error code=%s msg=%s", e.code, e.message);
      // Map common PG codes to safe user-facing messages
      const pgSafeMessages: Record<string, string> = {
        "23505": "Registro duplicado — este valor já existe.",
        "23503": "Operação inválida — referência a registro inexistente.",
        "23502": "Campo obrigatório não preenchido.",
        "23514": "Valor fora dos valores permitidos.",
        "42501": "Permissão negada.",
      };
      const safeMsg = (e.code && pgSafeMessages[e.code]) ?? "Erro ao executar operação.";
      res.json({ data: null, count: null, error: { message: safeMsg } });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[rest] error:", msg);
      // SECURITY: In production, return generic error messages to prevent schema disclosure
      const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
      const safeMsg = isProduction
        ? "Erro interno ao executar operação."
        : msg; // Allow full error messages in dev for debugging
      res.json({ data: null, count: null, error: { message: safeMsg } });
    }
  } finally {
    try {
      await client.query("RESET app.user_id");
    } catch {
      // ignore reset failures while releasing pooled clients
    }
    client.release();
  }
});
