/**
 * Regression tests for NLU pipeline enhancements (ABLP-403).
 *
 * Finding 1: FLOW step gather metadata propagation (sensitive, transient, etc.)
 * Finding 3: FLOW-local typed fields lowered into ir.entities
 * Finding 4: FLOW ENTITY_REF exclusivity enforcement
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
  return { agent, output };
}

// =============================================================================
// Finding 1 — FLOW step gather metadata propagation
// =============================================================================

describe('FLOW step gather metadata propagation (Finding 1)', () => {
  test('sensitive flag propagates from FLOW gather field to compiled IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_ssn:
    REASONING: false
    PROMPT: "Collecting SSN"
    GATHER:
      - ssn:
          TYPE: string
          PROMPT: "SSN?"
          SENSITIVE: true
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect_ssn'];
    const field = step.gather!.fields[0];

    expect(field.name).toBe('ssn');
    expect(field.sensitive).toBe(true);
  });

  test('transient flag propagates from FLOW gather field to compiled IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_otp:
    REASONING: false
    PROMPT: "Collecting OTP"
    GATHER:
      - otp_code:
          TYPE: string
          PROMPT: "Enter OTP"
          TRANSIENT: true
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect_otp'];
    const field = step.gather!.fields[0];

    expect(field.name).toBe('otp_code');
    expect(field.transient).toBe(true);
  });

  test('sensitive_display propagates from FLOW gather field to compiled IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_card:
    REASONING: false
    PROMPT: "Collecting card"
    GATHER:
      - card_number:
          TYPE: string
          PROMPT: "Card number?"
          SENSITIVE: true
          SENSITIVE_DISPLAY: mask
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect_card'];
    const field = step.gather!.fields[0];

    expect(field.sensitive).toBe(true);
    expect(field.sensitive_display).toBe('mask');
  });

  test('mask_config propagates from FLOW gather field to compiled IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_card:
    REASONING: false
    PROMPT: "Collecting card"
    GATHER:
      - card_number:
          TYPE: string
          PROMPT: "Card number?"
          SENSITIVE: true
          SENSITIVE_DISPLAY: mask
          MASK_CONFIG:
            SHOW_LAST: 4
            SHOW_FIRST: 0
            CHAR: "*"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect_card'];
    const field = step.gather!.fields[0];

    expect(field.mask_config).toBeDefined();
    expect(field.mask_config!.show_last).toBe(4);
    expect(field.mask_config!.show_first).toBe(0);
    expect(field.mask_config!.char).toBe('*');
  });

  test('fields without sensitive/transient have undefined metadata', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_name:
    REASONING: false
    PROMPT: "Collecting name"
    GATHER:
      - name:
          TYPE: string
          PROMPT: "Your name?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');
    const step = agent.flow!.definitions['collect_name'];
    const field = step.gather!.fields[0];

    expect(field.sensitive).toBeUndefined();
    expect(field.sensitive_display).toBeUndefined();
    expect(field.mask_config).toBeUndefined();
    expect(field.transient).toBeUndefined();
  });
});

// =============================================================================
// Finding 3 — FLOW-local typed fields lowered into ir.entities
// =============================================================================

describe('FLOW-to-entity lowering (Finding 3)', () => {
  test('FLOW gather field with TYPE creates anonymous entity in ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_info:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - user_email:
          TYPE: email
          PROMPT: "Email?"
      - user_phone:
          TYPE: phone
          PROMPT: "Phone?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toBeDefined();
    expect(agent.entities!.length).toBeGreaterThanOrEqual(2);

    const emailEntity = agent.entities!.find((e) => e.name === 'user_email');
    expect(emailEntity).toBeDefined();
    expect(emailEntity!.type).toBe('email');
    expect(emailEntity!.source).toBe('gather_inline');

    const phoneEntity = agent.entities!.find((e) => e.name === 'user_phone');
    expect(phoneEntity).toBeDefined();
    expect(phoneEntity!.type).toBe('phone');
    expect(phoneEntity!.source).toBe('gather_inline');
  });

  test('FLOW gather field with TYPE string does NOT create anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_name:
    REASONING: false
    PROMPT: "Collecting name"
    GATHER:
      - name:
          TYPE: string
          PROMPT: "Name?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');

    // string type fields do not create anonymous entities
    if (agent.entities) {
      const nameEntity = agent.entities.find((e) => e.name === 'name');
      expect(nameEntity).toBeUndefined();
    }
  });

  test('FLOW gather field with entity_ref does NOT create anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  device_type:
    TYPE: enum
    VALUES: [laptop, phone, tablet]
FLOW:
  collect_device:
    REASONING: false
    PROMPT: "Collecting device"
    GATHER:
      - device:
          ENTITY_REF: device_type
          PROMPT: "Which device?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toBeDefined();
    // device_type from ENTITIES exists, but no duplicate for 'device'
    const deviceTypeEntity = agent.entities!.find((e) => e.name === 'device_type');
    expect(deviceTypeEntity).toBeDefined();

    // 'device' should NOT appear as a separate entity (it uses entity_ref)
    const deviceInlineEntity = agent.entities!.find(
      (e) => e.name === 'device' && e.source === 'gather_inline',
    );
    expect(deviceInlineEntity).toBeUndefined();
  });

  test('FLOW gather typed field skips creation if entity already exists', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  user_email:
    TYPE: email
FLOW:
  collect_info:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - user_email:
          TYPE: email
          PROMPT: "Email?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toBeDefined();
    // Only one entity named 'user_email' — no duplicate
    const emailEntities = agent.entities!.filter((e) => e.name === 'user_email');
    expect(emailEntities).toHaveLength(1);
  });

  test('FLOW gather field with sensitive flag propagates to anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
FLOW:
  collect_ssn:
    REASONING: false
    PROMPT: "Collecting SSN"
    GATHER:
      - ssn:
          TYPE: number
          PROMPT: "SSN?"
          SENSITIVE: true
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent } = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toBeDefined();
    const ssnEntity = agent.entities!.find((e) => e.name === 'ssn');
    expect(ssnEntity).toBeDefined();
    expect(ssnEntity!.sensitive).toBe(true);
  });
});

// =============================================================================
// Finding 4 — FLOW ENTITY_REF exclusivity enforcement
// =============================================================================

describe('FLOW ENTITY_REF exclusivity (Finding 4)', () => {
  test('FLOW gather field with entity_ref + TYPE produces compilation error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  device_type:
    TYPE: enum
    VALUES: [laptop, phone, tablet]
FLOW:
  collect_device:
    REASONING: false
    PROMPT: "Collecting device"
    GATHER:
      - device:
          ENTITY_REF: device_type
          TYPE: number
          PROMPT: "Which device?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    const output = compileABLtoIR([parseResult.document!]);

    expect(output.compilation_errors).toBeDefined();
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    expect(
      output.compilation_errors!.some(
        (e) => e.message.includes('ENTITY_REF') && e.message.includes('device'),
      ),
    ).toBe(true);
  });

  test('FLOW gather field with entity_ref + OPTIONS produces compilation error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  device_type:
    TYPE: enum
    VALUES: [laptop, phone, tablet]
FLOW:
  collect_device:
    REASONING: false
    PROMPT: "Collecting device"
    GATHER:
      - device:
          ENTITY_REF: device_type
          OPTIONS: [laptop, phone]
          PROMPT: "Which device?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    const output = compileABLtoIR([parseResult.document!]);

    expect(output.compilation_errors).toBeDefined();
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    expect(
      output.compilation_errors!.some(
        (e) => e.message.includes('ENTITY_REF') && e.message.includes('OPTIONS'),
      ),
    ).toBe(true);
  });

  test('FLOW gather field with entity_ref only (no TYPE/OPTIONS) resolves normally', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  device_type:
    TYPE: enum
    VALUES: [laptop, phone, tablet]
FLOW:
  collect_device:
    REASONING: false
    PROMPT: "Collecting device"
    GATHER:
      - device:
          ENTITY_REF: device_type
          PROMPT: "Which device?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { agent, output } = compileAgent(dsl, 'TestAgent');

    // No compilation errors expected
    const relevantErrors = (output.compilation_errors ?? []).filter(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('device'),
    );
    expect(relevantErrors).toHaveLength(0);

    // Field should have inherited type and values from entity
    const step = agent.flow!.definitions['collect_device'];
    const field = step.gather!.fields[0];
    expect(field.type).toBe('enum');
    expect(field.enum_values).toEqual(['laptop', 'phone', 'tablet']);
  });

  test('FLOW gather field with entity_ref + TYPE:string is allowed (string is default)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  device_type:
    TYPE: enum
    VALUES: [laptop, phone, tablet]
FLOW:
  collect_device:
    REASONING: false
    PROMPT: "Collecting device"
    GATHER:
      - device:
          ENTITY_REF: device_type
          TYPE: string
          PROMPT: "Which device?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const { output } = compileAgent(dsl, 'TestAgent');

    // TYPE: string is the default, so it should NOT trigger exclusivity error
    const relevantErrors = (output.compilation_errors ?? []).filter(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('device'),
    );
    expect(relevantErrors).toHaveLength(0);
  });
});
