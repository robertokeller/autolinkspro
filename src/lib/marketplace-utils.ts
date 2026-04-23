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
const PLACEHOLDER_TOKEN_PATTERN = "[\\wáéíóúãõâêôçÁÉÍÓÚÃÕÂÊÔÇ -]{1,64}";
const ALLOWED_PLACEHOLDER_TOKEN = new RegExp(`^${PLACEHOLDER_TOKEN_PATTERN}$`);
const PLACEHOLDER_CAPTURE_REGEX = new RegExp(
  `\\{\\{\\s*(${PLACEHOLDER_TOKEN_PATTERN})\\s*\\}\\}|\\{\\s*(${PLACEHOLDER_TOKEN_PATTERN})\\s*\\}`,
  "g",
);

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

function normalizePlaceholderToken(key: string): string | null {
  const normalized = String(key || "").trim();
  if (!normalized) return null;

  const stripped = normalized
    .replace(/^\{\{?/, "")
    .replace(/\}\}?$/, "")
    .trim();

  if (!stripped || !ALLOWED_PLACEHOLDER_TOKEN.test(stripped)) return null;
  return stripped;
}

function isNumericDiscount(value: string): boolean {
  return /^-?\d+(?:[.,]\d+)?$/.test(value);
}

function resolveDiscountPlaceholderValue(
  value: string,
  fullText: string,
  matchStart: number,
  placeholderMatch: string,
): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!isNumericDiscount(normalized)) return normalized;
  if (normalized.includes("%")) return normalized;

  let cursor = matchStart + placeholderMatch.length;
  while (cursor < fullText.length && /\s/.test(fullText[cursor] || "")) {
    cursor += 1;
  }

  return fullText[cursor] === "%" ? normalized : `${normalized}%`;
}

export function stripUnresolvedPlaceholders(content: string): string {
  return applyPlaceholders(content, {});
}

/** Apply all placeholders to a template content string */
export function applyPlaceholders(content: string, data: Record<string, string>): string {
  const normalizedReplacements = new Map<string, string>();
  const orderedData = Object.entries(data || {})
    .sort((left, right) => right[0].length - left[0].length);

  for (const [key, value] of orderedData) {
    const token = normalizePlaceholderToken(key);
    if (!token) continue;

    normalizedReplacements.set(token, String(value ?? ""));
  }

  return String(content || "").replace(
    PLACEHOLDER_CAPTURE_REGEX,
    (fullMatch: string, doubleToken: string, singleToken: string, offset: number, fullText: string) => {
      const token = String(doubleToken || singleToken || "").trim();
      if (!token || !ALLOWED_PLACEHOLDER_TOKEN.test(token)) return fullMatch;
      const replacement = normalizedReplacements.get(token) ?? "";
      if (token === "desconto") {
        return resolveDiscountPlaceholderValue(replacement, fullText, offset, fullMatch);
      }
      return replacement;
    },
  );
}

