const pendingRequests = new Map();

function postToPage(message) {
  window.postMessage(message, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const data = event.data;
  if (!data || data.source !== "autolinks-page-bridge") return;

  const resolver = pendingRequests.get(data.requestId);
  if (!resolver) return;

  pendingRequests.delete(data.requestId);
  resolver(data);
});

function waitForBridgeResponse(requestId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({
        ok: false,
        message: "Tempo esgotado aguardando resposta da página de Configurações ML."
      });
    }, timeoutMs);

    pendingRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const allowed = new Set([
    "AUTOLINKS_PING",
    "AUTOLINKS_CHECK_AUTH",
    "AUTOLINKS_EXTENSION_LOGIN",
    "AUTOLINKS_PUSH_COOKIES"
  ]);

  if (!request || !allowed.has(request.type)) {
    return;
  }

  // Ping: return quick tab info and, when on the target page, also relay to the
  // page bridge to obtain the bridgeToken (needed for PUSH_COOKIES auth).
  if (request.type === "AUTOLINKS_PING") {
    const path = String(window.location.pathname || "");
    const isTargetPath = path.includes("/meli/configuracoes");

    if (isTargetPath) {
      // Relay to page bridge to collect the bridgeToken.
      (async () => {
        const requestId = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        postToPage({
          source: "autolinks-extension",
          type: "AUTOLINKS_PING",
          requestId,
          payload: request.payload || {}
        });
        const bridgeResult = await waitForBridgeResponse(requestId, 3000);
        sendResponse({
          ok: true,
          message: "Content script ativo.",
          payload: {
            href: window.location.href,
            path,
            isTargetPath: true,
            isAuthPath: false,
            bridgeToken: bridgeResult?.payload?.bridgeToken || null
          }
        });
      })();
      return true;
    }

    sendResponse({
      ok: true,
      message: "Content script ativo.",
      payload: {
        href: window.location.href,
        path,
        isTargetPath: false,
        isAuthPath: path.includes("/auth/")
      }
    });
    return true;
  }

  (async () => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    postToPage({
      source: "autolinks-extension",
      type: request.type,
      requestId,
      payload: request.payload || {}
    });

    const result = await waitForBridgeResponse(requestId, 8000);
    sendResponse(result);
  })();

  return true;
});
