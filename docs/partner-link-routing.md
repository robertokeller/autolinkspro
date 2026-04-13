# Sistemática de Captura e Tratamento de Links de Parceiros

## Objetivo
Monitorar mensagens dos grupos, identificar links de marketplace mesmo quando encurtados/mascarados e decidir por rota se a mensagem deve ser enviada ou ignorada.

## Fluxo
1. Sessão conectada (WhatsApp/Telegram) recebe `message_received`.
2. Sistema localiza grupo de origem interno e rotas ativas.
3. Rota aplica filtros de palavras:
   - bloqueia se houver palavra negativa;
   - bloqueia se faltar palavra positiva (quando configurada).
4. Sistema extrai links da mensagem e ignora domínios sociais/mensageria.
5. Se ativado na rota, resolve links por HTTP (HEAD/GET com redirecionamento) para obter URL final.
6. Sistema detecta marketplace do link final (ou original quando necessário).
7. Sistema aplica regra da rota para link parceiro:
   - `send`: continua processamento e envio;
   - `ignore`: descarta a mensagem nesta rota.
8. Quando configurado, exige link de parceiro para continuar.
9. Conversão Shopee ocorre somente quando habilitada e com credenciais válidas.
10. Template da rota é aplicado e a mensagem é enviada aos destinos.
11. Histórico registra decisão, links resolvidos, marketplace detectado e status de envio.

## Configurações por rota
- `resolvePartnerLinks`: resolve encurtadores/redirects antes de classificar.
- `requirePartnerLink`: exige link de marketplace parceiro para encaminhar.
- `partnerLinkAction`: ação ao encontrar parceiro (`send` ou `ignore`).
- `partnerMarketplaces`: marketplaces considerados parceiros na rota.
- `autoConvertShopee`: converte URL Shopee para afiliado.
- `templateId`: template opcional para saída.
- `positiveKeywords` / `negativeKeywords`: filtros opcionais.

## Marketplaces suportados para detecção
- Shopee
- Amazon
- Mercado Livre
- Magalu
- AliExpress

## Observações operacionais
- O comportamento padrão de rotas antigas é preservado:
  - exigir parceiro ativo;
  - ação `send`;
  - parceiros padrão: `["shopee"]`.
- Em falha de resolução HTTP, o sistema usa o link original e segue com fallback.
- A região da Shopee credenciada agora é respeitada na chamada GraphQL.
