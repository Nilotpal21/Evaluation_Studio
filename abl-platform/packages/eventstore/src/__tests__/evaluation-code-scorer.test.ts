import { describe, it, expect, beforeEach } from 'vitest';
import {
  CodeScorerEvaluator,
  BUILT_IN_SCORERS,
  turnEfficiencyScorer,
  repetitionScorer,
  errorOutcomeScorer,
  toolSuccessScorer,
  containmentScorer,
} from '../evaluation/evaluators/code-scorer.js';
import type { EvaluationInput } from '../evaluation/interfaces.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import type { EventCategory } from '../interfaces/types.js';

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
      { role: 'user', content: 'Hello' },
      { role: 'agent', content: 'Hi! How can I help you today?' },
      { role: 'user', content: 'Book a hotel' },
      { role: 'agent', content: 'Sure, I can help with that.' },
    ],
    traceEvents: [],
    sessionMetadata: {
      totalDurationMs: 15000,
      totalTurns: 4,
      totalLLMCalls: 2,
      totalToolCalls: 1,
      endReason: 'completed',
    },
    ...overrides,
  };
}

function makeTraceEvent(type: string, hasError = false): PlatformEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    event_type: type,
    category: 'tool' as EventCategory,
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    session_id: 'sess-1',
    timestamp: new Date(),
    has_error: hasError,
    data: {},
  };
}

// =============================================================================
// TURN EFFICIENCY SCORER
// =============================================================================

describe('turnEfficiencyScorer', () => {
  it('scores 5 for ≤3 turns', () => {
    const result = turnEfficiencyScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 5000,
          totalTurns: 2,
          totalLLMCalls: 1,
          totalToolCalls: 0,
          endReason: 'completed',
        },
      }),
    );
    expect(result.name).toBe('turn_efficiency');
    expect(result.value).toBe(5);
  });

  it('scores 4 for 4–6 turns', () => {
    const result = turnEfficiencyScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 10000,
          totalTurns: 5,
          totalLLMCalls: 3,
          totalToolCalls: 1,
          endReason: 'completed',
        },
      }),
    );
    expect(result.value).toBe(4);
  });

  it('scores 3 for 7–10 turns', () => {
    const result = turnEfficiencyScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 20000,
          totalTurns: 8,
          totalLLMCalls: 4,
          totalToolCalls: 2,
          endReason: 'completed',
        },
      }),
    );
    expect(result.value).toBe(3);
  });

  it('scores 2 for 11–15 turns', () => {
    const result = turnEfficiencyScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 30000,
          totalTurns: 12,
          totalLLMCalls: 6,
          totalToolCalls: 3,
          endReason: 'completed',
        },
      }),
    );
    expect(result.value).toBe(2);
  });

  it('scores 1 for >15 turns', () => {
    const result = turnEfficiencyScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 60000,
          totalTurns: 20,
          totalLLMCalls: 10,
          totalToolCalls: 5,
          endReason: 'completed',
        },
      }),
    );
    expect(result.value).toBe(1);
  });

  it('includes reasoning', () => {
    const result = turnEfficiencyScorer(makeInput());
    expect(result.reasoning).toContain('4 turns');
  });
});

// =============================================================================
// REPETITION SCORER
// =============================================================================

describe('repetitionScorer', () => {
  it('returns 0 rate for unique messages', () => {
    const result = repetitionScorer(makeInput());
    expect(result.name).toBe('repetition_rate');
    expect(result.value).toBe(0);
  });

  it('detects repeated agent messages', () => {
    const result = repetitionScorer(
      makeInput({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'agent', content: 'I can help with that.' },
          { role: 'user', content: 'Thanks' },
          { role: 'agent', content: 'I can help with that.' },
          { role: 'user', content: 'Again?' },
          { role: 'agent', content: 'I can help with that.' },
        ],
      }),
    );
    // 3 agent messages, 1 unique → repetition rate = 1 - 1/3 ≈ 0.67
    expect(result.value).toBeCloseTo(0.67, 1);
    expect(result.reasoning).toContain('67%');
  });

  it('handles case-insensitive comparison', () => {
    const result = repetitionScorer(
      makeInput({
        messages: [
          { role: 'agent', content: 'Hello' },
          { role: 'agent', content: 'hello' },
        ],
      }),
    );
    // Both lowercase to "hello" → 1 unique out of 2 → rate = 0.5
    expect(result.value).toBe(0.5);
  });

  it('returns 0 when no agent messages exist', () => {
    const result = repetitionScorer(
      makeInput({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'user', content: 'Anyone there?' },
        ],
      }),
    );
    expect(result.value).toBe(0);
  });
});

// =============================================================================
// ERROR OUTCOME SCORER
// =============================================================================

describe('errorOutcomeScorer', () => {
  it('passes when no errors', () => {
    const result = errorOutcomeScorer(makeInput());
    expect(result.name).toBe('error_free');
    expect(result.value).toBe('pass');
    expect(result.reasoning).toContain('without errors');
  });

  it('fails when session ended with error', () => {
    const result = errorOutcomeScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 5000,
          totalTurns: 2,
          totalLLMCalls: 1,
          totalToolCalls: 0,
          endReason: 'error',
        },
        traceEvents: [makeTraceEvent('llm.call.failed', true)],
      }),
    );
    expect(result.value).toBe('fail');
    expect(result.reasoning).toContain('error');
    expect(result.reasoning).toContain('1 error events');
  });
});

// =============================================================================
// TOOL SUCCESS SCORER
// =============================================================================

