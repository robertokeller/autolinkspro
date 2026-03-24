const DEFAULT_API_ORIGINS = [
  "https://api.autolinks.pro",
  "http://localhost:3116",
  "http://127.0.0.1:3116",
  "https://localhost:3116",
  "https://127.0.0.1:3116",
];

const TRUSTED_PRODUCTION_HOSTS = new Set([
  "autolinks.pro",
  "www.autolinks.pro",
  "api.autolinks.pro",
]);

const TRUSTED_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const STORAGE_KEY_AUTH = "autolinksExtensionAuth";
const STORAGE_KEY_API_ORIGIN = "autolinksExtensionApiOrigin";

const STATUS = {
  info: "info",
  success: "success",
  error: "error",
};

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const captureBtn = document.getElementById("captureBtn");
const logoutBtn = document.getElementById("logoutBtn");
const statusEl = document.getElementById("status");
const stepLogin = document.getElementById("stepLogin");
const stepCapture = document.getElementById("stepCapture");

let extensionAuth = null;

function setStatus(kind, message) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function setBusy(isBusy) {
  loginBtn.disabled = isBusy;
  captureBtn.disabled = isBusy;
  if (logoutBtn) logoutBtn.disabled = isBusy;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOrigin(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    return parsed.origin;
  } catch {
    return "";
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isTrustedAutolinksHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return TRUSTED_PRODUCTION_HOSTS.has(host) || TRUSTED_LOCAL_HOSTS.has(host);
}

function isLikelyAppOrigin(origin) {
  try {
    const parsed = new URL(String(origin || ""));
    return isTrustedAutolinksHost(parsed.hostname);
  } catch {
    return false;
  }
}

function deriveApiOriginsFromOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];

  try {
    const parsed = new URL(normalized);
    const protocol = parsed.protocol === "http:" ? "http:" : "https:";
    const host = String(parsed.hostname || "").toLowerCase();
    const derived = [];

    if (TRUSTED_LOCAL_HOSTS.has(host)) {
      derived.push(`${protocol}//${host}:3116`);
      derived.push(`http://${host}:3116`);
      derived.push(`https://${host}:3116`);
      return unique(derived.map((value) => normalizeOrigin(value)));
    }

    if (!TRUSTED_PRODUCTION_HOSTS.has(host)) {
      return [];
    }

    if (host === "api.autolinks.pro") {
      derived.push("https://api.autolinks.pro");
      return unique(derived.map((value) => normalizeOrigin(value)));
    }

    if (host === "autolinks.pro" || host === "www.autolinks.pro") {
      derived.push("https://api.autolinks.pro");
    }

    return unique(derived.map((value) => normalizeOrigin(value)));
  } catch {
    return [];
  }
}

function getOriginPriority(origin) {
  try {
    const parsed = new URL(String(origin || ""));
    const host = String(parsed.hostname || "").toLowerCase();
    if (host === "api.autolinks.pro") return 0;
    if ((host === "localhost" || host === "127.0.0.1") && parsed.port === "3116") return 1;
    if (host === "localhost" || host === "127.0.0.1") return 2;
    if (TRUSTED_PRODUCTION_HOSTS.has(host)) return 3;
    return 4;
  } catch {
    return 5;
  }
}

