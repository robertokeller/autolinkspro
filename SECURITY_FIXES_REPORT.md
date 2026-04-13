# 🔒 Relatório de Correções de Segurança - AutoLinks

**Data:** 2025-04-06
**Versão:** Pós-revisão de segurança

---

## 🎯 **Vulnerabilidades Críticas Corrigidas**

### 1. CORS Client Logic - Forçava Localhost em Produção
**Arquivo:** `src/integrations/backend/client.ts`
**Linhas:** 62-101

**Problema:** Lógica que substituía `VITE_API_URL` por `http://localhost:3116` em ambiente de desenvolvimento poderia causar falhas funcionais e riscos de MITM se configurado incorretamente em produção.

**Fix:** Removida completamente a heurística de detecção de host. Agora usa **apenas** `VITE_API_URL` configurado, fail fast se ausente.

```typescript
// Antes: if (isDevReachableHost(pageHost) && !allowRemoteApiInLocalDev) { ... }
// Agora: Simple validation - sempre usa VITE_API_URL
const API_URL: string = (() => {
  const url = resolveApiUrl((import.meta.env.VITE_API_URL as string | undefined) ?? "");
  if (!url) {
    throw new Error("VITE_API_URL is required. Set it in your environment variables.");
  }
  return url;
})();
```

---

### 2. Credential Encryption Key Não Validada em Desenvolvimento
**Arquivo:** `services/api/src/credential-cipher.ts`
**Linhas:** 19-42

**Problema:** Chave de criptografia (`CREDENTIAL_ENCRYPTION_KEY`) só era validada em produção. Em desenvolvimento, o sistema rodava com chave vazia ou fraca, arriscando vazamento de credenciais das APIs integradas.

**Fix:**
- Validação rigorosa em **todos** os ambientes (não apenas produção)
- Verifica se chave tem 64 caracteres hexadecimais
- Mensagem de erro clara sobre como gerar chave válida

```typescript
// Antes: if (IS_PRODUCTION && !RAW_KEY) { throw ... }
// Agora:
if (!RAW_KEY) {
  throw new Error("CREDENTIAL_ENCRYPTION_KEY is required. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}
if (!/^[0-9a-f]{64}$/i.test(RAW_KEY)) {
  throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)...");
}
```

---

### 3. Service Token Sem Expiração e Validação Fraca
**Arquivo:** `services/api/src/auth.ts`
**Linhas:** 31-40

**Problema:** `SERVICE_TOKEN` era um token estático sem expiração. Se vazado, concedia acesso administrativo eternamente.

**Fix:**
- Validação de comprimento mínimo (32 caracteres)
- Detecção de valores placeholder (`changeme`, `dev-`, `local-only`)
- Warnings em desenvolvimento, erros em produção

```typescript
if (!SERVICE_TOKEN) {
  if (NODE_ENV === "production") throw new Error("SERVICE_TOKEN é obrigatório...");
  console.warn("[auth] SERVICE_TOKEN não definido...");
} else if (SERVICE_TOKEN.length < 32) {
  if (NODE_ENV === "production") throw new Error("SERVICE_TOKEN muito curto...");
  console.warn("[auth] SERVICE_TOKEN muito curto...");
}
```

---

### 4. SQL Injection via Qualified Column Names
**Arquivo:** `services/api/src/rest.ts`
**Linhas:** 178-189

**Problema:** Função `safeCols()` permitia nomes qualificados como `table.column`, o que poderia ser explorado para enumeração de estrutura ou ataques de SQL injection se combinado com outras vulnerabilidades.

**Fix:** Removido suporte a nomes qualificados. Agora apenas identificadores simples:

```typescript
// Antes: permitia "table.column"
// Agora: ONLY unqualified column names
function safeCols(cols: string): string {
  if (cols.trim() === "*") return "*";
  return cols.split(",").map((c) => {
    const t = c.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
      throw new Error(`Invalid column identifier: ${t}. Only unqualified column names are allowed.`);
    }
    return `"${t}"`;
  }).join(", ");
}
```

---

### 5. Race Condition em Profile Update (Privilege Escalation)
**Arquivos:**
- `services/api/src/auth.ts` (código de aplicação)
- `supabase/migrations/022_protect_users_metadata.sql` (nova migration)

**Problema:** Atualização de `metadata.account_status` por usuário não-admin era validada apenas no código da aplicação, não no banco. Concorrência poderia permitir self-upgrade para admin.

**Fix:**
- Migration 022 adicionada com trigger `protect_users_account_status()` no banco
- Impede alteração de `account_status` por não-admins em nível de banco

```sql
CREATE OR REPLACE FUNCTION protect_users_account_status()
RETURNS TRIGGER AS $$
BEGIN
  IF app_is_trusted_backend() OR app_is_admin() THEN
    RETURN NEW;
  END IF;
  IF NEW.metadata ? 'account_status' AND NEW.metadata->>'account_status' IS DISTINCT FROM OLD.metadata->>'account_status' THEN
    RAISE EXCEPTION 'Only administrators can modify account_status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_users_account_status
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION protect_users_account_status();
```

---

### 6. Email Enumeração via Timing Attack no Signup
**Arquivo:** `services/api/src/auth.ts`
**Linhas:** 765-772

**Problema:** Diferença de tempo entre verificar se email existe (SELECT rápido) e criar conta (INSERT lento) permitia enumeration por timing.

**Fix:** Executar `bcrypt.compare` dummy em ambos os caminhos (existe e não existe):

```typescript
const exists = await queryOne("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
if (exists) {
  // Timing-safe: dummy bcrypt
  await bcrypt.compare(password, SIGNIN_DUMMY_HASH);
  res.json({ data: { user: null, session: null, verification_email_sent: false }, error: null });
  return;
}
```

