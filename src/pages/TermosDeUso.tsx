import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ROUTES } from "@/lib/routes";

export default function TermosDeUso() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b sticky top-0 z-40 bg-background/80 backdrop-blur-md">
        <div className="container flex items-center gap-3 py-4">
          <Link
            to={ROUTES.home}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
          <span className="text-border">|</span>
          <div className="flex items-center gap-2">
            <img src="/brand/icon-64.png" alt="AutoLinks!" className="h-5 w-5 rounded object-contain" loading="lazy" />
            <span className="font-bold text-sm">AutoLinks!</span>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="container max-w-3xl py-12 pb-20">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Termos de Uso</h1>
        <p className="text-sm text-muted-foreground mb-10">
          Última atualização: março de 2026
        </p>

        <div className="space-y-10 text-sm leading-relaxed text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-3 [&_h3]:text-foreground [&_h3]:font-medium [&_h3]:mb-2">
          {/* 1 */}
          <section>
            <h2>1. Sobre a Plataforma</h2>
            <p>
              A AutoLinks é um serviço digital voltado a criadores de conteúdo, afiliados e empreendedores que desejam
              otimizar e automatizar a divulgação de produtos em ambientes online.
            </p>
            <p className="mt-2">
              A plataforma disponibiliza recursos como curadoria de ofertas, criação de conteúdos promocionais, geração
              automatizada de textos e imagens, além de ferramentas de agendamento e análise de desempenho.
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2>2. Concordância com os Termos</h2>
            <p>
              Ao acessar ou utilizar qualquer funcionalidade da AutoLinks, o usuário declara ter lido, compreendido e
              aceito integralmente este documento.
            </p>
            <p className="mt-2">
              Caso não concorde com quaisquer disposições aqui previstas, a utilização da plataforma não é recomendada.
            </p>
          </section>

          {/* 3 */}
          <section>
            <h2>3. Criação de Conta e Responsabilidades</h2>
            <p>
              Para acessar os serviços, é necessário realizar cadastro com informações verdadeiras, completas e
              atualizadas.
            </p>
            <p className="mt-3 font-medium text-foreground">O usuário é responsável por:</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>proteger seus dados de acesso;</li>
              <li>não compartilhar suas credenciais com terceiros;</li>
              <li>todas as atividades realizadas em sua conta.</li>
            </ul>
            <p className="mt-3">
              A AutoLinks não se responsabiliza por acessos indevidos decorrentes de negligência do usuário.
            </p>
          </section>

          {/* 4 */}
          <section>
            <h2>4. Planos e Condições de Assinatura</h2>
            <p>
              O acesso completo à plataforma é oferecido mediante contratação de planos pagos com duração determinada
              (30, 90, 180 ou 365 dias).
            </p>
            <p className="mt-2">
              A ativação ocorre após a confirmação do pagamento. Quando houver período de teste gratuito, este será
              automaticamente convertido em plano pago ao final do prazo, salvo cancelamento prévio.
            </p>
            <p className="mt-2">
              As assinaturas são renovadas automaticamente ao término do período contratado, utilizando o meio de
              pagamento registrado. O cancelamento deve ser feito antes da renovação para evitar nova cobrança.
            </p>
            <p className="mt-2">
              Em caso de falha no pagamento, o acesso poderá ser interrompido até a regularização.
            </p>
          </section>

          {/* 5 */}
          <section>
            <h2>5. Política de Cancelamento e Reembolso</h2>
            <p>
              A AutoLinks oferece garantia de satisfação de 7 (sete) dias corridos, válida exclusivamente para a
              primeira contratação do usuário.
            </p>

            <h3 className="mt-4">Condições:</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>o pedido deve ser realizado dentro do prazo de garantia;</li>
              <li>solicitações fora do prazo não serão aceitas;</li>
              <li>reativações ou novas assinaturas não possuem direito a reembolso.</li>
            </ul>

            <h3 className="mt-4">Regras de devolução:</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong className="text-foreground">Cartão de crédito:</strong> estorno realizado na mesma forma de
                pagamento, podendo levar alguns dias úteis para processamento pela operadora;
              </li>
              <li>
                <strong className="text-foreground">Boleto:</strong> reembolso via Pix em até 30 dias, sendo
                obrigatória a utilização do mesmo e-mail cadastrado como chave.
              </li>
            </ul>

            <p className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-foreground">
              <strong>Importante:</strong> cancelar a assinatura não equivale a solicitar reembolso — é necessário
              entrar em contato pelos canais de atendimento.
            </p>
          </section>

          {/* 6 */}
          <section>
            <h2>6. Uso Adequado da Plataforma</h2>
            <p>
              O usuário compromete-se a utilizar a AutoLinks em conformidade com a legislação vigente e com padrões
              éticos.
            </p>
            <p className="mt-3 font-medium text-foreground">É proibido:</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>utilizar a plataforma para fins ilícitos ou fraudulentos;</li>
              <li>violar direitos de terceiros;</li>
              <li>explorar indevidamente funcionalidades da plataforma.</li>
            </ul>
            <p className="mt-3">
              O descumprimento poderá resultar em suspensão ou encerramento da conta.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2>7. Propriedade Intelectual</h2>
            <p>
              Todos os elementos disponíveis na AutoLinks — incluindo software, identidade visual, conteúdos e
              funcionalidades — são protegidos por legislação de propriedade intelectual.
            </p>
            <p className="mt-2">
              Nenhum conteúdo poderá ser reproduzido, modificado ou distribuído sem autorização prévia e expressa.
            </p>
          </section>

          {/* 8 – LGPD */}
          <section>
            <h2>8. Proteção de Dados e Privacidade (LGPD)</h2>
            <p>
              A AutoLinks trata dados pessoais em conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº
              13.709/2018 — LGPD).
            </p>

            <h3 className="mt-4">Dados coletados:</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>informações cadastrais (nome, e-mail, telefone);</li>
              <li>dados de uso da plataforma (logs de acesso, funcionalidades utilizadas);</li>
              <li>informações de pagamento (processadas por intermediadores seguros — a AutoLinks não armazena dados de cartão).</li>
            </ul>

            <h3 className="mt-4">Bases legais e finalidades do tratamento:</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong className="text-foreground">Execução de contrato (art. 7º, V):</strong> viabilizar a prestação
                dos serviços contratados;
              </li>
              <li>
                <strong className="text-foreground">Legítimo interesse (art. 7º, IX):</strong> melhorar a experiência
                do usuário e aprimorar funcionalidades;
              </li>
              <li>
                <strong className="text-foreground">Cumprimento de obrigação legal (art. 7º, II):</strong> atender
                exigências legais e regulatórias aplicáveis.
              </li>
            </ul>

            <h3 className="mt-4">Direitos do titular dos dados (art. 18):</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>confirmação da existência de tratamento;</li>
              <li>acesso aos dados pessoais;</li>
              <li>correção de informações incompletas, inexatas ou desatualizadas;</li>
              <li>anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desconformidade;</li>
              <li>portabilidade dos dados a outro fornecedor de serviço;</li>
              <li>eliminação dos dados tratados com base no consentimento;</li>
              <li>informação sobre o compartilhamento de dados com terceiros;</li>
              <li>revogação do consentimento a qualquer tempo.</li>
            </ul>

            <h3 className="mt-4">Compartilhamento de dados:</h3>
            <p>
              A AutoLinks poderá compartilhar dados pessoais exclusivamente com prestadores de serviço essenciais ao
              funcionamento da plataforma (gateways de pagamento, serviços de e-mail e infraestrutura em nuvem),
              sempre mediante cláusulas contratuais de proteção de dados.
            </p>

            <h3 className="mt-4">Retenção e eliminação:</h3>
            <p>
              Os dados são mantidos pelo tempo necessário ao cumprimento das finalidades descritas ou enquanto houver
              obrigação legal de retenção. Após esse prazo, os dados serão eliminados de forma segura.
            </p>

            <h3 className="mt-4">Medidas de segurança:</h3>
            <p>
              A AutoLinks adota medidas técnicas e organizacionais adequadas para proteger os dados pessoais contra
              acessos não autorizados, vazamentos, perda ou uso indevido, incluindo criptografia em trânsito e em
              repouso, controles de acesso e monitoramento contínuo.
            </p>

            <p className="mt-4">
              Para exercer seus direitos como titular de dados, entre em contato pelo e-mail{" "}
              <a href="mailto:suporte@autolinks.pro" className="text-primary hover:underline">
                suporte@autolinks.pro
              </a>.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2>9. Limitação de Responsabilidade</h2>
            <p>
              A AutoLinks não garante resultados financeiros ou desempenho específico com o uso da plataforma.
            </p>
            <p className="mt-3 font-medium text-foreground">Também não se responsabiliza por:</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>perdas indiretas ou lucros cessantes;</li>
              <li>interrupções de serviço decorrentes de manutenções programadas ou emergenciais;</li>
              <li>falhas externas, como problemas em serviços de terceiros ou provedores de infraestrutura.</li>
            </ul>
          </section>

          {/* 10 */}
          <section>
            <h2>10. Atualizações destes Termos</h2>
            <p>
              Este documento poderá ser revisado periodicamente. Em caso de alterações relevantes, os usuários serão
              informados com antecedência razoável por meio da plataforma ou do e-mail cadastrado.
            </p>
            <p className="mt-2">
              A continuidade de uso após as mudanças será considerada como aceitação das novas condições.
            </p>
          </section>

          {/* 11 */}
          <section>
            <h2>11. Legislação Aplicável</h2>
            <p>
              Este Termo será interpretado de acordo com as leis da República Federativa do Brasil. Eventuais
              controvérsias serão resolvidas no foro do domicílio do usuário, conforme disposto no art. 101, I, do
              Código de Defesa do Consumidor.
            </p>
          </section>

          {/* 12 */}
          <section>
            <h2>12. Canais de Atendimento</h2>
            <p>
              Em caso de dúvidas, solicitações ou exercício de direitos relacionados aos seus dados pessoais, entre em
              contato:
            </p>
            <p className="mt-3 rounded-md border bg-card px-4 py-3 text-foreground">
              E-mail:{" "}
              <a href="mailto:suporte@autolinks.pro" className="text-primary hover:underline">
                suporte@autolinks.pro
              </a>
            </p>
          </section>
        </div>
      </main>

      {/* Mini-footer */}
      <footer className="border-t py-6">
        <div className="container flex items-center justify-between text-xs text-muted-foreground">
          <span>© 2026 AutoLinks!. Todos os direitos reservados.</span>
          <Link to={ROUTES.home} className="hover:text-foreground transition-colors">
            Voltar ao início
          </Link>
        </div>
      </footer>
    </div>
  );
}
