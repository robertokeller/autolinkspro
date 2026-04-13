const MERCADO_LIVRE_URLS = [
  "https://www.mercadolivre.com.br/",
  "https://myaccount.mercadolivre.com.br/",
  "https://auth.mercadolivre.com.br/",
  "https://www.mercadolibre.com/",
  "https://meli.la/"
];

const AUTH_HINT_COOKIE_NAMES = ["ssid", "nsa_rotok", "orguseridp", "orgnickp"];
const TRUSTED_MESSAGE_SOURCE = "autolinks-popup";
const MAX_CAPTURED_COOKIES = 200;
const MAX_COOKIE_NAME_LENGTH = 128;
const MAX_COOKIE_VALUE_LENGTH = 8192;
const MAX_COOKIE_DOMAIN_LENGTH = 255;
const MAX_COOKIE_PATH_LENGTH = 512;

// Exact domain allowlist — prevents "mercadolivre.attacker.com" bypass via substring match.
const ALLOWED_MELI_DOMAINS = new Set([
  "mercadolivre.com.br",
  "www.mercadolivre.com.br",
  "myaccount.mercadolivre.com.br",
  "auth.mercadolivre.com.br",
  "mercadopago.com.br",
  "www.mercadopago.com.br",
  "mercadolibre.com",
  "www.mercadolibre.com",
  "auth.mercadolibre.com",
  "meli.la",
  "www.meli.la",
]);

function looksLikeMercadoLivreDomain(domain) {
  // Strip leading dot (cookie domains are sometimes ".mercadolivre.com.br")
  const host = String(domain || "").toLowerCase().replace(/^\./, "");
  if (ALLOWED_MELI_DOMAINS.has(host)) return true;
  // Accept subdomains of known ML TLDs only (e.g. cdn.mercadolivre.com.br)
  for (const allowed of ALLOWED_MELI_DOMAINS) {
    if (host.endsWith("." + allowed)) return true;
  }
  return false;
}

function dedupeCookies(cookies) {
  const map = new Map();
  for (const cookie of cookies) {
    const key = `${cookie.name}::${cookie.domain}::${cookie.path}`;
    map.set(key, cookie);
  }
  return Array.from(map.values());
}

async function getCookiesForUrl(url) {
  return chrome.cookies.getAll({ url });
}

async function hasMercadoLivreTabOpen() {
  const tabs = await chrome.tabs.query({});
  return tabs.some((tab) => {
    try {
      const parsed = new URL(String(tab.url || ""));
      return looksLikeMercadoLivreDomain(parsed.hostname);
    } catch {
      return false;
    }
  });
}

function isTrustedExtensionSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const senderUrl = String(sender.url || "");
  if (!senderUrl) return true;
  return senderUrl.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

async function collectMercadoLivreCookies() {
  const all = [];
  for (const url of MERCADO_LIVRE_URLS) {
    const items = await getCookiesForUrl(url);
    all.push(...items);
  }

  const filtered = all
    .filter((cookie) => cookie && cookie.name && cookie.value)
    .filter((cookie) => looksLikeMercadoLivreDomain(cookie.domain))
    .filter((cookie) => String(cookie.name || "").length <= MAX_COOKIE_NAME_LENGTH)
    .filter((cookie) => String(cookie.value || "").length <= MAX_COOKIE_VALUE_LENGTH)
    .filter((cookie) => String(cookie.domain || "").length <= MAX_COOKIE_DOMAIN_LENGTH)
    .filter((cookie) => String(cookie.path || "/").length <= MAX_COOKIE_PATH_LENGTH)
    .map((cookie) => ({
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain),
      path: String(cookie.path || "/"),
      httpOnly: !!cookie.httpOnly,
      secure: !!cookie.secure,
      expires: typeof cookie.expirationDate === "number" ? cookie.expirationDate : undefined,
      sameSite: cookie.sameSite || undefined
    }));

  return dedupeCookies(filtered).slice(0, MAX_CAPTURED_COOKIES);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.type !== "GET_ML_COOKIES") {
    return;
  }

  if (!isTrustedExtensionSender(sender) || request.source !== TRUSTED_MESSAGE_SOURCE) {
    sendResponse({
      ok: false,
      code: "UNTRUSTED_REQUEST",
      message: "Origem da requisicao nao autorizada.",
    });
    return true;
  }

  (async () => {
    try {
      const hasMlTab = await hasMercadoLivreTabOpen();
      if (!hasMlTab) {
        sendResponse({
          ok: false,
          code: "ML_TAB_REQUIRED",
          message: "Abra uma pagina do Mercado Livre e faca login nela antes de capturar os cookies."
        });
        return;
      }

      const cookies = await collectMercadoLivreCookies();
      if (!cookies.length) {
        sendResponse({
          ok: false,
          code: "ML_COOKIES_NOT_FOUND",
          message: "Nao encontramos cookies do Mercado Livre. Entre em uma conta do Mercado Livre no navegador e tente novamente."
        });
        return;
      }

      const cookieNames = cookies.map((cookie) => cookie.name);
      const hasAuthHint = AUTH_HINT_COOKIE_NAMES.some((name) => cookieNames.includes(name));
      if (!hasAuthHint) {
        sendResponse({
          ok: false,
          code: "ML_LOGIN_REQUIRED",
          message: "Cookies encontrados, mas sem sinal de sessao autenticada. Faca login no Mercado Livre e tente novamente."
        });
        return;
      }

      sendResponse({
        ok: true,
        message: `${cookies.length} cookie(s) capturado(s) com sucesso.`,
        payload: {
          cookies,
          capturedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Falha ao capturar cookies."
      });
    }
  })();

  return true;
});
