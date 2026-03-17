# Estudo de Caso - Migracao Baileys

## Objetivo

Substituir dependencia de AutoLinks por uma integracao propria com Baileys, mantendo o frontend React/Vite local.

## Sistema de referencia analisado

Repositorio: `robertokeller/autolinks`

Arquivos revisados:

- `server/bots/whatsapp.ts`
- `server/routes.ts`
- `server/bots/index.ts`

## Logicas aprovadas e reaproveitadas

1. Persistencia de credenciais por sessao (`useMultiFileAuthState`).
2. Reconexao automatica com backoff exponencial.
3. Tratamento de `loggedOut` limpando credenciais da sessao.
4. Geracao de QR Code em data URL para frontend.
5. Pairing code com telefone somente em digitos.
6. Sincronizacao de grupos via `groupFetchAllParticipating`.
7. Captura de mensagens de grupos e envio para pipeline de roteamento.

## Pontos rejeitados do sistema de referencia

1. Acoplamento excessivo entre bot, banco e rotas HTTP (dificulta manutencao).
2. Watchdog/stale monitor complexo com risco de loops de reconexao.
3. Uso de estados e nomes inconsistentes entre API, bot e banco.
4. Logs extremamente verbosos para producao.
5. Trechos com variaveis divergentes (exemplo: `watchdogInterval` vs `watchdogTimer`) que podem gerar erro de runtime/TS.

## Arquitetura aplicada neste projeto

- Frontend React/Vite local permanece.
- Gateway RPC local/Node (`whatsapp-connect`) vira camada segura.
- Microservico Node separado (`services/whatsapp-baileys`) executa Baileys 24/7.
- Webhook (`webhook-whatsapp`) continua como motor de roteamento e persistencia.

## Fluxo final

1. Usuario cria sessao no frontend.
2. Front chama `whatsapp-connect` com `action=connect`.
3. Gateway RPC chama microservico Baileys.
4. Microservico envia eventos (`connection_update`, `groups_sync`, `message_received`) para `webhook-whatsapp`.
5. Banco e UI atualizam automaticamente.

## Resultado da comparacao

Mantido:

- core de conexao Baileys, reconexao, QR, pairing e grupos.

Removido:

- acoplamento ao backend antigo do AutoLinks e partes com risco de instabilidade.

Consolidado:

- modelo de microservico simples, seguro por secret e pronto para Replit.
