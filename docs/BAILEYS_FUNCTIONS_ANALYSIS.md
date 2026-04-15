# Análise de Funções Baileys - Usadas vs Não Usadas

**Data:** 2026-04-13  
**Versão Baileys:** 7.0.0-rc.9  
**Arquivo Analisado:** `services/whatsapp-baileys/src/server.ts` (2273 linhas)

---

## 📊 RESUMO EXECUTIVO

A integração atual utiliza aproximadamente **15%** das funcionalidades disponíveis na biblioteca Baileys. Existem **oportunidades significativas** para expandir as capacidades do AutoLinks, especialmente em:

- ✅ Reações e edição de mensagens
- ✅ Gerenciamento avançado de grupos
- ✅ Presença e status online
- ✅ Stories/Status
- ✅ Listas de transmissão
- ✅ Mensagens efêmeras
- ✅ Star/Favoritar mensagens
- ✅ Bloqueio/desbloqueio de usuários
- ✅ Catálogo e produtos (WhatsApp Business)
- ✅ Newsletters
- ✅ Privacidade avançada
- ✅ Chamadas (calls)

---

## ✅ FUNÇÕES JÁ IMPLEMENTADAS

### Conexão e Autenticação
- ✅ `makeWASocket` - Criação do socket
- ✅ `useMultiFileAuthState` - Gerenciamento de sessão
- ✅ `fetchLatestBaileysVersion` - Versão WhatsApp
- ✅ `requestPairingCode` - Autenticação por código
- ✅ QR Code generation (via QRCode library)
- ✅ `logout` - Logout da sessão

### Eventos
- ✅ `creds.update` - Atualização de credenciais
- ✅ `connection.update` - Estado da conexão
- ✅ `messages.upsert` - Recebimento de mensagens
- ✅ `groups.update` - Atualizações de grupos

### Envio de Mensagens
- ✅ `sendMessage` - Texto, imagem, vídeo com caption
- ✅ Download de mídia (`downloadMediaMessage`, `downloadContentFromMessage`)

### Grupos (Básico)
- ✅ `groupFetchAllParticipating` - Lista todos os grupos
- ✅ `groupMetadata` - Metadados do grupo
- ✅ `groupInviteCode` - Código de convite do grupo

### Eventos Emitidos via Webhook
- ✅ `connection_update` - Status da conexão
- ✅ `message_received` - Mensagens recebidas (apenas grupos)
- ✅ `message_sent` - Mensagens enviadas
- ✅ `groups_sync` - Sincronização de grupos
- ✅ `group_name_update` - Mudança de nome de grupo

---

## 🚀 FUNÇÕES NÃO USADAS (OPORTUNIDADES)

### 1. ⭐ REAÇÕES E EDIÇÃO DE MENSAGENS (Alta Prioridade)

**Funções disponíveis:**
- `sendMessage` com tipo `react` - Enviar reações
- `sendMessage` com opção `edit` - Editar mensagens enviadas

**Caso de uso AutoLinks:**
```typescript
// Reagir a mensagens recebidas
await socket.sendMessage(jid, {
  react: {
    text: "👍",
    key: messageKey
  }
});

// Editar mensagem enviada
await socket.sendMessage(jid, {
  text: "Novo texto",
  edit: messageKey
});
```

**Implementação sugerida:** Adicionar endpoints `/api/reactions` e `/api/edit-message`

---

### 2. 📱 PRESENÇA E STATUS ONLINE (Alta Prioridade)

**Funções disponíveis:**
- `sendPresenceUpdate(type, toJid)` - Enviar presença
  - Tipos: `'unavailable' | 'available' | 'composing' | 'recording' | 'paused'`
- `presenceSubscribe(toJid)` - Subscrever presença de outros

