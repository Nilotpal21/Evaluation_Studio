import { describe, test, expect } from 'vitest';
import {
  validateInputMappings,
  validateInputMappingsForAgent,
} from '../platform/ir/validate-input-mappings.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR } from '../platform/ir/schema.js';

function makeAgent(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'booking_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
  } as AgentIR;
}

describe('validateInputMappings', () => {
  test('plain dot path produces no warning', () => {
    const warnings = validateInputMappings(
      { name: 'user.name', age: 'user.age' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(0);
  });

  test('function call syntax produces warning', () => {
    const warnings = validateInputMappings(
      { formatted: 'abl.upper(user.name)' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CEL_IN_INPUT_MAPPING');
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('abl.upper');
  });

  test('logical operators produce warning', () => {
    const warnings = validateInputMappings({ flag: 'a && b' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CEL_IN_INPUT_MAPPING');
  });

  test('OR operator produces warning', () => {
    const warnings = validateInputMappings({ flag: 'a || b' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
  });

  test('arithmetic operators (space-padded) produce warning', () => {
    const warnings = validateInputMappings({ total: 'price + tax' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
  });

  test('multiplication operator produces warning', () => {
    const warnings = validateInputMappings(
      { total: 'price * quantity' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(1);
  });

  test('subtraction (space-padded) produces warning', () => {
    const warnings = validateInputMappings({ diff: 'a - b' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
  });

  test('hyphenated path (not arithmetic) produces no warning', () => {
    const warnings = validateInputMappings(
      { id: 'user.account-id' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(0);
  });

  test('simple variable name produces no warning', () => {
    const warnings = validateInputMappings({ x: 'x' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(0);
  });

  test('nested dot path produces no warning', () => {
    const warnings = validateInputMappings({ deep: 'a.b.c.d' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(0);
  });

  test('multiple fields — only CEL ones get warnings', () => {
    const warnings = validateInputMappings(
      {
        name: 'user.name',
        formatted: 'abl.upper(user.name)',
        total: 'price + tax',
      },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(2);
  });

  test('warning message includes agent and delegate target info', () => {
    const warnings = validateInputMappings(
      { formatted: 'abl.upper(x)' },
      'my_agent',
      'target_agent',
    );
    expect(warnings[0].message).toContain('DELEGATE to "target_agent"');
  });

  test('warning includes correct type field', () => {
    const warnings = validateInputMappings(
      { formatted: 'abl.upper(x)' },
      'my_agent',
      'target_agent',
    );
    expect(warnings[0].type).toBe('validation');
  });

  test('warning includes agent name', () => {
    const warnings = validateInputMappings(
      { formatted: 'abl.upper(x)' },
      'my_agent',
      'target_agent',
    );
    expect(warnings[0].agent).toBe('my_agent');
  });

  test('agent-level wrapper annotates warnings with delegate input paths', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [],
      delegates: [
        {
          agent: 'specialist_agent',
          when: 'always',
          purpose: 'Specialist help',
          input: { formatted: 'abl.upper(user.name)' },
          returns: {},
          use_result: 'delegate_result',
          on_failure: 'continue',
        },
      ],
    };

    const warnings = validateInputMappingsForAgent(agent);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(VALIDATION_CODES.CEL_IN_INPUT_MAPPING);
    expect(warnings[0].path).toBe('coordination.delegates[0].input.formatted');
  });
});
