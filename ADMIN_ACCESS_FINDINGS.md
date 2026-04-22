# Auditoria da Página /admin/access - Achados e Ajustes Necessários

**Data**: 2026-04-16  
**URL**: http://localhost:5173/admin/access  
**Arquivo**: src/pages/admin/AdminAccess.tsx

---

## 🔴 CRÍTICO - CAMPOS FALTANDO NA INTERFACE

### Problema
A seção "Grupos de destino" do modal de edição está INCOMPLETA.

**O que está presente:**
- ✅ Cota em Automações (`groupsPerAutomation`)
- ✅ Cota em Rotas (`groupsPerRoute`)

**O que está FALTANDO:**
- ❌ Grupos WhatsApp (`whatsappGroups`)
- ❌ Grupos Telegram (`telegramGroups`)

### Por que é crítico
- Estes campos existem em `AccessLimitOverrides` (type definition)
- Eles são usados em `applyAccessLevelLimits()` para limites finais
- Sem UI para editá-los, admin não pode limitar grupos por plataforma

### Exemplos de uso impossível
- Limitar WhatsApp a 10 grupos mas Telegram ilimitado
- Limitar Telegram a 5 grupos mas WhatsApp a 20
- Criar diferentes estratégias de grupos por plataforma

### Código atual (linhas 47-82)
```typescript
const RESOURCE_LIMIT_SECTIONS = [
  // ... Sessões ...
  {
    heading: "Grupos de destino",
    subtext: "Total de grupos somando todas as automações ou rotas...",
    cols: 2,
    fields: [
      { key: "groupsPerAutomation", label: "Cota em Automações" },
      { key: "groupsPerRoute", label: "Cota em Rotas" },
      // ❌ FALTAM: whatsappGroups, telegramGroups
    ],
  },
];
```

### Fix
Adicionar dois campos na seção "Grupos de destino":
```typescript
{
  key: "whatsappGroups",
  label: "Limite de Grupos WhatsApp",
  hint: "Máximo de grupos que o usuário pode registrar no WhatsApp (−1 ilimitado)",
},
{
  key: "telegramGroups", 
  label: "Limite de Grupos Telegram",
  hint: "Máximo de grupos que o usuário pode registrar no Telegram (−1 ilimitado)",
},
```

---

## 🔴 CRÍTICO - COMPORTAMENTO CONFUSO DE LIMITES NULOS

### Problema
Quando um campo de limite é `null` (não definido), a UI mostra `0`:

```typescript
// Linha 419
value={String(currentValue == null ? 0 : currentValue)}
```

### Por que é confuso
- `null` = "usar limite padrão do plano"
- `-1` = "ilimitado"
- `0` = "bloqueado" (nada permitido!)
- Números positivos = "limite específico"

### Cenário problemático
1. Admin abre modal, vê campo vazio com valor `0`
2. Pensa: "OK, não está definido"
3. Clica Salvar sem mexer no campo
4. Sistema salva `null` como `0`
5. Limite fica permanentemente bloqueado!
6. Ao abrir novamente, vê `0` de novo - não há forma de voltar

### Código problemático (linhas 419)
```typescript
<Input
  type="number"
  className="h-8"
  placeholder="0"  // ❌ Enganoso: placeholder "0" parece valor padrão
  value={String(currentValue == null ? 0 : currentValue)}  // ❌ Mostra 0 para null
  onChange={(event) => setLimitNumber(...)}
/>
```

### Código do setter (linhas 186-195)
```typescript
const setLimitNumber = (levelId: string, key: keyof AccessLimitOverrides, value: string) => {
  const parsed = Number(value);
  return {
    limitOverrides: {
      [key]: Number.isFinite(parsed) ? parsed : 0,  // ❌ Fallback para 0!
    },
  };
};
```

### Fix Necessário

**Opção A - Mostrar diferença visual:**
```typescript
value={String(currentValue == null ? "" : currentValue)}  // Campo vazio para null
placeholder="-1 para ilimitado, 0 bloqueia, vazio = padrão"
```

**Opção B - Adicionar botão Reset:**
```tsx
<div className="flex gap-1">
  <Input type="number" value={String(...)} onChange={...} />
  <Button size="sm" variant="outline" onClick={() => resetLimit(field.key)}>
    ↺ Padrão
  </Button>
</div>
```

