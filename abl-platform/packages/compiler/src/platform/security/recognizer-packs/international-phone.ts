/**
 * `international-phone` recognizer pack.
 *
 * Wraps libphonenumber-js findPhoneNumbersInText for international phone
 * detection. Uses 'US' as the default country (matches existing
 * extractPhoneFromText callers); libphonenumber's per-country digit-count
 * validation is the gate.
 */

import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js';
import type { EntityCatalogEntry } from './catalog.js';
import { type PIIRecognizer, type PIIRecognizerRegistry } from '../pii-recognizer-registry.js';
import { createSafePIIDetection, type PIIDetection } from '../pii-detector.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  {
    id: 'phone',
    label: 'International Phone Number',
    pack: 'international-phone',
    category: 'contact',
  },
];

const RECOGNIZER_NAME = 'intl-phone';
const DEFAULT_COUNTRY: CountryCode = 'US';

// libphonenumber-js scans for candidate spans before validating. On long
// adversarial digit-only strings (e.g. '1'.repeat(200)) it can exceed the
// 25 ms ReDoS budget. Real phone numbers in text always have at least one
// separator (space, hyphen, parenthesis, plus, slash) or appear at a word
// boundary within mixed prose. A 50+ char string with no separators cannot
// contain a parseable phone number.
const HAS_PHONE_SEPARATOR = /[+\s\-()./]/;
const PHONE_PREFILTER_LENGTH = 20;

const intlPhoneRecognizer: PIIRecognizer = {
  name: RECOGNIZER_NAME,
  supportedTypes: ['phone'],
  tier: 'regex',
  detect(text: string): PIIDetection[] {
    if (text.length > PHONE_PREFILTER_LENGTH && !HAS_PHONE_SEPARATOR.test(text)) {
      return [];
    }
    const detections: PIIDetection[] = [];
    const matches = findPhoneNumbersInText(text, DEFAULT_COUNTRY);
    for (const match of matches) {
      detections.push(
        createSafePIIDetection('phone', match.startsAt, match.endsAt, {
          confidence: 1.0,
          recognizer: RECOGNIZER_NAME,
        }),
      );
    }
    return detections;
  },
};

export function register(registry: PIIRecognizerRegistry): void {
  registry.register(intlPhoneRecognizer, { permanent: true });
}