---

### 7. Sistema de Audit Logging Implementado
**Novo arquivo:** `services/api/src/audit.ts`

**Problema:** Ausência de logs estruturados para operações sensíveis dificulta forensic e detectação de ataques.

**Fix:**
- Módulo `audit.ts` criado com `logAudit()` que escreve na tabela `admin_audit_logs`
- Integrado com:
  - `signup` → `user.created`
  - `update-user` → `user.updated`
  - `signout` → `session.revoked`
  - `reset-password` → `user.password_reset`
  - `verify-email` → `user.email_verified`
- Estrutura de dados: `action`, `actor_user_id`, `target_user_id`, `resource_type`, `resource_id`, `details`, `ip_address`, `user_agent`

---

## 🔸 **Melhorias de Segurança Adicionais**

### 8. Redução de JSON Body Limit nos Microserviços
**Arquivos:**
- `services/whatsapp-baileys/src/server.ts` (linha 92)
- `services/telegram-telegraph/src/server.ts` (linha 101)

**Problema:** Limite de 12MB era muito alto, permitia ataques de DoS via payloads grandes.

**Fix:** Reduzido para **2MB**:

```typescript
// Antes: const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "12mb";
// Agora: const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "2mb";
```

Shopee e Meli já estavam em 2MB.

---

## 📊 **Status de Vulnerabilidades Restantes**

| # | Vulnerabilidade | Severidade | Status | Ação Necessária |
|---|-----------------|-----------|--------|-----------------|
| 1 | CORS Client Logic | CRÍTICA | ✅ Corrigido | - |
| 2 | CREDENTIAL_ENCRYPTION_KEY validation | CRÍTICA | ✅ Corrigido | - |
| 3 | Service Token estático | ALTA | ⚠️ Melhorado | Considerar JWT rotation (futuro) |
| 4 | SQL Injection qualified names | CRÍTICA | ✅ Corrigido | - |
| 5 | Race condition metadata | ALTA | ✅ Corrigido (DB trigger) | Aplicar migration 022 |
| 6 | Email enumeration timing | MÉDIA/ALTA | ✅ Corrigido | - |
| 7 | Missing audit trail | MÉDIA | ✅ Parcial | Expandir para outras operações |
| 8 | JSON body limit alto | MÉDIA | ✅ Corrigido | - |
| 9 | Error messages leakage | MÉDIA | ⚠️ OK | Manter genéricos |
| 10 | ALLOWED_EXTENSION_ORIGINS warning | BAIXA | ⚠️ Config | Configurar em produção |

---

## 🚀 **Próximos Passos Recomendados**

### **Imediato (Pré-Production)**
1. ✅ **Aplicar migration 022** no banco de dados:
   ```bash
   supabase db push
   # ou manualmente executar 022_protect_users_metadata.sql
   ```

2. ✅ **Configurar variáveis de ambiente obrigatórias**:
   - `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars)
   - `JWT_SECRET` (32+ chars, forte)
   - `SERVICE_TOKEN` (32+ chars, forte)
   - `WEBHOOK_SECRET` (24+ chars, forte)
   - `ALLOWED_EXTENSION_ORIGINS` (se usar extensão browser)

3. ✅ **Testar em staging** antes de produção:
   - Verificar que `VITE_API_URL` está correto
   - Testar fluxo de signup, login, logout
   - Verificar logs de auditoria na tabela `admin_audit_logs`

### **Curto Prazo (1-2 semanas)**
4. 🔄 **Adicionar mais logs de auditoria no RPC** (funções administrativas: criar/alterar/remover rotas, grupos, templates, etc.)
5. 🔄 **Implementar JWT rotation para service tokens** (substituir SERVICE_TOKEN estático por JWT curto com refresh)
6. 🔄 **Adicionar Content-Security-Policy-Report-Only** para detectar violações

### **Médio Prazo (1 mês)**
7. 🔄 **Penetration test profissional**
8. 🔄 **Vulnerability scanning** (Snyk, npm audit, OWASP Dependency Check)
9. 🔄 **Implementar SIEM integration** (enviar logs estruturados para sistema externo)
10. 🔄 **Considerar mutual TLS** entre serviços em produção

---

## ✅ **Checklist de Validação Pós-Correção**

- [x] Frontend usa apenas `VITE_API_URL` configurado
- [x] `CREDENTIAL_ENCRYPTION_KEY` validado em todos os modos
- [x] `SERVICE_TOKEN` com validação de força
- [x] `safeCols()` proíbequalified identifiers
- [x] Migration 022 criada e documentada
- [x] Timing equalization no signup
- [x] Sistema de audit logging implementado
- [x] JSON body limit reduzido para 2MB
- [ ] Migration 022 aplicada no banco
- [ ] Todas as variáveis de ambiente configuradas
- [ ] Testes de integração passando
- [ ] Logs de auditoria aparecendo na tabela

---

## 🔐 **Melhorias Globais de Arquitetura**

O sistema agora possui:

1. **RLS em todas as tabelas** + triggers de proteção
2. **Rate limiting distribuído** (IP + usuário + burst detection)
3. **JWT authentication** com refresh e revogação
4. **Criptografia de credenciais** em repouso (AES-256-GCM)
5. **Audit trail** estruturado
6. **Proteção contra timing attacks**
7. **Headers de segurança** (CSP, X-Frame-Options, etc.)
8. **Validação de entrada** rigorosa (colunas, enums, tamanhos)

---

**Conclusão:** O sistema está significativamente mais seguro. A maioria das vulnerabilidades críticas foi corrigida. Restam melhorias de médio prazo (JWT rotation, expansão de audit logs) que devem ser priorizadas no roadmap de segurança.

Aplique a migration 022 e faça testes em staging antes deany deploy de produção.
