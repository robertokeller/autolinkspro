import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

export default function PoliticaPrivacidade() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="container flex h-14 items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to={ROUTES.home}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Voltar
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <img src="/brand/icon-64.png" alt="AutoLinks!" className="h-5 w-5 rounded object-contain" loading="lazy" />
            <span className="font-bold text-sm">AutoLinks!</span>
          </div>
        </div>
      </header>

      <main className="container max-w-3xl py-12 space-y-8">
        <h1 className="text-3xl font-bold tracking-tight">Política de Privacidade</h1>
        <p className="text-sm text-muted-foreground">Última atualização: 17 de março de 2026</p>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-6 text-muted-foreground leading-relaxed">
          <p>
            A AutoLinks apresenta esta Política de Privacidade com o objetivo de informar, de forma clara e acessível, como os dados pessoais são tratados no contexto da utilização de sua plataforma. Ao utilizar nossos serviços, você declara estar ciente das práticas descritas neste documento.
          </p>

          <Section title="1. Tratamento de dados pessoais">
            <p>
              A coleta e o uso de dados pessoais pela AutoLinks seguem os princípios da boa-fé, finalidade, necessidade, transparência e segurança, conforme estabelecido pela Lei Geral de Proteção de Dados Pessoais — LGPD (Lei nº 13.709/2018).
            </p>
          </Section>

          <Section title="2. Informações que podemos coletar">
            <p>
              Durante a sua interação com a plataforma, diferentes tipos de dados podem ser obtidos, incluindo:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Dados informados diretamente pelo usuário:</strong> como nome, endereço de e-mail, número de telefone, senha e informações profissionais, quando aplicável.</li>
              <li><strong>Dados relacionados a pagamentos:</strong> necessários para viabilizar cobranças, assinaturas ou compras, sendo que dados sensíveis financeiros são tratados por provedores especializados.</li>
              <li><strong>Dados de uso da plataforma:</strong> registros de atividades, interações, preferências e padrões de navegação.</li>
              <li><strong>Dados técnicos e de conexão:</strong> como endereço IP, tipo de dispositivo, sistema operacional, navegador e localização aproximada.</li>
            </ul>
          </Section>

          <Section title="3. Finalidades do uso dos dados">
            <p>As informações coletadas são utilizadas para:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Garantir o funcionamento adequado dos serviços oferecidos.</li>
              <li>Gerenciar contas, planos e pagamentos.</li>
              <li>Personalizar e aprimorar a experiência do usuário.</li>
              <li>Enviar comunicações relevantes, incluindo avisos operacionais e conteúdos promocionais (com possibilidade de cancelamento).</li>
              <li>Monitorar o uso da plataforma para fins de segurança e prevenção de fraudes.</li>
              <li>Atender exigências legais e regulatórias.</li>
            </ul>
          </Section>

          <Section title="4. Base legal para o tratamento">
            <p>
              O tratamento de dados pessoais é realizado com base nos fundamentos legais previstos no Art. 7º da LGPD, tais como:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Execução de contrato ou de procedimentos preliminares relacionados a contrato do qual seja parte o titular (Art. 7º, V).</li>
              <li>Cumprimento de obrigação legal ou regulatória pelo controlador (Art. 7º, II).</li>
              <li>Legítimo interesse do controlador, respeitados os direitos e liberdades fundamentais do titular (Art. 7º, IX).</li>
              <li>Consentimento do titular, quando necessário (Art. 7º, I).</li>
            </ul>
          </Section>

          <Section title="5. Compartilhamento de dados">
            <p>A AutoLinks poderá compartilhar informações pessoais nas seguintes situações:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Com prestadores de serviços essenciais ao funcionamento da plataforma, como infraestrutura tecnológica e meios de pagamento.</li>
              <li>Quando houver obrigação legal, determinação judicial ou requisição de autoridade competente.</li>
              <li>Com empresas relacionadas ou parceiras, respeitando os limites desta política.</li>
              <li>Em processos de reorganização empresarial, como fusão, aquisição ou incorporação.</li>
            </ul>
          </Section>

          <Section title="6. Armazenamento e medidas de segurança">
            <p>
              Os dados pessoais são armazenados em ambientes protegidos e controlados. A AutoLinks adota medidas técnicas e administrativas adequadas para reduzir riscos de acesso indevido, perda, alteração ou divulgação não autorizada, em conformidade com o Art. 46 da LGPD.
            </p>
          </Section>

          <Section title="7. Tempo de retenção">
            <p>
              As informações serão mantidas pelo período necessário para cumprir as finalidades descritas nesta política, bem como para atender obrigações legais ou regulatórias. Após esse prazo, os dados poderão ser eliminados ou anonimizados, conforme previsto no Art. 16 da LGPD.
            </p>
          </Section>

          <Section title="8. Direitos dos titulares">
            <p>
              Você poderá, a qualquer momento, exercer os direitos garantidos pelo Art. 18 da LGPD, incluindo:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Confirmação da existência de tratamento de dados.</li>
              <li>Acesso aos dados pessoais.</li>
              <li>Correção de informações incorretas, incompletas ou desatualizadas.</li>
              <li>Solicitação de anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a LGPD.</li>
              <li>Portabilidade dos dados a outro fornecedor de serviço, mediante requisição expressa.</li>
              <li>Eliminação dos dados tratados com base no consentimento, exceto nas hipóteses previstas no Art. 16 da LGPD.</li>
              <li>Informação sobre entidades públicas e privadas com as quais o controlador realizou uso compartilhado de dados.</li>
              <li>Informação sobre a possibilidade de não fornecer consentimento e sobre as consequências da negativa.</li>
              <li>Revogação do consentimento, nos termos do Art. 8º, § 5º, da LGPD.</li>
            </ul>
          </Section>

          <Section title="9. Transferência internacional de dados">
            <p>
              Caso os dados pessoais sejam transferidos para servidores localizados fora do Brasil, a AutoLinks garantirá que essa transferência ocorra em conformidade com o Art. 33 da LGPD, assegurando grau adequado de proteção de dados ou base legal apropriada.
            </p>
          </Section>

          <Section title="10. Alterações desta política">
            <p>
              A AutoLinks poderá atualizar este documento a qualquer momento. Caso haja mudanças relevantes, os usuários serão informados por meios adequados. Recomenda-se a consulta periódica desta política.
            </p>
          </Section>

          <Section title="11. Canal de contato e encarregado (DPO)">
            <p>
              Para exercer seus direitos, esclarecer dúvidas sobre esta Política de Privacidade ou entrar em contato com o Encarregado de Proteção de Dados (DPO), conforme previsto no Art. 41 da LGPD, utilize o e-mail:
            </p>
            <p className="font-medium text-foreground">
              suporte@autolinks.pro
            </p>
          </Section>
        </div>
      </main>

      <footer className="border-t py-6">
        <div className="container text-center text-xs text-muted-foreground">
          © 2026 AutoLinks!. Todos os direitos reservados.
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}
