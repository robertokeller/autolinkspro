// services/whatsapp-baileys/src/analytics/ddd-to-state.ts

export const DDD_TO_STATE: Record<string, string> = {
  '11': 'SP', '12': 'SP', '13': 'SP', '14': 'SP', '15': 'SP',
  '16': 'SP', '17': 'SP', '18': 'SP', '19': 'SP',
  '21': 'RJ', '22': 'RJ', '24': 'RJ',
  '27': 'ES', '28': 'ES',
  '31': 'MG', '32': 'MG', '33': 'MG', '34': 'MG',
  '35': 'MG', '37': 'MG', '38': 'MG',
  '41': 'PR', '42': 'PR', '43': 'PR', '44': 'PR', '45': 'PR', '46': 'PR',
  '47': 'SC', '48': 'SC', '49': 'SC',
  '51': 'RS', '53': 'RS', '54': 'RS', '55': 'RS',
  '61': 'DF', '62': 'GO', '63': 'TO', '64': 'GO',
  '65': 'MT', '66': 'MT', '67': 'MS', '68': 'AC', '69': 'RO',
  '71': 'BA', '73': 'BA', '74': 'BA', '75': 'BA', '77': 'BA', '79': 'SE',
  '81': 'PE', '82': 'AL', '83': 'PB', '84': 'RN',
  '85': 'CE', '86': 'PI', '87': 'PE', '88': 'CE', '89': 'PI',
  '91': 'PA', '92': 'AM', '93': 'PA', '94': 'PA',
  '95': 'RR', '96': 'AP', '97': 'AM', '98': 'MA', '99': 'MA',
};

export const STATE_TO_IBGE: Record<string, number> = {
  'AC': 12, 'AL': 27, 'AP': 16, 'AM': 13, 'BA': 29, 'CE': 23, 'DF': 53,
  'ES': 32, 'GO': 52, 'MA': 21, 'MT': 51, 'MS': 50, 'MG': 31, 'PA': 15,
  'PB': 25, 'PR': 41, 'PE': 26, 'PI': 22, 'RJ': 33, 'RN': 24, 'RS': 43,
  'RO': 11, 'RR': 14, 'SC': 42, 'SP': 35, 'SE': 28, 'TO': 17,
};

export const IBGE_TO_STATE: Record<number, string> = {
  12: 'AC', 27: 'AL', 16: 'AP', 13: 'AM', 29: 'BA', 23: 'CE', 53: 'DF',
  32: 'ES', 52: 'GO', 21: 'MA', 51: 'MT', 50: 'MS', 31: 'MG', 15: 'PA',
  25: 'PB', 41: 'PR', 26: 'PE', 22: 'PI', 33: 'RJ', 24: 'RN', 43: 'RS',
  11: 'RO', 14: 'RR', 42: 'SC', 35: 'SP', 28: 'SE', 17: 'TO',
};

function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function extractPhoneFromJid(jid: string): string {
  if (!jid) return '';
  const normalized = String(jid || '').trim();
  if (!normalized) return '';

  // LID is an internal identifier and not a phone number.
  if (/@(?:hosted\.)?lid$/i.test(normalized)) return '';

  const [localPartRaw = ''] = normalized.split('@');
  const localPart = localPartRaw.split(':')[0] || '';
  return digitsOnly(localPart);
}

export function normalizePhoneCandidate(value: string): string {
  const digits = digitsOnly(value);
  if (!digits) return '';

  // BR with country code.
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  // BR local format (DDD + numero).
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;

  // Unknown/non-BR identifiers stay as-is for diagnostics, but DDD extraction
  // will reject them unless they resolve to BR format.
  return digits;
}

export function dddToState(ddd: string): string {
  return DDD_TO_STATE[ddd] || 'Desconhecido';
}

export function getMemberDDD(phone: string): string {
  const normalized = normalizePhoneCandidate(phone);
  if (normalized.startsWith('55') && normalized.length >= 12) return normalized.slice(2, 4);
  return '';
}

export function getMemberState(phone: string): string {
  const ddd = getMemberDDD(phone);
  return dddToState(ddd);
}

export function interpolateColor(color1: string, color2: string, factor: number): string {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);

  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
