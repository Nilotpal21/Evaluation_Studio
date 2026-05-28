/**
 * TDD lock tests for Slice 5 [ABLP-414] — PII_TYPE hint on GatherField.
 *
 * Bruce Wilcox flagged that non-canonical gather field names (e.g. `contact_info`,
 * `customer_number`, `dob`) cannot be reliably mapped to a PII type just from the
 * field name during XO11 migration. Users need an explicit hint.
 *
 * These tests lock the DSL contract:
 *   PII_TYPE: email        → piiType: 'email'
 *   PII_TYPE: phone        → piiType: 'phone'
 *   PII_TYPE: ssn          → piiType: 'ssn'
 *   PII_TYPE: credit_card  → piiType: 'credit_card'
 *   PII_TYPE: address      → piiType: 'address'
 *   PII_TYPE: name         → piiType: 'name'
 *   PII_TYPE: custom       → piiType: 'custom'
 *
 * Parses on both top-level GATHER and FLOW-step GATHER.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('GATHER PII_TYPE parsing (Slice 5 / ABLP-414)', () => {
  test('parses PII_TYPE: email on top-level GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  contact_info:
    PROMPT: "What is your contact info?"
    TYPE: string
    SENSITIVE: true
    SENSITIVE_DISPLAY: mask
    PII_TYPE: email
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.name).toBe('contact_info');
    expect(field.piiType).toBe('email');
  });

  test('parses each canonical PII_TYPE value', () => {
    const canonical = ['email', 'phone', 'ssn', 'credit_card', 'address', 'name', 'custom'];
    for (const piiType of canonical) {
      const dsl = `AGENT: Test
GOAL: "Test"
GATHER:
  some_field:
    PROMPT: "Value?"
    TYPE: string
    SENSITIVE: true
    PII_TYPE: ${piiType}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.gather[0].piiType).toBe(piiType);
    }
  });

  test('PII_TYPE is undefined when not specified', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.piiType).toBeUndefined();
  });

  test('PII_TYPE parses in FLOW step GATHER', () => {
    const dsl = `AGENT: Test
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - customer_number:
          TYPE: string
          PROMPT: "Your number?"
          SENSITIVE: true
          SENSITIVE_DISPLAY: mask
          PII_TYPE: phone
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['collect'];
    const field = step.gather!.fields[0];
    expect(field.name).toBe('customer_number');
    expect(field.piiType).toBe('phone');
  });

  test('unknown PII_TYPE values are silently dropped at parse time', () => {
    const dsl = `AGENT: Test
GOAL: "Test"
GATHER:
  field_a:
    PROMPT: "A?"
    TYPE: string
    SENSITIVE: true
    PII_TYPE: banana
  field_b:
    PROMPT: "B?"
    TYPE: string
    SENSITIVE: true
    PII_TYPE: EMAIL_ADDRESS
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const fieldA = result.document!.gather[0];
    const fieldB = result.document!.gather[1];
    expect(fieldA.piiType).toBeUndefined();
    expect(fieldB.piiType).toBeUndefined();
  });

  test('PII_TYPE coexists with SENSITIVE_DISPLAY and MASK_CONFIG', () => {
    const dsl = `AGENT: Test
GOAL: "Test"
GATHER:
  payment_info:
    PROMPT: "Card?"
    TYPE: string
    SENSITIVE: true
    SENSITIVE_DISPLAY: mask
    MASK_CONFIG:
      SHOW_FIRST: 0
      SHOW_LAST: 4
      CHAR: "*"
    PII_TYPE: credit_card
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.piiType).toBe('credit_card');
    expect(field.sensitive).toBe(true);
    expect(field.sensitiveDisplay).toBe('mask');
    expect(field.maskConfig).toEqual({ showFirst: 0, showLast: 4, char: '*' });
  });
});
