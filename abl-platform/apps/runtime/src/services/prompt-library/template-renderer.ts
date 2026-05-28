/**
 * Render prompt-library templates for runtime-owned prompt overrides.
 * Variables use the same {{name}} placeholder shape as prompt-library tests.
 */

export function sanitizeTemplateVariableValue(value: string): string {
  return value.replace(/\{\{/g, '').replace(/\}\}/g, '');
}

function stringifyTemplateValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderPromptTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    return sanitizeTemplateVariableValue(stringifyTemplateValue(variables[name]));
  });
}
