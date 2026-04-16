#!/usr/bin/env node
/**
 * Safe re-encryption utility for credential payloads stored in the database.
 *
 * Usage examples:
 *  - Detect problematic rows (attempt decrypt with current env key):
 *      node scripts/reencrypt-credentials.mjs --detect
 *
 *  - Migrate from an old key to a new key (requires old and new raw hex keys):
 *      node scripts/reencrypt-credentials.mjs --migrate --old-key <hex> --new-key <hex> --confirm
 *
 *  - Use explicit salts if the installation salt changed:
 *      node scripts/reencrypt-credentials.mjs --migrate --old-key <hex> --old-salt <hex> --new-key <hex> --new-salt <hex> --confirm
 */

import { Client } from "pg";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { hkdfSync, createDecipheriv, createCipheriv, randomBytes } from "crypto";
import { loadProjectEnv } from "./load-env.mjs";

loadProjectEnv();

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "enc:v1:";
const HKDF_INFO = "autolinks-credential-encryption";

function usageAndExit(code = 0) {
  console.log(`Usage:\n  --detect                      only detect rows that fail decryption with current env key\n  --migrate                     perform migration using --old-key and --new-key\n  --invalidate-broken           clear rows that cannot be decrypted with current key/salt\n  --old-key <hex>               old raw key (64 hex chars)\n  --old-salt <hex>              optional old salt (64 hex chars). Defaults to installation salt file or env\n  --new-key <hex>               new raw key (64 hex chars) or use CREDENTIAL_ENCRYPTION_KEY in env\n  --new-salt <hex>              optional new salt (64 hex chars)\n  --tables table:column,...     optional comma list of table:column pairs\n  --db-url <DATABASE_URL>       optional database url (defaults to env DATABASE_URL)\n  --dry-run                     show actions but do not update DB\n  --confirm                     required to actually run migration/invalidation\n\nExamples:\n  node scripts/reencrypt-credentials.mjs --detect\n  node scripts/reencrypt-credentials.mjs --migrate --old-key <hex> --new-key <hex> --confirm\n  node scripts/reencrypt-credentials.mjs --invalidate-broken --confirm\n`);
  process.exit(code);
}

function parseArgs() {
  const out = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--detect") out.detect = true;
    else if (a === "--migrate") out.migrate = true;
    else if (a === "--invalidate-broken") out.invalidateBroken = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--old-key") out.oldKey = args[++i];
    else if (a === "--new-key") out.newKey = args[++i];
    else if (a === "--old-salt") out.oldSalt = args[++i];
    else if (a === "--new-salt") out.newSalt = args[++i];
    else if (a === "--db-url") out.dbUrl = args[++i];
    else if (a === "--tables") out.tables = args[++i];
    else usageAndExit(2);
  }
  return out;
}

function readInstallationSalt() {
  const candidateEnv = String(process.env.CREDENTIAL_CIPHER_SALT || "").trim();
  if (candidateEnv) return candidateEnv;
  const saltFile = join(process.cwd(), ".private", "secrets", ".credential-cipher-salt");
  const legacy = join(process.cwd(), ".credential-cipher-salt");
  if (existsSync(saltFile)) return readFileSync(saltFile, "utf8").trim();
  if (existsSync(legacy)) return readFileSync(legacy, "utf8").trim();
  throw new Error("Installation salt not found. Set --old-salt/--new-salt or ensure .private/secrets/.credential-cipher-salt exists.");
}

function deriveKey(rawHex, saltHex) {
  if (!rawHex || !saltHex) throw new Error("Both raw key and salt are required to derive key");
  const ikm = Buffer.from(rawHex, "hex");
  const salt = Buffer.from(saltHex, "hex");
  return hkdfSync("sha256", ikm, salt, HKDF_INFO, 32);
}

