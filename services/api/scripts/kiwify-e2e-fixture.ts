import { v4 as uuid } from "uuid";

type KiwifyMapping = {
  plan_id: string;
  period_type: string;
  kiwify_product_id: string;
};

type EnsureFixtureResult = {
  mapping: KiwifyMapping;
  webhookSecret: string;
  cleanup: () => Promise<void>;
};

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function ensureKiwifyE2eFixture(): Promise<EnsureFixtureResult> {
  const allowBootstrap = isTruthy(String(process.env.KIWIFY_E2E_ALLOW_TEMP_BOOTSTRAP ?? "false"));

  const { queryOne, execute } = await import("../src/db.ts");
  const {
    clearKiwifyConfigCache,
    deletePlanMapping,
    loadKiwifyConfig,
    saveKiwifyConfig,
    savePlanMapping,
  } = await import("../src/kiwify/client.ts");

  let createdConfig = false;
  let createdConfigRef: { id: string; accountId: string } | null = null;
  let createdMapping: { planId: string; periodType: string } | null = null;

  let config = await loadKiwifyConfig();
  if (!config?.client_id || !config?.webhook_secret) {
    if (!allowBootstrap) {
      throw new Error(
        "Kiwify não configurado (client_id/webhook_secret ausentes). Defina KIWIFY_E2E_ALLOW_TEMP_BOOTSTRAP=true para fixture temporário.",
      );
    }

    const seed = `${Date.now()}-${uuid().slice(0, 8)}`;
    await saveKiwifyConfig({
      account_id: `e2e-account-${seed}`,
      client_id: `e2e-client-${seed}`,
      client_secret: `e2e-secret-${uuid()}`,
      webhook_secret: `e2e-webhook-${uuid()}`,
      affiliate_enabled: false,
      grace_period_days: 3,
    });
    clearKiwifyConfigCache();
    createdConfig = true;
    config = await loadKiwifyConfig();
    if (config?.id) {
      createdConfigRef = {
        id: config.id,
        accountId: config.account_id,
      };
    }
  }

  if (!config?.webhook_secret) {
    throw new Error("Falha ao carregar webhook_secret da Kiwify para o teste E2E.");
  }

  let mapping = await queryOne<KiwifyMapping>(
    "SELECT plan_id, period_type, kiwify_product_id FROM kiwify_plan_mappings WHERE is_active = TRUE ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  );

  if (!mapping?.plan_id || !mapping?.kiwify_product_id) {
    if (!allowBootstrap) {
      throw new Error(
        "Nenhum mapping ativo encontrado em kiwify_plan_mappings. Defina KIWIFY_E2E_ALLOW_TEMP_BOOTSTRAP=true para fixture temporário.",
      );
    }

    const seed = `${Date.now()}-${uuid().slice(0, 8)}`;
    const planId = `plan-e2e-${seed}`;
    const periodType = "monthly";
    const productId = `e2e-product-${seed}`;

    await savePlanMapping({
      plan_id: planId,
      period_type: periodType,
      kiwify_product_id: productId,
      kiwify_product_name: "E2E Temporary Product",
      kiwify_checkout_url: `https://checkout.kiwify.com.br/e2e-${seed}`,
      affiliate_enabled: false,
      affiliate_commission_percent: 0,
      is_active: true,
    });

    createdMapping = { planId, periodType };
    mapping = {
      plan_id: planId,
      period_type: periodType,
      kiwify_product_id: productId,
    };
  }

  const cleanup = async () => {
    if (createdMapping) {
      await deletePlanMapping(createdMapping.planId, createdMapping.periodType);
    }

    if (createdConfig && createdConfigRef) {
      await execute(
        "DELETE FROM kiwify_config WHERE id = $1 AND account_id = $2",
        [createdConfigRef.id, createdConfigRef.accountId],
      );
      clearKiwifyConfigCache();
    }
  };

  return {
    mapping,
    webhookSecret: config.webhook_secret,
    cleanup,
  };
}
