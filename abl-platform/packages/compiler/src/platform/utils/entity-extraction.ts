/**
 * Entity Extraction Utilities
 *
 * Shared TypeScript entity extraction for runtime use.
 * Mirrors the Python template generation logic but runs in TS.
 *
 * Date extraction delegates to chrono-node via ./date-extraction.ts
 * Phone extraction delegates to libphonenumber-js via ./phone-extraction.ts
 */

import { getDateFormat, getDecimalSeparator } from '../nlu/language.js';
import { extractDatesFromText, type DateExtractionOptions } from './date-extraction.js';
import { extractPhoneFromText } from './phone-extraction.js';

// =============================================================================
// DEFAULT CONFIGURATIONS
// =============================================================================

/**
 * @deprecated Use config.additionalDestinations instead. Hardcoded city lists
 * violate domain agnosticism. Kept as empty array for backward compatibility.
 */
export const DEFAULT_DESTINATIONS: string[] = [];

export const MONTH_MAP: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** Locale-specific month maps */
export const LOCALE_MONTH_MAPS: Record<string, Record<string, number>> = {
  en: MONTH_MAP,
  es: {
    enero: 1,
    ene: 1,
    febrero: 2,
    feb: 2,
    marzo: 3,
    mar: 3,
    abril: 4,
    abr: 4,
    mayo: 5,
    may: 5,
    junio: 6,
    jun: 6,
    julio: 7,
    jul: 7,
    agosto: 8,
    ago: 8,
    septiembre: 9,
    sep: 9,
    sept: 9,
    octubre: 10,
    oct: 10,
    noviembre: 11,
    nov: 11,
    diciembre: 12,
    dic: 12,
  },
  fr: {
    janvier: 1,
    janv: 1,
    février: 2,
    fév: 2,
    fevrier: 2,
    mars: 3,
    avril: 4,
    avr: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    juil: 7,
    août: 8,
    aout: 8,
    septembre: 9,
    sept: 9,
    octobre: 10,
    oct: 10,
    novembre: 11,
    nov: 11,
    décembre: 12,
    déc: 12,
    decembre: 12,
  },
  de: {
    januar: 1,
    jan: 1,
    februar: 2,
    feb: 2,
    märz: 3,
    mär: 3,
    maerz: 3,
    april: 4,
    apr: 4,
    mai: 5,
    juni: 6,
    jun: 6,
    juli: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    oktober: 10,
    okt: 10,
    november: 11,
    nov: 11,
    dezember: 12,
    dez: 12,
  },
  pt: {
    janeiro: 1,
    jan: 1,
    fevereiro: 2,
    fev: 2,
    março: 3,
    mar: 3,
    marco: 3,
    abril: 4,
    abr: 4,
    maio: 5,
    mai: 5,
    junho: 6,
    jun: 6,
    julho: 7,
    jul: 7,
    agosto: 8,
    ago: 8,
    setembro: 9,
    set: 9,
    outubro: 10,
    out: 10,
    novembro: 11,
    nov: 11,
    dezembro: 12,
    dez: 12,
  },
  it: {
    gennaio: 1,
    gen: 1,
    febbraio: 2,
    feb: 2,
    marzo: 3,
    mar: 3,
    aprile: 4,
    apr: 4,
    maggio: 5,
    mag: 5,
    giugno: 6,
    giu: 6,
    luglio: 7,
    lug: 7,
    agosto: 8,
    ago: 8,
    settembre: 9,
    set: 9,
    ottobre: 10,
    ott: 10,
    novembre: 11,
    nov: 11,
    dicembre: 12,
    dic: 12,
  },
};

/**
 * Map BCP-47 language prefix to a default ISO 3166-1 alpha-2 country code.
 * Used by phone extraction to infer the default country from a locale.
 */
const LOCALE_TO_DEFAULT_COUNTRY: Record<string, string> = {
  en: 'US',
  es: 'ES',
  fr: 'FR',
  de: 'DE',
  pt: 'BR',
  it: 'IT',
  nl: 'NL',
  ja: 'JP',
  zh: 'CN',
  ko: 'KR',
  ru: 'RU',
  ar: 'SA',
  hi: 'IN',
  sv: 'SE',
  da: 'DK',
  fi: 'FI',
  nb: 'NO',
  pl: 'PL',
  tr: 'TR',
  uk: 'UA',
};

