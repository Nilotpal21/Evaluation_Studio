export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\s\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

export const PROJECT_NAME_ERROR_MESSAGE =
  'Project name must start and end with a letter or number, and can only contain letters, numbers, spaces, hyphens, underscores, and periods';

export function getProjectNameValidationError(name: string): string | null {
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  return PROJECT_NAME_PATTERN.test(trimmedName) ? null : PROJECT_NAME_ERROR_MESSAGE;
}
