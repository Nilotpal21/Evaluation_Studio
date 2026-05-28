/**
 * Parser tests for the top-level ENTITIES section and ENTITY_REF on GATHER.
 *
 * Verifies:
 * - ENTITIES section parses enum, pattern, location, date entities
 * - Entity synonyms parse correctly
 * - Entity sensitive flag parses
 * - ENTITY_REF parses on top-level GATHER fields
 * - ENTITY_REF parses on FLOW GATHER fields
 * - ENTITY_REF and TYPE cannot coexist (parser allows; compiler rejects)
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('ENTITIES section parsing', () => {
  test('parses enum entity with values', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toBeDefined();
    expect(result.document!.entities).toHaveLength(1);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('cabin_class');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['economy', 'business', 'first']);
  });

  test('parses pattern entity with regex', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  booking_ref:
    TYPE: pattern
    PATTERN: "[A-Z]{2}\\\\d{6}"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('booking_ref');
    expect(entity.type).toBe('pattern');
    expect(entity.pattern).toBe('[A-Z]{2}\\\\d{6}');
  });

  test('parses entity with synonyms', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR, GBP]
    SYNONYMS:
      USD: [usd, dollars, bucks]
      EUR: [eur, euros]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('currency_code');
    expect(entity.synonyms).toEqual({
      USD: ['usd', 'dollars', 'bucks'],
      EUR: ['eur', 'euros'],
    });
  });

  test('parses entity with sensitive flag', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  ssn:
    TYPE: pattern
    PATTERN: "\\\\d{3}-\\\\d{2}-\\\\d{4}"
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('ssn');
    expect(entity.sensitive).toBe(true);
  });

  test('parses multiple entities', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR]
  travel_date:
    TYPE: date
  passenger_email:
    TYPE: email
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toHaveLength(3);

    expect(result.document!.entities![0].name).toBe('airport_code');
    expect(result.document!.entities![0].type).toBe('enum');
    expect(result.document!.entities![1].name).toBe('travel_date');
    expect(result.document!.entities![1].type).toBe('date');
    expect(result.document!.entities![2].name).toBe('passenger_email');
    expect(result.document!.entities![2].type).toBe('email');
    expect(result.document!.entities![2].sensitive).toBe(true);
  });

  test('parses entity with intrinsic validation', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  phone_number:
    TYPE: phone
    VALIDATION: "\\\\+?[0-9]{10,14}"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('phone_number');
    expect(entity.type).toBe('phone');
    expect(entity.validation).toBe('\\\\+?[0-9]{10,14}');
  });

  test('ENTITIES section absent yields undefined', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toBeUndefined();
  });
});

describe('ENTITY_REF parsing on GATHER fields', () => {
  test('parses entity_ref on top-level GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
    REQUIRED: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.name).toBe('cabin');
    expect(field.entityRef).toBe('cabin_class');
    expect(field.prompt).toBe('What cabin class?');
    expect(field.required).toBe(true);
  });

  test('entity_ref field with no TYPE still gets default type', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.entityRef).toBe('cabin_class');
    // Parser still sets default type 'string' — compiler will override from entity
    expect(field.type).toBe('string');
  });

  test('entity_ref coexists with collection policy properties', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  work_email:
    ENTITY_REF: email
    PROMPT: "Your work email?"
    REQUIRED: true
    VALIDATE: "must end with @company.com"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 3
    RETRY_PROMPT: "Please enter your work email."
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.entityRef).toBe('email');
    expect(field.validate).toBe('must end with @company.com');
    expect(field.validationProcess).toBe('LLM');
    expect(field.maxRetries).toBe(3);
    expect(field.retryPrompt).toBe('Please enter your work email.');
    expect(field.sensitive).toBe(true);
  });

  test('entity_ref on FLOW GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - cabin:
          ENTITY_REF: cabin_class
          PROMPT: "Cabin?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['collect'];
    const field = step.gather!.fields[0];
    expect(field.name).toBe('cabin');
    expect(field.entityRef).toBe('cabin_class');
  });
});

describe('ENTITIES section — negative / edge cases', () => {
  test('warns on unknown entity type (typo)', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  user_email:
    TYPE: emial
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings![0].message).toContain('Unknown entity type "emial"');
    // Still parses — treated as the raw string
    expect(result.document!.entities![0].type).toBe('emial');
  });

  test('entity with missing TYPE defaults to string', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  notes:
    VALUES: [a, b]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const entity = result.document!.entities![0];
    expect(entity.name).toBe('notes');
    expect(entity.type).toBe('string');
  });

  test('entity with empty VALUES list', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  color:
    TYPE: enum
    VALUES: []
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const entity = result.document!.entities![0];
    expect(entity.name).toBe('color');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual([]);
  });

  test('duplicate entity names both parse (last wins at IR level)', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business]
  cabin_class:
    TYPE: enum
    VALUES: [first, premium]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    // Parser captures both — dedup is a compiler concern
    expect(result.document!.entities!.length).toBe(2);
  });

  test('entity with SYNONYMS but no VALUES', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  color:
    TYPE: enum
    SYNONYMS:
      red: [crimson, scarlet]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const entity = result.document!.entities![0];
    expect(entity.synonyms).toEqual({ red: ['crimson', 'scarlet'] });
    expect(entity.values).toBeUndefined();
  });
});
