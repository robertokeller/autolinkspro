# Scheduler 24/7 (Node)

Worker responsavel por executar disparos de agendamentos, automacoes de marketplace e eventos da central de mensagens continuamente.

## Comando

```bash
npm run scheduler:start
```

## Modos

- `SCHEDULER_MODE=auto` (padrao): usa modo `remote` quando `SCHEDULER_RPC_BASE_URL` existir; caso contrario, entra em fallback local informativo.
- `SCHEDULER_MODE=remote`: exige backend remoto com endpoint de funcoes.
- `SCHEDULER_MODE=local`: apenas informa limitacao do backend local baseado em navegador.

## Variaveis suportadas

- `SCHEDULER_RPC_BASE_URL`: base URL do backend remoto (ex: `https://seu-projeto.supabase.co`)
- `SCHEDULER_RPC_TOKEN`: token usado em `Authorization` e `apikey`
- `DISPATCH_INTERVAL_SECONDS` (default: `45`)
- `SHOPEE_INTERVAL_SECONDS` (default: `60`)
- `ADMIN_BROADCAST_INTERVAL_SECONDS` (default: `45`)
- `ADMIN_EVENTS_INTERVAL_SECONDS` (default: `60`)
- `DISPATCH_LIMIT` (default: `100`)
- `DISPATCH_SOURCE` (default: `node-scheduler`)
- `SCHEDULER_TIMEOUT_MS` (default: `15000`)

## Endpoints esperados no backend remoto

- `POST /functions/v1/dispatch-messages`
- `POST /functions/v1/shopee-automation-run`
- `POST /functions/v1/admin-wa-broadcast` (acao `dispatch_scheduled`)
- `POST /functions/v1/admin-message-automations` (acao `dispatch_automations`)

## Observacao importante

O scheduler depende do backend API (`services/api/`) e do PostgreSQL para ler agendamentos.
O modo `local` é apenas um fallback informativo — em produção e desenvolvimento, use sempre `SCHEDULER_MODE=remote` com `SCHEDULER_RPC_BASE_URL` apontando para a API.
