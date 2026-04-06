import { ComponentType, Dispatch, SetStateAction } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Clock,
  LayoutDashboard,
  Route,
  ShoppingBag,
  ShoppingCart,
  Star,
  Users,
  X,
  Zap,
} from "lucide-react";
import { ROUTES } from "@/lib/routes";
import { WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";

type IconComponent = ComponentType<{ className?: string }>;

export type BillingPeriod = "monthly" | "annual";

export interface LandingPlanCard {
  id: string;
  name: string;
  priceLabel: string;
  period?: string | null;
  monthlyEquivalentPrice?: number | null;
  description?: string | null;
  features: string[];
  cta: string;
  highlight: boolean;
}

interface AuthAwareSectionProps {
  isAuthenticated: boolean;
}

interface LandingHeaderProps extends AuthAwareSectionProps {
  isLoading: boolean;
}

interface LandingPricingSectionProps {
  billingPeriod: BillingPeriod;
  publicPlans: LandingPlanCard[];
  setBillingPeriod: Dispatch<SetStateAction<BillingPeriod>>;
}

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5 },
};

const landingFeatures: Array<{ icon: IconComponent; title: string; description: string }> = [
  { icon: WhatsAppIcon, title: "WhatsApp & Telegram juntos", description: "Conecte várias contas ao mesmo tempo e controle tudo num lugar só." },
  { icon: ShoppingBag, title: "Shopee", description: "Filtre só as melhores comissões e deixe o sistema enviar sozinho." },
  { icon: ShoppingCart, title: "Mercado Livre", description: "Converta ofertas do Mercado Livre em poucos cliques, sem complicação." },
  { icon: Users, title: "Grupos mestres", description: "Organize seus grupos num só lugar e o sistema cuida do resto." },
  { icon: Clock, title: "Agendamentos", description: "Programe suas mensagens para qualquer horário e esqueça." },
  { icon: Route, title: "Rotas automáticas", description: "Copie as ofertas dos maiores afiliados no automático, sem mexer um dedo." },
];

const testimonials = [
  { name: "Lucas Ferreira", text: "Mano, depois que eu ajustei o filtro de comissão para só enviar oferta acima de 15%, eu comecei a lucrar bem mais com os mesmos grupos que eu já tinha." },
  { name: "Tayná Oliveira", text: "Na real, depois que automatizei as rotas ficou bem mais leve. Hoje eu faço uma conferência 1 vez por semana e deixo rodando no automático o resto dos dias." },
  { name: "Pedro Henrique", text: "Eu pagava bem mais caro em outras ferramentas e não tinha metade do que tem aqui. As automações fazem quase tudo sozinhas e as rotas para copiar estratégia de concorrente ajudam demais." },
];

const withoutAutoLinks = [
  "Posta ofertas na mão, uma por uma, o dia inteiro",
  "Perde promoção boa porque não viu a tempo",
  "WhatsApp e Telegram separados, sem controle",
  "Grupos param quando você dorme ou sai",
  "Não sabe o que os maiores afiliados estão divulgando",
  "Gera link de afiliado na mão, um por um",
];

const withAutoLinks = [
  "Zero trabalho - as rotas postam 24h por dia sozinhas",
  "Ofertas capturadas em segundos das fontes que você escolhe",
  "WhatsApp e Telegram num painel só",
  "Seus grupos vendem mesmo enquanto você dorme",
  "Você vê o que os concorrentes estão postando em tempo real",
  "Link de afiliado gerado e enviado sozinho ao detectar a oferta",
];

