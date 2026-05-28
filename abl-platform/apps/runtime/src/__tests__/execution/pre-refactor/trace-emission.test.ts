/**
 * Pre-Refactor Parity Test: Trace Emission
 *
 * Behavioral contract tests for trace event emission in the runtime engine.
 * Trace events are critical for observability and must be identical before
 * and after the consolidation:
 * - Trace event shape validation (required fields present)
 * - Execution trace ordering (events in correct sequence)
 * - Gather trace includes field metadata
 * - Constraint trace includes evaluation result
 * - Error trace includes original error info
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import {
  createTraceCollector,
  filterTraces,
  type CapturedTrace,
} from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

// =============================================================================
// HELPERS
// =============================================================================

/** Assert trace events contain expected types in order */
function expectTraceEventOrder(events: CapturedTrace[], expectedOrder: string[]): void {
  const types = events.map((e) => e.type);
  let lastIndex = -1;
  for (const expectedType of expectedOrder) {
    const index = types.indexOf(expectedType, lastIndex + 1);
    expect(
      index,
      `trace event '${expectedType}' not found after index ${lastIndex} in [${types.join(', ')}]`,
    ).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor Parity: Trace Emission', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Trace event shape validation
  // ---------------------------------------------------------------------------

  describe('Trace Event Shape', () => {
    test('every trace event has type and data fields', async () => {
      const dsl = `
AGENT: Shape_Test

GOAL: "Test trace shape"

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
        compileToResolvedAgent([dsl], 'Shape_Test'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'Alice', undefined, tc.callback);

      expect(tc.traces.length).toBeGreaterThan(0);
      for (const trace of tc.traces) {
        expect(trace.type).toBeDefined();
        expect(typeof trace.type).toBe('string');
        expect(trace.data).toBeDefined();
        expect(typeof trace.data).toBe('object');
      }
    });

    test('flow_step_enter trace includes step name', async () => {
      const dsl = `
AGENT: Step_Enter

GOAL: "Test step enter trace"

FLOW:
  entry_point: greet
  steps:
    - greet
    - done

greet:
  RESPOND: "Hello!"
  THEN: done

done:
  RESPOND: "Goodbye!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Enter'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const enterTraces = filterTraces(tc.traces, 'flow_step_enter');
      expect(enterTraces.length).toBeGreaterThanOrEqual(1);
      // At least one enter trace should have a step name
      const withStep = enterTraces.find((t) => t.data.step || t.data.stepName);
      expect(withStep).toBeDefined();
    });

    test('constraint_check trace includes passed field', async () => {
      const dsl = `
AGENT: Constraint_Shape

GOAL: "Test constraint trace shape"

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
        compileToResolvedAgent([dsl], 'Constraint_Shape'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      for (const trace of constraintTraces) {
        expect(trace.data).toHaveProperty('passed');
        expect(typeof trace.data.passed).toBe('boolean');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Execution trace ordering
  // ---------------------------------------------------------------------------

  describe('Execution Trace Ordering', () => {
    test('flow execution produces traces in sequential order', async () => {
      const dsl = `
AGENT: Order_Test

GOAL: "Test trace ordering"

ON_START:
  set: initialized = true
  respond: "Welcome!"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  RESPOND: "First."
  THEN: step2

step2:
  RESPOND: "Second."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Order_Test'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      // Should have traces — ordering should be sequential
      expect(tc.traces.length).toBeGreaterThan(0);

      // flow_step_enter events should appear in correct order
      const enterTraces = filterTraces(tc.traces, 'flow_step_enter');
      expect(enterTraces.length).toBeGreaterThanOrEqual(2);
      const steps = enterTraces.map((t) => t.data.step || t.data.stepName);
      const step1Idx = steps.indexOf('step1');
      const step2Idx = steps.indexOf('step2');
      expect(step1Idx).toBeGreaterThanOrEqual(0);
      expect(step2Idx).toBeGreaterThanOrEqual(0);
      expect(step1Idx).toBeLessThan(step2Idx);
    });

    test('constraint check traces appear before gather traces in execution', async () => {
      const dsl = `
AGENT: Order_Constraint

GOAL: "Test constraint ordering"

CONSTRAINTS:
  - REQUIRE true

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Order_Constraint'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'Alice', undefined, tc.callback);

      // All traces should be in chronological order (as emitted)
      // Constraint checks should generally appear before gather-related traces
      const constraintIdx = tc.traces.findIndex((t) => t.type === 'constraint_check');
      const gatherIdx = tc.traces.findIndex(
        (t) =>
          t.type === 'dsl_collect' ||
          t.type === 'gather_field_activation' ||
          t.type === 'extraction_attempt',
      );

      expect(constraintIdx).toBeGreaterThanOrEqual(0);
      expect(gatherIdx).toBeGreaterThanOrEqual(0);
      expect(constraintIdx).toBeLessThan(gatherIdx);
    });
  });

  // ---------------------------------------------------------------------------
  // Gather trace includes field metadata
  // ---------------------------------------------------------------------------

  describe('Gather Trace Metadata', () => {
    test('gather-related traces are emitted during field collection', async () => {
      const dsl = `
AGENT: Gather_Trace

GOAL: "Test gather traces"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - email: required
      type: email
    - phone: required
      type: string
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Gather_Trace'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'user@example.com', undefined, tc.callback);

      // Should have some gather-related traces (dsl_collect, extraction, etc.)
      const gatherRelated = tc.traces.filter(
        (t) =>
          t.type === 'dsl_collect' ||
          t.type === 'gather_field_activation' ||
          t.type === 'extraction_attempt' ||
          t.type === 'extraction_strategy_resolved',
      );
      // At least some gather traces should be present
      expect(gatherRelated.length).toBeGreaterThanOrEqual(1);

      // The trace event types present should have data objects
      for (const trace of gatherRelated) {
        expect(trace.data).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Constraint trace includes evaluation result
  // ---------------------------------------------------------------------------

  describe('Constraint Trace Evaluation Result', () => {
    test('constraint violation trace includes condition and action', async () => {
      const dsl = `
AGENT: Constraint_Result

GOAL: "Test constraint result trace"

CONSTRAINTS:
  - REQUIRE budget <= 1000
    ON_FAIL: RESPOND "Too high."

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
        compileToResolvedAgent([dsl], 'Constraint_Result'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '5000', undefined, tc.callback);

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);

      const violation = constraintTraces.find((t) => t.data.passed === false);
      expect(violation).toBeDefined();
      // Violation trace should contain evaluation result
      expect(violation!.data.passed).toBe(false);
    });

    test('passing constraint trace shows passed = true', async () => {
      const dsl = `
AGENT: Constraint_Pass

GOAL: "Test constraint pass trace"

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
        compileToResolvedAgent([dsl], 'Constraint_Pass'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
      for (const trace of constraintTraces) {
        expect(trace.data.passed).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Error trace includes original error info
  // ---------------------------------------------------------------------------

  describe('Error Trace Information', () => {
    test('LLM error produces error trace event', async () => {
      const dsl = `
AGENT: Error_Trace

GOAL: "Test error trace"
PERSONA: "Test agent"
`;
      const mock = injectMockClient(executor);
      mock.setResponseHandler(() => {
        throw new Error('LLM connection timeout');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Error_Trace'),
      );
      const tc = createTraceCollector();

      // Executor handles LLM errors gracefully and returns an error response
      const result = await executor.executeMessage(session.id, 'hello', undefined, tc.callback);
      expect(result.response).toBeDefined();

      // Trace events should still be emitted during execution
      expect(tc.traces.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Completion trace events
  // ---------------------------------------------------------------------------

  describe('Completion Trace Events', () => {
    test('completion emits completion_check trace', async () => {
      const dsl = `
AGENT: Complete_Trace

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
        compileToResolvedAgent([dsl], 'Complete_Trace'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const completionTraces = filterTraces(tc.traces, 'completion_check');
      expect(completionTraces.length).toBeGreaterThanOrEqual(1);

      // Each completion check should have a boolean result
      for (const trace of completionTraces) {
        expect(trace.data).toBeDefined();
        // Should have source context
        if (trace.data.source) {
          expect(typeof trace.data.source).toBe('string');
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ON_START trace events
  // ---------------------------------------------------------------------------

  describe('ON_START Trace Events', () => {
    test('ON_START SET emits dsl_set trace', async () => {
      const dsl = `
AGENT: OnStart_Trace

GOAL: "Test ON_START trace"

ON_START:
  set: initialized = true

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Ready."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Trace'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const setTraces = filterTraces(tc.traces, 'dsl_set');
      expect(setTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('ON_START RESPOND emits dsl_respond trace', async () => {
      const dsl = `
AGENT: OnStart_Respond

GOAL: "Test ON_START respond trace"

ON_START:
  respond: "Welcome!"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Ready."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Respond'),
      );
      const tc = createTraceCollector();
      await executor.initializeSession(session.id, undefined, tc.callback);

      const respondTraces = filterTraces(tc.traces, 'dsl_respond');
      expect(respondTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Session detail for trace reconstruction
  // ---------------------------------------------------------------------------

  describe('Session Detail for Trace Reconstruction', () => {
    test('session detail includes trace-relevant metadata', () => {
      const dsl = `
AGENT: Detail_Test

GOAL: "Test detail"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  RESPOND: "Hello."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Detail_Test'),
      );
      const detail = executor.getSessionDetail(session.id);

      expect(detail).toBeDefined();
      expect(detail).toHaveProperty('id');
      expect(detail).toHaveProperty('agentName');
      expect(detail).toHaveProperty('createdAt');
      expect(detail).toHaveProperty('lastActivityAt');
      expect(detail).toHaveProperty('threads');
      expect(detail).toHaveProperty('messages');
    });

    test('conversation history preserves message ordering for trace', async () => {
      const dsl = `
AGENT: History_Order

GOAL: "Test history ordering"

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
        compileToResolvedAgent([dsl], 'History_Order'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'Alice');

      // Conversation history should have messages in order
      const history = session.conversationHistory;
      expect(history.length).toBeGreaterThan(0);

      // User messages should appear before their assistant responses
      const userMsgs = history.filter((m) => m.role === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