function normalizeApiOriginInput(rawValue) {
  const base = normalizeOrigin(String(rawValue || ""));
  if (!base) return "";
  try {
    const parsed = new URL(base);
    const host = String(parsed.hostname || "").toLowerCase();
    if (!isTrustedAutolinksHost(host)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

async function readStoredApiOrigin() {
  const data = await chrome.storage.local.get(STORAGE_KEY_API_ORIGIN);
  return normalizeApiOriginInput(data?.[STORAGE_KEY_API_ORIGIN] || "");
}

async function saveStoredApiOrigin(origin) {
  const normalized = normalizeApiOriginInput(origin);
  if (!normalized) {
    await chrome.storage.local.remove(STORAGE_KEY_API_ORIGIN);
    return "";
  }
  await chrome.storage.local.set({ [STORAGE_KEY_API_ORIGIN]: normalized });
  return normalized;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function emailsMatch(a, b) {
  const left = normalizeEmail(a);
  const right = normalizeEmail(b);
  return !!left && !!right && left === right;
}

function isLikelyJwt(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function extractErrorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    const asRecord = payload;
    const fromErrorObject =
      asRecord.error && typeof asRecord.error === "object"
        ? String(asRecord.error.message || "")
        : "";
    const fromErrorString = typeof asRecord.error === "string" ? asRecord.error : "";
    const fromMessage = typeof asRecord.message === "string" ? asRecord.message : "";
    return (fromErrorObject || fromErrorString || fromMessage || fallback || "").trim();
  }
  return String(fallback || "").trim();
}

function isCredentialError(message) {
  const raw = String(message || "").toLowerCase();
  return (
    raw.includes("senha") ||
    raw.includes("credenciais") ||
    raw.includes("email ou senha") ||
    raw.includes("e-mail ainda") ||
    raw.includes("conta bloqueada")
  );
}

function isConnectionIssueMessage(message) {
  const raw = String(message || "").toLowerCase();
  return (
    raw.includes("failed to fetch") ||
    raw.includes("networkerror") ||
    raw.includes("load failed") ||
    raw.includes("tempo esgotado") ||
    raw.includes("falha ao conectar")
  );
}

function toFriendlyErrorMessage(error) {
  const raw = String(error?.message || error || "");
  const lower = raw.toLowerCase();

  if (lower.includes("funcao nao implementada")) {
    return "Extensao desatualizada. Atualize o arquivo baixado em Configuracoes ML e tente novamente.";
  }
  if (lower.includes("nao autenticado")) {
    return "Sua sessao expirou. Faca login novamente.";
  }
  if (lower.includes("email ou senha") || lower.includes("credenciais")) {
    return "E-mail ou senha incorretos.";
  }
  if (lower.includes("e-mail ainda nao confirmado")) {
    return "Seu e-mail ainda nao foi confirmado.";
  }
  if (lower.includes("tempo esgotado") || lower.includes("timeout")) {
    return "Tempo esgotado ao conectar com o Autolinks. Tente novamente.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("load failed")) {
    return "Falha ao conectar com o Autolinks. Verifique sua internet e tente novamente.";
  }
  if (lower.includes("resposta invalida")) {
    return "Recebi uma resposta invalida do servidor do Autolinks. Tente novamente.";
  }
  if (lower.includes("cookie bloqueado")) {
    return "Nao consegui salvar sua sessao. Verifique bloqueio de cookies no navegador.";
  }
  if (lower.includes("servico api offline")) {
    return "O servico do Autolinks esta offline no momento.";
  }
  return raw || "Ocorreu um erro inesperado. Tente novamente.";
}

function buildSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = char === "x" ? randomNibble : ((randomNibble & 0x3) | 0x8);
    return value.toString(16);
  });
}

async function listHttpTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    const url = String(tab.url || "").toLowerCase();
    return url.startsWith("http://") || url.startsWith("https://");
  });
}

async function getCandidateApiOrigins() {
  const storedApiOrigin = await readStoredApiOrigin();
  const tabs = await listHttpTabs();
  const fromTabs = tabs
    .map((tab) => normalizeOrigin(tab.url))
    .filter((origin) => isLikelyAppOrigin(origin));

  const current = normalizeOrigin(extensionAuth?.apiOrigin || "");
  const safeCurrent = isLikelyAppOrigin(current) ? current : "";
  const derivedFromCurrent = deriveApiOriginsFromOrigin(safeCurrent);
  const derivedFromStored = deriveApiOriginsFromOrigin(storedApiOrigin);
  const derivedFromTabs = fromTabs.flatMap((origin) => deriveApiOriginsFromOrigin(origin));

  return unique([
    storedApiOrigin,
    safeCurrent,
    ...derivedFromStored,
    ...derivedFromCurrent,
    ...derivedFromTabs,
    ...DEFAULT_API_ORIGINS,
    ...fromTabs,
  ])
    .filter((origin) => isLikelyAppOrigin(origin))
    .sort((left, right) => getOriginPriority(left) - getOriginPriority(right));
}

async function readAuthTokenFromCookies(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return "";

  const cookies = await chrome.cookies.getAll({ url: normalized });
  if (!Array.isArray(cookies) || cookies.length === 0) return "";

  const decodeValue = (value) => {
    try {
      return decodeURIComponent(String(value || ""));
    } catch {
      return String(value || "");
    }
  };

  const preferredNames = ["autolinks_at", "autolinks_auth", "autolinks_token"];
  for (const name of preferredNames) {
    const found = cookies.find((cookie) => String(cookie?.name || "").toLowerCase() === name);
    const token = decodeValue(found?.value || "");
    if (isLikelyJwt(token)) return token;
  }

  const fallback = cookies.find((cookie) => {
    const token = decodeValue(cookie?.value || "");
    const name = String(cookie?.name || "").toLowerCase();
    return isLikelyJwt(token) && (name.includes("autolinks") || name.includes("auth") || name.includes("token"));
  });

  const fallbackToken = decodeValue(fallback?.value || "");
  return isLikelyJwt(fallbackToken) ? fallbackToken : "";
}

