# Design System - Auto Links

## Objetivo
Padronizar a interface entre paginas internas e telas de autenticacao para reduzir variacoes de layout, tipografia e alinhamento.

## Diretrizes principais
- Fonte principal: `Plus Jakarta Sans`.
- Layout interno: largura maxima de conteudo `1240px`, centralizado.
- Espacamento vertical entre blocos de pagina: `space-y-6` (base) e `space-y-8` para paginas mais densas.
- Cards: raio `2xl`, borda suave e sombra leve.
- Inputs/selects/textarea: altura e ritmo visual consistentes.
- Botoes: peso semibold, alinhamento central, tamanhos previsiveis por variante.
- Headers de pagina: titulo + descricao com escala fixa e area de acoes alinhada a direita no desktop.

## Componentes base padronizados
- `src/components/ui/button.tsx`
  - Tipografia semibold
  - Tamanhos harmonizados (`sm`, `default`, `lg`, `icon`)
  - Melhor consistencia de densidade e alinhamento
- `src/components/ui/card.tsx`
  - Shell com `rounded-2xl`
  - Header/content/footer com ritmo unico de paddings
  - Footer com alinhamento de acoes orientado para consistencia
- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/textarea.tsx`
  - Controles de formulario com linguagem visual uniforme
- `src/components/ui/loading-state.tsx`
  - Componente unico para estados de carregamento (`screen`, `page`, `inline`)
  - Mesmo spinner, tipografia e transicao em toda a aplicacao
  - Centraliza o fallback de lazy loading de rotas e estados de validacao

## Layout global
- `src/components/AppLayout.tsx`
  - Conteudo interno centralizado em container unico
  - Padding responsivo padrao para desktop e mobile
- `src/components/PageHeader.tsx`
  - Estrutura semantica (`header`)
  - Titulo/descricao com hierarquia fixa
  - Area de acoes com comportamento responsivo

## Utilitarios globais
- `src/index.css`
  - `ds-page`: container de pagina padrao
  - `ds-stack`: stack vertical padrao
  - `ds-card-grid`: grid para blocos de cards
  - `ds-center-inline`: centralizacao inline para icones e conteudo curto

## Regra para novas telas
1. Comecar pela estrutura de `PageHeader` + blocos em `Card`.
2. Evitar estilos ad-hoc de tamanho/alinhamento em botoes e formularios.
3. Usar utilitarios `ds-*` quando possivel antes de criar classes novas.
4. Se um ajuste for recorrente em 2+ telas, promover para componente base ou token.
5. Para carregamento de tela/rota, usar `loading-state` (evitar spinners ad-hoc).

## Padrao de lazy loading por pagina
- Todas as paginas em `src/pages/**` devem ser carregadas por `React.lazy` em `src/routes/lazy-pages.ts`.
- O roteamento principal (`src/routes/AppRoutes.tsx`) deve manter `Suspense` global com fallback padronizado.
- Guardas de rota e validacoes assicronas devem usar `RoutePendingState`, que delega para `loading-state`.

## Checklist rapido de consistencia
- Titulo principal segue `PageHeader`?
- Botoes de acao estao alinhados e com mesmo tamanho por contexto?
- Inputs/select/textarea mantem mesma altura e borda?
- Cards tem o mesmo raio, borda e ritmo interno?
- Conteudo esta centralizado dentro do container global?

---

## Refatoração visual global (2026-03)

### Biblioteca de componentes shadcn/ui
shadcn/ui já estava configurado via `components.json`. A refatoração completou a biblioteca com os
componentes faltantes e reforçou o uso dos existentes em todo o sistema.

**Componentes adicionados:**
- `src/components/ui/table.tsx` — tabelas semânticas (Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption)
- `src/components/ui/avatar.tsx` — avatares com fallback (@radix-ui/react-avatar)
- `src/components/ui/popover.tsx` — popover flutuante (@radix-ui/react-popover), `rounded-xl`
- `src/components/ui/radio-group.tsx` — seleção exclusiva (@radix-ui/react-radio-group)
- `src/components/ui/toggle.tsx` — botão toggle (@radix-ui/react-toggle), variantes default/outline
- `src/components/ui/command.tsx` — paleta de comandos (cmdk), todos os itens com `rounded-lg`

### Variantes semânticas de Badge
O componente `Badge` ganhou variantes semânticas para status e feedback:
```
variant="success"     → border-success/30 bg-success/10 text-success
variant="warning"     → border-warning/30 bg-warning/10 text-warning
variant="info"        → border-info/30 bg-info/10 text-info
variant="destructive" → border-destructive/30 bg-destructive/10 text-destructive (agora sutil)
```
**Regra:** nunca usar classes inline `bg-success/10 text-success` diretamente. Sempre `<Badge variant="success">`.

### Variantes semânticas de Alert
O componente `Alert` ganhou variantes de feedback:
```
variant="success"     → estilo verde sutil, ícone colorido
variant="warning"     → estilo âmbar sutil
variant="info"        → estilo azul sutil
variant="destructive" → estilo vermelho sutil (era sólido antes)
```
Base mudou de `rounded-lg` para `rounded-xl`.

### Token de tipografia text-2xs
Adicionado em `tailwind.config.ts`:
```
text-2xs → 0.625rem (10px), line-height: 0.875rem
```
Todos os `text-[10px]`, `text-[9px]` e `text-[11px]` foram substituídos por `text-2xs` e `text-xs`
respectivamente, em todos os arquivos `.tsx` do projeto.

### Regras de ortografia (PT-BR sentence case)
Todas as strings visíveis da interface seguem a regra:
- **Primeira letra da frase/título em maiúsculo, restante em minúsculo**
- **Nomes próprios e marcas sempre em maiúsculo** (Shopee, WhatsApp, Telegram, Mercado Livre)

Exemplos corretos:
```
✅ "Vitrine de ofertas"         ❌ "Vitrine de Ofertas"
✅ "Rotas automáticas"          ❌ "Rotas Automáticas"
✅ "Grupos de destino"          ❌ "Grupos de Destino"
✅ "Piloto automático"          ❌ "Piloto Automático"
✅ "Conversor de links"         ❌ "Conversor de Links"
✅ "Sessões WhatsApp"           ✅ (WhatsApp é marca)
✅ "Automações Shopee"          ✅ (Shopee é marca)
```

### Padrão de ícones
- **Biblioteca principal:** `lucide-react` para todos os ícones de UI
- **Exceção:** `react-icons` apenas para ícones de marca — `FaTelegramPlane`, `FaWhatsapp`
- Não usar `react-icons` para ícones genéricos de interface
