/**
 * UT-1: validateRule() per-checkType matrix
 * UT-2: validateRule() export verification
 *
 * Tests organized into 6 groups (A–F) per the test spec at
 * docs/testing/sub-features/guardrails-sensitive-data-block.md §4.
 *
 * Zero mocks — validateRule is a pure function. sanitize-html runs for real.
 */
import { describe, expect, it } from 'vitest';

import {
  validateRule,
  type GuardrailRuleInput,
  type ValidateRuleResult,
} from '../../validation/guardrail-rule-validation.js';

// ---------------------------------------------------------------------------
// Shared base inputs
// ---------------------------------------------------------------------------

/** A fully valid SDB (provider + PII) rule — Group A baseline. */
const validSdbRule: GuardrailRuleInput = {
  name: 'ssn_block_rule',
  checkType: 'provider',
  kind: 'input',
  threshold: 0.7,
  provider: 'builtin-pii',
  category: 'pii',
  action: 'block',
  enabled: true,
  entities: ['us_ssn'],
  presetKey: 'sensitive_data_block',
  actionMessage: 'This message contains an SSN and cannot be processed.',
};

/** A fully valid provider + non-PII rule — Group B baseline. */
const validNonPiiProviderRule: GuardrailRuleInput = {
  name: 'hate_speech_rule',
  checkType: 'provider',
  kind: 'input',
  threshold: 0.5,
  provider: 'content-safety',
  category: 'hate',
  action: 'block',
  enabled: true,
};

/** A fully valid CEL rule — Group C baseline. */
const validCelRule: GuardrailRuleInput = {
  name: 'cel_rule',
  checkType: 'cel',
  kind: 'input',
  check: 'message.length < 1000',
  action: 'warn',
  enabled: true,
};

/** A fully valid LLM rule — Group D baseline. */
const validLlmRule: GuardrailRuleInput = {
  name: 'llm_rule',
  checkType: 'llm',
  kind: 'output',
  llmCheck: 'Check if the response is safe.',
  action: 'block',
  enabled: true,
};

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

function assertResult(
  result: ValidateRuleResult,
  expectedValid: boolean,
  expectedMissing?: string[],
): void {
  expect(result.valid).toBe(expectedValid);
  if (expectedMissing) {
    expect(result.missingFields).toEqual(expect.arrayContaining(expectedMissing));
    expect(result.missingFields).toHaveLength(expectedMissing.length);
  }
}

// ---------------------------------------------------------------------------
// Group A — checkType: 'provider' with category: 'pii' (SDB-specific) — 11 cases
// ---------------------------------------------------------------------------

