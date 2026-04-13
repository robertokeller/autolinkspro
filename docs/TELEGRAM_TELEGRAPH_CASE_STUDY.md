# Estudo de Caso - Migracao Telegram Telegraph

## Objetivo

Substituir o fluxo legado de Telegram via AutoLinks por uma integração propria, com sessão real, autenticação por codigo e 2FA, persistencia e monitoramento continuo.

## Sistema de referencia analisado

Repositorio: `robertokeller/autolinks`

Arquivos revisados:

- `server/routes.ts` (endpoints de conexão, verify-code, verify-password, disconnect, sync-groups)
- `server/bots/telegram-client.ts` (callbacks de autenticação, monitoramento, envio e sincronização)

## Logicas aprovadas e reaproveitadas

1. Fluxo de autenticação em etapas: `connecting -> awaiting_code -> awaiting_password -> connected`.
2. Uso de resolvers em memoria para receber codigo/senha assincronamente.
3. Sincronizacao de grupos via `getDialogs()` e persistencia no banco.
4. Envio de mensagens via sessão Telegram conectada.
5. Reconexão/restauração de sessão após restart do servico.

## Pontos rejeitados do sistema de referencia

1. Acoplamento excessivo entre rotas HTTP, storage interno e bot manager.
2. Logs muito verbosos e estados redundantes.
3. Tratamento complexo com branches de erro sobrepostos.
4. Codigo de producao misturado com diagnostico de debugging.

## Arquitetura aplicada neste projeto

- Frontend React/Vite local permanece (apenas trocando o hook/UI de Telegram para local).
- Gateway RPC local/Node `telegram-connect` atua como camada segura.
- Microservico Node dedicado (`services/telegram-telegraph`) executa cliente Telegram 24/7.
- Webhook `webhook-telegram` continua centralizando atualização de status, grupos e pipeline de roteamento.

## Fluxo final

1. Usuario cria sessão Telegram no frontend.
2. Front chama `telegram-connect` com `action=send_code`.
3. Gateway RPC chama microservico Telegram e inicia autenticação.
4. Usuario envia codigo e senha 2FA via `verify_code`/`verify_password`.
5. Microservico publica eventos (`connection_update`, `groups_sync`, `message_received`, `message_sent`) no `webhook-telegram`.
6. Banco/UI atualizam automaticamente e a sessão fica ativa para monitoramento e interacao.

## Resultado da comparacao

Mantido:

- Estrategia de autenticação com callbacks e estados de progresso.
- Sincronizacao de grupos e envio de mensagens por sessão.

Removido:

- Dependencia do painel externo AutoLinks para operação Telegram.
- Acoplamento com backend monolitico do sistema de referencia.

Consolidado:

- Integracao Telegram nativa no produto, com microservico simples, seguro por secret e pronta para deploy no Replit.
