/**
 * UT-6 (CI-blocking): ReDoS adversarial sweep across all 8 packs.
 *
 * Per LLD D-11: 25 ms wall-time bound per pattern (industry norm for
 * developer-authored patterns is 10–25 ms). Failure here blocks merge
 * because a vulnerable regex can hang a request thread.
 *
 * Adversarial inputs target the common catastrophic-backtracking shapes:
 * nested quantifiers, alternation with overlap, long ambiguous strings.
 */

import { describe, test, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  registerPacks,
  type RegisterPacksOptions,
} from '../../platform/security/index.js';
import type { PackName } from '@agent-platform/shared/validation';

const REDOS_BUDGET_MS = 25;

const ADVERSARIAL_INPUTS: string[] = [
  // Long sequences of digits — credit card / bank-account amplifiers
  '1'.repeat(200),
  '0'.repeat(200),
  '1234567890'.repeat(20),
  // Long ambiguous letter sequences — IBAN / IT fiscal / DEA
  'A'.repeat(200),
  'AAAA'.repeat(50),
  'ABCDEFGHIJKL'.repeat(20),
  // Mixed alphanumeric — base58 / GSTIN / IBAN
  '1A'.repeat(100),
  '0OoIl1'.repeat(30),
  // SWIFT-shaped repetition
  'ABCDEFGH' + 'A'.repeat(200),
  // IPv6 expanding tokens
  ':' + 'a:'.repeat(20),
  '1234:'.repeat(8) + '1234',
  // Email amplifier
  'a'.repeat(50) + '@' + 'b'.repeat(50) + '.com',
  // Phone amplifier
  '+1' + '0'.repeat(50),
  // Mac amplifier
  'aa:bb:cc:dd:ee:ff'.repeat(20),
];

const PACKS: PackName[] = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
];

describe('UT-6: ReDoS adversarial sweep', () => {
  test.each(PACKS)(
    'pack %s — every adversarial input completes within %s ms',
    (pack) => {
      const reg = new PIIRecognizerRegistry();
      const opts: RegisterPacksOptions = { onDegraded: () => undefined };
      registerPacks([pack], reg, opts);

      // Hard CI gate (LLD D-11): every adversarial input must complete within
      // REDOS_BUDGET_MS. NOT expect.soft — that records failures without
      // failing the test, which would make the gate non-blocking.
      for (const input of ADVERSARIAL_INPUTS) {
        const t0 = performance.now();
        reg.detectAll(input);
        const elapsed = performance.now() - t0;
        expect(elapsed, `pack=${pack} input.length=${input.length}`).toBeLessThan(REDOS_BUDGET_MS);
      }
    },
    /* test timeout */ 30_000,
  );
});
