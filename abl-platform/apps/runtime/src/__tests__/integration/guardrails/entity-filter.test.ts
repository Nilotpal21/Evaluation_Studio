/**
 * INT-2 — Post-detection entity filter (FR-6.4)
 *
 * Integration test for the BuiltinPIIProvider entity-type allowlist filter.
 * Validates that `request.context.allowedEntityTypes` correctly narrows
 * which PII detections trigger a violation, using real recognizers via DI
 * (zero vi.mock calls).
 *
 * 9 cases cover: undefined allowlist, empty allowlist, exact match, exclusion,
 * multi-entity, no-PII, unknown entity, disabled pack entity, and the R3-F1
 * zero-match mitigation proving the filter is exercised not bypassed.
 *
 * Boundary: compiler ↔ runtime. Tests BuiltinPIIProvider.evaluate() directly.
 */

import { describe, expect, it } from 'vitest';
import { BuiltinPIIProvider } from '@abl/compiler/platform/guardrails/providers/builtin-pii.js';
import {
  PIIRecognizerRegistry,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform/security/index.js';

// ---------------------------------------------------------------------------
// Shared provider + registry with core pack (email, ssn, credit_card, phone,
// ip_address). Additional packs are NOT registered — mirrors the default
// runtime configuration where only 'core' is loaded.
// ---------------------------------------------------------------------------

const registry = new PIIRecognizerRegistry();
registerBuiltInRecognizers(registry);

const provider = new BuiltinPIIProvider();

// ---------------------------------------------------------------------------
// Sample content strings
// ---------------------------------------------------------------------------

const SSN_CONTENT = 'My SSN is 123-45-6789';
const EMAIL_CONTENT = 'Contact john@example.com for details';
const SSN_AND_EMAIL_CONTENT = 'My SSN is 123-45-6789 and email is john@example.com';
const CLEAN_CONTENT = 'Hello, how are you doing today?';
// EU passport-shaped string (9 digits) — only detected by the 'eu' pack
// which is NOT registered in our default registry.
const EU_PASSPORT_CONTENT = 'My passport number is 123456789';

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

interface TestCase {
  n: number;
  label: string;
  allowlist: string[] | undefined;
  content: string;
  expectViolation: boolean;
}

const cases: TestCase[] = [
  {
    n: 1,
    label: 'undefined allowlist + SSN => violation (legacy default)',
    allowlist: undefined,
    content: SSN_CONTENT,
    expectViolation: true,
  },
  {
    n: 2,
    label: 'empty allowlist + SSN => violation (empty = pass-through)',
    allowlist: [],
    content: SSN_CONTENT,
    expectViolation: true,
  },
  {
    n: 3,
    label: "['ssn'] + SSN => violation (match)",
    allowlist: ['ssn'],
    content: SSN_CONTENT,
    expectViolation: true,
  },
  {
    n: 4,
    label: "['ssn'] + email => no violation (filter excludes email)",
    allowlist: ['ssn'],
    content: EMAIL_CONTENT,
    expectViolation: false,
  },
  {
    n: 5,
    label: "['ssn', 'email'] + both SSN+email => violation (either matches)",
    allowlist: ['ssn', 'email'],
    content: SSN_AND_EMAIL_CONTENT,
    expectViolation: true,
  },
  {
    n: 6,
    label: "['ssn'] + no PII => no violation",
    allowlist: ['ssn'],
    content: CLEAN_CONTENT,
    expectViolation: false,
  },
  {
    n: 7,
    label: "['UNKNOWN_ENTITY'] + SSN => no violation (closed allowlist)",
    allowlist: ['UNKNOWN_ENTITY'],
    content: SSN_CONTENT,
    expectViolation: false,
  },
  {
    n: 8,
    label:
      "['eu_uk_passport'] (pack disabled) + EU passport string => no violation (silently skip)",
    allowlist: ['eu_uk_passport'],
    content: EU_PASSPORT_CONTENT,
    expectViolation: false,
  },
  {
    n: 9,
    label:
      "R3-F1 mitigation — ['us_bank_account'] (no matching detection) + SSN+email => no violation (filter exercised, not bypassed)",
    allowlist: ['us_bank_account'],
    content: SSN_AND_EMAIL_CONTENT,
    expectViolation: false,
  },
];

describe('INT-2 — Post-detection entity filter (FR-6.4)', () => {
  it.each(cases)('case $n: $label', async ({ allowlist, content, expectViolation }) => {
    const result = await provider.evaluate({
      content,
      category: 'pii',
      context: {
        piiRecognizerRegistry: registry,
        allowedEntityTypes: allowlist,
      },
    });

    if (expectViolation) {
      expect(result.score).toBe(1.0);
      expect(result.severity).not.toBe('safe');
    } else {
      expect(result.score).toBe(0.0);
      expect(result.severity).toBe('safe');
    }
  });
});
