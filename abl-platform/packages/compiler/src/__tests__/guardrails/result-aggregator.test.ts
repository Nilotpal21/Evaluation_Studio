import { describe, it, expect } from 'vitest';
import { aggregateResults, ACTION_PRECEDENCE } from '../../platform/guardrails/result-aggregator';
import type { GuardrailViolation } from '../../platform/guardrails/types';
import { addViolation, createEmptyPipelineResult } from '../../platform/guardrails/types';

function violation(overrides: Partial<GuardrailViolation>): GuardrailViolation {
  return {
    name: 'test',
    kind: 'input',
    tier: 'local',
    action: 'block',
    severity: 'high',
    message: 'test',
    priority: 1,
    latencyMs: 0,
    ...overrides,
  };
}

describe('Result aggregation', () => {
  it('should return passed=true for empty violations', () => {
    const result = aggregateResults([], 'original');
    expect(result.passed).toBe(true);
  });

  it('should prioritize escalate over block', () => {
    const result = aggregateResults(
      [
        violation({ name: 'blocker', action: 'block', priority: 1 }),
        violation({ name: 'escalator', action: 'escalate', priority: 2 }),
      ],
      'original',
    );
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('escalator');
  });

  it('should separate warnings from violations', () => {
    const result = aggregateResults(
      [
        violation({ name: 'warning1', action: 'warn', priority: 1 }),
        violation({ name: 'blocker', action: 'block', priority: 2 }),
      ],
      'original',
    );
    expect(result.passed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.violations).toHaveLength(1);
  });

  it('should return passed=true with only warn violations', () => {
    const result = aggregateResults([violation({ action: 'warn', priority: 1 })], 'original');
    expect(result.passed).toBe(true);
  });

  it('should apply redact before fix in priority order', () => {
    const result = aggregateResults(
      [
        violation({ name: 'fixer', action: 'fix', priority: 2 }),
        violation({ name: 'redactor', action: 'redact', priority: 1 }),
      ],
      'original',
    );
    // Both are non-terminal, so passed = true
    expect(result.passed).toBe(true);
    // Non-terminal violations are still tracked
    expect(result.violations).toHaveLength(2);
  });
});

describe('Primary violation selection consistency', () => {
  it('should select the same primary violation via addViolation and aggregateResults', () => {
    // block at priority 1 vs escalate at priority 5
    // Both paths should pick escalate (higher ACTION_PRECEDENCE), not block (lower priority number)
    const violations: GuardrailViolation[] = [
      violation({ name: 'g1', action: 'block', priority: 1 }),
      violation({ name: 'g2', action: 'escalate', priority: 5 }),
    ];

    // aggregateResults path
    const result1 = aggregateResults(violations, 'test');
    expect(result1.primaryViolation?.action).toBe('escalate');

    // addViolation path
    const result2 = createEmptyPipelineResult();
    for (const v of violations) addViolation(result2, v);
    expect(result2.primaryViolation?.action).toBe('escalate');
  });

  it('should use priority as tiebreaker when action precedence is equal', () => {
    const violations: GuardrailViolation[] = [
      violation({ name: 'g1', action: 'block', priority: 5 }),
      violation({ name: 'g2', action: 'block', priority: 1 }),
    ];

    const result = createEmptyPipelineResult();
    for (const v of violations) addViolation(result, v);
    expect(result.primaryViolation?.name).toBe('g2');
    expect(result.primaryViolation?.priority).toBe(1);
  });

  it('should pick escalate over reask via addViolation', () => {
    const violations: GuardrailViolation[] = [
      violation({ name: 'reask1', action: 'reask', priority: 1 }),
      violation({ name: 'esc1', action: 'escalate', priority: 2 }),
    ];

    const result = createEmptyPipelineResult();
    for (const v of violations) addViolation(result, v);
    expect(result.primaryViolation?.action).toBe('escalate');
  });
});

describe('ACTION_PRECEDENCE', () => {
  it('should rank escalate highest among terminal', () => {
    expect(ACTION_PRECEDENCE.escalate).toBeGreaterThan(ACTION_PRECEDENCE.block);
  });

  it('should rank terminal above non-terminal', () => {
    expect(ACTION_PRECEDENCE.block).toBeGreaterThan(ACTION_PRECEDENCE.redact);
  });
});
