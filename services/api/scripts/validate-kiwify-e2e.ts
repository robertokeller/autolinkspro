import { v4 as uuid } from "uuid";
import { loadProjectEnv } from "../../../scripts/load-env.mjs";
import { ensureKiwifyE2eFixture } from "./kiwify-e2e-fixture.ts";

loadProjectEnv();

async function run() {
  const { queryOne } = await import("../src/db.ts");
  const { handleKiwifyWebhook } = await import("../src/kiwify/webhook-handler.ts");

  const fixture = await ensureKiwifyE2eFixture();
  const orderId = `smoke-${Date.now()}-${uuid().slice(0, 8)}`;

  try {
    const payload = {
      webhook_event_type: "order_approved",
      order_id: orderId,
      product_id: String(fixture.mapping.kiwify_product_id),
      payment_method: "pix",
      amount: 97,
      customer_email: `kiwify-smoke-${Date.now()}@autolinks.local`,
      customer_name: "Kiwify Smoke Test",
    };

    const result = await handleKiwifyWebhook(payload, fixture.webhookSecret);
    if (!result.success) {
      throw new Error(`Webhook smoke failed: ${result.message}`);
    }

    const tx = await queryOne<{ status: string; plan_id: string; event_type: string }>(
      "SELECT status, plan_id, event_type FROM kiwify_transactions WHERE kiwify_order_id = $1 ORDER BY created_at DESC LIMIT 1",
      [orderId],
    );

    if (!tx) {
      throw new Error("Smoke test transaction was not persisted.");
    }

    console.log("[kiwify-e2e] webhook processed successfully.");
    console.log(JSON.stringify({
      order_id: orderId,
      expected_plan_id: fixture.mapping.plan_id,
      expected_period_type: fixture.mapping.period_type,
      tx_status: tx.status,
      tx_plan_id: tx.plan_id,
      tx_event_type: tx.event_type,
    }, null, 2));
  } finally {
    await fixture.cleanup();
  }
}

run().catch((error) => {
  console.error("[kiwify-e2e] error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