**Caso de uso AutoLinks:**
```typescript
// Mostrar "digitando..." antes de enviar mensagem
await socket.sendPresenceUpdate('composing', jid);
await socket.sendMessage(jid, { text: "Mensagem" });
await socket.sendPresenceUpdate('paused', jid);

// Mostrar "online"
await socket.sendPresenceUpdate('available', jid);
```

**Implementação sugerida:** 
- Configurar presença automática no bootSocket
- Adicionar opção de simular "digitando" com delay configurável

---

### 3. 🌟 FAVORITAR/STAR MENSAGENS (Média Prioridade)

**Função disponível:**
- `star(jid, messages, star)` - Favoritar/desfavoritar mensagens

**Caso de uso AutoLinks:**
```typescript
// Favoritar mensagem importante
await socket.star(jid, [{ id: messageId, fromMe: false }], true);

// Desfavoritar
await socket.star(jid, [{ id: messageId, fromMe: false }], false);
```

**Implementação sugerida:** Webhook event `message_starred`

---

### 4. 📸 STORIES/STATUS (Alta Prioridade)

**Funções disponíveis:**
- `sendMessage('status@broadcast', content)` - Postar story/status
- Suporta: texto, imagem, vídeo

**Caso de uso AutoLinks:**
```typescript
// Postar imagem no status
await socket.sendMessage('status@broadcast', {
  image: buffer,
  caption: "Meu status"
});

// Postar texto no status
await socket.sendMessage('status@broadcast', {
  text: "Status atualizado"
});
```

**Implementação sugerida:** Endpoint `/api/post-status`

---

### 5. 📋 GERENCIAMENTO AVANÇADO DE GRUPOS (Alta Prioridade)

**Funções NÃO implementadas:**
- ❌ `groupCreate(subject, participants)` - Criar grupo
- ❌ `groupLeave(id)` - Sair de grupo
- ❌ `groupUpdateSubject(jid, subject)` - Mudar nome
- ❌ `groupUpdateDescription(jid, description)` - Mudar descrição
- ❌ `groupParticipantsUpdate(jid, participants, action)` - Adicionar/remover membros
  - Actions: `'add' | 'remove' | 'promote' | 'demote'`
- ❌ `groupRequestParticipantsList(jid)` - Lista de solicitações de entrada
- ❌ `groupRequestParticipantsUpdate(jid, participants, action)` - Aprovar/rejeitar entrada
- ❌ `groupRevokeInvite(jid)` - Revogar código de convite
- ❌ `groupAcceptInvite(code)` - Aceitar convite
- ❌ `groupToggleEphemeral(jid, ephemeralExpiration)` - Mensagens efêmeras
- ❌ `groupSettingUpdate(jid, setting)` - Configurações do grupo
  - Settings: `'announcement' | 'not_announcement' | 'locked' | 'unlocked'`
- ❌ `groupJoinApprovalMode(jid, mode)` - Modo de aprovação
- ❌ `groupMemberAddMode(jid, mode)` - Quem pode adicionar membros

**Caso de uso AutoLinks:**
```typescript
// Criar grupo
await socket.groupCreate("Novo Grupo", ["5511999999999@s.whatsapp.net"]);

// Adicionar membros
await socket.groupParticipantsUpdate(groupId, ["5511888888888@s.whatsapp.net"], 'add');

// Promover a admin
await socket.groupParticipantsUpdate(groupId, ["5511888888888@s.whatsapp.net"], 'promote');

// Configurar mensagens efêmeras (24h)
await socket.groupToggleEphemeral(groupId, 86400);

// Somente admins enviam mensagens (modo anúncio)
await socket.groupSettingUpdate(groupId, 'announcement');
```

**Implementação sugerida:** Múltiplos endpoints em `/api/groups/*`

---

### 6. 👥 PERFIL E CONTATOS (Média Prioridade)

**Funções NÃO implementadas:**
- ❌ `profilePictureUrl(jid, type)` - Obter foto de perfil
  - Types: `'preview' | 'image'`
