# Estudo Técnico - Workers Separados + Fila Dinâmica por Processo

## Objetivo
Garantir operação 24/7 estável para ~20 usuários simultâneos com fluxos compostos (rotas automáticas, agendamentos, automações, conversões), minimizando risco de pico, travamento e degradação em cascata.

## Premissas
- Processos críticos atuais: WhatsApp, Telegram, Shopee, Mercado Livre, Ops Control.
- Fluxos de negócio são compostos e encadeados.
- Picos são imprevisíveis (mensagens, conversões, execuções simultâneas).
- Requisito: priorização global, comando global com baixo impacto e alta estabilidade.

## Decisão Arquitetural
### 1) Fila por processo completo (não por etapa)
Cada evento vira um job atômico, executado de ponta a ponta no worker.

Exemplo `rota_automatica` (um único job):
1. Receber evento
2. Resolver/converter link
3. Aplicar template
4. Enviar para destino
5. Persistir histórico e auditoria

Isso preserva consistência de negócio e simplifica idempotência/retry.

### 2) Workers separados por domínio
- `worker-whatsapp`
- `worker-telegram`
- `worker-shopee`
- `worker-meli`
- `control-plane` (Ops Control) apenas para política, monitoramento e comando global

### 3) Broker de fila
- Recomendado: Redis + BullMQ
- Cada tipo de processo em sua fila lógica:
  - `q.process.route`
  - `q.process.schedule`
  - `q.process.automation`
  - `q.process.convert_manual`

## Scheduler Global Dinâmico
## Papel
O scheduler decide admissão de jobs, prioridade e concorrência global. Ele não executa payload pesado.

## Modos operacionais
- `normal`
- `warn`
- `critical`

## Sinais para decisão
- `host_mem_used_percent`
- `cpu_pressure`
- `backlog_size`
- `oldest_job_age`
- `error_rate`
- `latency_p95`

## Histerese (anti-flap)
Troca de modo apenas após N janelas consecutivas.
- Exemplo: 3 leituras consecutivas para subir modo
- 5 leituras consecutivas para descer modo

## Política de Prioridade Global
- **P1**: Rotas automáticas em tempo real
- **P2**: Agendamentos vencidos
- **P3**: Conversões manuais
- **P4**: Automações periódicas/varredura

Em pico:
- P1 e P2 mantidos
- P3 desacelerado
- P4 pausado primeiro

## Controle de Concorrência por Custo
## Conceito
Não usar apenas quantidade de jobs; usar custo estimado por processo.

Exemplo inicial de custo:
- `route_process`: 2
- `schedule_process`: 2
- `convert_manual`: 3
- `automation_scan`: 4

## Orçamento
- Capacidade teórica: 10 unidades
- Orçamento operacional: 5 unidades
- Reserva: 5 unidades (headroom)

Regra:
- Executar novo job apenas se `custo_ativo + custo_job <= orçamento`
- Caso contrário, enfileirar

## Anti-pico (suavização)
- Jitter de atraso pequeno por job:
  - dispatch: 300ms a 1200ms
  - conversão: 500ms a 2000ms
- Rate limit por sessão e por usuário
- Backpressure: bloquear admissão de baixa prioridade antes de saturar

## Resiliência e Segurança
### Idempotência
- Chave por processo (`tenantId + processType + sourceMessageId`)
- Evita duplicidade de envio em retries/reentregas

### Retry
- Backoff exponencial + jitter
- Limite máximo de tentativas

### DLQ
- Falha persistente vai para dead-letter queue
- Reprocessamento manual/assistido

### Circuit breaker
- Para integrações externas instáveis (Shopee/ML/Telegram/WhatsApp API)

### Bulkhead
- Isolamento entre workers para impedir falha em cascata

## Comando Global (baixo impacto)
O comando global não força execução síncrona em massa.
Ele altera política dinâmica:
- concorrência
- prioridade
- pausas seletivas
- orçamento operacional

Aplicação em rolling steps com cooldown, abort e rollback automático em caso de piora.

## Monitoramento (telemetria obrigatória)
Por worker:
- backlog
- oldest job age
- throughput
- latency p95/p99
- error rate
- retries
- dlq count
- rss/heap/cpu/event-loop-lag

Global:
- modo atual (`normal|warn|critical`)
- orçamento usado
- taxa de shedding
- fairness por usuário

## Fairness (justiça entre usuários)
- Cota máxima por usuário em fila e execução
- Ex.: nenhum tenant pode consumir > X% do orçamento global continuamente

## Sizing recomendado (20 usuários)
### Com arquitetura atual + filas dinâmicas
- Mínimo: 8 vCPU / 16 GB RAM
- Recomendado com folga: 12 vCPU / 24 GB RAM

### Meta de operação
- Reservar ~35% de headroom para picos
- Nunca operar continuamente acima de ~75% de memória

## SLO sugerido
- P1 (rotas): 99% em até 10-20s
- P2 (agendamentos): 99% em até 30-60s
- P3/P4: best effort com degradação controlada

## Plano de implementação (sem ruptura)
### Fase 1 - Fundação
- Introduzir broker e filas por processo completo
- Implementar idempotência/retry/DLQ
- Instrumentar métricas básicas

### Fase 2 - Scheduler dinâmico
- Modos `normal|warn|critical`
- Orçamento por custo de processo
- Histerese e backpressure

### Fase 3 - Hardening
- Fairness por usuário
- Circuit breaker por integração
- Comando global rolling com rollback

### Fase 4 - Validação de produção
- Stress test com burst
- Teste de caos (falha de integração)
- Tuning final de thresholds

## Critérios de aceite
- Sem perda de evento em pico
- Sem duplicidade em retry
- Sem parada global por rajada
- Recuperação automática após pico
- Comando global sem causar efeito cascata

## Valores iniciais recomendados (baseline)
- `MAX_COST_BUDGET=5`
- `MODE_WARN_MEM=75`
- `MODE_CRITICAL_MEM=85`
- `MODE_WARN_CPU=1.2`
- `MODE_CRITICAL_CPU=1.8`
- `HYSTERESIS_UP=3`
- `HYSTERESIS_DOWN=5`
- `RETRY_MAX=5`
- `RETRY_BACKOFF_BASE_MS=2000`
- `RETRY_BACKOFF_MAX_MS=120000`

## Observação importante
No Windows, `loadavg` pode não refletir pressão real de CPU. Em produção Linux/Coolify, a métrica é mais confiável. Para ambiente local Windows, complementar CPU com contador de processo/sistema para tuning realista.
