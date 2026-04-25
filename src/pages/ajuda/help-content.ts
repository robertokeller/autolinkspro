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
    title: "Primeiros passos e planos",
    description: "Configurações iniciais e informações sobre limites.",
    icon: "Rocket",
    items: [
      {
        id: "start",
        question: "Como começar a usar o sistema?",
        answer:
          "Acesse a aba 'Conexões' para vincular pelo menos uma conta de WhatsApp ou Telegram. Depois, vá até o marketplace de sua preferência (Mercado Livre, Shopee ou Amazon) para ativar as verificações e mapear seus links.",
      },
      {
        id: "limits",
        question: "Quais são os limites de cada plano?",
        answer:
          "Os limites variam de acordo com o pacote contratado e impactam a quantidade de instâncias conectadas e a velocidade das automações (como cron jobs). Se notar retenção de envios, consulte 'Configurações > Minha conta' para ver o uso atual.",
      },
    ],
  },
  {
    id: "connections",
    title: "Conexões (WhatsApp e Telegram)",
    description: "Configuração dos seus canais de mensagens.",
    icon: "Link2",
    items: [
      {
        id: "connect-wa-tg",
        question: "Como conectar WhatsApp ou Telegram?",
        answer:
          "Acesse 'Conexões > WhatsApp' ou 'Conexões > Telegram', clique em 'Nova conexão' e siga as instruções exibidas na tela para concluir a autenticação. A conexão deve permanecer com status 'Online' no painel.",
      },
      {
        id: "disconnect",
        question: "O que fazer quando uma conta desconecta?",
        answer:
          "Desconexões podem ocorrer por atualizações do WhatsApp/Telegram ou por instabilidade de internet no celular durante a sincronização. Remova a conexão atual no painel e faça a conexão novamente.",
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
        question: "Como usar Mercado Livre, Shopee e Amazon no sistema?",
        answer:
          "Cada integração possui uma aba dedicada no painel lateral. Nas configurações de cada uma, faça login na sua conta e ajuste os modelos para automatizar interações de compra e venda.",
      },
      {
        id: "status-check",
        question: "Como verificar se uma integração está funcionando?",
        answer:
          "Navegue até a página do marketplace correspondente (ex.: Shopee) e observe o status das credenciais no topo da tela. Avisos (Warning) indicam que é necessário fazer login novamente.",
      },
    ],
  },
  {
    id: "automations",
    title: "Rotas e automações",
    description: "Dúvidas sobre funcionamento e regras.",
    icon: "Bot",
    items: [
      {
        id: "automation-works",
        question: "Como funcionam as automações?",
        answer:
          "As automações funcionam com gatilhos específicos de cada loja e processam o fluxo (como o envio de mensagens predefinidas) em segundo plano, desde que a conexão associada (WhatsApp/Telegram) esteja ativa.",
      },
      {
        id: "notifications",
        question: "Como funcionam as notificações do sistema?",
        answer:
          "As notificações aparecem no ícone de sino, no canto superior direito, e informam atualizações visuais, links convertidos e possíveis erros de integração em tempo real.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Solução de problemas",
    description: "Como resolver os erros mais comuns.",
    icon: "Wrench",
    items: [
      {
        id: "common-errors",
        question: "Erros comuns e como resolver",
        answer:
          "O painel pode indicar limite de requisições devido a bloqueios das APIs externas ou falta de QR Code. Se a falha para gerar o QR Code persistir, recarregue a página ou reinicie o celular. Em caso de conexão 'Pendente', aguarde cerca de 1 minuto para que os fluxos locais se restabeleçam.",
      },
      {
        id: "ui-screens",
        question: "Como interpretar algumas telas importantes do sistema?",
        answer:
          "A tela do Dashboard traz as estatísticas gerais de conversões. Cores vermelhas em painéis de automação indicam falhas de conectividade ou que o limite de envios foi atingido.",
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
      "Clique no botão 'Nova conexão' no canto superior direito.",
      "Dê um nome para identificar esse número (ex.: Suporte, Vendas).",
      "Abra o WhatsApp no celular, vá em 'Dispositivos vinculados' e escaneie o QR Code exibido na tela.",
      "Aguarde o status mudar para 'Online' (indicador verde). A conexão estará pronta para uso.",
    ],
  },
  {
    id: "article-telegram",
    title: "Como conectar seu Telegram",
    summary: "Aprenda a integrar sua conta do Telegram ao sistema para envio automatizado de mensagens.",
    category: "Conexões",
    icon: "Send",
    steps: [
      "Acesse o menu lateral e clique em 'Conexões > Telegram'.",
      "Clique em 'Nova conexão' e siga as instruções de autenticação exibidas na tela.",
      "Confirme as permissões solicitadas e aguarde a validação.",
      "O status da conexão ficará 'Online' quando a conta estiver pronta para receber e enviar mensagens.",
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
    title: "Como funcionam as automações",
    summary: "Entenda o funcionamento das regras automáticas de envio e como configurar seu piloto automático.",
    category: "Automações",
    icon: "Bot",
    steps: [
      "As automações são ativadas dentro de cada módulo (Shopee, Mercado Livre e Amazon).",
      "Cada automação precisa de uma conexão WhatsApp ou Telegram ativa para funcionar.",
      "Você pode definir modelos de mensagem com variáveis dinâmicas, como nome do produto e preço.",
      "O sistema processa os gatilhos em segundo plano. Você não precisa manter a tela aberta.",
      "Monitore o status das automações no Dashboard principal para acompanhar os envios realizados.",
    ],
  },
];
