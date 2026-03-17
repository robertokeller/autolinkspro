# Plano Completo: Central de Notificacoes + Modo de Manutencao

Data: 2026-03-12
Status: Proposta tecnica para implementacao faseada

## 1) Objetivo

Implementar duas capacidades integradas:

1. Central de notificacoes no Painel Administrativo, com envio para o Painel do Usuario.
2. Modo de manutencao global (liga/desliga), que deixa o sistema indisponivel para clientes e exibe tela de manutencao.

## 2) Resultado esperado para negocio

- Admin consegue criar comunicados segmentados por:
  - plano (plan_id)
  - nivel de acesso (accessLevelId via admin control plane)
  - role (admin/user)
  - usuarios especificos
- Usuario recebe notificacoes no sininho do topo, com contador de nao lidas.
- Usuario pode abrir notificacoes em modal full-screen e marcar como lidas.
- Opcional de popup automatico no login para notificacoes marcadas como obrigatorias.
- Modo manutencao bloqueia toda area protegida do cliente com pagina unica de indisponibilidade.

## 3) Diagnostico atual (codigo existente)

### Ja existe

- Preferencias individuais de notificacao por usuario em profiles.notification_prefs.
- Admin ja possui dados de plano, role e status de conta para filtrar usuarios na tela de usuarios.
- Controle de acesso por plano/feature e expiracao de plano ja esta em uso.

### Ainda nao existe

- Tabela de notificacoes de sistema (mensagens enviadas por admin).
- Tabela de entrega/leitura por usuario (inbox por usuario).
- UI de central de notificacoes no admin.
- Sininho no header do painel do usuario com feed real.
- Modo manutencao global com bloqueio total por feature flag central.

## 4) Modelo de dados proposto (front/back sincronizado)

Adicionar tabelas ao adaptador local e ao contrato tipado (types):

### 4.1 system_announcements

Campos:
- id (string)
- created_at (string)
- updated_at (string)
- created_by_user_id (string)
- title (string)
- message (string)
- severity ("info" | "warning" | "critical")
- channel ("bell" | "modal" | "both")
- auto_popup_on_login (boolean)
- starts_at (string | null)
- ends_at (string | null)
- is_active (boolean)
- target_filter (json)
  - planIds: string[]
  - accessLevelIds: string[]
  - roles: ("admin"|"user")[]
  - userIds: string[]
  - matchMode: "any" | "all"

### 4.2 user_notifications

Campos:
- id (string)
- created_at (string)
- updated_at (string)
- user_id (string)
- announcement_id (string)
- status ("unread" | "read" | "dismissed")
- read_at (string | null)
- dismissed_at (string | null)
- delivered_at (string)

Indices logicos (no local adapter, por filtro em memoria):
- user_id + status
- user_id + created_at desc
- announcement_id

### 4.3 app_runtime_flags

Campos:
- id (string, fixo: "global")
- created_at (string)
- updated_at (string)
- maintenance_enabled (boolean)
- maintenance_title (string)
- maintenance_message (string)
- maintenance_eta (string | null)
- allow_admin_bypass (boolean)
- updated_by_user_id (string)

## 5) Regras de negocio

### Segmentacao de destinatarios

- matchMode any:
  - Envia se usuario casar em qualquer criterio selecionado.
- matchMode all:
  - Envia somente se casar em todos os criterios preenchidos.
- userIds sempre tem prioridade para inclusao explicita.
- Se nenhum filtro for informado, envia para todos os usuarios nao-admin (padrao seguro).

### Leitura e exibicao

- Bell mostra contador de unread.
- Ao abrir modal da central, marcar como read em lote (opcional configuravel).
- Notificacao critical com auto_popup_on_login abre modal ao entrar no sistema.

### Manutencao global

- Se maintenance_enabled = true:
  - usuarios comuns nao acessam rotas protegidas; veem pagina de manutencao.
  - admin pode manter acesso se allow_admin_bypass = true.
- Public routes (login) continuam acessiveis, mas login de cliente redireciona para tela de manutencao apos autenticacao.

## 6) API/RPC proposta

Adicionar handlers em local-functions:

Admin:
- admin-announcements
  - action: list
  - action: create
  - action: update
  - action: deactivate
  - action: deliver_now (materializa user_notifications)
