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
  ["conversao", "conversão"],
  ["sessao", "sessão"],
  ["Sessao", "Sessão"],
  ["conexao", "conexão"],
  ["autenticacao", "autenticação"],
  ["automacao", "automação"],
  ["Automacao", "Automação"],
  ["notificacao", "notificação"],
  ["Configuracoes", "Configurações"],
  ["configuracao", "configuração"],
  ["manutencao", "manutenção"],
  ["obrigatorio", "obrigatório"],
  ["obrigatorios", "obrigatórios"],
  ["invalida", "inválida"],
  ["invalido", "inválido"],
  ["funcao", "função"],
  ["execucao", "execução"],
  ["elegivel", "elegível"],
  ["invalidos", "inválidos"],
  ["Falha temporaria", "Falha temporária"],
  ["temporaria", "temporária"],
  ["disponivel", "disponível"],
  ["valido", "válido"],
  ["valida", "válida"],
  ["Senha invalida", "Senha inválida"],
  ["Nao", "Não"],
  ["nao ", "não "],
  ["e obrigatorio", "é obrigatório"],
  ["Modo manutencao", "Modo manutenção"],
  ["Fila de conversao", "Fila de conversão"],
  ["Sessao expirada", "Sessão expirada"],
  ["Sessao ja ", "Sessão já "],
  ["Sessao nao ", "Sessão não "],
  ["instabilidade no servico", "instabilidade no serviço"],
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
