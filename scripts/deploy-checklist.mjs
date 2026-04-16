/**
 * deploy-checklist.mjs
 *
 * Checklist de segurança e boas práticas executado AUTOMATICAMENTE antes de
 * cada build de produção (via hook "prebuild" no package.json).
 *
 * Também é chamado por scripts/preflight-coolify.mjs durante o deploy via Coolify.
 *
 * Itens CRÍTICOS: fazem o processo sair com código 1 e BLOQUEIAM o build/deploy.
 * Itens AVISO:    imprimem alerta mas não bloqueiam o build.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Como resolver cada problema apontado:
 *
 *  JWT_SECRET              → Gere com: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
 *  SERVICE_TOKEN           → Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *  CREDENTIAL_ENCRYPTION_KEY → 64 chars hex (32 bytes):  openssl rand -hex 32
 *  CREDENTIAL_CIPHER_SALT  → 64 chars hex (32 bytes):  openssl rand -hex 32
 *  BACKUP_ENCRYPTION_KEY   → Mín. 32 chars: openssl rand -base64 32
 *  LOG_HASH_SALT           → Nunca use o valor padrão público; gere: openssl rand -hex 16
 *  WEBHOOK_SECRET          → 64 chars hex: openssl rand -hex 32
 *  OPS_CONTROL_TOKEN       → 64 chars hex: openssl rand -hex 32
 *  DB_SSL_REJECT_UNAUTHORIZED → Defina como "true" em produção
 *  ENFORCE_RATE_LIMIT      → Nunca defina como "false" em produção
 * ─────────────────────────────────────────────────────────────────────────────
 */

import process from "node:process";

const RESET  = "\x1b[0m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Valor de uma variável de ambiente ou string vazia. */
function env(key) {
  return (process.env[key] ?? "").trim();
}

/** Verdadeiro se a variável existe e não está vazia. */
function has(key) {
  return env(key).length > 0;
}

/** Verdadeiro se estamos explicitamente em produção (NODE_ENV ou APP_ENV = "production"). */
function isProd() {
  const nodeEnv = env("NODE_ENV").toLowerCase();
  const appEnv  = env("APP_ENV").toLowerCase();
  // Requer sinalização explícita — não assume produção se as vars não estiverem definidas
  return nodeEnv === "production" || appEnv === "production";
}

// ─── resultado acumulado ──────────────────────────────────────────────────────

const errors   = []; // bloqueiam o build
const warnings = []; // não bloqueiam, mas devem ser corrigidos

function critical(msg, hint = "") {
  errors.push({ msg, hint });
}

function warn(msg, hint = "") {
  warnings.push({ msg, hint });
}

// ─── verificações ─────────────────────────────────────────────────────────────

// 1. Variáveis de segurança críticas (CRÍTICO — blocam o build em prod)
// ─────────────────────────────────────────────────────────────────────────────
const criticalSecretVars = [
  {
    key: "JWT_SECRET",
    minLen: 64,
    label: "Segredo JWT (autenticação de usuários)",
    hint: 'node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
  },
  {
    key: "SERVICE_TOKEN",
    minLen: 32,
    label: "Token de serviço interno (comunicação entre microsserviços)",
    hint: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  },
  {
    key: "CREDENTIAL_ENCRYPTION_KEY",
    minLen: 32,
    label: "Chave de criptografia de credenciais OAuth/API",
    hint: "openssl rand -hex 32",
  },
  {
    key: "CREDENTIAL_CIPHER_SALT",
    minLen: 32,
    label: "Salt de derivação da chave de credenciais (NOVO — adicionado em 04/2026)",
    hint: "openssl rand -hex 32",
  },
  {
    key: "BACKUP_ENCRYPTION_KEY",
    minLen: 32,
    label: "Chave de criptografia dos backups de sessão WhatsApp/Telegram",
    hint: "openssl rand -base64 32",
  },
  {
    key: "WEBHOOK_SECRET",
    minLen: 32,
    label: "Segredo para verificação de webhooks (Kiwify, etc.)",
    hint: "openssl rand -hex 32",
  },
  {
    key: "OPS_CONTROL_TOKEN",
    minLen: 32,
    label: "Token de autenticação do painel de controle interno",
    hint: "openssl rand -hex 32",
  },
];

