/**
 * Kiwify Webhook Handler — processes incoming webhook events
 * Handles: compra_aprovada, compra_reembolsada, chargeback,
 *   subscription_canceled, subscription_late, subscription_renewed,
 *   compra_recusada, boleto_gerado, pix_gerado, carrinho_abandonado
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { query, queryOne, execute } from "../db.js";
import {
  loadKiwifyConfig,
  findPlanByKiwifyProduct,
  hashPayload,
  type KiwifyConfig,
} from "./client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KiwifyWebhookPayload {
  order_id?: string;
  order_ref?: string;
  order_status?:
    | "approved"
    | "paid"
    | "refunded"
    | "chargedback"
    | "refused"
    | "waiting_payment"
    | "pending";
  product_id?: string;
  product_name?: string;
  payment_method?: string;
  Customer?: {
    full_name?: string;
    email?: string;
    mobile?: string;
    CPF?: string;
  };
  // Alternate shapes (Kiwify may send different field names)
  customer_email?: string;
  customer_name?: string;
  Subscription?: {
    id?: string;
    status?: string;
    plan?: { id?: string; name?: string };
    start_date?: string;
    next_payment?: string;
  };
  subscription_id?: string;
  approved_date?: string;
  sale_type?: string;
  amount?: number;
  // Capitalized objects sent by Kiwify webhook (real payload shape)
  Product?: {
    id?: string;
    name?: string;
  };
  Payment?: {
    charge_amount?: number; // Already in centavos (e.g., 9700 = R$97.00)
    charge_currency?: string;
  };
  Commissions?: {
    affiliate_id?: string;
    affiliate_name?: string;
    affiliate_email?: string;
    amount?: number;
    currency?: string;
  };
  TrackingParameters?: {
    src?: string;
    sck?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
  };
  webhook_event_type?: string;
  [key: string]: unknown;
}

export interface WebhookResult {
  success: boolean;
  message: string;
  transactionId?: string;
}

// ─── Token verification ─────────────────────────────────────────────────────

export function verifyWebhookToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Constant-time: hash both to fixed-length for timing safety
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
  }
  return timingSafeEqual(a, b);
}

// ─── Idempotency check ─────────────────────────────────────────────────────

async function wasAlreadyProcessed(payloadHash: string, orderId: string, eventType: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT id FROM kiwify_webhooks_log WHERE payload_hash = $1 AND kiwify_order_id = $2 AND event_type = $3 LIMIT 1`,
    [payloadHash, orderId, eventType]
  );
  return !!row;
}

async function logWebhookEvent(
  eventType: string,
  orderId: string,
  payloadHash: string,
  httpStatus: number,
  result: string,
  errorMsg: string,
): Promise<void> {
  await execute(
    `INSERT INTO kiwify_webhooks_log (id, event_type, kiwify_order_id, payload_hash, http_status_returned, processing_result, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuid(), eventType, orderId, payloadHash, httpStatus, result, errorMsg]
  );
}

// ─── Helper: extract fields from varying webhook payloads ───────────────────

function extractCustomerEmail(payload: KiwifyWebhookPayload): string {
  return String(
    payload.Customer?.email ?? payload.customer_email ?? ""
  ).toLowerCase().trim();
}

function extractCustomerName(payload: KiwifyWebhookPayload): string {
  return String(payload.Customer?.full_name ?? payload.customer_name ?? "").trim();
}

function extractCustomerCpf(payload: KiwifyWebhookPayload): string {
  return String(payload.Customer?.CPF ?? "").replace(/\D/g, "");
}

function maskCustomerCpf(payload: KiwifyWebhookPayload): string {
  const digits = extractCustomerCpf(payload);
  if (!digits) return "";
  if (digits.length <= 4) return digits;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function sanitizeStoredWebhookPayload(payload: KiwifyWebhookPayload): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;

  delete cloned.token;
  delete cloned.webhook_token;
  delete cloned.customer_email;
  delete cloned.customer_name;

  const customer = cloned.Customer && typeof cloned.Customer === "object" && !Array.isArray(cloned.Customer)
    ? cloned.Customer as Record<string, unknown>
    : null;
  if (customer) {
    delete customer.email;
    delete customer.full_name;
    delete customer.mobile;
    delete customer.CPF;
  }

  const commissions = cloned.Commissions && typeof cloned.Commissions === "object" && !Array.isArray(cloned.Commissions)
    ? cloned.Commissions as Record<string, unknown>
    : null;
  if (commissions) {
    delete commissions.affiliate_email;
  }

  return cloned;
}

function extractOrderId(payload: KiwifyWebhookPayload): string {
  return String(payload.order_id ?? "").trim();
}

function extractProductId(payload: KiwifyWebhookPayload): string {
  // Kiwify sends product as either flat `product_id` or nested `Product.id`
  return String(payload.product_id ?? payload.Product?.id ?? "").trim();
}

function extractAmount(payload: KiwifyWebhookPayload): number {
  // Real Kiwify webhook: Payment.charge_amount is already in centavos (e.g. 9700 = R$97.00)
  if (typeof payload.Payment?.charge_amount === "number") {
    return Math.round(payload.Payment.charge_amount); // already cents
  }
  // Fallback: top-level `amount` is a BRL float (e.g. 97.00) → convert to cents
  const raw = typeof payload.amount === "number" ? payload.amount : 0;
  return Math.round(raw * 100);
}

function extractTrackingData(payload: KiwifyWebhookPayload): Record<string, string | null> {
  const t = payload.TrackingParameters ?? {};
  return {
    src: t.src ?? null,
    sck: t.sck ?? null,
    utm_source: t.utm_source ?? null,
    utm_medium: t.utm_medium ?? null,
    utm_campaign: t.utm_campaign ?? null,
    utm_content: t.utm_content ?? null,
    utm_term: t.utm_term ?? null,
  };
}

function extractAffiliateData(payload: KiwifyWebhookPayload) {
  const c = payload.Commissions;
  return {
    affiliate_id: String(c?.affiliate_id ?? ""),
    affiliate_name: String(c?.affiliate_name ?? ""),
    affiliate_commission_cents: typeof c?.amount === "number" ? c.amount : 0,
  };
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function handleKiwifyWebhook(
  payload: KiwifyWebhookPayload,
  webhookToken: string,
): Promise<WebhookResult> {
  // 1. Load config & verify token
  const config = await loadKiwifyConfig();
  if (!config) {
    return { success: false, message: "Kiwify integration not configured" };
  }

  if (!verifyWebhookToken(webhookToken, config.webhook_secret)) {
    return { success: false, message: "Invalid webhook token" };
  }

  // 2. Identify event type
  const eventType = String(
    payload.webhook_event_type ?? payload.order_status ?? ""
  ).toLowerCase().trim();

  if (!eventType) {
    return { success: false, message: "Missing event type" };
  }

  const orderId = extractOrderId(payload);
  if (!orderId) {
    return { success: false, message: "Missing order_id" };
  }

  // 3. Idempotency
  const payHash = hashPayload(payload);
  if (await wasAlreadyProcessed(payHash, orderId, eventType)) {
    return { success: true, message: "Already processed (idempotent)" };
  }

  // 4. Dispatch by event type
  try {
    let result: WebhookResult;

    switch (eventType) {
      // Real Kiwify webhook_event_type values (English) + Portuguese trigger names
      case "order_approved":
      case "compra_aprovada":
      case "approved":
      case "paid":
        result = await handlePurchaseApproved(payload, config);
        break;
      case "order_refunded":
      case "compra_reembolsada":
      case "refunded":
        result = await handleRefund(payload, orderId);
        break;
      case "chargeback":
      case "chargedback":
        result = await handleChargeback(payload, orderId);
        break;
      case "subscription_renewed":
        result = await handleSubscriptionRenewed(payload, config);
        break;
      case "subscription_canceled":
        result = await handleSubscriptionCanceled(payload, orderId);
        break;
      case "subscription_late":
        result = await handleSubscriptionLate(payload, orderId, config);
        break;
      case "compra_recusada":
      case "refused":
        result = await handleInfoEvent(payload, orderId, eventType);
        break;
      case "boleto_gerado":
      case "pix_gerado":
      case "carrinho_abandonado":
      case "waiting_payment":
        result = await handleInfoEvent(payload, orderId, eventType);
        break;
      default:
        result = await handleInfoEvent(payload, orderId, eventType);
        break;
    }

    await logWebhookEvent(eventType, orderId, payHash, 200, result.success ? "ok" : "error", result.success ? "" : result.message);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[kiwify-webhook] Error processing ${eventType} for order ${orderId}:`, msg);
    await logWebhookEvent(eventType, orderId, payHash, 500, "exception", msg);
    return { success: false, message: msg };
  }
}

// ─── Event handlers ─────────────────────────────────────────────────────────

async function handlePurchaseApproved(
  payload: KiwifyWebhookPayload,
  config: KiwifyConfig,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const orderId = extractOrderId(payload);
  const productId = extractProductId(payload);

  if (!email) return { success: false, message: "Customer email missing" };

  // Map product → plan
  const mapping = productId ? await findPlanByKiwifyProduct(productId) : null;
  const planId = mapping?.plan_id ?? "";

  // Find user by email
  const user = await queryOne("SELECT u.id FROM users u WHERE LOWER(u.email) = $1", [email]);

  const affiliate = extractAffiliateData(payload);
  const tracking = extractTrackingData(payload);
  const txId = uuid();
  const status = user ? "activated" : "pending_activation";
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  // Record transaction
  await execute(
    `INSERT INTO kiwify_transactions (id, user_id, kiwify_order_id, kiwify_product_id, plan_id, event_type,
     status, amount_cents, payment_method, customer_email, customer_name, customer_cpf,
     affiliate_id, affiliate_name, affiliate_commission_cents, tracking_data, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      txId,
      user?.id ?? null,
      orderId,
      productId,
      planId,
      "compra_aprovada",
      status,
      extractAmount(payload),
      String(payload.payment_method ?? ""),
      email,
      extractCustomerName(payload),
      maskCustomerCpf(payload),
      affiliate.affiliate_id,
      affiliate.affiliate_name,
      affiliate.affiliate_commission_cents,
      JSON.stringify(tracking),
      JSON.stringify(storedPayload),
      user ? new Date().toISOString() : null,
    ]
  );

  // Activate plan for existing user
  if (user && planId) {
    await activateUserPlan(user.id, planId, mapping?.period_type ?? undefined);
    return {
      success: true,
      message: `Plan ${planId} activated for user ${email}`,
      transactionId: txId,
    };
  }

  if (!user) {
    return {
      success: true,
      message: `Transaction saved as pending_activation for ${email}. Plan will activate on signup.`,
      transactionId: txId,
    };
  }

  return {
    success: true,
    message: `Transaction recorded (no plan mapping for product ${productId})`,
    transactionId: txId,
  };
}

async function handleRefund(
  payload: KiwifyWebhookPayload,
  orderId: string,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const txId = uuid();
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  // Record refund transaction
  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     amount_cents, payment_method, customer_email, customer_name, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [
      txId, orderId, extractProductId(payload), "compra_reembolsada", "refunded",
      extractAmount(payload), String(payload.payment_method ?? ""),
      email, extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  // Find the original purchase and downgrade user
  const originalTx = await queryOne(
    `SELECT user_id FROM kiwify_transactions WHERE kiwify_order_id = $1 AND event_type = 'compra_aprovada' AND user_id IS NOT NULL LIMIT 1`,
    [orderId]
  );

  if (originalTx?.user_id) {
    await downgradeUserPlan(originalTx.user_id);
    return { success: true, message: `User downgraded due to refund on order ${orderId}`, transactionId: txId };
  }

  return { success: true, message: `Refund recorded for order ${orderId} (no linked user)`, transactionId: txId };
}

async function handleChargeback(
  payload: KiwifyWebhookPayload,
  orderId: string,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const txId = uuid();
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     amount_cents, customer_email, customer_name, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      txId, orderId, extractProductId(payload), "chargeback", "chargedback",
      extractAmount(payload), email, extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  const originalTx = await queryOne(
    `SELECT user_id FROM kiwify_transactions WHERE kiwify_order_id = $1 AND event_type = 'compra_aprovada' AND user_id IS NOT NULL LIMIT 1`,
    [orderId]
  );

  if (originalTx?.user_id) {
    await downgradeUserPlan(originalTx.user_id);
    return { success: true, message: `User downgraded due to chargeback on order ${orderId}`, transactionId: txId };
  }

  return { success: true, message: `Chargeback recorded for order ${orderId}`, transactionId: txId };
}

async function handleSubscriptionRenewed(
  payload: KiwifyWebhookPayload,
  config: KiwifyConfig,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const orderId = extractOrderId(payload);
  const productId = extractProductId(payload);
  const txId = uuid();
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     amount_cents, customer_email, customer_name, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      txId, orderId, productId, "subscription_renewed", "renewed",
      extractAmount(payload), email, extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  // Extend user's plan_expires_at
  if (email) {
    const user = await queryOne("SELECT u.id FROM users u WHERE LOWER(u.email) = $1", [email]);
    if (user) {
      const mapping = productId ? await findPlanByKiwifyProduct(productId) : null;
      if (mapping?.plan_id) {
        await activateUserPlan(user.id, mapping.plan_id, mapping.period_type ?? undefined);
        return { success: true, message: `Subscription renewed for ${email}`, transactionId: txId };
      }
    }
  }

  return { success: true, message: `Subscription renewal recorded for order ${orderId}`, transactionId: txId };
}

async function handleSubscriptionCanceled(
  payload: KiwifyWebhookPayload,
  orderId: string,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const txId = uuid();
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     customer_email, customer_name, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      txId, orderId, extractProductId(payload), "subscription_canceled", "canceled",
      email, extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  // Note: We do NOT downgrade immediately. User keeps access until plan_expires_at.
  return { success: true, message: `Subscription cancellation recorded for ${email}. Access maintained until plan expiry.`, transactionId: txId };
}

async function handleSubscriptionLate(
  payload: KiwifyWebhookPayload,
  orderId: string,
  config: KiwifyConfig,
): Promise<WebhookResult> {
  const email = extractCustomerEmail(payload);
  const txId = uuid();
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     customer_email, customer_name, raw_payload, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      txId, orderId, extractProductId(payload), "subscription_late", "late",
      email, extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  // Grace period: do not downgrade yet. The reconciler job will handle it after grace_period_days.
  return {
    success: true,
    message: `Subscription late recorded for ${email}. Grace period: ${config.grace_period_days} days.`,
    transactionId: txId,
  };
}

async function handleInfoEvent(
  payload: KiwifyWebhookPayload,
  orderId: string,
  eventType: string,
): Promise<WebhookResult> {
  const storedPayload = sanitizeStoredWebhookPayload(payload);

  await execute(
    `INSERT INTO kiwify_transactions (id, kiwify_order_id, kiwify_product_id, event_type, status,
     amount_cents, customer_email, customer_name, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      uuid(), orderId, extractProductId(payload), eventType, eventType,
      extractAmount(payload), extractCustomerEmail(payload),
      extractCustomerName(payload), JSON.stringify(storedPayload),
    ]
  );

  return { success: true, message: `Event ${eventType} logged for order ${orderId}` };
}

// ─── Plan activation / downgrade helpers ────────────────────────────────────

const PERIOD_TYPE_DAYS: Record<string, number> = {
  monthly: 30,
  quarterly: 90,
  semiannual: 180,
  annual: 365,
};

export async function activateUserPlan(userId: string, planId: string, periodType?: string): Promise<void> {
  // Use explicit period_type if provided, otherwise fall back to plan_id naming convention
  let periodMs: number;
  if (periodType && PERIOD_TYPE_DAYS[periodType]) {
    periodMs = PERIOD_TYPE_DAYS[periodType] * 24 * 60 * 60 * 1000;
  } else if (planId.includes("annual")) {
    // Backward compat: old annual plan IDs
    periodMs = 365 * 24 * 60 * 60 * 1000;
  } else if (planId === "plan-starter") {
    periodMs = 7 * 24 * 60 * 60 * 1000;
  } else {
    periodMs = 30 * 24 * 60 * 60 * 1000;
  }

  const expiresAt = new Date(Date.now() + periodMs).toISOString();

  await execute(
    "UPDATE profiles SET plan_id=$1, plan_expires_at=$2, updated_at=NOW() WHERE user_id=$3",
    [planId, expiresAt, userId]
  );
}

async function downgradeUserPlan(userId: string): Promise<void> {
  await execute(
    "UPDATE profiles SET plan_id='plan-starter', plan_expires_at=NULL, updated_at=NOW() WHERE user_id=$1",
    [userId]
  );
}

// ─── Pending activation: call on user signup ────────────────────────────────

export async function activatePendingKiwifyPurchases(userId: string, email: string): Promise<number> {
  const pending = await query(
    `SELECT id, plan_id, kiwify_order_id FROM kiwify_transactions
     WHERE LOWER(customer_email) = $1 AND status = 'pending_activation' AND plan_id != ''
     ORDER BY created_at DESC`,
    [email.toLowerCase().trim()]
  );

  if (!pending.length) return 0;

  let activated = 0;

  for (const tx of pending) {
    const planId = String(tx.plan_id);
    if (!planId) continue;

    // Look up period_type from the product mapping for correct expiry calculation
    const productId = String(tx.kiwify_product_id ?? "");
    const mapping = productId ? await findPlanByKiwifyProduct(productId) : null;
    await activateUserPlan(userId, planId, mapping?.period_type ?? undefined);
    await execute(
      "UPDATE kiwify_transactions SET user_id=$1, status='activated', processed_at=NOW() WHERE id=$2",
      [userId, tx.id]
    );
    activated++;
    // Only activate the most recent purchase (highest priority plan)
    break;
  }

  return activated;
}
