# Auto Links

Sistema para operacao de afiliados com roteamento de mensagens, integracoes de canais e automacoes.

## Requisitos

- Node.js 20+
- npm 10+
- Runtime de deploy: Node.js (sem Deno)

## Modos de execucao

- Local (npm): recomendado para desenvolvimento.
- Cloud (Coolify): recomendado para producao 24/7 com dominio e SSL.

## Setup local

```bash
cd "C:\Users\Rober\Downloads\Autolinks - codex"
npm install
```

Prepare o ambiente local privado (ignorado no Git) antes de iniciar os servicos:

```bash
npm run env:private:setup
```

- Os scripts Node de bootstrap local carregam automaticamente `.env`, `.env.local`, `.private/env/.env` e `.private/env/.env.local`.
- Prioridade: variáveis já exportadas no shell > `.private/env/.env.local` > `.private/env/.env` > `.env.local` > `.env`.

## Preview em tempo real

```bash
npm run preview
```

- URL padrao (sem parametros): `http://127.0.0.1:5173` (com fallback para `5174` e, se necessario, proxima porta livre)
- `npm run preview` usa o mesmo banco Supabase de producao (via `DATABASE_URL`), aplica migrations/seeds e sobe API + microservicos necessarios.
- Ao salvar codigo, a pagina recarrega automaticamente.

Para porta local padrao (`127.0.0.1:5173`, com fallback automatico para `5174`):

```bash
npm run preview:local
```

- Esse comando tambem valida banco Supabase + API + servicos (WhatsApp/Telegram/Shopee/Mercado Livre) antes do preview.

Para subir somente o frontend em porta livre automaticamente:

```bash
npm run preview:safe
```

Para subir tudo pronto (Supabase + API + microservicos + preview) com um comando:

```bash
npm run preview:ready -- --host 127.0.0.1 --port 5174
```

Ou explicitamente na porta padrao:

```bash
npm run preview:ready -- --host 127.0.0.1 --port 5173
```

- Se banco/API/microservicos nao estiverem rodando, esse comando faz `build + start` automaticamente.
- Depois basta abrir o link exibido no terminal, ir em `Conexoes > WhatsApp`, criar sessao e clicar em `Conectar` para gerar QR.

## Desenvolvimento

```bash
npm run dev
```

- `npm run dev` agora sobe o stack local completo e espera os serviços ficarem saudáveis antes de abrir a aplicação.
- Esse fluxo usa o mesmo orquestrador do `preview:ready`: Supabase remoto + API + microserviços + scheduler + frontend local.
- Se você quiser o comportamento antigo apenas para debug, use `npm run dev:legacy`.
- Se quiser apenas o frontend, use `npm run dev:web`.

### Variaveis essenciais dos controles (local)

Para os comandos de `Controles do Sistema` e `Controles dos Servicos` funcionarem sempre no `/admin`, mantenha esses valores no ambiente local (ex.: `.private/env/.env.local`):

```bash
WEBHOOK_SECRET=autolinks-preview-webhook-local
OPS_CONTROL_TOKEN=autolinks-preview-ops-token-local
SERVICE_TOKEN=autolinks-preview-service-token-local
OPS_CONTROL_URL=http://127.0.0.1:3115
VITE_OPS_CONTROL_URL=http://127.0.0.1:3115
```

No deploy Coolify, esses mesmos segredos devem existir no painel de env vars (com valores fortes de produção).

Credenciais seed (dev/local):

- Admin: `robertokellercontato@gmail.com` / `SEED_ADMIN_PASSWORD`
- User: `aliancaslovely@gmail.com` / `SEED_USER_PASSWORD`

## Integracoes reais (Baileys + Telegram + Shopee API)

1. Suba os microservicos em terminais separados:

```bash
npm run svc:wa:build
npm run svc:wa:start
```

```bash
npm run svc:tg:build
npm run svc:tg:start
```

