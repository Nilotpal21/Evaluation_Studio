/**
 * Slice 3 lock test — Bruce feedback 5.4 (action applier leg)
 *
 * When a Tier-N evaluator resolves a severity-specific action (e.g.
 * `severityActions.high: { type: 'redact', redactMode: 'pattern' }`), the
 * action applier must execute that resolved action's payload — not the
 * default action's payload from `actionContexts`.
 *
 * Today (baseline): `actionContexts` in pipeline.ts:275 is built from the
 * DEFAULT `guardrail.action`, and `action-applier.ts:51` fetches it by
 * guardrail name. That means if a violation carries
 * `action: 'redact'` but the guardrail's default is `action: { type: 'block' }`,
 * the applier sees `block` in actionContexts and silently no-ops
 * (redact is in CONTENT_MODIFYING_ACTIONS, block is not).
 *
 * After fix: applier must source the full resolved `GuardrailAction` object
 * from the violation itself, so the correct redact/fix/filter payload
 * (mode, pattern, strategy) is applied.
 */
import { describe, it, expect } from 'vitest';
import { applyActions } from '../../platform/guardrails/action-applier';
import type { GuardrailPipelineResult, GuardrailViolation } from '../../platform/guardrails/types';
import type { GuardrailAction } from '../../platform/ir/schema';

function baseResult(violation: GuardrailViolation): GuardrailPipelineResult {
  return {
    passed: false,
    violations: [violation],
    warnings: [],
    metrics: {
      totalChecks: 1,
      passed: 0,
      failed: 1,
      warnings: 0,
      totalLatencyMs: 0,
      tier1LatencyMs: 0,
      tier2LatencyMs: 0,
      tier3LatencyMs: 0,
      compoundFPREstimate: 0,
      costUsd: 0,
      cacheHits: 0,
      cacheMisses: 0,
      policyVersion: 0,
    },
  };
}

describe('action-applier uses resolved action from violation (Slice 3 / Bruce 5.4)', () => {
  it('redacts using violation resolvedAction when default action is block', () => {
    const violation: GuardrailViolation = {
      name: 'pii_check',
      kind: 'input',
      tier: 'local',
      action: 'redact',
      severity: 'high',
      message: 'redact pii',
      priority: 1,
      latencyMs: 0,
      // After fix: violation must carry the full resolved action payload
      resolvedAction: { type: 'redact', redactMode: 'pattern', redactPattern: '\\d+' },
    } as GuardrailViolation;

    const result = baseResult(violation);
    // actionContexts still carries the DEFAULT action — this simulates the
    // live bug: severity-resolved action is different from default.
    const actionContexts = new Map<string, GuardrailAction>([['pii_check', { type: 'block' }]]);

    applyActions(result, 'Call me at 4155551234', actionContexts);

    // The resolved action (redact) must have been applied — digits stripped
    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent).not.toContain('4155551234');
  });

  it('falls through to actionContexts when violation has no resolvedAction (backward compat)', () => {
    const violation: GuardrailViolation = {
      name: 'pii_check',
      kind: 'input',
      tier: 'local',
      action: 'redact',
      severity: 'high',
      message: 'redact pii',
      priority: 1,
      latencyMs: 0,
    };

    const result = baseResult(violation);
    const actionContexts = new Map<string, GuardrailAction>([
      ['pii_check', { type: 'redact', redactMode: 'pattern', redactPattern: '\\d+' }],
    ]);

    applyActions(result, 'Call me at 4155551234', actionContexts);

    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent).not.toContain('4155551234');
  });

  it('executes fix via resolved action even when default action is warn', () => {
    const violation: GuardrailViolation = {
      name: 'length_check',
      kind: 'output',
      tier: 'local',
      action: 'fix',
      severity: 'high',
      message: 'too long',
      priority: 1,
      latencyMs: 0,
      resolvedAction: { type: 'fix', fixStrategy: 'truncate', maxLength: 5 },
    } as GuardrailViolation;

    const result = baseResult(violation);
    // Default action is warn — non-content-modifying; the bug today is that
    // actionContexts would contain warn and the applier would bail.
    const actionContexts = new Map<string, GuardrailAction>([['length_check', { type: 'warn' }]]);

    applyActions(result, 'this is way too long', actionContexts);

    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent!.length).toBeLessThanOrEqual(5);
  });
});
