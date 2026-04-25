import {
  ArrowRight,
  BadgeDollarSign,
  Calculator,
  ExternalLink,
  Handshake,
  Infinity as InfinityIcon,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

export default function Afiliado() {
  const handleClick = () => {
    window.open('https://dashboard.kiwify.com/join/affiliate/n3gJoreU', '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="ds-page space-y-12 pb-24 animate-in fade-in duration-500">
      <PageHeader
        title="Programa de afiliados"
        description="Indique o AutoLinks e receba comissão recorrente em cada renovação ativa."
      />
      
      {/* Hero Section */}
      <div className="mx-auto max-w-3xl space-y-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-bold tracking-wide text-primary">
          <Handshake className="h-4 w-4" />
          Parceria oficial AutoLinks
        </div>
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-foreground leading-tight">
          Transforme cada indicação em um pagamento <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-orange-400">que entra todos os meses.</span>
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">
          Vender produtos com comissão única é desgastante. Torne-se parceiro de um software que empresas usam todos os dias para vender. Você indica uma vez, e nós dividimos os lucros com você para sempre.
        </p>
        <div className="pt-4">
          <Button 
            size="default"
            className="h-11 gap-2.5 rounded-full bg-primary px-7 text-sm text-primary-foreground shadow-lg transition-transform hover:-translate-y-0.5 hover:bg-primary/90 sm:text-base"
            onClick={handleClick}
          >
            Liberar meu link de parceiro
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* The Core Argument - Why it works */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="glass rounded-2xl p-8 shadow-sm transition-colors hover:border-primary/50">
          <div className="h-12 w-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
            <InfinityIcon className="h-6 w-6 text-primary" />
          </div>
          <h3 className="mb-3 text-xl font-bold">Ganhe em todos os planos</h3>
          <p className="text-muted-foreground leading-relaxed">
            Nossos clientes podem assinar pacotes mensais, trimestrais ou até semestrais. Você recebe 40% de comissão, independentemente do período escolhido. Em todas as renovações, você recebe comissão sobre os planos, para sempre.
          </p>
        </div>

        <div className="glass rounded-2xl p-8 shadow-sm transition-colors hover:border-primary/50">
          <div className="h-12 w-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <h3 className="mb-3 text-xl font-bold">Produto essencial (alta retenção)</h3>
          <p className="text-muted-foreground leading-relaxed">
            Diferentemente de cursos, que muitas pessoas abandonam, o AutoLinks é infraestrutura. Quando uma empresa automatiza as vendas com a ferramenta, ela não cancela.
          </p>
        </div>

        <div className="glass rounded-2xl p-8 shadow-sm transition-colors hover:border-primary/50">
          <div className="h-12 w-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
            <BadgeDollarSign className="h-6 w-6 text-primary" />
          </div>
          <h3 className="mb-3 text-xl font-bold">Venda indireta</h3>
          <p className="text-muted-foreground leading-relaxed">
            Você não precisa convencer ninguém a comprar. Basta mostrar como o AutoLinks está ajudando você a economizar tempo, e as pessoas naturalmente pedirão seu link de acesso.
          </p>
        </div>
      </div>

      {/* The Math - Visual Proof */}
      <div className="bg-muted/40 border border-border/60 rounded-3xl p-8 md:p-12 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -z-10" />
        
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 text-primary font-semibold">
              <Calculator className="h-5 w-5" />
              A matemática da recorrência
            </div>
            <h2 className="text-3xl font-bold text-foreground">Como o seu esforço se multiplica com o tempo</h2>
            <p className="text-muted-foreground text-lg leading-relaxed">
              Vamos fazer uma simulação realista. Imagine que você comece a compartilhar seu link e faça apenas uma venda por dia de assinatura (considerando um plano representativo com comissão líquida de ~R$ 38,80).
            </p>
            <p className="text-muted-foreground text-lg leading-relaxed">
              No final do mês, você não recebe apenas o valor daquele período. No mês seguinte, você já começa com essa mesma quantia <strong>garantida</strong>, vinda dos clientes antigos, somada às novas vendas.
            </p>
          </div>

          <div className="bg-card border shadow-lg rounded-2xl p-6 md:p-8 space-y-6">
            <h3 className="font-semibold text-center text-muted-foreground uppercase tracking-wider text-sm mb-4">
              Simulação acumulativa
            </h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-xl border border-border/50 bg-background/50">
                <div className="space-y-1">
                  <p className="font-medium">Ao atingir 10 clientes</p>
                  <p className="text-xs text-muted-foreground">Equivale ao custo de uma ida à pizzaria</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg">R$ 388,00</p>
                  <p className="text-xs text-muted-foreground">/ todo mês</p>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl border border-border/50 bg-background/50">
                <div className="space-y-1">
                  <p className="font-medium">Ao atingir 50 clientes</p>
                  <p className="text-xs text-muted-foreground">Cobre as contas básicas da casa</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg">R$ 1.940,00</p>
                  <p className="text-xs text-muted-foreground">/ todo mês</p>
                </div>
              </div>

              <div className="flex items-center justify-between p-5 rounded-xl border-2 border-primary/50 bg-primary/5 relative shadow-[0_0_20px_-5px_rgba(var(--primary),0.3)]">
                <div className="absolute -right-1.5 -top-1.5">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-success"></span>
                  </span>
                </div>
                <div className="space-y-1">
                  <p className="font-bold text-primary">Ao atingir 100 clientes</p>
                  <p className="text-xs text-primary/80 font-medium">Representa um salário-base sólido</p>
                </div>
                <div className="text-right text-primary">
                  <p className="font-extrabold text-2xl">R$ 3.880,00+</p>
                  <p className="text-xs font-medium uppercase tracking-wider">Por mês</p>
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-muted-foreground mt-4">
              *Valores projetados baseados em estimativas médias. Comissionamento ocorre automaticamente via checkout da Kiwify.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="max-w-2xl mx-auto text-center space-y-8 pt-8">
        <h2 className="text-2xl font-bold">O mercado já está aderindo. Você quer ser o parceiro que recebe a comissão ou o espectador?</h2>
        <p className="text-muted-foreground">
          O processo de afiliação é gratuito, não tem burocracia e leva menos de um minuto. Assim que for aprovado pelo sistema da Kiwify, você já pode começar a distribuir seu link e ver os resultados.
        </p>
        
        <Button 
          size="default"
          className="mx-auto flex h-11 gap-2.5 rounded-full bg-primary px-7 text-sm text-primary-foreground shadow-lg transition-transform hover:-translate-y-0.5 hover:bg-primary/90 sm:text-base"
          onClick={handleClick}
        >
          Tornar-se parceiro agora
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>

    </div>
  );
}
