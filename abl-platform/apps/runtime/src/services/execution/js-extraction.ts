/**
 * Tier 1: In-process JS extraction (chrono-node, libphonenumber-js, regex).
 *
 * Pure function that returns partial results for fields whose type it can handle
 * (date, datetime, phone, email, currency, number, integer, float). Unknown field
 * types are silently skipped so the caller can fall through to higher-cost tiers
 * (sidecar ML, LLM).
 *
 * This module is intentionally dependency-light and domain-agnostic — it reads
 * field.type from the IR and delegates to the appropriate JS library or regex
 * extractor. No domain-specific field names are checked.
 */
import {
  extractDatesFromText,
  extractPhoneFromText,
  type DateExtractionOptions,
} from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';
import {
  normalizeEnumValue,
  normalizePhone,
  TRUTHY_VALUES,
  FALSY_VALUES,
} from './extraction-validation.js';

const log = createLogger('js-extraction');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal field descriptor — mirrors GatherFieldIR but only what Tier 1 needs */
export interface JSExtractionField {
  name: string;
  type: string;
  /** Allowed values for enum fields */
  values?: string[];
  /** Synonym map for enum fields: canonical → aliases */
  synonyms?: Record<string, string[]>;
}

/** Default country code for phone extraction when locale doesn't include region */
const DEFAULT_PHONE_COUNTRY = 'US';
/** Fallback matcher for phone-like substrings when libphonenumber can't find one directly. */
const PHONE_CANDIDATE_REGEX = /(?:\+\d[\d\s().-]{5,}\d|\b\d{7,15}\b)/g;

// ---------------------------------------------------------------------------
// Field types handled by Tier 1
// ---------------------------------------------------------------------------

/** Field types that Tier 1 JS extraction can handle */
const DATE_TYPES = new Set(['date', 'datetime']);
const PHONE_TYPES = new Set(['phone']);
const EMAIL_TYPES = new Set(['email']);
const CURRENCY_TYPES = new Set(['currency']);
const NUMBER_TYPES = new Set(['number', 'integer', 'float']);
// Fixed-size constant sets — bounded at definition time, no eviction needed.
const BOOLEAN_TYPES = new Set(['boolean']);
const ENUM_TYPES = new Set(['enum']);

// ---------------------------------------------------------------------------
// Regex patterns for email, currency, and number extraction
// ---------------------------------------------------------------------------

/** RFC 5322-ish email pattern — sufficient for Tier 1 extraction */
const EMAIL_REGEX_GLOBAL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Currency symbol prefix pattern: $49.99, €120, £75.50, ¥5000, ₹250, ₣80, R$150, ₩5000
 * Supports optional comma thousands separators.
 */
const CURRENCY_SYMBOL_REGEX = /([€£¥₹₣₩]|R\$|(?:US)?\$)\s*([\d,]+(?:\.\d{1,2})?)/;

/**
 * Currency code suffix pattern: 250 USD, 100 EUR, 1500.75 GBP
 * Supports ISO 4217 codes for common currencies.
 */
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

/**
 * Number extraction pattern.
 * Matches standalone numbers (integer or decimal) not embedded in dates or phone patterns.
 * Negative lookbehind avoids matching day/month digits in date-like patterns (e.g. "3/15").
 * Negative lookahead avoids matching numbers followed by date separators.
 */
const NUMBER_REGEX = /(?<!\d[/-])\b(\d+(?:\.\d+)?)\b(?![/-]\d)/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract entity values from text using in-process JS libraries.
 *
 * Handles:
 * - date / datetime fields via chrono-node (multilingual, relative/absolute)
 * - phone fields via libphonenumber-js (E.164 normalization)
 * - email fields via regex (RFC 5322-ish pattern)
 * - currency fields via regex (symbol prefix or ISO code suffix)
 * - number / integer / float fields via regex (standalone numeric tokens)
 *
 * Returns a partial record keyed by field name. Fields that cannot be extracted
 * (no match or unsupported type) are omitted from the result.
 *
 * @param text - User message to extract from
 * @param fields - Array of field descriptors with name and type
 * @param locale - BCP-47 locale code (e.g. 'en', 'en-US', 'fr')
 * @returns Partial record of extracted values keyed by field name
 */
