# Shopee Affiliate Service

Servico Node.js para executar chamadas reais da API Shopee Affiliate (GraphQL), sem depender de Deno/Supabase.

## Endpoints

- `GET /health`
- `POST /api/shopee/test-connection`
- `POST /api/shopee/convert-link`
- `POST /api/shopee/batch`

Todos os endpoints em `/api` exigem header `x-webhook-secret`.
Por padrao, o servico exige `WEBHOOK_SECRET` definido para iniciar e processar chamadas.
Somente em desenvolvimento e com opt-in explicito e possivel liberar sem segredo via
`ALLOW_INSECURE_NO_SECRET=true`.

## Variaveis de ambiente

Copie `.env.example` para `.env` e ajuste:

- `PORT` porta HTTP do servico
- `HOST` host bind
- `WEBHOOK_SECRET` segredo compartilhado com o backend HTTP local
- `ALLOW_INSECURE_NO_SECRET` (opcional, apenas dev local) permite iniciar sem segredo
- `LOG_LEVEL` nivel de log (`info`, `warn`, `error`)

## Rodando local

```bash
cd services/shopee-affiliate
npm install
npm run build
npm run start
```

## Desenvolvimento local

```bash
cd services/shopee-affiliate
npm install
npm run dev
```
