/**
 * Substitute {{path}} patterns in a template string using dot-path resolution.
 */
export function substituteTemplates(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, path: string) => {
    const value = resolvePath(path.trim(), context);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

function resolvePath(path: string, obj: Record<string, any>): unknown {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}