/**
 * Resolve a BCP-47 locale to a default country code for phone extraction.
 * Falls back to 'US' for unknown locales.
 */
function localeToCountry(locale?: string): string {
  if (!locale) return 'US';
  // Handle full BCP-47 with region: en-GB -> GB
  const parts = locale.split('-');
  if (parts.length >= 2 && parts[1].length === 2) {
    return parts[1].toUpperCase();
  }
  // Fall back to language prefix mapping
  const lang = parts[0].toLowerCase();
  return LOCALE_TO_DEFAULT_COUNTRY[lang] ?? 'US';
}

/**
 * Get the month map for a given locale, falling back to English.
 */
function getMonthMap(locale?: string): Record<string, number> {
  if (!locale) return MONTH_MAP;
  const lang = locale.split('-')[0].toLowerCase();
  // Merge locale-specific map with English so both work
  const localeMap = LOCALE_MONTH_MAPS[lang];
  if (localeMap && lang !== 'en') {
    return { ...MONTH_MAP, ...localeMap };
  }
  return MONTH_MAP;
}

// =============================================================================
// TYPES
// =============================================================================

export interface ExtractedEntities {
  /** Extracted destination/location (from config.additionalDestinations) */
  destination?: string;
  /** Extracted date values */
  date?: string;
  /** Dynamic entity fields — populated by type-based extraction */
  [key: string]: unknown;
}

export interface EntityExtractionConfig {
  /** Additional destinations to recognize */
  additionalDestinations?: string[];
  /** Custom number fields to extract */
  numberFields?: Array<{ name: string; keywords: string[] }>;
}

// =============================================================================
// DATE EXTRACTION
// =============================================================================

/**
 * Parse a date string like "Mar 6" or "March 15" or "March 15, 2026" to ISO format
 */
function parseDateStr(dateStr: string, locale?: string): string | null {
  const cleaned = dateStr.trim().toLowerCase();
  const currentYear = new Date().getFullYear();
  const monthMap = getMonthMap(locale);

  for (const [monthName, monthNum] of Object.entries(monthMap)) {
    // Match with optional year: "March 15" or "March 15, 2026"
    const pattern = new RegExp(`${monthName}\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`, 'i');
    const match = cleaned.match(pattern);
    if (match) {
      const day = parseInt(match[1], 10);
      const year = match[2] ? parseInt(match[2], 10) : currentYear;
      return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Also try to parse using Date constructor as fallback
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  } catch {
    // Ignore parsing errors
  }

  return null;
}

/**
 * Extract dates from text
 */
export function extractDates(text: string, locale?: string): Record<string, string> {
  const textLower = text.toLowerCase().trim();
  const result: Record<string, string> = {};
  const now = new Date();

  // Handle relative dates first
  if (textLower === 'today') {
    result.date = now.toISOString().split('T')[0];
    return result;
  }
  if (textLower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    result.date = tomorrow.toISOString().split('T')[0];
    return result;
  }
  if (textLower.startsWith('next ')) {
    const unit = textLower.replace('next ', '');
    const date = new Date(now);
    if (unit === 'week') {
      date.setDate(date.getDate() + 7);
    } else if (unit === 'month') {
      date.setMonth(date.getMonth() + 1);
    } else {
      // Day of week
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(unit);
      if (targetDay !== -1) {
        const currentDay = date.getDay();
        const daysUntil = (targetDay - currentDay + 7) % 7 || 7;
        date.setDate(date.getDate() + daysUntil);
      }
    }
    result.date = date.toISOString().split('T')[0];
    return result;
  }

  // Numeric date format: MM/DD/YYYY or DD/MM/YYYY depending on locale
  const numericDateMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (numericDateMatch) {
    const dateFormat = getDateFormat(locale || 'en');
    let month: number, day: number;
    if (dateFormat === 'DMY') {
      // DD/MM/YYYY (most of world)
      day = parseInt(numericDateMatch[1], 10);
      month = parseInt(numericDateMatch[2], 10);
    } else {
      // MM/DD/YYYY (US)
      month = parseInt(numericDateMatch[1], 10);
      day = parseInt(numericDateMatch[2], 10);
    }
    let year = parseInt(numericDateMatch[3], 10);
    if (year < 100) year += 2000; // Handle 2-digit years
    result.date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return result;
  }

  // Date range patterns: "Mar 6 to Mar 10", "from March 15 to March 20"
  const rangePatterns = [
    /from\s+([a-z]+\s+\d{1,2})\s+to\s+([a-z]+\s+\d{1,2})/i,
    /([a-z]+\s+\d{1,2})\s+to\s+([a-z]+\s+\d{1,2})/i,
    /([a-z]+\s+\d{1,2})\s*[-–]\s*([a-z]+\s+\d{1,2})/i,
  ];

  for (const pattern of rangePatterns) {
    const match = textLower.match(pattern);
    if (match) {
      const checkin = parseDateStr(match[1], locale);
      const checkout = parseDateStr(match[2], locale);
      if (checkin) result.checkin = checkin;
      if (checkout) result.checkout = checkout;
      return result;
    }
  }

  // Single date patterns
  const singlePatterns = [
    /on\s+([a-z]+\s+\d{1,2})/i,
    /([a-z]+\s+\d{1,2})(?:th|st|nd|rd)?(?:\s|$|,)/i,
  ];

  for (const pattern of singlePatterns) {
    const match = textLower.match(pattern);
    if (match) {
      const date = parseDateStr(match[1], locale);
      if (date) {
        result.date = date;
        return result;
      }
    }
  }

  // ISO format: 2026-03-15
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    result.date = isoMatch[1];
  }

  return result;
}