async function resolveRuntimeAccessToken(auth) {
  const origin = normalizeOrigin(auth?.apiOrigin || "");
  if (!origin) return "";
  const cookieToken = await readAuthTokenFromCookies(origin);
  if (cookieToken) return cookieToken;
  return String(auth?.accessToken || "").trim();
}

async function apiRequest(origin, path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 15000;
  const body = options.body;
  const token = String(options.token || "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = {};
    if (text && text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("Resposta invalida do servidor.");
      }
    }

    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, `Falha ao conectar (HTTP ${response.status}).`));
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Tempo esgotado ao conectar com o Autolinks.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyApiOrigin(origin) {
  try {
    const health = await apiRequest(origin, "/health", {
      method: "GET",
      timeoutMs: 10000,
    });
    const service = String(health?.service || "").toLowerCase();
    const isApi = Boolean(health?.ok) && service.includes("autolinks-api");
    if (!isApi) {
      return { ok: false, message: "Origem sem API valida do AutoLinks." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFriendlyErrorMessage(error) };
  }
}

async function rpcRequest(auth, name, body = {}) {
  if (!auth?.apiOrigin) {
    throw new Error("Sessao da extensao invalida. Faca login novamente.");
  }

  const runtimeToken = await resolveRuntimeAccessToken(auth);
  if (!runtimeToken) {
    throw new Error("Sessao da extensao invalida. Faca login novamente.");
  }

  const response = await apiRequest(auth.apiOrigin, "/functions/v1/rpc", {
    method: "POST",
    token: runtimeToken,
    // Keep RPC selector authoritative even when the payload also includes
    // a business field called "name" (session name).
    body: { ...body, name },
    timeoutMs: 45000,
  });

  if (response?.error) {
    throw new Error(extractErrorMessage(response, `Falha ao executar ${name}.`));
  }

  const payload = response?.data;
  if (payload && typeof payload === "object" && payload.error) {
    throw new Error(extractErrorMessage(payload, `Falha ao executar ${name}.`));
  }

  return payload;
}

async function loadAuthFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY_AUTH);
  const raw = data?.[STORAGE_KEY_AUTH];
  if (!raw || typeof raw !== "object") {
    extensionAuth = null;
    return null;
  }

  extensionAuth = {
    apiOrigin: normalizeOrigin(raw.apiOrigin || ""),
    accessToken: "",
    userId: String(raw.userId || ""),
    email: String(raw.email || ""),
    expiresAt: Number(raw.expiresAt || 0),
  };

  if (!extensionAuth.apiOrigin) {
    extensionAuth = null;
    return null;
  }

  return extensionAuth;
}

async function saveAuthToStorage(auth) {
  extensionAuth = {
    apiOrigin: normalizeOrigin(auth.apiOrigin || ""),
    accessToken: String(auth.accessToken || ""),
    userId: String(auth.userId || ""),
    email: String(auth.email || ""),
    expiresAt: Number(auth.expiresAt || 0),
  };
  await chrome.storage.local.set({
    [STORAGE_KEY_AUTH]: {
      apiOrigin: extensionAuth.apiOrigin,
      userId: extensionAuth.userId,
      email: extensionAuth.email,
      expiresAt: extensionAuth.expiresAt,
    },
  });
}

async function clearStoredAuth() {
  extensionAuth = null;
  await chrome.storage.local.remove(STORAGE_KEY_AUTH);
}

async function signOutApi(auth) {
  const origin = normalizeOrigin(auth?.apiOrigin || "");
  if (!origin) return;
  const runtimeToken = await resolveRuntimeAccessToken(auth);

  try {
    await apiRequest(origin, "/auth/signout", {
      method: "POST",
      token: runtimeToken,
      timeoutMs: 12000,
    });
  } catch {
    // Best effort logout.
  }
}

