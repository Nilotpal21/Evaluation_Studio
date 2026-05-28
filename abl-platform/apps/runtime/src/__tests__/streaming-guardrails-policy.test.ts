/**
 * Tests for P1 fix: StreamingGuardrailEvaluator now accepts and forwards
 * PipelinePolicy to pipeline.execute().
 *
 * The fix adds a 4th constructor arg (policy?: PipelinePolicy) and passes
 * it as the 6th arg to every pipeline.execute() call — evaluateChunk,
 * evaluateFinal, and the terminated-path inside evaluateFinal.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Guardrail, GuardrailPipelineResult, PipelinePolicy } from '@abl/compiler';
import { GuardrailPipelineImpl, createEmptyPipelineResult } from '@abl/compiler';
import { StreamingGuardrailEvaluator } from '../services/guardrails/streaming-evaluator.js';

/** Helper: minimal output guardrail for testing */
function makeGuardrail(
  name: string,
  check: string,
  action: { type: string; message: string },
): Guardrail {
  return {
    name,
    description: `Test: ${name}`,
    kind: 'output',
    priority: 1,
    tier: 'local',
    check,
    action: action as Guardrail['action'],
  };
}

/** Helper: create a mock pipeline with a controllable execute method */
function createMockPipeline(result?: Partial<GuardrailPipelineResult>) {
  const baseResult = createEmptyPipelineResult();
  const merged = { ...baseResult, ...result };
  const execute = vi.fn().mockResolvedValue(merged);
  return { pipeline: { execute } as unknown as GuardrailPipelineImpl, execute };
}

describe('StreamingGuardrailEvaluator — PipelinePolicy forwarding', () => {
  // ── 1. Policy is passed to pipeline.execute on evaluateChunk ──────

  it('passes policy to pipeline.execute on evaluateChunk', async () => {
    const { pipeline, execute } = createMockPipeline();

    const guardrails = [
      makeGuardrail('test-guardrail', 'abl.length(output) > 0', {
        type: 'warn',
        message: 'non-empty',
      }),
    ];

    const policy: PipelinePolicy = {
      disabledGuardrails: ['test-guardrail'],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
      policy,
    );

    // Feed content with sentence boundary to trigger evaluation
    await evaluator.evaluateChunk('Hello world. ');

    expect(execute).toHaveBeenCalledTimes(1);
    // 6th arg (index 5) must be the policy
    expect(execute.mock.calls[0][5]).toBe(policy);
    expect(execute.mock.calls[0][5]).toEqual({
      disabledGuardrails: ['test-guardrail'],
    });
  });

  // ── 2. Policy is passed to pipeline.execute on evaluateFinal ──────

  it('passes policy to pipeline.execute on evaluateFinal', async () => {
    const { pipeline, execute } = createMockPipeline();

    const guardrails = [
      makeGuardrail('final-check', 'abl.length(output) > 0', {
        type: 'warn',
        message: 'content present',
      }),
    ];

    const policy: PipelinePolicy = {
      disabledGuardrails: ['some-guardrail'],
      settings: { failMode: 'open' },
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
      policy,
    );

    // Feed content without sentence boundary — no mid-stream eval
    await evaluator.evaluateChunk('No boundary here');
    expect(execute).not.toHaveBeenCalled();

    // Final evaluation should forward policy
    await evaluator.evaluateFinal();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][5]).toBe(policy);
  });

  // ── 3. Policy is passed on evaluateFinal when terminated ──────────

  it('passes policy to pipeline.execute on evaluateFinal after termination', async () => {
    // First call (evaluateChunk) returns a block violation to trigger termination
    const blockResult: Partial<GuardrailPipelineResult> = {
      passed: false,
      violations: [
        {
          name: 'pii-block',
          kind: 'output',
          tier: 'local',
          action: 'block',
          severity: 'high',
          message: 'PII detected',
          priority: 1,
          latencyMs: 0,
        },
      ],
      primaryViolation: {
        name: 'pii-block',
        kind: 'output',
        tier: 'local',
        action: 'block',
        severity: 'high',
        message: 'PII detected',
        priority: 1,
        latencyMs: 0,
      },
    };

    const execute = vi
      .fn()
      // First call (evaluateChunk) — block violation
      .mockResolvedValueOnce({ ...createEmptyPipelineResult(), ...blockResult })
      // Second call (evaluateFinal terminated path) — pass result
      .mockResolvedValueOnce(createEmptyPipelineResult());

    const pipeline = { execute } as unknown as GuardrailPipelineImpl;

    const guardrails = [
      makeGuardrail('pii-block', 'abl.contains_pii(output)', {
        type: 'block',
        message: 'PII detected',
      }),
    ];

    const policy: PipelinePolicy = {
      disabledGuardrails: ['other-guardrail'],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
      policy,
    );

    // Trigger termination via evaluateChunk
    const event = await evaluator.evaluateChunk('SSN is 123-45-6789. ');
    expect(event.type).toBe('terminate');
    expect(evaluator.isTerminated()).toBe(true);

    // First call should have received policy
    expect(execute.mock.calls[0][5]).toBe(policy);

    // evaluateFinal on the terminated path also calls execute with policy
    await evaluator.evaluateFinal();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][5]).toBe(policy);
  });

  // ── 4. No policy (undefined) works as before ─────────────────────

  it('passes undefined when no policy is provided', async () => {
    const { pipeline, execute } = createMockPipeline();

    const guardrails = [
      makeGuardrail('basic-check', 'abl.length(output) > 0', {
        type: 'warn',
        message: 'content',
      }),
    ];

    // No policy arg — 3-arg constructor
    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    await evaluator.evaluateChunk('Hello world. ');

    expect(execute).toHaveBeenCalledTimes(1);
    // 6th arg should be undefined
    expect(execute.mock.calls[0][5]).toBeUndefined();
  });

  // ── 5. Policy with failMode='closed' is forwarded ────────────────

  it('forwards policy with failMode closed to pipeline.execute', async () => {
    const { pipeline, execute } = createMockPipeline();

    const guardrails = [
      makeGuardrail('strict-check', 'abl.length(output) > 0', {
        type: 'block',
        message: 'content required',
      }),
    ];

    const policy: PipelinePolicy = {
      settings: { failMode: 'closed' },
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
      policy,
    );

    // Trigger via sentence boundary
    await evaluator.evaluateChunk('Content here. ');

    expect(execute).toHaveBeenCalledTimes(1);
    const passedPolicy = execute.mock.calls[0][5] as PipelinePolicy;
    expect(passedPolicy).toBe(policy);
    expect(passedPolicy.settings?.failMode).toBe('closed');
  });

  // ── 6. Policy disabling a guardrail name with real pipeline ───────

  it('disables a guardrail by name via policy when using real pipeline', async () => {
    const realPipeline = new GuardrailPipelineImpl();

    const guardrails: Guardrail[] = [
      makeGuardrail('always-block', 'true', {
        type: 'block',
        message: 'Always blocks',
      }),
      makeGuardrail('length-check', 'abl.length(output) > 1000', {
        type: 'warn',
        message: 'Output too long',
      }),
    ];

    // Disable the always-blocking guardrail via policy
    const policy: PipelinePolicy = {
      disabledGuardrails: ['always-block'],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      realPipeline,
      policy,
    );

    // With 'always-block' disabled, content under 1000 chars should pass
    const event = await evaluator.evaluateChunk('Short content. ');

    // The always-block guardrail is disabled, length-check threshold not met
    expect(event.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);

    // Final evaluation should also pass
    const finalResult = await evaluator.evaluateFinal();
    expect(finalResult.passed).toBe(true);
  });
});
