# Kiwify Plan Execution + Due Diligence (2026-04-10)

## Objetivo
Executar um plano incremental e seguro para endurecer a dinâmica de planos (trial, expiração, transações pendentes e grace period), com validação técnica ao final.

## Plano revisado em fases

### Fase 1 — Downgrade seguro sem trial infinito
- Problema tratado:
  - downgrade financeiro (refund/chargeback) deixava `plan_expires_at` nulo em `plan-starter`, podendo manter acesso sem vencimento.
- Implementação:
  - export de função de downgrade com modo explícito (`immediate` ou `trial`).
  - modo padrão `immediate` aplica expiração imediata.
- Evidência:
  - `services/api/src/kiwify/webhook-handler.ts`

### Fase 2 — Bloqueio de pending activation após reversão
- Problema tratado:
  - compras salvas como `pending_activation` podiam ser ativadas no signup mesmo após evento de estorno/cancelamento/chargeback.
- Implementação:
  - `activatePendingKiwifyPurchases` agora:
    - carrega `kiwify_product_id` corretamente.
    - verifica eventos/estados de reversão por `kiwify_order_id`.
    - marca item como `blocked_by_reversal` e não ativa plano nesses casos.
- Evidência:
  - `services/api/src/kiwify/webhook-handler.ts`

### Fase 3 — Grace period operacional no reconciler
- Problema tratado:
  - `subscription_late` era apenas registrado, sem transição real após período de graça.
- Implementação:
  - reconciler ganhou rotina `enforceLateSubscriptionGracePeriod`:
    - detecta `subscription_late` expirado pelo `grace_period_days`.
    - evita duplicidade com `grace_period_expired` já registrado.
    - ignora casos recuperados por `subscription_renewed`/ativação posterior.
    - executa downgrade imediato e registra evento `grace_period_expired` com status `downgraded`.
  - contador `downgraded` adicionado no resultado do reconciler.
- Evidência:
  - `services/api/src/kiwify/reconciler.ts`

## Validação técnica (due diligence)

### 1) Build e consistência de tipos
- `npm run build --prefix services/api` executado com sucesso.
- Sem erros de TypeScript nos arquivos alterados.

### 2) Segurança e integridade de negócio
- Confirmado fail-closed para ativação pendente quando há indício de reversão financeira.
- Reduzido risco de acesso indevido pós-estorno/chargeback.
- Grace period deixa de ser apenas informativo e passa a ser aplicável.

### 3) Idempotência e reprocessamento
- Reconciler evita downgrade duplicado para mesma ordem via marcador `grace_period_expired`.
- Recuperação pós-late (renovação/ativação) impede downgrade indevido.

### 4) Compatibilidade e impacto
- Mudanças preservam contratos existentes (webhook route, RPCs e schema atual).
- Sem necessidade de migração SQL para esta etapa.

## Riscos residuais (abertos)
1. Falta estado canônico de assinatura (subscription table dedicada) para reduzir ambiguidade entre eventos de pedido e ciclo de assinatura.
2. A aba de afiliados ainda não calcula métricas financeiras locais completas (usa placeholders para contadores/ganhos agregados).
3. Reconciler ainda não reconcilia todos os tipos de divergência financeira em um ledger formal (bruto/taxa/comissão/líquido por evento).

## Próxima fase recomendada
- Introduzir modelo canônico:
  - `billing_subscriptions`
  - `billing_events`
  - `billing_ledger`
- Tornar projeção de acesso (`profiles.plan_id/plan_expires_at`) derivada desse núcleo, mantendo webhook + reconciler como fontes de atualização.
