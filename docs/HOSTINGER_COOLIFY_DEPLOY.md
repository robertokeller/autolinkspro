# Deploy na Hostinger com Coolify (24/7)

Guia oficial para subir o Auto Links em producao com dominio, SSL e execucao continua.

## 1) Pre-requisitos

- VPS da Hostinger com Docker habilitado.
- Coolify instalado e acessivel.
- Dominio apontado para o IP da VPS.
- Repositorio conectado ao Coolify (GitHub/GitLab/Bitbucket).

## 2) DNS recomendado

Crie os registros `A` apontando para o IP da VPS:

- `app.seudominio.com` -> frontend
- `api.seudominio.com` -> API backend (Node.js + PostgreSQL)
- `wa-api.seudominio.com` -> WhatsApp
- `tg-api.seudominio.com` -> Telegram
- `shopee-api.seudominio.com` -> Shopee
- `meli-api.seudominio.com` -> Mercado Livre
- `ops-api.seudominio.com` -> Ops Control

## 3) Arquivo de ambiente

1. Rode `npm run deploy:preflight` para validar que o projeto esta completo para deploy.
2. Copie `.env.coolify.example` para `.env.coolify`.
3. Ajuste os valores para seu dominio e segredos.
4. No Coolify, cadastre as variaveis com os mesmos nomes do arquivo.
5. Nao publique `.env`, `.env.local` e `.env.coolify` no GitHub.

## 4) Criar aplicacao no Coolify

1. `New Resource` -> `Docker Compose`.
2. Selecione este repositorio.
3. Aponte para `docker-compose.coolify.yml`.
4. Configure as variaveis de ambiente do item anterior.
5. Faca o primeiro deploy.

> **Importante:** nao use `Application` com `Nixpacks` para este repositorio.
> Este projeto depende do stack multi-servico definido no compose (`web`, `api`, `postgres`, `whatsapp`, `telegram`, `shopee`, `meli`, `ops-control`, `scheduler`).

## 5) Dominios e SSL no Coolify

O compose de producao usa `expose` para `web` e `api` (sem bind fixo em porta do host), reduzindo risco de conflito de porta na VPS.

Apos o deploy, associe os dominios:

- `web` -> `app.seudominio.com`
- `api` -> `api.seudominio.com`
- `whatsapp` -> `wa-api.seudominio.com`
- `telegram` -> `tg-api.seudominio.com`
- `shopee` -> `shopee-api.seudominio.com`
- `meli` -> `meli-api.seudominio.com`
- `ops-control` -> `ops-api.seudominio.com`

