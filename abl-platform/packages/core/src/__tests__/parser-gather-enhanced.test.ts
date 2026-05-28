/**
 * Enhanced GATHER Parser Tests
 *
 * Tests that the parser (parseAgentBasedABL) correctly parses new GATHER fields
 * from DSL text. These tests are expected to FAIL initially since the parser
 * does not yet support the new fields (semantics, range, list, preferences,
 * activation, dependsOn, promptMode, validationProcess, retryPrompt).
 *
 * Once the parser is updated (Step 3b), these tests should pass.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// =============================================================================
// Top-Level GATHER: New Fields
// =============================================================================

describe('Enhanced GATHER parsing - top-level', () => {
  test('parse semantics sub-block in top-level GATHER', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  destination:
    PROMPT: "Where?"
    TYPE: string
    SEMANTICS:
      FORMAT: airport_code
      LOOKUP: iata_codes
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('destination');
    expect(field.semantics).toBeDefined();
    expect(field.semantics).toEqual({
      format: 'airport_code',
      lookup: 'iata_codes',
    });
  });

  test('parse semantics with components', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  address:
    PROMPT: "What is your address?"
    TYPE: string
    SEMANTICS:
      FORMAT: address
      COMPONENTS: [street, city, state, zip, country]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('address');
    expect(field.semantics).toBeDefined();
    expect(field.semantics!.format).toBe('address');
    expect(field.semantics!.components).toEqual(['street', 'city', 'state', 'zip', 'country']);
  });

  test('parse range: true', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  budget:
    PROMPT: "What is your budget range?"
    TYPE: number
    RANGE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('budget');
    expect(field.range).toBe(true);
  });

  test('parse list: true', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  activities:
    PROMPT: "What activities interest you?"
    TYPE: string
    LIST: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('activities');
    expect(field.list).toBe(true);
  });

  test('parse preferences: true', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  dining:
    PROMPT: "Any dining preferences?"
    TYPE: string
    LIST: true
    PREFERENCES: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('dining');
    expect(field.list).toBe(true);
    expect(field.preferences).toBe(true);
  });

  test('parse activation: optional', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  special_requests:
    PROMPT: "Any special requests?"
    TYPE: string
    ACTIVATION: optional
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('special_requests');
    expect(field.activation).toBe('optional');
  });

  test('parse activation: progressive with depends_on', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  room_type:
    PROMPT: "What room type?"
    TYPE: string
    ACTIVATION: progressive
    DEPENDS_ON: [destination, travel_dates]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('room_type');
    expect(field.activation).toBe('progressive');
    expect(field.dependsOn).toEqual(['destination', 'travel_dates']);
  });

  test('parse activation with when condition', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  military_id:
    PROMPT: "Military ID for Hale Koa discount?"
    TYPE: string
    ACTIVATION:
      WHEN: "search_results contains 'Hale Koa'"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('military_id');
    expect(field.activation).toEqual({ when: "search_results contains 'Hale Koa'" });
  });

  test('parse prompt_mode: ask', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  destination:
    PROMPT: "Where would you like to go?"
    TYPE: string
    PROMPT_MODE: ask
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('destination');
    expect(field.promptMode).toBe('ask');
  });

  test('parse prompt_mode: extract_only', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  sentiment:
    PROMPT: "Detect user sentiment from conversation"
    TYPE: string
    PROMPT_MODE: extract_only
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('sentiment');
    expect(field.promptMode).toBe('extract_only');
  });

  test('parse validation_process: LLM', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  destination:
    PROMPT: "Where?"
    TYPE: string
    VALIDATION_PROCESS: LLM
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('destination');
    expect(field.validationProcess).toBe('LLM');
  });

  test('parse retry_prompt', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  email:
    PROMPT: "What is your email?"
    TYPE: string
    validate: "contains '@'"
    RETRY_PROMPT: "That doesn't seem valid. Please enter a valid email address."
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const field = result.document!.gather[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('email');
    expect(field.retryPrompt).toBe("That doesn't seem valid. Please enter a valid email address.");
  });
});

// =============================================================================
// FLOW Step GATHER: New Fields
// =============================================================================

describe('Enhanced GATHER parsing - FLOW steps', () => {
  test('parse all new fields in FLOW GATHER', () => {
    const dsl = `AGENT: Test
GOAL: "Test scripted agent"
FLOW:
  collect_info:
    REASONING: false
    PROMPT: "Let me collect your travel details."
    GATHER:
      - destination:
          TYPE: string
          PROMPT: "Where to?"
          SEMANTICS:
            FORMAT: airport_code
            LOOKUP: iata_codes
          RANGE: false
          LIST: false
          ACTIVATION: required
          PROMPT_MODE: ask
      - budget:
          TYPE: number
          PROMPT: "Budget range?"
          RANGE: true
          VALIDATION_PROCESS: LLM
          RETRY_PROMPT: "Please provide a valid budget."
      - activities:
          TYPE: string
          PROMPT: "What activities?"
          LIST: true
          PREFERENCES: true
          ACTIVATION: optional
      - room_type:
          TYPE: string
          PROMPT: "Room type?"
          ACTIVATION: progressive
          DEPENDS_ON: [destination, budget]
    NEXT: confirm
  confirm:
    REASONING: false
    RESPOND: "Thank you for the details!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.flow).toBeDefined();

    const defs = result.document!.flow!.definitions;
    const collectStep = defs['collect_info'];
    expect(collectStep).toBeDefined();
    expect(collectStep.gather).toBeDefined();
    expect(collectStep.gather!.fields.length).toBe(4);

    // destination field
    const destination = collectStep!.gather!.fields.find((f) => f.name === 'destination');
    expect(destination).toBeDefined();
    expect(destination!.semantics).toEqual({
      format: 'airport_code',
      lookup: 'iata_codes',
    });
    expect(destination!.range).toBe(false);
    expect(destination!.list).toBe(false);
    expect(destination!.activation).toBe('required');
    expect(destination!.promptMode).toBe('ask');

    // budget field
    const budget = collectStep!.gather!.fields.find((f) => f.name === 'budget');
    expect(budget).toBeDefined();
    expect(budget!.range).toBe(true);
    expect(budget!.validationProcess).toBe('LLM');
    expect(budget!.retryPrompt).toBe('Please provide a valid budget.');

    // activities field
    const activities = collectStep!.gather!.fields.find((f) => f.name === 'activities');
    expect(activities).toBeDefined();
    expect(activities!.list).toBe(true);
    expect(activities!.preferences).toBe(true);
    expect(activities!.activation).toBe('optional');

    // room_type field
    const roomType = collectStep!.gather!.fields.find((f) => f.name === 'room_type');
    expect(roomType).toBeDefined();
    expect(roomType!.activation).toBe('progressive');
    expect(roomType!.dependsOn).toEqual(['destination', 'budget']);
  });
});

// =============================================================================
// Backward Compatibility
// =============================================================================

describe('Enhanced GATHER parsing - backward compatibility', () => {
  test('basic GATHER still works', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  name:
    prompt: "What is your name?"
    type: string
    required: true
  email:
    prompt: "What is your email?"
    type: string
    required: false
    default: "none"
  age:
    prompt: "How old are you?"
    type: number
    infer: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const gather = result.document!.gather;
    expect(gather).toHaveLength(3);

    // name field
    expect(gather[0].name).toBe('name');
    expect(gather[0].prompt).toBe('What is your name?');
    expect(gather[0].type).toBe('string');
    expect(gather[0].required).toBe(true);

    // email field
    expect(gather[1].name).toBe('email');
    expect(gather[1].prompt).toBe('What is your email?');
    expect(gather[1].type).toBe('string');
    expect(gather[1].required).toBe(false);
    expect(gather[1].default).toBe('none');

    // age field
    expect(gather[2].name).toBe('age');
    expect(gather[2].prompt).toBe('How old are you?');
    expect(gather[2].type).toBe('number');
    expect(gather[2].infer).toBe(true);
  });
});
