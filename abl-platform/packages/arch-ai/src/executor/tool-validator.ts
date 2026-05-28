import { toolInputSchemas } from '../tools/schemas/in-project-schemas.js';

export interface ValidationResult {
  valid: boolean;
  input: Record<string, unknown>;
  errors?: string[];
}

/**
 * Validates tool call inputs against Zod schemas.
 * Returns sanitized input on success, error details on failure.
 */
export function validateToolInput(
  toolName: string,
  rawInput: Record<string, unknown>,
): ValidationResult {
  const schema = toolInputSchemas[toolName as keyof typeof toolInputSchemas];

  if (!schema) {
    return { valid: true, input: rawInput };
  }

  const result = schema.safeParse(rawInput);

  if (result.success) {
    return { valid: true, input: result.data as Record<string, unknown> };
  }

  const errors = result.error.issues.map(
    (issue: { path: (string | number)[]; message: string }) =>
      `${issue.path.join('.')}: ${issue.message}`,
  );

  return { valid: false, input: rawInput, errors };
}
