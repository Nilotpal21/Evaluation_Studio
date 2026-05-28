/**
 * `core` recognizer pack — the canonical 5 built-in entity types.
 *
 * Detection-expanding bug fix vs. legacy `registerBuiltInRecognizers`
 * (LLD D-7): credit-card pattern accepts 13–19 digits with optional
 * separators (matched against the registry's exported Luhn validator);
 * SSN pattern accepts both dashed (`123-45-6789`) and undashed
 * (`123456789`) forms.
 *
 * No context-word boost in `core` — confidence_threshold + downstream
 * audit is the FP guardrail. (LLD §1.2 D-7 + D-12 §1.4 sibling contract.)
 */

import type { EntityCatalogEntry } from './catalog.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  luhnCheck,
} from '../pii-recognizer-registry.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'email', label: 'Email Address', pack: 'core', category: 'contact' },
  { id: 'ssn', label: 'US Social Security Number', pack: 'core', category: 'government_id' },
  { id: 'credit_card', label: 'Credit Card Number', pack: 'core', category: 'financial' },
  { id: 'phone', label: 'Phone Number', pack: 'core', category: 'contact' },
  { id: 'ip_address', label: 'IPv4 Address', pack: 'core', category: 'network' },
];

export function register(registry: PIIRecognizerRegistry): void {
  registry.register(
    new RegexPIIRecognizer(
      'core-email',
      ['email'],
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      'email',
    ),
    { permanent: true },
  );

  // Dashed OR undashed 9-digit SSN. The undashed form is high-FP — every
  // 9-digit number matches. LLD D-7 mitigates this with context-word boost:
  // baseConfidence stays low without context words, gets boosted only when
  // 'ssn' / 'social' / 'security' / 'tin' appears nearby. Operators with
  // confidence_threshold ≥ 0.7 will filter undashed-without-context matches.
  // Dashed SSN keeps the legacy 1.0 confidence (the pattern itself is the
  // signal — `123-45-6789` shape is virtually never anything else).
  registry.register(
    new RegexPIIRecognizer(
      'core-ssn',
      ['ssn'],
      /\b(?:\d{3}-\d{2}-\d{4}|\d{9})\b/g,
      'ssn',
      undefined,
      'regex',
      {
        baseConfidence: 0.55,
        contextBoost: 0.4,
        contextWords: ['ssn', 'social', 'security', 'tin'],
      },
    ),
    { permanent: true },
  );

  // 13–19 digit credit card with optional space/dash separators + Luhn.
  registry.register(
    new RegexPIIRecognizer(
      'core-credit-card',
      ['credit_card'],
      /\b\d(?:[\s-]?\d){12,18}\b/g,
      'credit_card',
      (match: string) => luhnCheck(match.replace(/[\s-]/g, '')),
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'core-phone',
      ['phone'],
      /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
      'phone',
      (match: string) => {
        const digits = match.replace(/\D/g, '');
        return digits.length >= 10 && digits.length <= 15;
      },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'core-ipv4',
      ['ip_address'],
      /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      'ip_address',
      (match: string) => {
        const parts = match.split('.');
        return parts.every((p) => {
          const n = parseInt(p, 10);
          return n >= 0 && n <= 255;
        });
      },
    ),
    { permanent: true },
  );
}
