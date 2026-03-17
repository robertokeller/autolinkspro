/**
 * Utilitário de normalização e validação de telefone
 * Remove formatação, adiciona código de país e valida números brasileiros
 */

function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

function ensureCountryCode(phone: string, defaultCode = "55"): string {
  const digits = normalizePhone(phone);
  
  // Já tem código de país (13 dígitos: 55 + DDD 2 + número 9)
  if (digits.length === 13 && digits.startsWith(defaultCode)) {
    return `+${digits}`;
  }
  // Tem DDD + número (11 dígitos)
  if (digits.length === 11) {
    return `+${defaultCode}${digits}`;
  }
  // Tem DDD + número sem 9 (10 dígitos - fixo)
  if (digits.length === 10) {
    return `+${defaultCode}${digits}`;
  }
  // Já tem + no input original
  if (phone.trim().startsWith("+")) {
    return `+${digits}`;
  }
  // Se tem 12 dígitos e começa com 55 (sem o 9 no celular)
  if (digits.length === 12 && digits.startsWith(defaultCode)) {
    return `+${digits}`;
  }
  // Fallback: adiciona código
  if (digits.length >= 10) {
    return `+${defaultCode}${digits}`;
  }
  return `+${digits}`;
}

export function formatPhoneDisplay(phone: string): string {
  const digits = normalizePhone(phone);
  
  // Formato brasileiro: +55 (11) 99999-9999
  if (digits.length === 13 && digits.startsWith("55")) {
    const ddd = digits.slice(2, 4);
    const part1 = digits.slice(4, 9);
    const part2 = digits.slice(9, 13);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }
  if (digits.length === 12 && digits.startsWith("55")) {
    const ddd = digits.slice(2, 4);
    const part1 = digits.slice(4, 8);
    const part2 = digits.slice(8, 12);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }
  // Retorna com + na frente se não encaixa no formato BR
  return phone.startsWith("+") ? phone : `+${digits}`;
}

interface PhoneValidation {
  valid: boolean;
  normalized: string;
  formatted: string;
  error?: string;
  wasAutoCorrected: boolean;
}

export function validatePhone(input: string): PhoneValidation {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, normalized: "", formatted: "", error: "Número é obrigatório", wasAutoCorrected: false };
  }

  const digits = normalizePhone(trimmed);
  
  if (digits.length < 10) {
    return { valid: false, normalized: `+${digits}`, formatted: trimmed, error: "Número muito curto", wasAutoCorrected: false };
  }
  if (digits.length > 15) {
    return { valid: false, normalized: `+${digits}`, formatted: trimmed, error: "Número muito longo", wasAutoCorrected: false };
  }

  const normalized = ensureCountryCode(trimmed);
  const formatted = formatPhoneDisplay(normalized);
  const wasAutoCorrected = trimmed !== normalized && trimmed !== formatted;

  return { valid: true, normalized, formatted, wasAutoCorrected };
}