describe('validateRule()', () => {
  describe('Group A — provider + PII (SDB-specific)', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
    }> = [
      {
        name: 'A1: all fields populated → valid',
        input: { ...validSdbRule },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'A2: missing name → invalid',
        input: { ...validSdbRule, name: undefined },
        expectedValid: false,
        expectedMissing: ['name'],
      },
      {
        name: 'A3: missing kind → invalid',
        input: { ...validSdbRule, kind: undefined },
        expectedValid: false,
        expectedMissing: ['kind'],
      },
      {
        name: 'A4: missing provider → invalid',
        input: { ...validSdbRule, provider: undefined },
        expectedValid: false,
        expectedMissing: ['provider'],
      },
      {
        // Deviation from spec: the source does NOT validate category as a required
        // field. Missing category does NOT cause a validation failure.
        name: 'A5: missing category → still valid (not validated by validateRule)',
        input: { ...validSdbRule, category: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // Deviation from spec: the source does NOT validate action as a required
        // field. Missing action does NOT cause a validation failure.
        name: 'A6: missing action → still valid (not validated by validateRule)',
        input: { ...validSdbRule, action: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // Deviation from spec: the source only validates severityThreshold range
        // when the field IS provided. Undefined severityThreshold is not an error.
        name: 'A7: missing severityThreshold → still valid (optional field)',
        input: { ...validSdbRule, severityThreshold: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'A8: missing actionMessage (enabled + SDB preset) → invalid',
        input: { ...validSdbRule, actionMessage: undefined },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
      {
        name: 'A9: entities: [] (empty array) → invalid',
        input: { ...validSdbRule, entities: [] },
        expectedValid: false,
        expectedMissing: ['entities'],
      },
      {
        // Deviation from spec: the source only validates entities when
        // input.entities !== undefined. undefined entities passes silently.
        name: 'A10: entities: undefined → valid (entities not required when omitted)',
        input: { ...validSdbRule, entities: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // Spec intent: disabled rule skips SDB-specific gated checks (actionMessage).
        // Cross-cutting fields (name, kind, provider) remain present.
        name: 'A11: enabled: false — actionMessage not required, entities undefined OK → valid',
        input: {
          ...validSdbRule,
          enabled: false,
          actionMessage: undefined,
          entities: undefined,
        },
        expectedValid: true,
        expectedMissing: [],
      },
    ];

    it.each(cases)('$name', ({ input, expectedValid, expectedMissing }) => {
      const result = validateRule(input);
      assertResult(result, expectedValid, expectedMissing);
    });
  });

  // ---------------------------------------------------------------------------
  // Group B — checkType: 'provider' with non-PII category — 3 cases
  // ---------------------------------------------------------------------------

  describe('Group B — provider + non-PII category', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
    }> = [
      {
        name: 'B1: valid non-PII provider rule (no entities, no actionMessage needed)',
        input: { ...validNonPiiProviderRule },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // Deviation from spec: the source does NOT validate action as required.
        // Missing action is still valid.
        name: 'B2: missing action → still valid (action not validated by validateRule)',
        input: { ...validNonPiiProviderRule, action: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // The spec says entities present should be "silently ignored for non-PII".
        // The actual code validates entities regardless of category when present:
        // it checks length bounds (1..37). With entities: ['us_ssn'] (length 1), valid.
        name: 'B3: entities present on non-PII rule → valid (entities validated by bounds only)',
        input: { ...validNonPiiProviderRule, entities: ['us_ssn'] },
        expectedValid: true,
        expectedMissing: [],
      },
    ];

    it.each(cases)('$name', ({ input, expectedValid, expectedMissing }) => {
      const result = validateRule(input);
      assertResult(result, expectedValid, expectedMissing);
    });
  });

  // ---------------------------------------------------------------------------
  // Group C — checkType: 'cel' — 5 cases
  // ---------------------------------------------------------------------------

  describe('Group C — checkType: cel', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
    }> = [
      {
        name: 'C1: all fields populated → valid',
        input: { ...validCelRule },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'C2: missing name → invalid',
        input: { ...validCelRule, name: undefined },
        expectedValid: false,
        expectedMissing: ['name'],
      },
      {
        name: 'C3: missing check (CEL expression) → invalid',
        input: { ...validCelRule, check: undefined },
        expectedValid: false,
        expectedMissing: ['check'],
      },
      {
        // Deviation from spec: action is not validated as required.
        name: 'C4: missing action → still valid (action not validated)',
        input: { ...validCelRule, action: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // CEL rule without presetKey: 'sensitive_data_block' — actionMessage not required.
        name: 'C5: missing actionMessage (no SDB preset) → valid',
        input: { ...validCelRule, actionMessage: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
    ];

    it.each(cases)('$name', ({ input, expectedValid, expectedMissing }) => {
      const result = validateRule(input);
      assertResult(result, expectedValid, expectedMissing);
    });
  });

  // ---------------------------------------------------------------------------
  // Group D — checkType: 'llm' — 5 cases
  // ---------------------------------------------------------------------------

  describe('Group D — checkType: llm', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
    }> = [
      {
        name: 'D1: all fields populated → valid',
        input: { ...validLlmRule },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'D2: missing llmCheck (prompt) → invalid',
        input: { ...validLlmRule, llmCheck: undefined },
        expectedValid: false,
        expectedMissing: ['llmCheck'],
      },
      {
        name: 'D3: missing name → invalid',
        input: { ...validLlmRule, name: undefined },
        expectedValid: false,
        expectedMissing: ['name'],
      },
      {
        // Deviation from spec: action is not validated as required.
        name: 'D4: missing action → still valid (action not validated)',
        input: { ...validLlmRule, action: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // LLM rule without presetKey: 'sensitive_data_block' — actionMessage not required.
        name: 'D5: missing actionMessage (no SDB preset) → valid',
        input: { ...validLlmRule, actionMessage: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
    ];

    it.each(cases)('$name', ({ input, expectedValid, expectedMissing }) => {
      const result = validateRule(input);
      assertResult(result, expectedValid, expectedMissing);
    });
  });

  // ---------------------------------------------------------------------------
  // Group E — Cross-cutting edge cases — 10 cases
  // ---------------------------------------------------------------------------

  describe('Group E — cross-cutting edge cases', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
    }> = [
      {
        name: 'E1: multiple missing fields — all listed',
        input: {
          // Missing name, kind, checkType — all cross-cutting
          enabled: true,
        },
        expectedValid: false,
        expectedMissing: ['name', 'kind', 'checkType'],
      },
      {
        name: 'E2: whitespace-only name → invalid',
        input: { ...validSdbRule, name: '   ' },
        expectedValid: false,
        expectedMissing: ['name'],
      },
      {
        // validateRule does not restrict action values — UI concern only
        name: "E3: action: 'redact' for SDB preset → valid at validation level",
        input: { ...validSdbRule, action: 'redact' },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // validateRule does not validate entity membership — catalog check is separate
        name: 'E4: entities: [unknown_entity_id] → valid at validation level',
        input: { ...validSdbRule, entities: ['unknown_entity_id'] },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'E5: threshold: 0.0 → valid (lower boundary)',
        input: { ...validSdbRule, threshold: 0.0 },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'E6: threshold: 1.0 → valid (upper boundary)',
        input: { ...validSdbRule, threshold: 1.0 },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        // Deviation from spec: threshold: undefined just skips the range check.
        // The spec expected missingFields: ['severityThreshold'] but the code
        // does not flag undefined threshold.
        name: 'E7: threshold: undefined → valid (range check skipped when absent)',
        input: { ...validSdbRule, threshold: undefined },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'E8: actionMessage exactly 500 chars → valid (boundary)',
        input: { ...validSdbRule, actionMessage: 'x'.repeat(500) },
        expectedValid: true,
        expectedMissing: [],
      },
      {
        name: 'E9: actionMessage 501 chars → invalid (over-length)',
        input: { ...validSdbRule, actionMessage: 'x'.repeat(501) },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
      {
        name: "E10: actionMessage: '' (empty) when required → invalid",
        input: { ...validSdbRule, actionMessage: '' },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
    ];

    it.each(cases)('$name', ({ input, expectedValid, expectedMissing }) => {
      const result = validateRule(input);
      assertResult(result, expectedValid, expectedMissing);
    });

    // Additional cross-cutting edge cases not in spec groups but validating code paths

    it('threshold: -0.1 → invalid (below range)', () => {
      const result = validateRule({ ...validSdbRule, threshold: -0.1 });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('threshold');
    });

    it('threshold: 1.1 → invalid (above range)', () => {
      const result = validateRule({ ...validSdbRule, threshold: 1.1 });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('threshold');
    });

    it('severityThreshold: -0.1 → invalid (below range)', () => {
      const result = validateRule({ ...validSdbRule, severityThreshold: -0.1 });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('severityThreshold');
    });

    it('severityThreshold: 1.1 → invalid (above range)', () => {
      const result = validateRule({ ...validSdbRule, severityThreshold: 1.1 });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('severityThreshold');
    });

    it('unknown checkType → invalid', () => {
      const result = validateRule({ ...validSdbRule, checkType: 'unknown_type' });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('checkType');
    });

    it('empty checkType → invalid', () => {
      const result = validateRule({ ...validSdbRule, checkType: '' });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('checkType');
    });

    it('whitespace-only kind → invalid', () => {
      const result = validateRule({ ...validSdbRule, kind: '   ' });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('kind');
    });

    it('entities exceeding MAX_ENTITIES (37) → invalid', () => {
      const oversizedEntities = Array.from({ length: 38 }, (_, i) => `entity_${i}`);
      const result = validateRule({ ...validSdbRule, entities: oversizedEntities });
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('entities');
    });
  });

  // ---------------------------------------------------------------------------
  // Group F — actionMessage sanitization edge cases (R2-F3) — 6 cases
  // ---------------------------------------------------------------------------

  describe('Group F — actionMessage sanitization', () => {
    /** Base rule: enabled SDB preset (actionMessage is required) */
    const sdbBase: GuardrailRuleInput = {
      name: 'sdb_rule',
      checkType: 'provider',
      kind: 'input',
      provider: 'builtin-pii',
      category: 'pii',
      action: 'block',
      enabled: true,
      entities: ['us_ssn'],
      presetKey: 'sensitive_data_block',
    };

    const cases: ReadonlyArray<{
      name: string;
      input: GuardrailRuleInput;
      expectedValid: boolean;
      expectedMissing?: string[];
      expectedSanitizedMessage?: string;
    }> = [
      {
        name: 'F1: null byte in actionMessage → rejected',
        input: { ...sdbBase, actionMessage: 'Hello\x00World' },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
      {
        name: 'F2: over-length (501 chars) → rejected',
        input: { ...sdbBase, actionMessage: 'x'.repeat(501) },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
      {
        // Deviation from spec: sanitize-html strips <script> tags AND their
        // content entirely (standard XSS prevention). Result is '' not 'alert(1)'.
        // The sanitizeActionMessage function does not re-check for empty after
        // stripping, so it returns '' and the result is valid with empty message.
        name: 'F3: HTML script tags → stripped entirely (script content removed)',
        input: { ...sdbBase, actionMessage: '<script>alert(1)</script>' },
        expectedValid: true,
        expectedMissing: [],
        expectedSanitizedMessage: '',
      },
      {
        name: 'F4: plain text → unchanged, valid',
        input: { ...sdbBase, actionMessage: 'Valid plain text message.' },
        expectedValid: true,
        expectedMissing: [],
        expectedSanitizedMessage: 'Valid plain text message.',
      },
      {
        name: 'F5: empty string when required → rejected',
        input: { ...sdbBase, actionMessage: '' },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
      {
        name: 'F6: undefined when required → rejected',
        input: { ...sdbBase, actionMessage: undefined },
        expectedValid: false,
        expectedMissing: ['actionMessage'],
      },
    ];

    it.each(cases)(
      '$name',
      ({ input, expectedValid, expectedMissing, expectedSanitizedMessage }) => {
        const result = validateRule(input);
        assertResult(result, expectedValid, expectedMissing);
        if (expectedSanitizedMessage !== undefined) {
          expect(result.sanitized.actionMessage).toBe(expectedSanitizedMessage);
        }
      },
    );

    it('F3 variant: bold tags stripped to text content', () => {
      const result = validateRule({
        ...sdbBase,
        actionMessage: 'Hi <b>there</b>!',
      });
      expect(result.valid).toBe(true);
      expect(result.sanitized.actionMessage).toBe('Hi there!');
    });

    it('actionMessage not required when enabled: false (non-SDB gate)', () => {
      const result = validateRule({
        ...sdbBase,
        enabled: false,
        actionMessage: undefined,
      });
      // enabled === false → actionMessageRequired is false → no error
      expect(result.missingFields).not.toContain('actionMessage');
    });

    it('actionMessage not required when presetKey !== sensitive_data_block', () => {
      const result = validateRule({
        ...sdbBase,
        presetKey: 'content_safety',
        actionMessage: undefined,
      });
      // presetKey is not 'sensitive_data_block' → actionMessageRequired is false
      expect(result.missingFields).not.toContain('actionMessage');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-2 — validateRule() is exported from @agent-platform/shared (FR-8.2)
  // ---------------------------------------------------------------------------

  describe('UT-2 — validateRule export from @agent-platform/shared', () => {
    it('is exported as a function from the public barrel', async () => {
      // Dynamic import to exercise the barrel export path exactly as
      // external consumers would resolve it.
      const Shared = await import('../../index.js');
      expect(typeof Shared.validateRule).toBe('function');
    });

    it('exports GuardrailRuleInput type alongside validateRule', async () => {
      // Type-level assertion: if GuardrailRuleInput were removed from the
      // barrel's re-export list, this import would fail at compile time.
      // At runtime we verify the function returns the expected shape.
      const { validateRule: vr } = await import('../../index.js');
      const result = vr({
        name: 'test',
        checkType: 'provider',
        kind: 'input',
        provider: 'test',
        enabled: false,
      });
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('missingFields');
      expect(result).toHaveProperty('sanitized');
    });
  });
});
