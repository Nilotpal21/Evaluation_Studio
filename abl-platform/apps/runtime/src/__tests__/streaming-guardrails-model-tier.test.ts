/**
 * Streaming guardrails e2e tests for model-tier providers.
 *
 * Validates that StreamingGuardrailEvaluator works correctly with Tier 2
 * (model-based) providers via the pipeline, including:
 *   1. Streaming with openai-moderation provider (mocked)
 *   2. Streaming with custom-http provider (mocked)
 *   3. Early termination when model-tier blocks mid-stream
 *   4. Latency budget behavior with slow model-tier providers
 *   5. Policy forwarding in streaming mode per provider type
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Guardrail,
  GuardrailPipelineResult,
  PipelinePolicy,
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '@abl/compiler';
import {
  GuardrailPipelineImpl,
  GuardrailProviderRegistry,
  createEmptyPipelineResult,
} from '@abl/compiler';
import { StreamingGuardrailEvaluator } from '../services/guardrails/streaming-evaluator.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModelGuardrail(
  name: string,
  provider: string,
  overrides: Partial<Guardrail> = {},
): Guardrail {
  return {
    name,
    description: `Test model guardrail: ${name}`,
    kind: 'output',
    priority: 1,
    tier: 'model',
    provider,
    check: undefined,
    action: { type: 'block', message: `Blocked by ${name}` },
    ...overrides,
  };
}

/** Create a mock GuardrailModelProvider with controllable evaluate behavior */
function createMockProvider(
  name: string,
  evaluateFn?: (req: GuardrailEvalRequest) => Promise<GuardrailEvalResult>,
): GuardrailModelProvider {
  const defaultEval = async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
    score: 0.0,
    severity: 'safe',
    category: req.category,
    latencyMs: 1,
  });
  return {
    name,
    costPerEvalUsd: 0.001,
    evaluate: evaluateFn ?? defaultEval,
    isAvailable: async () => true,
  };
}

/** Build a real pipeline with a registry containing the given providers */
function buildPipeline(providers: GuardrailModelProvider[]): GuardrailPipelineImpl {
  const registry = new GuardrailProviderRegistry();
  for (const p of providers) {
    registry.register(p);
  }
  return new GuardrailPipelineImpl(registry);
}

// ---------------------------------------------------------------------------
// 1. Streaming with openai-moderation provider (mocked)
// ---------------------------------------------------------------------------

describe('Streaming with openai-moderation provider (mocked)', () => {
  it('accumulates chunks and evaluates at sentence boundary via model provider', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.1,
        severity: 'safe',
        category: req.category,
        latencyMs: 5,
      }),
    );

    const provider = createMockProvider('openai-moderation', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('oai-mod-check', 'openai-moderation')];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    // Feed chunks without sentence boundary — no evaluation yet
    await evaluator.evaluateChunk('Hello ');
    await evaluator.evaluateChunk('world ');
    expect(evaluateSpy).not.toHaveBeenCalled();

    // Sentence boundary triggers evaluation
    const result = await evaluator.evaluateChunk('today. ');
    expect(result.type).toBe('pass');
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(evaluateSpy.mock.calls[0][0].content).toBe('Hello world today. ');
  });

  it('detects violation from openai-moderation and returns violation event', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.95,
        severity: 'critical',
        category: req.category,
        label: 'harassment',
        latencyMs: 10,
      }),
    );

    const provider = createMockProvider('openai-moderation', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('oai-mod-check', 'openai-moderation', { threshold: 0.5 }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
    );

    const result = await evaluator.evaluateChunk('You are terrible. ');
    expect(result.type).toBe('terminate');
    expect(result.violation?.guardrailName).toBe('oai-mod-check');
    expect(result.violation?.action).toBe('block');
    expect(evaluator.isTerminated()).toBe(true);
  });

  it('evaluateFinal runs full evaluation via model provider', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.0,
        severity: 'safe',
        category: req.category,
        latencyMs: 3,
      }),
    );

    const provider = createMockProvider('openai-moderation', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('oai-mod-final', 'openai-moderation')];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    // Feed content without sentence boundary
    await evaluator.evaluateChunk('All good content');
    expect(evaluateSpy).not.toHaveBeenCalled();

    // Final evaluation should trigger
    const finalResult = await evaluator.evaluateFinal();
    expect(finalResult.passed).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming with custom-http provider (mocked)