- ❌ `updateProfilePicture(jid, content)` - Atualizar foto de perfil
- ❌ `removeProfilePicture(jid)` - Remover foto de perfil
- ❌ `updateProfileStatus(status)` - Atualizar recado/status
- ❌ `updateProfileName(name)` - Atualizar nome do perfil
- ❌ `onWhatsApp(...phoneNumber)` - Verificar se número existe no WhatsApp
- ❌ `addOrEditContact(jid, contact)` - Adicionar/editar contato
- ❌ `removeContact(jid)` - Remover contato
- ❌ `fetchStatus(...jids)` - Obter status/recado de usuários

**Caso de uso AutoLinks:**
```typescript
// Verificar se número existe
const result = await socket.onWhatsApp("5511999999999");
// Retorna: { jid: "...", exists: true/false }

// Obter foto de perfil
const photoUrl = await socket.profilePictureUrl(jid, 'image');

// Atualizar recado
await socket.updateProfileStatus("Disponível para atendimento");
```

**Implementação sugerida:** Endpoints `/api/contacts/*` e `/api/profile/*`

---

### 7. 🚫 BLOQUEIO/DESBLOQUEIO (Média Prioridade)

**Funções disponíveis:**
- `fetchBlocklist()` - Lista de bloqueados
- `updateBlockStatus(jid, action)` - Bloquear/desbloquear
  - Actions: `'block' | 'unblock'`

**Caso de uso AutoLinks:**
```typescript
// Bloquear usuário
await socket.updateBlockStatus(jid, 'block');

// Desbloquear
await socket.updateBlockStatus(jid, 'unblock');

// Listar bloqueados
const blocklist = await socket.fetchBlocklist();
```

**Implementação sugerida:** Endpoint `/api/blocklist`

---

### 8. 📦 LISTAS DE TRANSMISSÃO (Média Prioridade)

**Funções disponíveis:**
- Uso de `relayMessage` para broadcast
- Envio para múltiplos JIDs via loop

**Caso de uso AutoLinks:**
```typescript
// Enviar para lista de transmissão
const broadcastList = ["jid1@s.whatsapp.net", "jid2@s.whatsapp.net"];
for (const jid of broadcastList) {
  await socket.sendMessage(jid, { text: "Broadcast message" });
}
```

**Implementação sugerida:** Endpoint `/api/broadcast`

---

### 9. 💼 WHATSAPP BUSINESS - CATÁLOGO E PRODUTOS (Baixa Prioridade)

**Funções disponíveis:**
- ❌ `getBusinessProfile(jid)` - Obter perfil business
- ❌ `updateBussinesProfile(args)` - Atualizar perfil business
- ❌ `getOrderDetails(orderId, tokenBase64)` - Detalhes do pedido
- ❌ `getCatalog({jid, limit, cursor})` - Obter catálogo de produtos
- ❌ `getCollections(jid, limit)` - Coleções do catálogo
- ❌ `productCreate(create)` - Criar produto
- ❌ `productDelete(productIds)` - Deletar produtos
- ❌ `productUpdate(productId, update)` - Atualizar produto
- ❌ `addOrEditQuickReply(quickReply)` - Respostas rápidas
- ❌ `removeQuickReply(timestamp)` - Remover resposta rápida
- ❌ Labels: `addLabel`, `addChatLabel`, `removeChatLabel`, etc.

**Caso de uso:** Para clientes com WhatsApp Business que querem gerenciar catálogo via AutoLinks

---

### 10. 📰 NEWSLETTERS (Baixa Prioridade)

