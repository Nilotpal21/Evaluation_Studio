import crypto from 'crypto';
import { SENSITIVE_PATHS } from '../constants/sensitive-paths.js';

/**
 * Compute a deterministic SHA-256 hash of the config object.
 * Sensitive fields are excluded from the hash to prevent secret leakage in logs.
 * Keys are sorted for determinism.
 */
export function computeConfigHash(config: unknown): string {
  if (config === null || config === undefined || typeof config !== 'object') {
    const canonical = String(config);
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }
  const sanitized = redactForHashing(config as Record<string, unknown>);
  const canonical = stableStringify(sanitized);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function redactForHashing(
  obj: Record<string, unknown>,
  prefix = '',
  visited: Set<object> = new Set(),
): Record<string, unknown> {
  if (visited.has(obj)) return { '[circular]': true };
  visited.add(obj);

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_PATHS.includes(path)) continue;
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = redactForHashing(val as Record<string, unknown>, path, visited);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function stableStringify(obj: unknown, visited: Set<object> = new Set()): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (visited.has(obj as object)) return '"[circular]"';
  visited.add(obj as object);
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => stableStringify(item, visited)).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k], visited),
      )
      .join(',') +
    '}'
  );
}