**Opção C - Campo com persistência melhorada:**
```typescript
const setLimitNumber = (levelId: string, key: keyof AccessLimitOverrides, value: string) => {
  const parsed = value.trim() === "" ? null : Number(value);
  const finalValue = !Number.isFinite(parsed) ? 0 : parsed;
  // ... salva com parsed === null para "não definido"
};
```

---

## 🟠 ALTO - SEM FORMA DE RESETAR LIMITES

### Problema
Uma vez que um limite é definido com valor numérico, não há jeito de voltar a `null` (herdar do plano).

### Cenário
1. Admin define `whatsappSessions: 5`
2. Depois quer que volte ao padrão do plano (heredar limite)
3. Não há forma de fazer isso
4. Tem que deletar o nível inteiro e criar novo

### Fix Necessário
- Adicionar botão "Resetar para padrão" em cada campo, OU
- Permitir entrada vazia (string vazia = `null`), OU
- Usar checkbox "Usar padrão do plano" para habilitar/desabilitar o input

---

## 🟠 ALTO - VALIDAÇÃO FRACA

### Problema - setLimitNumber (linhas 186-195)

```typescript
const setLimitNumber = (levelId: string, key: keyof AccessLimitOverrides, value: string) => {
  const parsed = Number(value);
  return {
    limitOverrides: {
      [key]: Number.isFinite(parsed) ? parsed : 0,  // ❌ Silenciosamente vira 0!
    },
  };
};
```

### Cenários problemáticos
- Usuário digita "abc" → salva como `0` (bloqueado) sem aviso
- Usuário digita "12.5" → salva como `12.5` (pode quebrar lógica de limite)
- Campo vazio "" → `Number("")` = `0` → salva como bloqueado
- Usuário não sabe que erro aconteceu

### Impacto
- Configurações silenciosamente inválidas
- Ninguém avisa ao admin que algo deu errado
- Sistema fica em estado inconsistente

### Fix Necessário
```typescript
const setLimitNumber = (levelId: string, key: keyof AccessLimitOverrides, value: string) => {
  const trimmed = value.trim();
  
  // Campo vazio = reset para null (padrão)
  if (trimmed === "") {
    updateLevel(levelId, current => ({
      ...current,
      limitOverrides: { ...current.limitOverrides, [key]: null }
    }));
    return;
  }
  
  const parsed = Number(trimmed);
  
  // Validar: deve ser inteiro
  if (!Number.isInteger(parsed)) {
    toast.error(`${field.label} deve ser número inteiro`);
    return;
  }
  
  // Validar: deve ser >= -1
  if (parsed < -1) {
    toast.error(`${field.label} não pode ser menor que -1`);
    return;
  }
  
  updateLevel(levelId, current => ({
    ...current,
    limitOverrides: { ...current.limitOverrides, [key]: parsed }
  }));
};
```

---

## 🟡 MÉDIO - PLACEHOLDER E INSTRUÇÕES CONFUSAS

### Problema

**Linha 418:**
```typescript
placeholder="0"
```

Isso sugere que `0` é o padrão, mas `0` significa "bloqueado".

**Linha 395:**
```html
<p>Use <strong>-1</strong> pra ilimitado · <strong>0</strong> bloqueia. 
O sistema usa o menor valor entre o plano e o que tá aqui.</p>
```

Não deixa claro que:
- Campo vazio = `null` = "usar do plano"
- É diferente de `0` = "bloqueado"
- Como a hierarquia funciona realmente

### Fix Necessário

**Placeholder melhor:**
```typescript
placeholder="-1 = ilimitado, 0 = bloqueado"
// ou
placeholder="Deixe em branco para usar do plano"
```

**Instruções expandidas:**
```html
<p className="text-xs text-muted-foreground">
  <strong>Deixe em branco</strong> para usar o limite padrão do plano.<br/>
  Use <strong>-1</strong> para ilimitado, <strong>0</strong> para bloquear,
  ou um número específico.<br/>
  <small>O sistema usa sempre o menor valor: min(plano, nível)</small>
</p>
```

---

## 🟡 MÉDIO - DISPLAY INCONSISTENTE

### Problema

**No card (linhas 339-349):**
```typescript
const fmt = (n: number | null) => n == null ? "—" : n === -1 ? "∞" : String(n);
return <p>{fmt(ov.automations)} · {fmt(ov.routes)} ...</p>
```
Mostra: `—` (null), `∞` (−1), números

**No input (linha 419):**
```typescript
value={String(currentValue == null ? 0 : currentValue)}
```
Mostra: `0` (null), números

### Impacto
Inconsistência visual causa confusão.

