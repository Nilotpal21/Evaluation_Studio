/**
 * Session Memory Declaration Validation Tests
 *
 * Ensures the compiler warns when session variables are declared
 * but have no known population source.
 */

import { describe, test, expect } from 'vitest';
import { validateSessionMemoryDeclarations } from '../platform/ir/compiler.js';
import type { AgentIR } from '../platform/ir/schema.js';

/** Minimal AgentIR stub for validation testing */
function makeAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    metadata: { name: 'test_agent', kind: 'agent', description: '', source_hash: '' },
    identity: { goal: '', persona: '', limitations: [] },
    // mode is deprecated — execution style derived from flow presence
    execution: {} as any,
    gather: { fields: [], strategy: 'hybrid' },
    memory: {
      session: [],
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: { constraints: [], guardrails: [] },
    tools: [],
    coordination: { delegates: [], handoffs: [] },
    ...overrides,
  } as AgentIR;
}

describe('validateSessionMemoryDeclarations', () => {
  // -------------------------------------------------------------------------
  // No warnings — variable has a population source
  // -------------------------------------------------------------------------

  test('no warnings when no session variables declared', () => {
    const ir = makeAgentIR();
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by top-level GATHER field', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'destination' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      gather: {
        fields: [{ name: 'destination', type: 'string', required: true, prompt: 'Where?' }],
        strategy: 'hybrid',
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by flow step GATHER', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'num_guests' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            gather: {
              fields: [{ name: 'num_guests', type: 'number', required: true }],
            },
          },
        },
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by tool on_result', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'booking_id' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'create_booking',
          description: 'Create a booking',
          parameters: [],
          on_result: { set: { booking_id: '_result.id' } },
        },
      ],
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by tool on_error', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'error_code' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'check_inventory',
          description: 'Check inventory',
          parameters: [],
          on_error: { set: { error_code: '_error.code' } },
        },
      ],
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by REMEMBER trigger', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'user_preference' }],
        persistent: [],
        remember: [
          {
            when: 'user_preference IS SET',
            store: { value: 'user_preference', target: 'user_preference' },
          },
        ],
        recall: [],
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by RECALL inject_context', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'loyalty_tier' }],
        persistent: [],
        remember: [],
        recall: [
          {
            event: 'session:start',
            instruction: 'Load loyalty tier',
            action: { type: 'inject_context', paths: ['loyalty_tier'] },
          },
        ],
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by flow step SET', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'total_price' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['calc'],
        definitions: {
          calc: {
            name: 'calc',
            set: [{ variable: 'total_price', expression: 'unit_price * quantity' }],
          },
        },
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by delegate returns', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'search_results' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      coordination: {
        delegates: [
          {
            agent: 'search_agent',
            when: 'search needed',
            purpose: 'Search',
            input: {},
            returns: { results: 'search_results' },
            use_result: 'show results',
            on_failure: 'continue',
          },
        ],
        handoffs: [],
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by handoff on_return map', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'booking_ref' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'booking_agent',
            when: 'booking needed',
            context: { pass: [], summary: 'Book' },
            return: true,
            on_return: { action: 'continue', map: { reference: 'booking_ref' } },
          },
        ],
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by flow step ON_INPUT branch set', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'user_choice' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['ask'],
        definitions: {
          ask: {
            name: 'ask',
            on_input: [
              { condition: 'input == "yes"', set: { user_choice: '"confirmed"' }, then: 'next' },
            ],
          },
        },
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by flow step TRANSFORM target', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'filtered_hotels' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['filter'],
        definitions: {
          filter: {
            name: 'filter',
            transform: {
              source: 'search_results',
              item_var: 'hotel',
              target: 'filtered_hotels',
            },
          },
        },
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('no warning when variable is populated by flow step sub_intent set', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'override_flag' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['collect'],
        definitions: {
          collect: {
            name: 'collect',
            sub_intents: [{ intent: 'override', set: { override_flag: '"true"' } }],
          },
        },
      },
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Warnings — variable has no population source
  // -------------------------------------------------------------------------

  test('warns for session variable with no population source', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'orphaned_var' }],
        persistent: [],
        remember: [],
        recall: [],
      },
    });
    const warnings = validateSessionMemoryDeclarations(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].agent).toBe('test_agent');
    expect(warnings[0].message).toContain('W801');
    expect(warnings[0].message).toContain('orphaned_var');
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].type).toBe('validation');
  });

  test('warns for multiple orphaned variables', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'populated_var' }, { name: 'orphan_a' }, { name: 'orphan_b' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      gather: {
        fields: [{ name: 'populated_var', type: 'string', required: true, prompt: 'Enter' }],
        strategy: 'hybrid',
      },
    });
    const warnings = validateSessionMemoryDeclarations(ir);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('orphan_a'),
        expect.stringContaining('orphan_b'),
      ]),
    );
  });

  test('handles dot-notation in SET variable (matches root)', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'user' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      flow: {
        steps: ['s1'],
        definitions: {
          s1: {
            name: 's1',
            set: [{ variable: 'user.name', expression: '"John"' }],
          },
        },
      },
    });
    // user.name SET populates root var 'user'
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });

  test('handles dot-notation in on_result set key', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'booking' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'book',
          description: 'Book',
          parameters: [],
          on_result: { set: { 'booking.id': '_result.id', 'booking.status': '_result.status' } },
        },
      ],
    });
    expect(validateSessionMemoryDeclarations(ir)).toEqual([]);
  });
});
