# Plano de Evolução — /home (Auto Links)

**Data:** 16/03/2026  
**Baseline:** Redirect Flow análise + Auto Links atual  
**Abordagem:** Minimamente invasiva (mudanças de alto impacto, baixo risco)

---

## Fase 1: High-Impact Wins (Semana 1)

### 1. **Badges de Confiança no Hero** (5 min)
- Adicionar **"Garantia de 7 dias"** + **"Cancele quando quiser"** logo abaixo do H1
- Copia exato da Redirect Flow: ícones checkmark + subtitle
- **Arquivo:** `src/pages/Index.tsx` → section Hero

### 2. **Marquee de Logos (Marketplaces)** (10 min)
- Strip animado: Shopee, Mercado Livre, (Amazon se aplicável)
- Posição: Logo após stats do hero, antes de "Features"
- **Impacto:** Confiança instantânea, 3 segundos de scroll para ver
- **Arquivo:** Novo componente ou inline no Index

### 3. **Trocar Copy do Hero com Métrica** (3 min)
- Atual: "Você conexa seu WhatsApp ou Telegram…"
- Novo: Incluir **"até 180% mais conversões"** ou **"200+ ofertas/dia"** (se real)
- **Arquivo:** `src/pages/Index.tsx` → H2

### 4. **Reforçar Toggle Preço com "Economize"** (5 min)
- Mostrar **economia explícita** ao selecionar anual
- Exemplo: "R$194 economizados" (red em destaque)
- **Arquivo:** `src/pages/Index.tsx` → pricing-toggle section

### 5. **Botão WhatsApp Flutuante** (10 min - se não tiver)
- Canto inferior direito, ícone WhatsApp
- Abre conversa direto com equipe
- **Arquivo:** Novo ou componente existente

---

## Fase 2: Proof of Concept (Semana 2)

### 6. **Seção "Veja o Painel" com Screenshots** (15 min)
- 3 cards/screenshots: "Monitoramento", "Disparo", "Rodízio de Links"
- Antes da seção de Testimonials
- **Arquivo:** Componente new ou inline

### 7. **Depoimentos com Imagem/Contexto** (10 min)
- Se tiver prints: grid 3x1 com imagem + nome/resultado
- Se não tiver: destacar quote + badge de "verificado"
- **Arquivo:** `src/pages/Index.tsx` → Testimonials section

---

## Fase 3: Conversão Linear (Semana 3)

### 8. **CTA Header Para Pricing** (2 min)
- Header CTA principal: **"Ver Planos"** (em vez de "Começar grátis")
- Smooth scroll para `#pricing`
- **Arquivo:** `src/pages/Index.tsx` → header section

---

## Prioridade de Impacto (Top 3)

| Rank | Ação | Impacto | Tempo |
|------|------|--------|-------|
| 1 | Badges + Marquee | ↑↑ Confiança / Conversão | 15 min |
| 2 | Métrica no Hero + Toggle Economia | ↑ Copy persuasivo | 8 min |
| 3 | WhatsApp Float | ↑ Fallback conversão | 10 min |

---

## Checklist Implementação

- [ ] Badges (Garantia + Cancelamento)
- [ ] Marquee de logos
- [ ] Copy hero com métrica
- [ ] Toggle com economia
- [ ] WhatsApp float
- [ ] Lint + build
- [ ] Backup (git commit)

---

## Estimativa Total
**~50 minutos de trabalho** (implementação + validação)

