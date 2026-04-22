# Implementação - Página de Métricas

**Data:** 2026-04-13  
**Status:** ✅ Concluído e testado no build  
**Atualização:** ✅ Grupos administrados via RPC + Dashboard geral

---

## 📦 O que foi implementado

### Backend (WhatsApp Baileys Service)

#### Novos módulos criados:
```
services/whatsapp-baileys/src/analytics/
├── types.ts                    # Interfaces TypeScript de todas as métricas
├── ddd-to-state.ts             # Mapeamento DDD → Estado → IBGE + cores
├── store.ts                    # Storage engine (JSON files)
├── collector.ts                # Coletor de eventos em tempo real
├── index.ts                    # Export unificado
└── metrics/
    ├── composition.ts          # Tamanho, crescimento, capacidade
    ├── geography.ts            # Distribuição por estado + heatmap
    ├── churn-daily.ts          # Entradas/saídas por dia
    ├── churn-trends.ts         # Tendências + anomalias
    ├── churn-retention.ts      # Retenção + tempo no grupo
    ├── cross-group.ts          # Overlapping multi-grupos
    └── health-score.ts         # Score de saúde ponderado
```

#### Endpoints API adicionados:
```
GET /api/analytics/groups/:groupId/composition
GET /api/analytics/groups/:groupId/geography
GET /api/analytics/groups/:groupId/churn/daily
GET /api/analytics/groups/:groupId/churn/trends
GET /api/analytics/groups/:groupId/churn/retention
GET /api/analytics/groups/:groupId/health
GET /api/analytics/groups/:groupId/summary
GET /api/analytics/cross-group/overlapping
```

#### Funções RPC adicionadas:
```
POST /functions/v1/rpc  { name: "analytics-admin-groups" }
  → Retorna grupos WhatsApp administrados pelo usuário
  → Busca da tabela `groups` WHERE user_id = $1 AND platform = 'whatsapp'
```

#### Integração no server.ts:
- ✅ `SessionState` exportado para uso do collector
- ✅ Analytics collector inicializado no `bootSocket` quando conexão abre
- ✅ Listener `group-participants.update` captura entradas/saídas
- ✅ Snapshots diários agendados automaticamente
- ✅ `proxyAnalytics` no RPC para forwarding seguro

### Frontend (React)

#### Componentes criados:
```
src/components/metrics/
├── BrasilMap.tsx               # Mapa interativo do Brasil
├── CapacidadePorGrupo.tsx      # Capacidade e ocupação por grupo
├── GruposDesempenho.tsx        # Ranking de desempenho por grupo
├── HistoricoMovimentos.tsx     # Histórico e tendências
└── RecapturaAutomatica.tsx     # Regras de recaptura e fila
```

#### Página principal:
```
src/pages/Metricas.tsx          # Página completa com tabs
```

#### Integração:
```
src/integrations/
└── analytics-client.ts         # Cliente HTTP + fetchAdminGroups() via RPC
```

#### Rotas e Navegação:
- ✅ Rota `/metricas` registrada em `routes.ts`
- ✅ Título "Metricas" em `APP_ROUTE_TITLES`
- ✅ Página lazy-loaded em `lazy-pages.ts`
- ✅ Rota protegida em `app-routes.tsx`
- ✅ Link no sidebar "Ferramentas" com ícone BarChart3

---

## 🔧 Funcionalidades implementadas

### 1. Dashboard Geral (Sempre Visível)
| Métrica | Descrição |
|---------|-----------|
| Total Membros | Soma de membros do grupo selecionado |
| Grupos | Nº de grupos administrados |
| Crescimento Semanal | Taxa de crescimento semanal |
| Entradas | Total de entradas no período |
| Saídas | Total de saídas no período |
| Capacidade | % uso do limite de 1024 |

### 2. Grupos Administrados (Auto-populados)
- Grupos buscados via RPC `analytics-admin-groups`
- Filtrados por `user_id` e `platform = 'whatsapp'`
- Dropdown mostra nome + nº de membros
- Opção "Todos os grupos" para visão agregada

### 3. Composição do Grupo
| Métrica | Descrição |
|---------|-----------|
| Tamanho total | Nº de membros atual |
| Taxa de crescimento | Membros/dia e membros/semana |
| Capacidade utilizada | % do limite de 1024 |
| Distribuição geográfica | DDDs → Estados com mapa de calor |

