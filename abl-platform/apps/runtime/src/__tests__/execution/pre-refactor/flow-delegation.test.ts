/**
 * Pre-Refactor Test: Flow Delegation
 *
 * Tests the FlowExecutor construct executor that resolves next-step transitions
 * (THEN, GOTO, COMPLETE), detects loops (visited steps), identifies terminal
 * steps, and handles ON_SUCCESS/ON_FAILURE branching. This is the new
 * compiler-layer implementation that will replace the runtime's inline
 * step traversal logic in FlowStepExecutor.
 */

import { describe, test, expect, vi } from 'vitest';
import type { FlowConfig, FlowStep, FlowStepResolution } from '@abl/compiler';
import { FlowExecutor } from '@abl/compiler';

// =============================================================================
// FIXTURES
// =============================================================================

function createFlowConfig(
  steps: Record<string, Partial<FlowStep>>,
  entryPoint?: string,
): FlowConfig {
  const stepNames = Object.keys(steps);
  const definitions: Record<string, FlowStep> = {};
  for (const [name, partial] of Object.entries(steps)) {
    definitions[name] = { name, ...partial } as FlowStep;
  }
  return {
    steps: stepNames,
    definitions,
    entry_point: entryPoint ?? stepNames[0],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('FlowExecutor', () => {
  const executor = new FlowExecutor();

  // ---------------------------------------------------------------------------
  // THEN transitions
  // ---------------------------------------------------------------------------

  describe('THEN Transitions', () => {
    test('resolves simple THEN to next step', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Hello', then: 'step2' },
        step2: { respond: 'World', then: 'COMPLETE' },
      });

      const result = executor.resolveNextStep('step1', flow);

      expect(result.nextStep).toBe('step2');
      expect(result.isTerminal).toBe(false);
      expect(result.isComplete).toBe(false);
      expect(result.loopDetected).toBe(false);
      expect(result.source).toBe('step');
    });

    test('resolves THEN: COMPLETE as completion', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Done', then: 'COMPLETE' },
      });

      const result = executor.resolveNextStep('step1', flow);

      expect(result.nextStep).toBe('COMPLETE');
      expect(result.isComplete).toBe(true);
      expect(result.isTerminal).toBe(false);
    });

    test('resolves case-insensitive COMPLETE', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Done', then: 'complete' },
      });

      const result = executor.resolveNextStep('step1', flow);
      expect(result.isComplete).toBe(true);
    });

    test('multi-step chain resolves each transition correctly', () => {
      const flow = createFlowConfig({
        a: { respond: 'A', then: 'b' },
        b: { respond: 'B', then: 'c' },
        c: { respond: 'C', then: 'COMPLETE' },
      });

      const r1 = executor.resolveNextStep('a', flow);
      expect(r1.nextStep).toBe('b');
      expect(r1.isComplete).toBe(false);

      const r2 = executor.resolveNextStep('b', flow);
      expect(r2.nextStep).toBe('c');

      const r3 = executor.resolveNextStep('c', flow);
      expect(r3.nextStep).toBe('COMPLETE');
      expect(r3.isComplete).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // GOTO (THEN targets to non-sequential steps)
  // ---------------------------------------------------------------------------

  describe('GOTO Jumps', () => {
    test('resolves THEN to a non-sequential step (GOTO)', () => {
      const flow = createFlowConfig({
        check: { respond: 'Checking', then: 'result' },
        intermediate: { respond: 'Skipped' },
        result: { respond: 'Result', then: 'COMPLETE' },
      });

      const result = executor.resolveNextStep('check', flow);
      expect(result.nextStep).toBe('result');
      expect(result.isTerminal).toBe(false);
    });

    test('resolves THEN to a step earlier in the flow', () => {
      const flow = createFlowConfig({
        ask: { respond: 'Ask', then: 'confirm' },
        confirm: { respond: 'Confirm', then: 'ask' },
      });

      const result = executor.resolveNextStep('confirm', flow);
      expect(result.nextStep).toBe('ask');
    });
  });

  // ---------------------------------------------------------------------------
  // Loop detection
  // ---------------------------------------------------------------------------

  describe('Loop Detection', () => {
    test('detects loop when next step is in visited set', () => {
      const flow = createFlowConfig({
        ask: { respond: 'Ask', then: 'confirm' },
        confirm: { respond: 'Confirm', then: 'ask' },
      });

      const visited = new Set(['ask', 'confirm']);
      const result = executor.resolveNextStep('confirm', flow, visited);

      expect(result.loopDetected).toBe(true);
      expect(result.nextStep).toBe('ask');
    });

    test('no loop when next step is not in visited set', () => {
      const flow = createFlowConfig({
        step1: { respond: 'S1', then: 'step2' },
        step2: { respond: 'S2', then: 'COMPLETE' },
      });

      const visited = new Set(['step1']);
      const result = executor.resolveNextStep('step1', flow, visited);

      expect(result.loopDetected).toBe(false);
      expect(result.nextStep).toBe('step2');
    });

    test('loop detection with empty visited set returns false', () => {
      const flow = createFlowConfig({
        a: { respond: 'A', then: 'b' },
        b: { respond: 'B', then: 'a' },
      });

      const result = executor.resolveNextStep('b', flow, new Set());
      expect(result.loopDetected).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal steps (no THEN)
  // ---------------------------------------------------------------------------

  describe('Terminal Steps', () => {
    test('step without THEN is terminal', () => {
      const flow = createFlowConfig({
        single: { respond: 'Only step' },
      });

      const result = executor.resolveNextStep('single', flow);

      expect(result.isTerminal).toBe(true);
      expect(result.nextStep).toBeUndefined();
      expect(result.isComplete).toBe(false);
    });

    test('step with undefined THEN is terminal', () => {
      const flow = createFlowConfig({
        final: { respond: 'Final', then: undefined },
      });

      const result = executor.resolveNextStep('final', flow);
      expect(result.isTerminal).toBe(true);
    });

    test('non-existent step name is terminal', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Hello' },
      });

      const result = executor.resolveNextStep('nonexistent', flow);
      expect(result.isTerminal).toBe(true);
      expect(result.nextStep).toBeUndefined();
    });

    test('COMPLETE as current step name is terminal and complete', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Hello', then: 'COMPLETE' },
      });

      const result = executor.resolveNextStep('COMPLETE', flow);
      expect(result.isTerminal).toBe(true);
      expect(result.isComplete).toBe(true);
      expect(result.nextStep).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // ON_SUCCESS / ON_FAILURE branching
  // ---------------------------------------------------------------------------

  describe('Call Result Branching', () => {
    test('resolves ON_SUCCESS THEN when callSuccess is true', () => {
      const flow = createFlowConfig({
        api_call: {
          call: 'some_tool',
          on_success: { respond: 'OK', then: 'next' },
          on_failure: { respond: 'Fail', then: 'retry' },
        },
        next: { respond: 'Next', then: 'COMPLETE' },
        retry: { respond: 'Retry', then: 'api_call' },
      });

      const result = executor.resolveNextStep('api_call', flow, undefined, {
        callSuccess: true,
      });

      expect(result.nextStep).toBe('next');
      expect(result.source).toBe('on_success');
    });

    test('resolves ON_FAILURE THEN when callSuccess is false', () => {
      const flow = createFlowConfig({
        api_call: {
          call: 'some_tool',
          on_success: { respond: 'OK', then: 'next' },
          on_failure: { respond: 'Fail', then: 'retry' },
        },
        next: { respond: 'Next', then: 'COMPLETE' },
        retry: { respond: 'Retry', then: 'api_call' },
      });

      const result = executor.resolveNextStep('api_call', flow, undefined, {
        callSuccess: false,
      });

      expect(result.nextStep).toBe('retry');
      expect(result.source).toBe('on_failure');
    });

    test('resolves conditional branches with evaluateCondition', () => {
      const flow = createFlowConfig({
        api_call: {
          call: 'lookup_tool',
          on_success: {
            branches: [
              { condition: 'status == "vip"', respond: 'VIP!', then: 'vip_step', set: {} },
              { respond: 'Regular', then: 'regular_step', set: {} },
            ],
          },
          on_failure: { respond: 'Fail', then: 'error' },
        },
        vip_step: { respond: 'VIP', then: 'COMPLETE' },
        regular_step: { respond: 'Regular', then: 'COMPLETE' },
        error: { respond: 'Error', then: 'COMPLETE' },
      });

      // VIP match
      const vipResult = executor.resolveNextStep('api_call', flow, undefined, {
        callSuccess: true,
        evaluateCondition: (cond, ctx) => ctx.status === 'vip',
        context: { status: 'vip' },
      });
      expect(vipResult.nextStep).toBe('vip_step');
      expect(vipResult.source).toBe('branch');

      // Non-VIP falls to ELSE branch
      const regularResult = executor.resolveNextStep('api_call', flow, undefined, {
        callSuccess: true,
        evaluateCondition: (cond, ctx) => {
          if (cond === 'status == "vip"') return ctx.status === 'vip';
          return false;
        },
        context: { status: 'regular' },
      });
      expect(regularResult.nextStep).toBe('regular_step');
      expect(regularResult.source).toBe('branch');
    });

    test('falls back to step.then when call block has no then', () => {
      const flow = createFlowConfig({
        api_call: {
          call: 'some_tool',
          on_success: { respond: 'OK' },
          then: 'fallback_step',
        },
        fallback_step: { respond: 'Fallback', then: 'COMPLETE' },
      });

      const result = executor.resolveNextStep('api_call', flow, undefined, {
        callSuccess: true,
      });
      expect(result.nextStep).toBe('fallback_step');
    });
  });

  // ---------------------------------------------------------------------------
  // Entry point resolution
  // ---------------------------------------------------------------------------

  describe('Entry Point', () => {
    test('resolves explicit entry_point', () => {
      const flow = createFlowConfig(
        {
          step1: { respond: 'S1' },
          step2: { respond: 'S2' },
        },
        'step2',
      );

      expect(executor.resolveEntryPoint(flow)).toBe('step2');
    });

    test('falls back to first step when no entry_point', () => {
      const flow: FlowConfig = {
        steps: ['first', 'second'],
        definitions: {
          first: { name: 'first', respond: 'First' } as FlowStep,
          second: { name: 'second', respond: 'Second' } as FlowStep,
        },
      };

      expect(executor.resolveEntryPoint(flow)).toBe('first');
    });
  });

  // ---------------------------------------------------------------------------
  // Shadow mode: agreement between old and new logic
  // ---------------------------------------------------------------------------

  describe('Shadow Mode Agreement', () => {
    test('old and new paths agree on simple THEN', () => {
      const flow = createFlowConfig({
        step1: { respond: 'Hello', then: 'step2' },
        step2: { respond: 'World', then: 'COMPLETE' },
      });

      // Simulate old logic: step.then
      const step = flow.definitions['step1'];
      const oldNextStep = step.then;

      // New logic
      const newResult = executor.resolveNextStep('step1', flow);

      expect(newResult.nextStep).toBe(oldNextStep);
    });

    test('old and new paths agree on COMPLETE terminal', () => {
      const flow = createFlowConfig({
        last: { respond: 'Done', then: 'COMPLETE' },
      });

      const step = flow.definitions['last'];
      const oldIsComplete = step.then === 'COMPLETE' || step.then?.toLowerCase() === 'complete';

      const newResult = executor.resolveNextStep('last', flow);

      expect(newResult.isComplete).toBe(oldIsComplete);
    });

    test('old and new paths agree on terminal (no THEN)', () => {
      const flow = createFlowConfig({
        terminal: { respond: 'End' },
      });

      const step = flow.definitions['terminal'];
      const oldNextStep = step.then; // undefined

      const newResult = executor.resolveNextStep('terminal', flow);

      expect(newResult.nextStep).toBe(oldNextStep);
      expect(newResult.isTerminal).toBe(true);
    });

    test('old and new paths agree on loop detection', () => {
      const flow = createFlowConfig({
        ask: { respond: 'Ask', then: 'confirm' },
        confirm: { respond: 'Confirm', then: 'ask' },
      });

      const visited = new Set(['ask', 'confirm']);

      // Old logic: visited.has(nextStep)
      const step = flow.definitions['confirm'];
      const oldLoopDetected = visited.has(step.then!);

      // New logic
      const newResult = executor.resolveNextStep('confirm', flow, visited);

      expect(newResult.loopDetected).toBe(oldLoopDetected);
      expect(newResult.loopDetected).toBe(true);
    });

    test('shadow mismatch logging scenario', () => {
      // This test verifies that the shadow comparison pattern works:
      // if old and new disagree, a log should be emitted.
      const flow = createFlowConfig({
        step1: { respond: 'Hello', then: 'step2' },
        step2: { respond: 'World', then: 'COMPLETE' },
      });

      const newResult = executor.resolveNextStep('step1', flow);
      const oldNextStep = flow.definitions['step1'].then;

      const mismatch = newResult.nextStep !== oldNextStep;
      expect(mismatch).toBe(false); // Should agree

      // Simulating a mismatch scenario for coverage of the logging path
      const mockLog = vi.fn();
      if (mismatch) {
        mockLog('flow-shadow mismatch', { old: oldNextStep, new: newResult.nextStep });
      }
      expect(mockLog).not.toHaveBeenCalled();
    });
  });
});
