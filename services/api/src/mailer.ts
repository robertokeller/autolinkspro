const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim();
const RESEND_REPLY_TO = String(process.env.RESEND_REPLY_TO || "").trim();

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export function isEmailDeliveryConfigured() {
  return Boolean(RESEND_API_KEY && RESEND_FROM);
}

export async function sendEmail(input: SendEmailInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isEmailDeliveryConfigured()) {
    return { ok: false, error: "RESEND_API_KEY/RESEND_FROM not configured" };
  }

  const toList = Array.isArray(input.to) ? input.to : [input.to];
  const payload: Record<string, unknown> = {
    from: RESEND_FROM,
    to: toList,
    subject: input.subject,
    html: input.html,
  };
  if (input.text) {
    payload.text = input.text;
  }
  if (RESEND_REPLY_TO) {
    payload.reply_to = RESEND_REPLY_TO;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
      const message = typeof json?.message === "string" && json.message.trim()
        ? json.message.trim()
        : `Resend error ${response.status}`;
      return { ok: false, error: message };
    }

    const id = typeof json?.id === "string" && json.id.trim() ? json.id.trim() : "unknown";
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown mail transport error" };
  }
}
