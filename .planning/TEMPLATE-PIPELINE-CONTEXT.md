# Contexto - Pipeline de Templates e Formatacao por Canal

Data: 2026-03-18

## Objetivo
Garantir que mensagens com marcacao rica (negrito, italico, riscado) sejam adaptadas por canal (WhatsApp/Telegram) e que o pipeline completo aplique regras/placeholder sem regressao.

## Inconsistencias encontradas
1. Runtime de producao não aplicava `templateId + templateData` no `dispatch-messages` antes de enviar.
2. Runtime local (`local-functions`) em envio manual (`send_message`) enviava texto cru para microservicos (sem adaptar marcacao por canal).
3. Conversão Telegram no backend de producao estava divergente da logica canonica (`src/lib/rich-text.ts`).

## Correcoes aplicadas
1. `services/api/src/rpc.ts`
- `applyPlaceholders` agora cobre `{chave}` e `{{chave}}`.
- Adicionada adaptacao por canal:
  - WhatsApp: `** -> *`, `__ -> _`, `~~ -> ~`
  - Telegram HTML-safe: escape HTML + `** -> <b>`, `__ -> <i>`, `~~ -> <s>` (+ legado `*texto* -> <b>`)
- `dispatch-messages`:
  - aplica `templateId` + `templateData` (com cache por usuario/template)
  - formata mensagem por plataforma de destino antes do envio
- `whatsapp-connect` e `telegram-connect` (`send_message`) agora formatam por plataforma antes de enviar.

2. `src/integrations/backend/local-functions.ts`
- `whatsapp-connect` (`send_message`) agora aplica formatacao de WhatsApp antes de chamar microservico.
- `telegram-connect` (`send_message`) agora aplica formatacao de Telegram antes de chamar microservico.

## Verificação executada
- `npm --prefix services/api run build` -> OK
- `npm run build` -> OK

## Resultado esperado
- Mesmo template funciona para WhatsApp e Telegram sem quebrar marcacao.
- Agendamentos com `templateId/templateData` respeitam placeholders na hora real do disparo.
- Fluxo manual e fluxo automatico ficam coerentes entre runtime local e producao.