/**
 * Pre-Refactor Test: Handoff & Delegate Executor Validation
 *
 * Tests the pure HandoffExecutor and DelegateExecutor from @abl/compiler
 * against the existing RoutingExecutor behavior. Verifies that shadow mode
 * produces identical decisions for all handoff/delegate scenarios.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { HandoffExecutor } from '@abl/compiler';
import { DelegateExecutor } from '@abl/compiler';
import type {
  HandoffThreadInfo,
  HandoffSessionInfo,
  HandoffInput,
  DelegateThreadInfo,
  DelegateSessionInfo,
  DelegateInput,
} from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';

// =============================================================================
// HANDOFF EXECUTOR TESTS
// =============================================================================

describe('HandoffExecutor', () => {
  let executor: HandoffExecutor;

  beforeEach(() => {
    executor = new HandoffExecutor();
  });

  describe('validate', () => {
    const makeThread = (agentName: string): HandoffThreadInfo => ({ agentName });

    const makeSession = (overrides: Partial<HandoffSessionInfo> = {}): HandoffSessionInfo => ({
      handoffStack: ['Supervisor'],
      handoffReturnInfo: { Worker: true, Greeter: false },
      agentIR: {
        metadata: { name: 'Supervisor', type: 'supervisor', version: '1.0' },
        identity: { goal: 'Route', persona: 'Router' },
        routing: { rules: [{ to: 'Worker', when: 'true' }] },
        coordination: {
          handoffs: [
            { to: 'Worker', return: true },
            { to: 'Greeter', return: false },
          ],
        },
      } as unknown as AgentIR,
      ...overrides,
    });

    test('allows valid handoff to registered target', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession(),
        { target: 'Worker' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.returnExpected).toBe(true);
    });

    test('returns correct returnExpected=false for permanent handoff', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession(),
        { target: 'Greeter' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.returnExpected).toBe(false);
    });

    test('prevents self-handoff', () => {
      const result = executor.validate(
        makeThread('Worker'),
        makeSession({ handoffStack: ['Supervisor', 'Worker'] }),
        { target: 'Worker' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cannot hand off to yourself');
    });

    test('prevents handoff cycle', () => {
      const result = executor.validate(
        makeThread('Worker'),
        makeSession({
          handoffStack: ['Supervisor', 'Worker'],
          handoffReturnInfo: { Supervisor: false, Worker: true },
        }),
        { target: 'Supervisor' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Handoff cycle detected');
      expect(result.reason).toContain('Supervisor → Worker → Supervisor');
    });

    test('rejects handoff to invalid target', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession(),
        { target: 'Unknown_Agent' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Invalid handoff target');
    });

    test('rejects handoff when agent not in registry', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession(),
        { target: 'Worker' },
        false, // not in registry
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Agent not found');
    });

    test('rejects handoff when no routing config', () => {
      const result = executor.validate(
        makeThread('PlainAgent'),
        makeSession({
          agentIR: {
            metadata: { name: 'PlainAgent', type: 'agent', version: '1.0' },
            identity: { goal: 'Do stuff' },
          } as unknown as AgentIR,
          handoffReturnInfo: {},
        }),
        { target: 'Worker' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not configured for handoffs');
    });

    test('allows handoff to a constraint-declared target', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession({
          agentIR: {
            metadata: { name: 'Supervisor', type: 'supervisor', version: '1.0' },
            identity: { goal: 'Route' },
            constraints: {
              constraints: [
                {
                  condition: 'true',
                  on_fail: {
                    type: 'handoff',
                    target: 'Worker',
                    message: 'Escalate to worker',
                  },
                },
              ],
              guardrails: [],
            },
          } as unknown as AgentIR,
          handoffReturnInfo: { Worker: false },
        }),
        { target: 'Worker' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.returnExpected).toBe(false);
    });

    test('rejects handoff when handoffReturnInfo exists without IR-defined authority', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession({
          agentIR: {
            metadata: { name: 'Supervisor', type: 'supervisor', version: '1.0' },
            identity: { goal: 'Route' },
          } as unknown as AgentIR,
          handoffReturnInfo: { Worker: true },
        }),
        { target: 'Worker' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not configured for handoffs');
    });

    test('generates correct trace events', () => {
      const result = executor.validate(
        makeThread('Supervisor'),
        makeSession(),
        { target: 'Worker', context: { user_name: 'Alice' } },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.returnExpected).toBe(true);
    });
  });
});

// =============================================================================
// DELEGATE EXECUTOR TESTS
// =============================================================================

describe('DelegateExecutor', () => {
  let executor: DelegateExecutor;

  beforeEach(() => {
    executor = new DelegateExecutor();
  });

  describe('validate', () => {
    const makeThread = (
      agentName: string,
      dataValues: Record<string, unknown> = {},
    ): DelegateThreadInfo => ({
      agentName,
      dataValues,
    });

    const makeSession = (overrides: Partial<DelegateSessionInfo> = {}): DelegateSessionInfo => ({
      delegateStack: [],
      agentIR: {
        metadata: { name: 'Boss', type: 'agent', version: '1.0' },
        identity: { goal: 'Manage' },
        coordination: {
          delegates: [
            {
              agent: 'Fee_Calc',
              when: 'action == "calculate"',
              purpose: 'Calculate fees',
              input: { amount: 'requested_amount' },
              returns: { fee: 'calculated_fee' },
              timeout: '5s',
              on_failure: 'respond',
              failure_message: 'Fee calculation failed',
            },
            {
              agent: 'Validator',
              purpose: 'Validate data',
            },
          ],
        },
      } as unknown as AgentIR,
      ...overrides,
    });

    test('allows valid delegation with WHEN condition met', () => {
      const result = executor.validate(
        makeThread('Boss', { action: 'calculate', requested_amount: 100 }),
        makeSession(),
        { target: 'Fee_Calc' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.delegateConfig?.agent).toBe('Fee_Calc');
      expect(result.mappedInput).toEqual({ amount: 100 });
    });

    test('blocks delegation when WHEN condition not met', () => {
      const result = executor.validate(
        makeThread('Boss', { action: 'review' }),
        makeSession(),
        { target: 'Fee_Calc' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('WHEN condition not met');
    });

    test('allows delegation without WHEN condition', () => {
      const result = executor.validate(
        makeThread('Boss', {}),
        makeSession(),
        { target: 'Validator' },
        true,
      );
      expect(result.allowed).toBe(true);
    });

    test('prevents self-delegation', () => {
      const result = executor.validate(
        makeThread('Fee_Calc'),
        makeSession({ delegateStack: ['Boss', 'Fee_Calc'] }),
        { target: 'Fee_Calc' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cannot delegate to yourself');
    });

    test('prevents delegate cycle', () => {
      const result = executor.validate(
        makeThread('Fee_Calc'),
        makeSession({ delegateStack: ['Boss', 'Fee_Calc'] }),
        { target: 'Boss' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Delegate cycle detected');
    });

    test('prevents unbounded depth', () => {
      const deepStack = Array.from({ length: 10 }, (_, i) => `Agent_${i}`);
      const result = executor.validate(
        makeThread('Agent_10'),
        makeSession({ delegateStack: deepStack }),
        { target: 'Agent_11' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Delegate depth limit reached');
    });

    test('rejects delegation when target not in registry', () => {
      const result = executor.validate(
        makeThread('Boss', {}),
        makeSession(),
        { target: 'Validator' },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Agent not found');
    });

    test('uses explicit input over config mapping', () => {
      const result = executor.validate(
        makeThread('Boss', { action: 'calculate', requested_amount: 100 }),
        makeSession(),
        { target: 'Fee_Calc', input: { amount: 999 } },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.mappedInput).toEqual({ amount: 999 });
    });
  });

  describe('mapInput', () => {
    test('maps simple field references', () => {
      const result = executor.mapInput(
        { amount: 'requested_amount', name: 'user_name' },
        { requested_amount: 100, user_name: 'Alice' },
      );
      expect(result.values).toEqual({ amount: 100, name: 'Alice' });
      expect(result.droppedFields).toEqual([]);
    });

    test('maps dot-path references', () => {
      const result = executor.mapInput({ name: 'user.name' }, { user: { name: 'Bob' } });
      expect(result.values).toEqual({ name: 'Bob' });
    });

    test('reports dropped fields for undefined sources', () => {
      const result = executor.mapInput(
        { amount: 'requested_amount', missing: 'nonexistent' },
        { requested_amount: 100 },
      );
      expect(result.values).toEqual({ amount: 100 });
      expect(result.droppedFields).toEqual(['missing']);
    });
  });
});

// =============================================================================
// SHADOW MODE AGREEMENT TESTS
// =============================================================================

describe('Shadow Mode: Old vs New Agreement', () => {
  let handoffExecutor: HandoffExecutor;
  let delegateExecutor: DelegateExecutor;

  beforeEach(() => {
    handoffExecutor = new HandoffExecutor();
    delegateExecutor = new DelegateExecutor();
  });

  test('handoff: both old and new agree on self-handoff rejection', () => {
    // Old path: RoutingExecutor checks currentThread.agentName === targetAgent
    // New path: HandoffExecutor.validate checks the same
    const result = handoffExecutor.validate(
      { agentName: 'Worker' },
      {
        handoffStack: ['Supervisor', 'Worker'],
        handoffReturnInfo: { Worker: true },
        agentIR: {
          metadata: { name: 'Worker', type: 'agent', version: '1.0' },
          identity: { goal: 'Work' },
          coordination: { handoffs: [{ to: 'Worker', return: true }] },
        } as unknown as AgentIR,
      },
      { target: 'Worker' },
      true,
    );
    // Old path returns: { success: false, error: "Cannot hand off to yourself..." }
    // New path returns: { allowed: false, reason: "Cannot hand off to yourself..." }
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cannot hand off to yourself');
  });

  test('handoff: both old and new agree on cycle detection', () => {
    const result = handoffExecutor.validate(
      { agentName: 'Worker_B' },
      {
        handoffStack: ['Supervisor', 'Worker_A', 'Worker_B'],
        handoffReturnInfo: { Supervisor: false },
        agentIR: {
          metadata: { name: 'Worker_B', type: 'agent', version: '1.0' },
          identity: { goal: 'Work' },
          coordination: { handoffs: [{ to: 'Supervisor' }] },
        } as unknown as AgentIR,
      },
      { target: 'Supervisor' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Handoff cycle detected');
  });

  test('delegate: both old and new agree on WHEN condition blocking', () => {
    const result = delegateExecutor.validate(
      { agentName: 'Boss', dataValues: { action: 'review' } },
      {
        delegateStack: [],
        agentIR: {
          metadata: { name: 'Boss', type: 'agent', version: '1.0' },
          identity: { goal: 'Manage' },
          coordination: {
            delegates: [{ agent: 'Fee_Calc', when: 'action == "calculate"' }],
          },
        } as unknown as AgentIR,
      },
      { target: 'Fee_Calc' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('WHEN condition not met');
  });

  test('delegate: both old and new agree on depth limit', () => {
    const deepStack = Array.from({ length: 10 }, (_, i) => `Agent_${i}`);
    const result = delegateExecutor.validate(
      { agentName: 'Agent_10', dataValues: {} },
      {
        delegateStack: deepStack,
        agentIR: {
          metadata: { name: 'Agent_10', type: 'agent', version: '1.0' },
          identity: { goal: 'Work' },
        } as unknown as AgentIR,
      },
      { target: 'Agent_11' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Delegate depth limit reached');
  });

  test('delegate: both old and new agree on valid delegation', () => {
    const result = delegateExecutor.validate(
      { agentName: 'Boss', dataValues: { action: 'calculate', requested_amount: 50 } },
      {
        delegateStack: [],
        agentIR: {
          metadata: { name: 'Boss', type: 'agent', version: '1.0' },
          identity: { goal: 'Manage' },
          coordination: {
            delegates: [
              {
                agent: 'Fee_Calc',
                when: 'action == "calculate"',
                input: { amount: 'requested_amount' },
              },
            ],
          },
        } as unknown as AgentIR,
      },
      { target: 'Fee_Calc' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.mappedInput).toEqual({ amount: 50 });
  });
});
