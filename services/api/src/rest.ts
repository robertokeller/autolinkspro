import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "./db.js";
import { requireAuth } from "./auth.js";
import { encryptCredential, decryptCredential } from "./credential-cipher.js";

// Columns that must be encrypted at rest per table
const ENCRYPTED_COLUMNS: Record<string, Set<string>> = {
  api_credentials: new Set(["secret_key"]),
};

// Table-specific enum constraints validated before hitting the DB for clean error messages
const TABLE_ENUM_CONSTRAINTS: Record<string, Record<string, readonly string[]>> = {
  templates: {
    scope:    ["shopee", "meli", "amazon"],
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
  "telegram_sessions", "history_entries", "user_notifications",
  "amazon_affiliate_tags",
]);

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
  profiles: new Set(["plan_id", "plan_expires_at"]),
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
    // allow: col, table.col, table.*
    if (!/^[a-zA-Z_*][a-zA-Z0-9_]*(\.[a-zA-Z_*][a-zA-Z0-9_]*)?$/.test(t)) throw new Error(`Invalid column: ${t}`);
    if (t.includes(".")) return t; // already qualified
    return `"${t}"`;
  }).join(", ");
}

function toPositiveInt(value: unknown, min: number, max: number): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min) return null;
  return Math.min(parsed, max);
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
    else if (f.type === "like") { parts.push(`${col} ILIKE $${i++}`); params.push(f.val); }
  }
  return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", nextOffset: i };
}

// ─── POST /rest/:table — unified CRUD endpoint ────────────────────────────────
restRouter.post("/:table", async (req: Request, res: Response) => {
  const { table } = req.params;
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
  try {
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

      let sql = `SELECT ${selectExpr} FROM "${table}" ${whereSql}`;

      if (!isCount) {
        const ordArr = (Array.isArray(normalizedOptions.order) ? normalizedOptions.order : []).slice(0, 5);
        if (ordArr.length > 0) {
          sql += " ORDER BY " + ordArr.map((o: Record<string, unknown>) => `${safeIdent(String(o.col))} ${o.ascending === false ? "DESC" : "ASC"}`).join(", ");
        }
        const safeLimit = toPositiveInt(normalizedOptions.limit, 1, MAX_SELECT_LIMIT);
        if (safeLimit) sql += ` LIMIT ${safeLimit}`;
      }

      const result = await client.query(sql, params);

      if (isCount) {
        res.json({ data: null, count: Number(result.rows[0]?.count ?? 0), error: null }); return;
      }

      const rows = result.rows;
      decryptRows(table, rows as Record<string, unknown>[]);
      if (normalizedOptions.maybeSingle) { res.json({ data: rows[0] ?? null, count: null, error: null }); return; }
      if (normalizedOptions.single) {
        if (rows.length === 0) { res.json({ data: null, count: null, error: { message: "No rows found" } }); return; }
        res.json({ data: rows[0], count: null, error: null }); return;
      }
      res.json({ data: rows, count: rows.length, error: null }); return;
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
      const setKeys = Object.keys(updateData);
      if (setKeys.length === 0) { res.json({ data: [], count: 0, error: null }); return; }

      const params: unknown[] = [];
      const setClause = setKeys.map((k) => {
        params.push(pgValue(updateData[k]));
        return `${safeIdent(k)} = $${params.length}`;
      }).join(", ");

      const whereFilters: Filter[] = [...normalizedFilters];
      if ((USER_OWNED.has(table) || table === "profiles") && !effectiveAdmin) whereFilters.push({ type: "eq", col: "user_id", val: userId });
      let whereSql: string;
      if (PARENT_SCOPED[table] && !effectiveAdmin) {
        params.push(userId);
        const parentClause = parentScopeClause(table, params.length);
        const { sql: extra } = buildWhere(whereFilters, params, params.length + 1);
        whereSql = `WHERE ${parentClause}` + (extra ? ` AND ${extra.replace(/^WHERE\s+/i, "")}` : "");
      } else {
        const { sql } = buildWhere(whereFilters, params, params.length + 1);
        whereSql = sql;
      }
      if (!whereSql) { res.json({ data: null, count: 0, error: { message: "UPDATE sem WHERE é proibido" } }); return; }

      const result = await client.query(`UPDATE "${table}" SET ${setClause} ${whereSql} RETURNING *`, params);
      decryptRows(table, result.rows as Record<string, unknown>[]);
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

      const result = await client.query(`DELETE FROM "${table}" ${whereSql} RETURNING *`, params);
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
            const updateCols = keys.filter((k) => !onConflict.split(",").map((c) => c.trim()).includes(k));
            if (updateCols.length === 0) {
              onConflictClause = `ON CONFLICT (${conflictCols}) DO NOTHING`;
            } else {
              const updateExpr = updateCols.map((k) => `${safeIdent(k)} = EXCLUDED.${safeIdent(k)}`).join(", ");
              onConflictClause = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateExpr}`;
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
      const ret = Array.isArray(data) ? upserted : (upserted[0] ?? null);
      res.json({ data: ret, count: upserted.length, error: null }); return;
    }

    res.json({ data: null, count: null, error: { message: `Operação desconhecida: ${op}` } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[rest] error:", msg);
    res.json({ data: null, count: null, error: { message: msg } });
  } finally {
    client.release();
  }
});
