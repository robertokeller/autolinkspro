# Estudo de Caso - Migracao Telegram Telegraph

## Objetivo

Substituir o fluxo legado de Telegram via AutoLinks por uma integracao propria, com sessao real, autenticacao por codigo e 2FA, persistencia e monitoramento continuo.

## Sistema de referencia analisado

Repositorio: `robertokeller/autolinks`

Arquivos revisados:

- `server/routes.ts` (endpoints de conexao, verify-code, verify-password, disconnect, sync-groups)
- `server/bots/telegram-client.ts` (callbacks de autenticacao, monitoramento, envio e sincronizacao)

## Logicas aprovadas e reaproveitadas

1. Fluxo de autenticacao em etapas: `connecting -> awaiting_code -> awaiting_password -> connected`.
2. Uso de resolvers em memoria para receber codigo/senha assincronamente.
3. Sincronizacao de grupos via `getDialogs()` e persistencia no banco.
4. Envio de mensagens via sessao Telegram conectada.
5. Reconexao/restauracao de sessao apos restart do servico.

## Pontos rejeitados do sistema de referencia

1. Acoplamento excessivo entre rotas HTTP, storage interno e bot manager.
2. Logs muito verbosos e estados redundantes.
3. Tratamento complexo com branches de erro sobrepostos.
4. Codigo de producao misturado com diagnostico de debugging.

## Arquitetura aplicada neste projeto

- Frontend React/Vite local permanece (apenas trocando o hook/UI de Telegram para local).
- Gateway RPC local/Node `telegram-connect` atua como camada segura.
- Microservico Node dedicado (`services/telegram-telegraph`) executa cliente Telegram 24/7.
- Webhook `webhook-telegram` continua centralizando atualizacao de status, grupos e pipeline de roteamento.

## Fluxo final

1. Usuario cria sessao Telegram no frontend.
2. Front chama `telegram-connect` com `action=send_code`.
3. Gateway RPC chama microservico Telegram e inicia autenticacao.
4. Usuario envia codigo e senha 2FA via `verify_code`/`verify_password`.
5. Microservico publica eventos (`connection_update`, `groups_sync`, `message_received`, `message_sent`) no `webhook-telegram`.
6. Banco/UI atualizam automaticamente e a sessao fica ativa para monitoramento e interacao.

## Resultado da comparacao

Mantido:

- Estrategia de autenticacao com callbacks e estados de progresso.
- Sincronizacao de grupos e envio de mensagens por sessao.

Removido:

- Dependencia do painel externo AutoLinks para operacao Telegram.
- Acoplamento com backend monolitico do sistema de referencia.

Consolidado:

- Integracao Telegram nativa no produto, com microservico simples, seguro por secret e pronta para deploy no Replit.
