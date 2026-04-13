type MarketplaceName = "shopee" | "unknown";

interface MarketplacePattern {
  name: MarketplaceName;
  patterns: RegExp[];
  shorteners: RegExp[];
  label: string;
}

const marketplaces: MarketplacePattern[] = [
  {
    name: "shopee",
    label: "Shopee",
    patterns: [
      /shopee\.com\.br/i,
      /shopee\.com/i,
      /shopee\.co\.\w+/i,
    ],
    shorteners: [
      /shope\.ee/i,
      /s\.shopee\./i,
    ],
  },
];

const ignoredDomains = [
  /wa\.me/i,
  /whatsapp\.com/i,
  /t\.me/i,
  /telegram\.org/i,
  /instagram\.com/i,
  /facebook\.com/i,
  /twitter\.com/i,
  /x\.com/i,
  /youtube\.com/i,
  /youtu\.be/i,
  /tiktok\.com/i,
  /linkedin\.com/i,
];

const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

export function extractLinks(content: string): string[] {
  return content.match(urlRegex) || [];
}

function isIgnoredLink(url: string): boolean {
  return ignoredDomains.some((re) => re.test(url));
}

function detectMarketplace(url: string): MarketplaceName {
  for (const mp of marketplaces) {
    if ([...mp.patterns, ...mp.shorteners].some((re) => re.test(url))) {
      return mp.name;
    }
  }
  return "unknown";
}

export function getMarketplaceLabel(name: MarketplaceName): string {
  return marketplaces.find((m) => m.name === name)?.label ?? "Desconhecido";
}

export function extractMarketplaceLinks(content: string): { url: string; marketplace: MarketplaceName }[] {
  return extractLinks(content)
    .filter((l) => !isIgnoredLink(l))
    .map((url) => ({ url, marketplace: detectMarketplace(url) }))
    .filter((l) => l.marketplace !== "unknown");
}

/** Apply all placeholders to a template content string */
export function applyPlaceholders(content: string, data: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(data)) {
    // Support both {key} and {{key}} formats
    result = result.split(key).join(value);
    const doubleKey = key.replace("{", "{{").replace("}", "}}");
    result = result.split(doubleKey).join(value);
  }
  return result;
}

