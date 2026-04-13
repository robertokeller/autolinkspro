import { execute, query, queryOne } from "../db.js";
import { extractKiwifyPeriodTypeHint, findPlanByKiwifyProduct } from "./client.js";
import { activateUserPlan } from "./webhook-handler.js";

export interface KiwifyTransactionListInput {
  page?: unknown;
  limit?: unknown;
  status?: unknown;
  event_type?: unknown;
  customer_email?: unknown;
  plan_id?: unknown;
}

export async function listKiwifyTransactions(input: KiwifyTransactionListInput): Promise<{
  transactions: unknown[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, Number(input.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
  const offset = (page - 1) * limit;
  const filters: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.status) { filters.push(`status = $${idx++}`); values.push(String(input.status)); }
  if (input.event_type) { filters.push(`event_type = $${idx++}`); values.push(String(input.event_type)); }
  if (input.customer_email) { filters.push(`LOWER(customer_email) LIKE $${idx++}`); values.push(`%${String(input.customer_email).toLowerCase()}%`); }
  if (input.plan_id) { filters.push(`plan_id = $${idx++}`); values.push(String(input.plan_id)); }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await query(
    `SELECT * FROM kiwify_transactions ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM kiwify_transactions ${where}`,
    values,
  );

  return {
    transactions: rows,
    total: Number(countRow?.total ?? 0),
    page,
    limit,
  };
}

export async function linkKiwifyTransactionToUser(input: {
  transactionId: string;
  targetUserId: string;
}): Promise<{ planId: string }> {
  const txId = String(input.transactionId ?? "").trim();
  const targetUserId = String(input.targetUserId ?? "").trim();
  if (!txId || !targetUserId) {
    throw new Error("transaction_id e user_id obrigatórios");
  }

  const tx = await queryOne<{ plan_id: string | null; kiwify_product_id: string | null; raw_payload: unknown }>(
    "SELECT plan_id, kiwify_product_id, raw_payload FROM kiwify_transactions WHERE id = $1",
    [txId],
  );
  if (!tx) throw new Error("Transação não encontrada");

  const productId = String(tx.kiwify_product_id ?? "").trim();
  const periodHint = extractKiwifyPeriodTypeHint(tx.raw_payload) ?? undefined;
  const mapping = productId ? await findPlanByKiwifyProduct(productId, periodHint) : null;
  const currentPlanId = String(tx.plan_id ?? "").trim();
  const resolvedPlanId = currentPlanId || String(mapping?.plan_id ?? "").trim();
  if (!resolvedPlanId) {
    throw new Error("Nao foi possivel resolver o plano da transacao. Ajuste o mapeamento Kiwify e tente novamente.");
  }

  await activateUserPlan(
    targetUserId,
    resolvedPlanId,
    mapping?.period_type ?? periodHint,
    "replace",
    { source: "admin", force: true },
  );

  await execute(
    `UPDATE kiwify_transactions
        SET user_id = $1,
            plan_id = CASE WHEN COALESCE(plan_id, '') = '' THEN $2 ELSE plan_id END,
            status = 'activated',
            processed_at = NOW()
      WHERE id = $3`,
    [targetUserId, resolvedPlanId, txId],
  );

  return { planId: resolvedPlanId };
}