describe('toolSuccessScorer', () => {
  it('returns 1.0 when no tool calls', () => {
    const result = toolSuccessScorer(makeInput());
    expect(result.name).toBe('tool_success_rate');
    expect(result.value).toBe(1.0);
    expect(result.reasoning).toContain('No tool calls');
  });

  it('calculates success rate from trace events', () => {
    const result = toolSuccessScorer(
      makeInput({
        traceEvents: [
          makeTraceEvent('tool.call.completed', false),
          makeTraceEvent('tool.call.completed', false),
          makeTraceEvent('tool.call.failed', true),
        ],
      }),
    );
    expect(result.value).toBeCloseTo(0.67, 1);
    expect(result.reasoning).toContain('2/3');
  });

  it('returns 1.0 when all tool calls succeed', () => {
    const result = toolSuccessScorer(
      makeInput({
        traceEvents: [
          makeTraceEvent('tool.call.completed', false),
          makeTraceEvent('tool.call.completed', false),
        ],
      }),
    );
    expect(result.value).toBe(1.0);
  });

  it('returns 0 when all tool calls fail', () => {
    const result = toolSuccessScorer(
      makeInput({
        traceEvents: [
          makeTraceEvent('tool.call.failed', true),
          makeTraceEvent('tool.call.failed', true),
        ],
      }),
    );
    expect(result.value).toBe(0);
  });

  it('ignores non-tool events', () => {
    const result = toolSuccessScorer(
      makeInput({
        traceEvents: [
          makeTraceEvent('llm.call.completed', false),
          makeTraceEvent('agent.entered', false),
          makeTraceEvent('tool.call.completed', false),
        ],
      }),
    );
    // Only 1 tool event (successful)
    expect(result.value).toBe(1.0);
    expect(result.reasoning).toContain('1/1');
  });
});

// =============================================================================
// CONTAINMENT SCORER
// =============================================================================

describe('containmentScorer', () => {
  it('returns true when contained and completed', () => {
    const result = containmentScorer(makeInput());
    expect(result.name).toBe('contained');
    expect(result.value).toBe(true);
    expect(result.reasoning).toContain('without escalation');
  });

  it('returns false when escalated', () => {
    const result = containmentScorer(
      makeInput({
        traceEvents: [makeTraceEvent('agent.escalated')],
      }),
    );
    expect(result.value).toBe(false);
    expect(result.reasoning).toContain('escalated to human');
  });

  it('returns false when session did not complete', () => {
    const result = containmentScorer(
      makeInput({
        sessionMetadata: {
          totalDurationMs: 5000,
          totalTurns: 2,
          totalLLMCalls: 1,
          totalToolCalls: 0,
          endReason: 'timeout',
        },
      }),
    );
    expect(result.value).toBe(false);
    expect(result.reasoning).toContain('did not complete');
  });
});

// =============================================================================
// CODE SCORER EVALUATOR CLASS
// =============================================================================

describe('CodeScorerEvaluator', () => {
  let evaluator: CodeScorerEvaluator;

  beforeEach(() => {
    evaluator = new CodeScorerEvaluator('test-scorer', {
      scorers: BUILT_IN_SCORERS,
    });
  });

  it('has correct name and type', () => {
    expect(evaluator.name).toBe('test-scorer');
    expect(evaluator.type).toBe('code_scorer');
  });

  it('runs all built-in scorers', async () => {
    const output = await evaluator.evaluate(makeInput());

    expect(output.evaluatorName).toBe('test-scorer');
    expect(output.evaluatorType).toBe('code_scorer');
    expect(output.scores).toHaveLength(5);

    const scoreNames = output.scores.map((s) => s.name);
    expect(scoreNames).toContain('turn_efficiency');
    expect(scoreNames).toContain('repetition_rate');
    expect(scoreNames).toContain('error_free');
    expect(scoreNames).toContain('tool_success_rate');
    expect(scoreNames).toContain('contained');
  });

  it('records latency', async () => {
    const output = await evaluator.evaluate(makeInput());
    expect(output.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles scorer returning array of scores', async () => {
    const multiScorer = () => [
      { name: 'score_a', value: 1 },
      { name: 'score_b', value: 2 },
    ];
    const evalMulti = new CodeScorerEvaluator('multi', { scorers: [multiScorer] });
    const output = await evalMulti.evaluate(makeInput());

    expect(output.scores).toHaveLength(2);
    expect(output.scores[0].name).toBe('score_a');
    expect(output.scores[1].name).toBe('score_b');
  });

  it('skips failing scorers without blocking others', async () => {
    const failScorer = () => {
      throw new Error('boom');
    };
    const goodScorer = () => ({ name: 'good', value: 42 });
    const eval2 = new CodeScorerEvaluator('mixed', { scorers: [failScorer, goodScorer] });
    const output = await eval2.evaluate(makeInput());

    expect(output.scores).toHaveLength(1);
    expect(output.scores[0].name).toBe('good');
  });

  it('returns empty scores if all scorers fail', async () => {
    const failScorer = () => {
      throw new Error('fail');
    };
    const eval3 = new CodeScorerEvaluator('all-fail', { scorers: [failScorer, failScorer] });
    const output = await eval3.evaluate(makeInput());

    expect(output.scores).toHaveLength(0);
  });
});

// =============================================================================
// BUILT_IN_SCORERS export
// =============================================================================

describe('BUILT_IN_SCORERS', () => {
  it('contains 5 scoring functions', () => {
    expect(BUILT_IN_SCORERS).toHaveLength(5);
    expect(BUILT_IN_SCORERS).toContain(turnEfficiencyScorer);
    expect(BUILT_IN_SCORERS).toContain(repetitionScorer);
    expect(BUILT_IN_SCORERS).toContain(errorOutcomeScorer);
    expect(BUILT_IN_SCORERS).toContain(toolSuccessScorer);
    expect(BUILT_IN_SCORERS).toContain(containmentScorer);
  });
});
