/**
 * Enhanced Memory Types Tests
 *
 * Verifies SessionMemory, PersistentMemory, RecallInstruction, and RecallAction
 * types are correctly structured and support all expected configurations.
 * Also verifies compileMemory() passes through all fields from parser to IR.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type {
  SessionMemory,
  PersistentMemory,
  RecallInstruction,
  RecallAction,
} from '../platform/ir/schema.js';

describe('SessionMemory', () => {
  test('with reset="per_step" creates valid object', () => {
    const mem: SessionMemory = {
      name: 'step_counter',
      description: 'Tracks attempts within the current step',
      initial_value: 0,
      reset: 'per_step',
    };

    expect(mem.name).toBe('step_counter');
    expect(mem.reset).toBe('per_step');
    expect(mem.initial_value).toBe(0);
    expect(mem.description).toBe('Tracks attempts within the current step');
  });

  test('with reset="per_session" creates valid object (default)', () => {
    const mem: SessionMemory = {
      name: 'user_language',
      reset: 'per_session',
    };

    expect(mem.name).toBe('user_language');
    expect(mem.reset).toBe('per_session');
    expect(mem.description).toBeUndefined();
    expect(mem.initial_value).toBeUndefined();
  });

  test('with reset="never" creates valid object', () => {
    const mem: SessionMemory = {
      name: 'accumulated_context',
      description: 'Context preserved across session boundaries',
      initial_value: [],
      reset: 'never',
    };

    expect(mem.name).toBe('accumulated_context');
    expect(mem.reset).toBe('never');
    expect(mem.initial_value).toEqual([]);
  });
});

describe('PersistentMemory', () => {
  test('with type="number" and unit="USD" creates valid object', () => {
    const mem: PersistentMemory = {
      path: 'user/account_balance',
      description: 'Current account balance',
      scope: 'user',
      access: 'readwrite',
      type: 'number',
      unit: 'USD',
    };

    expect(mem.path).toBe('user/account_balance');
    expect(mem.type).toBe('number');
    expect(mem.unit).toBe('USD');
    expect(mem.access).toBe('readwrite');
    expect(mem.scope).toBe('user');
    expect(mem.description).toBe('Current account balance');
  });

  test('with default_value=0 creates valid object', () => {
    const mem: PersistentMemory = {
      path: 'user/loyalty_points',
      scope: 'user',
      access: 'read',
      type: 'number',
      default_value: 0,
    };

    expect(mem.path).toBe('user/loyalty_points');
    expect(mem.default_value).toBe(0);
    expect(mem.access).toBe('read');
    expect(mem.type).toBe('number');
  });

  test('with sensitivity metadata creates valid object', () => {
    const mem: PersistentMemory = {
      path: 'user/loyalty_number',
      scope: 'user',
      access: 'readwrite',
      sensitive: true,
      sensitive_display: 'mask',
      mask_config: { show_first: 2, show_last: 2, char: '#' },
    };

    expect(mem.sensitive).toBe(true);
    expect(mem.sensitive_display).toBe('mask');
    expect(mem.mask_config).toEqual({ show_first: 2, show_last: 2, char: '#' });
  });

  test('supports execution_tree scope for workflow-shared memory', () => {
    const mem: PersistentMemory = {
      path: 'workflow.auth_token',
      scope: 'execution_tree',
      access: 'readwrite',
      type: 'string',
    };

    expect(mem.path).toBe('workflow.auth_token');
    expect(mem.scope).toBe('execution_tree');
    expect(mem.access).toBe('readwrite');
    expect(mem.type).toBe('string');
  });
});

describe('RecallInstruction', () => {
  test('with action type="inject_context" creates valid object', () => {
    const action: RecallAction = {
      type: 'inject_context',
      paths: ['user/preferences'],
    };
    const recall: RecallInstruction = {
      event: 'session:start',
      instruction: 'Load user preferences into context',
      action,
    };

    expect(recall.event).toBe('session:start');
    expect(recall.instruction).toBe('Load user preferences into context');
    expect(recall.action).toBeDefined();
    expect(recall.action!.type).toBe('inject_context');
    expect((recall.action as { type: 'inject_context'; paths: string[] }).paths).toEqual([
      'user/preferences',
    ]);
  });

  test('with action type="load_memory" creates valid object', () => {
    const action: RecallAction = {
      type: 'load_memory',
      domain: 'travel',
    };
    const recall: RecallInstruction = {
      event: 'agent:*:before',
      instruction: 'Load travel-related memory',
      action,
    };

    expect(recall.event).toBe('agent:*:before');
    expect(recall.action).toBeDefined();
    expect(recall.action!.type).toBe('load_memory');
    expect((recall.action as { type: 'load_memory'; domain?: string }).domain).toBe('travel');
  });

  test('with action type="prompt_llm" creates valid object', () => {
    const action: RecallAction = {
      type: 'prompt_llm',
      instruction: 'Load travel prefs',
    };
    const recall: RecallInstruction = {
      event: 'tool:search_hotels:after',
      instruction: 'Prompt LLM with travel preferences',
      action,
    };

    expect(recall.event).toBe('tool:search_hotels:after');
    expect(recall.action).toBeDefined();
    expect(recall.action!.type).toBe('prompt_llm');
    expect((recall.action as { type: 'prompt_llm'; instruction: string }).instruction).toBe(
      'Load travel prefs',
    );
  });

  test('without action (backward compat) uses instruction field only', () => {
    const recall: RecallInstruction = {
      event: 'session:start',
      instruction: 'Remember the user name from previous interactions',
    };

    expect(recall.event).toBe('session:start');
    expect(recall.instruction).toBe('Remember the user name from previous interactions');
    expect(recall.action).toBeUndefined();
  });
});

// =============================================================================
// Compilation Pass-Through Tests
// =============================================================================

describe('compileMemory pass-through', () => {
  const memoryDSL = `
AGENT: Memory_Test

GOAL: "Test memory compilation"
PERSONA: "Test agent"

MEMORY:
  session:
    - step_counter
      INITIAL: 0

  persistent:
    - user.preferred_chain
    - user.budget
      TYPE: number
      UNIT: USD
      DEFAULT_VALUE: 500

  remember:
    - WHEN preferred_chain IS SET
      STORE preferred_chain -> user.preferred_chain

  recall:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user.preferred_chain, user.budget]
`;

  test('persistent memory preserves type, unit, default_value through compilation', () => {
    const parseResult = parseAgentBasedABL(memoryDSL);
    expect(parseResult.document).toBeDefined();

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['Memory_Test'];
    expect(agent).toBeDefined();
    expect(agent.memory).toBeDefined();

    const persistent = agent.memory!.persistent;
    expect(persistent.length).toBeGreaterThanOrEqual(2);

    // Find the budget entry which has type, unit, and default_value
    const budgetEntry = persistent.find((p) => p.path === 'user.budget');
    expect(budgetEntry).toBeDefined();
    expect(budgetEntry!.type).toBe('number');
    expect(budgetEntry!.unit).toBe('USD');
    expect(budgetEntry!.default_value).toBeDefined();

    // Chain entry should not have type/unit/default
    const chainEntry = persistent.find((p) => p.path === 'user.preferred_chain');
    expect(chainEntry).toBeDefined();
    expect(chainEntry!.type).toBeUndefined();

    // All persistent entries should have access set
    for (const p of persistent) {
      expect(p.access).toBe('readwrite');
    }
  });

  test('recall instructions preserve action field through compilation', () => {
    const parseResult = parseAgentBasedABL(memoryDSL);
    expect(parseResult.document).toBeDefined();

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['Memory_Test'];
    expect(agent).toBeDefined();
    expect(agent.memory).toBeDefined();
    expect(agent.memory!.recall.length).toBeGreaterThanOrEqual(1);

    // The recall instruction should have event, instruction, and action
    const recall = agent.memory!.recall[0];
    expect(recall.event).toBe('session:start');
    expect(recall.action).toBeDefined();
    expect(recall.action!.type).toBe('inject_context');
  });

  test('session memory preserves initial_value through compilation', () => {
    const parseResult = parseAgentBasedABL(memoryDSL);
    expect(parseResult.document).toBeDefined();

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['Memory_Test'];
    expect(agent.memory).toBeDefined();

    const sessionVars = agent.memory!.session;
    const counter = sessionVars.find((s) => s.name === 'step_counter');
    expect(counter).toBeDefined();
    expect(counter!.initial_value).toBe(0);
  });

  test('persistent memory preserves sensitivity metadata through compilation', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: Sensitive_Memory_Test

GOAL: "Test sensitive memory compilation"
PERSONA: "Test agent"

MEMORY:
  persistent:
    - user.loyalty_number
      SENSITIVE: true
      SENSITIVE_DISPLAY: mask
      MASK_CONFIG:
        show_first: 2
        show_last: 2
        char: "#"
    - user.profile_note
      SENSITIVE: yes
      SENSITIVE_DISPLAY: redact
  RECALL:
    - ON: session:start
      ACTION: load_memory
      DOMAIN: customer
`);
    expect(parseResult.document).toBeDefined();

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['Sensitive_Memory_Test'];
    expect(agent).toBeDefined();

    const loyaltyNumber = agent.memory!.persistent.find((p) => p.path === 'user.loyalty_number');
    expect(loyaltyNumber).toBeDefined();
    expect(loyaltyNumber!.sensitive).toBe(true);
    expect(loyaltyNumber!.sensitive_display).toBe('mask');
    expect(loyaltyNumber!.mask_config).toEqual({
      show_first: 2,
      show_last: 2,
      char: '#',
    });

    const profileNote = agent.memory!.persistent.find((p) => p.path === 'user.profile_note');
    expect(profileNote).toBeDefined();
    expect(profileNote!.sensitive).toBe(true);
    expect(profileNote!.sensitive_display).toBe('redact');
    expect(profileNote!.mask_config).toBeUndefined();

    expect(agent.memory!.recall).toHaveLength(1);
    expect(agent.memory!.recall[0]).toMatchObject({
      event: 'session:start',
      action: { type: 'load_memory', domain: 'customer' },
    });
  });

  test('persistent memory preserves execution_tree scope through compilation', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: ExecutionTreeMemory

GOAL: "Test workflow memory compilation"
PERSONA: "Test agent"

MEMORY:
  persistent:
    - workflow.auth_token
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string
`);
    expect(parseResult.document).toBeDefined();

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['ExecutionTreeMemory'];

    expect(agent.memory?.persistent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'workflow.auth_token',
          scope: 'execution_tree',
          access: 'readwrite',
          type: 'string',
        }),
      ]),
    );
  });

  test('structured recall INSTRUCTION compiles to prompt_llm action', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: PromptRecallMemory

GOAL: "Test prompt recall compilation"

MEMORY:
  recall:
    - ON: session:start
      ACTION: prompt_llm
      INSTRUCTION: "Greet the user by name if known"
`);
    expect(parseResult.errors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    expect(output.agents.PromptRecallMemory.memory?.recall).toEqual([
      expect.objectContaining({
        event: 'session:start',
        instruction: 'Greet the user by name if known',
        action: {
          type: 'prompt_llm',
          instruction: 'Greet the user by name if known',
        },
      }),
    ]);
  });
});
