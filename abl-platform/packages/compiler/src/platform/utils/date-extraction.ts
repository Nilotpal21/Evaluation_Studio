/**
 * Date extraction using chrono-node (multilingual, relative/absolute/range).
 * Replaces regex-based extractDates() in entity-extraction.ts with robust
 * NLP-backed date parsing supporting relative dates, absolute dates,
 * date ranges, and multiple locales.
 */
import * as chrono from 'chrono-node';

export interface ExtractedDate {
  /** Always 'date' for date extractions */
  type: 'date';
  /** ISO 8601 date string (YYYY-MM-DD) */
  value: string;
  /** Original matched text from the input */
  text: string;
  /** Character position in the input string */
  index: number;
}

export interface DateExtractionOptions {
  /** Reference instant used to anchor relative-date expressions. */
  referenceInstant?: Date;
  /** IANA timezone used for relative-date anchoring and ISO date formatting. */
  timezone?: string;
}

/** Map BCP-47 locale prefix to chrono locale-specific casual parser */
const LOCALE_PARSERS: Record<string, chrono.Chrono> = {
  en: chrono.en.casual,
  es: chrono.es.casual,
  fr: chrono.fr.casual,
  de: chrono.de.casual,
  pt: chrono.pt.casual,
  ja: chrono.ja.casual,
  nl: chrono.nl.casual,
  zh: chrono.zh.casual,
  ru: chrono.ru.casual,
  uk: chrono.uk.casual,
  it: chrono.it.casual,
  sv: chrono.sv.casual,
};

const DEFAULT_LOCALE = 'en';
const DEFAULT_TIMEZONE_OFFSET_MINUTES = 0;

