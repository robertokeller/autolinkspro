# Cloudflare Rollout Plan (No-Break Strategy)

Objetivo: preparar o ambiente para ativar Cloudflare no proximo deploy sem interromper os servicos validados.

## Escopo Coberto

- Frontend: `autolinks.pro`
- API: `api.autolinks.pro`
- Microservicos: `wa-api`, `tg-api`, `shopee-api`, `meli-api`, `amazon-api`, `ops-api`
- Impacto analisado para:
  - WhatsApp
  - Telegram
  - Shopee
  - Amazon
  - Mercado Livre (Playwright)
  - Extensao de cookies do Mercado Livre (bridge + RPC)

## Matriz de Risco

| Area | Risco | Probabilidade | Impacto | Mitigacao |
|---|---|---:|---:|---|
| DNS / Cutover | Nameserver incorreto ou propagacao parcial | Media | Alto | Pre-stage no Cloudflare, trocar NS em janela controlada, validar por etapa com `npm run cloudflare:verify`. |
| TLS | Modo SSL inadequado (Flexible) quebrar cookies/sessoes | Baixa | Alto | Forcar `ssl=strict` e `always_use_https=on`. |
| API RPC | WAF challenge em rotas de API (`/functions/v1/rpc`) | Media | Alto | Comecar com regras basicas (sem challenge agressivo), validar extensao e login apos cutover. |
| Webhooks | Bloqueio de webhook por protecao edge | Media | Alto | Manter segredo `WEBHOOK_SECRET`, testar webhook apos cutover, criar excecao de WAF somente se necessario. |
| Mercado Livre Playwright | Falha intermitente por session file/cookies durante transicao | Media | Medio/Alto | Mudancas de rehydrate ja aplicadas no backend + smoke de conversao apos ativacao. |
| Extensao cookies ML | CORS/origin bloqueado | Media | Alto | Garantir `ALLOWED_EXTENSION_ORIGINS` + `connect-src` para `https://api.autolinks.pro`; testar fluxo `/meli/configuracoes`. |
| Ops Control | Health/restart bloqueados por edge | Baixa | Medio | Manter `x-ops-token` e validar `ops-api` com script de verify. |
| Observabilidade | Falso positivo de indisponibilidade durante propagacao DNS | Media | Medio | Rodar checagem de status com e sem cache DNS local (curl + verify script). |

## Fase 0 - Pre-requisitos

1. Garantir backup atual:
   - Banco (Supabase backup/snapshot)
   - Volumes de sessao (`wa_sessions`, `tg_sessions`, `meli_sessions`)
2. Garantir segredos validos no Coolify:
   - `WEBHOOK_SECRET`, `OPS_CONTROL_TOKEN`, `SERVICE_TOKEN`
   - `CORS_ORIGIN`, `MELI_CORS_ORIGIN`, `APP_PUBLIC_URL`, `API_PUBLIC_URL`
3. Garantir build verde:
   - `npm run svc:api:build`
   - `npm run svc:meli:build`
   - `npm run build`

## Fase 1 - Pre-stage Cloudflare (sem corte)

Configurar ambiente local (exemplo):

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_ZONE_NAME=autolinks.pro
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_ORIGIN_IPV4=72.62.11.177
CLOUDFLARE_PROXY_MODE=edge
CLOUDFLARE_INCLUDE_SERVICE_HOSTS=true
```

Executar:

```bash
npm run cloudflare:plan
npm run cloudflare:apply
npm run cloudflare:verify
```

O bootstrap aplica:

- DNS records idempotentes para dominios do stack
- SSL/TLS:
  - `ssl = strict`
  - `always_use_https = on`
  - `min_tls_version = 1.2`
  - `tls_1_3 = on`
  - `automatic_https_rewrites = on`

## Fase 2 - Proximo Deploy (Coolify)

1. Deploy normal no Coolify com compose atual.
2. Confirmar health interno (containers `healthy`).
3. Rodar smoke:

```bash
npm run smoke:coolify
```

## Fase 3 - Ativacao Cloudflare (janela de cutover)

1. Trocar nameservers no provedor do dominio para os NS da zona Cloudflare.
2. Aguardar propagacao inicial.
3. Validar:

```bash
npm run cloudflare:verify
npm run cloudflare:verify:strict
```

4. Validacao funcional por servico:
   - Login + refresh de sessao no frontend
   - WhatsApp: listar sessao + envio teste
   - Telegram: listar sessao + envio teste
   - Shopee: conversao de link
   - Amazon: conversao de link
   - Mercado Livre:
     - salvar/testar sessao
     - converter link unitario e batch
     - fluxo da extensao em `/meli/configuracoes`

## Fase 4 - Rollback

Se houver regressao critica:

1. Reverter nameservers para os anteriores (Hostinger).
2. Manter aplicacao no Coolify rodando (origem continua disponivel).
3. Corrigir regra de edge (DNS/proxy/WAF) e repetir validacao em staging.

## Guardrails de Seguranca

- Nao armazenar `CLOUDFLARE_API_TOKEN` no repositiorio.
- Preferir token de escopo minimo:
  - `Zone:Read`, `Zone Settings:Edit`, `DNS:Edit`
- Rotacionar tokens expostos em chat/log imediatamente.
- Manter `CLOUDFLARE_PROXY_MODE=edge` no inicio para reduzir risco em microservicos.

