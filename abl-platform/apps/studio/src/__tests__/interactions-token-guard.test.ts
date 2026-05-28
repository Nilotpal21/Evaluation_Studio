/**
 * Token Aggregation & Guardrail Classification — tests
 *
 * Tests the pure logic for:
 * - Token aggregation across LLM call steps (TokenBadge)
 * - Guardrail check classification from trace events (GuardrailPanel)
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';
import { aggregateTokens } from '../components/observatory/interactions/TokenBadge';
import {
  extractGuardrailChecks,
  type GuardrailCheck,
} from '../components/observatory/interactions/GuardrailPanel';
import type { InteractionStep } from '../components/observatory/interactions/types';
import type { ExtendedTraceEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(data: Record<string, unknown>, type = 'guardrail_check'): ExtendedTraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'sess-1',
    agentName: 'test-agent',
    data,
  } as ExtendedTraceEvent;
}

function makeStep(
  type: InteractionStep['type'],
  data: Record<string, unknown>,
  events: ExtendedTraceEvent[] = [],
): InteractionStep {
  return {
    id: `step-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: new Date(),
    agentName: 'test-agent',
    events,
    data,
  };
}

// ---------------------------------------------------------------------------
// Token aggregation
// ---------------------------------------------------------------------------

describe('aggregateTokens', () => {
  it('sums tokensIn and tokensOut from llm_call steps', () => {
    const steps = [
      makeStep('llm_call', { tokensIn: 100, tokensOut: 20 }),
      makeStep('llm_call', { tokensIn: 200, tokensOut: 50 }),
    ];

    const result = aggregateTokens(steps);

    expect(result.totalTokens).toBe(370);
  });

  it('sums cost from llm_call steps', () => {
    const steps = [
      makeStep('llm_call', { tokensIn: 100, tokensOut: 20, cost: 0.001 }),
      makeStep('llm_call', { tokensIn: 200, tokensOut: 50, cost: 0.002 }),
    ];

    const result = aggregateTokens(steps);

    expect(result.totalCost).toBeCloseTo(0.003);
  });

  it('ignores non-llm_call steps', () => {
    const steps = [
      makeStep('user_input', { tokensIn: 999 }),
      makeStep('llm_call', { tokensIn: 50, tokensOut: 10 }),
      makeStep('tool_call', { tokensIn: 888 }),
    ];

    const result = aggregateTokens(steps);

    expect(result.totalTokens).toBe(60);
  });

  it('returns zero for empty steps', () => {
    const result = aggregateTokens([]);

    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('handles missing token fields gracefully', () => {
    const steps = [makeStep('llm_call', {})];

    const result = aggregateTokens(steps);

    expect(result.totalTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Guardrail classification
// ---------------------------------------------------------------------------

describe('extractGuardrailChecks', () => {
  it('classifies pass results', () => {
    const step = makeStep('input_guard', {}, [
      makeEvent({ checkType: 'pii_check', result: 'pass', confidence: 0.95 }),
    ]);

    const checks = extractGuardrailChecks(step);

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('pii_check');
    expect(checks[0].result).toBe('pass');
    expect(checks[0].confidence).toBe(0.95);
  });

  it('classifies fail results', () => {
    const step = makeStep('input_guard', {}, [
      makeEvent({
        checkType: 'injection_check',
        result: 'fail',
        details: 'SQL injection detected',
      }),
    ]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].result).toBe('fail');
    expect(checks[0].details).toBe('SQL injection detected');
  });

  it('classifies warning results', () => {
    const step = makeStep('output_guard', {}, [makeEvent({ name: 'toxicity', result: 'warning' })]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].result).toBe('warning');
  });

  it('classifies "clean" as pass', () => {
    const step = makeStep('input_guard', {}, [makeEvent({ guardName: 'policy', result: 'clean' })]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].result).toBe('pass');
  });

  it('classifies "blocked" as fail', () => {
    const step = makeStep('input_guard', {}, [
      makeEvent({ checkType: 'content_filter', result: 'blocked' }),
    ]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].result).toBe('fail');
  });

  it('classifies passed=true as pass', () => {
    const step = makeStep('input_guard', {}, [makeEvent({ checkType: 'safety', passed: true })]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].result).toBe('pass');
  });

  it('falls back to step data when no events', () => {
    const step = makeStep('input_guard', {
      checkType: 'pii_check',
      result: 'pass',
      confidence: 0.9,
    });

    const checks = extractGuardrailChecks(step);

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('pii_check');
    expect(checks[0].result).toBe('pass');
  });

  it('handles multiple check events', () => {
    const step = makeStep('input_guard', {}, [
      makeEvent({ checkType: 'pii', result: 'pass' }),
      makeEvent({ checkType: 'injection', result: 'pass' }),
      makeEvent({ checkType: 'toxicity', result: 'fail' }),
    ]);

    const checks = extractGuardrailChecks(step);

    expect(checks).toHaveLength(3);
    expect(checks.filter((c) => c.result === 'pass')).toHaveLength(2);
    expect(checks.filter((c) => c.result === 'fail')).toHaveLength(1);
  });

  it('strips guardrail_ prefix from event type names', () => {
    const step = makeStep('input_guard', {}, [makeEvent({}, 'guardrail_pii_check')]);

    const checks = extractGuardrailChecks(step);

    expect(checks[0].name).toBe('pii_check');
  });
});
