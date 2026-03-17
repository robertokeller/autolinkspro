# Visual Restructuring Study

Data: 2026-03-10
Projeto: Auto Links
Escopo: padronizar interface (icones, componentes, transicoes, efeitos, janelas e cards) com base no stack atual e em padroes visuais do Tailwind Plus (Flyout Menus).

## 1) Objetivo

Criar um padrao unico de UI para reduzir variacoes visuais entre telas, acelerar manutencao e manter consistencia de experiencia em desktop e mobile.

## 2) Base Tecnica Recomendada (Padrao Oficial)

Manter e reforcar as bibliotecas ja presentes no projeto:

- `Tailwind CSS`: tokens, layout, spacing, responsividade e utilitarios visuais.
- `Radix UI` (via componentes `src/components/ui/*`): acessibilidade, overlays, interacoes.
- `shadcn/ui` (estrutura local): base composavel para button/card/dialog/dropdown/sidebar etc.
- `lucide-react`: biblioteca unica de icones.
- `framer-motion`: animacoes orquestradas (entrada de pagina, stagger, transicoes de listas).
- `tailwindcss-animate`: animacoes utilitarias simples (open/close de overlays).

Diretriz critica:

- Nao introduzir novas bibliotecas de icones ou kits paralelos de componentes.
- Nao copiar codigo proprietario do Tailwind Plus; usar apenas os padroes de estrutura e UX como referencia.

## 3) Diagnostico Atual

Pontos fortes:

- Tokens de cor e tema ja centralizados em `src/index.css`.
- Configuracao de design tokens e animacoes em `tailwind.config.ts`.
- Base consistente de primitives (`card`, `dialog`, `dropdown-menu`, `sidebar`, `button`).
- Iconografia centralizada em `lucide-react`.

Gaps encontrados:

- Componentes de dominio aplicam estilos locais sem padrao unico de densidade/espacamento.
- Variacoes de hover/focus/active em cards, badges e botoes contextuais.
- Uso misto de transicoes: parte em classes Tailwind, parte sem padrao temporal.
- Menus complexos (ex.: seletores com arvore) sem linguagem visual padronizada de flyout.

## 4) Padrao Global de Interface

### 4.1 Iconografia

- Fonte unica: `lucide-react`.
- Tamanhos padrao:
  - navegacao primaria: `h-4 w-4`
  - acao secundaria: `h-3.5 w-3.5`
  - destaque/status: `h-5 w-5`
- Containers de icone:
  - botao icon-only: `size=icon` em `Button`
  - icone em card: `h-9 w-9 rounded-lg bg-primary/10 text-primary`

### 4.2 Componentes (Single Source of Truth)

Todos os modulos de negocio devem compor apenas primitives de `src/components/ui`:

- `Button`, `Card`, `Dialog`, `DropdownMenu`, `Sheet`, `Tabs`, `Badge`, `Alert`, `Tooltip`, `Sidebar`.

Evitar:

- wrappers customizados duplicando comportamento de primitive.
- classes longas repetidas em multiplos arquivos quando virar padrao reutilizavel.

### 4.3 Transicoes e Efeitos

Padrao de duracao:

- hover/focus: `duration-200`
- open/close overlay: `duration-200` a `duration-300`
- entrada de card/lista: `animate-card-in` ou `framer-motion` com 0.2s-0.35s

Padrao de easing:

- default: `ease-out`
- navegacao e sidebars: `ease-linear` apenas quando ja estiver no primitive base

Padrao de elevao visual:

- surface base: `shadow-sm`
- overlay/menu/dialog: `shadow-xl` ou `shadow-2xl`
- evitar sombra custom por tela sem justificativa de hierarquia

### 4.4 Janelas (Dialog/Sheet)

- usar `DialogContent` padrao como base unica.
- header sempre com `DialogHeader`, `DialogTitle`, `DialogDescription`.
- footer com `DialogFooter` e ordem de acoes consistente:
  - acao secundaria a esquerda
  - acao primaria a direita
