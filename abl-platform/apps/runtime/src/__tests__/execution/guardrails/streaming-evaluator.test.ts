import { describe, it, expect, vi } from 'vitest';
import type { Guardrail } from '@abl/compiler';
import { GuardrailPipelineImpl, createEmptyPipelineResult } from '@abl/compiler';
import type { GuardrailPipelineResult } from '@abl/compiler';
import {
  StreamingGuardrailEvaluator,
  type StreamingEvalConfig,
  type StreamingEvalEvent,
} from '../../../services/guardrails/streaming-evaluator.js';

/**
 * Tests for StreamingGuardrailEvaluator — mid-stream guardrail checks.
 *
 * The evaluator buffers streaming tokens and evaluates guardrails at
 * sentence boundaries (or chunk-size boundaries in chunk mode).
 * Tests use real CEL guardrails via GuardrailPipelineImpl for Tier 1 checks.
 */

/** Helper: create a Tier 1 CEL guardrail for output content */
function makeOutputGuardrail(
  name: string,
  check: string,
  action: { type: string; message: string },
): Guardrail {
  return {
    name,
    description: `Test guardrail: ${name}`,
    kind: 'output',
    priority: 1,
    tier: 'local',
    check,
    action: action as Guardrail['action'],
  };
}

describe('StreamingGuardrailEvaluator', () => {
  // ── Sentence buffering ──────────────────────────────────────────

  it('should not evaluate until sentence boundary in sentence mode', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
    });

    // Feed partial sentence with no boundary — should not trigger evaluation
    const event1 = await evaluator.evaluateChunk('Hello, my name is');
    expect(event1.type).toBe('pass');
    expect(event1.evaluatedContent).toBeUndefined();

    // Continue without sentence boundary
    const event2 = await evaluator.evaluateChunk(' John and I');
    expect(event2.type).toBe('pass');
    expect(event2.evaluatedContent).toBeUndefined();
  });

  it('should evaluate at sentence boundary', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
      earlyTermination: true,
    });

    // First chunk without sentence boundary — no evaluation
    const event1 = await evaluator.evaluateChunk('My SSN is 123-45-6789');
    expect(event1.type).toBe('pass');

    // Now add a sentence boundary — triggers evaluation on full buffer
    const event2 = await evaluator.evaluateChunk('. Next sentence');
    expect(event2.type).toBe('terminate');
    expect(event2.violation).toBeDefined();
    expect(event2.violation!.guardrailName).toBe('pii_check');
    expect(event2.violation!.action).toBe('block');
  });

  // ── Chunk mode ──────────────────────────────────────────────────

  it('should evaluate at chunk size boundary in chunk mode', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('length_warn', 'abl.length(output) > 10', {
        type: 'warn',
        message: 'Output getting long',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'chunk',
      chunkSize: 20,
    });

    // First chunk: 10 chars — below 20 threshold, no evaluation
    const event1 = await evaluator.evaluateChunk('1234567890');
    expect(event1.type).toBe('pass');
    expect(event1.evaluatedContent).toBeUndefined();

    // Second chunk: total 25 chars — exceeds 20 threshold, triggers evaluation
    const event2 = await evaluator.evaluateChunk('123456789012345');
    // The check `abl.length(output) > 10` is true for 25 chars, but action is 'warn'
    // Warn does not fail the pipeline so result.passed=true, event type is 'pass'
    expect(event2.type).toBe('pass');
    expect(event2.evaluatedContent).toBeDefined();
  });

  it('should evaluate every chunk in token mode', async () => {
    const mockPipeline = new GuardrailPipelineImpl();
    const executeSpy = vi
      .spyOn(mockPipeline, 'execute')
      .mockResolvedValue(createEmptyPipelineResult());

    const evaluator = new StreamingGuardrailEvaluator(
      [],
      {
        interval: 'token',
      },
      mockPipeline,
    );

    await evaluator.evaluateChunk('Hello');
    await evaluator.evaluateChunk(' world');

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[0][1]).toBe('Hello');
    expect(executeSpy.mock.calls[1][1]).toBe(' world');
  });

  it('should force evaluation when maxLatencyMs elapses without a sentence boundary', async () => {
    vi.useFakeTimers();

    try {
      const mockPipeline = new GuardrailPipelineImpl();
      const executeSpy = vi
        .spyOn(mockPipeline, 'execute')
        .mockResolvedValue(createEmptyPipelineResult());

      const evaluator = new StreamingGuardrailEvaluator(
        [],
        {
          interval: 'sentence',
          maxLatencyMs: 1000,
        },
        mockPipeline,
      );

      await evaluator.evaluateChunk('Partial sentence');
      expect(executeSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1001);
      await evaluator.evaluateChunk(' still streaming');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0][1]).toBe('Partial sentence still streaming');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Early termination ───────────────────────────────────────────

  it('should terminate stream on block violation with earlyTermination', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_block', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII in output',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
      earlyTermination: true,
    });

    // Feed content with PII and sentence boundary
    const event = await evaluator.evaluateChunk('Your SSN is 123-45-6789. Here is more text.');

    expect(event.type).toBe('terminate');
    expect(event.violation).toBeDefined();
    expect(event.violation!.guardrailName).toBe('pii_block');
    expect(event.violation!.action).toBe('block');
    expect(event.violation!.message).toBe('PII in output');
    expect(evaluator.isTerminated()).toBe(true);

    // Subsequent chunks should immediately return terminate
    const event2 = await evaluator.evaluateChunk('more content');
    expect(event2.type).toBe('terminate');
  });

  it('should not terminate on non-terminal violation (warn)', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('length_warn', 'abl.length(output) > 5', {
        type: 'warn',
        message: 'Response long',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
      earlyTermination: true,
    });

    // Content with sentence boundary that triggers warn (not block)
    const event = await evaluator.evaluateChunk(
      'This is a response that is longer than five characters. ',
    );

    // Warn does not fail the pipeline so result.passed=true; event should be pass
    expect(event.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);
  });

  // ── Pass through ────────────────────────────────────────────────

  it('should return pass when no violation detected', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
    });

    // Clean content with sentence boundary
    const event = await evaluator.evaluateChunk('The weather in Paris is lovely today. ');

    expect(event.type).toBe('pass');
    expect(event.evaluatedContent).toBeDefined();
    expect(evaluator.isTerminated()).toBe(false);
  });

  // ── Fail-open on pipeline errors ────────────────────────────────

  it('should fail-open when pipeline throws during chunk evaluation', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('bad_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'Should not matter',
      }),
    ];

    // Create a mock pipeline that throws
    const mockPipeline = new GuardrailPipelineImpl();
    vi.spyOn(mockPipeline, 'execute').mockRejectedValue(new Error('Pipeline exploded'));

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      mockPipeline,
    );

    // Content with sentence boundary to trigger evaluation
    const event = await evaluator.evaluateChunk('Some content here. More text.');

    // Fail-open: returns pass despite pipeline error
    expect(event.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);
  });

  // ── evaluateFinal ───────────────────────────────────────────────

  it('should run full pipeline on evaluateFinal', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
    });

    // Feed content without sentence boundary — no mid-stream evaluation
    await evaluator.evaluateChunk('My SSN is 123-45-6789');

    // evaluateFinal runs the full pipeline on accumulated buffer
    const finalResult = await evaluator.evaluateFinal();

    expect(finalResult.passed).toBe(false);
    expect(finalResult.primaryViolation?.name).toBe('pii_check');
    expect(finalResult.violations.length).toBeGreaterThan(0);
  });

  // ── Buffer accumulation ─────────────────────────────────────────

  it('should track accumulated buffer', async () => {
    const guardrails: Guardrail[] = [];
    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
    });

    await evaluator.evaluateChunk('Hello ');
    await evaluator.evaluateChunk('world ');
    await evaluator.evaluateChunk('from streaming');

    expect(evaluator.getBuffer()).toBe('Hello world from streaming');
  });

  // ── Terminated state ────────────────────────────────────────────

  it('should report terminated state after block', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_block', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII found',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
      earlyTermination: true,
    });

    expect(evaluator.isTerminated()).toBe(false);

    await evaluator.evaluateChunk('SSN 123-45-6789. Done.');

    expect(evaluator.isTerminated()).toBe(true);
  });

  // ── Violation count ─────────────────────────────────────────────

  it('should count violations', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'escalate',
        message: 'PII found',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
      earlyTermination: true,
    });

    expect(evaluator.getViolationCount()).toBe(0);

    // Trigger first violation (escalate is terminal with earlyTermination)
    await evaluator.evaluateChunk('Email user@domain.com. ');

    expect(evaluator.getViolationCount()).toBe(1);
  });

  // ── Empty chunks ────────────────────────────────────────────────

  it('should handle empty chunks', async () => {
    const guardrails: Guardrail[] = [
      makeOutputGuardrail('pii_check', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(guardrails, {
      interval: 'sentence',
    });

    const event1 = await evaluator.evaluateChunk('');
    expect(event1.type).toBe('pass');

    const event2 = await evaluator.evaluateChunk('');
    expect(event2.type).toBe('pass');

    expect(evaluator.getBuffer()).toBe('');
    expect(evaluator.isTerminated()).toBe(false);
  });
});
