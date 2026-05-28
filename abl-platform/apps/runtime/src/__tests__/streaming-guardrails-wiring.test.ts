/**
 * Tests for StreamingGuardrailEvaluator wiring into the streaming response path.
 *
 * Validates the evaluator's API surface used by the onChunk wrapper in
 * runtime-executor.ts: buffer accumulation, termination state, violation
 * counting, and pass-through behavior when no guardrails are defined.
 */
import { describe, it, expect } from 'vitest';
import { StreamingGuardrailEvaluator } from '../services/guardrails/streaming-evaluator.js';

describe('StreamingGuardrailEvaluator integration', () => {
  it('should pass chunks through when no guardrails defined', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    const result = await evaluator.evaluateChunk('Hello world. ');
    expect(result.type).toBe('pass');
  });

  it('should accumulate buffer across chunks', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    await evaluator.evaluateChunk('Hello ');
    await evaluator.evaluateChunk('world. ');
    expect(evaluator.getBuffer()).toBe('Hello world. ');
  });

  it('should report not terminated initially', () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    expect(evaluator.isTerminated()).toBe(false);
  });

  it('should report zero violations initially', () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    expect(evaluator.getViolationCount()).toBe(0);
  });

  it('should handle multiple sequential chunks without error', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    const chunks = ['The ', 'quick ', 'brown ', 'fox. ', 'Jumps ', 'over. '];
    for (const chunk of chunks) {
      const result = await evaluator.evaluateChunk(chunk);
      expect(result.type).toBe('pass');
    }
    expect(evaluator.getBuffer()).toBe('The quick brown fox. Jumps over. ');
    expect(evaluator.isTerminated()).toBe(false);
    expect(evaluator.getViolationCount()).toBe(0);
  });

  it('should produce a passing final evaluation when no guardrails defined', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    await evaluator.evaluateChunk('Some content. ');
    const finalResult = await evaluator.evaluateFinal();
    expect(finalResult.passed).toBe(true);
    expect(finalResult.violations).toHaveLength(0);
  });
});
