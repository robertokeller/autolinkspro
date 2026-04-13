# Telegram Telegraph Service

Servico Node.js para integrar sessoes Telegram (cliente real) com backend HTTP em Node.

## Endpoints

- `GET /health`
- `POST /api/telegram/send_code`
- `POST /api/telegram/verify_code`
- `POST /api/telegram/verify_password`
- `POST /api/telegram/disconnect`
- `POST /api/telegram/sync_groups`
- `GET /api/telegram/events/:sessionId`
- `POST /api/telegram/send-message`

Todos os endpoints em `/api` exigem header `x-webhook-secret`.
Por padrao, o servico exige `WEBHOOK_SECRET` definido para iniciar e processar chamadas.
Somente em desenvolvimento e com opt-in explicito e possivel liberar sem segredo via
`ALLOW_INSECURE_NO_SECRET=true`.
No `send_code`, o `webhookUrl` agora e opcional (modo polling local).

## Variaveis de ambiente

Copie `.env.example` para `.env` e ajuste:

- `PORT` porta HTTP do servico
- `HOST` host bind (Replit: `0.0.0.0`)
- `WEBHOOK_SECRET` segredo compartilhado com o backend HTTP
- `ALLOW_INSECURE_NO_SECRET` (opcional, apenas dev local) permite iniciar sem segredo
- `TELEGRAM_SESSIONS_DIR` diretorio para persistencia da sessao
- `LOG_LEVEL` nivel de log (`info`, `warn`, `error`)

## Rodando local

```bash
cd services/telegram-telegraph
npm install
npm run build
npm run start
```

## Desenvolvimento local

```bash
cd services/telegram-telegraph
npm install
npm run dev
```

## Deploy no Replit

Use um Repl Node.js apontando para esta pasta e configure o comando:

```bash
cd services/telegram-telegraph && npm install && npm run build && npm run start
```

No painel de secrets do Replit, configure ao menos:

- `WEBHOOK_SECRET`
- `TELEGRAM_SESSIONS_DIR=.sessions`
- `LOG_LEVEL=info`

## Integracao com backend

No backend Node, defina:

- `TELEGRAM_MICROSERVICE_URL` URL publica do servico
- `TELEGRAM_API_ID` api id do Telegram
- `TELEGRAM_API_HASH` api hash do Telegram
- `WEBHOOK_SECRET` mesmo valor usado no servico

Com isso, o endpoint `telegram-connect` chamara este servico para autenticar, sincronizar grupos e enviar mensagens.
