/**
 * Helpers for interpolating values into JSON template strings without
 * breaking the surrounding JSON syntax.
 */

/**
 * Escape a string so it can be safely inserted into an already-quoted JSON
 * string value.
 */
export function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Serialize a template placeholder value for a JSON body template.
 *
 * String values are escaped for insertion into an already-quoted JSON string.
 * Objects/arrays stay JSON-encoded so existing unquoted object placeholders keep
 * working as before.
 */
export function stringifyJsonTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return escapeJsonString(value);
  }

  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
