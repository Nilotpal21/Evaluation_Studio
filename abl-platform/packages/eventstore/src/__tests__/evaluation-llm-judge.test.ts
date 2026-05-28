import { describe, it, expect, vi } from 'vitest';
import {
  LLMJudgeEvaluator,
  DEFAULT_QUALITY_CRITERIA,
  type LLMCompletionFn,
  type EvaluationCriterion,
} from '../evaluation/evaluators/llm-judge-evaluator.js';
import type { EvaluationInput } from '../evaluation/interfaces.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    sessionId: 'sess-1',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    agentName: 'test-agent',
    messages: [
      { role: 'user', content: 'I need to book a hotel in Paris' },
      {
        role: 'agent',
        content: "I'd be happy to help you book a hotel in Paris. What dates are you looking for?",
      },
      { role: 'user', content: 'March 15-18' },
      {
        role: 'agent',
        content:
          'I found several options for March 15-18 in Paris. The Hotel Le Marais is available at $150/night.',
      },
    ],
    traceEvents: [],
    sessionMetadata: {
      totalDurationMs: 25000,
      totalTurns: 4,
      totalLLMCalls: 2,
      totalToolCalls: 1,
      endReason: 'completed',
    },
    ...overrides,
  };
}

function makeMockCompletion(responseJson: Record<string, unknown>): LLMCompletionFn {
  return vi.fn().mockResolvedValue({
    text: JSON.stringify(responseJson),
    tokensUsed: 500,
    estimatedCost: 0.001,
    model: 'gpt-4o-mini',
  });
}

function makeGoodResponse(): Record<string, unknown> {
  return {
    resolution_quality: { score: 4, reasoning: 'Good resolution' },
    response_accuracy: { score: 5, reasoning: 'Accurate responses' },
    helpfulness: { score: 4, reasoning: 'Helpful and actionable' },
    coherence: { score: 5, reasoning: 'Logically consistent' },
    professionalism: { score: 4, reasoning: 'Professional tone' },
    safety: { score: 'pass', reasoning: 'No safety issues' },
    pii_handling: { score: 'pass', reasoning: 'PII handled correctly' },
  };
}

// =============================================================================
// LLM JUDGE EVALUATOR
// =============================================================================

