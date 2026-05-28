/**
 * Shared session placeholder resolver for MCP and HTTP tool executors.
 *
 * Resolves {{session.path.to.key}} placeholders using dot-path traversal.
 * Returns empty string for null/undefined values (not "null").
 */

/** Keys blocked from dot-path traversal to prevent prototype pollution. */
const DENIED_TRAVERSAL_KEYS: Record<string, boolean> = {
  __proto__: true,
  constructor: true,
  prototype: true,
};

/**
 * Resolve {{session.path.to.key}} placeholders using dot-path traversal.
 *
 * @param value - The string containing {{session.X}} placeholders
 * @param sessionVars - The session variables object (typically session.data.values._session)
 * @param formatter - Optional callback to format each resolved value (defaults to String).
 *   Runs per-placeholder inside the regex replace callback, enabling per-value
 *   transformations like JSON body escaping.
 */
export function resolveSessionPlaceholders(
  value: string,
  sessionVars: Record<string, unknown> | undefined,
  formatter: (value: unknown) => string = String,
): string {
  if (!sessionVars) return value;
  return value.replace(/\{\{session\.([\w.]+)\}\}/g, (_, dotPath: string) => {
    const parts = dotPath.split('.');
    let current: unknown = sessionVars;
    for (const part of parts) {
      if (DENIED_TRAVERSAL_KEYS[part]) return '';
      if (current == null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[part];
    }
    return current != null ? formatter(current) : '';
  });
}