### 4. Entrada/Saída (Churn)
| Métrica | Descrição |
|---------|-----------|
| Entrantes por período | Quantos entraram por dia |
| Saídas por período | Quantos saíram/removidos por dia |
| Taxa de Rotatividade | % = saídas / total_membros × 100 |
| Crescimento líquido | Entradas - Saídas |
| Média diária | Membros/dia em média |

### 5. Multi-Grupos
| Métrica | Descrição |
|---------|-----------|
| Membros únicos | Total de membros distintos |
| Overlapping | Membros em 2+ grupos |
| Exclusivos | Membros em apenas 1 grupo |
| Taxa de overlap | % de membros em múltiplos grupos |

### 6. Health Score
| Componente | Peso | Descrição |
|------------|------|-----------|
| Crescimento | 15% | Taxa semanal de crescimento |
| Capacidade | 10% | Uso do limite de 1024 |
| Diversidade | 5% | Nº de estados diferentes |
| Rotatividade | 15% | % de saídas no período |
| Retenção | 15% | % de membros ativos |
| Tendência | 10% | Direção do crescimento |
| Engajamento | 20% | Overlapping multi-grupos |

---

## 📊 Fluxo de dados

```
Evento WhatsApp                    Coletor                     Storage
┌──────────────────┐      ┌───────────────────┐       ┌─────────────────────┐
│ group-participants│─────>│ setupAnalytics    │──────>│ storeEvent()        │
│ .update          │      │ Collector()       │       │ captureSnapshot()   │
└──────────────────┘      └───────────────────┘       └─────────────────────┘

Storage                     Calculadores                    API
┌──────────────────┐      ┌───────────────────┐       ┌─────────────────────┐
│ .analytics/      │─────>│ calculateComposition│─────>│ GET /api/analytics/ │
│ events/          │      │ calculateGeography  │       │ groups/:groupId/... │
│ groups/          │      │ calculateDailyChurn │       └─────────────────────┘
└──────────────────┘      │ calculateRetention  │
                          │ calculateCrossGroup │
                          │ calculateHealthScore│
                          └───────────────────┘

Frontend                    Componentes React               Usuário
┌──────────────────┐      ┌───────────────────┐       ┌─────────────────────┐
│ analytics-client │─────>│ Metricas.tsx      │──────>│ /metricas           │
│ .ts              │      │ - KPIs principais │       │ - Tabs/Sub-tabs     │
│                  │      │ - Mapa interativo │       │ - Mapa interativo   │
│                  │      │ - Ranking grupos  │       │ - Tabela ranking    │
│                  │      │ - Histórico       │       └─────────────────────┘
└──────────────────┘      └───────────────────┘
```

---

## 🗂️ Estrutura de armazenamento

```
.services/whatsapp-baileys/.analytics/
├── events/
│   ├── 2026-04-13.jsonl      # Eventos do dia (NDJSON)
│   ├── 2026-04-12.jsonl
│   └── ...
└── groups/
    └── {groupId}/
        └── snapshots/
            ├── 2026-04-13.json  # Snapshot diário
            ├── 2026-04-12.json
            └── ...
```

### Formato de evento (JSONL):
```json
{
  "type": "member_joined",
  "groupId": "123456789@g.us",
  "groupName": "Grupo Exemplo",
  "participantPhone": "5511999999999",
  "participantDDD": "11",
  "participantState": "SP",
  "authorPhone": "5511888888888",
  "timestamp": "2026-04-13T10:30:00.000Z"
}
```

### Formato de snapshot (JSON):
```json
{
  "groupId": "123456789@g.us",
  "groupName": "Grupo Exemplo",
  "date": "2026-04-13",
  "totalMembers": 150,
  "members": [
    {
      "phone": "5511999999999",
      "ddd": "11",
      "state": "SP",
      "isAdmin": false,
      "joinedAt": "2026-04-13T10:30:00.000Z"
    }
  ]
}
```

---

## 🎨 Visual da Página