- admin-maintenance
  - action: get
  - action: set

Usuario:
- user-notifications
  - action: list (com pagina e filtros)
  - action: unread_count
  - action: mark_read
  - action: mark_all_read
  - action: dismiss

## 7) Frontend proposto

### 7.1 Painel Admin

Nova rota/pagina: AdminNotifications

Blocos da tela:
- Composer de notificacao
  - titulo, mensagem, severidade, canal, popup no login
  - vigencia (inicio/fim)
  - filtros: plano, nivel de acesso, role, usuarios especificos
- Preview de alcance
  - mostra quantos usuarios receberao
- Lista historica
  - status ativa/inativa
  - metricas (entregues, lidas, taxa de leitura)
- Bloco de manutencao
  - toggle liga/desliga
  - titulo, mensagem, ETA
  - bypass admin

### 7.2 Painel Usuario

- Header: adicionar NotificationBell ao lado do ThemeToggle.
- Dropdown rapido do sininho com ultimas 5-10 notificacoes.
- Modal full-screen com inbox completo e filtros (nao lidas/todas).
- Popup de login para notificacao critica obrigatoria.

## 8) Sincronizacao front/back e persistencia

- Extender local-core:
  - TABLE_DEFAULTS com novas tabelas.
  - normalizacao e migracao de schemaVersion (v4 -> v5).
- Extender types.ts com novas tabelas para tipagem forte.
- Extender DATABASE.md com documentacao das novas entidades.
- Emitir LOCAL_DB_UPDATED_EVENT apos operacoes de notificacao/manutencao.
- Assinar subscribeLocalDbChanges no header para atualizar badge em tempo real.

## 9) Seguranca e controle de acesso

- Apenas admin pode criar/editar notificacoes e alterar manutencao.
- Validar payload (titulo, mensagem, filtros, datas).
- Registrar auditoria em admin_audit_logs:
  - create_announcement
  - update_announcement
  - deactivate_announcement
  - set_maintenance

## 10) Plano de implementacao por fases

### Fase 1: Fundacao de dados e RPC
- Criar tabelas no local-core (schema v5).
- Adicionar tipos no types.ts.
- Implementar RPC user-notifications (list, unread_count, mark_read).
- Testes unitarios basicos de leitura/marcacao.

### Fase 2: Bell + inbox no usuario
- Criar NotificationBell e NotificationCenterModal.
- Integrar no AppLayout.
- Polling leve + subscribeLocalDbChanges.
- Testes de UI (contador e marcacao).

### Fase 3: Central admin de notificacoes
- Nova pagina AdminNotifications.
- Composer + filtros + entrega em massa.
- Registro de auditoria.
- Testes de segmentacao por plano/role/usuarios.

### Fase 4: Modo manutencao global
- app_runtime_flags + RPC admin-maintenance.
- MaintenanceGuard nas rotas protegidas.
- MaintenancePage dedicada.
- Bypass de admin configuravel.

### Fase 5: Endurecimento
- Debounce e limites de envio em massa.
- Metricas de leitura.
- Ajustes de UX para popup no login.

## 11) Criterios de aceite

- Admin envia notificacao para plano X e somente usuarios desse plano recebem.
- Admin envia para role admin e usuario comum nao recebe.
- Admin escolhe 3 usuarios especificos e somente eles recebem.
- Bell mostra contador correto e cai para zero apos mark_all_read.
- Notificacao critica com popup abre no login.
- Com manutencao ligada, usuario comum nao usa o app e ve tela de manutencao.
- Com bypass ativo, admin continua operando durante manutencao.

## 12) Riscos e mitigacoes

- Risco: entrega em massa lenta em base grande.
  - Mitigar com loteamento e escrita incremental.
- Risco: notificacao duplicada para mesmo usuario.
  - Mitigar com chave logica (announcement_id + user_id).
- Risco: manutencao bloquear admin por erro de regra.
  - Mitigar com allow_admin_bypass default true.

## 13) Proxima acao recomendada

Iniciar pela Fase 1 e Fase 2 em um unico PR pequeno (dados + bell do usuario), depois Fase 3 e Fase 4 em PRs separados para reduzir risco de regressao.
