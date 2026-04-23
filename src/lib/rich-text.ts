import { applyPlaceholders } from "@/lib/marketplace-utils";

/**
 * Unified rich-text formatting utilities.
 *
 * Templates are stored with a portable markup:
 *   - Bold        : **text**
 *   - Italic      : __text__
 *   - Strikethrough: ~~text~~
 *
 * At send time, the markup is converted to each platform's native format:
 *
 *   WhatsApp (native inline syntax)
 *     **text** → *text*
 *     __text__ → _text_
 *     ~~text~~ → ~text~
 *
 *   Telegram (HTML parseMode — more reliable, supports all three styles)
 *     **text** → <b>text</b>
 *     __text__ → <i>text</i>
 *     ~~text~~ → <s>text</s>
 *     All other characters are HTML-escaped to prevent injection.
 */

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Defense-in-depth: escape quotes so the output is safe in HTML-attribute
    // contexts too (e.g. if this function is ever reused outside of innerHTML).
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Converts the template's portable markup to the destination platform's
 * native formatting and returns the final string ready to be sent.
 */
export function formatMessageForPlatform(
  message: string,
  platform: "whatsapp" | "telegram",
): string {
  if (platform === "whatsapp") {
    return message
      .replace(/\*\*(.+?)\*\*/gs, "*$1*")   // **bold**  → *bold*
      .replace(/__(.+?)__/gs, "_$1_")         // __italic__ → _italic_
      .replace(/~~(.+?)~~/gs, "~$1~");         // ~~strike~~ → ~strike~
  }

  // Telegram: HTML parseMode
  // Step 1: escape HTML-special chars so placeholder values (e.g. product names
  //         with & or <) never break the HTML output.
  // Step 2: convert double-marker unified markup → HTML tags.
  //         Markup chars (**  __  ~~) are not HTML-special, so escapeHtml
  //         leaves them untouched.
  // Step 3: convert legacy single-marker markup (*text* / _text_) that may
  //         exist in templates created before the unified format was introduced.
  //         Single-asterisk pass runs AFTER the double-asterisk pass so that
  //         **text** is never matched twice.
  //         Single-underscore is intentionally skipped: underscores appear in
  //         product SKUs / URLs and would cause false positives.
  const escaped = escapeHtml(message);
  return escaped
    .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")            // **bold**  → <b>bold</b>
    .replace(/__(.+?)__/gs, "<i>$1</i>")                  // __italic__ → <i>italic</i>
    .replace(/~~(.+?)~~/gs, "<s>$1</s>")                  // ~~strike~~ → <s>strike</s>
    // legacy: *bold* (single asterisk, old WhatsApp-style templates)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<b>$1</b>");
}

/**
 * Renders a template's raw content into HTML for in-editor preview.
 *
 * SECURITY: all user text is HTML-escaped before any replacement, so
 * injecting raw HTML through template content is not possible.
 */
export function renderRichTextPreviewHtml(text: string): string {
  const escaped = escapeHtml(text);

  return escaped
    // **bold** (before single-asterisk pass)
    .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
    // *bold*  — single asterisks not adjacent to another asterisk (legacy WA compat)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<strong>$1</strong>")
    // __italic__
    .replace(/__(.+?)__/gs, "<em>$1</em>")
    // ~~strikethrough~~
    .replace(/~~(.+?)~~/gs, "<del>$1</del>")
    // newlines → <br>
    .replace(/\n/g, "<br />");
}

/**
 * Renders a raw template (before placeholder substitution) into HTML for
 * in-editor preview, aware of the {imagem} placeholder.
 *
 * Rules that mirror the actual send logic:
 *   - A line whose trimmed content is exactly `{imagem}` → rendered as <img>
 *   - `{imagem}` appearing inline → removed (empty string), same as dispatch
 *   - All other placeholder keys → replaced with escaped sample values
 *   - Rich-text markup (**bold** / __italic__ / ~~strike~~) → HTML tags
 *
 * SECURITY: all substituted values and template literal text are HTML-escaped
 * before insertion; the image URL (from a controlled sample constant) is also
 * escaped before use in the src attribute.
 */
const IMAGE_SENTINEL = "\x00IMG\x00";

export function renderTemplatePreviewHtml(
  rawContent: string,
  sampleData: Record<string, string>,
): string {
  // Step 1: for lines that are ONLY {imagem}, swap them for a sentinel token.
  //         This mirrors the "remove the whole line" logic in the send path.
  const lines = rawContent.split("\n");
  const withSentinel = lines
    .map((line) =>
      line.trim() === "{imagem}" || line.trim() === "{{imagem}}" ? IMAGE_SENTINEL : line,
    )
    .join("\n");

  // Step 2: apply all placeholder substitutions, with {imagem} → "" for any
  //         remaining inline occurrences.
  const sampleWithoutImage = { ...sampleData, "{imagem}": "", "{{imagem}}": "" };
  const text = applyPlaceholders(withSentinel, sampleWithoutImage);

  // Step 3: HTML-escape everything (\x00 chars in the sentinel are not
  //         HTML-special, so the sentinel survives this step intact).
  const escaped = escapeHtml(text);

  // Step 4: apply rich-text markup → HTML tags.
  const html = escaped
    .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<strong>$1</strong>")
    .replace(/__(.+?)__/gs, "<em>$1</em>")
    .replace(/~~(.+?)~~/gs, "<del>$1</del>")
    .replace(/\n/g, "<br />");

  // Step 5: remove the sentinel entirely (mirrors the send path, which strips
  //         the {imagem} line and delivers the image as a media attachment).
  return html.split(IMAGE_SENTINEL).join("");
}