```bash
npm run svc:shopee:build
npm run svc:shopee:start
```

```bash
npm run svc:ops:start
```

2. Configure no `.env` do frontend:

```bash
VITE_WHATSAPP_MICROSERVICE_URL=http://127.0.0.1:3111
VITE_TELEGRAM_MICROSERVICE_URL=http://127.0.0.1:3112
VITE_SHOPEE_MICROSERVICE_URL=http://127.0.0.1:3113
VITE_MELI_RPA_URL=http://127.0.0.1:3114
VITE_OPS_CONTROL_URL=http://127.0.0.1:3115
```

Credenciais sensiveis e segredos devem ficar apenas nos arquivos `.env` dos servicos:

- `services/whatsapp-baileys/.env`
- `services/telegram-telegraph/.env`
- `services/shopee-affiliate/.env`
- `services/mercadolivre-rpa/.env`

3. Reinicie o `npm run preview` apos alterar `.env`.

4. Diagnostico rapido do QR do WhatsApp:

```bash
# deve responder {"ok":true,...}
curl http://127.0.0.1:3111/health
```

- Diagnostico rapido Shopee API:

```bash
curl http://127.0.0.1:3113/health
```

- Se `VITE_WHATSAPP_MICROSERVICE_URL` nao estiver configurado, o sistema nao gera QR e exibira erro de configuracao.
- `WEBHOOK_SECRET` e credenciais de API nao devem ser expostos no frontend.

## Fluxo validado (monitorar e enviar)

- WhatsApp:
  - gera QR/pairing code;
  - captura mensagens de grupos (`message_received`);
  - sincroniza grupos;
  - envia mensagens para grupos (`send-message`).
- Telegram:
  - autentica por `send_code` + `verify_code` (+ `verify_password` quando 2FA);
  - captura mensagens de grupos/canais;
  - sincroniza grupos;
  - envia mensagens para grupos/canais.
- Agendamentos (`dispatch-messages`) agora enviam de fato via conectores reais e registram falhas no historico.
- Automacoes Shopee (`shopee-automation-run`) executam busca real na API Shopee, aplicam template e disparam para grupos da sessao configurada.

## Build

```bash
npm run build
```

## Deploy com Coolify (Hostinger)

Arquivos prontos para deploy:

- `docker-compose.coolify.yml`
- `docker/web.Dockerfile`
- `docker/whatsapp.Dockerfile`
- `docker/telegram.Dockerfile`
- `docker/shopee.Dockerfile`
- `docker/meli.Dockerfile`
- `docker/scheduler.Dockerfile`
- `.env.coolify.example`

Passos rapidos:

1. Rode `npm run deploy:preflight` para validar estrutura e arquivos obrigatorios.
2. Rode `npm run deploy:prepare` para bootstrap de env privado + docs automáticas + checklist.
3. Use `.private/env/.env.coolify` como base local para variáveis de deploy (não commitar).
4. No Coolify, crie um recurso `Docker Compose` apontando para `docker-compose.coolify.yml` (**nao use Application/Nixpacks**).
5. Cadastre as variaveis de ambiente iguais ao `.private/env/.env.coolify`.
   Inclua obrigatoriamente `RESEND_API_KEY`, `RESEND_FROM`, `APP_PUBLIC_URL` e `API_PUBLIC_URL` para verificacao de conta e reset de senha por e-mail.
  Para permitir start/stop/restart via Ops Control em produção, mantenha `DOCKER_CONTROL_ENABLED=true`.
6. Associe dominios e SSL para `web`, `whatsapp`, `telegram`, `shopee`, `meli` e `ops-control`.
7. Mantenha `.env`, `.env.local`, `.env.coolify` e toda a pasta `.private/` fora do GitHub.

Guia completo:

- `docs/HOSTINGER_COOLIFY_DEPLOY.md`
- `docs/DEPLOY_AUTOGENERATED.md` (gerado via `npm run deploy:docs`)

