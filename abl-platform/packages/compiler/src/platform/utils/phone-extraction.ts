/**
 * Phone number extraction and validation using libphonenumber-js.
 * Replaces regex-based phone extraction in entity-extraction.ts.
 *
 * Uses a two-pass strategy:
 * 1. findPhoneNumbersInText — finds strictly valid phone numbers in free text
 * 2. Regex pre-extraction + parsePhoneNumberFromString — catches phone-like
 *    patterns that are "possible" (correct digit count / structure) but not
 *    strictly "valid" (e.g. 555-xxx-xxxx test numbers in the US)
 */
import {
  findPhoneNumbersInText,
  parsePhoneNumberFromString,
  type CountryCode,
  type E164Number,
} from 'libphonenumber-js';

export interface ExtractedPhone {
  /** Always 'phone' for phone extractions */
  type: 'phone';
  /** E.164 format: +15551234567 */
  e164: E164Number;
  /** National format: (555) 123-4567 */
  national: string;
  /** ISO country code: US */
  country: string;
  /** Original matched text from the input */
  text: string;
}

/**
 * Regex pattern to locate phone-like digit sequences in free text.
 * Used as a pre-filter for the lenient parsePhoneNumberFromString fallback.
 *
 * Matches patterns like:
 *   +1 555-123-4567, (555) 123-4567, 07911 123456, 555.123.4567
 */
const PHONE_CANDIDATE_PATTERN =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?(?:\d[\s.-]?){6,14}/g;

/**
 * Extract a phone number from natural language text.
 *
 * Returns the first phone number found, or null if none is detected.
 * The number is normalized to E.164 format for storage/comparison.
 *
 * @param text - The input text to extract a phone number from
 * @param defaultCountry - ISO 3166-1 alpha-2 country code (defaults to 'US')
 * @returns Extracted phone entity or null
 */
export function extractPhoneFromText(
  text: string,
  defaultCountry: string = 'US',
): ExtractedPhone | null {
  if (!text.trim()) return null;

  const country = defaultCountry as CountryCode;

  // Pass 1: strict — findPhoneNumbersInText validates fully
  const found = findPhoneNumbersInText(text, country);
  if (found.length > 0) {
    const phone = found[0].number;
    const formatted = phone.format('E.164');
    if (!formatted) return null;

    return {
      type: 'phone',
      e164: formatted as E164Number,
      national: phone.formatNational(),
      country: phone.country ?? defaultCountry,
      text: text.substring(found[0].startsAt, found[0].endsAt),
    };
  }

  // Pass 2: lenient — regex pre-filter + isPossible() check
  const matches = text.match(PHONE_CANDIDATE_PATTERN);
  if (!matches) return null;

  for (const match of matches) {
    const candidate = match.trim();
    const parsed = parsePhoneNumberFromString(candidate, country);
    if (parsed && parsed.isPossible()) {
      const formatted = parsed.format('E.164');
      if (!formatted) continue;

      return {
        type: 'phone',
        e164: formatted as E164Number,
        national: parsed.formatNational(),
        country: parsed.country ?? defaultCountry,
        text: candidate,
      };
    }
  }

  return null;
}