const faqs = [
  {
    q: "Preciso ficar online para as automações funcionarem?",
    a: "Não. Depois que você configura as rotas e automações, o sistema opera de forma completamente independente. O Auto Links roda 24 horas por dia, 7 dias por semana - enquanto você dorme, viaja ou cuida de outro trabalho, ele continua monitorando fontes, gerando links com seu cookie de afiliado e disparando ofertas nos seus grupos sem nenhuma intervenção sua.",
  },
  {
    q: "Como funciona o monitoramento de rotas inteligentes?",
    a: "Você cadastra quais fontes quer monitorar e define os grupos de destino. O Auto Links rastreia cada oferta publicada em tempo real, captura o link do produto, processa com seu cookie de afiliado e dispara automaticamente nos grupos configurados. Tudo em segundos, sem você precisar copiar, colar ou confirmar nada.",
  },
  {
    q: "Consigo usar WhatsApp e Telegram ao mesmo tempo?",
    a: "Sim. O Auto Links suporta múltiplas sessões de WhatsApp e Telegram em paralelo, tudo num único painel. Você gerencia os dois canais de forma integrada, define regras específicas por plataforma e acompanha o status de cada sessão em tempo real - sem precisar abrir apps separados ou alternar entre ferramentas diferentes.",
  },
  {
    q: "Corro risco de ter minha conta banida?",
    a: "O sistema conta com proteções nativas: delays inteligentes entre envios consecutivos, templates de mensagem rotativos para evitar padrão repetitivo, sistema de filas para não sobrecarregar sessões e pausas automáticas quando o limiar de segurança é atingido. Seguindo as configurações recomendadas no painel, o risco é muito baixo.",
  },
  {
    q: "Posso definir horários exatos para as automações dispararem?",
    a: "Sim. O módulo de agendamento permite configurar janelas horárias precisas para cada automação - dias da semana, horário de início e de fim. O sistema respeita esses limites automaticamente, ideal para atingir seus grupos no momento de maior engajamento e para não enviar ofertas fora de hora, o que reduz o desengajamento dos membros.",
  },
  {
    q: "Como funciona o conversor de links da Shopee e do Mercado Livre?",
    a: "Basta colar o link de qualquer produto. O sistema detecta automaticamente a plataforma, gera o URL com seu cookie de afiliado e entrega o link pronto para divulgar - sem trabalho manual. No caso da Shopee, ele também remove parâmetros que prejudicam o rastreamento da comissão, garantindo que cada clique seja corretamente atribuído a você.",
  },
  {
    q: "É difícil de configurar para quem está começando?",
    a: "Não. O painel foi desenhado para ser simples e direto: você conecta sua primeira sessão WhatsApp via QR Code, configura uma rota em menos de 5 minutos e o sistema já começa a trabalhar por você. Não é necessário nenhum conhecimento técnico - tudo é visual e guiado. E se tiver alguma dúvida, o suporte está disponível para ajudar você a dar o primeiro passo.",
  },
  {
    q: "Posso cancelar a qualquer momento sem multa?",
    a: "Sim. Todos os planos são sem fidelidade e sem qualquer taxa de cancelamento. Você pode assinar no modelo mensal ou anual - o plano anual oferece 2 meses grátis e é cobrado de uma vez, mas sem multa de saída. Você pode fazer upgrade, downgrade ou cancelar quando quiser, diretamente no painel, sem precisar falar com ninguém. Sem burocracia, sem prazo mínimo, sem letra miúda.",
  },
];

