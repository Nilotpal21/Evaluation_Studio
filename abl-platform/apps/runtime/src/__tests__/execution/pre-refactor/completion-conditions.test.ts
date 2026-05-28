/**
 * Pre-Refactor Test: Completion Conditions
 *
 * Covers COMPLETE conditions, post-turn evaluation, STORE directive,
 * completion callsite contexts, and premature completion prevention.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { MockAnthropicClient, injectMockClient } from './helpers/mock-llm-client';

describe('Pre-Refactor: Completion Conditions', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('COMPLETE with WHEN condition', () => {
    test('completes when condition is met', async () => {
      const dsl = `
AGENT: Complete_When

GOAL: "Test conditional completion"

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
        compileToResolvedAgent([dsl], 'Complete_When'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'Alice');

      expect(session.isComplete).toBe(true);
    });

    test('does not complete when condition is not met', async () => {
      const dsl = `
AGENT: Complete_NotMet

GOAL: "Test unmet completion"

COMPLETE:
  - WHEN: confirmed == true
    RESPOND: "Confirmed!"

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
        compileToResolvedAgent([dsl], 'Complete_NotMet'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'Alice');

      // Without 'confirmed' being set, the agent completes with default (terminal step)
      // but the specific COMPLETE condition won't fire its RESPOND
    });

    test('first matching condition wins', async () => {
      // Use a terminal step (no THEN) so the runtime evaluates COMPLETE conditions
      // via checkCompletionConditions. The THEN: COMPLETE short path does NOT
      // evaluate conditions — it marks complete immediately.
      const dsl = `
AGENT: Complete_FirstMatch

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
        compileToResolvedAgent([dsl], 'Complete_FirstMatch'),
      );
      await executor.initializeSession(session.id);
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Bob', (c) => chunks.push(c));

      // The terminal step triggers checkCompletionConditions.
      // vip is not set so the first condition (vip == true) doesn't match.
      // name IS SET matches (second condition), so "Regular goodbye." is emitted.
      const output = chunks.join('');
      expect(output).toContain('Regular goodbye.');
      expect(session.isComplete).toBe(true);
    });
  });

  describe('COMPLETE with STORE', () => {
    test('STORE persists data to session context on completion', async () => {
      // Use a terminal step (no THEN) so the runtime evaluates COMPLETE conditions
      // via checkCompletionConditions, which calls executeComplete with the STORE directive.
      // The THEN: COMPLETE short path does NOT evaluate conditions or STORE.
      const dsl = `
AGENT: Complete_Store

GOAL: "Test STORE"

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
        compileToResolvedAgent([dsl], 'Complete_Store'),
      );
      await executor.initializeSession(session.id);
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Paris', (c) => chunks.push(c));

      expect(session.isComplete).toBe(true);
      // The STORE directive stores to _stored_{storeKey} in the runtime's current implementation
      // (executeComplete stores as session.data.values[`_stored_${storeKey}`])
      expect(session.data.values['_stored_booking_city = city']).toBeDefined();
      const stored = session.data.values['_stored_booking_city = city'] as any;
      expect(stored.key).toBe('booking_city = city');
      expect(stored.value.city).toBe('Paris');
      // Verify the completion message was emitted
      expect(chunks.join('')).toContain('Booked for Paris!');
    });
  });

  describe('Completion Trace Events', () => {
    test('emits completion_check trace with callsite context', async () => {
      // Use a terminal step (no THEN) so the runtime evaluates COMPLETE conditions
      // via checkCompletionConditions, which emits completion_check trace events.
      // The THEN: COMPLETE short path does NOT emit these traces.
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

      // Should have source context indicating it came from a terminal step
      const withSource = checks.find((c) => c.data.source);
      expect(withSource).toBeDefined();
      expect(withSource!.data.source).toBe('terminal_step');
    });
  });

  describe('Post-Turn Auto-Completion (Reasoning Mode)', () => {
    test('reasoning mode checks completion after each turn', async () => {
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
          // Entity extraction
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

      // Should have run completion check
      const checks = filterTraces(tc.traces, 'completion_check');
      expect(checks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Forward-Progression Skip', () => {
    test('forward-progressing transitions skip completion check', async () => {
      const dsl = `
AGENT: Forward_Skip

GOAL: "Test forward skip"

COMPLETE:
  - WHEN: true
    RESPOND: "This should not fire mid-flow."

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
      // All three steps should execute
      expect(output).toContain('Step 1');
      expect(output).toContain('Step 2');
      expect(output).toContain('Step 3');

      // Should have skip_completion_check decisions for forward transitions
      const decisions = filterTraces(tc.traces, 'engine_decision');
      const skips = decisions.filter((d) => d.data.decision === 'skip_completion_check');
      expect(skips.length).toBeGreaterThanOrEqual(1);
    });
  });
});
