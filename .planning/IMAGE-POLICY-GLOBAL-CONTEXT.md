# Contexto - Politica Global de Imagem nos Pipelines

Data: 2026-03-18

## Objetivo
Garantir uma regra unica para todos os fluxos de envio:
- rotas monitoradas
- automacoes inteligentes Shopee
- agendamentos vindos da vitrine/pesquisa Shopee

## Comportamento esperado (regra de negocio)
1. Se a mensagem de origem ja vier com imagem, essa imagem e usada.
2. Se nao vier imagem e houver produto Shopee, baixar a imagem da API e anexar.
3. Nunca enviar link de imagem no texto como substituicao de anexo.
4. Mesmo sem placeholder `{imagem}` no template, a imagem deve ser anexada quando a rota exige midia.
5. Quando fluxo exigir imagem e ela nao puder ser anexada, cancelar envio e registrar no historico.
6. Midias temporarias devem ser limpas apos 2 minutos.

## Ajustes aplicados
### `services/api/src/rpc.ts`
- Adicionados modulos globais para politicas de imagem:
  - `scheduleRequiresMandatoryImage`
  - `extractScheduleProductImageUrl`
  - `buildAutomationImageMedia`
  - controle de cleanup de midia agendada (`mediaCleanupAt` + limpeza por timer/varredura)
- `route-process-message`:
  - remove dependencia de `autoDownloadImage` para exigir imagem
  - tenta imagem do produto convertido, depois extracao por URL
  - sem imagem: bloqueia com `missing_image_required` no historico
  - se destino nao aceitar/resolver midia: bloqueia envio para esse destino
- `dispatch-messages`:
  - aplica regra de imagem obrigatoria para agendamentos com `imagePolicy=required` ou `scheduleSource=shopee_catalog`
  - tenta fallback por `productImageUrl` quando metadata nao tem midia
  - sem imagem obrigatoria: cancela e registra historico com `missing_image_required`
  - marca limpeza da midia em metadata e executa cleanup apos 2 minutos (timer + reconciliacao)
- `shopee-automation-run`:
  - passa a montar midia obrigatoria da oferta via download de imagem
  - se falhar montagem da midia: bloqueia automacao e registra historico
  - envio para WhatsApp/Telegram sempre com anexo de midia
  - historico de sucesso/falha agora marca `messageType: image` quando aplicavel

### Frontend/local ja alinhados anteriormente
- `src/components/shopee/ScheduleProductModal.tsx`
- `src/hooks/useAgendamentos.ts`
- `src/integrations/backend/local-functions.ts`

## Resultado operacional
- Nao deve mais sair mensagem de automacao/agendamento Shopee sem imagem quando politica exige anexo.
- Rotas monitoradas passam a bloquear envio sem midia quando nao conseguirem resolver imagem.
- Casos bloqueados ficam auditaveis no historico com motivo explicito.

## Validacao
- `npm run svc:api:build` -> OK
- `npx vitest run src/integrations/backend/local-sync.test.ts -t "route|automation|agendamento|schedule"` -> OK
- `npm run build` -> OK