**Funções disponíveis:**
- ❌ `newsletterCreate(name, description)` - Criar newsletter
- ❌ `newsletterUpdate(jid, updates)` - Atualizar
- ❌ `newsletterDelete(jid)` - Deletar
- ❌ `newsletterMetadata(type, key)` - Metadados
- ❌ `newsletterFollow(jid)` - Seguir
- ❌ `newsletterUnfollow(jid)` - Deixar de seguir
- ❌ `newsletterMute/Unmute(jid)` - Silenciar
- ❌ `newsletterUpdateName/Description/Picture`
- ❌ `newsletterFetchMessages(jid, count, since, after)` - Buscar mensagens
- ❌ `newsletterSubscribers(jid)` - Inscritos
- ❌ `newsletterAdminCount(jid)` - Número de admins
- ❌ `newsletterChangeOwner(jid, newOwnerJid)` - Mudar dono
- ❌ `newsletterDemote(jid, userJid)` - Rebaixar admin
- ❌ `newsletterReactMessage(jid, serverId, reaction)` - Reagir

**Implementação sugerida:** Endpoints `/api/newsletters/*`

---

### 11. 🔒 PRIVACIDADE (Baixa Prioridade)

**Funções disponíveis:**
- ❌ `fetchPrivacySettings()` - Obter configurações
- ❌ `updateCallPrivacy(value)` - Privacidade de chamadas
  - Values: `'all' | 'known'`
- ❌ `updateMessagesPrivacy(value)` - Quem pode enviar mensagens
  - Values: `'all' | 'contacts'`
- ❌ `updateLastSeenPrivacy(value)` - Visto por último
  - Values: `'all' | 'contacts' | 'contact_blacklist' | 'none'`
- ❌ `updateOnlinePrivacy(value)` - Online
  - Values: `'all' | 'match_last_seen'`
- ❌ `updateProfilePicturePrivacy(value)` - Foto de perfil
- ❌ `updateStatusPrivacy(value)` - Status
- ❌ `updateReadReceiptsPrivacy(value)` - Confirmação de leitura
  - Values: `'all' | 'none'`
- ❌ `updateGroupsAddPrivacy(value)` - Adicionar a grupos
  - Values: `'all' | 'contacts' | 'contact_blacklist'`
- ❌ `updateDefaultDisappearingMode(duration)` - Modo efêmero padrão

---

### 12. 📞 CHAMADAS (CALLS) (Baixa Prioridade)

**Funções disponíveis:**
- ❌ `rejectCall(callId, callFrom)` - Rejeitar chamada
- ❌ `createCallLink(type, event, timeoutMs)` - Criar link de chamada
  - Types: `'audio' | 'video'`
- ❌ Evento `call` - Receber eventos de chamada

**Caso de uso AutoLinks:**
```typescript
// Rejeitar chamada recebida
socket.ev.on('call', (call) => {
  if (call.status === 'offer') {
    await socket.rejectCall(call.id, call.from);
  }
});
```

---

### 13. 💬 MENSAGENS EFÊMERAS (Média Prioridade)

**Funções disponíveis:**
- ❌ `groupToggleEphemeral(jid, duration)` - Grupo
- ❌ `updateDefaultDisappearingMode(duration)` - Global
- ❌ Envio com `ephemeralExpiration` nas mensagens

**Durações válidas:**
- `86400` = 24 horas
- `604800` = 7 dias
- `7776000` = 90 dias

**Caso de uso:**
```typescript
// Enviar mensagem efêmera (24h)
await socket.sendMessage(jid, {
  text: "Esta mensagem desaparece",
  ephemeralExpiration: 86400
});
```

---

### 14. ✉️ TIPOS AVANÇADOS DE MENSAGEM (Alta Prioridade)

**O `sendMessage` suporta muitos tipos além de texto/imagem/vídeo:**

