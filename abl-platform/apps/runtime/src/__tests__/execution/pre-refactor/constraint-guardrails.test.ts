/**
 * Pre-Refactor Test: Constraints & Guardrails
 *
 * Covers constraint evaluation, auto-guard behavior, violation actions
 * (RESPOND, ESCALATE, HANDOFF), and pre/post-extraction constraint checking.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Constraints & Guardrails', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('Constraint Evaluation', () => {
    test('constraint passes when condition is met', async () => {
      const dsl = `
AGENT: Constraint_Pass

GOAL: "Test constraint pass"

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
        compileToResolvedAgent([dsl], 'Constraint_Pass'),
      );
      await executor.initializeSession(session.id);
      const result = await executor.executeMessage(session.id, 'Alice');

      // Should not be escalated or blocked
      expect(session.isEscalated).toBe(false);
    });

    test('constraint violation triggers RESPOND action', async () => {
      const dsl = `
AGENT: Constraint_Respond

GOAL: "Test constraint respond"

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
        compileToResolvedAgent([dsl], 'Constraint_Respond'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '5000', (c) => chunks.push(c), tc.callback);

      // Constraint violation should emit the ON_FAIL RESPOND message
      const output = chunks.join('');
      expect(output).toContain('Budget exceeds $1000 limit.');

      // Should emit constraint_check trace showing the violation
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      const violation = constraintTraces.find((t) => t.data.passed === false);
      expect(violation).toBeDefined();
    });

    test('constraint violation triggers ESCALATE', async () => {
      const dsl = `
AGENT: Constraint_Escalate

GOAL: "Test constraint escalate"

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
        compileToResolvedAgent([dsl], 'Constraint_Escalate'),
      );
      await executor.initializeSession(session.id);
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      // Session should be escalated (REQUIRE false always fails)
      expect(session.isEscalated).toBe(true);

      // Should have escalation trace OR constraint_check trace
      // (The escalation may bypass the constraint_check trace depending on execution path)
      const escalationTraces = filterTraces(tc.traces, 'escalation');
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(escalationTraces.length + constraintTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Auto-Guard Behavior', () => {
    test('auto-guard allows unset variables to pass', async () => {
      const dsl = `
AGENT: AutoGuard_Agent

GOAL: "Test auto-guard"

CONSTRAINTS:
  - REQUIRE destination != origin

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - destination: required
  THEN: done

done:
  RESPOND: "Going to {{destination}}!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'AutoGuard_Agent'),
      );
      await executor.initializeSession(session.id);

      // origin IS NOT SET, so auto-guard should let the constraint pass
      const result = await executor.executeMessage(session.id, 'Paris');
      expect(session.isEscalated).toBe(false);
      expect(session.data.values.destination).toBe('Paris');
    });
  });

  describe('Constraint Trace Events', () => {
    test('emits constraint_check trace event', async () => {
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
      // Should have at least one constraint check
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      // All checks should pass (REQUIRE true always passes)
      const allPassed = constraintTraces.every((t) => t.data.passed === true);
      expect(allPassed).toBe(true);
    });
  });

  describe('CHECK Inline Conditions', () => {
    test('CHECK passes when condition is true', async () => {
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

      expect(chunks.join('')).toContain('Verification passed.');
      expect(chunks.join('')).toContain('Proceeding...');
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
});
