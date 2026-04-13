import { ComponentType, Dispatch, SetStateAction } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
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

export type BillingPeriod = "monthly" | "quarterly" | "semiannual" | "annual";

export interface LandingPlanCard {
  id: string;
  name: string;
  priceLabel: string;
  period?: string | null;
  monthlyEquivalentPrice?: number | null;
  description?: string | null;
  features: string[];
  cta: string;
  /** External checkout URL (e.g. Kiwify). When set, the CTA links here instead of the signup page. */
  ctaHref?: string;
  /** Internal route CTA (e.g. /account). Used when no external checkout URL is available. */
  ctaTo?: string;
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
  { icon: WhatsAppIcon, title: "Gestão Unificada de Canais", description: "Controle seu WhatsApp e Telegram na mesma tela. Acabe com a confusão de dispositivos e abas abertas de vez." },
  { icon: Zap, title: "Conversor Universal Seguro", description: "Mude links comuns da Amazon, Shopee e Mercado Livre para afiliados em poucos segundos. O seu cookie estará rastreado." },
  { icon: Clock, title: "Agendamento Inteligente", description: "Seu tempo vale dinheiro e saúde mental. Programe campanhas de forma antecipada para manter constância postando de hora em hora." },
  { icon: Route, title: "Rotas Práticas", description: "O Auto Links repassa ofertas automaticamente de um grupo principal para vários outros. Chega de copiar e colar a toda hora." },
  { icon: ShoppingBag, title: "Filtro de Desempenho", description: "Determine comissões mínimas para a operação automática ou ignore lojistas ruins, assim o algoritmo trabalha com o que de fato gera ROI." },
  { icon: BarChart3, title: "Métricas Diretas", description: "Veja com facilidade num painel limpo as postagens, links gerados e canais integrados para atuar nas pendências certas da sua empresa." }
];

const testimonials = [
  { name: "Lucas Ferreira", text: "Cara, fiquei bem mais tranquilo. Conseguir centralizar minhas divulgações de Amazon e Mercado Livre com a segurança do cookie correto me devolveu paz." },
  { name: "Tayná Oliveira", text: "Antes eu perdia meus sábados correndo feito louca no Telegram pra postar ofertas a noite. Com as Rotas eu deixo pronto. Foi a melhor coisa." },
  { name: "Pedro Henrique", text: "O negócio impressionante é a clareza do sistema. Chegava a errar os meus cupons copiando e colando nos contatos, com os conversores o risco foi a zero." },
];

const withoutAutoLinks = [
  "Copia e cola as ofertas exaustivamente na mão",
  "Não pode tirar os olhos do celular senão não vende",
  "Demora muito tempo criando uma oferta bonita com links",
  "Usa Telegram e WhatsApp juntos e sem padrão",
  "O link quebra, a rotina não para, e sua comissão morre",
  "Administra 3 grupos estressado ao invés de lucrar e delegar"
];

const withAutoLinks = [
  "Muito mais vendas com as mãos livres o dia inteiro",
  "Seu robô de vendas acorda no fim de semana pra trabalhar",
  "O único painel em que WhatsApp e Telegram conversam",
  "Rotas limpam perfeitamente as poluições de link que vem de fábrica",
  "Agendamentos diários. Trabalha pra você postar com consistência",
  "Gerenciar 20 grupos torna-se tranquilo como se fosse apenas 1"
];

const faqs = [
  {
    q: "O Auto Links funciona para quais varejistas?",
    a: "Atualmente atuamos facilitando pra quem é afiliado ativo na Amazon, Shopee e Mercado Livre. O sistema garante que seus identificadores entrem corretamente quando o link for convertido para o seu público."
  },
  {
    q: "Como o Auto Links lida com grupos de WhatsApp e Telegram?",
    a: "Uma das coisas que nossos clientes mais gostam é organizar isso! Você tem as duas mensagerias juntas rodando num só painel seguro e claro. Nada de perder canais em abas ou precisar de celulares secundários quentes."
  },
  {
    q: "O que seriam as famosas Rotas Práticas?",
    a: "Você não vai mais repetir trabalhos. Um canal 'Líder' ou 'Mestre' pode servir de espelho para as ferramentas repassarem suas mensagens aos demais canais. Recebeu ali? O Auto Links duplica pro resto da sua carteira perfeitamente."
  },
  {
    q: "Preciso baixar algo estranho pro sistema rodar?",
    a: "Zero! O Auto Links opera 100% na nuvem, você só faz login como faria na Netflix. Como as integrações são em alto nível, não precisa deixar pc ligado se agendar a campanha corretamente."
  },
  {
    q: "Sou afiliado que trabalha do celular, dá pra navegar à vontade pelo aparelho?",
    a: "Total. Nossas telas foram projetadas com um carinho ímpar para quem não tem computador e opera pelo touch do celular na maioria dos dias. Telas fluidas e organizadas pra qualquer modelo."
  },
  {
    q: "O sistema me prende com multas altas pra cancelar?",
    a: "Que nada, ninguém segura gente boa pela força. Os planos Mensal, Trimestral, Semestral e Anual ficam à sua disposição e você desativa sua renovação a qualquer instante sozinho através da aba 'Assinaturas'."
  }
];

