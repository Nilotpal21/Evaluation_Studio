/**
 * `eu` recognizer pack.
 *
 * Entity types: eu-iban, eu-uk-nhs, eu-uk-nino, eu-uk-passport, eu-de-tax-id,
 *               eu-it-fiscal-code, eu-es-nif-nie, eu-pl-pesel, eu-fi-pic,
 *               eu-se-personal-number.
 *
 * IBAN mod-97 validator is inlined here for Phase 2; the consolidated
 * implementation lands at `_validators.ts` in P3 (see TODO marker below).
 */

import type { EntityCatalogEntry } from './catalog.js';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '../pii-recognizer-registry.js';
import { isIbanMod97 } from './_validators.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'eu_iban', label: 'EU IBAN', pack: 'eu', category: 'financial' },
  { id: 'eu_uk_nhs', label: 'UK NHS Number', pack: 'eu', category: 'healthcare' },
  {
    id: 'eu_uk_nino',
    label: 'UK National Insurance Number',
    pack: 'eu',
    category: 'government_id',
  },
  { id: 'eu_uk_passport', label: 'UK Passport', pack: 'eu', category: 'government_id' },
  { id: 'eu_de_tax_id', label: 'German Tax ID', pack: 'eu', category: 'government_id' },
  { id: 'eu_it_fiscal_code', label: 'Italian Fiscal Code', pack: 'eu', category: 'government_id' },
  { id: 'eu_es_nif_nie', label: 'Spanish NIF/NIE', pack: 'eu', category: 'government_id' },
  { id: 'eu_pl_pesel', label: 'Polish PESEL', pack: 'eu', category: 'government_id' },
  {
    id: 'eu_fi_pic',
    label: 'Finnish Personal Identity Code',
    pack: 'eu',
    category: 'government_id',
  },
  {
    id: 'eu_se_personal_number',
    label: 'Swedish Personal Number',
    pack: 'eu',
    category: 'government_id',
  },
];

const PACK_CFG = { baseConfidence: 0.7, contextBoost: 0.35 };

export function register(registry: PIIRecognizerRegistry): void {
  // IBAN — supports all SEPA + many international country codes.
  registry.register(
    new RegexPIIRecognizer(
      'eu-iban',
      ['eu_iban'],
      /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g,
      'eu_iban',
      isIbanMod97,
      'regex',
      { ...PACK_CFG, contextWords: ['iban', 'bank', 'transfer', 'account'] },
    ),
    { permanent: true },
  );

  // UK NHS number (10 digits with mod-11 check; for Phase 2 we use shape only)
  registry.register(
    new RegexPIIRecognizer(
      'eu-uk-nhs',
      ['eu_uk_nhs'],
      /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g,
      'eu_uk_nhs',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['nhs', 'health', 'patient'] },
    ),
    { permanent: true },
  );

  // UK NINO
  registry.register(
    new RegexPIIRecognizer(
      'eu-uk-nino',
      ['eu_uk_nino'],
      /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]\b/g,
      'eu_uk_nino',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['nino', 'national', 'insurance'] },
    ),
    { permanent: true },
  );

  // UK passport — 9 digits
  registry.register(
    new RegexPIIRecognizer(
      'eu-uk-passport',
      ['eu_uk_passport'],
      /\b\d{9}\b/g,
      'eu_uk_passport',
      undefined,
      'regex',
      {
        ...PACK_CFG,
        baseConfidence: 0.35,
        contextWords: ['passport', 'passports', 'uk'],
      },
    ),
    { permanent: true },
  );

  // DE Tax ID (Steueridentifikationsnummer) — 11 digits
  registry.register(
    new RegexPIIRecognizer(
      'eu-de-tax-id',
      ['eu_de_tax_id'],
      /\b\d{11}\b/g,
      'eu_de_tax_id',
      undefined,
      'regex',
      {
        ...PACK_CFG,
        baseConfidence: 0.4,
        contextWords: ['steueridentifikationsnummer', 'idnr', 'tax'],
      },
    ),
    { permanent: true },
  );

  // IT Codice Fiscale
  registry.register(
    new RegexPIIRecognizer(
      'eu-it-fiscal-code',
      ['eu_it_fiscal_code'],
      /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g,
      'eu_it_fiscal_code',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['codice', 'fiscale'] },
    ),
    { permanent: true },
  );

  // ES NIF/NIE — 8 digits + check letter (NIE starts with X/Y/Z)
  registry.register(
    new RegexPIIRecognizer(
      'eu-es-nif-nie',
      ['eu_es_nif_nie'],
      /\b[XYZ]?\d{7,8}[A-Z]\b/g,
      'eu_es_nif_nie',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['nif', 'nie', 'dni'] },
    ),
    { permanent: true },
  );

  // PL PESEL — 11 digits
  registry.register(
    new RegexPIIRecognizer(
      'eu-pl-pesel',
      ['eu_pl_pesel'],
      /\b\d{11}\b/g,
      'eu_pl_pesel',
      undefined,
      'regex',
      { ...PACK_CFG, baseConfidence: 0.4, contextWords: ['pesel'] },
    ),
    { permanent: true },
  );

  // FI Personal Identity Code
  registry.register(
    new RegexPIIRecognizer(
      'eu-fi-pic',
      ['eu_fi_pic'],
      /\b\d{6}[+\-A]\d{3}[A-Z\d]\b/g,
      'eu_fi_pic',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['henkilötunnus', 'hetu', 'personal'] },
    ),
    { permanent: true },
  );

  // SE Personnummer (YYMMDD-XXXX)
  registry.register(
    new RegexPIIRecognizer(
      'eu-se-personal-number',
      ['eu_se_personal_number'],
      /\b\d{6}[-+]\d{4}\b/g,
      'eu_se_personal_number',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['personnummer'] },
    ),
    { permanent: true },
  );
}