// ---------------------------------------------------------------------------

describe('Streaming with custom-http provider (mocked)', () => {
  it('evaluates at sentence boundaries with custom-http provider', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.2,
        severity: 'low',
        category: req.category,
        label: 'mild',
        latencyMs: 50,
      }),
    );

    const provider = createMockProvider('custom-safety-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('custom-http-check', 'custom-safety-api', {
        threshold: 0.5,
        action: { type: 'warn', message: 'Content flagged' },
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    // Score 0.2 is below threshold 0.5 — should pass
    const result = await evaluator.evaluateChunk('This is fine content. ');
    expect(result.type).toBe('pass');
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('custom-http provider returning high score triggers warn (non-terminal)', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.7,
        severity: 'high',
        category: req.category,
        latencyMs: 30,
      }),
    );

    const provider = createMockProvider('custom-safety-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('custom-http-warn', 'custom-safety-api', {
        threshold: 0.5,
        action: { type: 'warn', message: 'Content flagged' },
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
    );

    // Score 0.7 >= threshold 0.5, but action is warn (non-terminal) — should not terminate
    const result = await evaluator.evaluateChunk('Questionable content. ');
    // warn is non-terminal, so the evaluator should not terminate
    expect(evaluator.isTerminated()).toBe(false);
    // The pipeline marks warn as a warning, not a violation, so result.passed stays true
    // and the streaming evaluator returns 'pass' (no terminal violation found)
    expect(result.type).toBe('pass');
  });

  it('chunk-based interval triggers evaluation at chunk size threshold', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.0,
        severity: 'safe',
        category: req.category,
        latencyMs: 2,
      }),
    );

    const provider = createMockProvider('custom-chunk-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('chunk-check', 'custom-chunk-api')];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'chunk', chunkSize: 20 },
      pipeline,
    );

    // Feed content under chunk size — no evaluation
    await evaluator.evaluateChunk('Short text');
    expect(evaluateSpy).not.toHaveBeenCalled();

    // Push over chunk size — triggers evaluation
    await evaluator.evaluateChunk(' with more words added');
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Early termination when model-tier blocks mid-stream
// ---------------------------------------------------------------------------

