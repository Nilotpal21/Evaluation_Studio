/**
 * Shared JSON field parsing utility.
 * Extracted from model-resolution.ts:282 — identical behavior and signature.
 *
 * Return type is `any` to match the original — call sites in model-resolution.ts
 * assign the result to typed variables without explicit casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonField(val: unknown): any {
  if (!val) return undefined;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}
