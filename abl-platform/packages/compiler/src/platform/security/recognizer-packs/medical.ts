/**
 * `medical` recognizer pack.
 *
 * Entity types: MRN, NPI (Luhn-prefixed with 80840), DEA (checksum).
 */

import type { EntityCatalogEntry } from './catalog.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  luhnCheck,
} from '../pii-recognizer-registry.js';
import { deaCheck } from './_validators.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'med_mrn', label: 'Medical Record Number', pack: 'medical', category: 'healthcare' },
  { id: 'med_npi', label: 'National Provider Identifier', pack: 'medical', category: 'healthcare' },
  { id: 'med_dea', label: 'DEA Registration Number', pack: 'medical', category: 'healthcare' },
];

const PACK_CFG = { baseConfidence: 0.7, contextBoost: 0.35 };

export function register(registry: PIIRecognizerRegistry): void {
  // MRN: 6-10 alphanumeric — high FP risk without context.
  registry.register(
    new RegexPIIRecognizer(
      'med-mrn',
      ['med_mrn'],
      /\b[A-Z0-9]{6,10}\b/g,
      'med_mrn',
      undefined,
      'regex',
      {
        ...PACK_CFG,
        baseConfidence: 0.3,
        contextWords: ['mrn', 'medical', 'record', 'patient'],
      },
    ),
    { permanent: true },
  );

  // NPI: 10 digits; Luhn validation against the 80840 prefix.
  // CMS publishes the algorithm: prepend 80840 then run Luhn against the 15-digit string.
  registry.register(
    new RegexPIIRecognizer(
      'med-npi',
      ['med_npi'],
      /\b\d{10}\b/g,
      'med_npi',
      (m: string) => luhnCheck('80840' + m),
      'regex',
      { ...PACK_CFG, contextWords: ['npi', 'provider', 'practitioner'] },
    ),
    { permanent: true },
  );

  // DEA: 2 letters + 7 digits + checksum
  registry.register(
    new RegexPIIRecognizer(
      'med-dea',
      ['med_dea'],
      /\b[A-Z]{2}\d{7}\b/g,
      'med_dea',
      deaCheck,
      'regex',
      { ...PACK_CFG, contextWords: ['dea', 'controlled', 'prescriber'] },
    ),
    { permanent: true },
  );
}
