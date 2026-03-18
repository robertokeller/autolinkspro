const MERCADO_LIVRE_URLS = [
  "https://www.mercadolivre.com.br/",
  "https://myaccount.mercadolivre.com.br/",
  "https://auth.mercadolivre.com.br/",
  "https://www.mercadolibre.com/",
  "https://meli.la/"
];

const AUTH_HINT_COOKIE_NAMES = ["ssid", "nsa_rotok", "orguseridp", "orgnickp"];

function looksLikeMercadoLivreDomain(domain) {
  const host = String(domain || "").toLowerCase();
  return host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("meli.la");
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
    const url = String(tab.url || "").toLowerCase();
    return (
      url.includes("mercadolivre.com.br") ||
      url.includes("mercadolibre.com") ||
      url.includes("meli.la")
    );
  });
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
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      httpOnly: !!cookie.httpOnly,
      secure: !!cookie.secure,
      expires: typeof cookie.expirationDate === "number" ? cookie.expirationDate : undefined,
      sameSite: cookie.sameSite || undefined
    }));

  return dedupeCookies(filtered);
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || request.type !== "GET_ML_COOKIES") {
    return;
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