function decryptWithKey(stored, keyBuf) {
  if (!stored) return stored;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  const [ivHex, authHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const auth = Buffer.from(authHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(auth);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decrypted.toString("utf8");
}

function encryptWithKey(plaintext, keyBuf) {
  if (!plaintext) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

async function main() {
  const opts = parseArgs();
  const selectedModes = [opts.detect, opts.migrate, opts.invalidateBroken].filter(Boolean).length;
  if (selectedModes !== 1) {
    console.error("Choose exactly one mode: --detect OR --migrate OR --invalidate-broken");
    usageAndExit(2);
  }

  const dbUrl = opts.dbUrl || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not provided (env DATABASE_URL or --db-url)");
    process.exit(2);
  }

  // default targets
  const defaultPairs = [
    { table: "api_credentials", column: "secret_key", idColumn: "id" },
    { table: "telegram_sessions", column: "session_string", idColumn: "id" },
  ];

  const pairs = opts.tables
    ? opts.tables.split(",").map((p) => { const [t,c] = p.split(":"); return { table: t, column: c, idColumn: "id" }; })
    : defaultPairs;

  // determine salts/keys
  const installationSalt = (() => {
    try { return readInstallationSalt(); } catch (e) { return null; }
  })();

  const currentNewKey = (opts.newKey || String(process.env.CREDENTIAL_ENCRYPTION_KEY || "").trim()) || null;
  const newSalt = opts.newSalt || installationSalt || null;
  const oldKey = opts.oldKey || null;
  const oldSalt = opts.oldSalt || installationSalt || null;

  if ((opts.migrate || opts.invalidateBroken) && !opts.confirm) {
    console.error("This operation requires --confirm to actually run. Use --dry-run for a preview.");
    process.exit(2);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Backup table is only needed for write operations (not detect/dry-run).
  const mayWriteRows = (opts.migrate || opts.invalidateBroken) && !opts.dryRun;
  let canUseBackupTable = false;
  if (mayWriteRows) {
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS credential_reencrypt_backups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        column_name TEXT NOT NULL,
        old_value TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      canUseBackupTable = true;
    } catch (err) {
      canUseBackupTable = false;
      console.warn("[reencrypt] could not create backup table (permission denied?) — continuing and skipping backups:", String(err.message || err));
    }
  }

  // Prepare key buffers if provided
  let newKeyBuf = null;
  if (currentNewKey && newSalt) {
    try { newKeyBuf = deriveKey(currentNewKey, newSalt); } catch (e) { console.error("Failed deriving new key:", e.message); process.exit(2); }
  }
  let oldKeyBuf = null;
  if (oldKey && oldSalt) {
    try { oldKeyBuf = deriveKey(oldKey, oldSalt); } catch (e) { console.error("Failed deriving old key:", e.message); process.exit(2); }
  }

  const summary = [];
  for (const pair of pairs) {
    const table = pair.table;
    const column = pair.column;
    const idCol = pair.idColumn || "id";

    console.log(`Checking ${table}.${column} ...`);
    const res = await client.query(`SELECT ${idCol}::text AS id, ${column} FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
    let rows = res.rows;
    console.log(`  rows found: ${rows.length}`);

    let failCount = 0;
    let okCount = 0;
    let migratedCount = 0;

    for (const r of rows) {
      const rowId = String(r.id || "");
      const stored = String(r[column] ?? "");

      // If detect-only: try decrypt with current newKeyBuf (if available) else skip
      if (opts.detect) {
        if (!newKeyBuf) {
          console.log("  Skipping detect for rows: no derived current key available (set CREDENTIAL_ENCRYPTION_KEY or pass --new-key/--new-salt)");
          break;
        }
        try {
          const dec = decryptWithKey(stored, newKeyBuf);
          okCount++;
        } catch (e) {
          failCount++;
          console.warn(`  [DETECT] ${table}:${rowId} decryption FAILED: ${e.message}`);
        }
        continue;
      }

      // Migrate path
      if (opts.migrate) {
        if (!oldKeyBuf) {
          console.error("Old key not provided/derivable; cannot migrate.");
          break;
        }
        if (!newKeyBuf) {
          console.error("New key not provided/derivable; cannot migrate.");
          break;
        }

        let plaintext;
        try {
          plaintext = decryptWithKey(stored, oldKeyBuf);
        } catch (e) {
          failCount++;
          console.warn(`  [MIGRATE] ${table}:${rowId} decrypt with old key FAILED: ${e.message}`);
          continue;
        }

        if (plaintext === null || plaintext === undefined) plaintext = "";

        const reencrypted = encryptWithKey(plaintext, newKeyBuf);

        if (reencrypted === stored) {
          okCount++;
          continue;
        }

        if (opts.dryRun) {
          console.log(`  [DRY-RUN] would update ${table}:${rowId}`);
          migratedCount++;
          continue;
        }

        // backup old value (if available)
        if (canUseBackupTable) {
          await client.query(
            `INSERT INTO credential_reencrypt_backups (table_name, row_id, column_name, old_value) VALUES ($1,$2,$3,$4)`,
            [table, rowId, column, stored],
          );
        } else {
          console.warn(`[reencrypt] backup table unavailable — skipping backup for ${table}:${rowId}`);
        }

        // update target row
        await client.query(`UPDATE ${table} SET ${column} = $1, updated_at = NOW() WHERE ${idCol}::text = $2`, [reencrypted, rowId]);
        migratedCount++;
      }

      if (opts.invalidateBroken) {
        if (!newKeyBuf) {
          console.error("Current key not provided/derivable; cannot invalidate broken rows.");
          break;
        }

        try {
          decryptWithKey(stored, newKeyBuf);
          okCount++;
          continue;
        } catch (e) {
          failCount++;
          const reason = e instanceof Error ? e.message : String(e);
          console.warn(`  [INVALIDATE] ${table}:${rowId} decryption FAILED: ${reason}`);

          if (opts.dryRun) {
            console.log(`  [DRY-RUN] would clear broken payload in ${table}:${rowId}`);
            migratedCount++;
            continue;
          }

          // backup old value (if available)
          if (canUseBackupTable) {
            await client.query(
              `INSERT INTO credential_reencrypt_backups (table_name, row_id, column_name, old_value) VALUES ($1,$2,$3,$4)`,
              [table, rowId, column, stored],
            );
          } else {
            console.warn(`[reencrypt] backup table unavailable — skipping backup for ${table}:${rowId}`);
          }

          // Clear irrecoverable encrypted data so runtime can fail closed without repeated decrypt noise.
          // telegram_sessions needs extra fields reset so scheduler no longer treats it as recoverable online state.
          if (table === "telegram_sessions" && column === "session_string") {
            await client.query(
              `UPDATE telegram_sessions
                  SET session_string = '',
                      phone_code_hash = '',
                      status = 'offline',
                      connected_at = NULL,
                      error_message = 'session_cipher_invalid',
                      updated_at = NOW()
                WHERE ${idCol}::text = $1`,
              [rowId],
            );
          } else {
            await client.query(`UPDATE ${table} SET ${column} = '', updated_at = NOW() WHERE ${idCol}::text = $1`, [rowId]);
          }

          migratedCount++;
        }
      }
    }

    summary.push({ table: pair.table, column: pair.column, rows: rows.length, ok: okCount, failed: failCount, migrated: migratedCount });
    console.log(`  done: rows=${rows.length} ok=${okCount} failed=${failCount} migrated=${migratedCount}`);
  }

  console.log("Summary:");
  for (const s of summary) console.log(`  ${s.table}.${s.column}: rows=${s.rows} ok=${s.ok} failed=${s.failed} migrated=${s.migrated}`);

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(2); });
