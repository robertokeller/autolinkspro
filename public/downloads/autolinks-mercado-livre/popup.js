const TARGET_PATH = "/mercadolivre/configuracoes";
const TRUSTED_PANEL_ORIGINS = [
  "https://app.autolinks.pro",
  "http://localhost:5173",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5175",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
];
const STATUS = {
  info: "info",
  success: "success",
  error: "error"
};

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
const stepLogin = document.getElementById("stepLogin");
const stepCapture = document.getElementById("stepCapture");
let extensionAuthVerified = false;
let bridgeToken = "";

function setStatus(kind, message) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function toFriendlyErrorMessage(error) {
  const raw = String(error?.message || error || "");
  if (raw.includes("Could not establish connection") || raw.includes("Receiving end does not exist")) {
    return "Nao consegui falar com a pagina do Autolinks. Abra Configuracoes ML no painel e tente novamente.";
  }
  if (raw.toLowerCase().includes("tempo esgotado aguardando resposta")) {
    return "Conexao iniciada, mas a pagina nao respondeu a tempo. Reabra Configuracoes ML e tente novamente.";
  }
  if (raw.toLowerCase().includes("permission")) {
    return "Permissao do navegador bloqueada. Reinstale a extensao e autorize novamente.";
  }
  if (raw.toLowerCase().includes("configuracoes ml") || raw.toLowerCase().includes("painel")) {
    return raw;
  }
  return raw || "Ocorreu um erro inesperado. Tente novamente.";
}

function setBusy(isBusy) {
  loginBtn.disabled = isBusy;
  captureBtn.disabled = isBusy;
}

function setAuthenticated(isAuthenticated) {
  if (isAuthenticated) {
    stepLogin.classList.add("hidden");
    stepCapture.classList.remove("hidden");
  } else {
    stepLogin.classList.remove("hidden");
    stepCapture.classList.add("hidden");
  }
}

function isTrustedPanelUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return TRUSTED_PANEL_ORIGINS.includes(parsed.origin);
  } catch {
    return false;
  }
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function pingTab(tab) {
  if (!tab || typeof tab.id !== "number") return null;
  try {
    const response = await sendToTab(tab.id, { type: "AUTOLINKS_PING" });
    if (response?.ok && response?.payload?.bridgeToken) {
      bridgeToken = String(response.payload.bridgeToken);
    }
    return response?.ok ? response : null;
  } catch {
    return null;
  }
}

async function listHttpTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    const url = String(tab.url || "").toLowerCase();
    return url.startsWith("http://") || url.startsWith("https://");
  });
}

async function ensureBridgeToken(tabId) {
  if (bridgeToken) return bridgeToken;
  const ping = await sendToTab(tabId, { type: "AUTOLINKS_PING" });
  if (ping?.ok && ping?.payload?.bridgeToken) {
    bridgeToken = String(ping.payload.bridgeToken);
    return bridgeToken;
  }
  throw new Error("Falha ao validar canal seguro com o painel. Reabra Configuracoes ML e tente novamente.");
}

async function ensureBridgeTab() {
  const tabs = await listHttpTabs();
  const isTargetUrl = (url) => {
    const str = String(url || "");
    return str.toLowerCase().includes(TARGET_PATH) && isTrustedPanelUrl(str);
  };

  const existingTargetTab = tabs.find((tab) => isTargetUrl(tab.url));
  if (existingTargetTab && typeof existingTargetTab.id === "number") {
    await chrome.tabs.update(existingTargetTab.id, { active: true });
    return existingTargetTab;
  }

  const candidateOrigins = [...TRUSTED_PANEL_ORIGINS];

  for (const candidateOrigin of candidateOrigins) {
    const targetUrl = `${candidateOrigin}${TARGET_PATH}`;
    const created = await chrome.tabs.create({ url: targetUrl, active: true });

    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const tab = await chrome.tabs.get(created.id);
      const currentUrl = String(tab.url || "").toLowerCase();

      if (currentUrl.includes("/auth/login") || currentUrl.includes("/auth/")) {
        throw new Error("Painel encontrado, mas voce esta na tela de login. Entre no AutoLinks no navegador e tente novamente.");
      }

      if (isTargetUrl(currentUrl)) {
        const ping = await pingTab(tab);
        if (ping?.ok) return tab;
      }
    }
  }

  throw new Error("Nao consegui conectar com Configuracoes ML. Abra o painel Autolinks e tente novamente.");
}

