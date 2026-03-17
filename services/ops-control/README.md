# Ops Control Service

Servico HTTP para controle operacional dos processos PM2 em producao.

## Endpoints

- `GET /health`
- `GET /api/services`
- `POST /api/services/:service/:action` (`action`: `start`, `stop`, `restart`)
- `POST /api/services/all/:action` (`action`: `start`, `stop`, `restart`)

Servicos suportados por padrao:

- `whatsapp` -> `autolinks-whatsapp`
- `telegram` -> `autolinks-telegram`
- `shopee` -> `autolinks-shopee`
- `meli` -> `autolinks-meli`

## Variaveis de ambiente

- `PORT` (default: `3115`)
- `HOST` (default: `0.0.0.0`)
- `OPS_CONTROL_TOKEN` token de autenticacao para o painel admin
- `ALLOW_INSECURE_NO_TOKEN=true` (somente dev local)

Painel admin (frontend) deve ter:

- `VITE_OPS_CONTROL_URL` ex.: `http://127.0.0.1:3115`
- Em produção, chamadas ops passam pelo API backend (que possui `OPS_CONTROL_TOKEN` server-side)

## Execucao

```bash
cd services/ops-control
npm install
npm run start
```

## Exemplo de chamada

```bash
curl -H "x-ops-token: <TOKEN>" http://127.0.0.1:3115/api/services
curl -X POST -H "x-ops-token: <TOKEN>" http://127.0.0.1:3115/api/services/whatsapp/restart
curl -X POST -H "x-ops-token: <TOKEN>" http://127.0.0.1:3115/api/services/all/restart
```

## Deploy

No PM2, o processo `autolinks-ops-control` deve ficar ativo junto dos servicos:

- `autolinks-whatsapp`
- `autolinks-telegram`
- `autolinks-shopee`
- `autolinks-meli`
- `autolinks-ops-control`
