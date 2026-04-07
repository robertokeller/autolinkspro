/**
 * Kiwify Reconciler
 * Runs daily to compare Kiwify sales with local kiwify_transactions records.
 * Detects missing activations, discrepancies, and logs them for admin review.
 * Called from the scheduler or a PM2 cron process.
 */

import { queryOne, execute } from "../db.js";
import { loadKiwifyConfig, kiwifyListSales, type KiwifySale } from "./client.js";
import { activateUserPlan } from "./webhook-handler.js";

const RECONCILE_WINDOW_DAYS = 7;

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
  skipped: number;
  errors: string[];
}

export async function runKiwifyReconciler(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, activated: 0, skipped: 0, errors: [] };

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

    // Find the plan mapping for this product
    const mapping = await queryOne(
      "SELECT plan_id FROM kiwify_plan_mappings WHERE kiwify_product_id = $1 AND is_active = TRUE LIMIT 1",
      [productId]
    );

    if (!mapping) {
      result.skipped++;
      continue; // No known plan mapping
    }

    const planId = String(mapping.plan_id);

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
               (kiwify_order_id, event_type, status, plan_id, customer_email, customer_name, amount_cents, raw_payload)
             VALUES ($1, 'purchase_approved', 'pending_activation', $2, $3, $4, $5, $6)`,
            [
              orderId,
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
      await activateUserPlan(userId, planId);
      if (existing) {
        await execute(
          "UPDATE kiwify_transactions SET status='activated', user_id=$1, processed_at=NOW() WHERE kiwify_order_id=$2",
          [userId, orderId]
        );
      } else {
        await execute(
          `INSERT INTO kiwify_transactions
             (kiwify_order_id, event_type, status, plan_id, user_id, customer_email, customer_name, amount_cents, processed_at, raw_payload)
           VALUES ($1, 'purchase_approved', 'activated', $2, $3, $4, $5, $6, NOW(), $7)`,
          [
            orderId,
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
    `[kiwify-reconciler] window=${RECONCILE_WINDOW_DAYS}d checked=${result.checked} activated=${result.activated} skipped=${result.skipped} errors=${result.errors.length}`
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