async function validateAuthSession(auth) {
  const origin = normalizeOrigin(auth?.apiOrigin || "");
  if (!origin) {
    return { ok: false, message: "Origem da API invalida." };
  }

  let token = await readAuthTokenFromCookies(origin);
  if (!token && auth?.accessToken) token = String(auth.accessToken || "");
  if (!token) {
    await sleep(200);
    token = await readAuthTokenFromCookies(origin);
  }
  if (!token) {
    return { ok: false, message: "Nao foi possivel validar a sessao da extensao." };
  }

  const sessionResult = await apiRequest(origin, "/auth/session", {
    method: "GET",
    token,
    timeoutMs: 12000,
  });

  if (sessionResult?.error) {
    return { ok: false, message: extractErrorMessage(sessionResult, "Sessao invalida.") };
  }

  const session = sessionResult?.data?.session;
  const user = session?.user;
  if (!user?.id) {
    return { ok: false, message: "Sessao invalida ou expirada." };
  }

  return {
    ok: true,
    auth: {
      apiOrigin: origin,
      accessToken: token,
      userId: String(user.id || ""),
      email: String(user.email || ""),
      expiresAt: Number(session?.expires_at || 0),
    },
  };
}

async function refreshAuthFromStorage() {
  await loadAuthFromStorage();
  if (!extensionAuth) return false;

  try {
    const validation = await validateAuthSession(extensionAuth);
    if (!validation?.ok || !validation.auth) {
      await clearStoredAuth();
      return false;
    }
    await saveAuthToStorage(validation.auth);
    return true;
  } catch {
    await clearStoredAuth();
    return false;
  }
}

async function loginAtOrigin(origin, email, password) {
  const signIn = await apiRequest(origin, "/auth/signin", {
    method: "POST",
    body: { email, password },
    timeoutMs: 15000,
  });

  if (signIn?.error) {
    const message = extractErrorMessage(signIn, "Nao foi possivel validar login.");
    return { ok: false, message, credentialIssue: isCredentialError(message) };
  }

  const signInEmail = normalizeEmail(signIn?.data?.user?.email || signIn?.data?.session?.user?.email);
  if (signInEmail && !emailsMatch(signInEmail, email)) {
    await signOutApi({ apiOrigin: origin });
    return {
      ok: false,
      message: "O login retornou uma conta diferente do e-mail informado. Tente novamente.",
      credentialIssue: true,
    };
  }

  const signInAccessToken = String(
    signIn?.data?.session?.access_token || signIn?.data?.session?.accessToken || "",
  ).trim();

  const validation = await validateAuthSession({
    apiOrigin: origin,
    accessToken: signInAccessToken,
  });
  if (!validation?.ok || !validation.auth) {
    const message = validation?.message || "Login realizado, mas a sessao nao foi validada.";
    return { ok: false, message, credentialIssue: false };
  }

  if (!emailsMatch(validation.auth.email, email)) {
    await signOutApi(validation.auth);
    return {
      ok: false,
      message: "Sessao invalida: o e-mail autenticado nao corresponde ao informado.",
      credentialIssue: true,
    };
  }

  return { ok: true, auth: validation.auth };
}

function extractMlUserId(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const found = list.find((cookie) => String(cookie?.name || "").toLowerCase() === "orguseridp");
  return String(found?.value || "").trim();
}