export function LandingHeader({ isAuthenticated, isLoading }: LandingHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl">
      <div className="container flex h-14 items-center justify-between">
        <Link to={ROUTES.home} className="flex items-center gap-2">
          <img src="/brand/icon-64.png" alt="AutoLinks!" className="h-7 w-7 rounded-lg object-contain" loading="lazy" />
          <span className="font-bold text-sm">AutoLinks!</span>
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
          Conforto e Escala de verdade para você focar no que importa
        </div>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.1]">
          Automatize seus disparos e <span className="text-gradient">multiplique comissões</span> sem sacrificar seu tempo livre.
        </h1>
        <div className="flex items-center justify-center gap-4 flex-wrap text-xs font-medium text-muted-foreground pt-2">
          <div className="flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /><span>Não perca comissões</span></div>
          <div className="w-1 h-1 rounded-full bg-border" />
          <div className="flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /><span>Operação escalável</span></div>
        </div>
        <p className="text-lg text-muted-foreground max-w-xl mx-auto pt-4">
          O parceiro dos afiliados profissionais que não perdem tempo. Interaja com Amazon, Mercado Livre e Shopee sem falhas.
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
          
        </div>
      </motion.div>
    </section>
  );
}

export function LandingFeaturesSection({ isAuthenticated }: AuthAwareSectionProps) {
  return (
    <section id="features" className="container py-20 border-t">
      <motion.div {...fadeUp} className="text-center mb-12">
        <h2 className="text-3xl font-bold tracking-tight mb-3">O Lucro dos Benefícios Indiretos</h2>
        <p className="text-muted-foreground max-w-lg mx-auto">Não é só velocidade. Tudo foi preparado para que você compre de volta o seu tempo e lucre com segurança.</p>
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
        <h2 className="text-3xl font-bold tracking-tight mb-3">A Prova de quem já Escala</h2>
        <p className="text-muted-foreground">Um ecossistema de sucesso validado por Afiliados reais que mudaram de nível.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
        {testimonials.map((testimonial) => (
          <div key={testimonial.name} className="rounded-xl border bg-card/50 p-6 space-y-4 text-left">
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
        <h2 className="text-3xl font-bold tracking-tight mb-3">Afiliado Amador vs. Afiliado AutoLinks</h2>
        <p className="text-muted-foreground">Entenda por que o afiliado manual está sendo engolido por quem sabe automatizar a venda.</p>
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
        <div className="inline-flex items-center rounded-full border bg-secondary/40 p-1 gap-1 flex-wrap justify-center">
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
            onClick={() => setBillingPeriod("quarterly")}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              billingPeriod === "quarterly" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Trimestral
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod("semiannual")}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all flex items-center gap-1.5 ${
              billingPeriod === "semiannual" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Semestral
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[0.6rem] font-bold text-primary">-15%</span>
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod("annual")}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all flex items-center gap-1.5 ${
              billingPeriod === "annual" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Anual
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[0.6rem] font-bold text-primary">-20%</span>
          </button>
        </div>
        {(billingPeriod === "annual" || billingPeriod === "semiannual") && (
          <div className="text-sm font-medium text-primary animate-in fade-in duration-300">
            {billingPeriod === "annual" ? "Economize até R$194 ao ano" : "Economize até R$130 no semestre"}
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
                {plan.ctaHref
                  ? <a href={plan.ctaHref} target="_blank" rel="noopener noreferrer">{plan.cta}</a>
                  : plan.ctaTo
                    ? <Link to={plan.ctaTo}>{plan.cta}</Link>
                    : <Link to={ROUTES.auth.cadastro}>{plan.cta}</Link>}
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
