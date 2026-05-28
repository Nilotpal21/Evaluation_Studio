/**
 * Compiler tests for entity extraction gap fixes.
 *
 * Gap 5:  maxRetries wired through compileGather → validation.max_retries
 * Gap 6:  retryPrompt → validation.retry_prompt, validationProcess → validation.validation_process
 * Gap 9:  enum_values on FlowGatherField
 * Gap 30: mergeNLUIntoGather — NLU entity definitions merged into GATHER fields at compile time
 * Gap 31: sensitive flag in compileNLU
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).toBeDefined();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

// =============================================================================
// Gaps 5, 6 — Validation properties wired through compileGather
// =============================================================================

describe('compileGather validation wiring (Gaps 5, 6)', () => {
  test('maxRetries wires to validation.max_retries on enum field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
    OPTIONS: [iPhone, iPad, Mac]
    MAX_RETRIES: 3
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.max_retries).toBe(3);
  });

  test('retryPrompt wires to validation.retry_prompt on enum field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
    OPTIONS: [iPhone, iPad, Mac]
    RETRY_PROMPT: "Please choose iPhone, iPad, or Mac."
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.retry_prompt).toBe('Please choose iPhone, iPad, or Mac.');
  });

  test('validationProcess wires to validation.validation_process on enum field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
    OPTIONS: [iPhone, iPad, Mac]
    VALIDATION_PROCESS: LLM
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.validation_process).toBe('LLM');
  });

  test('all three properties wire through on custom validated field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  email:
    PROMPT: "Email?"
    TYPE: string
    VALIDATE: "contains '@'"
    MAX_RETRIES: 5
    RETRY_PROMPT: "Please enter a valid email."
    VALIDATION_PROCESS: REGEX
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.type).toBe('pattern');
    expect(field.validation!.max_retries).toBe(5);
    expect(field.validation!.retry_prompt).toBe('Please enter a valid email.');
    expect(field.validation!.validation_process).toBe('REGEX');
  });

  test('retryPrompt alone creates validation block (no validate/options)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
    RETRY_PROMPT: "I need your full name."
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.retry_prompt).toBe('I need your full name.');
  });

  test('maxRetries alone creates validation block', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
    MAX_RETRIES: 2
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.max_retries).toBe(2);
  });

  test('field with no validation props has no validation block', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeUndefined();
  });

  test('VALIDATE with default (no VALIDATION_PROCESS) compiles as pattern type', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  phone:
    PROMPT: "Phone?"
    TYPE: string
    VALIDATE: "^\\\\+?[0-9]{10,14}$"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation!.type).toBe('pattern');
  });

  test('VALIDATION_PROCESS: LLM compiles as llm type', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  address:
    PROMPT: "Address?"
    TYPE: string
    VALIDATE: "Must be a valid US street address"
    VALIDATION_PROCESS: LLM
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation!.type).toBe('llm');
    expect(field.validation!.rule).toBe('Must be a valid US street address');
  });

  test('invalid regex in VALIDATE throws compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  code:
    PROMPT: "Code?"
    TYPE: string
    VALIDATE: "[invalid regex"
`;
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    const output = compileABLtoIR([parseResult.document!]);

    expect(output.compilation_errors).toBeDefined();
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    expect(output.compilation_errors!.some((e) => /invalid regex/i.test(e.message))).toBe(true);
  });

  test('invalid regex with VALIDATION_PROCESS: LLM does NOT throw (natural language rule)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  code:
    PROMPT: "Code?"
    TYPE: string
    VALIDATE: "Must contain at least [one special character"
    VALIDATION_PROCESS: LLM
`;
    // Should compile fine — LLM validation uses natural language, not regex
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];
    expect(field.validation!.type).toBe('llm');
  });
});

// =============================================================================
// Gap 9 — enum_values on FlowGatherField
// =============================================================================

describe('FlowGatherField enum_values (Gap 9)', () => {
  test('FLOW step GATHER field with OPTIONS compiles enum_values', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - cabin_class:
          TYPE: enum
          PROMPT: "Cabin class?"
          OPTIONS: [economy, business, first]
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    const field = step.gather!.fields[0];

    expect(field.name).toBe('cabin_class');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });

  test('FLOW step GATHER field without OPTIONS has no enum_values', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - name:
          TYPE: string
          PROMPT: "Your name?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    const field = step.gather!.fields[0];

    expect(field.enum_values).toBeUndefined();
  });

  test('FLOW step GATHER validation properties wire through', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test scripted agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - email:
          TYPE: string
          PROMPT: "Email?"
          VALIDATION: "contains '@'"
          MAX_RETRIES: 3
          RETRY_PROMPT: "Invalid email."
          VALIDATION_PROCESS: REGEX
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    const field = step.gather!.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.max_retries).toBe(3);
    expect(field.validation!.retry_prompt).toBe('Invalid email.');
    expect(field.validation!.validation_process).toBe('REGEX');
  });
});

// =============================================================================
// Gap 31 — sensitive flag in compileNLU
// =============================================================================

describe('compileNLU sensitive flag (Gap 31)', () => {
  test('sensitive: true propagates to IR NLU entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  entities:
    - NAME: ssn
      TYPE: pattern
      PATTERN: "\\d{3}-\\d{2}-\\d{4}"
      SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.nlu).toBeDefined();
    expect(agent.nlu!.entities).toHaveLength(1);

    const entity = agent.nlu!.entities[0];
    expect(entity.name).toBe('ssn');
    expect(entity.sensitive).toBe(true);
  });

  test('sensitive not specified yields undefined in IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  entities:
    - NAME: product
      TYPE: enum
      VALUES: [iPhone, iPad]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.nlu!.entities[0];
    expect(entity.sensitive).toBeUndefined();
  });
});

// =============================================================================
// Gap 30 — mergeNLUIntoGather (compile-time NLU → GATHER merge)
// =============================================================================

describe('mergeNLUIntoGather (Gap 30)', () => {
  test('GATHER with options + matching NLU entity → synonyms merged, filtered to GATHER options', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
    OPTIONS: [iPhone, iPad]
NLU:
  entities:
    - NAME: device
      TYPE: enum
      VALUES: [iPhone, iPad, Mac, AirPods]
      SYNONYMS:
        iPhone: [apple phone, mobile]
        iPad: [tablet, apple tablet]
        Mac: [macbook, laptop]
        AirPods: [earbuds, headphones]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    // enum_values come from GATHER OPTIONS
    expect(field.enum_values).toEqual(['iPhone', 'iPad']);

    // synonyms should only include iPhone and iPad (GATHER options filter)
    expect(field.synonyms).toBeDefined();
    expect(field.synonyms!['iPhone']).toEqual(['apple phone', 'mobile']);
    expect(field.synonyms!['iPad']).toEqual(['tablet', 'apple tablet']);

    // Mac and AirPods synonyms NOT included (not in GATHER options)
    expect(field.synonyms!['Mac']).toBeUndefined();
    expect(field.synonyms!['AirPods']).toBeUndefined();
  });

  test('GATHER with options + NLU entity has no synonyms for those options → no synonyms on field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  size:
    PROMPT: "Size?"
    TYPE: enum
    OPTIONS: [small, medium, large]
NLU:
  entities:
    - NAME: size
      TYPE: enum
      VALUES: [tiny, huge]
      SYNONYMS:
        tiny: [mini, small]
        huge: [massive, enormous]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    // GATHER options are the enum_values
    expect(field.enum_values).toEqual(['small', 'medium', 'large']);

    // No synonyms match GATHER option keys (tiny/huge are NLU values, not GATHER options)
    expect(field.synonyms).toBeUndefined();
  });

  test('GATHER without options + NLU entity → brings all NLU values and synonyms', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
NLU:
  entities:
    - NAME: device
      TYPE: enum
      VALUES: [iPhone, iPad, Mac]
      SYNONYMS:
        iPhone: [apple phone]
        Mac: [macbook, laptop]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    // All NLU values come through
    expect(field.enum_values).toEqual(['iPhone', 'iPad', 'Mac']);

    // All NLU synonyms come through
    expect(field.synonyms).toBeDefined();
    expect(field.synonyms!['iPhone']).toEqual(['apple phone']);
    expect(field.synonyms!['Mac']).toEqual(['macbook', 'laptop']);
  });

  test('GATHER field with no matching NLU entity → unchanged', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
NLU:
  entities:
    - NAME: device
      TYPE: enum
      VALUES: [iPhone, iPad]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.name).toBe('name');
    expect(field.synonyms).toBeUndefined();
    expect(field.enum_values).toBeUndefined();
  });

  test('type mismatch between GATHER and NLU produces compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: number
NLU:
  entities:
    - NAME: device
      TYPE: enum
      VALUES: [iPhone, iPad]
`;
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    const output = compileABLtoIR([parseResult.document!]);

    // mergeNLUIntoGather throws, caught by compileABLtoIR → stored in compilation_errors
    expect(output.compilation_errors).toBeDefined();
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    expect(
      output.compilation_errors!.some((e) =>
        /type "number" but NLU entity has type "enum"/.test(e.message),
      ),
    ).toBe(true);
  });

  test('NLU free_text type maps to string for type comparison', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  notes:
    PROMPT: "Any notes?"
    TYPE: string
NLU:
  entities:
    - NAME: notes
      TYPE: free_text
`;
    // Should NOT throw — free_text maps to string
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];
    expect(field.name).toBe('notes');
  });

  test('merge applies to FLOW step GATHER fields too', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting"
    GATHER:
      - device:
          TYPE: enum
          PROMPT: "Device?"
          OPTIONS: [iPhone, iPad]
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
NLU:
  entities:
    - NAME: device
      TYPE: enum
      VALUES: [iPhone, iPad, Mac]
      SYNONYMS:
        iPhone: [apple phone]
        iPad: [tablet]
        Mac: [macbook]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect'];
    const field = step.gather!.fields[0];

    // Synonyms filtered to GATHER options (iPhone, iPad only)
    expect(field.synonyms).toBeDefined();
    expect(field.synonyms!['iPhone']).toEqual(['apple phone']);
    expect(field.synonyms!['iPad']).toEqual(['tablet']);
    expect(field.synonyms!['Mac']).toBeUndefined();
  });

  test('no NLU section → GATHER fields unchanged', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  device:
    PROMPT: "Which device?"
    TYPE: enum
    OPTIONS: [iPhone, iPad]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.enum_values).toEqual(['iPhone', 'iPad']);
    expect(field.synonyms).toBeUndefined();
  });
});