describe('Early termination with model-tier providers', () => {
  it('terminates stream on block action from model provider at sentence boundary', async () => {
    let callCount = 0;
    const evaluateSpy = vi.fn(async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => {
      callCount++;
      // First sentence is safe, second triggers block
      if (callCount === 1) {
        return { score: 0.1, severity: 'safe', category: req.category, latencyMs: 5 };
      }
      return { score: 0.9, severity: 'critical', category: req.category, latencyMs: 5 };
    });

    const provider = createMockProvider('moderation-provider', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('mid-stream-block', 'moderation-provider', { threshold: 0.5 }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
    );

    // First sentence — safe
    const result1 = await evaluator.evaluateChunk('This is safe content. ');
    expect(result1.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);

    // Second sentence — triggers block
    const result2 = await evaluator.evaluateChunk('Now something bad. ');
    expect(result2.type).toBe('terminate');
    expect(evaluator.isTerminated()).toBe(true);

    // Subsequent chunks should immediately return terminate
    const result3 = await evaluator.evaluateChunk('More content. ');
    expect(result3.type).toBe('terminate');
    // Provider should not be called for the third chunk
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('escalate action also triggers early termination', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.95,
        severity: 'critical',
        category: req.category,
        latencyMs: 3,
      }),
    );

    const provider = createMockProvider('escalate-provider', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('escalate-check', 'escalate-provider', {
        threshold: 0.5,
        action: { type: 'escalate', message: 'Requires human review' },
      }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
    );

    const result = await evaluator.evaluateChunk('Dangerous content. ');
    expect(result.type).toBe('terminate');
    expect(result.violation?.action).toBe('escalate');
    expect(evaluator.isTerminated()).toBe(true);
  });

  it('earlyTermination=false allows stream to continue after block violation', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.9,
        severity: 'critical',
        category: req.category,
        latencyMs: 3,
      }),
    );

    const provider = createMockProvider('non-term-provider', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [
      makeModelGuardrail('non-term-check', 'non-term-provider', { threshold: 0.5 }),
    ];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: false },
      pipeline,
    );

    // Even though block violation, earlyTermination=false means no termination
    const result = await evaluator.evaluateChunk('Bad content. ');
    expect(result.type).toBe('violation');
    expect(evaluator.isTerminated()).toBe(false);
    expect(evaluator.getViolationCount()).toBe(1);

    // Can still process more chunks
    const result2 = await evaluator.evaluateChunk('More content. ');
    expect(evaluator.isTerminated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Latency budget behavior with model-tier providers
// ---------------------------------------------------------------------------

describe('Latency budget with model-tier providers', () => {
  it('slow model provider does not block stream (fail-open on timeout)', async () => {
    // Simulate a provider that takes too long
    const slowProvider = createMockProvider(
      'slow-provider',
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => {
        // Simulate a timeout by throwing
        throw new Error('Request timed out');
      },
    );

    const pipeline = buildPipeline([slowProvider]);
    const guardrails = [makeModelGuardrail('slow-check', 'slow-provider')];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    // Pipeline error should fail-open (streaming evaluator catches and returns pass)
    const result = await evaluator.evaluateChunk('Content to check. ');
    expect(result.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);
  });

  it('fail-closed policy causes timeout to block in streaming evaluator final', async () => {
    const failingProvider = createMockProvider(
      'failing-provider',
      async (): Promise<GuardrailEvalResult> => {
        throw new Error('Service unavailable');
      },
    );

    const pipeline = buildPipeline([failingProvider]);
    const guardrails = [
      makeModelGuardrail('fail-closed-check', 'failing-provider', { threshold: 0.5 }),
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

    // With failMode=closed, the pipeline catches the provider error internally
    // and returns a violation result (passed=false) rather than throwing.
    // The streaming evaluator sees a terminal violation and terminates.
    const chunkResult = await evaluator.evaluateChunk('Some content. ');
    expect(chunkResult.type).toBe('terminate');
    expect(evaluator.isTerminated()).toBe(true);
    expect(chunkResult.violation?.guardrailName).toBe('fail-closed-check');

    // Final evaluation on the terminated path also returns failed
    const finalResult = await evaluator.evaluateFinal();
    expect(finalResult.passed).toBe(false);
    expect(finalResult.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('provider returning quickly passes within latency budget', async () => {
    const fastProvider = createMockProvider(
      'fast-provider',
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.0,
        severity: 'safe',
        category: req.category,
        latencyMs: 1,
      }),
    );

    const pipeline = buildPipeline([fastProvider]);
    const guardrails = [makeModelGuardrail('fast-check', 'fast-provider')];

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
    );

    const result = await evaluator.evaluateChunk('Quick evaluation. ');
    expect(result.type).toBe('pass');

    const finalResult = await evaluator.evaluateFinal();
    expect(finalResult.passed).toBe(true);
    expect(finalResult.metrics.tier2LatencyMs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Policy forwarding in streaming mode for each provider type
// ---------------------------------------------------------------------------

describe('Policy forwarding in streaming mode', () => {
  it('policy with disabledGuardrails skips model-tier guardrail in streaming', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.95,
        severity: 'critical',
        category: req.category,
        latencyMs: 5,
      }),
    );

    const provider = createMockProvider('moderation-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('disabled-check', 'moderation-api', { threshold: 0.5 })];
    const policy: PipelinePolicy = {
      disabledGuardrails: ['disabled-check'],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
      policy,
    );

    // Even though provider would return high score, guardrail is disabled by policy
    const result = await evaluator.evaluateChunk('Content that would violate. ');
    expect(result.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);

    // Provider should not have been called since the guardrail is disabled
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('policy with threshold override changes sensitivity in streaming', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.6,
        severity: 'medium',
        category: req.category,
        latencyMs: 5,
      }),
    );

    const provider = createMockProvider('threshold-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    // Original threshold is 0.5 — score 0.6 would violate
    const guardrails = [makeModelGuardrail('threshold-check', 'threshold-api', { threshold: 0.5 })];
    // Policy raises threshold to 0.8 — score 0.6 should now pass
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'threshold-check',
          override: 'threshold',
          threshold: 0.8,
        },
      ],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      pipeline,
      policy,
    );

    const result = await evaluator.evaluateChunk('Moderate content. ');
    expect(result.type).toBe('pass');
    expect(evaluator.isTerminated()).toBe(false);
  });

  it('policy with action override changes block to warn in streaming', async () => {
    const evaluateSpy = vi.fn(
      async (req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.9,
        severity: 'critical',
        category: req.category,
        latencyMs: 5,
      }),
    );

    const provider = createMockProvider('action-override-api', evaluateSpy);
    const pipeline = buildPipeline([provider]);
    // Default action is block
    const guardrails = [
      makeModelGuardrail('action-check', 'action-override-api', { threshold: 0.5 }),
    ];
    // Policy changes action to warn (non-terminal)
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'action-check',
          override: 'action',
          action: { type: 'warn', message: 'Downgraded to warning' },
        },
      ],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence', earlyTermination: true },
      pipeline,
      policy,
    );

    // With action overridden to warn, should not terminate even with high score
    const result = await evaluator.evaluateChunk('Violating content. ');
    expect(evaluator.isTerminated()).toBe(false);
    // warn is non-terminal, so streaming continues
    expect(result.type).toBe('pass');
  });

  it('policy with failMode=closed is forwarded through streaming evaluator', async () => {
    const mockExecute = vi.fn().mockResolvedValue(createEmptyPipelineResult());
    const mockPipeline = { execute: mockExecute } as unknown as GuardrailPipelineImpl;

    const guardrails = [makeModelGuardrail('policy-fwd-check', 'some-provider')];
    const policy: PipelinePolicy = {
      settings: { failMode: 'closed' },
      disabledGuardrails: ['other-guard'],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      mockPipeline,
      policy,
    );

    await evaluator.evaluateChunk('Test content. ');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // 6th argument (index 5) should be the policy
    const passedPolicy = mockExecute.mock.calls[0][5];
    expect(passedPolicy).toBe(policy);
    expect(passedPolicy.settings?.failMode).toBe('closed');
    expect(passedPolicy.disabledGuardrails).toContain('other-guard');
  });

  it('policy with providerOverrides is forwarded in streaming', async () => {
    const mockExecute = vi.fn().mockResolvedValue(createEmptyPipelineResult());
    const mockPipeline = { execute: mockExecute } as unknown as GuardrailPipelineImpl;

    const guardrails = [makeModelGuardrail('provider-override-check', 'custom-api')];
    const policy: PipelinePolicy = {
      providerOverrides: [
        {
          providerName: 'custom-api',
          circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
        },
      ],
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      mockPipeline,
      policy,
    );

    await evaluator.evaluateChunk('Content here. ');

    const passedPolicy = mockExecute.mock.calls[0][5];
    expect(passedPolicy.providerOverrides).toHaveLength(1);
    expect(passedPolicy.providerOverrides![0].providerName).toBe('custom-api');
    expect(passedPolicy.providerOverrides![0].circuitBreaker?.failureThreshold).toBe(3);
  });

  it('policy forwarding works on evaluateFinal path', async () => {
    const mockExecute = vi.fn().mockResolvedValue(createEmptyPipelineResult());
    const mockPipeline = { execute: mockExecute } as unknown as GuardrailPipelineImpl;

    const guardrails = [makeModelGuardrail('final-policy-check', 'api-provider')];
    const policy: PipelinePolicy = {
      settings: { failMode: 'closed' },
    };

    const evaluator = new StreamingGuardrailEvaluator(
      guardrails,
      { interval: 'sentence' },
      mockPipeline,
      policy,
    );

    // No sentence boundary — goes straight to final
    await evaluator.evaluateChunk('No boundary');
    expect(mockExecute).not.toHaveBeenCalled();

    await evaluator.evaluateFinal();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][5]).toBe(policy);
  });
});
