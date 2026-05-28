/**
 * Pre-Refactor Parity Test: Constraint Evaluation
 *
 * Behavioral contract tests for constraint evaluation in the runtime engine.
 * These capture current behavior before consolidation:
 * - Guardrail pass-through (constraint evaluates true, execution continues)
 * - ON_FAIL:BLOCK (constraint fails, response blocked)
 * - ON_FAIL:REASK (constraint fails, user re-prompted)
 * - Multiple constraints evaluated in order
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

describe('Pre-Refactor Parity: Constraint Evaluation', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Guardrail pass-through
  // ---------------------------------------------------------------------------

  describe('Guardrail Pass-Through', () => {
    test('constraint evaluates true allows execution to continue', async () => {
      const dsl = `
AGENT: Pass_Through

GOAL: "Test constraint pass-through"

CONSTRAINTS:
  - REQUIRE name IS NOT SET OR name != ""

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - name: required
  THEN: done

done:
  RESPOND: "Hello {{name}}!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Pass_Through'),
      );
      await executor.initializeSession(session.id);
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Alice', (c) => chunks.push(c));

      expect(session.isEscalated).toBe(false);
      expect(session.data.values.name).toBe('Alice');
    });

    test('REQUIRE true always passes constraint check', async () => {
      const dsl = `
AGENT: Always_Pass

GOAL: "Test always-pass constraint"

CONSTRAINTS:
  - REQUIRE true

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - value: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Always_Pass'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      expect(session.isEscalated).toBe(false);
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      const allPassed = constraintTraces.every((t) => t.data.passed === true);
      expect(allPassed).toBe(true);
    });

    test('auto-guard lets unset variables pass constraint', async () => {
      const dsl = `
AGENT: AutoGuard_Test

GOAL: "Test auto-guard"

CONSTRAINTS:
  - REQUIRE destination != origin

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - destination: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'AutoGuard_Test'),
      );
      await executor.initializeSession(session.id);

      // origin IS NOT SET, so auto-guard should let the constraint pass
      await executor.executeMessage(session.id, 'Paris');
      expect(session.isEscalated).toBe(false);
      expect(session.data.values.destination).toBe('Paris');
    });
  });

  // ---------------------------------------------------------------------------
  // ON_FAIL: RESPOND (block response)
  // ---------------------------------------------------------------------------

  describe('ON_FAIL: RESPOND (Block)', () => {
    test('constraint violation emits ON_FAIL RESPOND message', async () => {
      const dsl = `
AGENT: Respond_Block

GOAL: "Test constraint blocking"

CONSTRAINTS:
  - REQUIRE budget <= 1000
    ON_FAIL: RESPOND "Budget exceeds $1000 limit."

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - budget: required
      type: number
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Respond_Block'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '5000', (c) => chunks.push(c), tc.callback);

      const output = chunks.join('');
      expect(output).toContain('Budget exceeds $1000 limit.');

      // Should emit constraint_check trace showing the violation
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      const violation = constraintTraces.find((t) => t.data.passed === false);
      expect(violation).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // ON_FAIL: ESCALATE (reask / escalate)
  // ---------------------------------------------------------------------------

  describe('ON_FAIL: ESCALATE', () => {
    test('constraint violation triggers escalation', async () => {
      const dsl = `
AGENT: Escalate_Test

GOAL: "Test constraint escalation"

CONSTRAINTS:
  - REQUIRE false
    ON_FAIL: ESCALATE "Must escalate"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - data: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Escalate_Test'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      // REQUIRE false always fails — session should be escalated
      expect(session.isEscalated).toBe(true);

      const escalationTraces = filterTraces(tc.traces, 'escalation');
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(escalationTraces.length + constraintTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple constraints evaluated in order
  // ---------------------------------------------------------------------------

  describe('Multiple Constraints in Order', () => {
    test('first failing constraint determines the action', async () => {
      const dsl = `
AGENT: Multi_Constraint

GOAL: "Test multiple constraints"

CONSTRAINTS:
  - REQUIRE amount IS NOT SET OR amount > 0
    ON_FAIL: RESPOND "Amount must be positive."
  - REQUIRE amount IS NOT SET OR amount <= 10000
    ON_FAIL: RESPOND "Amount exceeds max."

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - amount: required
      type: number
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Multi_Constraint'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const chunks: string[] = [];
      await executor.executeMessage(session.id, '50000', (c) => chunks.push(c), tc.callback);

      const output = chunks.join('');
      // 50000 passes first constraint (> 0) but fails second (<= 10000)
      expect(output).toContain('Amount exceeds max.');

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('all constraints pass when values are valid', async () => {
      const dsl = `
AGENT: Multi_Pass

GOAL: "Test all constraints pass"

CONSTRAINTS:
  - REQUIRE amount > 0
    ON_FAIL: RESPOND "Must be positive."
  - REQUIRE amount <= 10000
    ON_FAIL: RESPOND "Exceeds max."

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - amount: required
      type: number
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Multi_Pass'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '500', undefined, tc.callback);

      // No constraint violation — session should not be escalated
      expect(session.isEscalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // CHECK inline conditions
  // ---------------------------------------------------------------------------

  describe('CHECK Inline Conditions', () => {
    test('CHECK passes and continues execution', async () => {
      const dsl = `
AGENT: Check_Pass

GOAL: "Test CHECK pass"

ON_START:
  set: ready = true

FLOW:
  entry_point: verify
  steps:
    - verify
    - proceed

verify:
  CHECK: ready == true
  RESPOND: "Verification passed."
  THEN: proceed

proceed:
  RESPOND: "Proceeding..."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Check_Pass'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Verification passed.');
      expect(output).toContain('Proceeding...');
    });

    test('CHECK fails and redirects with ON_FAIL', async () => {
      const dsl = `
AGENT: Check_Fail

GOAL: "Test CHECK fail"

FLOW:
  entry_point: verify
  steps:
    - verify
    - fallback

verify:
  CHECK: authorized == true
    ON_FAIL: fallback
  RESPOND: "Should not reach here."
  THEN: COMPLETE

fallback:
  RESPOND: "Not authorized."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Check_Fail'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Not authorized.');
      expect(output).not.toContain('Should not reach here.');
    });
  });

  // ---------------------------------------------------------------------------
  // Constraint trace events
  // ---------------------------------------------------------------------------

  describe('Constraint Trace Events', () => {
    test('emits constraint_check trace event with pass/fail data', async () => {
      const dsl = `
AGENT: Trace_Constraint

GOAL: "Test constraint trace"

CONSTRAINTS:
  - REQUIRE true

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Trace_Constraint'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      const allPassed = constraintTraces.every((t) => t.data.passed === true);
      expect(allPassed).toBe(true);
    });
  });
});
