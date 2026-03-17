export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_POLICY_HINT = `Mínimo ${PASSWORD_MIN_LENGTH} caracteres com letras e números`;

const HAS_LETTER_REGEX = /[A-Za-z]/;
const HAS_NUMBER_REGEX = /\d/;

export function getPasswordPolicyError(password: string): string | null {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`;
  }
  if (!HAS_LETTER_REGEX.test(value) || !HAS_NUMBER_REGEX.test(value)) {
    return "A senha deve conter letras e números";
  }
  return null;
}

