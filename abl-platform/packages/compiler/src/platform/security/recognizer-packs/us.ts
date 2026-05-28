/**
 * `us` recognizer pack.
 *
 * Entity types: us-passport, us-dl, us-itin, us-bank-account, us-aba-routing.
 * baseConfidence = 0.7 (numeric IDs are noisier without context); contextBoost = 0.35.
 */

import type { EntityCatalogEntry } from './catalog.js';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '../pii-recognizer-registry.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'us_passport', label: 'US Passport', pack: 'us', category: 'government_id' },
  { id: 'us_drivers_license', label: 'US Drivers License', pack: 'us', category: 'government_id' },
  {
    id: 'us_itin',
    label: 'US Individual Taxpayer Identification Number',
    pack: 'us',
    category: 'government_id',
  },
  { id: 'us_bank_account', label: 'US Bank Account Number', pack: 'us', category: 'financial' },
  { id: 'us_aba_routing', label: 'US ABA Routing Number', pack: 'us', category: 'financial' },
];

const COMMON_CONFIG = {
  baseConfidence: 0.7,
  contextBoost: 0.35,
};

function abaRoutingValidate(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  // ABA routing checksum: 3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)
  const d = digits.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

export function register(registry: PIIRecognizerRegistry): void {
  registry.register(
    new RegexPIIRecognizer(
      'us-passport',
      ['us_passport'],
      /\b[A-Z]\d{8}\b/g,
      'us_passport',
      undefined,
      'regex',
      { ...COMMON_CONFIG, contextWords: ['passport', 'passports', 'travel'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'us-dl',
      ['us_drivers_license'],
      /\b[A-Z]\d{7,12}\b/g,
      'us_drivers_license',
      undefined,
      'regex',
      { ...COMMON_CONFIG, contextWords: ['driver', 'drivers', 'license', 'dl'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'us-itin',
      ['us_itin'],
      /\b9\d{2}-(?:7\d|8\d|9[0-2]|9[4-9])-\d{4}\b/g,
      'us_itin',
      undefined,
      'regex',
      { ...COMMON_CONFIG, contextWords: ['itin', 'tax', 'taxpayer'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'us-bank-account',
      ['us_bank_account'],
      /\b\d{8,17}\b/g,
      'us_bank_account',
      (m: string) => m.length >= 8 && m.length <= 17,
      'regex',
      {
        ...COMMON_CONFIG,
        baseConfidence: 0.4, // very noisy without context
        contextWords: ['bank', 'account', 'acct', 'checking', 'savings'],
      },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'us-aba-routing',
      ['us_aba_routing'],
      /\b\d{9}\b/g,
      'us_aba_routing',
      abaRoutingValidate,
      'regex',
      { ...COMMON_CONFIG, contextWords: ['routing', 'aba', 'rtn', 'wire'] },
    ),
    { permanent: true },
  );
}