```
┌─────────────────────────────────────────────────────────────────┐
│  Métricas                                                       │
│  Análise de saúde e performance dos grupos administrados        │
├─────────────────────────────────────────────────────────────────┤
│  Grupo: [Grupo A (150 membros) ▼]  Período: [30d ▼]  [Atualizar]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐            │
│  │👥150│ │💬 1 │ │📈+2.│ │📥 12│ │📤 3 │ │🛡️14│            │
│  │Membr│ │Grp  │ │ %   │ │Entr │ │Saíd │ │ %Cap│            │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘            │
│                                                                 │
│  [Dashboard]  [Composição]  [Entrada/Saída]  [Multi-Grupos]   │
│  ───────────────────────────────────────────────────────────   │
│                                                                 │
│  (Tab Dashboard)                                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  💚 Health Score: 72 (B) - Bom                          │   │
│  │  (círculo 72%)  Crescimento: 25/30  Rotatividade: 22/30 │   │
│  │  "Grupo estável - Atenção ao churn"                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  (Tab Composição → Sub-tab Visão Geral)                        │
│  ┌────────────────────────────┬──────────────────────────┐    │
│  │ [MAPA DO BRASIL]          │  Ranking por Estado      │    │
│  │  com heatmap interativo   │  1. SP  45 (30%)        │    │
│  │  hover → detalhes         │  2. RJ  30 (20%)        │    │
│  │  legenda de cores         │  3. MG  22 (15%)        │    │
│  └────────────────────────────┴──────────────────────────┘    │
│                                                                 │
│  (Tab Entrada/Saída → Sub-tab Diário)                          │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  [GRÁFICO BARRAS: Entradas vs Saídas por dia]       │     │
│  │  Cards: Total Entradas, Total Saídas, Cresc. Líq.   │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                 │
│  (Tab Multi-Grupos)                                            │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  Membros Únicos: 450 | Overlapping: 78 | Exclusivos:│     │
│  │  Tabela: +5511999999999 → 4 grupos                   │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Testes de Build

| Componente | Status |
|------------|--------|
| TypeScript Baileys Service | ✅ 0 erros |
| Build Baileys Service | ✅ Sucesso |
| TypeScript Frontend | ✅ 0 erros |
| Build Frontend (Vite) | ✅ Sucesso |
| Bundle Métricas | 34.48 kB (gzip: 10.60 kB) |
| Bundle Mapa | Incluído no chunk principal |

---

## 🚀 Como usar

### 1. Iniciar serviços:
```bash
# Terminal 1 - WhatsApp Baileys
npm run svc:wa:dev

# Terminal 2 - API Gateway
npm run svc:api:dev

# Terminal 3 - Frontend
npm run dev
```

### 2. Acessar página:
- Navegar até `/metricas`
- Selecionar grupo no dropdown
- Selecionar período (7d, 30d, 90d)
- Clicar em "Atualizar"

### 3. Coleta automática de dados:
- Eventos são capturados em tempo real quando membros entram/saem
- Snapshots diários são agendados automaticamente à meia-noite
- Para dados iniciais: fazer um snapshot manual via código ou aguardar eventos

---

## 🔄 Próximos passos recomendados

1. **Popular dados iniciais**: Criar script para gerar snapshots retroativos a partir de grupos atuais
2. **Adicionar RPC no frontend**: Substituir chamadas diretas de API por `invokeBackendRpc("analytics", ...)` para consistência
3. **Melhorar dropdown de grupos**: Buscar lista real de grupos do usuário via API
4. **Adicionar exports**: Botão para exportar dados CSV/JSON
5. **Alertas visuais**: Destacar quando churn > 10% ou health score < 40
6. **Gráficos de linha**: Usar Recharts para tendência de crescimento
7. **Tabela de retenção**: Mostrar top stayers e recent leavers

---

## 📝 Notas importantes

- O mapa `mapa-brasil` é vanilla JS e injeta SVG diretamente no DOM
- O collector de analytics só ativa quando a sessão está `online`
- Snapshots são armazenados em `.analytics/` no diretório do serviço
- Eventos são append-only em arquivos `.jsonl` diários
- O Health Score é calculado com base em 7 métricas ponderadas
- Todas as métricas são protegidas por autenticação (webhook secret + userId)

---

**Implementado em:** 2026-04-13  
**Build status:** ✅ Passing  
**TypeScript:** ✅ 0 errors