- ❌ **Áudio** - `{ audio: buffer, ptt: true }` (mensagem de voz)
- ❌ **Documento** - `{ document: buffer, fileName: "doc.pdf", mimetype: "application/pdf" }`
- ❌ **Sticker** - `{ sticker: buffer }`
- ❌ **Localização** - `{ location: { degreesLatitude: -23.5, degreesLongitude: -46.6 } }`
- ❌ **Contato** - `{ contacts: { displayName: "João", contacts: [{ vcard: "..." }] } }`
- ❌ **Botões/Lista** - Via `templateMessage`, `listMessage`
- ❌ **Poll/Enquete** - `{ poll: { name: "Escolha", values: ["A", "B"], selectableCount: 1 } }`
- ❌ **Link preview** - Com `linkPreview` nas options
- ❌ **Forward/Encaminhar** - Relay de mensagens
- ❌ **Marcar como lidas** - `readMessages(keys)`
- ❌ **Mencionar usuários** - `{ mentions: ["5511999999999@s.whatsapp.net"] }`

**Caso de uso AutoLinks:**
```typescript
// Enviar enquete
await socket.sendMessage(jid, {
  poll: {
    name: "Qual melhor?",
    values: ["Opção A", "Opção B", "Opção C"],
    selectableCount: 1
  }
});

// Enviar áudio
await socket.sendMessage(jid, {
  audio: buffer,
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true // push-to-talk (mensagem de voz)
});

// Enviar documento
await socket.sendMessage(jid, {
  document: buffer,
  fileName: "relatorio.pdf",
  mimetype: "application/pdf",
  caption: "Relatório mensal"
});

// Enviar localização
await socket.sendMessage(jid, {
  location: {
    degreesLatitude: -23.5505,
    degreesLongitude: -46.6333
  }
});

// Enviar com menções
await socket.sendMessage(jid, {
  text: "@5511999999999 olá!",
  mentions: ["5511999999999@s.whatsapp.net"]
});
```

---

### 15. 🤖 BOTS (Baixa Prioridade)

**Funções disponíveis:**
- ❌ `getBotListV2()` - Lista de bots disponíveis
- Mensagens para `@bot` JIDs

---

### 16. 🔍 EVENTOS ADICIONAIS (Média Prioridade)

**Eventos Baileys que podem ser capturados:**
- ❌ `messages.reaction` - Reações recebidas
- ❌ `messages.update` - Atualizações de mensagens (editadas, apagadas)
- ❌ `message-receipt` - Confirmação de leitura por outros
- ❌ `presence.update` - Mudança de presença de contatos
- ❌ `call` - Eventos de chamada
- ❌ `blocklist.set` / `blocklist.update` - Mudanças na lista de bloqueio
- ❌ `chats.set` / `chats.update` / `chats.delete` - Sync de chats
- ❌ `contacts.set` / `contacts.update` - Sync de contatos
- ❌ `groups.upsert` - Novo grupo
- ❌ `groups.participants.update` - Mudanças em participantes

**Caso de uso AutoLinks:**
```typescript
// Capturar reações
socket.ev.on('messages.reaction', async (reactions) => {
  for (const reaction of reactions) {
    await emitWebhook(state, 'message_reaction', {
      messageId: reaction.key.id,
      reaction: reaction.reaction.text,
      from: reaction.key.participant || reaction.key.remoteJid
    });
  }
});

// Capturar presenças
socket.ev.on('presence.update', async (updates) => {
  for (const update of updates) {
    await emitWebhook(state, 'presence_update', {
      jid: update.id,
      presence: update.presences
    });
  }
});
```

---

## 📈 RECOMENDAÇÕES POR PRIORIDADE

### 🔴 ALTA PRIORIDADE (Impacto imediato)

1. **Tipos avançados de mensagem** - Áudio, documento, localização, enquete, menções, stickers
2. **Presença (digitando/online)** - Melhor UX nas conversas
3. **Reações e edição** - Interatividade completa
4. **Stories/Status** - Novo canal de comunicação
5. **Gerenciamento de grupos** - Criar, adicionar/remover membros, configurações

### 🟡 MÉDIA PRIORIDADE (Valor agregado)

