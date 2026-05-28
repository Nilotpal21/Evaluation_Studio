/**
 * Slice 3 lock test — Bruce feedback 5.4
 *
 * Tier 1 (local CEL) guardrails must resolve their violation action via the
 * shared severity resolver, honoring `severityActions.high` when defined,
 * just like Tier 2 and Tier 3 do.
 *
 * Today (baseline): Tier 1 hardcodes `action: guardrail.action.type` at
 * tier1-evaluator.ts:59 — severityActions overrides are silently ignored.
 * After fix: Tier 1 must call the shared resolver and emit the resolved
 * action on the violation.
 */
import { describe, it, expect } from 'vitest';
import { Tier1Evaluator } from '../../platform/guardrails/tier1-evaluator';
import type { Guardrail } from '../../platform/ir/schema';

function tier1Guardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test_check',
    description: 'test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('Tier 1 severity resolution (Slice 3 / Bruce 5.4)', () => {
  it('emits severity-resolved action when severityActions.high is defined', async () => {
    const evaluator = new Tier1Evaluator();
    const guardrail = tier1Guardrail({
      name: 'with_severity_override',
      check: 'true',
      action: { type: 'block', message: 'default block' },
      severityActions: {
        high: { type: 'redact', redactMode: 'pii' },
      },
    });

    const result = await evaluator.evaluate([guardrail], { input: 'hello' });

    expect(result.violations).toHaveLength(1);
    // Severity-specific action must win over default 'block'
    expect(result.violations[0].action).toBe('redact');
    expect(result.violations[0].severity).toBe('high');
  });

  it('falls back to default action when severityActions is absent', async () => {
    const evaluator = new Tier1Evaluator();
    const guardrail = tier1Guardrail({
      name: 'no_severity_override',
      check: 'true',
      action: { type: 'warn' },
    });

    const result = await evaluator.evaluate([guardrail], { input: 'hello' });

    // Warnings go to warnings array not violations
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].action).toBe('warn');
  });

  it('falls back to default when severityActions has other levels but not high', async () => {
    const evaluator = new Tier1Evaluator();
    const guardrail = tier1Guardrail({
      name: 'partial_severity_override',
      check: 'true',
      action: { type: 'block' },
      severityActions: {
        critical: { type: 'escalate' },
        // high: not defined — Tier 1 treats as 'high', so falls back to default block
      },
    });

    const result = await evaluator.evaluate([guardrail], { input: 'hello' });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].severity).toBe('high');
  });

  it('honors severityActions.high with redact mode payload', async () => {
    const evaluator = new Tier1Evaluator();
    const guardrail = tier1Guardrail({
      name: 'redact_high',
      check: 'true',
      action: { type: 'block' },
      severityActions: {
        high: { type: 'redact', redactMode: 'pattern', redactPattern: '\\d+' },
      },
    });

    const result = await evaluator.evaluate([guardrail], { input: 'hello' });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('redact');
  });
});