describe('LLMJudgeEvaluator', () => {
  it('has correct name and type', () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('quality-judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });
    expect(evaluator.name).toBe('quality-judge');
    expect(evaluator.type).toBe('llm_judge');
  });

  it('calls completion function with correct params', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 3000,
    });

    await evaluator.evaluate(makeInput());

    expect(fn).toHaveBeenCalledOnce();
    const callArgs = (fn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o');
    expect(callArgs.temperature).toBe(0.2);
    expect(callArgs.maxTokens).toBe(3000);
    expect(callArgs.systemPrompt).toBeDefined();
    expect(callArgs.userPrompt).toContain('book a hotel');
  });

  it('uses default model and temperature', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    await evaluator.evaluate(makeInput());

    const callArgs = (fn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.temperature).toBe(0.1);
    expect(callArgs.maxTokens).toBe(2000);
  });

  it('parses numeric and pass/fail scores', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    expect(output.evaluatorName).toBe('judge');
    expect(output.evaluatorType).toBe('llm_judge');
    expect(output.scores).toHaveLength(7);

    // Numeric scores
    const resolution = output.scores.find((s) => s.name === 'resolution_quality');
    expect(resolution?.value).toBe(4);
    expect(resolution?.reasoning).toBe('Good resolution');

    // Pass/fail scores
    const safety = output.scores.find((s) => s.name === 'safety');
    expect(safety?.value).toBe('pass');
  });

  it('computes weighted composite score', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    // Weighted: (4*0.25 + 5*0.20 + 4*0.25 + 5*0.15 + 4*0.15) / 1.0 = 4.35
    expect(output.compositeScore).toBeCloseTo(4.35, 1);
  });

  it('includes model and cost metadata', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    expect(output.modelUsed).toBe('gpt-4o-mini');
    expect(output.tokensUsed).toBe(500);
    expect(output.estimatedCost).toBe(0.001);
    expect(output.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    const fn = vi.fn().mockResolvedValue({
      text: '```json\n' + JSON.stringify(makeGoodResponse()) + '\n```',
      tokensUsed: 500,
      estimatedCost: 0.001,
      model: 'gpt-4o-mini',
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    const resolution = output.scores.find((s) => s.name === 'resolution_quality');
    expect(resolution?.value).toBe(4);
  });

  it('returns defaults when JSON parsing fails', async () => {
    const fn = vi.fn().mockResolvedValue({
      text: 'This is not JSON at all',
      tokensUsed: 100,
      estimatedCost: 0.0002,
      model: 'gpt-4o-mini',
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    // Should return default scores for all criteria
    expect(output.scores).toHaveLength(7);
    const resolution = output.scores.find((s) => s.name === 'resolution_quality');
    expect(resolution?.value).toBe(3); // default for numeric
    expect(resolution?.reasoning).toContain('Failed to parse');
  });

  it('returns defaults when criterion missing from response', async () => {
    const fn = makeMockCompletion({
      resolution_quality: { score: 5, reasoning: 'Great' },
      // All other criteria missing
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    const resolution = output.scores.find((s) => s.name === 'resolution_quality');
    expect(resolution?.value).toBe(5);

    const accuracy = output.scores.find((s) => s.name === 'response_accuracy');
    expect(accuracy?.value).toBe(3); // default
    expect(accuracy?.reasoning).toContain('not found');
  });

  it('clamps numeric scores to 1-5 range', async () => {
    const fn = makeMockCompletion({
      resolution_quality: { score: 10, reasoning: 'Out of range' },
      response_accuracy: { score: -2, reasoning: 'Negative' },
      helpfulness: { score: 3, reasoning: 'Normal' },
      coherence: { score: 5, reasoning: 'Max' },
      professionalism: { score: 1, reasoning: 'Min' },
      safety: { score: 'pass', reasoning: 'OK' },
      pii_handling: { score: 'pass', reasoning: 'OK' },
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    const resolution = output.scores.find((s) => s.name === 'resolution_quality');
    expect(resolution?.value).toBe(5); // clamped to max

    const accuracy = output.scores.find((s) => s.name === 'response_accuracy');
    expect(accuracy?.value).toBe(1); // clamped to min
  });

  it('normalizes pass/fail to lowercase comparison', async () => {
    const fn = makeMockCompletion({
      ...makeGoodResponse(),
      safety: { score: 'FAIL', reasoning: 'Violation found' },
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    const output = await evaluator.evaluate(makeInput());

    const safety = output.scores.find((s) => s.name === 'safety');
    expect(safety?.value).toBe('fail');
  });

  it('supports custom criteria', async () => {
    const customCriteria: EvaluationCriterion[] = [
      {
        name: 'domain_accuracy',
        description: 'Did the agent use correct domain terminology?',
        scoreType: 'numeric_1_5',
        weight: 1.0,
      },
    ];
    const fn = makeMockCompletion({
      domain_accuracy: { score: 4, reasoning: 'Good domain knowledge' },
    });
    const evaluator = new LLMJudgeEvaluator('custom-judge', {
      completionFn: fn,
      criteria: customCriteria,
    });

    const output = await evaluator.evaluate(makeInput());

    expect(output.scores).toHaveLength(1);
    expect(output.scores[0].name).toBe('domain_accuracy');
    expect(output.scores[0].value).toBe(4);
    expect(output.compositeScore).toBe(4);
  });

  it('includes conversation transcript in prompt', async () => {
    const fn = makeMockCompletion(makeGoodResponse());
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria: DEFAULT_QUALITY_CRITERIA,
    });

    await evaluator.evaluate(makeInput());

    const callArgs = (fn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.userPrompt).toContain('[USER]');
    expect(callArgs.userPrompt).toContain('[AGENT]');
    expect(callArgs.userPrompt).toContain('book a hotel in Paris');
    expect(callArgs.userPrompt).toContain('Turns: 4');
    expect(callArgs.userPrompt).toContain('Duration: 25000ms');
  });

  it('supports categorical score type', async () => {
    const criteria: EvaluationCriterion[] = [
      {
        name: 'sentiment',
        description: 'Overall conversation sentiment',
        scoreType: 'categorical',
        categories: ['positive', 'neutral', 'negative'],
      },
    ];
    const fn = makeMockCompletion({
      sentiment: { score: 'positive', reasoning: 'Upbeat conversation' },
    });
    const evaluator = new LLMJudgeEvaluator('judge', {
      completionFn: fn,
      criteria,
    });

    const output = await evaluator.evaluate(makeInput());

    expect(output.scores[0].value).toBe('positive');
    // Composite excludes non-numeric
    expect(output.compositeScore).toBe(0);
  });
});

// =============================================================================
// DEFAULT QUALITY CRITERIA
// =============================================================================

describe('DEFAULT_QUALITY_CRITERIA', () => {
  it('has 7 criteria', () => {
    expect(DEFAULT_QUALITY_CRITERIA).toHaveLength(7);
  });

  it('has 5 numeric and 2 pass/fail criteria', () => {
    const numeric = DEFAULT_QUALITY_CRITERIA.filter((c) => c.scoreType === 'numeric_1_5');
    const passFail = DEFAULT_QUALITY_CRITERIA.filter((c) => c.scoreType === 'pass_fail');
    expect(numeric).toHaveLength(5);
    expect(passFail).toHaveLength(2);
  });

  it('numeric weights sum to 1.0', () => {
    const totalWeight = DEFAULT_QUALITY_CRITERIA.filter(
      (c) => c.scoreType === 'numeric_1_5',
    ).reduce((sum, c) => sum + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it('includes safety and pii_handling', () => {
    const names = DEFAULT_QUALITY_CRITERIA.map((c) => c.name);
    expect(names).toContain('safety');
    expect(names).toContain('pii_handling');
  });
});
