import type { SessionStatus } from "@/lib/types";

export function normalizeSessionStatus(status: string): SessionStatus {
  const normalized = status === "disconnected" ? "offline" : status;

  switch (normalized) {
    case "online":
    case "offline":
    case "connecting":
    case "warning":
    case "awaiting_code":
    case "awaiting_password":
    case "qr_code":
    case "pairing_code":
      return normalized;
    default:
      return "offline";
  }
}
