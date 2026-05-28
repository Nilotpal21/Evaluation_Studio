/**
 * `apac` recognizer pack.
 *
 * Entity types: in-aadhaar (Verhoeff), in-pan, in-gstin, sg-nric,
 * au-tfn, au-medicare, au-abn-acn, kr-rrn.
 */

import type { EntityCatalogEntry } from './catalog.js';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '../pii-recognizer-registry.js';
import { verhoeffCheck } from './_validators.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'in_aadhaar', label: 'Indian Aadhaar', pack: 'apac', category: 'government_id' },
  { id: 'in_pan', label: 'Indian PAN', pack: 'apac', category: 'government_id' },
  { id: 'in_gstin', label: 'Indian GSTIN', pack: 'apac', category: 'government_id' },
  { id: 'sg_nric', label: 'Singapore NRIC/FIN', pack: 'apac', category: 'government_id' },
  { id: 'au_tfn', label: 'Australian Tax File Number', pack: 'apac', category: 'government_id' },
  { id: 'au_medicare', label: 'Australian Medicare Number', pack: 'apac', category: 'healthcare' },
  { id: 'au_abn', label: 'Australian Business Number', pack: 'apac', category: 'business' },
  {
    id: 'kr_rrn',
    label: 'Korean Resident Registration Number',
    pack: 'apac',
    category: 'government_id',
  },
];

const PACK_CFG = { baseConfidence: 0.7, contextBoost: 0.35 };

export function register(registry: PIIRecognizerRegistry): void {
  registry.register(
    new RegexPIIRecognizer(
      'in-aadhaar',
      ['in_aadhaar'],
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      'in_aadhaar',
      (m: string) => verhoeffCheck(m.replace(/[\s-]/g, '')),
      'regex',
      { ...PACK_CFG, contextWords: ['aadhaar', 'aadhar', 'uidai'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'in-pan',
      ['in_pan'],
      /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      'in_pan',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['pan'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'in-gstin',
      ['in_gstin'],
      /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/g,
      'in_gstin',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['gstin', 'gst'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'sg-nric',
      ['sg_nric'],
      /\b[STFG]\d{7}[A-Z]\b/g,
      'sg_nric',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['nric', 'fin'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer('au-tfn', ['au_tfn'], /\b\d{8,9}\b/g, 'au_tfn', undefined, 'regex', {
      ...PACK_CFG,
      baseConfidence: 0.4,
      contextWords: ['tfn', 'tax'],
    }),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'au-medicare',
      ['au_medicare'],
      /\b\d{4}\s?\d{5}\s?\d\b/g,
      'au_medicare',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['medicare'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer(
      'au-abn-acn',
      ['au_abn'],
      /\b\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/g,
      'au_abn',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['abn', 'acn', 'business'] },
    ),
    { permanent: true },
  );

  registry.register(
    new RegexPIIRecognizer('kr-rrn', ['kr_rrn'], /\b\d{6}-\d{7}\b/g, 'kr_rrn', undefined, 'regex', {
      ...PACK_CFG,
      contextWords: ['rrn', '주민등록번호'],
    }),
    { permanent: true },
  );
}
