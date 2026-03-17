import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Flame, ShoppingBag, ShoppingCart, Route, Clock, ArrowRight, Check, X, Users, Star, LayoutDashboard, Zap } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { ROUTES } from "@/lib/routes";
import { WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";

const features = [
  { icon: WhatsAppIcon, title: "Multi-Sessão WhatsApp & Telegram", description: "Conecte várias sessões ao mesmo tempo e gerencie tudo no mesmo painel, de forma simples." },
  { icon: ShoppingBag, title: "Shopee", description: "Você filtra somente as melhores comissões dos produtos que realmente vendem, tudo no automático." },
  { icon: ShoppingCart, title: "Mercado Livre", description: "Automatize a conversão de ofertas do Mercado Livre com poucos cliques, sem nenhuma burocracia." },
  { icon: Users, title: "Master Groups", description: "Tenha controle automático de tudo o que acontece nos seus grupos com organização centralizada." },
  { icon: Clock, title: "Agendamentos", description: "Programe mensagens para quando quiser e o sistema cuida do resto pra você." },
  { icon: Route, title: "Rotas Inteligentes", description: "Copie as ofertas dos maiores players do mercado no automático, sem precisar fazer nada manualmente." },
];

const testimonials = [
  { name: "Lucas Ferreira", text: "Mano, depois que eu ajustei o filtro de comissão para só enviar oferta acima de 15%, eu comecei a lucrar bem mais com os mesmos grupos que eu já tinha." },
  { name: "Tayná Oliveira", text: "Na real, depois que automatizei as rotas ficou bem mais leve. Hoje eu faço uma conferência 1 vez por semana e deixo rodando no automático o resto dos dias." },
  { name: "Pedro Henrique", text: "Eu pagava bem mais caro em outras ferramentas e não tinha metade do que tem aqui. As automações fazem quase tudo sozinhas e as rotas para copiar estratégia de concorrente ajudam demais." },
];

const withoutAutoLinks = [
  "Fica o dia todo postando ofertas manualmente, uma por uma",
  "Perde as melhores promoções porque não viu a tempo",
  "WhatsApp e Telegram gerenciados em apps separados, fora do controle",
  "Os grupos ficam parados enquanto você dorme ou descansa",
  "Não sabe o que os maiores afiliados do mercado estão divulgando",
  "Link de afiliado precisa ser gerado manualmente em cada oferta",
];

const withAutoLinks = [
  "Zero minutos de trabalho — as rotas postam 24h por dia sozinhas",
  "Captura automática de ofertas das fontes monitoradas em segundos",
  "WhatsApp e Telegram integrados num único painel centralizado",
  "Os grupos continuam vendendo mesmo quando você está dormindo",
  "Monitoramento em tempo real das principais fontes do mercado",
  "Link afiliado gerado e disparado automaticamente ao detectar a oferta",
];

const faqs = [
  {
    q: "Preciso ficar online para as automações funcionarem?",
    a: "Não. Depois que você configura as rotas e automações, o sistema opera de forma completamente independente. O Auto Links roda 24 horas por dia, 7 dias por semana — enquanto você dorme, viaja ou cuida de outro trabalho, ele continua monitorando fontes, gerando links com seu cookie de afiliado e disparando ofertas nos seus grupos sem nenhuma intervenção sua.",
  },
  {
    q: "Como funciona o monitoramento de rotas inteligentes?",
    a: "Você cadastra quais fontes quer monitorar e define os grupos de destino. O Auto Links rastreia cada oferta publicada em tempo real, captura o link do produto, processa com seu cookie de afiliado e dispara automaticamente nos grupos configurados. Tudo em segundos, sem você precisar copiar, colar ou confirmar nada.",
  },
  {
    q: "Consigo usar WhatsApp e Telegram ao mesmo tempo?",
    a: "Sim. O Auto Links suporta múltiplas sessões de WhatsApp e Telegram em paralelo, tudo num único painel. Você gerencia os dois canais de forma integrada, define regras específicas por plataforma e acompanha o status de cada sessão em tempo real — sem precisar abrir apps separados ou alternar entre ferramentas diferentes.",
  },
  {
    q: "Corro risco de ter minha conta banida?",
    a: "O sistema conta com proteções nativas: delays inteligentes entre envios consecutivos, templates de mensagem rotativos para evitar padrão repetitivo, sistema de filas para não sobrecarregar sessões e pausas automáticas quando o limiar de segurança é atingido. Seguindo as configurações recomendadas no painel, o risco é muito baixo.",
  },
  {
    q: "Posso definir horários exatos para as automações dispararem?",
    a: "Sim. O módulo de agendamento permite configurar janelas horárias precisas para cada automação — dias da semana, horário de início e de fim. O sistema respeita esses limites automaticamente, ideal para atingir seus grupos no momento de maior engajamento e para não enviar ofertas fora de hora, o que reduz o desengajamento dos membros.",
  },
  {
    q: "Como funciona o conversor de links da Shopee e do Mercado Livre?",
    a: "Basta colar o link de qualquer produto. O sistema detecta automaticamente a plataforma, gera o URL com seu cookie de afiliado e entrega o link pronto para divulgar — sem trabalho manual. No caso da Shopee, ele também remove parâmetros que prejudicam o rastreamento da comissão, garantindo que cada clique seja corretamente atribuído a você.",
  },
  {
    q: "É difícil de configurar para quem está começando?",
    a: "Não. O painel foi desenhado para ser simples e direto: você conecta sua primeira sessão WhatsApp via QR Code, configura uma rota em menos de 5 minutos e o sistema já começa a trabalhar por você. Não é necessário nenhum conhecimento técnico — tudo é visual e guiado. E se tiver alguma dúvida, o suporte está disponível para ajudar você a dar o primeiro passo.",
  },
  {
    q: "Posso cancelar a qualquer momento sem multa?",
    a: "Sim. Todos os planos são sem fidelidade e sem qualquer taxa de cancelamento. Você pode assinar no modelo mensal ou anual — o plano anual oferece 2 meses grátis e é cobrado de uma vez, mas sem multa de saída. Você pode fazer upgrade, downgrade ou cancelar quando quiser, diretamente no painel, sem precisar falar com ninguém. Sem burocracia, sem prazo mínimo, sem letra miúda.",
  },
];

const fadeUp = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5 } };

