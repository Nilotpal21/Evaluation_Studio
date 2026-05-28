/**
 * Slice 3 lock test — Bruce feedback 5.4 (supporting)
 *
 * A shared `resolveAction(guardrail, severity)` helper must exist in
 * `platform/guardrails/severity-resolver.ts` and be used by Tier 1, 2, 3
 * evaluators identically.
 *
 * Today (baseline): Tier 2 and Tier 3 have duplicate private resolveAction
 * methods; Tier 1 has no resolver at all.
 * After fix: a single shared helper returns the same GuardrailAction for
 * the same (guardrail, severity) pair across all tiers.
 */
import { describe, it, expect } from 'vitest';
import type { Guardrail, SeverityLevel, GuardrailAction } from '../../platform/ir/schema';

describe('severity-resolver shared helper (Slice 3 / Bruce 5.4)', () => {
  it('exports a resolveAction function from the shared module', async () => {
    const mod = await import('../../platform/guardrails/severity-resolver.js');
    expect(typeof mod.resolveAction).toBe('function');
  });

  it('returns severity-specific action when defined', async () => {
    const { resolveAction } = await import('../../platform/guardrails/severity-resolver.js');
    const guardrail: Guardrail = {
      name: 'test',
      description: 'test',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'block' },
      severityActions: {
        high: { type: 'redact', redactMode: 'pii' },
        critical: { type: 'escalate' },
      },
    };

    const resolved: GuardrailAction = resolveAction(guardrail, 'high' as SeverityLevel);
    expect(resolved.type).toBe('redact');
    expect(resolved.redactMode).toBe('pii');
  });

  it('returns default action when severity is safe', async () => {
    const { resolveAction } = await import('../../platform/guardrails/severity-resolver.js');
    const guardrail: Guardrail = {
      name: 'test',
      description: 'test',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'warn' },
      severityActions: {
        high: { type: 'block' },
      },
    };

    const resolved = resolveAction(guardrail, 'safe' as SeverityLevel);
    expect(resolved.type).toBe('warn');
  });

  it('returns default action when severity-specific is not defined', async () => {
    const { resolveAction } = await import('../../platform/guardrails/severity-resolver.js');
    const guardrail: Guardrail = {
      name: 'test',
      description: 'test',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'block' },
      severityActions: {
        critical: { type: 'escalate' },
      },
    };

    const resolved = resolveAction(guardrail, 'medium' as SeverityLevel);
    expect(resolved.type).toBe('block');
  });

  it('returns default action when severityActions is undefined', async () => {
    const { resolveAction } = await import('../../platform/guardrails/severity-resolver.js');
    const guardrail: Guardrail = {
      name: 'test',
      description: 'test',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'fix', fixStrategy: 'truncate' },
    };

    const resolved = resolveAction(guardrail, 'high' as SeverityLevel);
    expect(resolved.type).toBe('fix');
    expect(resolved.fixStrategy).toBe('truncate');
  });

  it('same input produces identical output regardless of caller tier', async () => {
    const { resolveAction } = await import('../../platform/guardrails/severity-resolver.js');
    const guardrail: Guardrail = {
      name: 'parity',
      description: 'test',
      kind: 'output',
      priority: 1,
      tier: 'model',
      action: { type: 'block' },
      severityActions: {
        high: { type: 'redact', redactMode: 'pii' },
        medium: { type: 'warn' },
      },
    };

    const callA = resolveAction(guardrail, 'high' as SeverityLevel);
    const callB = resolveAction(guardrail, 'high' as SeverityLevel);
    const callC = resolveAction(guardrail, 'medium' as SeverityLevel);

    expect(callA).toEqual(callB);
    expect(callA.type).toBe('redact');
    expect(callC.type).toBe('warn');
  });
});