export function LandingHeader({ isAuthenticated, isLoading }: LandingHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl">
      <div className="container flex h-14 items-center justify-between">
        <Link to={ROUTES.home} className="flex items-center gap-2">
          <img src="/brand/icon-64.png" alt="Auto Links" className="h-7 w-7 rounded-lg object-contain" loading="lazy" />
          <span className="font-bold text-sm">Auto Links</span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {!isLoading && isAuthenticated ? (
            <Button size="sm" asChild>
              <Link to={ROUTES.app.dashboard}>
                <LayoutDashboard className="h-4 w-4 mr-1.5" />
                Ir para dashboard
              </Link>
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" asChild><Link to={ROUTES.auth.login}>Login</Link></Button>
              <Button size="sm" asChild><Link to={ROUTES.auth.cadastro}>Começar grátis</Link></Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function LandingHero({ isAuthenticated }: AuthAwareSectionProps) {
  return (
    <section className="container py-20 md:py-32 text-center">
      <motion.div {...fadeUp} className="max-w-3xl mx-auto space-y-6">
        <div className="inline-flex items-center gap-1.5 rounded-full border bg-secondary/50 px-3 py-1 text-xs font-medium text-muted-foreground">
          <img src="/brand/logo-chama-64.png" alt="" className="h-3 w-3 object-contain" loading="lazy" />
          Sistema Nº1 para afiliados Shopee e Mercado Livre
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
          {isAuthenticated ? (
            <Button size="lg" className="glow-primary" asChild>
              <Link to={ROUTES.app.dashboard}>
                <LayoutDashboard className="h-4 w-4 mr-1.5" />
                Ir para dashboard
              </Link>
            </Button>
          ) : (
            <Button size="lg" className="glow-primary" asChild>
              <Link to={ROUTES.auth.cadastro}>
                Começar grátis
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </Link>
            </Button>
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
  );
}

export function LandingFeaturesSection({ isAuthenticated }: AuthAwareSectionProps) {
  return (
    <section id="features" className="container py-20 border-t">
      <motion.div {...fadeUp} className="text-center mb-12">
        <h2 className="text-3xl font-bold tracking-tight mb-3">Tudo que você precisa, em um só lugar</h2>
        <p className="text-muted-foreground max-w-lg mx-auto">Ferramentas profissionais para afiliados que querem escalar suas operações.</p>
      </motion.div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
        {landingFeatures.map((feature, i) => (
          <motion.div
            key={feature.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.08 }}
            className="group h-full rounded-xl border bg-card/50 p-5 hover:bg-card hover:shadow-lg transition-all duration-300"
          >
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
      {!isAuthenticated && (
        <div className="text-center mt-10">
          <Button size="lg" className="glow-primary" asChild>
            <Link to={ROUTES.auth.cadastro}>
              Quero começar agora
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}

export function LandingTestimonialsSection() {
  return (
    <section className="container py-20 border-t">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold tracking-tight mb-3">O que nossos clientes dizem</h2>
        <p className="text-muted-foreground">Afiliados reais, resultados reais.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
        {testimonials.map((testimonial) => (
          <div key={testimonial.name} className="rounded-xl border bg-card/50 p-5 space-y-3">
            <div className="flex gap-0.5">{[...Array(5)].map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-warning text-warning" />)}</div>
            <p className="text-sm text-muted-foreground leading-relaxed min-h-[80px]">"{testimonial.text}"</p>
            <div><p className="text-sm font-medium">{testimonial.name}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function LandingComparisonSection() {
  return (
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
                <X className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                {text}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
          <h3 className="font-semibold text-primary mb-4">Com Auto Links</h3>
          <div className="space-y-3">
            {withAutoLinks.map((text) => (
              <div key={text} className="flex items-start gap-2 text-sm">
                <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function LandingPricingSection({ billingPeriod, publicPlans, setBillingPeriod }: LandingPricingSectionProps) {
  return (
    <section id="pricing" className="container py-20 border-t">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold tracking-tight mb-3">Planos simples e transparentes</h2>
        <p className="text-muted-foreground">Comece grátis. Escale quando precisar.</p>
      </div>

      <div className="flex justify-center mb-10 flex-col items-center gap-4">
        <div className="inline-flex items-center rounded-full border bg-secondary/40 p-1 gap-1">
          <button
            type="button"
            onClick={() => setBillingPeriod("monthly")}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              billingPeriod === "monthly" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Mensal
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod("annual")}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all flex items-center gap-1.5 ${
              billingPeriod === "annual" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Anual
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">2 meses grátis</span>
          </button>
        </div>
        {billingPeriod === "annual" && (
          <div className="text-sm font-medium text-primary animate-in fade-in duration-300">
            Economize até R$194 ao ano
          </div>
        )}
      </div>

      {publicPlans.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">
            Planos em breve. <Link to={ROUTES.auth.cadastro} className="underline text-primary">Crie sua conta grátis</Link> para ser o primeiro a saber.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 max-w-5xl mx-auto items-stretch justify-items-center">
          {publicPlans.map((plan) => (
            <div key={plan.id} className={`w-full rounded-xl border p-6 flex flex-col relative ${plan.highlight ? "border-primary bg-primary/5 shadow-xl" : "bg-card/50"}`}>
              {plan.highlight && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                    <Zap className="h-3 w-3" />
                    Mais popular
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
                    ≈ R${plan.monthlyEquivalentPrice.toFixed(2).replace(".", ",")}/mês - economize 17%
                  </p>
                )}
                {plan.description && <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{plan.description}</p>}
              </div>
              <ul className="space-y-2.5 flex-1 mb-6">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                    {feature}
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
  );
}

export function LandingFaqSection() {
  return (
    <section className="container py-20 border-t">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold tracking-tight mb-3">Perguntas Frequentes</h2>
        <p className="text-muted-foreground max-w-lg mx-auto">
          Tudo que você precisa saber antes de começar. Não encontrou sua resposta? Fale com nosso suporte em{" "}
          <a href="mailto:suporte@autolinks.pro" className="underline underline-offset-2 hover:text-foreground transition-colors">
            suporte@autolinks.pro
          </a>.
        </p>
      </div>
      <div className="max-w-3xl mx-auto">
        <Accordion type="single" collapsible className="space-y-3">
          {faqs.map((faq, index) => (
            <AccordionItem key={faq.q} value={`faq-${index}`} className="border rounded-xl px-5">
              <AccordionTrigger className="text-sm font-semibold text-left py-4">{faq.q}</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground leading-relaxed pb-4">{faq.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

export function LandingCtaSection({ isAuthenticated }: AuthAwareSectionProps) {
  return (
    <section className="container py-20 border-t">
      <div className="text-center max-w-xl mx-auto space-y-4">
        <h2 className="text-3xl font-bold tracking-tight">Pronto para automatizar?</h2>
        <p className="text-muted-foreground">Junte-se a dezenas de afiliados que já estão escalando suas vendas com Auto Links.</p>
        {isAuthenticated ? (
          <Button size="lg" className="glow-primary" asChild>
            <Link to={ROUTES.app.dashboard}>
              <LayoutDashboard className="h-4 w-4 mr-1.5" />
              Acessar meu painel
            </Link>
          </Button>
        ) : (
          <Button size="lg" className="glow-primary" asChild>
            <Link to={ROUTES.auth.cadastro}>
              Começar agora, é grátis
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t py-8">
      <div className="container">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <img src="/brand/icon-64.png" alt="Auto Links" className="h-4 w-4 rounded object-contain" loading="lazy" />
            <span className="font-semibold text-foreground">Auto Links</span>
            <span className="hidden sm:inline">·</span>
            <span>© 2026 Todos os direitos reservados.</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="mailto:suporte@autolinks.pro" className="hover:text-foreground transition-colors">suporte@autolinks.pro</a>
            <span>·</span>
            <Link to={ROUTES.termos} className="hover:text-foreground transition-colors">Termos de Uso</Link>
            <span>·</span>
            <Link to={ROUTES.privacidade} className="hover:text-foreground transition-colors">Privacidade</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
