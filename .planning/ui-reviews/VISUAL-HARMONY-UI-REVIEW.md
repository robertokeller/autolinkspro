# Visual Harmony — UI Review

**Audited:** 2026-03-17
**Baseline:** DESIGN_SYSTEM.md + abstract 6-pillar standards (no UI-SPEC.md)
**Screenshots:** Captured (desktop 1440×900, mobile 375×812, tablet 768×1024)

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | All labels use PT-BR sentence case; CTAs are specific ("Criar agendamento", "Nova rota"); empty/error states use `EmptyState` component with contextual messages |
| 2. Visuals | 3/4 | Strong visual hierarchy with `PageHeader`, `glass` cards, and consistent status bars; minor issue with 9 distinct font sizes in use |
| 3. Color | 4/4 | Color usage is clean — only 1 hardcoded hex (landing page CTA), 1 inline rgb; accent properly channeled through design tokens; semantic badges (`success`, `warning`, `info`) used correctly |
| 4. Typography | 3/4 | 9 font sizes and 5 font weights in use — above the recommended 4 sizes / 2 weights, but justified by the app's complexity (admin dashboards, compact lists, headers); the `text-2xs` custom token covers 10px needs |
| 5. Spacing | 4/4 | Consistent Tailwind scale usage; `ds-page` provides `space-y-6` baseline; no arbitrary spacing values in page files; top classes follow expected distribution (gap-2: 211, space-y-2: 142, gap-1: 135) |
| 6. Experience Design | 4/4 | Excellent state coverage — 191 loading refs (Skeleton/Loader2), 67 empty state refs (EmptyState component), 127 error handlers (toast.error), 74 disabled state guards, 222 AlertDialog confirmation refs |

**Overall: 22/24**

---

## Top 3 Priority Fixes

1. **Typography scale could be tighter** — 9 distinct font sizes (`text-xs` through `text-5xl`) create subtle visual inconsistency in dense views — Consider consolidating `text-4xl` and `text-5xl` to only be used on marketing/landing pages, keeping app pages to ≤6 sizes
2. **Font weight breadth** — 5 weights (`normal`, `medium`, `semibold`, `bold`, `extrabold`) — `font-extrabold` and `font-thin` could be limited to the landing page hero, keeping app UI to `normal`, `medium`, `semibold`, `bold`
3. **Minor: landing page hardcoded hex** — `Index.tsx:153` has a `#features` anchor link that triggers the hardcoded color match; while harmless, the landing page could benefit from using the same token-based approach as the app

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

All user-facing copy follows PT-BR sentence case per DESIGN_SYSTEM.md rules. Key observations:

- **CTAs are specific:** "Criar agendamento", "Nova rota", "Adicionar sessão", "Selecionar imagem" — no generic "Submit" or "Click Here" labels found in user-facing UI
- **Empty states:** All pages use the shared `EmptyState` component with contextual titles ("Nenhum agendamento ainda", "Nenhum template encontrado")
- **Error handling:** 127 `toast.error` calls provide specific error feedback ("E-mail ou senha incorretos", "API fora do ar")
- **Confirmation dialogs:** Destructive actions use `AlertDialog` with clear consequences ("O agendamento vai ser apagado e não tem como desfazer")

No generic labels found. No placeholder copy or Lorem ipsum detected.

### Pillar 2: Visuals (3/4)

Strong visual system built on consistent patterns:

- **Focal hierarchy:** `PageHeader` provides consistent title (text-2xl/3xl bold) + description across all pages
- **Card depth:** All user-facing page cards use `glass` class (bg-card/80 backdrop-blur-xl border-border/50) — verified across Dashboard, Rotas, Modelos, Historico, Agendamentos, LinkHub, Configurações, MercadoLivreConfigurações, ShopeeConversor, ShopeeConfigurações, ShopeeAutomacoes
- **Status indicators:** Color-coded status bars (h-0.5) on route/schedule cards with semantically correct colors (success=green, destructive=red, info=blue)
- **Minor:** 9 font sizes create slight visual noise in dense admin views — not blocking but could be tighter

### Pillar 3: Color (4/4)

Excellent token discipline:

