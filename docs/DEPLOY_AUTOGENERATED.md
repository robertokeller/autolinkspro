# Deploy Autogerado (Coolify)

> Arquivo gerado automaticamente por `scripts/generate-deploy-doc.mjs`.  
> Atualizado em: `2026-04-16T01:57:57.775Z`

## Fluxo automático recomendado

```bash
npm run env:private:setup
npm run deploy:docs
npm run deploy:preflight
```

Ou em comando único:

```bash
npm run deploy:prepare
```

## Regras de segurança para commit

- Nunca commitar `.env`, `.env.local`, `.env.coolify` e qualquer segredo.
- Use `.private/env/` para versões locais dos envs.
- Use `.private/secrets/` para segredos em arquivo local (ex.: salt local de criptografia).
- Rode `npm run commit:safety` antes de abrir PR.

## Variáveis obrigatórias no compose

| Variável | Serviços | Default no compose | Exemplo em .env.coolify.example |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | api | - | suporte@autolinks.pro |
| `ADMIN_PASSWORD` | api | - | troque-por-uma-senha-forte |
| `API_PUBLIC_URL` | api | - | https://api.autolinks.pro |
| `APP_PUBLIC_URL` | api | - | https://autolinks.pro |
| `BACKUP_ENCRYPTION_KEY` | sessions-backup | - | troque-por-chave-forte-de-backup |
| `CORS_ORIGIN` | amazon, api, ops-control, shopee, telegram, whatsapp | - | https://autolinks.pro |
| `CREDENTIAL_CIPHER_SALT` | api | - | troque-por-salt-hex-64-caracteres |
| `CREDENTIAL_ENCRYPTION_KEY` | api | - | troque-por-chave-hex-64-caracteres |
| `DATABASE_URL` | api | - | postgresql://postgres:[SUA-SENHA]@db.rwurwyuhxvlnykosfkdj.supabase.co:5432/postgres |
| `JWT_SECRET` | api | - | troque-por-um-segredo-com-32-caracteres-ou-mais |
| `MELI_CORS_ORIGIN` | meli | - | https://autolinks.pro |
| `OPS_CONTROL_TOKEN` | api, ops-control | - | troque-por-ops-token-forte |
| `RESEND_API_KEY` | api | - | re_xxxxxxxxxxxxxxxxxxxxxxxxx |
| `RESEND_FROM` | api | - | Auto Links <suporte@autolinks.pro> |
| `SERVICE_TOKEN` | api, scheduler | - | troque-por-token-forte-de-servico |
| `TELEGRAM_API_HASH` | telegram | - | troque-por-telegram-api-hash |
| `TELEGRAM_API_ID` | telegram | - | 123456 |
| `WEBHOOK_SECRET` | amazon, api, meli, ops-control, shopee, telegram, whatsapp | - | troque-por-webhook-secret-forte |

## Variáveis opcionais no compose

| Variável | Serviços | Default no compose | Exemplo em .env.coolify.example |
| --- | --- | --- | --- |
| `ALLOW_PUBLIC_RPC` | api | false | false |
| `AUTH_COOKIE_DOMAIN` | api | - | .autolinks.pro |
| `BURST_THRESHOLD_PER_BUCKET` | api | 500 | - |
| `CHANNEL_EVENTS_INTERVAL_SECONDS` | scheduler | 15 | 15 |
| `DB_POOL_MAX` | api | 10 | - |
| `DB_SSL` | api | true | true |
| `DB_SSL_REJECT_UNAUTHORIZED` | api | true | true |
| `DISABLE_SIGNUP` | api | true | true |
| `DISPATCH_INTERVAL_SECONDS` | scheduler | - | 15 |
| `DISPATCH_LIMIT` | scheduler | - | 25 |
| `DISPATCH_SOURCE` | scheduler | - | scheduler |
| `DOCKER_CONTROL_ENABLED` | ops-control | true | true |
| `DOCKER_SERVICE_LABEL_KEY` | ops-control | com.docker.compose.service | com.docker.compose.service |
| `EMAIL_VERIFY_TOKEN_TTL_MINUTES` | api | 1440 | 1440 |
| `LOG_LEVEL` | amazon, meli, shopee, telegram, whatsapp | info | info |
| `MEDIA_CAPTURE_DEBUG` | telegram, whatsapp | false | false |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | api | 30 | 30 |
| `RESEND_REPLY_TO` | api | - | suporte@autolinks.pro |
| `ROUTE_MEDIA_DEBUG` | api, telegram, whatsapp | false | false |
| `SCHEDULER_RPC_BASE_URL` | scheduler | http://api:3116 | https://api.autolinks.pro |
| `SCHEDULER_TIMEOUT_MS` | scheduler | - | 20000 |
| `SESSIONS_BACKUP_KEEP_DAYS` | sessions-backup | 7 | 7 |
| `SESSIONS_BACKUP_SCHEDULE` | sessions-backup | 0 4 * * * | 0 4 * * * |
| `SHOPEE_INTERVAL_SECONDS` | scheduler | - | 60 |
| `VITE_AMAZON_MICROSERVICE_URL` | web | - | https://amazon-api.autolinks.pro |
| `VITE_API_URL` | web | - | https://api.autolinks.pro |
| `VITE_BROWSER_RUNTIME_ENABLED` | web | false | false |
| `VITE_MELI_RPA_URL` | web | - | https://meli-api.autolinks.pro |
| `VITE_OPS_CONTROL_URL` | web | - | https://ops-api.autolinks.pro |
| `VITE_SHOPEE_MICROSERVICE_URL` | web | - | https://shopee-api.autolinks.pro |
| `VITE_TELEGRAM_MICROSERVICE_URL` | web | - | https://tg-api.autolinks.pro |
| `VITE_WHATSAPP_MICROSERVICE_URL` | web | - | https://wa-api.autolinks.pro |

## Capacidade inicial por serviço (baseline de escala)

| Serviço | Limite de memória | Limite de CPU | Healthcheck |
| --- | --- | --- | --- |
| `amazon` | 256M | 0.25 | http://127.0.0.1:3117/health |
| `api` | 768M | 2.0 | http://127.0.0.1:3116/health |
| `meli` | 1G | 1.5 | http://127.0.0.1:3114/api/meli/health |
| `ops-control` | 256M | 0.25 | http://127.0.0.1:3115/health |
| `scheduler` | 256M | 0.25 | - |
| `sessions-backup` | - | - | - |
| `shopee` | 512M | 0.5 | http://127.0.0.1:3113/health |
| `telegram` | 512M | 0.5 | http://127.0.0.1:3112/health |
| `web` | 256M | 0.5 | http://127.0.0.1:3000/ |
| `whatsapp` | 512M | 0.5 | http://127.0.0.1:3111/health |

## Próximos passos de escala (skill: scalability)

- Validar p95/p99 por serviço com carga sintética antes de campanha.
- Ajustar `deploy.resources.limits` conforme uso real de CPU/memória.
- Escalar horizontalmente serviços stateless primeiro (`web`, `api`, `scheduler`).
- Manter filas/scheduler idempotentes para evitar duplicidade em retry/redeploy.
