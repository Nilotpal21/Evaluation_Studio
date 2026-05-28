/**
 * Entity-type intrinsic validation.
 *
 * Pure functions that validate extracted values against entity-level intrinsic
 * rules. Stronger type-specific patterns than the basic checks in
 * extraction-validation.ts (e.g., RFC 5322 email regex, digit-count phone
 * validation, Date.parse heuristic).
 */

import {
  normalizeEnumValue,
  normalizePhone,
  normalizeDate,
  normalizeCurrency,
  TRUTHY_VALUES,
  FALSY_VALUES,
  type DateNormalizationOptions,
} from './extraction-validation.js';

// ── Result type ──────────────────────────────────────────────────────────────

export interface IntrinsicValidationResult {
  valid: boolean;
  normalized?: unknown;
  error?: string;
}

/** Maximum input length for pattern validation — runtime ReDoS guard. */
const MAX_PATTERN_INPUT_LENGTH = 1000;

/** RFC 5322-ish email regex — shared across validation paths. */
export const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractDigits(value: string): string {
  return value.replace(/\D/g, '');
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Validate an extracted value against entity-type intrinsic rules.
 *
 * @param entityType - The entity type identifier (e.g. "email", "phone", "boolean").
 * @param value      - The raw extracted value.
 * @param constraints - Optional constraints (enum values, synonyms, regex pattern).
 * @returns Validation result with optional normalized value and error message.
 */
export function validateIntrinsic(
  entityType: string,
  value: unknown,
  constraints?: {
    values?: string[];
    synonyms?: Record<string, string[]>;
    pattern?: string;
  },
  options: DateNormalizationOptions = {},
): IntrinsicValidationResult {
  const type = entityType.toLowerCase();

  switch (type) {
    // ── Email ────────────────────────────────────────────────────────────
    case 'email': {
      const str = typeof value === 'string' ? value : String(value);
      if (!EMAIL_REGEX.test(str)) {
        return { valid: false, error: `Invalid email: "${str}"` };
      }
      return { valid: true, normalized: str.toLowerCase() };
    }

    // ── Phone ────────────────────────────────────────────────────────────
    case 'phone': {
      const str = typeof value === 'string' ? value : String(value);
      const digits = extractDigits(str);
      if (digits.length < 7 || digits.length > 15) {
        return {
          valid: false,
          error: `Invalid phone: expected 7-15 digits, got ${digits.length}`,
        };
      }
      const normalized = normalizePhone(str);
      if (normalized === null) {
        return {
          valid: false,
          error: `Invalid phone: "${str}" does not contain a valid phone number`,
        };
      }
      return { valid: true, normalized };
    }

    // ── Date / Datetime ──────────────────────────────────────────────────
    case 'date':
    case 'datetime': {
      const str = typeof value === 'string' ? value : String(value);
      const isoDate = normalizeDate(str, options);
      if (isoDate === null) {
        return { valid: false, error: `Invalid ${type}: "${str}"` };
      }
      return { valid: true, normalized: isoDate };
    }

    // ── Boolean ──────────────────────────────────────────────────────────
    case 'boolean': {
      if (typeof value === 'boolean') {
        return { valid: true, normalized: value };
      }
      const str = String(value).toLowerCase().trim();
      if (TRUTHY_VALUES.has(str)) return { valid: true, normalized: true };
      if (FALSY_VALUES.has(str)) return { valid: true, normalized: false };
      return { valid: false, error: `Invalid boolean: "${value}"` };
    }

    // ── Currency ─────────────────────────────────────────────────────────
    case 'currency': {
      const amount = normalizeCurrency(value);
      if (amount !== null) return { valid: true, normalized: amount };
      return { valid: false, error: `Invalid currency value: "${value}"` };
    }

    // ── Numeric types ────────────────────────────────────────────────────
    case 'number':
    case 'integer':
    case 'float': {
      if (typeof value === 'number' && !isNaN(value)) {
        return { valid: true, normalized: value };
      }
      const parsed = Number(value);
      if (!isNaN(parsed)) return { valid: true, normalized: parsed };
      return { valid: false, error: `Invalid ${type}: "${value}"` };
    }

    // ── Enum ─────────────────────────────────────────────────────────────
    case 'enum': {
      const enumValues = constraints?.values ?? [];
      if (enumValues.length === 0) return { valid: true, normalized: value };
      const normalized = normalizeEnumValue(String(value), enumValues, constraints?.synonyms);
      if (normalized !== null) return { valid: true, normalized };
      return {
        valid: false,
        error: `Invalid enum value: "${value}". Allowed: ${enumValues.join(', ')}`,
      };
    }

    // ── Pattern ──────────────────────────────────────────────────────────
    case 'pattern': {
      const patternStr = constraints?.pattern;
      if (!patternStr) return { valid: true, normalized: value };
      const str = typeof value === 'string' ? value : String(value);
      // Runtime guard: cap input length to limit blast radius of complex patterns.
      // Compile-time validation (regex-safety.ts) catches dangerous patterns,
      // but this defends against patterns that slip through or pre-existing agents.
      if (str.length > MAX_PATTERN_INPUT_LENGTH) {
        return {
          valid: false,
          error: `Input too long for pattern validation (${str.length} chars, max ${MAX_PATTERN_INPUT_LENGTH})`,
        };
      }
      try {
        const regex = new RegExp(patternStr);
        if (!regex.test(str)) {
          return { valid: false, error: `Value "${str}" does not match pattern: ${patternStr}` };
        }
        return { valid: true, normalized: str };
      } catch (err) {
        return {
          valid: false,
          error: `Invalid pattern "${patternStr}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Pass-through types ───────────────────────────────────────────────
    case 'string':
    case 'text':
    case 'free_text':
    case 'location':
    default:
      return { valid: true, normalized: value };
  }
}
