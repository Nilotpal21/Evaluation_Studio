/**
 * Entity compilation tests — semantic constructs redesign.
 *
 * Verifies:
 * - Top-level ENTITIES compile to ir.entities
 * - NLU.entities lower into ir.entities
 * - Conflict detection between ENTITIES and NLU.entities
 * - ENTITY_REF resolution on GATHER fields
 * - ENTITY_REF exclusivity (compile error if TYPE + entity_ref)
 * - Inline GATHER TYPE produces anonymous entity in ir.entities
 * - System entity types have built-in definitions
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';
import type { EntityDefinitionIR } from '../platform/ir/schema.js';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

function compileWithErrors(dsl: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  return compileABLtoIR([parseResult.document!]);
}

describe('Top-level ENTITIES compilation', () => {
  test('ENTITIES section compiles to ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeDefined();
    expect(agent.entities).toHaveLength(1);

    const entity = agent.entities![0];
    expect(entity.name).toBe('cabin_class');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['economy', 'business', 'first']);
    expect(entity.source).toBe('explicit');
  });
});

describe('ENTITIES compilation to ir.entities', () => {
  test('enum entity with synonyms compiles correctly', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR, GBP]
    SYNONYMS:
      USD: [usd, dollars, bucks]
      EUR: [eur, euros]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(1);

    const entity = agent.entities![0];
    expect(entity.name).toBe('currency_code');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['USD', 'EUR', 'GBP']);
    expect(entity.synonyms).toEqual({
      USD: ['usd', 'dollars', 'bucks'],
      EUR: ['eur', 'euros'],
    });
    expect(entity.source).toBe('explicit');
  });

  test('pattern entity with sensitive flag compiles correctly', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  ssn:
    TYPE: pattern
    PATTERN: "\\d{3}-\\d{2}-\\d{4}"
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities![0];

    expect(entity.name).toBe('ssn');
    expect(entity.type).toBe('pattern');
    expect(entity.pattern).toBe('\\d{3}-\\d{2}-\\d{4}');
    expect(entity.sensitive).toBe(true);
    expect(entity.source).toBe('explicit');
  });

  test('multiple entities compile in order', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR]
  travel_date:
    TYPE: date
  email_address:
    TYPE: email
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(3);
    expect(agent.entities![0].name).toBe('airport_code');
    expect(agent.entities![1].name).toBe('travel_date');
    expect(agent.entities![2].name).toBe('email_address');
  });

  test('agent with no ENTITIES has undefined ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeUndefined();
  });
});

describe('NLU.entities lowering to ir.entities', () => {
  test('NLU entities lower into ir.entities with source nlu_lowered', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book", "fly"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.length).toBeGreaterThanOrEqual(1);

    const entity = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('enum');
    expect(entity!.values).toEqual(['economy', 'business', 'first']);
    expect(entity!.source).toBe('nlu_lowered');
  });

  test('NLU entities still appear in ir.nlu.entities for backward compat', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    // Still in nlu.entities for backward compat
    expect(agent.nlu!.entities).toHaveLength(1);
    expect(agent.nlu!.entities[0].name).toBe('cabin_class');
    // Also in top-level entities
    expect(agent.entities!.find((e) => e.name === 'cabin_class')).toBeDefined();
  });

  test('ENTITIES and NLU.entities merge into one registry', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(2);

    const airport = agent.entities!.find((e) => e.name === 'airport_code');
    expect(airport!.source).toBe('explicit');
    const cabin = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(cabin!.source).toBe('nlu_lowered');
  });

  test('conflict: same entity name in ENTITIES and NLU.entities emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, premium]
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    const err = output.compilation_errors!.find((e) => e.message.includes('cabin_class'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('defined in both ENTITIES and NLU');
  });
});

describe('ENTITY_REF resolution in GATHER', () => {
  test('entity_ref inherits type and values from entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.name).toBe('cabin');
    expect(field.entity_ref).toBe('cabin_class');
    expect(field.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });

  test('entity_ref inherits synonyms from entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR]
    SYNONYMS:
      USD: [dollars, bucks]
      EUR: [euros]
GATHER:
  payout_currency:
    ENTITY_REF: currency_code
    PROMPT: "Which currency?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('currency_code');
    expect(field.synonyms).toEqual({ USD: ['dollars', 'bucks'], EUR: ['euros'] });
  });

  test('entity_ref preserves collection policy on GATHER field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  email_address:
    TYPE: email
GATHER:
  work_email:
    ENTITY_REF: email_address
    PROMPT: "Your work email?"
    VALIDATE: "must end with @company.com"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 3
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('email_address');
    expect(field.type).toBe('email');
    expect(field.validation).toBeDefined();
    expect(field.validation!.rule).toBe('must end with @company.com');
    expect(field.validation!.type).toBe('llm');
    expect(field.validation!.max_retries).toBe(3);
    expect(field.sensitive).toBe(true);
  });

  test('entity_ref to nonexistent entity emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin:
    ENTITY_REF: nonexistent_entity
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find((e) => e.message.includes('nonexistent_entity'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('not found in entity registry');
  });

  test('entity_ref works with NLU-lowered entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('cabin_class');
    expect(field.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });
});

describe('ENTITY_REF exclusivity', () => {
  test('entity_ref with TYPE emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    TYPE: number
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('TYPE'),
    );
    expect(err).toBeDefined();
  });

  test('entity_ref with OPTIONS emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    OPTIONS: [economy, first]
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('redefine'),
    );
    expect(err).toBeDefined();
  });

  test('entity_ref WITHOUT entity-level props is valid', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
    REQUIRED: true
    VALIDATE: "must not be empty"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 2
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);
    const agent = output.agents['TestAgent'];
    expect(agent.gather.fields[0].entity_ref).toBe('cabin_class');
  });
});

describe('Inline GATHER TYPE to anonymous entity', () => {
  test('inline TYPE: enum produces anonymous entity in ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin_class:
    TYPE: enum
    OPTIONS: [economy, business, first]
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Anonymous entity should be created
    expect(agent.entities).toBeDefined();
    const entity = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('enum');
    expect(entity!.values).toEqual(['economy', 'business', 'first']);
    expect(entity!.source).toBe('gather_inline');
  });

  test('inline TYPE: email produces anonymous entity with system type', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  user_email:
    TYPE: email
    PROMPT: "Your email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    const entity = agent.entities!.find((e) => e.name === 'user_email');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('email');
    expect(entity!.source).toBe('gather_inline');
  });

  test('inline TYPE: date produces anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  departure_date:
    TYPE: date
    PROMPT: "When?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    const entity = agent.entities!.find((e) => e.name === 'departure_date');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('date');
    expect(entity!.source).toBe('gather_inline');
  });

  test('GATHER field with entity_ref does NOT create anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Only the explicit entity, no anonymous entity for 'cabin'
    expect(agent.entities!.filter((e) => e.source === 'gather_inline')).toHaveLength(0);
    expect(agent.entities!.filter((e) => e.source === 'explicit')).toHaveLength(1);
  });

  test('mixed: explicit ENTITIES + inline GATHER types all in ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX]
GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: "From?"
  departure_date:
    TYPE: date
    PROMPT: "When?"
  passenger_email:
    TYPE: email
    PROMPT: "Email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toHaveLength(3);
    expect(agent.entities!.find((e) => e.name === 'airport_code')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'departure_date')!.source).toBe('gather_inline');
    expect(agent.entities!.find((e) => e.name === 'passenger_email')!.source).toBe('gather_inline');
  });

  test('existing ABL with no ENTITIES still works (backward compat)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
  email:
    PROMPT: "Email?"
    TYPE: email
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Should compile without errors — anonymous entities created
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'name')).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'email')).toBeDefined();

    // GATHER fields still work as before
    expect(agent.gather.fields[0].name).toBe('name');
    expect(agent.gather.fields[0].type).toBe('string');
    expect(agent.gather.fields[1].name).toBe('email');
  });
});

describe('Integration: NLU + ENTITIES + GATHER + entity_ref', () => {
  test('full canonical model: ENTITIES + NLU intents + GATHER entity_ref', () => {
    const dsl = `
AGENT: FlightAgent
GOAL: "Help book flights"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR, SFO]
    SYNONYMS:
      JFK: [kennedy, new york]
      LAX: [los angeles]
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book", "fly", "flight"]
GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying from?"
    REQUIRED: true
  destination:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying to?"
    REQUIRED: true
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
    ACTIVATION: optional
  departure_date:
    TYPE: date
    PROMPT: "When do you want to fly?"
    REQUIRED: true
`;
    const agent = compileAgent(dsl, 'FlightAgent');

    // Entity registry has all entities
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'airport_code')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'cabin_class')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'departure_date')!.source).toBe('gather_inline');

    // GATHER fields resolve entity_ref correctly
    const origin = agent.gather.fields.find((f) => f.name === 'origin')!;
    expect(origin.entity_ref).toBe('airport_code');
    expect(origin.type).toBe('enum');
    expect(origin.enum_values).toEqual(['JFK', 'LAX', 'LHR', 'SFO']);
    expect(origin.synonyms).toEqual({ JFK: ['kennedy', 'new york'], LAX: ['los angeles'] });

    const destination = agent.gather.fields.find((f) => f.name === 'destination')!;
    expect(destination.entity_ref).toBe('airport_code');
    expect(destination.type).toBe('enum');

    const cabin = agent.gather.fields.find((f) => f.name === 'cabin')!;
    expect(cabin.entity_ref).toBe('cabin_class');
    expect(cabin.type).toBe('enum');
    expect(cabin.enum_values).toEqual(['economy', 'business', 'first']);

    // Inline type still works
    const date = agent.gather.fields.find((f) => f.name === 'departure_date')!;
    expect(date.entity_ref).toBeUndefined();
    expect(date.type).toBe('date');

    // NLU intents still compiled
    expect(agent.nlu!.intents).toHaveLength(1);
  });

  test('legacy ABL: NLU entities + GATHER name matching still works', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
      SYNONYMS:
        economy: [coach, standard]
GATHER:
  cabin_class:
    PROMPT: "Cabin?"
    TYPE: enum
    OPTIONS: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // mergeNLUIntoGather should still work
    const field = agent.gather.fields[0];
    expect(field.name).toBe('cabin_class');
    expect(field.synonyms).toEqual({ economy: ['coach', 'standard'] });

    // Entity also in registry
    expect(agent.entities!.find((e) => e.name === 'cabin_class')).toBeDefined();
  });
});

describe('System entity intrinsic validation on inline GATHER', () => {
  test('inline TYPE: email creates anonymous entity with intrinsic_validation containing RFC', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  user_email:
    TYPE: email
    PROMPT: "Your email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'user_email');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('email');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('RFC');
  });

  test('inline TYPE: phone creates anonymous entity with intrinsic_validation containing phone', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  contact_phone:
    TYPE: phone
    PROMPT: "Your phone number?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'contact_phone');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('phone');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation!.toLowerCase()).toContain('phone');
  });

  test('inline TYPE: date creates anonymous entity with intrinsic_validation containing date', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  departure_date:
    TYPE: date
    PROMPT: "When?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'departure_date');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('date');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation!.toLowerCase()).toContain('date');
  });

  test('inline TYPE: boolean creates anonymous entity with intrinsic_validation containing true or false', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  opt_in:
    TYPE: boolean
    PROMPT: "Do you agree?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'opt_in');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('boolean');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('true or false');
  });

  test('inline TYPE: currency creates anonymous entity with intrinsic_validation containing currency', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  amount:
    TYPE: currency
    PROMPT: "How much?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'amount');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('currency');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation!.toLowerCase()).toContain('currency');
  });

  test('inline TYPE: datetime creates anonymous entity with intrinsic_validation containing date', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  appointment_time:
    TYPE: datetime
    PROMPT: "When is your appointment?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'appointment_time');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('datetime');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation!.toLowerCase()).toContain('date');
  });

  test('inline TYPE: string does NOT get intrinsic_validation', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  full_name:
    TYPE: string
    PROMPT: "Your name?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'full_name');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('string');
    expect(entity!.intrinsic_validation).toBeUndefined();
  });

  test('explicit ENTITIES with custom VALIDATION is NOT overwritten by system validation', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  user_email:
    TYPE: email
    VALIDATION: "must end with @company.com"
GATHER:
  work_email:
    ENTITY_REF: user_email
    PROMPT: "Your work email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // The explicit entity should keep its custom validation, not system intrinsic
    const entity = agent.entities!.find((e) => e.name === 'user_email');
    expect(entity).toBeDefined();
    expect(entity!.source).toBe('explicit');
    expect(entity!.intrinsic_validation).toBe('must end with @company.com');
  });

  test('boolean system entity injects values [true, false, yes, no]', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  consent:
    TYPE: boolean
    PROMPT: "Do you consent?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities!.find((e) => e.name === 'consent');
    expect(entity).toBeDefined();
    expect(entity!.values).toEqual(['true', 'false', 'yes', 'no']);
  });
});

describe('Integration: all 6 system entity types in one agent', () => {
  test('inline GATHER produces entities with intrinsic_validation for all system types', () => {
    const dsl = `
AGENT: FullSystemTest
GOAL: "Test all system entity types"
GATHER:
  contact_email:
    TYPE: email
    PROMPT: "Your email?"
    REQUIRED: true
  contact_phone:
    TYPE: phone
    PROMPT: "Your phone?"
  departure:
    TYPE: date
    PROMPT: "When?"
  arrival_time:
    TYPE: datetime
    PROMPT: "Arrival time?"
  confirmed:
    TYPE: boolean
    PROMPT: "Confirm?"
  amount:
    TYPE: currency
    PROMPT: "Amount?"
  name:
    TYPE: string
    PROMPT: "Name?"
`;
    const agent = compileAgent(dsl, 'FullSystemTest');
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.length).toBeGreaterThanOrEqual(7);

    const emailEntity = agent.entities!.find((e) => e.name === 'contact_email');
    expect(emailEntity!.type).toBe('email');
    expect(emailEntity!.intrinsic_validation).toContain('RFC');
    expect(emailEntity!.source).toBe('gather_inline');

    const phoneEntity = agent.entities!.find((e) => e.name === 'contact_phone');
    expect(phoneEntity!.type).toBe('phone');
    expect(phoneEntity!.intrinsic_validation).toContain('phone');

    const dateEntity = agent.entities!.find((e) => e.name === 'departure');
    expect(dateEntity!.type).toBe('date');
    expect(dateEntity!.intrinsic_validation).toContain('date');

    const datetimeEntity = agent.entities!.find((e) => e.name === 'arrival_time');
    expect(datetimeEntity!.type).toBe('datetime');
    expect(datetimeEntity!.intrinsic_validation).toContain('date');

    const boolEntity = agent.entities!.find((e) => e.name === 'confirmed');
    expect(boolEntity!.type).toBe('boolean');
    expect(boolEntity!.intrinsic_validation).toContain('true or false');
    expect(boolEntity!.values).toEqual(['true', 'false', 'yes', 'no']);

    const currencyEntity = agent.entities!.find((e) => e.name === 'amount');
    expect(currencyEntity!.type).toBe('currency');
    expect(currencyEntity!.intrinsic_validation).toContain('currency');

    // string type should NOT have intrinsic_validation
    const stringEntity = agent.entities!.find((e) => e.name === 'name');
    expect(stringEntity!.type).toBe('string');
    expect(stringEntity!.intrinsic_validation).toBeUndefined();
  });

  test('explicit ENTITIES with ENTITY_REF preserve custom validation over system defaults', () => {
    const dsl = `
AGENT: MixedTest
GOAL: "Test mixed explicit + inline"
ENTITIES:
  corp_email:
    TYPE: email
    VALIDATION: "Must end with @corp.com"
  custom_phone:
    TYPE: phone
GATHER:
  work_email:
    ENTITY_REF: corp_email
    PROMPT: "Work email?"
  cell_phone:
    ENTITY_REF: custom_phone
    PROMPT: "Cell?"
  backup_email:
    TYPE: email
    PROMPT: "Backup email?"
`;
    const agent = compileAgent(dsl, 'MixedTest');
    expect(agent.entities).toBeDefined();

    // Explicit entity keeps custom validation
    const corpEmail = agent.entities!.find((e) => e.name === 'corp_email');
    expect(corpEmail!.intrinsic_validation).toBe('Must end with @corp.com');
    expect(corpEmail!.source).toBe('explicit');

    // Explicit entity without custom validation has no intrinsic_validation
    const customPhone = agent.entities!.find((e) => e.name === 'custom_phone');
    expect(customPhone!.source).toBe('explicit');

    // Inline GATHER email gets system intrinsic_validation
    const backupEmail = agent.entities!.find((e) => e.name === 'backup_email');
    expect(backupEmail!.intrinsic_validation).toContain('RFC');
    expect(backupEmail!.source).toBe('gather_inline');
  });
});