for (const { key, minLen, label, hint } of criticalSecretVars) {
  if (!has(key)) {
    if (isProd()) {
      critical(
        `${key} não está definido — ${label}`,
        `Configure no painel do Coolify: ${hint}`,
      );
    } else {
      warn(
        `${key} não está definido (ignorado em dev, mas OBRIGATÓRIO em prod) — ${label}`,
        hint,
      );
    }
  } else if (env(key).length < minLen) {
    const msg = `${key} tem ${env(key).length} caracteres — mínimo seguro é ${minLen} — ${label}`;
    if (isProd()) {
      critical(msg, `Regenere: ${hint}`);
    } else {
      warn(msg, `Em produção isso bloqueará o build. Regenere: ${hint}`);
    }
  }
}

// 2. JWT_SECRET não pode ser o valor padrão "changeme"
// ─────────────────────────────────────────────────────────────────────────────
const jwtVal = env("JWT_SECRET").toLowerCase();
if (jwtVal && ["changeme", "secret", "jwt_secret", "your-secret", "unsafe"].some(v => jwtVal.includes(v))) {
  critical(
    "JWT_SECRET contém um valor padrão inseguro",
    'node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
  );
}

// 3. SSL do banco de dados
// ─────────────────────────────────────────────────────────────────────────────
const sslReject = env("DB_SSL_REJECT_UNAUTHORIZED").toLowerCase();
if (isProd()) {
  if (sslReject === "false") {
    critical(
      "DB_SSL_REJECT_UNAUTHORIZED=false em produção — permite ataques man-in-the-middle no banco",
      "Defina DB_SSL_REJECT_UNAUTHORIZED=true no Coolify",
    );
  }
} else if (sslReject === "false") {
  warn(
    "DB_SSL_REJECT_UNAUTHORIZED=false — isso é aceitável em dev local mas NUNCA use em produção",
    "Certifique-se de que a variável está como 'true' no ambiente Coolify",
  );
}

// 4. Rate limiting não pode ser desabilitado em produção
// ─────────────────────────────────────────────────────────────────────────────
const enforceRl = env("ENFORCE_RATE_LIMIT").toLowerCase();
if (enforceRl === "false" && isProd()) {
  critical(
    "ENFORCE_RATE_LIMIT=false em produção — expõe endpoints de login a ataques de força bruta",
    "Remova a variável ou defina como 'true' no Coolify",
  );
}

// 4.1 Public RPC should be explicitly disabled unless intentionally required
// ─────────────────────────────────────────────────────────────────────────────
const allowPublicRpc = env("ALLOW_PUBLIC_RPC").toLowerCase();
if (allowPublicRpc === "true") {
  warn(
    "ALLOW_PUBLIC_RPC=true — páginas públicas de convite (link-hub/master-group) ficam acessíveis sem sessão",
    "Mantenha como false em produção, a menos que esse comportamento seja deliberado",
  );
}

// 4.2 Open self-signup is a business-policy choice; warn in production
// ─────────────────────────────────────────────────────────────────────────────
const disableSignup = env("DISABLE_SIGNUP").toLowerCase();
if (isProd() && disableSignup === "false") {
  warn(
    "DISABLE_SIGNUP=false em produção — novos usuários podem criar conta sem provisionamento administrativo",
    "Defina DISABLE_SIGNUP=true se a operação deve ser fechada com onboarding via admin",
  );
}

// 5. LOG_HASH_SALT não pode ser o padrão público
// ─────────────────────────────────────────────────────────────────────────────
const logSalt = env("LOG_HASH_SALT");
const knownDefaultSalts = ["autolinks-log-salt-dev", "dev", "salt", "default"];
if (logSalt && knownDefaultSalts.some(v => logSalt.toLowerCase().includes(v))) {
  warn(
    "LOG_HASH_SALT usa um valor padrão público — hashes de PII nos logs são previsíveis",
    "openssl rand -hex 16",
  );
}