6. **Perfil e contatos** - Fotos, status, verificar números
7. **Mensagens efêmeras** - Privacidade
8. **Bloqueio/desbloqueio** - Moderação
9. **Eventos adicionais** - Reações, presença, receipts
10. **Listas de transmissão** - Envio em massa

### 🟢 BAIXA PRIORIDADE (Casos específicos)

11. **WhatsApp Business** - Catálogo, produtos (apenas se clientes usarem Business)
12. **Newsletters** - Caso de uso específico
13. **Privacidade** - Configurações avançadas
14. **Chamadas** - Rejeitar calls automaticamente
15. **Bots** - Integração com Meta AI

---

## 💡 ESTIMATIVA DE IMPLEMENTAÇÃO

| Funcionalidade | Complexidade | Tempo Estimado |
|----------------|--------------|----------------|
| Tipos de mensagem avançados | Baixa | 2-4 horas |
| Presença (digitando) | Baixa | 1-2 horas |
| Reações e edição | Baixa | 2-3 horas |
| Stories/Status | Baixa | 2-3 horas |
| Gerenciamento de grupos | Média | 6-8 horas |
| Perfil e contatos | Média | 4-6 horas |
| Mensagens efêmeras | Baixa | 1-2 horas |
| Bloqueio/desbloqueio | Baixa | 1-2 horas |
| Eventos adicionais | Média | 4-6 horas |
| Listas de transmissão | Baixa | 2-3 horas |
| WhatsApp Business | Alta | 10-15 horas |
| Newsletters | Alta | 8-12 horas |

---

## 🔧 EXEMPLOS DE IMPLEMENTAÇÃO RÁPIDA

### Exemplo 1: Adicionar suporte a enquetes

```typescript
// No server.ts, adicionar novo tipo no SendBody
interface SendBody {
  // ...existing fields
  poll?: {
    name: string;
    options: string[];
    maxSelectable?: number;
  };
}

// No handler /api/send-message
if (body.poll) {
  sendResult = await state.socket!.sendMessage(targetJid, {
    poll: {
      name: body.poll.name,
      values: body.poll.options,
      selectableCount: body.poll.maxSelectable || 1
    }
  });
}
```

### Exemplo 2: Adicionar presença automática

```typescript
// No bootSocket, após socket estar online
socket.ev.on('messages.upsert', async (upsert) => {
  // Simular "digitando" antes de responder
  const jid = upsert.messages[0].key.remoteJid;
  await socket.sendPresenceUpdate('composing', jid);
  
  // Aguardar tempo configurável (ex: 2s)
  await new Promise(r => setTimeout(r, 2000));
  
  await socket.sendPresenceUpdate('paused', jid);
});
```

### Exemplo 3: Endpoint para criar grupo

```typescript
app.post('/api/groups/create', async (req, res) => {
  const { sessionId, name, participants } = req.body;
  
  const state = await loadStateFromDisk(sessionId);
  if (!state?.socket || state.status !== 'online') {
    return res.status(409).json({ error: 'Sessão não online' });
  }
  
  const group = await state.socket.groupCreate(name, participants);
  res.json({ ok: true, group });
});
```

---

## 📝 CONCLUSÃO

A biblioteca Baileys oferece **muito mais funcionalidades** do que atualmente explorado no AutoLinks. A implementação das funcionalidades de **alta prioridade** pode aumentar significativamente o valor da plataforma, permitindo:

- ✅ Envio de enquetes, áudios, documentos, stickers, localização
- ✅ Reagir e editar mensagens
- ✅ Controlar presença (digitando/online)
- ✅ Postar stories/status
- ✅ Criar e gerenciar grupos completamente via API

**Próximos passos recomendados:**
1. Começar pelos tipos avançados de mensagem (maior impacto, menor esforço)
2. Adicionar presença e reações
3. Implementar gerenciamento de grupos
4. Avaliar demanda por Business/Newsletters com clientes reais

---

**Documento criado em:** 2026-04-13  
**Por:** Análise automática de código Baileys
