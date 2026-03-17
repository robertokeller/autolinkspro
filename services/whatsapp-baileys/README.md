# WhatsApp Baileys Service

Servico Node.js para integrar sessoes WhatsApp via Baileys com backend HTTP em Node.

## Endpoints

- `GET /health`
- `POST /api/sessions/:sessionId/connect`
- `POST /api/sessions/:sessionId/disconnect`
- `POST /api/sessions/:sessionId/sync-groups`
- `GET /api/sessions/:sessionId/events`
- `POST /api/send-message`

Todos os endpoints em `/api` exigem header `x-webhook-secret`.
Por padrao, o servico exige `WEBHOOK_SECRET` definido para iniciar e processar chamadas.
Somente em desenvolvimento e com opt-in explicito e possivel liberar sem segredo via
`ALLOW_INSECURE_NO_SECRET=true`.
O `webhookUrl` no `connect` agora e opcional (modo polling local).

## Variaveis de ambiente

Copie `.env.example` para `.env` e ajuste:

- `PORT` porta HTTP do servico
- `HOST` host bind (Replit: `0.0.0.0`)
- `WEBHOOK_SECRET` segredo compartilhado com o backend HTTP
- `ALLOW_INSECURE_NO_SECRET` (opcional, apenas dev local) permite iniciar sem segredo
- `BAILEYS_SESSIONS_DIR` diretorio para persistencia das credenciais
- `LOG_LEVEL` nivel de log (`info`, `warn`, `error`)

## Rodando local

```bash
cd services/whatsapp-baileys
npm install
npm run build
npm run start
```

## Desenvolvimento local

```bash
cd services/whatsapp-baileys
npm install
npm run dev
```

## Deploy no Replit

Use um Repl Node.js apontando para esta pasta e configure o comando:

```bash
cd services/whatsapp-baileys && npm install && npm run build && npm run start
```

No painel de secrets do Replit, configure ao menos:

- `WEBHOOK_SECRET`
- `BAILEYS_SESSIONS_DIR=.sessions`
- `LOG_LEVEL=info`

## Integracao com backend

No backend Node, defina:

- `WHATSAPP_MICROSERVICE_URL` URL publica do servico
- `WEBHOOK_SECRET` mesmo valor usado no servico

Com isso, o endpoint `whatsapp-connect` pode chamar este servico para conectar, desconectar e sincronizar grupos.
