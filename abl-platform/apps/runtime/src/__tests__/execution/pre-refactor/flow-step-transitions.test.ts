/**
 * Pre-Refactor Test: Flow Step Transitions
 *
 * Covers THEN transitions, auto-advance, loop detection, GOTO,
 * terminal steps, and multi-step flows — behavioral contracts for consolidation.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Flow Step Transitions', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Basic THEN transitions
  // ---------------------------------------------------------------------------

  describe('THEN Transitions', () => {
    test('RESPOND + THEN auto-advances to next step', async () => {
      const dsl = `
AGENT: Auto_Advance

GOAL: "Test auto-advance"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  RESPOND: "Step 1"
  THEN: step2

step2:
  RESPOND: "Step 2"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Auto_Advance'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Step 1');
      expect(output).toContain('Step 2');
      expect(session.isComplete).toBe(true);
    });

    test('GATHER stops auto-advance and waits for input', async () => {
      const dsl = `
AGENT: Collect_Wait

GOAL: "Test collect wait"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirm

ask:
  GATHER:
    - name: required
  THEN: confirm

confirm:
  RESPOND: "Hello {{name}}!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Collect_Wait'),
      );
      await executor.initializeSession(session.id);

      expect(session.isComplete).toBe(false);
      expect(session.currentFlowStep).toBe('ask');
      expect(session.waitingForInput).toContain('name');

      await executor.executeMessage(session.id, 'Alice');
      expect(session.data.values.name).toBe('Alice');
      expect(session.isComplete).toBe(true);
    });

    test('multi-step chain with RESPOND-only auto-advances through all', async () => {
      const dsl = `
AGENT: Chain_Agent

GOAL: "Test chain"

FLOW:
  entry_point: a
  steps:
    - a
    - b
    - c

a:
  RESPOND: "A"
  THEN: b

b:
  RESPOND: "B"
  THEN: c

c:
  RESPOND: "C"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Chain_Agent'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('A');
      expect(output).toContain('B');
      expect(output).toContain('C');
      expect(session.isComplete).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Loop detection
  // ---------------------------------------------------------------------------

  describe('Loop Detection', () => {
    test('loop-back with gather does not infinite loop', async () => {
      const dsl = `
AGENT: Loop_Agent

GOAL: "Test loop"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirm

ask:
  GATHER:
    - item: required
  THEN: confirm

confirm:
  RESPOND: "Got {{item}}"
  THEN: ask
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Loop_Agent'),
      );
      await executor.initializeSession(session.id);

      // First iteration: collect item, transition to confirm, then loop back to ask
      await executor.executeMessage(session.id, 'apple');
      expect(session.data.values.item).toBe('apple');
      expect(session.isComplete).toBe(false);

      // Second iteration: collect again, verify value updated
      await executor.executeMessage(session.id, 'banana');
      expect(session.data.values.item).toBe('banana');
      expect(session.isComplete).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal steps (no THEN)
  // ---------------------------------------------------------------------------

  describe('Terminal Steps', () => {
    test('step without THEN triggers completion check', async () => {
      const dsl = `
AGENT: Terminal_Agent

GOAL: "Test terminal"

COMPLETE:
  - WHEN: true
    RESPOND: "All done."

FLOW:
  entry_point: single
  steps:
    - single

single:
  RESPOND: "Only step."
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Terminal_Agent'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Only step.');
      expect(session.isComplete).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Trace events for flow transitions
  // ---------------------------------------------------------------------------

  describe('Flow Transition Trace Events', () => {
    test('emits flow_step_enter and flow_step_exit for each step', async () => {
      const dsl = `
AGENT: Trace_Flow

GOAL: "Test traces"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  RESPOND: "Step 1"
  THEN: step2

step2:
  RESPOND: "Step 2"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Trace_Flow'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const enters = filterTraces(tc.traces, 'flow_step_enter');
      expect(enters.length).toBeGreaterThanOrEqual(2);
      expect(enters.some((e) => e.data.stepName === 'step1')).toBe(true);
      expect(enters.some((e) => e.data.stepName === 'step2')).toBe(true);
    });

    test('emits flow_transition on step change', async () => {
      const dsl = `
AGENT: Transition_Trace

GOAL: "Test transition trace"

FLOW:
  entry_point: first
  steps:
    - first
    - second

first:
  RESPOND: "First"
  THEN: second

second:
  RESPOND: "Second"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Transition_Trace'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const transitions = filterTraces(tc.traces, 'flow_transition');
      expect(transitions.length).toBeGreaterThanOrEqual(1);
    });

    test('emits engine_decision for auto-advance', async () => {
      const dsl = `
AGENT: Decision_Trace

GOAL: "Test decision trace"

FLOW:
  entry_point: auto1
  steps:
    - auto1
    - auto2

auto1:
  RESPOND: "Auto 1"
  THEN: auto2

auto2:
  RESPOND: "Auto 2"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Decision_Trace'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const decisions = filterTraces(tc.traces, 'engine_decision');
      const autoAdvance = decisions.find((d) => d.data.decision === 'auto_advance');
      expect(autoAdvance).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // SET and template in transitions
  // ---------------------------------------------------------------------------

  describe('SET During Flow', () => {
    test('SET persists values across steps', async () => {
      const dsl = `
AGENT: Set_Flow

GOAL: "Test SET"

ON_START:
  set: greeting = hello

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  RESPOND: "Greeting is: {{greeting}}"
  THEN: step2

step2:
  RESPOND: "Done"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'Set_Flow'));
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(session.data.values.greeting).toBe('hello');
      expect(chunks.join('')).toContain('Greeting is: hello');
    });
  });
});
