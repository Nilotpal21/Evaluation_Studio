/**
 * Tests that StreamingGuardrailEvaluator uses the pipeline passed to it
 * (with shared registry and llmEval) rather than falling back to a bare
 * GuardrailPipelineImpl().
 *
 * Validates the Gap 3 fix: runtime-executor.ts now passes a properly
 * constructed pipeline from createGuardrailPipeline(llmEval).
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamingGuardrailEvaluator } from '../services/guardrails/streaming-evaluator.js';

describe('StreamingGuardrailEvaluator pipeline wiring', () => {
  it('uses the provided pipeline instead of creating a bare default', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      passed: true,
      violations: [],
    });

    const mockPipeline = {
      execute: mockExecute,
    } as any;

    const guardrails = [
      {
        name: 'test-guardrail',
        kind: 'output' as const,
        rules: [{ type: 'regex', pattern: 'bad-word', action: 'block' }],
        priority: 1,
      },
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, undefined, mockPipeline);

    // Feed content with a sentence boundary to trigger evaluation
    await evaluator.evaluateChunk('Hello world. ');

    // The mock pipeline should have been used, not a default instance
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      guardrails,
      'Hello world. ',
      'output',
      {},
      undefined,
      undefined,
    );
  });

  it('falls back to bare GuardrailPipelineImpl when no pipeline provided', async () => {
    // When no pipeline is provided, the evaluator creates its own
    // This is the legacy behavior — streaming should still work
    const guardrails: any[] = [];
    const evaluator = new StreamingGuardrailEvaluator(guardrails);

    const result = await evaluator.evaluateChunk('Hello. ');
    expect(result.type).toBe('pass');
  });

  it('provided pipeline receives all chunks accumulated in buffer', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      passed: true,
      violations: [],
    });

    const mockPipeline = { execute: mockExecute } as any;

    const guardrails = [
      {
        name: 'content-check',
        kind: 'output' as const,
        rules: [{ type: 'regex', pattern: 'secret', action: 'block' }],
        priority: 1,
      },
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, undefined, mockPipeline);

    // Feed chunks without sentence boundary — no evaluation yet
    await evaluator.evaluateChunk('The quick ');
    await evaluator.evaluateChunk('brown fox ');

    // No evaluation yet (no sentence boundary)
    expect(mockExecute).not.toHaveBeenCalled();

    // Sentence boundary triggers evaluation of accumulated buffer
    await evaluator.evaluateChunk('jumps. ');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      guardrails,
      'The quick brown fox jumps. ',
      'output',
      {},
      undefined,
      undefined,
    );
  });

  it('provided pipeline is used for final evaluation', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      passed: true,
      violations: [],
    });

    const mockPipeline = { execute: mockExecute } as any;

    const guardrails = [
      {
        name: 'final-check',
        kind: 'output' as const,
        rules: [],
        priority: 1,
      },
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, undefined, mockPipeline);

    // Feed content without triggering mid-stream evaluation
    await evaluator.evaluateChunk('No sentence boundary');

    // Final evaluation should use the provided pipeline
    await evaluator.evaluateFinal();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      guardrails,
      'No sentence boundary',
      'output',
      {},
      undefined,
      undefined,
    );
  });

  it('pipeline with llmEval handles termination correctly', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      passed: false,
      violations: [
        {
          name: 'toxicity-check',
          action: 'block',
          message: 'Content is toxic',
          tier: 'llm',
        },
      ],
      primaryViolation: {
        name: 'toxicity-check',
        action: 'block',
        message: 'Content is toxic',
        tier: 'llm',
      },
    });

    const mockPipeline = { execute: mockExecute } as any;

    const guardrails = [
      {
        name: 'toxicity-check',
        kind: 'output' as const,
        rules: [{ type: 'llm', prompt: 'Is this toxic?', threshold: 0.5 }],
        priority: 1,
      },
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { earlyTermination: true },
      mockPipeline,
    );

    // Trigger evaluation at sentence boundary
    const result = await evaluator.evaluateChunk('This is bad content. ');

    expect(result.type).toBe('terminate');
    expect(result.violation?.guardrailName).toBe('toxicity-check');
    expect(result.violation?.action).toBe('block');
    expect(evaluator.isTerminated()).toBe(true);
  });
});