### Fix
Padronizar: usar campo vazio (não "0") quando `null`.

---

## 🟡 MÉDIO - HIDDEN VS BLOCKED NÃO ESTÁ CLARO

### Problema

Três opções no select:
- ✅ "Liberado"
- "Oculto" (mode = "hidden")
- "Bloqueado" (mode = "blocked")

### Diferença técnica
- **Hidden** (linha 24 FeatureRouteGuard.tsx): Usuário é redirecionado para dashboard, não vê a feature
- **Blocked** (linhas 52-67): Usuário vê página especial com mensagem de erro

### Impacto
Admin não sabe quando usar "Oculto" vs "Bloqueado".

### Fix
Adicionar descrição em cada opção:

```typescript
<SelectContent>
  <SelectItem value="enabled">
    <div>
      <p className="font-medium">Liberado</p>
      <p className="text-xs text-muted-foreground">Acesso total</p>
    </div>
  </SelectItem>
  <SelectItem value="hidden">
    <div>
      <p className="font-medium">Oculto</p>
      <p className="text-xs text-muted-foreground">Não aparece na interface</p>
    </div>
  </SelectItem>
  <SelectItem value="blocked">
    <div>
      <p className="font-medium">Bloqueado</p>
      <p className="text-xs text-muted-foreground">Aparece com mensagem de erro</p>
    </div>
  </SelectItem>
</SelectContent>
```

---

## 🟡 MÉDIO - SEM VALIDAÇÃO DE CONSISTÊNCIA

### Problema

Nada impede configurações ilógicas:
- `whatsappSessions: 0` mas `automations: 10` (automações que precisam de sessão)
- `groupsPerAutomation: 3` mas `groupsPerRoute: 50` (muito desequilibrado)
- Todos os limites em `0` (nada pode ser feito)

### Impacto
Configurações estranhas podem confundir usuários finais.

### Fix (Não bloqueia, só avisa)
```typescript
// No salvar, antes de persistir:
const warnings: string[] = [];

if (ov.whatsappSessions === 0 && ov.automations !== null && ov.automations > 0) {
  warnings.push("⚠️ Nenhuma sessão WhatsApp mas há espaço para automações");
}

if (ov.groupsPerAutomation && ov.groupsPerRoute && 
    ov.groupsPerAutomation !== -1 && ov.groupsPerRoute !== -1) {
  const ratio = Math.max(ov.groupsPerAutomation, ov.groupsPerRoute) / 
                Math.min(ov.groupsPerAutomation, ov.groupsPerRoute);
  if (ratio > 5) {
    warnings.push(`⚠️ Proporção Grupos/Auto vs Grupos/Rota muito alta (${ratio.toFixed(1)}x)`);
  }
}

if (warnings.length > 0) {
  // Mostrar toast de aviso ou modal confirmando com warnings
}
```

---

## PLANO DE EXECUÇÃO

### Fase 1 - CRÍTICO (hoje)
1. [ ] Adicionar `whatsappGroups` e `telegramGroups` aos RESOURCE_LIMIT_SECTIONS
2. [ ] Corrigir comportamento de null no input (mostrar "" em vez de "0")
3. [ ] Melhorar validação em `setLimitNumber()` para aceitar valores vazios = null

### Fase 2 - ALTO (próximo dia)
4. [ ] Adicionar botão "Resetar" ou usar checkbox "Usar padrão"
5. [ ] Expandir instruções de limites (texto mais claro)
6. [ ] Melhorar placeholder e labels

### Fase 3 - MÉDIO (quando tiver tempo)
7. [ ] Clarificar Hidden vs Blocked com descrições
8. [ ] Adicionar validações de consistência (avisos)
9. [ ] Padronizar display entre card e modal

---

## IMPACTO DE NÃO CORRIGIR

### Risco Imediato
- ❌ Admin não consegue limitar grupos por plataforma
- ❌ Limites viram bloqueados permanentemente quando não deveriam
- ❌ Nenhuma forma de consertar sem deletar e recriar

### Risco Médio
- ❌ Configurações silenciosamente inválidas
- ❌ Usuários finais podem ficar confusos com "oculto" vs "bloqueado"
- ❌ Sem validação de consistência

### Risco Longo Prazo
- ❌ Admin precisa treinar usuários sobre comportamento estranho
- ❌ Mais tickets de suporte: "por que meu limite sumiu?"
- ❌ Perda de confiança no sistema de controle de acesso
