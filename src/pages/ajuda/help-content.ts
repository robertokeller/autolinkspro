export type HelpCategory = {
  id: string;
  title: string;
  description: string;
  icon: string;
  items: HelpItem[];
};

export type HelpItem = {
  id: string;
  question: string;
  answer: string;
};

export type HelpArticle = {
  id: string;
  title: string;
  summary: string;
  category: string;
  icon: string;
  steps: string[];
};

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: "getting-started",
    title: "Primeiros Passos e Planos",
    description: "Configurações iniciais e informações de limites.",
    icon: "Rocket",
    items: [
      {
        id: "start",
        question: "Como começar a usar o sistema?",
        answer:
          "Acesse a aba 'Conexões' para vincular pelo menos um número de WhatsApp ou Telegram. Depois, vá até o seu marketplace de preferência (Mercado Livre, Shopee ou Amazon) para ativar as verificações e mapear seus links.",
      },
      {
        id: "limits",
        question: "Quais são os limites de cada plano?",
        answer:
          "Os limites variam pelo tipo de pacote contratado, refletindo na quantidade de instâncias conectadas e velocidade das automações (como cronjobs). Se notar retenção de envios, consulte 'Configurações > Minha Conta' para ver o uso atual.",
      },
    ],
  },
  {
    id: "connections",
    title: "Conexões (WhatsApp & Telegram)",
    description: "Configurando seus canais de mensagens.",
    icon: "Link2",
    items: [
      {
        id: "connect-wa-tg",
        question: "Como conectar o WhatsApp/Telegram?",
        answer:
          "Basta acessar 'Conexões > WhatsApp/Telegram', clicar em 'Adicionar' e escanear o QR Code gerado na tela através do seu aplicativo do celular (dispositivos vinculados). A conexão deve permanecer verde (Online) no painel.",
      },
      {
        id: "disconnect",
        question: "O que fazer quando uma conta desconecta?",
        answer:
          "Desconexões podem ocorrer devido a atualizações do WhatsApp ou falta de internet no seu celular na hora da sincronização. Remova a conexão atual no painel e escaneie o QR Code novamente.",
      },
    ],
  },
  {
    id: "integrations",
    title: "Integrações",
    description: "Mercado Livre, Shopee e Amazon.",
    icon: "ShoppingCart",
    items: [
      {
        id: "use-integrations",
        question: "Como usar Mercado Livre/Shopee/Amazon dentro do sistema?",
        answer:
          "Cada integração possui sua aba dedicada no painel lateral. Nas configurações de cada uma, você fará login em suas contas ou gerará os templates para interagir automaticamente nas compras e vendas.",
      },
      {
        id: "status-check",
        question: "Como verificar se uma integração está funcionando?",
        answer:
          "Navegue para a página do Marketplace correspondente (ex: Shopee) e observe o status das suas credenciais no topo da tela. Sinais de aviso (Warning) significam que relogar é necessário.",
      },
    ],
  },
  {
    id: "automations",
    title: "Rotas e Automações",
    description: "Dúvidas sobre funcionamento e regras.",
    icon: "Bot",
    items: [
      {
        id: "automation-works",
        question: "Como funcionam as automações?",
        answer:
          "As automações agem em gatilhos específicos das lojas, processando o fluxo (como envio da mensagem predeterminada) em background, desde que a conexão (WhatsApp) associada esteja ativa.",
      },
      {
        id: "notifications",
        question: "Como funcionam as notificações do sistema?",
        answer:
          "As notificações aparecem no 'Sininho' no canto superior direito e avisam sobre atualizações visuais, links convertidos e possíveis erros de integração em tempo real.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Solução de Problemas",
    description: "Como resolver os erros mais comuns.",
    icon: "Wrench",
    items: [
      {
        id: "common-errors",
        question: "Erros comuns e como resolver",
        answer:
          "O painel pode acusar limite de requisições por bloqueios das APIs externas ou falta de QR Code. Se houver falha persistente ao gerar o QR Code, recarregue a página ou reinicie seu celular. Em caso de conexão 'Pendente', espere cerca de 1 minuto para que os fluxos locais se restabeleçam.",
      },
      {
        id: "ui-screens",
        question: "Como interpretar algumas telas importantes do sistema?",
        answer:
          "A tela de Dashboard trará as estatísticas gerais de conversões. Cores vermelhas em painéis de automação indicam falhas de conectividade ou que você atingiu o limite de envios.",
      },
    ],
  },
];

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "article-whatsapp",
    title: "Como conectar seu WhatsApp",
    summary: "Guia passo a passo para vincular um número de WhatsApp ao sistema e manter a conexão ativa.",
    category: "Conexões",
    icon: "Smartphone",
    steps: [
      "Acesse o menu lateral e clique em 'Conexões > WhatsApp'.",
      "Clique no botão 'Nova Conexão' no canto superior direito.",
      "Dê um nome para identificar esse número (ex: Suporte, Vendas).",
      "Abra o WhatsApp no seu celular, vá em 'Dispositivos Vinculados' e escaneie o QR Code exibido na tela.",
      "Aguarde o status mudar para 'Online' (indicador verde). A conexão está pronta para uso.",
    ],
  },
  {
    id: "article-telegram",
    title: "Como conectar seu Telegram",
    summary: "Aprenda a integrar um bot ou conta do Telegram ao sistema para envio automatizado de mensagens.",
    category: "Conexões",
    icon: "Send",
    steps: [
      "Acesse o menu lateral e clique em 'Conexões > Telegram'.",
      "Clique em 'Nova Conexão' e insira o token do seu bot do Telegram (obtido via @BotFather).",
      "Confirme as permissões e aguarde a validação do token.",
      "O status da conexão ficará 'Online' quando o bot estiver pronto para receber e enviar mensagens.",
    ],
  },
  {
    id: "article-meli",
    title: "Integrando o Mercado Livre",
    summary: "Configure o Mercado Livre no sistema para automatizar o envio de links de produtos e acompanhar vendas.",
    category: "Integrações",
    icon: "ShoppingBag",
    steps: [
      "Acesse 'Mercado Livre > Configurações' no menu lateral.",
      "Clique em 'Conectar conta' e autorize o sistema na sua conta do Mercado Livre.",
      "Após autorização, seus dados de vendedor serão importados automaticamente.",
      "Navegue até 'Vitrine ML' para visualizar seus anúncios e criar links rastreáveis.",
      "Em 'Automações ML' você pode ativar regras automáticas de resposta e envio de mensagens.",
    ],
  },
  {
    id: "article-shopee",
    title: "Integrando a Shopee",
    summary: "Como usar o sistema para criar links encurtados de produtos da Shopee e ativar o piloto automático.",
    category: "Integrações",
    icon: "ShoppingCart",
    steps: [
      "Acesse 'Shopee > Configurações' no menu lateral.",
      "Faça login com sua conta de vendedor da Shopee para autorizar o acesso.",
      "Use 'Vitrine Shopee' para explorar seus produtos e gerar links rastreáveis.",
      "Em 'Pesquisa' você pode encontrar produtos por palavra-chave.",
      "Ative o 'Piloto Automático' em 'Shopee > Automações' para enviar links de forma dinâmica por WhatsApp.",
    ],
  },
  {
    id: "article-amazon",
    title: "Integrando a Amazon",
    summary: "Veja como usar o conversor de links da Amazon e configurar automações para a plataforma.",
    category: "Integrações",
    icon: "Package",
    steps: [
      "Acesse 'Amazon > Configurações' e insira seu ID de afiliado (se aplicável).",
      "Use o 'Conversor de links' para encurtar e rastrear URLs de produtos da Amazon.",
      "Em 'Vitrine Amazon' visualize e gerencie seus produtos em destaque.",
      "Configure automações em 'Amazon > Automações' para envio de links via mensageria.",
    ],
  },
  {
    id: "article-automations",
    title: "Como funcionam as Automações",
    summary: "Entenda o funcionamento das regras automáticas de envio e como configurar seu piloto automático.",
    category: "Automações",
    icon: "Bot",
    steps: [
      "As automações são ativadas dentro de cada módulo (Shopee, Meli, Amazon).",
      "Cada automação precisa de uma conexão WhatsApp ou Telegram ativa para funcionar.",
      "Você pode definir templates de mensagem com variáveis dinâmicas como nome do produto e preço.",
      "O sistema processa os gatilhos em background — você não precisa manter a tela aberta.",
      "Monitore o status das automações no Dashboard principal para ver os envios realizados.",
    ],
  },
];