- em mobile, respeitar `max-h-[92dvh]` e `overflow-y-auto`.

### 4.5 Cards

- usar `Card` default (`rounded-xl border border-border/70 bg-card/95 shadow-sm`).
- estrutura obrigatoria para consistencia:
  - `CardHeader` (titulo e contexto)
  - `CardContent` (dados/controles)
  - `CardFooter` (acoes)
- evitar card sem header quando houver metrica ou estado.

## 5) Flyout Menus (Tailwind Plus Inspired)

Referencia visual: Tailwind Plus Flyout Menus (marketing/elements/flyout-menus).

Padroes a adotar no projeto:

- trigger claro com estado aberto/fechado.
- painel com secoes bem definidas (grupo principal + acoes de rodape).
- opcao de layout:
  - simples com descricao
  - duas colunas para menus de alta densidade
  - stacked com footer actions para atalhos
- icones alinhados por coluna fixa.
- itens com titulo + descricao curta quando necessario.
- footer com CTA de alta relevancia (ex.: "Ver tudo", "Configuracoes").

Implementacao tecnica recomendada:

- base em `DropdownMenu` (Radix) para menus compactos.
- migrar para `Popover`/`Dialog` quando o menu virar mini-painel com multi-coluna e muito conteudo.
- animacao de entrada padrao (fade + zoom + slide curto) reutilizando classes existentes em `dropdown-menu.tsx`.

## 6) Plano de Migracao por Fase

### Fase 1 - Foundation (rapida, baixo risco)

- Consolidar um guia de classes utilitarias para:
  - densidade de formularios
  - blocos de cabecalho
  - lista de acoes
- Revisar componentes `ui/*` para garantir variantes suficientes antes de alterar telas.

### Fase 2 - Navegacao e Menus

- Padronizar todos os menus complexos no modelo flyout.
- Prioridade inicial:
  - `src/components/AppSidebar.tsx`
  - `src/components/shopee/CategoryMultiSelect.tsx`

### Fase 3 - Overlays e Janelas

- Harmonizar dialogs e sheets em paginas com maior uso operacional.
- Garantir consistencia de spacing, hierarquia e foco visual.

### Fase 4 - Cards e Modulos de Negocio

- Aplicar padrao unico em cards de metricas, cards de sessao e cards de configuracao.
- Remover variacoes isoladas que nao agregam semantica.

### Fase 5 - Motion e Polimento

- Introduzir stagger de entrada com `framer-motion` em listas longas.
- Uniformizar timing de interacoes.
- Revisar comportamento mobile (breakpoints e touch targets).

## 7) Checklist de Padronizacao (Definition of Done)

- 100% dos icones vindos de `lucide-react`.
- 100% dos overlays baseados em primitives `ui/*`.
- 0 componentes novos duplicando primitive existente.
- Menus com estados de foco/teclado acessiveis.
- Contraste minimo AA em texto principal e acoes.
- Sem regressao visual relevante em `sm`, `md`, `lg`.

## 8) Backlog Tecnico Imediato (Proximo Sprint)

1. Criar uma variacao de flyout padrao reutilizavel em `src/components/ui`.
2. Refatorar `CategoryMultiSelect` para usar composicao de secoes no padrao flyout.
3. Revisar cards de conexoes (WhatsApp/Telegram) para estrutura unica de `CardHeader/CardContent/CardFooter`.
4. Padronizar tempos de animacao em classes utilitarias compartilhadas.
5. Validar acessibilidade de navegacao por teclado nos menus.

## 9) Risco e Mitigacao

Riscos:

- refactor visual extenso gerar regressao de layout.
- divergencia entre desktop e mobile em menus complexos.

Mitigacao:

- migracao incremental por modulo.
- snapshots visuais por tela critica.
- feature flags para habilitar novo padrao por secao.

## 10) Resultado Esperado

- UI coesa e previsivel para o usuario.
- Menor custo de manutencao visual.
- Maior velocidade para criar novas telas sem retrabalho de estilo.