export function extractWithJSLibs(
  text: string,
  fields: JSExtractionField[],
  locale: string,
  dateOptions: DateExtractionOptions = {},
): Record<string, unknown> {
  if (!text || !text.trim() || fields.length === 0) {
    return {};
  }

  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const fieldType = (field.type ?? '').toLowerCase();

    if (DATE_TYPES.has(fieldType)) {
      try {
        const dates = extractDatesFromText(text, locale, dateOptions);
        if (dates.length === 1) {
          result[field.name] = dates[0].value;
        } else if (dates.length > 1) {
          result[field.name] = dates.map((d) => d.value);
        }
      } catch (err) {
        log.debug('Date extraction failed for field', {
          field: field.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (PHONE_TYPES.has(fieldType)) {
      try {
        // Extract country code from locale (e.g. 'en-US' -> 'US', 'fr' -> 'US')
        const localeParts = locale.split('-');
        const country =
          localeParts.length > 1 ? localeParts[1].toUpperCase() : DEFAULT_PHONE_COUNTRY;

        const phone = extractPhoneFromText(text, country);
        if (phone) {
          result[field.name] = phone.e164;
          continue;
        }

        const fallbackCandidate = text.match(PHONE_CANDIDATE_REGEX)?.[0];
        if (fallbackCandidate) {
          const normalized = normalizePhone(fallbackCandidate, country);
          if (normalized) {
            result[field.name] = normalized;
          }
        }
      } catch (err) {
        log.debug('Phone extraction failed for field', {
          field: field.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (EMAIL_TYPES.has(fieldType)) {
      try {
        const matches = [...text.matchAll(EMAIL_REGEX_GLOBAL)];
        if (matches.length === 1) {
          result[field.name] = matches[0][0];
        } else if (matches.length > 1) {
          result[field.name] = matches.map((m) => m[0]);
        }
      } catch (err) {
        log.debug('Email extraction failed for field', {
          field: field.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (CURRENCY_TYPES.has(fieldType)) {
      try {
        // Try symbol-prefix first: $49.99, €120, £75.50
        const symbolMatch = text.match(CURRENCY_SYMBOL_REGEX);
        if (symbolMatch) {
          result[field.name] = {
            value: parseFloat(symbolMatch[2].replace(/,/g, '')),
            currency: CURRENCY_SYMBOL_MAP[symbolMatch[1]] ?? 'USD',
          };
        } else {
          // Try code-suffix: 250 USD, 100 EUR
          const codeMatch = text.match(CURRENCY_CODE_REGEX);
          if (codeMatch) {
            result[field.name] = {
              value: parseFloat(codeMatch[1].replace(/,/g, '')),
              currency: codeMatch[2].toUpperCase(),
            };
          }
        }
      } catch (err) {
        log.debug('Currency extraction failed for field', {
          field: field.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (NUMBER_TYPES.has(fieldType)) {
      try {
        const numMatch = text.match(NUMBER_REGEX);
        if (numMatch) {
          result[field.name] = parseFloat(numMatch[1]);
        }
      } catch (err) {
        log.debug('Number extraction failed for field', {
          field: field.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (BOOLEAN_TYPES.has(fieldType)) {
      const lower = text.toLowerCase().trim();
      if (TRUTHY_VALUES.has(lower)) {
        result[field.name] = true;
      } else if (FALSY_VALUES.has(lower)) {
        result[field.name] = false;
      }
    } else if (ENUM_TYPES.has(fieldType)) {
      if (field.values && field.values.length > 0) {
        const normalized = normalizeEnumValue(text.trim(), field.values, field.synonyms);
        if (normalized !== null) {
          result[field.name] = normalized;
        }
      }
    }
    // Unknown field types are silently skipped — Tier 2/3/4 will handle them
  }

  return result;
}

/**
 * Check whether a field type is handled by Tier 1 JS extraction.
 * Useful for the tier router to partition fields between tiers.
 */
export function isJSExtractableType(fieldType: string): boolean {
  const normalized = (fieldType ?? '').toLowerCase();
  return (
    DATE_TYPES.has(normalized) ||
    PHONE_TYPES.has(normalized) ||
    EMAIL_TYPES.has(normalized) ||
    CURRENCY_TYPES.has(normalized) ||
    NUMBER_TYPES.has(normalized) ||
    BOOLEAN_TYPES.has(normalized) ||
    ENUM_TYPES.has(normalized)
  );
}
