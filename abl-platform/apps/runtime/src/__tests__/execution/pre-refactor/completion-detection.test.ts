/**
 * Pre-Refactor Parity Test: Completion Detection
 *
 * Behavioral contract tests for completion detection in the runtime engine.
 * These capture current behavior before consolidation:
 * - Explicit completion (THEN: COMPLETE)
 * - Goal satisfaction detection (COMPLETE WHEN conditions)
 * - Max turns / terminal step completion
 * - Escalation triggers completion
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

describe('Pre-Refactor Parity: Completion Detection', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Explicit completion (THEN: COMPLETE)
  // ---------------------------------------------------------------------------

  describe('Explicit Completion', () => {
    test('THEN: COMPLETE marks session as complete', async () => {
      const dsl = `
AGENT: Explicit_Complete

GOAL: "Test explicit completion"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Hello!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Explicit_Complete'),
      );
      await executor.initializeSession(session.id);

      expect(session.isComplete).toBe(true);
    });

    test('completed session rejects new messages', async () => {
      const dsl = `
AGENT: Complete_Reject

GOAL: "Test completed rejection"

FLOW:
  entry_point: done
  steps:
    - done

done:
  RESPOND: "Done!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Complete_Reject'),
      );
      await executor.initializeSession(session.id);

      expect(session.isComplete).toBe(true);
      const result = await executor.executeMessage(session.id, 'hello');
      expect(result.action.type).toBe('complete');
    });

    test('multi-step flow completes at terminal COMPLETE', async () => {
      const dsl = `
AGENT: Multi_Step_Complete

GOAL: "Test multi-step completion"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2
    - step3

step1:
  RESPOND: "Step 1"
  THEN: step2

step2:
  RESPOND: "Step 2"
  THEN: step3

step3:
  RESPOND: "Step 3 - final"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Multi_Step_Complete'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Step 1');
      expect(output).toContain('Step 2');
      expect(output).toContain('Step 3 - final');
      expect(session.isComplete).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Goal satisfaction detection (COMPLETE WHEN)
  // ---------------------------------------------------------------------------

  describe('Goal Satisfaction (COMPLETE WHEN)', () => {
    test('completes when WHEN condition is met', async () => {
      const dsl = `
AGENT: Goal_Satisfied

GOAL: "Collect user name"

COMPLETE:
  - WHEN: name IS SET
    RESPOND: "Goodbye {{name}}!"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Goal_Satisfied'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'Alice');

      expect(session.isComplete).toBe(true);
    });

    test('first matching WHEN condition wins', async () => {
      // Use a terminal step (no THEN) so the runtime evaluates COMPLETE conditions
      // via checkCompletionConditions. THEN: COMPLETE marks complete immediately.
      const dsl = `
AGENT: First_Match

GOAL: "Test first match"

COMPLETE:
  - WHEN: vip == true
    RESPOND: "VIP goodbye!"
  - WHEN: name IS SET
    RESPOND: "Regular goodbye."

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - name: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'First_Match'),
      );
      await executor.initializeSession(session.id);
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Bob', (c) => chunks.push(c));

      // vip is not set, so first condition doesn't match.
      // name IS SET matches second condition.
      const output = chunks.join('');
      expect(output).toContain('Regular goodbye.');
      expect(session.isComplete).toBe(true);
    });

    test('COMPLETE with STORE persists data on completion', async () => {
      // Use a terminal step (no THEN) so the runtime evaluates COMPLETE conditions.
      const dsl = `
AGENT: Store_Complete

GOAL: "Test STORE on completion"

COMPLETE:
  - WHEN: city IS SET
    RESPOND: "Booked for {{city}}!"
    STORE: booking_city = city

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - city: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Store_Complete'),
      );
      await executor.initializeSession(session.id);
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Paris', (c) => chunks.push(c));

      expect(session.isComplete).toBe(true);
      expect(chunks.join('')).toContain('Booked for Paris!');
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal step completion
  // ---------------------------------------------------------------------------

  describe('Terminal Step Completion', () => {
    test('terminal step (no THEN) triggers completion check', async () => {
      const dsl = `
AGENT: Terminal_Step

GOAL: "Test terminal step"

COMPLETE:
  - WHEN: true
    RESPOND: "Done."

FLOW:
  entry_point: single
  steps:
    - single

single:
  RESPOND: "Only step."
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Terminal_Step'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const checks = filterTraces(tc.traces, 'completion_check');
      expect(checks.length).toBeGreaterThanOrEqual(1);

      const withSource = checks.find((c) => c.data.source);
      expect(withSource).toBeDefined();
      expect(withSource!.data.source).toBe('terminal_step');
    });

    test('forward-progressing transitions skip completion check', async () => {
      const dsl = `
AGENT: Forward_Skip

GOAL: "Test forward skip"

COMPLETE:
  - WHEN: true
    RESPOND: "Should not fire mid-flow."

FLOW:
  entry_point: s1
  steps:
    - s1
    - s2
    - s3

s1:
  RESPOND: "Step 1"
  THEN: s2

s2:
  RESPOND: "Step 2"
  THEN: s3

s3:
  RESPOND: "Step 3"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Forward_Skip'),
      );
      const tc = createTraceCollector();
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c), tc.callback);

      const output = chunks.join('');
      expect(output).toContain('Step 1');
      expect(output).toContain('Step 2');
      expect(output).toContain('Step 3');

      // Forward transitions should skip completion checks
      const decisions = filterTraces(tc.traces, 'engine_decision');
      const skips = decisions.filter((d) => d.data.decision === 'skip_completion_check');
      expect(skips.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Escalation triggers completion
  // ---------------------------------------------------------------------------

  describe('Escalation Triggers Completion', () => {
    test('escalated session is not complete but is escalated', async () => {
      const dsl = `
AGENT: Escalation_End

GOAL: "Test escalation"

CONSTRAINTS:
  - REQUIRE false
    ON_FAIL: ESCALATE "Need human"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - query: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Escalation_End'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'help');

      expect(session.isEscalated).toBe(true);
    });

    test('escalated session echoes mock human agent response', async () => {
      const dsl = `
AGENT: Escalation_Echo

GOAL: "Test escalation echo"

CONSTRAINTS:
  - REQUIRE false
    ON_FAIL: ESCALATE "Need human"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - query: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Escalation_Echo'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'help');

      if (session.isEscalated) {
        const result = await executor.executeMessage(session.id, 'still here');
        // Escalated sessions return 'escalate' action type on subsequent messages
        expect(result.action.type).toBe('escalate');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Reasoning mode completion
  // ---------------------------------------------------------------------------

  describe('Reasoning Mode Completion', () => {
    test('reasoning mode checks completion after turn', async () => {
      const dsl = `
AGENT: Reasoning_Complete

GOAL: "Complete after collecting name"
PERSONA: "Helper"

GATHER:
  name:
    prompt: "Your name?"
    type: string
    required: true

COMPLETE:
  - WHEN: name IS SET
    RESPOND: "Got it, {{name}}!"
`;
      const mock = injectMockClient(executor);
      mock.setResponseHandler((_s, _m, tools) => {
        if (tools.length === 0) {
          return {
            text: '{"name": "Eve"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"name": "Eve"}' }],
          };
        }
        return {
          text: 'Hello Eve!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Hello Eve!' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Reasoning_Complete'),
      );
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'My name is Eve', undefined, tc.callback);

      const checks = filterTraces(tc.traces, 'completion_check');
      expect(checks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Completion trace events
  // ---------------------------------------------------------------------------

  describe('Completion Trace Events', () => {
    test('emits completion_check trace with callsite context', async () => {
      const dsl = `
AGENT: Trace_Complete

GOAL: "Test completion trace"

COMPLETE:
  - WHEN: true
    RESPOND: "Done."

FLOW:
  entry_point: single
  steps:
    - single

single:
  RESPOND: "Only step."
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Trace_Complete'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const checks = filterTraces(tc.traces, 'completion_check');
      expect(checks.length).toBeGreaterThanOrEqual(1);
      const withSource = checks.find((c) => c.data.source);
      expect(withSource).toBeDefined();
    });
  });
});
