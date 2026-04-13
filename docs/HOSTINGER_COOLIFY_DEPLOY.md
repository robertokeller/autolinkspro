# Deploy na Hostinger com Coolify (24/7)

Guia oficial para subir o Auto Links em producao com dominio, SSL e execução continua.

## 1) Pre-requisitos

- VPS da Hostinger com Docker habilitado.
- Coolify instalado e acessivel.
- Dominio apontado para o IP da VPS.
- Repositorio conectado ao Coolify (GitHub/GitLab/Bitbucket).

## 2) DNS recomendado

Crie os registros `A` apontando para o IP da VPS:

- `autolinks.pro` -> frontend
- `api.autolinks.pro` -> API backend (Node.js + Supabase PostgreSQL)
- `wa-api.autolinks.pro` -> WhatsApp
- `tg-api.autolinks.pro` -> Telegram
- `shopee-api.autolinks.pro` -> Shopee
- `meli-api.autolinks.pro` -> Mercado Livre
- `ops-api.autolinks.pro` -> Ops Control

Para este projeto em produção:

- `autolinks.pro` -> frontend (`web`)
- `api.autolinks.pro` -> API backend (`api`)

## 3) Arquivo de ambiente

1. Rode `npm run deploy:preflight` para válidar que o projeto esta completo para deploy.
2. Rode `npm run env:private:setup` para criar `.private/env` e `.private/secrets`.
3. Use `.private/env/.env.coolify` como base local e ajuste os valores para seu dominio e segredos.
4. No Coolify, cadastre as variaveis com os mesmos nomes desse arquivo local.
5. Rode `npm run deploy:docs` para atualizar a documentação automática de variáveis.
6. Não publique `.env`, `.env.local`, `.env.coolify` e `.private/` no GitHub.

## 4) Criar aplicacao no Coolify

1. `New Resource` -> `Docker Compose`.
2. Selecione este repositorio.
3. Aponte para `docker-compose.coolify.yml`.
4. Configure as variaveis de ambiente do item anterior.
5. Faça o primeiro deploy.

> **Importante:** não use `Application` com `Nixpacks` para este repositorio.
> Este projeto depende do stack multi-servico definido no compose (`web`, `api`, `whatsapp`, `telegram`, `shopee`, `meli`, `ops-control`, `scheduler`, `sessions-backup`).

## 5) Dominios e SSL no Coolify

O compose de producao usa `expose` para `web` e `api` (sem bind fixo em porta do host), reduzindo risco de conflito de porta na VPS.

Apos o deploy, associe os dominios:

- `web` -> `autolinks.pro`
- `api` -> `api.autolinks.pro`
- `whatsapp` -> `wa-api.autolinks.pro`
- `telegram` -> `tg-api.autolinks.pro`
- `shopee` -> `shopee-api.autolinks.pro`
- `meli` -> `meli-api.autolinks.pro`
- `ops-control` -> `ops-api.autolinks.pro`

