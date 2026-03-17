export const PASSWORD_MIN_LENGTH = 8;

const HAS_LETTER_REGEX = /[A-Za-z]/;
const HAS_NUMBER_REGEX = /\d/;

export function getPasswordPolicyError(password: string): string | null {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres`;
  }
  if (!HAS_LETTER_REGEX.test(value) || !HAS_NUMBER_REGEX.test(value)) {
    return "Senha deve conter letras e números";
  }
  return null;
}

