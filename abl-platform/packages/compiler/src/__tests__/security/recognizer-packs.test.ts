/**
 * UT-2: `core` pack parity with the legacy 5 built-in recognizers.
 * UT-7: unknown pack name resolves with degraded callback.
 *
 * Phase 1b lands `core` and the dispatcher. UT-3 fixtures for `us`/`eu`
 * land in P2; APAC/financial/medical in P3; network/intl-phone in P4.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  PIIRecognizerRegistry,
  registerPacks,
  registerBuiltInRecognizers,
} from '../../platform/security/index.js';

describe('UT-2: core pack parity with built-in recognizers', () => {
  test('registerPacks([core]) yields the same 5 recognizer counts as registerBuiltInRecognizers', () => {
    const a = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(a); // shim — delegates to core

    const b = new PIIRecognizerRegistry();
    registerPacks(['core'], b);

    expect(a.getRecognizerCount()).toBe(5);
    expect(b.getRecognizerCount()).toBe(5);
  });

  test('core pack uses core-* recognizer names', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);
    const names = reg.listRecognizers().map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'core-email',
        'core-ssn',
        'core-credit-card',
        'core-phone',
        'core-ipv4',
      ]),
    );
  });

  test('detects email, SSN (dashed), credit card, phone, IPv4 (legacy parity)', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);

    const types = (text: string) => new Set(reg.detectAll(text).map((d) => d.type));

    expect(types('a@b.com')).toContain('email');
    expect(types('SSN: 123-45-6789')).toContain('ssn');
    // Visa test number — passes Luhn
    expect(types('4111 1111 1111 1111')).toContain('credit_card');
    expect(types('Call (415) 555-0100')).toContain('phone');
    expect(types('IP 192.168.1.1')).toContain('ip_address');
  });

  test('LLD D-7: detects undashed 9-digit SSN (detection-expanding fix)', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);
    const types = new Set(reg.detectAll('Account 123456789').map((d) => d.type));
    expect(types).toContain('ssn');
  });

  test('LLD D-7: detects 13-digit and 15-digit Luhn-valid credit cards', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);
    // 13-digit Luhn-valid Visa-style number
    expect(reg.detectAll('Card: 4222222222222').map((d) => d.type)).toContain('credit_card');
    // Amex (15-digit Luhn-valid)
    expect(reg.detectAll('Amex: 378282246310005').map((d) => d.type)).toContain('credit_card');
    // 16-digit (legacy parity)
    expect(reg.detectAll('Visa: 4111 1111 1111 1111').map((d) => d.type)).toContain('credit_card');
  });

  test('threads recognizer name and confidence', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);
    const detections = reg.detectAll('hi a@b.com');
    expect(detections[0].recognizer).toBe('core-email');
    expect(detections[0].confidence).toBe(1.0);
  });
});

describe('UT-3: us pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['us'], reg);

  test('us-passport: 1 letter + 8 digits', () => {
    const types = reg.detectAll('Passport: A12345678').map((d) => d.type);
    expect(types).toContain('us_passport');
  });

  test('us-dl: letter + 7-12 digits', () => {
    // Shape only — no checksum. Letter + 8 digits is a common DL format.
    expect(reg.detectAll('DL: D12345678').map((d) => d.type)).toContain('us_drivers_license');
    // Lower bound: letter + 7 digits
    expect(reg.detectAll('License: A1234567').map((d) => d.type)).toContain('us_drivers_license');
    // Upper bound: letter + 12 digits
    expect(reg.detectAll('License: B123456789012').map((d) => d.type)).toContain(
      'us_drivers_license',
    );
    // Out of range — 6 digits
    expect(reg.detectAll('Code: A123456').map((d) => d.type)).not.toContain('us_drivers_license');
  });

  test('us-bank-account: 8-17 digit shape', () => {
    // 12-digit account
    expect(reg.detectAll('Account: 123456789012').map((d) => d.type)).toContain('us_bank_account');
    // Lower bound — 8 digits
    expect(reg.detectAll('Account: 12345678').map((d) => d.type)).toContain('us_bank_account');
    // Out of range — 7 digits
    expect(reg.detectAll('Code: 1234567').map((d) => d.type)).not.toContain('us_bank_account');
  });

  test('us-aba-routing: 9-digit checksum', () => {
    // 021000021 — Federal Reserve Bank of NY (valid ABA)
    expect(reg.detectAll('Routing: 021000021').map((d) => d.type)).toContain('us_aba_routing');
    // 123456789 — invalid ABA checksum
    expect(reg.detectAll('Routing: 123456789').map((d) => d.type)).not.toContain('us_aba_routing');
  });

  test('us-itin: 9XX-7X-XXXX shape', () => {
    expect(reg.detectAll('ITIN: 900-71-1234').map((d) => d.type)).toContain('us_itin');
    // 93 falls in the gap between 9[0-2] and 9[4-9] in the IRS spec
    expect(reg.detectAll('ITIN: 900-93-1234').map((d) => d.type)).not.toContain('us_itin');
  });
});

describe('UT-3: eu pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['eu'], reg);

  test('eu-iban: GB IBAN with valid mod-97', () => {
    // GB82 WEST 1234 5698 7654 32 — canonical UK test IBAN, valid mod-97.
    expect(reg.detectAll('IBAN GB82 WEST 1234 5698 7654 32').map((d) => d.type)).toContain(
      'eu_iban',
    );
  });

  test('eu-iban: rejects bad mod-97', () => {
    // Mutate last digit
    expect(reg.detectAll('IBAN GB82 WEST 1234 5698 7654 31').map((d) => d.type)).not.toContain(
      'eu_iban',
    );
  });

  test('eu-uk-nino: shape match', () => {
    // 'AB' is a valid NINO prefix (A and B both in allowed character classes)
    expect(reg.detectAll('NINO AB123456C').map((d) => d.type)).toContain('eu_uk_nino');
    // 'QQ' is excluded — Q is not a valid first/second letter
    expect(reg.detectAll('NINO QQ123456C').map((d) => d.type)).not.toContain('eu_uk_nino');
  });

  test('eu-it-fiscal-code: 6-letter + 2-digit + letter + 2-digit + letter + 3-digit + letter', () => {
    expect(reg.detectAll('CF: RSSMRA85T10A562S').map((d) => d.type)).toContain('eu_it_fiscal_code');
  });

  test('eu-uk-nhs: 10-digit shape with optional separators', () => {
    // 9434765919 — NHS Digital published example number
    expect(reg.detectAll('NHS 9434765919').map((d) => d.type)).toContain('eu_uk_nhs');
    expect(reg.detectAll('NHS 943-476-5919').map((d) => d.type)).toContain('eu_uk_nhs');
    expect(reg.detectAll('NHS 943 476 5919').map((d) => d.type)).toContain('eu_uk_nhs');
  });

  test('eu-uk-passport: 9 digits (broad regex, low baseConfidence)', () => {
    // Broad — same shape as undashed SSN / ABA. Detected via type set containment.
    const types = reg.detectAll('UK passport 987654321').map((d) => d.type);
    expect(types).toContain('eu_uk_passport');
  });

  test('eu-de-tax-id: 11 digits', () => {
    // 11-digit Steueridentifikationsnummer — broad shape, gates on context boost
    const types = reg.detectAll('IdNr 12345678901').map((d) => d.type);
    expect(types).toContain('eu_de_tax_id');
  });

  test('eu-es-nif-nie: optional X/Y/Z + 7-8 digits + check letter', () => {
    // NIF — 8 digits + letter
    expect(reg.detectAll('NIF: 12345678Z').map((d) => d.type)).toContain('eu_es_nif_nie');
    // NIE — Y prefix + 7 digits + letter
    expect(reg.detectAll('NIE: Y1234567A').map((d) => d.type)).toContain('eu_es_nif_nie');
  });

  test('eu-pl-pesel: 11 digits', () => {
    // 44051401358 — published PESEL example
    const types = reg.detectAll('PESEL 44051401358').map((d) => d.type);
    expect(types).toContain('eu_pl_pesel');
  });

  test('eu-fi-pic: 6-digit + separator + 3-digit + alphanumeric', () => {
    // 131052-308T — Finnish published example HETU
    expect(reg.detectAll('HETU 131052-308T').map((d) => d.type)).toContain('eu_fi_pic');
    // 'A' separator (born after 2000)
    expect(reg.detectAll('HETU 010101A123B').map((d) => d.type)).toContain('eu_fi_pic');
  });

  test('eu-se-personal-number: YYMMDD-NNNN', () => {
    expect(reg.detectAll('Personnummer 811228-9874').map((d) => d.type)).toContain(
      'eu_se_personal_number',
    );
    // '+' separator (over 100 years old)
    expect(reg.detectAll('Personnummer 811228+9874').map((d) => d.type)).toContain(
      'eu_se_personal_number',
    );
  });
});

describe('UT-3: apac pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['apac'], reg);

  test('in-aadhaar: Verhoeff-valid 12-digit number detects', () => {
    // 234123412346 is Verhoeff-valid per _validators.test.ts
    expect(reg.detectAll('Aadhaar: 234123412346').map((d) => d.type)).toContain('in_aadhaar');
  });

  test('in-aadhaar: Verhoeff-invalid 12-digit number does NOT detect', () => {
    expect(reg.detectAll('Aadhaar: 234123412345').map((d) => d.type)).not.toContain('in_aadhaar');
  });

  test('in-pan: 5-letter + 4-digit + letter shape detects', () => {
    expect(reg.detectAll('PAN: AAAPL1234C').map((d) => d.type)).toContain('in_pan');
  });

  test('sg-nric: starts with S/T/F/G + 7 digits + check letter', () => {
    expect(reg.detectAll('NRIC: S1234567A').map((d) => d.type)).toContain('sg_nric');
  });

  test('kr-rrn: 6-digit + dash + 7-digit shape', () => {
    expect(reg.detectAll('RRN: 901231-1234567').map((d) => d.type)).toContain('kr_rrn');
  });

  test('in-gstin: 15-char composite shape', () => {
    // 27AAPFU0939F1ZV — published Indian GSTIN example (state 27 = Maharashtra)
    expect(reg.detectAll('GSTIN: 27AAPFU0939F1ZV').map((d) => d.type)).toContain('in_gstin');
    // Wrong shape — fewer chars
    expect(reg.detectAll('Code: 27AAPFU0939').map((d) => d.type)).not.toContain('in_gstin');
  });

  test('au-tfn: 8-9 digit shape (broad, low baseConfidence)', () => {
    // 9-digit TFN — overlaps undashed SSN; type-set containment.
    const types = reg.detectAll('TFN 123456789').map((d) => d.type);
    expect(types).toContain('au_tfn');
    // 8-digit TFN
    expect(reg.detectAll('TFN 12345678').map((d) => d.type)).toContain('au_tfn');
  });

  test('au-medicare: 10-digit shape with optional spacing', () => {
    expect(reg.detectAll('Medicare 2123456701').map((d) => d.type)).toContain('au_medicare');
    expect(reg.detectAll('Medicare 2123 45670 1').map((d) => d.type)).toContain('au_medicare');
  });

  test('au-abn-acn: 11-digit shape with optional spacing', () => {
    // 51824753556 — Australian Tax Office's own ABN
    expect(reg.detectAll('ABN 51824753556').map((d) => d.type)).toContain('au_abn');
    expect(reg.detectAll('ABN 51 824 753 556').map((d) => d.type)).toContain('au_abn');
  });
});

describe('UT-3: financial pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['financial'], reg);

  test('fin-swift-bic: 8-char shape detects', () => {
    // BARCGB22 = Barclays Bank UK (canonical SWIFT test value)
    expect(reg.detectAll('SWIFT: BARCGB22').map((d) => d.type)).toContain('fin_swift_bic');
  });

  test('fin-swift-bic: 11-char shape (with branch code) detects', () => {
    expect(reg.detectAll('SWIFT: DEUTDEFF500').map((d) => d.type)).toContain('fin_swift_bic');
  });

  test('fin-btc-wallet: well-formed P2PKH base58 address detects', () => {
    // Bitcoin Genesis address — public reference value
    expect(reg.detectAll('BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').map((d) => d.type)).toContain(
      'fin_btc_wallet',
    );
  });

  test('fin-btc-wallet: address with invalid base58 chars (0/O/I/l) is rejected', () => {
    expect(
      reg.detectAll('BTC: 1A1zP1eP5QGefi2DM0TfTL5SLmv7DivfNa').map((d) => d.type),
    ).not.toContain('fin_btc_wallet');
  });
});

describe('UT-3: medical pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['medical'], reg);

  test('med-npi: 1234567893 is Luhn-valid against the 80840 prefix', () => {
    // Pre-computed: Luhn('808401234567893') === true
    expect(reg.detectAll('NPI: 1234567893').map((d) => d.type)).toContain('med_npi');
  });

  test('med-npi: 1234567890 is NOT Luhn-valid against the 80840 prefix', () => {
    expect(reg.detectAll('NPI: 1234567890').map((d) => d.type)).not.toContain('med_npi');
  });

  test('med-dea: 2-letter + 7-digit + valid checksum detects', () => {
    // AB1234563 — last digit 3 is the computed check digit per deaCheck spec
    expect(reg.detectAll('DEA: AB1234563').map((d) => d.type)).toContain('med_dea');
  });

  test('med-dea: invalid checksum does NOT detect', () => {
    expect(reg.detectAll('DEA: AB1234567').map((d) => d.type)).not.toContain('med_dea');
  });
});

describe('UT-3: network pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['network'], reg);

  test('net-ipv6: full 8-group form detects', () => {
    expect(
      reg.detectAll('IP: 2001:0db8:85a3:0000:0000:8a2e:0370:7334').map((d) => d.type),
    ).toContain('net_ipv6');
  });

  test('net-mac: colon-separated 6-pair hex detects', () => {
    expect(reg.detectAll('MAC: 01:23:45:67:89:AB').map((d) => d.type)).toContain('net_mac');
  });

  test('net-url-with-credentials: user:pass@host detects', () => {
    expect(
      reg.detectAll('Visit https://alice:s3cret@example.com/path').map((d) => d.type),
    ).toContain('net_url_with_credentials');
  });

  test('net-url-with-credentials: bare URL (no credentials) does NOT match', () => {
    expect(reg.detectAll('Visit https://example.com/path').map((d) => d.type)).not.toContain(
      'net_url_with_credentials',
    );
  });
});

describe('UT-3: international-phone pack fixtures', () => {
  const reg = new PIIRecognizerRegistry();
  registerPacks(['international-phone'], reg);

  test('US E.164 number detects via libphonenumber-js', () => {
    const types = reg.detectAll('Call me at +14155551234').map((d) => d.type);
    expect(types).toContain('phone');
  });

  test('UK landline detects', () => {
    const types = reg.detectAll('UK office: +44 20 7946 0958').map((d) => d.type);
    expect(types).toContain('phone');
  });

  test('threads recognizer name as intl-phone', () => {
    const dets = reg.detectAll('Call +14155551234');
    const phoneDet = dets.find((d) => d.type === 'phone');
    expect(phoneDet?.recognizer).toBe('intl-phone');
  });
});

describe('LLD task 1b.14: SSN false-positive guardrail', () => {
  // The core SSN regex matches every 9-digit number — without context, it
  // would over-redact zip+4, order numbers, and internal IDs. D-7 mitigates
  // this via context-word boost: undashed SSN gets baseConfidence=0.55,
  // boosted to ≥ 0.95 only when 'ssn'/'social'/'security'/'tin' appears
  // nearby. Operators with confidence_threshold ≥ 0.7 will filter the
  // unboosted form.
  const reg = new PIIRecognizerRegistry();
  registerPacks(['core'], reg);

  // Detect-level: regex DOES match these 9-digit non-SSN strings (audit visibility)
  test.each([
    ['ZIP+4 940731234', 940731234],
    ['Order# 987654321', 987654321],
    ['Tracking 555123456', 555123456],
    ['REF-100200300', 100200300],
    ['Account 800400200', 800400200],
    ['Customer ID 123987456', 123987456],
    ['Internal ID 246802468', 246802468],
    ['Confirmation 192837465', 192837465],
    ['Code 555000111', 555000111],
    ['Token 600700800', 600700800],
  ])('regex matches "%s" (audit visibility) but with low confidence', (text, _expected) => {
    const dets = reg.detectAll(text);
    const ssnDets = dets.filter((d) => d.type === 'ssn');
    expect(ssnDets).toHaveLength(1);
    // Without context, confidence stays at baseConfidence (0.55)
    expect(ssnDets[0].confidence).toBeCloseTo(0.55, 2);
  });

  // Filter-level: with confidence_threshold = 0.7, none of these should be redacted
  test.each([
    'ZIP+4 940731234',
    'Order# 987654321',
    'Tracking 555123456',
    'REF-100200300',
    'Account 800400200',
    'Customer ID 123987456',
    'Internal ID 246802468',
    'Confirmation 192837465',
    'Code 555000111',
    'Token 600700800',
  ])('with confidence_threshold=0.7, "%s" is NOT redacted', async (text) => {
    const { detectPIISelective } = await import('../../platform/security/pii-detector.js');
    const out = detectPIISelective(text, undefined, reg, { confidenceThreshold: 0.7 });
    expect(out.redacted).toBe(text);
    expect(out.redactedTypes).toEqual([]);
  });

  // Positive case: with context word, undashed SSN IS redacted at threshold 0.7
  test('SSN context-word boost: "ssn 123456789" IS redacted at threshold 0.7', async () => {
    const { detectPIISelective } = await import('../../platform/security/pii-detector.js');
    const out = detectPIISelective('ssn 123456789', undefined, reg, {
      confidenceThreshold: 0.7,
    });
    expect(out.redacted).toContain('[REDACTED_SSN]');
  });

  // Dashed SSN: no context needed — pattern itself is the signal
  test('dashed SSN "123-45-6789" gets baseConfidence 0.55, boosted by context to >=0.7', async () => {
    const { detectPIISelective } = await import('../../platform/security/pii-detector.js');
    // Without context: below 0.7
    const without = detectPIISelective('id 123-45-6789', undefined, reg, {
      confidenceThreshold: 0.7,
    });
    expect(without.redactedTypes).toEqual([]);
    // With 'ssn' context: above 0.7
    const withCtx = detectPIISelective('SSN: 123-45-6789', undefined, reg, {
      confidenceThreshold: 0.7,
    });
    expect(withCtx.redactedTypes).toEqual(['ssn']);
  });
});

describe('UT-7: unknown pack name', () => {
  test('logs warning, fires onDegraded, skips unknown pack', () => {
    const reg = new PIIRecognizerRegistry();
    const onDegraded = vi.fn();
    registerPacks(['core', 'totally-fake' as never], reg, { onDegraded });
    expect(reg.getRecognizerCount()).toBe(5); // core only
    expect(onDegraded).toHaveBeenCalledWith('unknown_pack', 'totally-fake');
  });

  test('all 8 valid PackNames register without onDegraded calls', () => {
    const reg = new PIIRecognizerRegistry();
    const onDegraded = vi.fn();
    registerPacks(
      ['core', 'us', 'eu', 'apac', 'financial', 'medical', 'network', 'international-phone'],
      reg,
      { onDegraded },
    );
    expect(onDegraded).not.toHaveBeenCalled();
    expect(reg.getRecognizerCount()).toBeGreaterThan(30);
  });
});
