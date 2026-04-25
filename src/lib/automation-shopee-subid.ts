import type { Json } from "@/integrations/backend/types";
import { normalizeShopeeSubId } from "@/lib/shopee-subid";

const AUTOMATION_SHOPEE_SUB_ID_CONFIG_KEY = "shopeeSubId";

export function readAutomationShopeeSubId(config: unknown): string {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};

  return normalizeShopeeSubId(source[AUTOMATION_SHOPEE_SUB_ID_CONFIG_KEY]);
}

export function mergeAutomationShopeeSubIdConfig(config: unknown, shopeeSubId?: string | null): Json {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};

  const normalized = normalizeShopeeSubId(shopeeSubId || "");
  if (normalized) {
    source[AUTOMATION_SHOPEE_SUB_ID_CONFIG_KEY] = normalized;
  } else {
    delete source[AUTOMATION_SHOPEE_SUB_ID_CONFIG_KEY];
  }

  return source as Json;
}
