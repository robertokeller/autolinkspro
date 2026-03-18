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
  meliSessionId: string;
  templateId: string;
  positiveKeywords: string;
  negativeKeywords: string;
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
  meliSessionId: "",
  templateId: "",
  positiveKeywords: "",
  negativeKeywords: "",
};

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildRoutePayload(form: NewRouteForm) {
  const selectedMasterGroupIds = form.destinationType === "master" ? form.masterGroupIds : [];
  const partnerMarketplaces = [
    form.autoConvertShopee ? "shopee" : null,
    form.autoConvertMercadoLivre ? "mercadolivre" : null,
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
      meliSessionId: form.autoConvertMercadoLivre ? form.meliSessionId || null : null,
      // Keep compatibility with the existing route pipeline while partner selectors are hidden in the UI.
      resolvePartnerLinks: true,
      requirePartnerLink: true,
      partnerMarketplaces,
      filterWords: [],
      negativeKeywords: splitCsv(form.negativeKeywords),
      positiveKeywords: splitCsv(form.positiveKeywords),
      templateId: form.templateId === "none" || form.templateId === "original" || !form.templateId ? null : form.templateId,
      groupType: "ofertas",
      sessionId: form.destSessionId || null,
      masterGroupIds: selectedMasterGroupIds,
    },
  };
}
