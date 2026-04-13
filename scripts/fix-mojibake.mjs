import { readFileSync, writeFileSync } from "node:fs";

const mojibakeMap = [
  ["\u00C3\u00B3", "\u00F3"], // ó
  ["\u00C3\u00A3", "\u00E3"], // ã
  ["\u00C3\u00A7", "\u00E7"], // ç
  ["\u00C3\u00AA", "\u00EA"], // ê
  ["\u00C3\u00A9", "\u00E9"], // é
  ["\u00C3\u00AD", "\u00ED"], // í
  ["\u00C3\u00B5", "\u00F5"], // õ
  ["\u00C3\u00A1", "\u00E1"], // á
  ["\u00C3\u009A", "\u00DA"], // Ú
  ["\u00C3\u00A2", "\u00E2"], // â
  ["\u00C3\u00BC", "\u00FC"], // ü
  ["\u00C3\u00A0", "\u00E0"], // à
  ["\u00C3\u0081", "\u00C1"], // Á
  ["\u00C3\u0089", "\u00C9"], // É
  ["\u00C3\u00B4", "\u00F4"], // ô
  ["\u00C3\u00BA", "\u00FA"], // ú
];

const wordMap = [
  // Palavras com -ão
  ["conversão", "conversão"],
  ["sessão", "sessão"],
  ["Sessão", "Sessão"],
  ["conexão", "conexão"],
  ["autenticação", "autenticação"],
  ["automação", "automação"],
  ["Automação", "Automação"],
  ["notificação", "notificação"],
  ["configuração", "configuração"],
  ["manutenção", "manutenção"],
  ["verificação", "verificação"],
  ["Verificação", "Verificação"],
  ["execução", "execução"],
  ["informação", "informação"],
  ["comunicação", "comunicação"],
  ["transação", "transação"],
  ["reação", "reação"],
  ["localização", "localização"],
  ["navegação", "navegação"],
  ["integração", "integração"],
  ["operação", "operação"],
  ["condição", "condição"],
  ["descrição", "descrição"],
  ["direção", "direção"],
  ["versão", "versão"],
  ["variação", "variação"],
  ["reconciliação", "reconciliação"],
  ["válidação", "válidação"],
  ["sincronização", "sincronização"],
  ["restauração", "restauração"],
  ["produzação", "produzação"],
  ["reconexão", "reconexão"],
  ["Reconexão", "Reconexão"],
  ["atualização", "atualização"],
  ["publicação", "publicação"],
  
  // Palavras com -ía
  ["saída", "saída"],
  ["entrada", "entrada"],
  ["mídia", "mídia"],
  ["Mídia", "Mídia"],
  
  // Palavras com -ç
  ["Configurações", "Configurações"],
  ["função", "função"],
  
  // Palavras com -á ou -ão futuro
  ["será", "será"],
  ["estará", "estará"],
  ["deverão", "deverão"],
  ["poderá", "poderá"],
  ["haverão", "haverão"],
  ["aparecerão", "aparecerão"],
  ["permitirá", "permitirá"],
  ["entrará", "entrará"],
  ["começará", "começará"],
  ["encontrará", "encontrará"],
  ["estarão", "estarão"],
  ["ficarão", "ficarão"],
  ["Faça", "Faça"],
  ["poderá", "poderá"],
  
  // Palavras com -í
  ["elegível", "elegível"],
  ["disponível", "disponível"],
  ["compatível", "compatível"],
  ["inválida", "inválida"],
  ["inválido", "inválido"],
  ["inválidos", "inválidos"],
  ["válido", "válido"],
  ["válida", "válida"],
  ["obrigatório", "obrigatório"],
  ["obrigatórios", "obrigatórios"],
  ["obrigatórias", "obrigatórias"],
  ["meio", "meio"],
  ["médio", "médio"],
  
  // Palavras com -ã
  ["variações", "variações"],
  ["segurança", "segurança"],
  ["página", "página"],
  ["páginas", "páginas"],
  ["Páginas", "Páginas"],
  ["Não", "Não"],
  ["não ", "não "],
  ["obtém", "obtém"],
  ["temporária", "temporária"],
  ["Falha temporária", "Falha temporária"],
  ["já ", "já "],
  ["além", "além"],
  ["após", "após"],
  
  // Frases compostas
  ["é obrigatório", "é obrigatório"],
  ["Modo manutenção", "Modo manutenção"],
  ["Fila de conversão", "Fila de conversão"],
  ["Sessão expirada", "Sessão expirada"],
  ["Sessão já ", "Sessão já "],
  ["Sessão não ", "Sessão não "],
  ["instabilidade no serviço", "instabilidade no serviço"],
  ["Senha inválida", "Senha inválida"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyMap(fileName, content, replacements, label) {
  let updated = content;
  let total = 0;

  for (const [bad, good] of replacements) {
    const re = new RegExp(escapeRegExp(bad), "g");
    const matches = updated.match(re);
    if (matches) {
      total += matches.length;
      console.log(`${fileName}: ${label} '${bad}' -> '${good}' : ${matches.length}`);
      updated = updated.replace(re, good);
    }
  }

  return { updated, total };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("Usage: node scripts/fix-mojibake.mjs <file1> [file2...]");
  process.exit(0);
}

for (const fileName of files) {
  const original = readFileSync(fileName, "utf8");
  const phase1 = applyMap(fileName, original, mojibakeMap, "mojibake");
  const phase2 = applyMap(fileName, phase1.updated, wordMap, "word");
  writeFileSync(fileName, phase2.updated, "utf8");
  console.log(`${fileName}: total ${phase1.total + phase2.total} replacements applied\n`);
}