async function findExistingBridgeTab() {
  const tabs = await listHttpTabs();
  const targetTabs = tabs.filter((tab) => {
    const url = String(tab.url || "");
    return url.toLowerCase().includes(TARGET_PATH) && isTrustedPanelUrl(url);
  });

  for (const tab of targetTabs) {
    const ping = await pingTab(tab);
    if (ping?.ok && typeof tab.id === "number") {
      return tab;
    }
  }

  return null;
}

async function checkAuth(tabId) {
  const token = await ensureBridgeToken(tabId);
  return sendToTab(tabId, { type: "AUTOLINKS_CHECK_AUTH", payload: { bridgeToken: token } });
}

async function loginAndValidate() {
  const email = String(emailInput.value || "").trim();
  const password = String(passwordInput.value || "");

  if (!email || !password) {
    setStatus(STATUS.error, "Preencha e-mail e senha para continuar.");
    return;
  }

  setBusy(true);
  setStatus(STATUS.info, "Conectando ao painel para validar login...");

  try {
    const tab = await findExistingBridgeTab();
    if (!tab || typeof tab.id !== "number") {
      extensionAuthVerified = false;
      setAuthenticated(false);
      setStatus(STATUS.error, "Abra o painel em /mercadolivre/configuracoes e tente entrar novamente.");
      return;
    }

    const result = await sendToTab(tab.id, {
      type: "AUTOLINKS_EXTENSION_LOGIN",
      payload: {
        email,
        password,
        bridgeToken: await ensureBridgeToken(tab.id)
      }
    });

    if (!result?.ok) {
      extensionAuthVerified = false;
      setAuthenticated(false);
      setStatus(STATUS.error, result?.message || "Nao foi possivel validar login.");
      return;
    }

    extensionAuthVerified = true;
    setAuthenticated(true);
    setStatus(STATUS.success, result.message || "Login confirmado com sucesso.");
  } catch (error) {
    extensionAuthVerified = false;
    setAuthenticated(false);
    setStatus(STATUS.error, toFriendlyErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function captureAndSendCookies() {
  if (!extensionAuthVerified) {
    setAuthenticated(false);
    setStatus(STATUS.error, "Login obrigatorio: clique em 'Entrar e validar' antes de capturar cookies.");
    return;
  }

  setBusy(true);
  setStatus(STATUS.info, "Preparando envio de cookies...");

  try {
    const tab = await ensureBridgeTab();
    const auth = await checkAuth(tab.id);
    if (!auth?.ok) {
      extensionAuthVerified = false;
      setAuthenticated(false);
      setStatus(STATUS.error, auth?.message || "Sessao nao autenticada. Faca login novamente.");
      return;
    }

    setStatus(STATUS.info, "Capturando cookies do Mercado Livre...");
    const capture = await chrome.runtime.sendMessage({ type: "GET_ML_COOKIES" });
    if (!capture?.ok) {
      setStatus(STATUS.error, capture?.message || "Nao foi possivel capturar cookies.");
      return;
    }

    setStatus(STATUS.info, "Enviando cookies para sua conta no painel...");
    const result = await sendToTab(tab.id, {
      type: "AUTOLINKS_PUSH_COOKIES",
      payload: {
        bridgeToken: await ensureBridgeToken(tab.id),
        cookies: { cookies: capture.payload.cookies },
        suggestedName: "Conta principal"
      }
    });

    if (!result?.ok) {
      setStatus(STATUS.error, result?.message || "Falha ao salvar cookies no painel.");
      return;
    }

    setStatus(STATUS.success, result.message || "Cookies enviados com sucesso.");
  } catch (error) {
    setStatus(STATUS.error, toFriendlyErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function bootstrap() {
  setBusy(true);
  extensionAuthVerified = false;
  setAuthenticated(false);
  setStatus(STATUS.info, "Verificando painel aberto...");

  try {
    const tab = await findExistingBridgeTab();
    if (!tab) {
      setAuthenticated(false);
      setStatus(STATUS.info, "Abra o painel em /mercadolivre/configuracoes e depois volte para a extensao.");
      return;
    }

    const auth = await checkAuth(tab.id);
    if (auth?.ok) {
      setAuthenticated(false);
      setStatus(STATUS.info, "Painel conectado. Agora faca login na extensao para liberar a captura.");
    } else {
      setAuthenticated(false);
      setStatus(STATUS.info, "Faca login para liberar a captura de cookies.");
    }
  } catch {
    setAuthenticated(false);
    setStatus(STATUS.info, "Abra o painel em /mercadolivre/configuracoes e mantenha uma aba do Mercado Livre logada.");
  } finally {
    setBusy(false);
  }
}

loginBtn.addEventListener("click", () => {
  void loginAndValidate();
});

captureBtn.addEventListener("click", () => {
  void captureAndSendCookies();
});

void bootstrap();
