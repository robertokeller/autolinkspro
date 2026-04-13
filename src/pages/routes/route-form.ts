export interface NewRouteForm {
  name: string;
  sourceSessionId: string;
  sourceGroupId: string;
  destSessionId: string;
  destinationType: "groups" | "master";
  destinationGroupIds: string[];
  masterGroupIds: string[];
  autoConvertShopee: boolean;
  autoConvertMercadoLivre: boolean;
  autoConvertAmazon: boolean;
  templateId: string;
  amazonTemplateId: string;
  positiveKeywords: string;
  negativeKeywords: string;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export const emptyNewRoute: NewRouteForm = {
  name: "",
  sourceSessionId: "",
  sourceGroupId: "",
  destSessionId: "",
  destinationType: "groups",
  destinationGroupIds: [],
  masterGroupIds: [],
  autoConvertShopee: true,
  autoConvertMercadoLivre: false,
  autoConvertAmazon: false,
  templateId: "",
  amazonTemplateId: "",
  positiveKeywords: "",
  negativeKeywords: "",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
};

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeClockTime(value: string, fallback: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function buildRoutePayload(form: NewRouteForm) {
  const selectedMasterGroupIds = form.destinationType === "master" ? form.masterGroupIds : [];
  const partnerMarketplaces = [
    form.autoConvertShopee ? "shopee" : null,
    form.autoConvertMercadoLivre ? "mercadolivre" : null,
    form.autoConvertAmazon ? "amazon" : null,
  ].filter((item): item is string => Boolean(item));
  return {
    name: form.name,
    sourceGroupId: form.sourceGroupId,
    destinationGroupIds: form.destinationType === "groups" ? form.destinationGroupIds : [],
    masterGroupIds: selectedMasterGroupIds,
    masterGroupId: selectedMasterGroupIds[0],
    rules: {
      autoConvertShopee: form.autoConvertShopee,
      autoConvertMercadoLivre: form.autoConvertMercadoLivre,
      autoConvertAmazon: form.autoConvertAmazon,
      // Keep compatibility with the existing route pipeline while partner selectors are hidden in the UI.
      resolvePartnerLinks: true,
      requirePartnerLink: true,
      partnerMarketplaces,
      filterWords: [],
      negativeKeywords: splitCsv(form.negativeKeywords),
      positiveKeywords: splitCsv(form.positiveKeywords),
      templateId: form.templateId === "none" || form.templateId === "original" || !form.templateId ? null : form.templateId,
      amazonTemplateId: form.amazonTemplateId === "none" || form.amazonTemplateId === "original" || !form.amazonTemplateId
        ? null
        : form.amazonTemplateId,
      groupType: "ofertas",
      sessionId: form.destSessionId || null,
      masterGroupIds: selectedMasterGroupIds,
      quietHoursEnabled: form.quietHoursEnabled === true,
      quietHoursStart: normalizeClockTime(form.quietHoursStart, "22:00"),
      quietHoursEnd: normalizeClockTime(form.quietHoursEnd, "08:00"),
    },
  };
}
