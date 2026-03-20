import { readFileSync, writeFileSync } from 'fs';

// ── Phase 1: Mojibake (double-encoded UTF-8) ─────────────────────────────────
const mojibakeMap = [
  ['\u00C3\u00B3', '\u00F3'],  // ó
  ['\u00C3\u00A3', '\u00E3'],  // ã
  ['\u00C3\u00A7', '\u00E7'],  // ç
  ['\u00C3\u00AA', '\u00EA'],  // ê
  ['\u00C3\u00A9', '\u00E9'],  // é
  ['\u00C3\u00AD', '\u00ED'],  // í
  ['\u00C3\u00B5', '\u00F5'],  // õ
  ['\u00C3\u00A1', '\u00E1'],  // á
  ['\u00C3\u009A', '\u00DA'],  // Ú
  ['\u00C3\u00A2', '\u00E2'],  // â
  ['\u00C3\u00BC', '\u00FC'],  // ü
  ['\u00C3\u00A0', '\u00E0'],  // à
  ['\u00C3\u0081', '\u00C1'],  // Á
  ['\u00C3\u0089', '\u00C9'],  // É
  ['\u00C3\u00B4', '\u00F4'],  // ô
  ['\u00C3\u00BA', '\u00FA'],  // ú
];

// ── Phase 2: Stripped-accent Portuguese words ─────────────────────────────────
const wordMap = [
  // Common stripped-accent words → correct form (whole-word or phrase)
  ['conversao', 'conversão'],
  ['sessao', 'sessão'],
  ['Sessao', 'Sessão'],
  ['conexao', 'conexão'],
  ['autenticacao', 'autenticação'],
  ['automacao', 'automação'],
  ['Automacao', 'Automação'],
  ['notificacao', 'notificação'],
  ['Configuracoes', 'Configurações'],
  ['configuracao', 'configuração'],
  ['manutencao', 'manutenção'],
  ['obrigatorio', 'obrigatório'],
  ['obrigatorios', 'obrigatórios'],
  ['invalida', 'inválida'],
  ['invalido', 'inválido'],
  ['funcao', 'função'],
  ['execucao', 'execução'],
  ['elegivel', 'elegível'],
  ['invalidos', 'inválidos'],
  ['Falha temporaria', 'Falha temporária'],
  ['temporaria', 'temporária'],
  ['disponivel', 'disponível'],
  ['valido', 'válido'],
  ['valida', 'válida'],
  ['Senha invalida', 'Senha inválida'],
  ['Nao', 'Não'],
  ['nao ', 'não '],
  ['e obrigatorio', 'é obrigatório'],
  ['Modo manutencao', 'Modo manutenção'],
  ['Fila de conversao', 'Fila de conversão'],
  ['Sessao expirada', 'Sessão expirada'],
  ['Sessao ja ', 'Sessão já '],
  ['Sessao nao ', 'Sessão não '],
  ['instabilidade no servico', 'instabilidade no serviço'],
];

const files = process.argv.slice(2);
for (const f of files) {
  let c = readFileSync(f, 'utf8');
  let total = 0;

  // Phase 1: Fix mojibake
  for (const [bad, good] of mojibakeMap) {
    const escaped = bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const matches = c.match(re);
    if (matches) {
      total += matches.length;
      console.log(`${f}: mojibake '${bad}' -> '${good}' : ${matches.length}`);
    }
    c = c.replace(re, good);
  }

  // Phase 2: Fix stripped accents (case-sensitive exact word replacements)
  for (const [bad, good] of wordMap) {
    const escaped = bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const matches = c.match(re);
    if (matches) {
      total += matches.length;
      console.log(`${f}: word '${bad}' -> '${good}' : ${matches.length}`);
    }
    c = c.replace(re, good);
  }

  writeFileSync(f, c, 'utf8');
  console.log(`${f}: total ${total} replacements applied\n`);
}