Ative SSL automatico (Let's Encrypt) em cada servico exposto.

## 6) Volumes persistentes (obrigatorio)

O compose ja define volumes para manter sessoes entre reinicios:

- `wa_sessions`
- `tg_sessions`
- `meli_sessions`

Nao remova esses volumes em atualizacoes de deploy.

## 7) Scheduler 24/7

Para rodar agendamentos/automacoes sem navegador aberto:

- `SCHEDULER_MODE=remote`
- `SCHEDULER_RPC_BASE_URL` preenchido
- `SCHEDULER_RPC_TOKEN` preenchido

Sem backend remoto de RPC, o scheduler nao executa 24/7 real.

## 8) Checklist de validacao pos-deploy

- Frontend abre em `https://app.seudominio.com`.
- `https://wa-api.seudominio.com/health` responde 200.
- `https://tg-api.seudominio.com/health` responde 200.
- `https://shopee-api.seudominio.com/health` responde 200.
- `https://meli-api.seudominio.com/api/meli/health` responde 200.
- Fluxo WhatsApp: conectar sessao e gerar QR.
- Fluxo Telegram: send_code, verify_code, verify_password (quando 2FA).
- Conversor Shopee e Mercado Livre funcionando pela UI.
- Cadastro: cria conta sem login automático e envia e-mail de verificação.
- Login: bloqueia conta não verificada e permite "reenviar verificação".
- Esqueci senha: envia link por e-mail e redefine senha com token.

## 9) Operacao continua

- Use restart policy `unless-stopped` (ja configurado).
- Monitore logs de cada servico no Coolify.
- Sempre redeploy apos mudar variaveis de build do frontend (`VITE_*`).
- Antes de atualizar, valide build local com:

```bash
npm run build
npm run svc:all:build
npm run test
```

## 10) Pré-deploy checklist

Configure as variáveis abaixo **antes** de clicar em Deploy. Variáveis marcadas com `*` causam falha imediata de boot se ausentes (validação no `ensureRequiredEnvVars()` e no `:?` do compose).

| Variável | Valor esperado | Obrigatório |
|---|---|---|
| `POSTGRES_PASSWORD` | Senha forte (≥ 16 chars) | `*` |
| `JWT_SECRET` | String aleatória ≥ 32 chars | `*` |
| `SERVICE_TOKEN` | Token opaco, único por ambiente | `*` |
| `CORS_ORIGIN` | `https://app.seudominio.com` — **nunca `*`** | `*` |
| `APP_PUBLIC_URL` | `https://app.seudominio.com` | `*` |
| `API_PUBLIC_URL` | `https://api.seudominio.com` | `*` |
| `RESEND_API_KEY` | Chave `re_...` do Resend | `*` |
| `RESEND_FROM` | Ex.: `Auto Links <suporte@seudominio.com>` | `*` |
| `RESEND_REPLY_TO` | E-mail de resposta (opcional) | Não |
| `WEBHOOK_SECRET` | String aleatória | `*` |
| `OPS_CONTROL_TOKEN` | String aleatória | `*` |
| `VITE_API_URL` | `https://api.seudominio.com` | `*` |
| `AUTH_COOKIE_DOMAIN` | `.seudominio.com` (com ponto) | Sim |
| `DISABLE_SIGNUP` | `true` (contas via admin) | Recomendado |
| `SCHEDULER_RPC_BASE_URL` | Mesmo valor de `VITE_API_URL` | Sim |
| `SCHEDULER_RPC_TOKEN` | **Mesmo valor de `SERVICE_TOKEN`** | Sim |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Credenciais do admin inicial | Sim |
| `VITE_WHATSAPP_MICROSERVICE_URL` | `https://wa-api.seudominio.com` | Build |
| `VITE_TELEGRAM_MICROSERVICE_URL` | `https://tg-api.seudominio.com` | Build |
| `VITE_SHOPEE_MICROSERVICE_URL` | `https://shopee-api.seudominio.com` | Build |
| `VITE_MELI_RPA_URL` | `https://meli-api.seudominio.com` | Build |
| `VITE_OPS_CONTROL_URL` | `https://ops-api.seudominio.com` | Build |
| `EMAIL_VERIFY_TOKEN_TTL_MINUTES` | Ex.: `1440` (24h) | Opcional |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | Ex.: `30` (30 min) | Opcional |

> **Nota:** `SERVICE_TOKEN` e `SCHEDULER_RPC_TOKEN` devem ter o mesmo valor — o compose já faz isso via `${SERVICE_TOKEN:?...}` para os dois.  
> **Nota:** `CORS_ORIGIN=*` é bloqueado em produção pela API (`ensureRequiredEnvVars`).  
> **Nota:** `AUTH_COOKIE_DOMAIN` é necessário para cookies cross-subdomain (app.X ↔ api.X). Use o formato `.seudominio.com` com ponto inicial.  
> **Nota:** `VITE_OPS_CONTROL_TOKEN` foi removido — chamadas ops passam pelo API backend com token server-side.

## 11) Smoke test automatizado

Após o deploy concluir com sucesso, rode o smoke test a partir de qualquer máquina com acesso à internet:

```bash
SERVICE_TOKEN=xxx \
SMOKE_API_URL=https://api.seudominio.com \
SMOKE_WA_URL=https://wa-api.seudominio.com \
SMOKE_TG_URL=https://tg-api.seudominio.com \
SMOKE_SHOPEE_URL=https://shopee-api.seudominio.com \
SMOKE_MELI_URL=https://meli-api.seudominio.com \
SMOKE_OPS_URL=https://ops-api.seudominio.com \
SMOKE_WEB_URL=https://app.seudominio.com \
npm run smoke:coolify
```

Saída esperada (8 linhas `[smoke] OK ...`):

```
[smoke] Starting post-deploy smoke tests…

[smoke] OK api       /health → 200 https://api.seudominio.com/health
[smoke] OK whatsapp  /health → 200 https://wa-api.seudominio.com/health
[smoke] OK telegram  /health → 200 https://tg-api.seudominio.com/health
[smoke] OK shopee    /health → 200 https://shopee-api.seudominio.com/health
[smoke] OK meli      /health → 200 https://meli-api.seudominio.com/api/meli/health
[smoke] OK ops       /health → 200 https://ops-api.seudominio.com/health
[smoke] OK web                → 200 https://app.seudominio.com/
[smoke] OK api       /rpc    → 400 https://api.seudominio.com/functions/v1/rpc

[smoke] All checks passed ✓
```

> O check de `/rpc` aceita HTTP 400 ("função desconhecida") como OK — isso prova que a rota existe e a API está respondendo. Qualquer 404 ou 5xx indica problema na rota RPC.

## 12) Rollback

**Via Coolify:**
1. Abra a aplicação → aba **Deployments**.
2. Localize o SHA anterior (deploy com status verde).
3. Clique em **Redeploy** naquele SHA.

**Volumes — sempre preservados:**
- `wa_sessions`, `tg_sessions`, `meli_sessions` — sessões de autenticação.
- `postgres_data` — banco de dados completo.
- Nunca execute `docker volume rm` nesses volumes sem um backup validado.

**Se a migração falhou:**
1. Verifique os logs do container `migrate` no Coolify.
2. Corrija o SQL problemático em `database/migrations/`.
3. Crie um novo commit e faça novo deploy — o container `migrate` roda novamente.
4. O container `api` (e todos os serviços dependentes) só sobe **após** `migrate` completar com sucesso (boot order enforced pelo `depends_on`).


