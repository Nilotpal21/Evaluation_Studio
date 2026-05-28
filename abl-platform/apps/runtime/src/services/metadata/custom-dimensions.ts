/**
 * Custom Dimensions — validation and merging for session-level analytics metadata.
 *
 * Dimensions flow from three sources (SDK init, DSL SET _meta.*, REST injection)
 * and are propagated through the trace pipeline to the ClickHouse
 * `platform_events.custom_dimensions Map(String, String)` column.
 */

import { containsPII as detectPII } from '@abl/compiler';
import type { PIIRecognizerRegistry } from '@abl/compiler/platform';

// ── Limits ────────────────────────────────────────────────────────
export const MAX_DIMENSION_KEYS = 50;
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_BYTES = 1024; // 1 KB per value
export const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

// ── Types ─────────────────────────────────────────────────────────
export interface DimensionValidationResult {
  valid: boolean;
  dimensions: Map<string, string>;
  errors: string[];
  warnings: string[];
}

export interface DimensionValidationOptions {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  enforcePII?: boolean;
}

export interface SessionDimensionTarget {
  customDimensions?: Map<string, string>;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  piiRedactionConfig?: { enabled?: boolean };
}

// ── Helpers ───────────────────────────────────────────────────────

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function containsDimensionPII(value: string, options?: DimensionValidationOptions): boolean {
  if (options?.enforcePII === false) {
    return false;
  }

  return detectPII(value, options?.piiRecognizerRegistry);
}

function coerceToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Objects, arrays, null, undefined, NaN, Infinity → rejected
  return null;
}

export function buildDimensionValidationOptions(
  target?: Pick<SessionDimensionTarget, 'piiRecognizerRegistry' | 'piiRedactionConfig'>,
): DimensionValidationOptions {
  return {
    piiRecognizerRegistry: target?.piiRecognizerRegistry,
    enforcePII: target?.piiRedactionConfig?.enabled !== false,
  };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Validate a set of raw key-value pairs as custom dimensions.
 * Returns the clean Map plus any errors/warnings.
 */
export function validateDimensions(
  input: Record<string, unknown>,
  existing?: Map<string, string>,
  options?: DimensionValidationOptions,
): DimensionValidationResult {
  const dimensions = new Map<string, string>(existing ?? []);
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(input)) {
    // 1. Key format
    if (!KEY_PATTERN.test(rawKey)) {
      errors.push(`Invalid key format: "${rawKey}" — must match [a-zA-Z][a-zA-Z0-9_]*`);
      continue;
    }

    // 2. Key length
    if (rawKey.length > MAX_KEY_LENGTH) {
      errors.push(`Key too long: "${rawKey.slice(0, 32)}…" (${rawKey.length} > ${MAX_KEY_LENGTH})`);
      continue;
    }

    // 3. Value coercion
    const strValue = coerceToString(rawValue);
    if (strValue === null) {
      errors.push(`Cannot coerce value for key "${rawKey}" — objects/arrays/null not allowed`);
      continue;
    }

    // 4. Value size
    const valueBytelen = byteLength(strValue);
    if (valueBytelen > MAX_VALUE_BYTES) {
      errors.push(
        `Value too large for key "${rawKey}" (${valueBytelen} bytes > ${MAX_VALUE_BYTES})`,
      );
      continue;
    }

    // 5. PII check
    if (containsDimensionPII(strValue, options)) {
      errors.push(`PII detected in value for key "${rawKey}" — rejected`);
      continue;
    }

    // 6. Total key count (check only when adding a truly new key)
    if (!dimensions.has(rawKey) && dimensions.size >= MAX_DIMENSION_KEYS) {
      errors.push(`Key limit reached (${MAX_DIMENSION_KEYS}) — cannot add "${rawKey}"`);
      continue;
    }

    dimensions.set(rawKey, strValue);
  }

  return {
    valid: errors.length === 0,
    dimensions,
    errors,
    warnings,
  };
}

/**
 * Merge incoming dimensions into an existing Map.
 * Convenience wrapper around validateDimensions.
 */
export function mergeDimensions(
  existing: Map<string, string>,
  incoming: Record<string, unknown>,
  options?: DimensionValidationOptions,
): DimensionValidationResult {
  return validateDimensions(incoming, existing, options);
}

export function mergeSessionDimensions(
  session: SessionDimensionTarget,
  incoming: Record<string, unknown>,
): DimensionValidationResult {
  const result = mergeDimensions(
    session.customDimensions ?? new Map<string, string>(),
    incoming,
    buildDimensionValidationOptions(session),
  );

  if (result.dimensions.size > 0) {
    session.customDimensions = result.dimensions;
  }

  return result;
}
