const fs = require('fs');
const path = 'src/pages/admin/AdminAccess.tsx';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  ['Conex?es Telegram', 'Conexões Telegram'],
  ['Automa??es Shopee', 'Automações Shopee'],
  ['Conex?es em Tempo Real', 'Conexões em Tempo Real'],
  ['Sess?es ativas permitidas simultaneamente.', 'Sessões ativas permitidas simultaneamente.'],
  ['N?o foi poss?vel salvar n?veis de acesso', 'Não foi possível salvar níveis de acesso'],
  ['N?veis salvos!', 'Níveis salvos!'],
  ['N?veis de Servi?o', 'Níveis de Serviço'],
  ['Novo N?vel', 'Novo Nível'],
  ['Aplicar Altera??es', 'Aplicar Alterações'],
  ['M?tricas Ativas', 'Métricas Ativas'],
  ['Capacidade M?xima', 'Capacidade Máxima'],
  ['Automa??es', 'Automações'],
  ['Sess?es WA', 'Sessões WA'],
  ['Gerenciar N?vel', 'Gerenciar Nível'],
  ['Configura N?vel de Servi?o', 'Configurar Nível de Serviço'],
  ['Identifica??o do N?vel', 'Identificação do Nível'],
  ['Usu?rio VIP', 'Usuário VIP'],
  ['Recursos & Permiss?es', 'Recursos & Permissões'],
  ['Prioridade de Configura??o', 'Prioridade de Configuração'],
  ['s?o soberanos', 'são soberanos'],
  ['for?ar?', 'forçará'],
  ['Padr?o sist?mico.', 'Padrão sistêmico.'],
  ['permiss?es', 'permissões']
];

for (const [old, new_] of replacements) {
  content = content.replace(old, new_);
}

fs.writeFileSync(path, content);
console.log('AdminAccess.tsx fixed');
