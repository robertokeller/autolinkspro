# Estudo - Extensao "AutoLinks - Mercado Livre"

## Objetivo
Automatizar a captura de cookies do Mercado Livre e envio para o painel AutoLinks com isolamento por usuario.

## Estado Atual
- Nome da extensao: `AutoLinks - Mercado Livre`
- Artefato de download: `public/downloads/autolinks-mercado-livre.zip`
- Link de download na pagina: `src/pages/mercadolivre/MercadoLivreConfiguracoes.tsx`
- Fluxo no popup: `Entrar e validar` -> `Capturar e enviar cookies`

## Arquitetura Resumida
1. Popup (UI da extensao) coordena o fluxo.
2. Content script faz bridge entre extensao e pagina do painel via `window.postMessage`.
3. Pagina `Configuracoes ML` responde aos eventos e chama backend local.
4. Background script captura cookies do Mercado Livre via API `chrome.cookies`.

## Eventos de Comunicacao
- `AUTOLINKS_PING`: confirma bridge ativa na pagina.
- `AUTOLINKS_EXTENSION_LOGIN`: valida credenciais no painel.
- `AUTOLINKS_CHECK_AUTH`: confirma sessao autenticada.
- `AUTOLINKS_PUSH_COOKIES`: envia cookies para salvar sessao ML.

## Isolamento por Usuario
- O salvamento de sessao segue o usuario autenticado no painel.
- O backend local persiste sessao por `user_id`.
- Se usuario A loga na extensao e envia cookies, os dados entram no escopo do usuario A.

## Mensagens Amigaveis Implementadas
- Sem aba ML aberta.
- Sem cookies ML encontrados.
- Cookies sem sinais de login ML.
- Sem conexao com pagina `Configuracoes ML`.
- Credenciais invalidas.

## Seguranca (atual)
- URL do painel nao fica editavel no popup.
- Upload de cookies exige autenticacao validada.
- Bloqueio quando cookies parecem de conta ML diferente da sessao ja conectada.
- Origem do painel agora e restrita por allowlist local confiavel no popup.
- Bridge popup/pagina exige token de canal (bridgeToken) para `CHECK_AUTH`, `EXTENSION_LOGIN` e `PUSH_COOKIES`.
- `manifest.json` da extensao foi reduzido para hosts locais confiaveis no painel e domínios ML para captura.
- Escopo de `sessionId` no backend/servico ML foi ampliado para reduzir risco de colisao por prefixo curto.

## Pendencias recomendadas (producao)
1. Migrar allowlist de origens para variavel de ambiente (incluindo dominio de producao).
2. Evoluir `bridgeToken` para nonce/challenge com expiracao curta e binding por request.
3. Auditoria de eventos de importacao (usuario, horario, origem, quantidade de cookies).
4. Opcional: endpoint dedicado para extensao em producao com token curto e escopo minimo.

## Checklist de Pronto para Uso
- [x] Botao de download na pagina de Configuracoes ML
- [x] Zip atualizado em `public/downloads/autolinks-mercado-livre.zip`
- [x] Fluxo de login antes da captura
- [x] Mensagens amigaveis para erros comuns
- [x] Tema escuro preto + laranja no popup