async function loginAndValidate() {
  const email = String(emailInput.value || "").trim();
  const password = String(passwordInput.value || "");

  if (!email || !password) {
    setStatus(STATUS.error, "Preencha e-mail e senha para continuar.");
    return;
  }

  setBusy(true);
  setStatus(STATUS.info, "Validando seu login...");

  try {
    const candidates = await getCandidateApiOrigins();
    if (candidates.length === 0) {
      setStatus(STATUS.error, "Nao encontrei uma API valida do AutoLinks no momento. Tente novamente.");
      return;
    }

    let lastError = "";
    let bestError = "";
    let testedApiEndpoints = 0;
    for (const origin of candidates) {
      const healthCheck = await verifyApiOrigin(origin);
      if (!healthCheck.ok) {
        if (healthCheck.message) {
          lastError = healthCheck.message;
          if (!bestError || (isConnectionIssueMessage(bestError) && !isConnectionIssueMessage(healthCheck.message))) {
            bestError = healthCheck.message;
          }
        }
        continue;
      }

      testedApiEndpoints += 1;
      try {
        setStatus(STATUS.info, `Conectando em ${origin}...`);
        const result = await loginAtOrigin(origin, email, password);
        if (result?.ok && result.auth) {
          await saveAuthToStorage(result.auth);
          await saveStoredApiOrigin(origin);
          setAuthenticated(true);
          passwordInput.value = "";
          setStatus(STATUS.success, `Login confirmado para ${result.auth.email || email}.`);
          return;
        }

        const message = String(result?.message || "").trim();
        if (message) {
          lastError = message;
          if (!bestError || (isConnectionIssueMessage(bestError) && !isConnectionIssueMessage(message))) {
            bestError = message;
          }
        }
        if (result?.credentialIssue) break;
      } catch (error) {
        const message = toFriendlyErrorMessage(error);
        if (message) {
          lastError = message;
          if (!bestError || (isConnectionIssueMessage(bestError) && !isConnectionIssueMessage(message))) {
            bestError = message;
          }
        }
      }
    }

    await clearStoredAuth();
    setAuthenticated(false);
    if (testedApiEndpoints === 0) {
      setStatus(
        STATUS.error,
        bestError || "Nao consegui acessar uma API valida do AutoLinks. Tente novamente em instantes.",
      );
      return;
    }
    setStatus(STATUS.error, bestError || lastError || "Nao foi possivel validar login. Tente novamente.");
  } catch (error) {
    await clearStoredAuth();
    setAuthenticated(false);
    setStatus(STATUS.error, toFriendlyErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function captureAndSendCookies() {
  setBusy(true);
  setStatus(STATUS.info, "Validando sua sessao...");

  try {
    const isLogged = await refreshAuthFromStorage();
    if (!isLogged || !extensionAuth) {
      setAuthenticated(false);
      setStatus(STATUS.error, "Login obrigatorio: faca login antes de capturar cookies.");
      return;
    }

    setAuthenticated(true);
    setStatus(STATUS.info, "Capturando cookies do Mercado Livre...");

    const capture = await chrome.runtime.sendMessage({ type: "GET_ML_COOKIES" });
    if (!capture?.ok) {
      setStatus(STATUS.error, capture?.message || "Nao foi possivel capturar cookies.");
      return;
    }

    const capturedCookies = Array.isArray(capture?.payload?.cookies) ? capture.payload.cookies : [];
    if (!capturedCookies.length) {
      setStatus(STATUS.error, "Nenhum cookie valido foi capturado.");
      return;
    }

    setStatus(STATUS.info, "Validando conta Mercado Livre...");
    const listed = await rpcRequest(extensionAuth, "meli-list-sessions", {});
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
    const existingSession = sessions[0] || null;

    const incomingMlUserId = extractMlUserId(capturedCookies);
    const existingMlUserId = String(existingSession?.ml_user_id || "").trim();
    if (existingMlUserId && incomingMlUserId && existingMlUserId !== incomingMlUserId) {
      setStatus(
        STATUS.error,
        "Os cookies parecem ser de outra conta Mercado Livre. Remova a sessao atual antes de conectar outra conta.",
      );
      return;
    }

    const sessionId = String(existingSession?.id || buildSessionId());
    const sessionName = String(existingSession?.name || "Conta principal");

    setStatus(STATUS.info, "Enviando cookies para sua conta...");
    const saved = await rpcRequest(extensionAuth, "meli-save-session", {
      sessionId,
      name: sessionName,
      cookies: { cookies: capturedCookies },
    });

    const accountName = String(saved?.accountName || "").trim();
    if (accountName) {
      setStatus(STATUS.success, `Cookies enviados com sucesso (${accountName}).`);
    } else {
      setStatus(STATUS.success, "Cookies enviados com sucesso.");
    }
  } catch (error) {
    setStatus(STATUS.error, toFriendlyErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function bootstrap() {
  setBusy(true);
  setAuthenticated(false);
  setStatus(STATUS.info, "Verificando login salvo...");

  try {
    const isLogged = await refreshAuthFromStorage();
    if (isLogged && extensionAuth) {
      setAuthenticated(true);
      setStatus(STATUS.success, `Sessao ativa para ${extensionAuth.email || "usuario"}.`);
      return;
    }

    setAuthenticated(false);
    setStatus(STATUS.info, "Faca login para liberar a captura de cookies.");
  } catch {
    setAuthenticated(false);
    setStatus(STATUS.info, "Faca login para liberar a captura de cookies.");
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

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        if (extensionAuth?.apiOrigin) {
          await signOutApi(extensionAuth);
        }
        await clearStoredAuth();
        setAuthenticated(false);
        passwordInput.value = "";
        setStatus(STATUS.info, "Voce saiu da conta. Faca login novamente.");
      } finally {
        setBusy(false);
      }
    })();
  });
}

void bootstrap();