// =============================================================================
// NUMBER EXTRACTION
// =============================================================================

/**
 * Extract numbers with keywords (guests, rooms, nights, etc.)
 */
export function extractNumbers(
  text: string,
  config?: EntityExtractionConfig,
  locale?: string,
): Record<string, number> {
  const textLower = text.toLowerCase();
  const result: Record<string, number> = {};

  // Number field patterns are provided by the caller via config.numberFields.
  // No hardcoded domain-specific defaults (guests/rooms/nights).
  const fields = config?.numberFields || [];
  const decimalSep = getDecimalSeparator(locale || 'en');

  for (const field of fields) {
    const keywords = field.keywords.join('|');
    const pattern = new RegExp(`(\\d+)\\s*(?:${keywords})`, 'i');
    const match = textLower.match(pattern);
    if (match) {
      result[field.name] = parseInt(match[1], 10);
    }
  }

  // Also try extracting standalone numbers with locale decimal separator
  if (decimalSep === ',' && Object.keys(result).length === 0) {
    // For comma-decimal locales, handle "1.000" as 1000 and "1,5" as 1.5
    const commaDecimalMatch = textLower.match(/(\d+),(\d+)/);
    if (commaDecimalMatch && fields.length > 0) {
      const value = parseFloat(`${commaDecimalMatch[1]}.${commaDecimalMatch[2]}`);
      if (!isNaN(value)) {
        result[fields[0].name] = value;
      }
    }
  }

  return result;
}

// =============================================================================
// DESTINATION EXTRACTION
// =============================================================================

/**
 * Extract destination/city from text
 */