const RELATIVE_FROM_ANCHOR_REGEX =
  /\b(?:(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(day|days|week|weeks)\s+from\s+(today|tomorrow)\b/gi;

const WORD_NUMBER_MAP: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * Resolve a BCP-47 locale string to a chrono parser instance.
 * Falls back to the English casual parser for unsupported locales.
 */
function getParser(locale: string): chrono.Chrono {
  const prefix = locale.split('-')[0].toLowerCase();
  return LOCALE_PARSERS[prefix] ?? chrono.en.casual;
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUTCDateParts(year: number, month: number, day: number): string {
  return `${year}-${padTwoDigits(month)}-${padTwoDigits(day)}`;
}

function getDatePartsInTimeZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  return { year, month, day };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const second = Number(parts.find((part) => part.type === 'second')?.value);

  const utcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((utcTimestamp - instant.getTime()) / 60_000);
}

function resolveReferenceInstant(referenceInstant?: Date): Date {
  if (referenceInstant instanceof Date && !Number.isNaN(referenceInstant.getTime())) {
    return new Date(referenceInstant.getTime());
  }
  return new Date();
}

function resolveTimeZoneContext(
  referenceInstant: Date,
  timeZone?: string,
): { timeZone?: string; timezoneOffsetMinutes: number } {
  if (timeZone && isValidTimeZone(timeZone)) {
    return {
      timeZone,
      timezoneOffsetMinutes: getTimeZoneOffsetMinutes(referenceInstant, timeZone),
    };
  }

  return {
    timezoneOffsetMinutes: DEFAULT_TIMEZONE_OFFSET_MINUTES,
  };
}

/**
 * Format a Date object to an ISO 8601 date-only string (YYYY-MM-DD).
 * Uses the target timezone or offset explicitly so host-local getters never
 * influence the formatted calendar date.
 */
function toISODate(
  date: Date,
  context: { timeZone?: string; timezoneOffsetMinutes: number },
): string {
  if (context.timeZone) {
    const { year, month, day } = getDatePartsInTimeZone(date, context.timeZone);
    return formatUTCDateParts(year, month, day);
  }

  const shiftedDate = new Date(date.getTime() + context.timezoneOffsetMinutes * 60_000);
  return formatUTCDateParts(
    shiftedDate.getUTCFullYear(),
    shiftedDate.getUTCMonth() + 1,
    shiftedDate.getUTCDate(),
  );
}

function addDaysToISODate(value: string, daysToAdd: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return formatUTCDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getReferenceISODate(
  referenceInstant: Date,
  context: { timeZone?: string; timezoneOffsetMinutes: number },
): string {
  return toISODate(referenceInstant, context);
}

function parseRelativeQuantity(value: string | undefined): number {
  if (!value) {
    return 1;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized in WORD_NUMBER_MAP) {
    return WORD_NUMBER_MAP[normalized];
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function extractRelativeFromAnchorPhrases(
  text: string,
  referenceInstant: Date,
  context: { timeZone?: string; timezoneOffsetMinutes: number },
): { extracted: ExtractedDate[]; sanitizedText: string } {
  const extracted: ExtractedDate[] = [];
  if (!text.trim()) {
    return { extracted, sanitizedText: text };
  }

  RELATIVE_FROM_ANCHOR_REGEX.lastIndex = 0;
  const sanitizedChars = [...text];
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_FROM_ANCHOR_REGEX.exec(text)) !== null) {
    const rawText = match[0];
    const quantity = parseRelativeQuantity(match[1]);
    const unit = match[2].toLowerCase();
    const anchor = match[3].toLowerCase();
    const unitDays = unit.startsWith('week') ? 7 : 1;
    const anchorDays = anchor === 'tomorrow' ? 1 : 0;
    const referenceDate = getReferenceISODate(referenceInstant, context);
    const value = addDaysToISODate(referenceDate, anchorDays + quantity * unitDays);

    extracted.push({
      type: 'date',
      value,
      text: rawText,
      index: match.index,
    });

    for (let index = match.index; index < match.index + rawText.length; index += 1) {
      sanitizedChars[index] = ' ';
    }
  }

  return {
    extracted,
    sanitizedText: sanitizedChars.join(''),
  };
}

/**
 * Extract date entities from natural language text.
 *
 * Supports:
 * - Relative dates: "today", "tomorrow", "next Monday", "in 3 days"
 * - Absolute dates: "March 15, 2026", "15/03/2026", "2026-03-15"
 * - Date ranges: "March 6 to March 10", "next Monday through Friday"
 *   (ranges emit two ExtractedDate entries: one for start, one for end)
 * - Multilingual: en, es, fr, de, pt, ja, nl, zh, ru, uk, it, sv
 *
 * @param text - The input text to extract dates from
 * @param locale - BCP-47 locale code (defaults to 'en')
 * @param options - Optional reference instant and timezone for deterministic parsing
 * @returns Array of extracted date entities, empty if none found
 */
export function extractDatesFromText(
  text: string,
  locale: string = DEFAULT_LOCALE,
  options: DateExtractionOptions = {},
): ExtractedDate[] {
  if (!text.trim()) return [];

  const referenceInstant = resolveReferenceInstant(options.referenceInstant);
  const context = resolveTimeZoneContext(referenceInstant, options.timezone);
  const { extracted: relativeAnchorDates, sanitizedText } = extractRelativeFromAnchorPhrases(
    text,
    referenceInstant,
    context,
  );
  const parser = getParser(locale);
  const results = parser.parse(sanitizedText, {
    instant: referenceInstant,
    timezone: context.timezoneOffsetMinutes,
  });
  const extracted: ExtractedDate[] = [...relativeAnchorDates];

  for (const result of results) {
    // Always emit the start date
    extracted.push({
      type: 'date' as const,
      value: toISODate(result.start.date(), context),
      text: result.text,
      index: result.index,
    });

    // If the result has an end component (date range), emit a second entry
    if (result.end) {
      extracted.push({
        type: 'date' as const,
        value: toISODate(result.end.date(), context),
        text: result.text,
        index: result.index,
      });
    }
  }

  extracted.sort((left, right) => left.index - right.index);
  return extracted;
}
