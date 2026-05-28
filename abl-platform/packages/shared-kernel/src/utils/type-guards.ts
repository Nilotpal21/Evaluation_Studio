/**
 * Type Guard Utilities
 *
 * Runtime type checking and safe parsing utilities.
 */

/**
 * Safe JSON.parse with type fallback.
 * Returns fallback if JSON is invalid or parsing fails.
 */
export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Check if value is a plain object (not array, not null).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