export default function Index() {
  const { user, isLoading } = useAuth();
  const { state } = useAdminControlPlane();
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "annual">("monthly");

  const publicPlans = state.plans
    .filter((plan) => plan.isActive && plan.visibleOnHome && (plan.billingPeriod ?? "monthly") === billingPeriod)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((plan) => ({
      id: plan.id,
      name: plan.homeTitle || plan.name,
      priceLabel: plan.price === 0 ? "Grátis" : `R$${plan.price.toFixed(2).replace(".", ",")}`,
      period: plan.period,
      monthlyEquivalentPrice: plan.monthlyEquivalentPrice,
      description: plan.homeDescription,
      features: Array.isArray(plan.homeFeatureHighlights) && plan.homeFeatureHighlights.length > 0
        ? plan.homeFeatureHighlights.slice(0, 6)
        : [],
      cta: plan.homeCtaText || (plan.price === 0 ? "Começar grátis" : `Assinar ${plan.name}`),
      highlight: plan.id === "plan-pro" || plan.id === "plan-pro-annual",
    }));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl">
        <div className="container flex h-14 items-center justify-between">
          <Link to={ROUTES.home} className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Flame className="h-3.5 w-3.5" /></div>
            <span className="font-bold text-sm">Auto Links</span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {!isLoading && user ? (
              <Button size="sm" asChild><Link to={ROUTES.app.dashboard}><LayoutDashboard className="h-4 w-4 mr-1.5" />Ir para dashboard</Link></Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" asChild><Link to={ROUTES.auth.login}>Login</Link></Button>
                <Button size="sm" asChild><Link to={ROUTES.auth.cadastro}>Começar grátis</Link></Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="container py-20 md:py-32 text-center">
        <motion.div {...fadeUp} className="max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-1.5 rounded-full border bg-secondary/50 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Flame className="h-3 w-3 text-primary" />Sistema Nº1 para afiliados Shopee e Mercado Livre
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.1]">
            Automatize suas divulgações. <span className="text-gradient">Escale seus resultados.</span>
          </h1>
          <div className="flex items-center justify-center gap-4 flex-wrap text-xs font-medium text-muted-foreground pt-2">
            <div className="flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /><span>Garantia de 7 dias</span></div>
            <div className="w-1 h-1 rounded-full bg-border" />
            <div className="flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /><span>Cancele quando quiser</span></div>
          </div>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto pt-4">
            Conecte seu WhatsApp ou Telegram e o sistema cria ofertas sozinho e até monitora as estratégias do mercado por você. Tudo no automático!
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            {!isLoading && user ? (
              <Button size="lg" className="glow-primary" asChild><Link to={ROUTES.app.dashboard}><LayoutDashboard className="h-4 w-4 mr-1.5" />Ir para dashboard</Link></Button>
            ) : (
              <Button size="lg" className="glow-primary" asChild><Link to={ROUTES.auth.cadastro}>Começar grátis<ArrowRight className="h-4 w-4 ml-1.5" /></Link></Button>
            )}
            <Button size="lg" variant="outline" asChild><a href="#features">Ver funcionalidades</a></Button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 pt-8 border-t border-border/50">
            <div className="text-center"><p className="text-2xl font-bold">+100</p><p className="text-xs text-muted-foreground">afiliados ativos</p></div>
            <div className="hidden sm:block w-px h-8 bg-border" />
            <div className="text-center"><p className="text-2xl font-bold">24/7</p><p className="text-xs text-muted-foreground">operação automática</p></div>
            <div className="hidden sm:block w-px h-8 bg-border" />
            <div className="text-center"><p className="text-2xl font-bold">5 min</p><p className="text-xs text-muted-foreground">para configurar</p></div>
            <div className="hidden sm:block w-px h-8 bg-border" />
            <div className="text-center"><p className="text-2xl font-bold">2</p><p className="text-xs text-muted-foreground">canais (WhatsApp + Telegram)</p></div>
          </div>
        </motion.div>
      </section>

      {/* Marketplace Compatibility Strip */}
      <section className="w-full bg-secondary/30 border-y border-border/50 py-6">
        <div className="container">
          <p className="text-center text-xs text-muted-foreground font-medium mb-4">COMPATÍVEL COM OS MAIORES MARKETPLACES</p>
          <div className="flex items-center justify-center gap-8 flex-wrap">
            <div className="text-center opacity-75 hover:opacity-100 transition-opacity"><p className="text-sm font-semibold">Shopee</p></div>
            <div className="w-1 h-6 bg-border/30 hidden sm:block" />
            <div className="text-center opacity-75 hover:opacity-100 transition-opacity"><p className="text-sm font-semibold">Mercado Livre</p></div>
            <div className="w-1 h-6 bg-border/30 hidden sm:block" />
            <div className="text-center opacity-75 hover:opacity-100 transition-opacity"><p className="text-sm font-semibold">Amazon</p></div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="container py-20 border-t">
        <motion.div {...fadeUp} className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Tudo que você precisa, em um só lugar</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">Ferramentas profissionais para afiliados que querem escalar suas operações.</p>
        </motion.div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
          {features.map((feature, i) => (
            <motion.div key={feature.title} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: i * 0.08 }}
              className="group h-full rounded-xl border bg-card/50 p-5 hover:bg-card hover:shadow-lg transition-all duration-300">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary mb-3 group-hover:glow-primary transition-all">
                  <feature.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-sm mb-1">{feature.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
        {/* Mid-page CTA */}
        {!user && (
          <div className="text-center mt-10">
            <Button size="lg" className="glow-primary" asChild>
              <Link to={ROUTES.auth.cadastro}>Quero começar agora<ArrowRight className="h-4 w-4 ml-1.5" /></Link>
            </Button>
          </div>
        )}
      </section>

      {/* Testimonials */}
      <section className="container py-20 border-t">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">O que nossos clientes dizem</h2>
          <p className="text-muted-foreground">Afiliados reais, resultados reais.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
          {testimonials.map((t) => (
            <div key={t.name} className="rounded-xl border bg-card/50 p-5 space-y-3">
              <div className="flex gap-0.5">{[...Array(5)].map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-warning text-warning" />)}</div>
              <p className="text-sm text-muted-foreground leading-relaxed min-h-[80px]">"{t.text}"</p>
              <div><p className="text-sm font-medium">{t.name}</p></div>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison */}
      <section className="container py-20 border-t">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Por que usar o Auto Links?</h2>
          <p className="text-muted-foreground">Veja a diferença de operar com as ferramentas certas.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 max-w-3xl mx-auto">
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
            <h3 className="font-semibold text-destructive mb-4">Sem Auto Links</h3>
            <div className="space-y-3">
              {withoutAutoLinks.map((text) => (
                <div key={text} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <X className="h-4 w-4 text-destructive shrink-0 mt-0.5" />{text}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
            <h3 className="font-semibold text-primary mb-4">Com Auto Links</h3>
            <div className="space-y-3">
              {withAutoLinks.map((text) => (
                <div key={text} className="flex items-start gap-2 text-sm">
                  <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />{text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="container py-20 border-t">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Planos simples e transparentes</h2>
          <p className="text-muted-foreground">Comece grátis. Escale quando precisar.</p>
        </div>

        {/* Billing period toggle */}
        <div className="flex justify-center mb-10 flex-col items-center gap-4">
          <div className="inline-flex items-center rounded-full border bg-secondary/40 p-1 gap-1">
            <button
              type="button"
              onClick={() => setBillingPeriod("monthly")}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                billingPeriod === "monthly"
                  ? "bg-background shadow text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Mensal
            </button>
            <button
              type="button"
              onClick={() => setBillingPeriod("annual")}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all flex items-center gap-1.5 ${
                billingPeriod === "annual"
                  ? "bg-background shadow text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Anual
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">2 meses grátis 🔥</span>
            </button>
          </div>
          {billingPeriod === "annual" && (
            <div className="text-sm font-medium text-primary animate-in fade-in duration-300">
              💰 Economize até R$194 ao ano
            </div>
          )}
        </div>

        {publicPlans.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">Planos em breve. <Link to={ROUTES.auth.cadastro} className="underline text-primary">Crie sua conta grátis</Link> para ser o primeiro a saber.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 max-w-5xl mx-auto items-stretch justify-items-center">
            {publicPlans.map((plan) => (
              <div key={plan.id} className={`w-full rounded-xl border p-6 flex flex-col relative ${plan.highlight ? "border-primary bg-primary/5 shadow-xl" : "bg-card/50"}`}>
                {plan.highlight && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                      <Zap className="h-3 w-3" />Mais popular
                    </span>
                  </div>
                )}
                <div className="mb-5">
                  <h3 className="font-semibold text-base">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mt-3">
                    <span className="text-3xl font-extrabold">{plan.priceLabel}</span>
                    {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
                  </div>
                  {plan.monthlyEquivalentPrice != null && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      ≈ R${plan.monthlyEquivalentPrice.toFixed(2).replace(".", ",")}/mês — economize 17%
                    </p>
                  )}
                  {plan.description && <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{plan.description}</p>}
                </div>
                <ul className="space-y-2.5 flex-1 mb-6">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />{f}
                    </li>
                  ))}
                </ul>
                <Button className="w-full" variant={plan.highlight ? "default" : "outline"} asChild>
                  <Link to={ROUTES.auth.cadastro}>{plan.cta}</Link>
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* FAQ */}
      <section className="container py-20 border-t">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Perguntas Frequentes</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">
            Tudo que você precisa saber antes de começar. Não encontrou sua resposta? Fale com nosso suporte em{" "}
            <a href="mailto:suporte@autolinks.pro" className="underline underline-offset-2 hover:text-foreground transition-colors">
              suporte@autolinks.pro
            </a>
            .
          </p>
        </div>
        <div className="max-w-3xl mx-auto">
          <Accordion type="single" collapsible className="space-y-3">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`faq-${i}`} className="border rounded-xl px-5">
                <AccordionTrigger className="text-sm font-semibold text-left py-4">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground leading-relaxed pb-4">{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* CTA */}
      <section className="container py-20 border-t">
        <div className="text-center max-w-xl mx-auto space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Pronto para automatizar?</h2>
          <p className="text-muted-foreground">Junte-se a dezenas de afiliados que já estão escalando suas vendas com Auto Links.</p>
          {!isLoading && user ? (
            <Button size="lg" className="glow-primary" asChild><Link to={ROUTES.app.dashboard}><LayoutDashboard className="h-4 w-4 mr-1.5" />Acessar meu painel</Link></Button>
          ) : (
            <Button size="lg" className="glow-primary" asChild><Link to={ROUTES.auth.cadastro}>Começar agora, é grátis<ArrowRight className="h-4 w-4 ml-1.5" /></Link></Button>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-3"><Flame className="h-4 w-4 text-primary" /><span className="font-bold text-sm">Auto Links</span></div>
              <p className="text-xs text-muted-foreground leading-relaxed">Sistema Nº1 para afiliados Shopee e Mercado Livre</p>
            </div>
            <div>
              <h4 className="text-sm font-semibold mb-3">Produto</h4>
              <ul className="space-y-2 text-xs text-muted-foreground">
                <li><a href="#features" className="hover:text-foreground transition-colors">Funcionalidades</a></li>
                <li><a href="#pricing" className="hover:text-foreground transition-colors">Preços</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Roadmap</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold mb-3">Empresa</h4>
              <ul className="space-y-2 text-xs text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">Sobre</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Blog</a></li>
                <li><a href="mailto:suporte@autolinks.pro" className="hover:text-foreground transition-colors">Contato</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold mb-3">Suporte</h4>
              <ul className="space-y-2 text-xs text-muted-foreground">
                <li><a href="mailto:suporte@autolinks.pro" className="hover:text-foreground transition-colors">Central de Ajuda</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Termos de Uso</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Privacidade</a></li>
                <li><a href="mailto:suporte@autolinks.pro" className="hover:text-foreground transition-colors">suporte@autolinks.pro</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t pt-6 flex items-center justify-between text-xs text-muted-foreground">
            <span>© 2026 Auto Links. Todos os direitos reservados.</span>
            <div className="flex gap-4">
              <a href="#" className="hover:text-foreground transition-colors">Termos</a>
              <a href="#" className="hover:text-foreground transition-colors">Privacidade</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

