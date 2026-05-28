/**
 * Shared validation and normalization utilities for entity extraction.
 * Pure functions — no session state, no side effects.
 *
 * Normalization uses the same Tier 1 JS libraries (libphonenumber-js, chrono-node)
 * so that LLM-extracted values receive identical format normalization as
 * JS-extracted values (E.164 phone, ISO date, lowercase email, numeric currency).
 */
import {
  extractDatesFromText,
  extractPhoneFromText,
  type DateExtractionOptions,
} from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';
import { EMAIL_REGEX } from './intrinsic-validation.js';

const log = createLogger('extraction-validation');

export interface ExtractionField {
  name: string;
  type?: string;
  prompt?: string;
  required?: boolean;
  enum_values?: string[];
  synonyms?: Record<string, string[]>;
}

export interface ValidationResult {
  valid: boolean;
  normalized?: unknown;
  error?: string;
}

export interface DateNormalizationOptions extends DateExtractionOptions {
  locale?: string;
}

// Fixed-size constant sets — MAX_SIZE is bounded at definition time, no eviction needed.
export const TRUTHY_VALUES = new Set(['true', 'yes', '1', 'y', 'si', 'sí']);
export const FALSY_VALUES = new Set(['false', 'no', '0', 'n']);

/**
 * Currency symbol prefix pattern: $49.99, €120, £75.50, ¥5000, ₹250, ₣80, R$150, ₩5000
 * Matches the same patterns as js-extraction.ts Tier 1.
 */
const CURRENCY_SYMBOL_REGEX = /([€£¥₹₣₩]|R\$|(?:US)?\$)\s*([\d,]+(?:\.\d{1,2})?)/;

/** Currency code suffix pattern: 250 USD, 100 EUR */
const CURRENCY_CODE_REGEX = /([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|BRL|KRW)\b/i;

/** Map currency symbols to ISO 4217 codes */
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₣': 'CHF',
  R$: 'BRL',
  '₩': 'KRW',
};

/** Default country code for phone normalization */
const DEFAULT_PHONE_COUNTRY = 'US';

/** Accept loosely formatted phone-like strings before falling back to null. */
const PHONE_LIKE_VALUE_REGEX = /^\+?[\d\s().-]{7,20}$/;

// ── Shared normalizers ──────────────────────────────────────────────────────
// Used by both validateExtractedValue (GATHER path) and validateIntrinsic
// (entity pipeline) to ensure identical normalization regardless of code path.

/**
 * Minimum number of digits required for a string to be considered phone-like.
 * Most national numbers have at least 7 digits; E.164 has 7-15.
 */
const MIN_PHONE_DIGITS = 7;

/**
 * Normalize a phone string to E.164 format using libphonenumber-js.
 * Returns the E.164 string, or null if the value doesn't contain enough
 * digits to be a plausible phone number.
 */
