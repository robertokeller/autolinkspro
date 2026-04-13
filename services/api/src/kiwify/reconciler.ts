/**
 * Kiwify Reconciler
 * Runs daily to compare Kiwify sales with local kiwify_transactions records.
 * Detects missing activations, discrepancies, and logs them for admin review.
 * Called from the scheduler or a PM2 cron process.
 */

import { query, queryOne, execute } from "../db.js";
import {
  loadKiwifyConfig,
  kiwifyListSales,
  findPlanByKiwifyProduct,
  extractKiwifyPeriodTypeHint,
  type KiwifySale,
} from "./client.js";
import { v4 as uuid } from "uuid";
import { activateUserPlan, downgradeUserPlan } from "./webhook-handler.js";

const RECONCILE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns "YYYY-MM-DD" formatted date for N days ago.
 */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

interface ReconcileResult {
  checked: number;
  activated: number;
  downgraded: number;
  skipped: number;
  errors: string[];
}

export async function runKiwifyReconciler(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, activated: 0, downgraded: 0, skipped: 0, errors: [] };

  let cfg: Awaited<ReturnType<typeof loadKiwifyConfig>>;
  try {
    cfg = await loadKiwifyConfig();
  } catch (e) {
    result.errors.push(`Config load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  if (!cfg || !cfg.client_id) {
    result.skipped++;
    return result; // Kiwify not configured — skip silently
  }

  const startDate = daysAgo(RECONCILE_WINDOW_DAYS);
  const endDate = daysAgo(0);

  // Fetch all pages. No status filter — Kiwify credit cards land as "approved",
  // boleto/PIX as "paid". We filter for both after fetching.
  const sales: KiwifySale[] = [];
  const PAGE_SIZE = 50;
  let pageNumber = 1;
  let hasMore = true;

  while (hasMore) {
    let salesData: Awaited<ReturnType<typeof kiwifyListSales>>;
    try {
      salesData = await kiwifyListSales(cfg, {
        start_date: startDate,
        end_date: endDate,
        page_number: pageNumber,
        page_size: PAGE_SIZE,
        view_full_sale_details: true,
      });
    } catch (e) {
      result.errors.push(`Sales fetch failed (page ${pageNumber}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    const page: KiwifySale[] = Array.isArray(salesData?.data) ? salesData.data : [];
    for (const sale of page) {
      if (["approved", "paid", "authorized"].includes(sale.status)) {
        sales.push(sale);
      }
    }

    const totalFetched = (salesData?.pagination?.page_number ?? 1) * PAGE_SIZE;
    hasMore = page.length === PAGE_SIZE && totalFetched < (salesData?.pagination?.count ?? 0);
    pageNumber++;
  }

  for (const sale of sales) {
    result.checked++;
    const orderId = String(sale.id ?? "");
    const customerEmail = String(sale.customer?.email ?? "").toLowerCase();
    const productId = String(sale.product?.id ?? "");

    if (!orderId || !customerEmail) {
      result.skipped++;
      continue;
    }

    // Check if already processed in our transactions table
    const existing = await queryOne(
      "SELECT id, status, user_id FROM kiwify_transactions WHERE kiwify_order_id = $1 LIMIT 1",
      [orderId]
    );

    if (existing && String(existing.status) !== "pending_activation") {
      result.skipped++;
      continue; // Already activated or handled
    }

    const periodHint = extractKiwifyPeriodTypeHint(sale) ?? undefined;
    const mapping = productId ? await findPlanByKiwifyProduct(productId, periodHint) : null;

    if (!mapping) {
      result.skipped++;
      continue; // No known plan mapping
    }

    const planId = String(mapping.plan_id);
    const periodType = String(mapping.period_type ?? periodHint ?? "").trim();

    // Find user by email
    const userRow = await queryOne(
      "SELECT user_id FROM profiles WHERE LOWER(email) = $1 LIMIT 1",
      [customerEmail]
    );

    if (!userRow) {
      // Record as pending if not already in DB — user may sign up later
      if (!existing) {
        try {
          await execute(
            `INSERT INTO kiwify_transactions
               (kiwify_order_id, kiwify_product_id, event_type, status, plan_id, customer_email, customer_name, amount_cents, raw_payload)
             VALUES ($1, $2, 'compra_aprovada', 'pending_activation', $3, $4, $5, $6, $7)`,
            [
              orderId,
              productId,
              planId,
              customerEmail,
              String(sale.customer?.name ?? ""),
              sale.payment?.charge_amount ?? 0,
              JSON.stringify(sale),
            ]
          );
        } catch {
          // Ignore duplicate key or constraint errors
        }
      }
      result.skipped++;
      continue;
    }

    const userId = String(userRow.user_id);

    // User found — activate plan
    try {
      const activation = await activateUserPlan(
        userId,
        planId,
        periodType || undefined,
        "replace",
        { source: "kiwify" },
      );
      if (activation === "skipped_manual_override") {
        if (existing) {
          await execute(
            "UPDATE kiwify_transactions SET status='manual_override_hold', user_id=$1, processed_at=NOW() WHERE kiwify_order_id=$2",
            [userId, orderId],
          );
        } else {
          await execute(
            `INSERT INTO kiwify_transactions
               (kiwify_order_id, kiwify_product_id, event_type, status, plan_id, user_id, customer_email, customer_name, amount_cents, processed_at, raw_payload)
             VALUES ($1, $2, 'compra_aprovada', 'manual_override_hold', $3, $4, $5, $6, $7, NOW(), $8)`,
            [
              orderId,
              productId,
              planId,
              userId,
              customerEmail,
              String(sale.customer?.name ?? ""),
              sale.payment?.charge_amount ?? 0,
              JSON.stringify(sale),
            ],
          );
        }
        result.skipped++;
        continue;
      }
      if (existing) {
        await execute(
          "UPDATE kiwify_transactions SET status='activated', user_id=$1, processed_at=NOW() WHERE kiwify_order_id=$2",
          [userId, orderId]
        );
      } else {
        await execute(
          `INSERT INTO kiwify_transactions
             (kiwify_order_id, kiwify_product_id, event_type, status, plan_id, user_id, customer_email, customer_name, amount_cents, processed_at, raw_payload)
           VALUES ($1, $2, 'compra_aprovada', 'activated', $3, $4, $5, $6, $7, NOW(), $8)`,
          [
            orderId,
            productId,
            planId,
            userId,
            customerEmail,
            String(sale.customer?.name ?? ""),
            sale.payment?.charge_amount ?? 0,
            JSON.stringify(sale),
          ]
        );
      }
      result.activated++;
    } catch (e) {
      result.errors.push(`Activate failed for order ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Process delayed downgrades for subscription_late after grace period.
  const graceDays = Math.max(0, Number(cfg.grace_period_days ?? 0));
  try {
    const lateRows = await query<{
      kiwify_order_id: string;
      late_created_at: string;
      user_id: string | null;
    }>(
      `SELECT DISTINCT ON (l.kiwify_order_id)
          l.kiwify_order_id,
          l.created_at AS late_created_at,
          COALESCE(
            l.user_id,
            (
              SELECT tx.user_id
                FROM kiwify_transactions tx
               WHERE tx.kiwify_order_id = l.kiwify_order_id
                 AND tx.user_id IS NOT NULL
               ORDER BY tx.created_at DESC
               LIMIT 1
            )
          ) AS user_id
       FROM kiwify_transactions l
      WHERE l.event_type = 'subscription_late'
        AND l.status = 'late'
      ORDER BY l.kiwify_order_id, l.created_at DESC`,
    );

    for (const late of lateRows) {
      const orderId = String(late.kiwify_order_id ?? "").trim();
      const userId = String(late.user_id ?? "").trim();
      const lateMs = Date.parse(String(late.late_created_at ?? ""));
      if (!orderId || !userId || !Number.isFinite(lateMs)) {
        result.skipped++;
        continue;
      }

      const graceDeadlineMs = lateMs + graceDays * DAY_MS;
      if (graceDeadlineMs > Date.now()) {
        result.skipped++;
        continue;
      }

      const alreadyDowngraded = await queryOne(
        `SELECT id
           FROM kiwify_transactions
          WHERE kiwify_order_id = $1
            AND event_type = 'grace_period_expired'
          LIMIT 1`,
        [orderId],
      );
      if (alreadyDowngraded) {
        result.skipped++;
        continue;
      }

      const recovered = await queryOne(
        `SELECT id
           FROM kiwify_transactions
          WHERE kiwify_order_id = $1
            AND created_at > $2::timestamptz
            AND event_type IN ('subscription_renewed', 'compra_aprovada', 'order_approved', 'approved', 'paid')
          LIMIT 1`,
        [orderId, new Date(lateMs).toISOString()],
      );
      if (recovered) {
        result.skipped++;
        continue;
      }

      try {
        const downgrade = await downgradeUserPlan(userId, "immediate", { source: "kiwify" });
        if (downgrade === "skipped_manual_override") {
          await execute(
            `INSERT INTO kiwify_transactions
               (id, user_id, kiwify_order_id, event_type, status, raw_payload, processed_at)
             VALUES ($1, $2, $3, 'grace_period_expired', 'manual_override_hold', $4, NOW())`,
            [
              uuid(),
              userId,
              orderId,
              JSON.stringify({
                source: "reconciler",
                reason: "subscription_late_grace_expired",
                skipped_due_to: "manual_override",
                grace_period_days: graceDays,
                late_event_created_at: new Date(lateMs).toISOString(),
              }),
            ],
          );
          result.skipped++;
          continue;
        }
        await execute(
          `INSERT INTO kiwify_transactions
             (id, user_id, kiwify_order_id, event_type, status, raw_payload, processed_at)
           VALUES ($1, $2, $3, 'grace_period_expired', 'downgraded', $4, NOW())`,
          [
            uuid(),
            userId,
            orderId,
            JSON.stringify({
              source: "reconciler",
              reason: "subscription_late_grace_expired",
              grace_period_days: graceDays,
              late_event_created_at: new Date(lateMs).toISOString(),
            }),
          ],
        );
        result.downgraded++;
      } catch (e) {
        result.errors.push(`Late downgrade failed for order ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    result.errors.push(`Late reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Log reconcile run
  try {
    await execute(
      `INSERT INTO kiwify_webhooks_log (event_type, kiwify_order_id, payload_hash, http_status_returned, processing_result, error_message)
       VALUES ('reconciler_run', 'reconciler', 'reconciler', 200, $1, $2)`,
      [
        result.errors.length === 0 ? "ok" : "error",
        result.errors.length > 0 ? result.errors.slice(0, 3).join("; ") : "",
      ]
    );
  } catch {
    // Non-critical log failure
  }

  console.log(
    `[kiwify-reconciler] window=${RECONCILE_WINDOW_DAYS}d checked=${result.checked} activated=${result.activated} downgraded=${result.downgraded} skipped=${result.skipped} errors=${result.errors.length}`
  );

  return result;
}

/**
 * Self-scheduling wrapper. Call once at startup to run daily reconciliation.
 * Runs immediately on first call, then every 24 hours.
 */
export function scheduleKiwifyReconciler() {
  const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const run = () => {
    runKiwifyReconciler().catch((e) => {
      console.error("[kiwify-reconciler] Unhandled error:", e instanceof Error ? e.message : e);
    });
  };

  // Delay first run by 60 seconds to let the server fully start
  const startDelay = setTimeout(() => {
    run();
    setInterval(run, RUN_INTERVAL_MS);
  }, 60 * 1000);

  // Return cleanup for graceful shutdown
  return () => clearTimeout(startDelay);
}
