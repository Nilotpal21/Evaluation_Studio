import { describe, it, expect } from 'vitest';
import { Tier1Evaluator } from '../../platform/guardrails/tier1-evaluator';
import type { Guardrail } from '../../platform/ir/schema';

function localGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('Tier1Evaluator', () => {
  const evaluator = new Tier1Evaluator();

  it('should pass when CEL check returns false (no violation)', async () => {
    const result = await evaluator.evaluate(
      [localGuardrail({ check: 'abl.length(input) > 1000' })],
      { input: 'short text' },
    );
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('should fail when CEL check returns true (violation)', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({
          name: 'too_long',
          check: 'abl.length(input) > 5',
          action: { type: 'block', message: 'Too long' },
        }),
      ],
      { input: 'This is a very long input string' },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('too_long');
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].tier).toBe('local');
  });

  it('should handle PII detection', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({
          name: 'pii',
          check: 'abl.contains_pii(input)',
          action: { type: 'redact' },
        }),
      ],
      { input: 'Email: john@example.com' },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('redact');
  });

  it('should evaluate multiple guardrails in parallel', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({ name: 'check1', check: 'false', action: { type: 'block' } }),
        localGuardrail({ name: 'check2', check: 'false', action: { type: 'warn' } }),
        localGuardrail({ name: 'check3', check: 'true', action: { type: 'warn' } }),
      ],
      { input: 'test' },
    );
    // check1 and check2 return false (no violation), check3 returns true (violation)
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('check3');
  });

  it('should sort results by priority', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({ name: 'low', priority: 10, check: 'true', action: { type: 'block' } }),
        localGuardrail({ name: 'high', priority: 1, check: 'true', action: { type: 'block' } }),
      ],
      { input: 'test' },
    );
    expect(result.primaryViolation?.name).toBe('high');
  });

  it('should handle CEL evaluation errors gracefully', async () => {
    const result = await evaluator.evaluate([localGuardrail({ check: 'nonexistent_function()' })], {
      input: 'test',
    });
    // CEL error → treat as pass (fail-open for local checks with bad expressions)
    expect(result.passed).toBe(true);
  });

  it('should track latency per check', async () => {
    const result = await evaluator.evaluate(
      [localGuardrail({ check: 'true', action: { type: 'warn' } })],
      { input: 'test' },
    );
    expect(result.warnings[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});
