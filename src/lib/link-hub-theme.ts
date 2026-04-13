export const LINK_HUB_DEFAULT_THEME_COLOR = "#7c3aed";

export const LINK_HUB_PRESET_COLORS = [
  "#7c3aed",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#4f46e5",
  "#0d9488",
] as const;

export const LINK_HUB_PUBLIC_THEME = {
  background: "#050507",
  text: "#f5f5f5",
  textMuted: "rgba(245,245,245,0.6)",
  textSubtle: "rgba(245,245,245,0.45)",
  textDim: "rgba(245,245,245,0.4)",
  textFaint: "rgba(245,245,245,0.3)",
  borderSoft: "rgba(255,255,255,0.04)",
  borderMuted: "rgba(255,255,255,0.06)",
  surfaceSoft: "rgba(255,255,255,0.02)",
  surfaceMuted: "rgba(255,255,255,0.03)",
  star: "#facc15",
  foregroundOnLight: "#111",
  foregroundOnDark: "#fff",
} as const;

type HslColor = { h: number; s: number; l: number };

export function hexToHsl(hex: string): HslColor {
  const normalized = normalizeHexColor(hex);
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
      default:
        h = 0;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function normalizeHexColor(color?: string | null): string {
  if (!color) return LINK_HUB_DEFAULT_THEME_COLOR;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  return LINK_HUB_DEFAULT_THEME_COLOR;
}

export function getReadableTextColor(lightness: number): string {
  return lightness > 60
    ? LINK_HUB_PUBLIC_THEME.foregroundOnLight
    : LINK_HUB_PUBLIC_THEME.foregroundOnDark;
}

export function getPlatformGradient(platform: string): string {
  if (platform === "whatsapp") {
    return "linear-gradient(135deg, hsl(var(--brand-whatsapp)), #128C7E)";
  }
  return "linear-gradient(135deg, hsl(var(--brand-telegram)), #229ED9)";
}