export function normalizePhone(
  value: string,
  defaultCountry: string = DEFAULT_PHONE_COUNTRY,
): string | null {
  // Already E.164 — pass through
  if (/^\+\d{7,15}$/.test(value)) return value;
  try {
    const phone = extractPhoneFromText(value, defaultCountry);
    if (phone) return phone.e164;
  } catch (err) {
    log.debug('Phone normalization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const trimmed = value.trim();
  if (PHONE_LIKE_VALUE_REGEX.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= MIN_PHONE_DIGITS && digits.length <= 15) {
      return `+${digits}`;
    }
  }

  return null;
}

/**
 * Normalize a date/datetime string to ISO YYYY-MM-DD format using chrono-node.
 * Returns ISO string, the original value if already ISO or Date.parse-able, or null if invalid.
 */
export function normalizeDate(
  value: string,
  options: DateNormalizationOptions = {},
): string | null {
  // Already ISO format — pass through
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  // Natural-language date — normalize via chrono-node
  try {
    const dates = extractDatesFromText(value, options.locale ?? 'en', {
      referenceInstant: options.referenceInstant,
      timezone: options.timezone,
    });
    if (dates.length > 0) return dates[0].value;
  } catch (err) {
    log.debug('Date normalization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Fallback: accept if Date.parse can handle it
  if (!isNaN(Date.parse(value))) return value;
  return null;
}

/**
 * Normalize a currency value to a plain number.
 * Handles: plain numbers, {value, currency} objects, "$3,500" strings, "250 USD" strings.
 * Returns the numeric value or null if unparseable.
 */
export function normalizeCurrency(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value;
  // Structured {value, currency} from Tier 1
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as Record<string, unknown>).value;
    if (typeof inner === 'number' && !isNaN(inner)) return inner;
  }
  if (typeof value === 'string') {
    const symbolMatch = value.match(CURRENCY_SYMBOL_REGEX);
    if (symbolMatch) return parseFloat(symbolMatch[2].replace(/,/g, ''));
    const codeMatch = value.match(CURRENCY_CODE_REGEX);
    if (codeMatch) return parseFloat(codeMatch[1].replace(/,/g, ''));
    const parsed = Number(value.replace(/,/g, ''));
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Normalize a raw extracted value to a canonical enum value.
 *
 * 4-step matching:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Synonym lookup (case-insensitive against synonym lists)
 * 4. Substring match (prefer shortest matching option)
 */
export function normalizeEnumValue(
  value: string,
  enumValues: string[],
  synonyms?: Record<string, string[]>,
): string | null {
  if (enumValues.length === 0) return null;

  // 1. Exact match
  if (enumValues.includes(value)) return value;

  // 2. Case-insensitive match
  const lower = value.toLowerCase();
  const ciMatch = enumValues.find((o) => o.toLowerCase() === lower);
  if (ciMatch) return ciMatch;

  // 3. Synonym lookup
  if (synonyms) {
    for (const [canonical, syns] of Object.entries(synonyms)) {
      if (!enumValues.includes(canonical)) continue;
      for (const syn of syns) {
        if (syn.toLowerCase() === lower) return canonical;
      }
    }
  }

  // 4. Substring match — prefer shortest matching option
  const substringMatches: string[] = [];
  for (const option of enumValues) {
    const optLower = option.toLowerCase();
    if (lower.includes(optLower) || optLower.includes(lower)) {
      substringMatches.push(option);
    }
  }
  if (substringMatches.length > 0) {
    substringMatches.sort((a, b) => a.length - b.length);
    return substringMatches[0];
  }

  return null;
}

/**
 * Validate and normalize an extracted value against a field definition.
 * Handles type coercion and enum normalization.
 * Does NOT run ValidationRule checks (pattern, range, custom).
 */
export function validateExtractedValue(
  field: ExtractionField,
  value: unknown,
  options: DateNormalizationOptions = {},
): ValidationResult {
  const fieldType = (field.type ?? 'string').toLowerCase();

  switch (fieldType) {
    case 'string':
    case 'text':
    case 'free_text':
      return {
        valid: true,
        normalized: typeof value === 'string' ? value : String(value),
      };

    case 'number':
    case 'integer':
    case 'float': {
      if (typeof value === 'number' && !isNaN(value)) return { valid: true, normalized: value };
      const parsed = Number(value);
      if (!isNaN(parsed)) return { valid: true, normalized: parsed };
      return {
        valid: false,
        error: `Expected a number for "${field.name}", got "${value}"`,
      };
    }

    case 'currency': {
      const amount = normalizeCurrency(value);
      if (amount !== null) return { valid: true, normalized: amount };
      return {
        valid: false,
        error: `Expected a currency value for "${field.name}", got "${value}"`,
      };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { valid: true, normalized: value };
      const str = String(value).toLowerCase().trim();
      if (TRUTHY_VALUES.has(str)) return { valid: true, normalized: true };
      if (FALSY_VALUES.has(str)) return { valid: true, normalized: false };
      return {
        valid: false,
        error: `Expected a boolean for "${field.name}", got "${value}"`,
      };
    }

    case 'date':
    case 'datetime': {
      if (typeof value !== 'string' || value.length === 0) {
        return { valid: false, error: `Expected a date for "${field.name}", got "${value}"` };
      }
      const isoDate = normalizeDate(value, options);
      if (isoDate !== null) return { valid: true, normalized: isoDate };
      return { valid: false, error: `Expected a date for "${field.name}", got "${value}"` };
    }

    case 'email':
      if (typeof value === 'string' && EMAIL_REGEX.test(value))
        return { valid: true, normalized: value.toLowerCase() };
      return {
        valid: false,
        error: `Expected an email for "${field.name}", got "${value}"`,
      };

    case 'phone': {
      if (typeof value !== 'string' || value.length === 0) {
        return {
          valid: false,
          error: `Expected a phone number for "${field.name}", got "${value}"`,
        };
      }
      const normalized = normalizePhone(value);
      if (normalized === null) {
        return {
          valid: false,
          error: `Expected a phone number for "${field.name}", got "${value}"`,
        };
      }
      return { valid: true, normalized };
    }

    case 'enum': {
      const enumValues = field.enum_values ?? [];
      if (enumValues.length === 0) return { valid: true, normalized: value };
      const normalized = normalizeEnumValue(String(value), enumValues, field.synonyms);
      if (normalized !== null) return { valid: true, normalized };
      return {
        valid: false,
        error: `Invalid value "${value}" for "${field.name}". Allowed: ${enumValues.join(', ')}`,
      };
    }

    default:
      return { valid: true, normalized: value };
  }
}

/**
 * Apply validation and normalization to a batch of extracted values.
 */
export function validateExtractedBatch(
  fields: ExtractionField[],
  extracted: Record<string, unknown>,
  options: DateNormalizationOptions = {},
): { valid: Record<string, unknown>; invalid: Record<string, string> } {
  const valid: Record<string, unknown> = {};
  const invalid: Record<string, string> = {};

  for (const [name, value] of Object.entries(extracted)) {
    if (value === undefined || value === null || value === '') continue;

    const field = fields.find((f) => f.name === name);
    if (!field) {
      valid[name] = value;
      continue;
    }

    // For fields with enum_values but type !== 'enum', still try normalization
    if (field.enum_values && field.enum_values.length > 0 && typeof value === 'string') {
      const normalized = normalizeEnumValue(value, field.enum_values, field.synonyms);
      if (normalized !== null) {
        valid[name] = normalized;
        continue;
      }
    }

    const result = validateExtractedValue(field, value, options);
    if (result.valid) {
      valid[name] = result.normalized;
    } else {
      invalid[name] = result.error ?? `Invalid value for ${name}`;
      log.debug('Extracted value rejected by validation', {
        field: name,
        type: field.type,
        rawValue: value,
        reason: result.error,
      });
    }
  }

  return { valid, invalid };
}
