import { loadProjectEnv } from "../../../scripts/load-env.mjs";

loadProjectEnv();

type MappingInput = {
  plan_id: string;
  period_type: "monthly" | "quarterly" | "semiannual" | "annual";
  kiwify_product_id: string;
  kiwify_product_name?: string;
  kiwify_checkout_url: string;
  affiliate_enabled?: boolean;
  affiliate_commission_percent?: number;
  is_active?: boolean;
};

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function envNumber(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) ? n : fallback;
}

function parseMappings(raw: string): MappingInput[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("KIWIFY_PLAN_MAPPINGS_JSON deve ser um array JSON.");
  }

  const validPeriods = new Set(["monthly", "quarterly", "semiannual", "annual"]);

  return parsed.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const planId = String(row.plan_id || "").trim();
    const periodType = String(row.period_type || "monthly").trim() as MappingInput["period_type"];
    const productId = String(row.kiwify_product_id || "").trim();
    const checkoutUrl = String(row.kiwify_checkout_url || "").trim();

    if (!planId || !productId || !checkoutUrl) {
      throw new Error(`Mapping index ${index} inválido: plan_id, kiwify_product_id e kiwify_checkout_url são obrigatórios.`);
    }
    if (!validPeriods.has(periodType)) {
      throw new Error(`Mapping index ${index} inválido: period_type '${periodType}' não suportado.`);
    }

    return {
      plan_id: planId,
      period_type: periodType,
      kiwify_product_id: productId,
      kiwify_product_name: String(row.kiwify_product_name || "").trim(),
      kiwify_checkout_url: checkoutUrl,
      affiliate_enabled: row.affiliate_enabled === true,
      affiliate_commission_percent: Number(row.affiliate_commission_percent ?? 0),
      is_active: row.is_active !== false,
    };
  });
}

async function run() {
  const {
    KIWIFY_WEBHOOK_TRIGGERS,
    clearKiwifyConfigCache,
    kiwifyCreateWebhook,
    kiwifyGetAccountDetails,
    kiwifyListWebhooks,
    loadKiwifyConfig,
    saveKiwifyConfig,
    savePlanMapping,
  } = await import("../src/kiwify/client.ts");

  const accountId = env("KIWIFY_ACCOUNT_ID");
  const clientId = env("KIWIFY_CLIENT_ID");
  const clientSecret = env("KIWIFY_CLIENT_SECRET");
  const webhookSecret = env("KIWIFY_WEBHOOK_SECRET");
  const webhookUrl = env("KIWIFY_WEBHOOK_URL") || `${env("VITE_API_URL")}/webhooks/kiwify`;
  const webhookName = env("KIWIFY_WEBHOOK_NAME") || "AutoLinks Webhook";
  const affiliateEnabled = envBool("KIWIFY_AFFILIATE_ENABLED", false);
  const gracePeriodDays = Math.max(0, Math.min(30, envNumber("KIWIFY_GRACE_PERIOD_DAYS", 3)));
  const mappings = parseMappings(env("KIWIFY_PLAN_MAPPINGS_JSON"));

  const missing: string[] = [];
  if (!accountId) missing.push("KIWIFY_ACCOUNT_ID");
  if (!clientId) missing.push("KIWIFY_CLIENT_ID");
  if (!clientSecret) missing.push("KIWIFY_CLIENT_SECRET");
  if (!webhookSecret) missing.push("KIWIFY_WEBHOOK_SECRET");

  if (missing.length > 0) {
    throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(", ")}`);
  }

  await saveKiwifyConfig({
    account_id: accountId,
    client_id: clientId,
    client_secret: clientSecret,
    webhook_secret: webhookSecret,
    affiliate_enabled: affiliateEnabled,
    grace_period_days: gracePeriodDays,
  });

  clearKiwifyConfigCache();
  const cfg = await loadKiwifyConfig();
  if (!cfg) throw new Error("Falha ao carregar configuração salva da Kiwify.");

  if (mappings.length === 0) {
    console.warn("[kiwify-bootstrap] Sem mappings no KIWIFY_PLAN_MAPPINGS_JSON. Checkout e ativação automática seguirão indisponíveis até mapear produtos.");
  }

  for (const mapping of mappings) {
    await savePlanMapping({
      plan_id: mapping.plan_id,
      period_type: mapping.period_type,
      kiwify_product_id: mapping.kiwify_product_id,
      kiwify_product_name: mapping.kiwify_product_name || "",
      kiwify_checkout_url: mapping.kiwify_checkout_url,
      affiliate_enabled: mapping.affiliate_enabled === true,
      affiliate_commission_percent: Number.isFinite(mapping.affiliate_commission_percent)
        ? Number(mapping.affiliate_commission_percent)
        : 0,
      is_active: mapping.is_active !== false,
    });
  }

  const account = await kiwifyGetAccountDetails(cfg);
  console.log("[kiwify-bootstrap] conexão com API Kiwify OK:");
  console.log(JSON.stringify({ account_id: account?.id || accountId }, null, 2));

  if (webhookUrl && /^https:\/\//i.test(webhookUrl)) {
    const existing = await kiwifyListWebhooks(cfg);
    const rows = Array.isArray(existing?.data) ? existing.data : [];
    const already = rows.find((row) => String(row.url || "").trim() === webhookUrl);

    if (!already) {
      const created = await kiwifyCreateWebhook(cfg, {
        name: webhookName,
        url: webhookUrl,
        products: "all",
        triggers: [...KIWIFY_WEBHOOK_TRIGGERS],
        token: cfg.webhook_secret,
      });
      console.log("[kiwify-bootstrap] webhook criado:", created.id);
    } else {
      console.log("[kiwify-bootstrap] webhook já existente:", already.id);
    }
  } else {
    console.warn("[kiwify-bootstrap] KIWIFY_WEBHOOK_URL inválido ou ausente. Webhook não foi provisionado automaticamente.");
  }

  console.log("[kiwify-bootstrap] bootstrap concluído.");
}

run().catch((error) => {
  console.error("[kiwify-bootstrap] erro:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