- **Hardcoded colors:** Only 1 hex reference (`Index.tsx` landing page) and 1 rgb reference across all TSX files
- **Primary accent:** 109 references to `text-primary|bg-primary|border-primary` — well distributed across interactive elements (buttons, links, active states, CTAs)
- **Semantic colors:** Properly using `success`, `warning`, `info`, `destructive` tokens through Badge/Alert semantic variants
- **Glass consistency:** `bg-card/80 backdrop-blur-xl` provides depth without competing with accent colors

### Pillar 4: Typography (3/4)

Font system is functional but wider than ideal:

- **Sizes in use (9):** `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`, `text-3xl`, `text-4xl`, `text-5xl`
- **Weights in use (5):** `font-normal`, `font-medium`, `font-semibold`, `font-bold`, `font-extrabold`
- **Custom token:** `text-2xs` (10px) properly covers compact badge/label needs
- **Justification:** The app has 3 visual contexts (landing page, user app, admin dashboard) which legitimately need different scales. Within the user app specifically, sizes are mostly `text-xs` through `text-2xl` (6 sizes) which is acceptable.

Recommendation: Limit `text-4xl`/`text-5xl`/`font-extrabold` to landing page only.

### Pillar 5: Spacing (4/4)

Highly consistent spacing across the application:

- **ds-page utility:** Provides `mx-auto w-full max-w-[1240px] space-y-6` as the standard page container — used consistently across all user-facing pages
- **Top spacing classes:** gap-2 (211), space-y-2 (142), gap-1 (135), gap-3 (64), space-y-1 (64) — follows a consistent 4px/8px/12px/16px scale
- **No arbitrary spacing values:** No `[Npx]` or `[Nrem]` spacing values found in page files
- **Card padding:** Consistent `p-3`/`p-4`/`p-5` patterns inside CardContent
- **Narrow page pattern:** Pages like ShopeeConfigurações (max-w-3xl), ShopeeConversor (max-w-4xl), Configurações (max-w-4xl) properly use inner `mx-auto` containers within ds-page

### Pillar 6: Experience Design (4/4)

Comprehensive state coverage:

- **Loading states (191 refs):** Every data-fetching page has skeleton loading states with proper glass card shells
- **Empty states (67 refs):** Shared `EmptyState` component with icon, title, description, and optional action button
- **Error handling (127 toast.error):** All API calls wrapped with specific error messages; auth pages detect API unavailability
- **Disabled states (74 refs):** Buttons properly disabled during loading/processing states
- **Destructive confirmations (222 AlertDialog refs):** Delete operations use `AlertDialog` with descriptive warnings
- **Optimistic patterns:** Route/schedule cards show real-time status through color-coded bars and semantic badges

---

## Files Audited

### Pages (user-facing)
- `src/pages/Dashboard.tsx`
- `src/pages/Rotas.tsx`
- `src/pages/Modelos.tsx`
- `src/pages/Configurações.tsx`
- `src/pages/Historico.tsx`
- `src/pages/Agendamentos.tsx`
- `src/pages/LinkHub.tsx`
- `src/pages/mercadolivre/MercadoLivreConfigurações.tsx`
- `src/pages/shopee/ShopeeConversor.tsx`
- `src/pages/shopee/ShopeePesquisa.tsx`
- `src/pages/shopee/ShopeeVitrine.tsx`
- `src/pages/shopee/ShopeeAutomacoes.tsx`
- `src/pages/shopee/ShopeeConfigurações.tsx`

### Pages (auth)
- `src/pages/auth/Login.tsx`
- `src/pages/auth/Cadastro.tsx`
- `src/pages/auth/EsqueciSenha.tsx`
- `src/pages/auth/ResetarSenha.tsx`
- `src/pages/auth/VerificaçãoEmail.tsx`

### Pages (admin)
- `src/pages/admin/AdminDashboard.tsx`
- `src/pages/admin/AdminUsers.tsx`
- `src/pages/admin/AdminLogs.tsx`
- `src/pages/admin/AdminNotifications.tsx`
- `src/pages/admin/AdminPlans.tsx`
- `src/pages/admin/AdminAccess.tsx`

### Shared components
- `src/components/PageHeader.tsx`
- `src/components/AppLayout.tsx`
- `src/components/EmptyState.tsx`
- `src/components/StatCard.tsx`
- `src/components/conexoes/ConexoesCanalLayout.tsx`
- `src/components/auth/AuthCard.tsx`

### Styles
- `src/index.css`

### Reference
- `docs/DESIGN_SYSTEM.md`
- `components.json`
