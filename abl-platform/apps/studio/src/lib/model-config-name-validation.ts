export const MODEL_CONFIG_NAME_PATTERN = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9\s\-_.()]+$/;

export const MODEL_CONFIG_NAME_ERROR_MESSAGE =
  'Model configuration name can only contain letters, numbers, spaces, hyphens, underscores, periods, and parentheses, and must include at least one letter or number';

export function getModelConfigNameValidationError(name: string): string | null {
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  return MODEL_CONFIG_NAME_PATTERN.test(trimmedName) ? null : MODEL_CONFIG_NAME_ERROR_MESSAGE;
}