## Execucao 24/7 no Windows

Para manter todo o stack sempre ativo (frontend + WhatsApp + Telegram + Shopee + Mercado Livre), use PM2.

Guia completo: `docs/RUN_24_7_WINDOWS.md`.

Resumo rapido:

```bash
npm install -g pm2 pm2-windows-startup
npm run pm2:bootstrap
```

- O processo `autolinks-health-guardian` roda junto no PM2 para monitorar os 4 servicos e reiniciar automaticamente em caso de falhas consecutivas.
- Para agendamentos, automacoes e roteamento de mensagens (WhatsApp/Telegram) rodarem sem depender da interface aberta, configure `SCHEDULER_MODE=remote`, `SCHEDULER_RPC_BASE_URL` e `SCHEDULER_RPC_TOKEN`.

## Estudo de reestruturacao visual

- Guia de padronizacao visual (icones, componentes, transicoes, janelas, cards e flyout menus): `docs/VISUAL_RESTRUCTURING_STUDY.md`

## Estudo de estabilidade operacional

- Arquitetura com workers separados + fila dinamica por processo completo (24/7, prioridade global e anti-pico): `docs/WORKER_QUEUE_STABILITY_STUDY.md`

## Scripts principais

- `npm run dev`: sobe stack local completa e só abre o app quando API e serviços essenciais estiverem prontos
- `npm run dev:legacy`: fluxo antigo de desenvolvimento (frontend + Ops Control/API em paralelo, sem readiness completa)
- `npm run dev:web`: apenas frontend (sem Ops Control)
- `npm run preview`: sobe stack local completa (Supabase + API + WhatsApp + Telegram + Shopee + Mercado Livre + preview)
- `npm run preview:local`: sobe stack completa e preview local em `127.0.0.1:5173` (fallback sequencial: `5174`, `5175`, ...)
- `npm run preview:safe`: inicia somente o frontend em porta livre automaticamente (a partir da `5173`)
- `npm run preview:live`: sobe stack completa e preview na rede local (`0.0.0.0`)
- `npm run preview:dist`: preview do build de producao
- `npm run lint`: analise estatica
- `npm run deploy:preflight`: valida estrutura minima para deploy no Coolify (antes de subir para GitHub)
- `npm run deploy:docs`: gera documentação automática de deploy (vars, serviços e baseline de escala)
- `npm run deploy:prepare`: executa bootstrap de env privado + docs + commit safety + preflight
- `npm run env:private:setup`: cria `.private/env` e `.private/secrets` com templates locais
- `npm run commit:safety`: bloqueia arquivos sensíveis em commit/stage
- `npm run scheduler:start`: scheduler 24/7 (modo remoto quando `SCHEDULER_RPC_BASE_URL` estiver configurado)
- `npm run guardian:start`: monitor 24/7 de saude dos servicos
- `npm run svc:shopee:build`: build do servico Shopee
- `npm run svc:shopee:start`: sobe servico Shopee (porta `3113`)
- `npm run svc:ops:start`: sobe servico Ops Control (porta `3115`)

## Credenciais locais

- email admin: `robertokellercontato@gmail.com`
- senha admin: definida por `SEED_ADMIN_PASSWORD` (ou fallback `SEED_DEFAULT_PASSWORD`)
- email cliente: `aliancaslovely@gmail.com`
- senha cliente: definida por `SEED_USER_PASSWORD` (ou fallback `SEED_DEFAULT_PASSWORD`)

## Estrutura de alto nivel

- `src/pages`: telas
- `src/components`: componentes reutilizaveis
- `src/routes`: definicao modular das rotas
- `src/integrations/backend`: camada de dados/auth/rpc local
- `services`: microservicos externos (WhatsApp/Telegram)

## Observacoes

- O projeto usa Supabase PostgreSQL como banco unico (mesmo ambiente para local e deploy).
