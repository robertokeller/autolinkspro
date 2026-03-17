import { backend } from "@/integrations/backend/client";

export async function logHistorico(
  userId: string,
  type: string,
  source: string,
  destination: string,
  status: "success" | "error" | "warning" | "info",
  details: string
) {
  try {
    await backend.from("history_entries").insert({
      user_id: userId,
      type,
      source,
      destination,
      status,
      details: { message: details },
    });
  } catch {
    // Logging should never break the main flow
    console.warn("[logHistorico] Failed to log entry");
  }
}
