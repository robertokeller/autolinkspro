import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { loadProjectEnv } from "../../../scripts/load-env.mjs";
import { ensureKiwifyE2eFixture } from "./kiwify-e2e-fixture.ts";

loadProjectEnv();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run() {
  const { queryOne, execute } = await import("../src/db.ts");
  const { handleKiwifyWebhook } = await import("../src/kiwify/webhook-handler.ts");

  const fixture = await ensureKiwifyE2eFixture();

  const userId = uuid();
  const profileId = uuid();
  const roleId = uuid();
  const now = Date.now();
  const orderId = `e2e-lifecycle-${now}-${uuid().slice(0, 8)}`;
  const email = `kiwify-e2e-${now}@autolinks.local`;
  const passwordHash = await bcrypt.hash(`E2e#${uuid()}`, 10);

  try {
    await execute(
      `INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, NOW(), NOW(), NOW())`,
      [userId, email, passwordHash],
    );
    await execute(
      `INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'plan-starter', NOW(), NOW(), NOW())`,
      [profileId, userId, "Kiwify Lifecycle E2E", email],
    );
    await execute(
      `INSERT INTO user_roles (id, user_id, role, created_at)
       VALUES ($1, $2, 'user', NOW())`,
      [roleId, userId],
    );

    const approvedPayload = {
      webhook_event_type: "order_approved",
      order_id: orderId,
      product_id: String(fixture.mapping.kiwify_product_id),
      payment_method: "pix",
      amount: 97,
      customer_email: email,
      customer_name: "Kiwify Lifecycle E2E",
    };
    const approved = await handleKiwifyWebhook(approvedPayload, fixture.webhookSecret);
    assert(approved.success, `order_approved failed: ${approved.message}`);

    const afterApproved = await queryOne<{ plan_id: string; plan_expires_at: string | null }>(
      "SELECT plan_id, plan_expires_at FROM profiles WHERE user_id = $1",
      [userId],
    );
    assert(afterApproved, "Profile not found after order_approved.");
    assert(String(afterApproved.plan_id) === String(fixture.mapping.plan_id), `Unexpected plan after order_approved: expected=${fixture.mapping.plan_id} current=${afterApproved.plan_id}`);
    const approvedExpiryMs = Date.parse(String(afterApproved.plan_expires_at ?? ""));
    assert(Number.isFinite(approvedExpiryMs), "Invalid plan_expires_at after order_approved.");
    assert(approvedExpiryMs > Date.now(), "plan_expires_at is not in the future after order_approved.");

    const renewedPayload = {
      webhook_event_type: "subscription_renewed",
      order_id: orderId,
      product_id: String(fixture.mapping.kiwify_product_id),
      customer_email: email,
      customer_name: "Kiwify Lifecycle E2E",
    };
    const renewed = await handleKiwifyWebhook(renewedPayload, fixture.webhookSecret);
    assert(renewed.success, `subscription_renewed failed: ${renewed.message}`);

    const afterRenewed = await queryOne<{ plan_id: string; plan_expires_at: string | null }>(
      "SELECT plan_id, plan_expires_at FROM profiles WHERE user_id = $1",
      [userId],
    );
    assert(afterRenewed, "Profile not found after subscription_renewed.");
    assert(String(afterRenewed.plan_id) === String(fixture.mapping.plan_id), `Unexpected plan after subscription_renewed: expected=${fixture.mapping.plan_id} current=${afterRenewed.plan_id}`);
    const renewedExpiryMs = Date.parse(String(afterRenewed.plan_expires_at ?? ""));
    assert(Number.isFinite(renewedExpiryMs), "Invalid plan_expires_at after subscription_renewed.");
    assert(renewedExpiryMs > approvedExpiryMs, "subscription_renewed did not extend plan_expires_at.");

    const canceledPayload = {
      webhook_event_type: "subscription_canceled",
      order_id: orderId,
      product_id: String(fixture.mapping.kiwify_product_id),
      customer_email: email,
      customer_name: "Kiwify Lifecycle E2E",
    };
    const canceled = await handleKiwifyWebhook(canceledPayload, fixture.webhookSecret);
    assert(canceled.success, `subscription_canceled failed: ${canceled.message}`);

    const afterCanceled = await queryOne<{ plan_id: string; plan_expires_at: string | null }>(
      "SELECT plan_id, plan_expires_at FROM profiles WHERE user_id = $1",
      [userId],
    );
    assert(afterCanceled, "Profile not found after subscription_canceled.");
    assert(String(afterCanceled.plan_id) === "plan-starter", `Unexpected plan after cancellation: expected=plan-starter current=${afterCanceled.plan_id}`);
    const canceledExpiryMs = Date.parse(String(afterCanceled.plan_expires_at ?? ""));
    assert(Number.isFinite(canceledExpiryMs), "Invalid plan_expires_at after subscription_canceled.");
    assert(canceledExpiryMs <= Date.now() + 60_000, "Cancellation did not revoke access immediately.");

    const cancelTx = await queryOne<{ status: string }>(
      "SELECT status FROM kiwify_transactions WHERE kiwify_order_id = $1 AND event_type = 'subscription_canceled' ORDER BY created_at DESC LIMIT 1",
      [orderId],
    );
    assert(cancelTx, "Cancellation transaction was not recorded.");

    console.log("[kiwify-lifecycle-e2e] flow validated successfully.");
    console.log(JSON.stringify({
      order_id: orderId,
      user_id: userId,
      mapped_plan_id: fixture.mapping.plan_id,
      mapped_period_type: fixture.mapping.period_type,
      approved_expiry: new Date(approvedExpiryMs).toISOString(),
      renewed_expiry: new Date(renewedExpiryMs).toISOString(),
      canceled_plan_id: afterCanceled.plan_id,
      canceled_expiry: new Date(canceledExpiryMs).toISOString(),
      cancel_tx_status: cancelTx.status,
    }, null, 2));
  } finally {
    await execute("DELETE FROM kiwify_webhooks_log WHERE kiwify_order_id = $1", [orderId]);
    await execute("DELETE FROM kiwify_transactions WHERE kiwify_order_id = $1", [orderId]);
    await execute("DELETE FROM user_roles WHERE user_id = $1", [userId]);
    await execute("DELETE FROM profiles WHERE user_id = $1", [userId]);
    await execute("DELETE FROM users WHERE id = $1", [userId]);
    await fixture.cleanup();
  }
}

run().catch((error) => {
  console.error("[kiwify-lifecycle-e2e] error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