// 6. URLs públicas obrigatórias
// ─────────────────────────────────────────────────────────────────────────────
const requiredPublicUrls = [
  { key: "APP_PUBLIC_URL", label: "URL pública do frontend" },
  { key: "API_PUBLIC_URL", label: "URL pública da API" },
  { key: "CORS_ORIGIN",    label: "Origem permitida no CORS" },
];
for (const { key, label } of requiredPublicUrls) {
  if (!has(key)) {
    if (isProd()) {
      critical(`${key} não definido — ${label}`, `Defina no Coolify, ex: https://app.autolinks.com.br`);
    } else {
      warn(`${key} não definido (obrigatório em prod) — ${label}`, `Defina no Coolify, ex: https://app.autolinks.com.br`);
    }
  } else {
    const val = env(key);
    if (!val.startsWith("https://") && isProd()) {
      critical(
        `${key}="${val}" não usa HTTPS em produção`,
        `Corrija para https:// no Coolify`,
      );
    }
  }
}

// 7. SEED não deve estar ativado em produção
// ─────────────────────────────────────────────────────────────────────────────
const applySeeds = env("APPLY_SEED_MIGRATIONS").toLowerCase();
if (applySeeds === "true" && isProd()) {
  critical(
    "APPLY_SEED_MIGRATIONS=true em produção — pode sobrescrever dados reais com dados de demonstração",
    "Defina como 'false' ou remova a variável no Coolify",
  );
}

// 8. EMAIL (Resend) — aviso se não configurado
// ─────────────────────────────────────────────────────────────────────────────
if (!has("RESEND_API_KEY") || !has("RESEND_FROM")) {
  warn(
    "RESEND_API_KEY ou RESEND_FROM não configurados — emails transacionais (verificação, alertas de segurança) não serão enviados",
    "Configure ambos no Coolify com chave válida do Resend",
  );
}

// 9. Variáveis de ambiente obrigatórias para os microsserviços frontend
// ─────────────────────────────────────────────────────────────────────────────
const requiredViteVars = [
  "VITE_API_URL",
  "VITE_WHATSAPP_MICROSERVICE_URL",
  "VITE_TELEGRAM_MICROSERVICE_URL",
  "VITE_SHOPEE_MICROSERVICE_URL",
  "VITE_MELI_RPA_URL",
  "VITE_AMAZON_MICROSERVICE_URL",
  "VITE_OPS_CONTROL_URL",
];
for (const key of requiredViteVars) {
  if (!has(key) && isProd()) {
    warn(
      `${key} não definido — o frontend não conseguirá se conectar ao microsserviço correspondente`,
      `Defina no Coolify com a URL interna/pública do container`,
    );
  }
}

// ─── relatório ────────────────────────────────────────────────────────────────

const separator = `${DIM}${"─".repeat(70)}${RESET}`;
const tag = `${BOLD}${CYAN}[deploy-checklist]${RESET}`;

console.log("");
console.log(`${tag} ${BOLD}Checklist de segurança para deploy — AutoLinks!${RESET}`);
console.log(separator);

// Sem problemas
if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GREEN}${BOLD}  ✅  Todas as verificações passaram. O deploy pode prosseguir com segurança.${RESET}`);
  console.log(separator);
  console.log("");
  process.exit(0);
}

// Avisos (não bloqueiam)
if (warnings.length > 0) {
  console.log(`${YELLOW}${BOLD}  ⚠️  ${warnings.length} aviso(s) — Recomendado corrigir antes do deploy:${RESET}`);
  for (const { msg, hint } of warnings) {
    console.log(`${YELLOW}  ⚠  ${msg}${RESET}`);
    if (hint) console.log(`${DIM}     → ${hint}${RESET}`);
  }
  console.log("");
}

// Erros críticos (bloqueiam o build em produção)
if (errors.length > 0) {
  console.error(`${RED}${BOLD}  ❌  ${errors.length} erro(s) CRÍTICO(S) — Build bloqueado:${RESET}`);
  for (const { msg, hint } of errors) {
    console.error(`${RED}  ✗  ${msg}${RESET}`);
    if (hint) console.error(`${DIM}     → ${hint}${RESET}`);
  }
  console.log("");
  console.error(`${RED}${BOLD}  O build foi interrompido para proteger a produção.${RESET}`);
  console.error(`${DIM}  Corrija os itens acima e execute novamente.${RESET}`);
  console.log(separator);
  console.log("");
  process.exit(1);
}

console.log(separator);
console.log("");