export function extractDestination(text: string, config?: EntityExtractionConfig): string | null {
  const textLower = text.toLowerCase();

  // When additionalDestinations are provided, use ONLY those (no domain contamination).
  // When not provided, fall back to DEFAULT_DESTINATIONS.
  const destinations = config?.additionalDestinations
    ? [...config.additionalDestinations]
    : [...DEFAULT_DESTINATIONS];

  // Sort by length descending to match longer names first (e.g., "New York" before "York")
  destinations.sort((a, b) => b.length - a.length);

  for (const city of destinations) {
    if (textLower.includes(city.toLowerCase())) {
      // Return properly capitalized
      return city
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
  }

  return null;
}

// =============================================================================
// COMBINED EXTRACTION
// =============================================================================

/**
 * Extract all entities from user text
 */
export function extractAllEntities(
  text: string,
  config?: EntityExtractionConfig,
  locale?: string,
): ExtractedEntities {
  const entities: ExtractedEntities = {};

  // Extract dates
  const dates = extractDates(text, locale);
  Object.assign(entities, dates);

  // Extract numbers
  const numbers = extractNumbers(text, config, locale);
  Object.assign(entities, numbers);

  // Extract destination
  const dest = extractDestination(text, config);
  if (dest) {
    entities.destination = dest;
  }

  return entities;
}

// =============================================================================
// FIELD-BASED EXTRACTION (for COLLECT steps)
// =============================================================================

/**
 * Extract entities based on expected field names
 * This is the main function used by runtime for COLLECT steps
 */
export function extractEntitiesForFields(
  userMessage: string,
  fields: string[],
  config?: EntityExtractionConfig,
  fieldTypes?: Record<string, string>,
  locale?: string,
  dateOptions?: DateExtractionOptions,
): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  const message = userMessage.trim();

  // First, extract all entities we can find (used for number/destination heuristics)
  const allEntities = extractAllEntities(message, config, locale);

  // Lazy-initialized chrono-node dates — computed once on first date-typed field
  let chronoDates: import('./date-extraction.js').ExtractedDate[] | null = null;
  // Counter for positional date assignment (first date field → first date, etc.)
  let dateFieldIndex = 0;
  // Counter for positional number assignment
  let numberFieldIndex = 0;
  // Strip date-like patterns before extracting standalone numbers to avoid
  // matching day/month digits (e.g. "Mar 6" → 6, "Mar 10" → 10).
  let textForNumbers = message;
  const monthMap = getMonthMap(locale);
  const monthNamePattern = Object.keys(monthMap).join('|');
  textForNumbers = textForNumbers.replace(
    new RegExp(`(?:${monthNamePattern})\\s+\\d{1,2}(?:,?\\s*\\d{4})?`, 'gi'),
    '',
  );
  textForNumbers = textForNumbers.replace(/\d{4}-\d{2}-\d{2}/g, '');
  textForNumbers = textForNumbers.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '');
  const numberMatches = [...textForNumbers.matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));

  // Map extracted entities to requested fields using declared types only.
  // No field-name heuristics — extraction is type-driven.
  for (const field of fields) {
    const fieldType = fieldTypes?.[field]?.toLowerCase() || '';

    // Determine extraction category from declared type only
    const isDate = fieldType === 'date' || fieldType === 'datetime';
    const isNumber = fieldType === 'number' || fieldType === 'integer' || fieldType === 'int';
    const isEmail = fieldType === 'email';
    const isPhone = fieldType === 'phone' || fieldType === 'tel';
    const isDestination = fieldType === 'location' || fieldType === 'destination';

    if (isDate) {
      // Use chrono-node for robust date extraction (multilingual, relative, ranges)
      if (!chronoDates) {
        chronoDates = extractDatesFromText(message, locale || 'en', dateOptions);
      }

      // Positional assignment: first date field gets first date, second gets second, etc.
      if (chronoDates.length > dateFieldIndex) {
        extracted[field] = chronoDates[dateFieldIndex].value;
      } else if (chronoDates.length > 0) {
        // Fewer dates than fields — reuse last available date
        extracted[field] = chronoDates[chronoDates.length - 1].value;
      }
      dateFieldIndex++;
    } else if (isNumber) {
      // Prefer keyword-matched numbers from allEntities (via extractNumbers config)
      const keywordValue = allEntities[field];
      if (typeof keywordValue === 'number') {
        extracted[field] = keywordValue;
      } else if (numberMatches.length > numberFieldIndex) {
        // Fallback: positional assignment from date-stripped text
        extracted[field] = numberMatches[numberFieldIndex];
      }
      numberFieldIndex++;
    } else if (isDestination) {
      if (allEntities.destination) {
        extracted[field] = allEntities.destination;
      }
    } else if (isEmail) {
      const emailMatch = message.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch) {
        extracted[field] = emailMatch[1];
      }
    } else if (isPhone) {
      // Use libphonenumber-js for robust phone extraction and E.164 normalization
      const country = localeToCountry(locale);
      const phoneResult = extractPhoneFromText(message, country);
      if (phoneResult) {
        extracted[field] = phoneResult.e164;
      }
    } else if (fields.length === 1) {
      // Single untyped field — raw input is the only reasonable assignment
      extracted[field] = message;
    }
    // Multi-field with no declared type: leave empty for progressive collection
  }

  // If only one field and nothing extracted, store raw input
  if (fields.length === 1 && extracted[fields[0]] === undefined) {
    extracted[fields[0]] = message;
  }

  return extracted;
}