Ative SSL automatico (Let's Encrypt) em cada servico exposto.

## 5.1) URL de webhook Kiwify em deploy

Com `VITE_API_URL=https://api.autolinks.pro`, a URL correta para cadastrar no painel da Kiwify e:

- `https://api.autolinks.pro/webhooks/kiwify`

Nao use query string com token. O token deve ser enviado pela Kiwify no header/corpo, conforme configuracao de token do webhook.

## 6) Volumes persistentes (obrigatório)

O compose já define volumes para manter sessoes entre reinicios:

- `wa_sessions`
- `tg_sessions`
- `meli_sessions`

Não remova esses volumes em atualizacoes de deploy.

## 7) Scheduler 24/7

Para rodar agendamentos/automacoes sem navegador aberto:

- `SCHEDULER_MODE=remote`
- `SCHEDULER_RPC_BASE_URL` preenchido
- `SCHEDULER_RPC_TOKEN` preenchido

Sem backend remoto de RPC, o scheduler não executa 24/7 real.

## 8) Checklist de válidação pos-deploy

- Frontend abre em `https://autolinks.pro`.
- `https://wa-api.autolinks.pro/health` responde 200.
- `https://tg-api.autolinks.pro/health` responde 200.
- `https://shopee-api.autolinks.pro/health` responde 200.
- `https://meli-api.autolinks.pro/api/meli/health` responde 200.
- `https://api.autolinks.pro/health` responde 200.
- Kiwify aponta para `https://api.autolinks.pro/webhooks/kiwify` e eventos chegam em `Admin > Kiwify > Webhooks`.
- Fluxo WhatsApp: conectar sessão e gerar QR.
- Fluxo Telegram: send_code, verify_code, verify_password (quando 2FA).
- Conversor Shopee e Mercado Livre funcionando pela UI.
- Cadastro: cria conta sem login automático e envia e-mail de verificação.
- Login: bloqueia conta não verificada e permite "reenviar verificação".
- Esqueci senha: envia link por e-mail e redefine senha com token.

## 9) Operacao continua

- Use restart policy `unless-stopped` (já configurado).
- Monitore logs de cada servico no Coolify.
- Sempre redeploy após mudar variaveis de build do frontend (`VITE_*`).
- Para diagnosticar captura de mensagens com `texto + imagem`, habilite temporáriamente:
  - `ROUTE_MEDIA_DEBUG=true` (API + conectores)
  - `MEDIA_CAPTURE_DEBUG=true` (opcional, override explicito nos conectores)
- Com debug ativo, procure nos logs:
  - API: prefixo `[route-media-debug]`
  - WhatsApp/Telegram: mensagem `media capture debug`
- Antes de atualizar, valide build local com:

```bash
npm run build
npm run svc:all:build
```

## 10) Pré-deploy checklist

Configure as variáveis abaixo **antes** de clicar em Deploy. Variáveis marcadas com `*` causam falha imediata de boot se ausentes (válidação no `ensureRequiredEnvVars()` e no `:?` do compose).

| Variável | Valor esperado | Obrigatório |
|---|---|---|
| `DATABASE_URL` | URL direta do Postgres Supabase | `*` |
| `DB_SSL` | `true` | `*` |
| `JWT_SECRET` | String aleatória ≥ 32 chars | `*` |
| `SERVICE_TOKEN` | Token opaco, único por ambiente | `*` |
| `CREDENTIAL_CIPHER_SALT` | Hex aleatório (64 chars), fixo por ambiente | `*` |
| `CORS_ORIGIN` | `https://autolinks.pro` — **nunca `*`** | `*` |
| `APP_PUBLIC_URL` | `https://autolinks.pro` | `*` |
| `API_PUBLIC_URL` | `https://api.autolinks.pro` | `*` |
| `RESEND_API_KEY` | Chave `re_...` do Resend | `*` |
| `RESEND_FROM` | Ex.: `Auto Links <suporte@autolinks.pro>` | `*` |
| `RESEND_REPLY_TO` | E-mail de resposta (opcional) | Não |
| `WEBHOOK_SECRET` | String aleatória | `*` |
| `OPS_CONTROL_TOKEN` | String aleatória | `*` |
| `DOCKER_CONTROL_ENABLED` | `true` para habilitar start/stop/restart dos containers via painel admin | Recomendado |
| `VITE_API_URL` | `https://api.autolinks.pro` | `*` |
| `AUTH_COOKIE_DOMAIN` | `.autolinks.pro` (com ponto) | Sim |
| `DISABLE_SIGNUP` | `true` (contas via admin) | Recomendado |
| `SCHEDULER_RPC_BASE_URL` | `https://api.autolinks.pro` (mesmo valor de `VITE_API_URL`) | Sim |
| `SCHEDULER_RPC_TOKEN` | **Mesmo valor de `SERVICE_TOKEN`** | Sim |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Credenciais do admin inicial | Sim |
| `VITE_WHATSAPP_MICROSERVICE_URL` | `https://wa-api.autolinks.pro` | Build |
| `VITE_TELEGRAM_MICROSERVICE_URL` | `https://tg-api.autolinks.pro` | Build |
| `VITE_SHOPEE_MICROSERVICE_URL` | `https://shopee-api.autolinks.pro` | Build |
| `VITE_MELI_RPA_URL` | `https://meli-api.autolinks.pro` | Build |
| `VITE_OPS_CONTROL_URL` | `https://ops-api.autolinks.pro` | Build |
| `EMAIL_VERIFY_TOKEN_TTL_MINUTES` | Ex.: `1440` (24h) | Opcional |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | Ex.: `30` (30 min) | Opcional |

> **Nota:** `SERVICE_TOKEN` e `SCHEDULER_RPC_TOKEN` devem ter o mesmo valor — o compose já faz isso via `${SERVICE_TOKEN:?...}` para os dois.  
> **Nota:** `CORS_ORIGIN=*` é bloqueado em produção pela API (`ensureRequiredEnvVars`).  
> **Nota:** `AUTH_COOKIE_DOMAIN` é necessário para cookies entre `autolinks.pro` e `api.autolinks.pro`. Use `AUTH_COOKIE_DOMAIN=.autolinks.pro` (com ponto inicial).  
> **Nota:** `VITE_OPS_CONTROL_TOKEN` foi removido — chamadas ops passam pelo API backend com token server-side.
> **Nota:** com `DOCKER_CONTROL_ENABLED=true`, o `ops-control` usa Docker CLI + socket para executar os comandos de serviço no deploy Coolify.

## 11) Smoke test automatizado

Após o deploy concluir com sucesso, rode o smoke test a partir de qualquer máquina com acesso à internet:

```bash
SERVICE_TOKEN=xxx \
SMOKE_API_URL=https://api.autolinks.pro \
SMOKE_WA_URL=https://wa-api.autolinks.pro \
SMOKE_TG_URL=https://tg-api.autolinks.pro \
SMOKE_SHOPEE_URL=https://shopee-api.autolinks.pro \
SMOKE_MELI_URL=https://meli-api.autolinks.pro \
SMOKE_OPS_URL=https://ops-api.autolinks.pro \
SMOKE_WEB_URL=https://autolinks.pro \
npm run smoke:coolify
```

Saída esperada (8 linhas `[smoke] OK ...`):

```
[smoke] Starting post-deploy smoke tests…

[smoke] OK api       /health → 200 https://api.autolinks.pro/health
[smoke] OK whatsapp  /health → 200 https://wa-api.autolinks.pro/health
[smoke] OK telegram  /health → 200 https://tg-api.autolinks.pro/health
[smoke] OK shopee    /health → 200 https://shopee-api.autolinks.pro/health
[smoke] OK meli      /health → 200 https://meli-api.autolinks.pro/api/meli/health
[smoke] OK ops       /health → 200 https://ops-api.autolinks.pro/health
[smoke] OK web                → 200 https://autolinks.pro/
[smoke] OK api       /rpc    → 400 https://api.autolinks.pro/functions/v1/rpc

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
- Nunca execute `docker volume rm` nesses volumes sem um backup válidado.

**Se a migração falhou:**
1. Verifique logs de `api`/`scheduler` no Coolify.
2. Corrijá o SQL problemático em `supabase/migrations/`.
3. Rode `supabase db push --linked --include-all` para aplicar o ajuste.
4. Faça novo deploy do compose para sincronizar serviços.
