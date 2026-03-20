// ===== Sessões de Comunicação =====

export type SessionStatus = "online" | "offline" | "connecting" | "warning" | "awaiting_code" | "awaiting_password" | "qr_code" | "pairing_code";
export type AuthMethod = "qr" | "pairing";

export interface WhatsAppSession {
  id: string;
  name: string;
  phoneNumber: string;
  status: SessionStatus;
  isDefault: boolean;
  authMethod: AuthMethod;
  qrCode: string | null;
  pairingCode: string | null;
  errorMessage: string | null;
  connectedAt: string | null;
}

export interface TelegramSession {
  id: string;
  name: string;
  phoneNumber: string;
  status: SessionStatus;
  connectedAt: string | null;
  errorMessage: string | null;
}

// ===== Grupos =====

export interface Group {
  id: string;
  name: string;
  platform: "whatsapp" | "telegram";
  memberCount: number;
  sessionId: string;
  tags: string[];
  externalId: string | null;
  inviteLink: string | null;
  whatsappSessionId: string | null;
  telegramSessionId: string | null;
}

export type DistributionMode = "balanced" | "random";

export interface MasterGroup {
  id: string;
  name: string;
  slug: string;
  platform: "whatsapp" | "telegram" | "mixed" | "unknown";
  groupIds: string[];
  distribution: DistributionMode;
  memberLimit: number;
  alertMargin: number;
  linkedGroups: Array<{
    masterGroupId: string;
    groupId: string;
    inviteLink: string | null;
    memberCount: number;
    isActive: boolean;
  }>;
}

// ===== Rotas =====

export type RouteStatus = "active" | "paused" | "error";

export interface AppRoute {
  id: string;
  name: string;
  sourceGroupId: string;
  destinationGroupIds: string[];
  masterGroupId: string | null;
  status: RouteStatus;
  rules: {
    autoConvertShopee: boolean;
    autoConvertMercadoLivre?: boolean;
    resolvePartnerLinks: boolean;
    requirePartnerLink: boolean;
    partnerMarketplaces: string[];
    filterWords: string[];
    negativeKeywords: string[];
    positiveKeywords: string[];
    templateId: string | null;
    groupType: "ofertas";
    sessionId: string | null;
    masterGroupIds?: string[];
  };
  messagesForwarded: number;
  createdAt: string;
}

// ===== Shopee =====
// ShopeeProduct is defined in src/components/shopee/ProductCard.tsx (canonical source)
// ShopeeAutomation uses ShopeeAutomationRow from backend types (canonical source)

// ===== Agendamentos =====

export type RecurrenceType = "none" | "daily" | "weekly";

export type MessageType = "text" | "offer" | "coupon";
export type WeekDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface ScheduledMediaAttachment {
  kind: "image";
  base64: string;
  mimeType: string;
  fileName: string;
}

export interface ScheduledPost {
  id: string;
  name: string;
  content: string;
  finalContent: string;
  scheduledAt: string;
  recurrenceTimes: string[];
  destinationGroupIds: string[];
  masterGroupIds: string[];
  templateId: string | null;
  templateData?: Record<string, string> | null;
  sessionId: string | null;
  recurrence: RecurrenceType;
  weekDays: WeekDay[];
  messageType: MessageType;
  detectedLinks: string[];
  media: ScheduledMediaAttachment | null;
  imagePolicy?: string | null;
  scheduleSource?: string | null;
  productImageUrl?: string | null;
  status: "pending" | "processing" | "sent" | "failed" | "cancelled";
  createdAt: string;
}

// ===== Templates =====

export type TemplateCategory = "oferta" | "cupom" | "geral";
export type TemplateScope = "shopee" | "meli";

// Template type - canonical version used by useTemplates hook (TemplateRow)
export interface Template {
  id: string;
  name: string;
  content: string;
  category: TemplateCategory;
  scope: TemplateScope;
  tags: string[];
  isDefault: boolean;
  createdAt: string;
}

// ===== Link Hub =====

export interface LinkHubPage {
  id: string;
  slug: string;
  title: string;
  description: string;
  logoUrl: string | null;
  themeColor: string;
  groupIds: string[];
  masterGroupIds: string[];
  groupLabels: Record<string, string>;
  isActive: boolean;
  createdAt: string;
}
