/**
 * Parser tests for entity extraction gap fixes.
 *
 * Gap 5:  max_retries parsing in top-level GATHER
 * Gap 31: SENSITIVE flag parsing on NLU entity definitions
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// =============================================================================
// Gap 5 — max_retries parsing in top-level GATHER
// =============================================================================

describe('GATHER max_retries parsing (Gap 5)', () => {
  test('parses max_retries as integer on GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  email:
    PROMPT: "What is your email?"
    TYPE: string
    VALIDATE: "contains '@'"
    MAX_RETRIES: 3
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field.name).toBe('email');
    expect(field.maxRetries).toBe(3);
  });

  test('max_retries coexists with retry_prompt and validation_process', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  phone:
    PROMPT: "Phone number?"
    TYPE: string
    VALIDATE: "^\\\\+?[0-9]{10,14}$"
    RETRY_PROMPT: "Please enter a valid phone number."
    MAX_RETRIES: 5
    VALIDATION_PROCESS: REGEX
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.maxRetries).toBe(5);
    expect(field.retryPrompt).toBe('Please enter a valid phone number.');
    expect(field.validationProcess).toBe('REGEX');
  });

  test('max_retries not present yields undefined', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.maxRetries).toBeUndefined();
  });

  test('max_retries parses in FLOW step GATHER', () => {
    const dsl = `AGENT: Test
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - email:
          TYPE: string
          PROMPT: "Email?"
          VALIDATION: "contains '@'"
          MAX_RETRIES: 2
          RETRY_PROMPT: "Try again."
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['collect'];
    const field = step.gather!.fields[0];
    expect(field.name).toBe('email');
    expect(field.maxRetries).toBe(2);
    expect(field.retryPrompt).toBe('Try again.');
  });
});

// =============================================================================
// Gap 31 — SENSITIVE flag on NLU entity definitions
// =============================================================================

describe('NLU entity SENSITIVE parsing (Gap 31)', () => {
  test('parses SENSITIVE: true on NLU entity', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
NLU:
  entities:
    - NAME: ssn
      TYPE: pattern
      PATTERN: "\\d{3}-\\d{2}-\\d{4}"
      SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.nlu).toBeDefined();

    const entity = result.document!.nlu!.entities[0];
    expect(entity.name).toBe('ssn');
    expect(entity.sensitive).toBe(true);
  });

  test('parses SENSITIVE: yes as true', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
NLU:
  entities:
    - NAME: credit_card
      TYPE: pattern
      SENSITIVE: yes
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.nlu!.entities[0];
    expect(entity.sensitive).toBe(true);
  });

  test('SENSITIVE defaults to undefined when not specified', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
NLU:
  entities:
    - NAME: product
      TYPE: enum
      VALUES: [iPhone, iPad, Mac]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.nlu!.entities[0];
    expect(entity.name).toBe('product');
    expect(entity.sensitive).toBeUndefined();
  });

  test('SENSITIVE: false parses as false', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
NLU:
  entities:
    - NAME: product
      TYPE: enum
      SENSITIVE: false
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.nlu!.entities[0];
    expect(entity.sensitive).toBe(false);
  });

  test('SENSITIVE coexists with other NLU entity properties', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
NLU:
  entities:
    - NAME: phone_number
      TYPE: pattern
      PATTERN: "\\+?[0-9]{10,14}"
      VALIDATION: "must be 10-14 digits"
      SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.nlu!.entities[0];
    expect(entity.name).toBe('phone_number');
    expect(entity.type).toBe('pattern');
    expect(entity.pattern).toBe('\\+?[0-9]{10,14}');
    expect(entity.validation).toBe('must be 10-14 digits');
    expect(entity.sensitive).toBe(true);
  });
});
