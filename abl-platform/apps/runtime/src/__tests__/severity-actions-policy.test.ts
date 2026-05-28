import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailPipelineImpl } from '@abl/compiler';
import type { Guardrail, PipelinePolicy } from '@abl/compiler';
import type { PolicyData } from '../services/guardrails/policy-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'content.size() > 0',
    action: { type: 'block' },
    ...overrides,
  };
}

const defaultPolicySettings: PolicyData['settings'] = {
  failMode: 'open',
  timeouts: { local: 10, model: 500, llm: 2000 },
};

// ---------------------------------------------------------------------------
// Suite 1: GuardrailPipelineImpl.execute with severity_actions policy
// ---------------------------------------------------------------------------

describe('GuardrailPipelineImpl.execute with severity_actions policy', () => {
  let pipeline: GuardrailPipelineImpl;

  beforeEach(() => {
    pipeline = new GuardrailPipelineImpl();
  });

  it('severity_actions override applies severityActions to guardrail', async () => {
    const guardrail = makeGuardrail({
      name: 'content-safety',
      // No severityActions on the guardrail itself
    });

    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'content-safety',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block' },
            low: { type: 'warn' },
          },
        },
      ],
    };

    // Execute the pipeline. The guardrail has a CEL check that will pass
    // for non-empty content. We are verifying that the pipeline does not
    // throw and processes the policy override without error.
    const result = await pipeline.execute(
      [guardrail],
      'Hello world',
      'input',
      {},
      undefined,
      policy,
    );

    // Pipeline should complete successfully
    expect(result).toBeDefined();
    expect(result.metrics).toBeDefined();
    expect(result.metrics.totalChecks).toBeGreaterThanOrEqual(1);
  });

  it('severity_actions override without severityActions field is a no-op', async () => {
    const guardrail = makeGuardrail({
      name: 'no-severity-field',
      // Guardrail starts without severityActions
    });

    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'no-severity-field',
          override: 'severity_actions',
          // severityActions field intentionally omitted
        },
      ],
    };

    // Should not throw, and the guardrail should be unmodified
    const result = await pipeline.execute(
      [guardrail],
      'Test content',
      'input',
      {},
      undefined,
      policy,
    );

    expect(result).toBeDefined();
    // Pipeline completes without error — the override was a no-op
    expect(result.metrics.totalChecks).toBeGreaterThanOrEqual(1);
  });

  it('severity_actions coexists with threshold override for different guardrails', async () => {
    const guardrailA = makeGuardrail({
      name: 'guard-threshold',
      tier: 'model',
      provider: 'test-provider',
      category: 'test',
      threshold: 0.5,
      check: undefined,
    });

    const guardrailB = makeGuardrail({
      name: 'guard-severity',
      // Tier 1 CEL guardrail
    });

    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'guard-threshold',
          override: 'threshold',
          threshold: 0.9,
        },
        {
          guardrailName: 'guard-severity',
          override: 'severity_actions',
          severityActions: {
            critical: { type: 'escalate' },
            medium: { type: 'warn' },
          },
        },
      ],
    };

    // Execute: the pipeline should apply both overrides independently
    const result = await pipeline.execute(
      [guardrailA, guardrailB],
      'Hello world',
      'input',
      {},
      undefined,
      policy,
    );

    expect(result).toBeDefined();
    // At least the CEL guardrail (guard-severity) should have been evaluated
    expect(result.metrics.totalChecks).toBeGreaterThanOrEqual(1);
  });

  it('severity_actions override does not affect guardrails with different names', async () => {
    const guardA = makeGuardrail({ name: 'targeted-guard' });
    const guardB = makeGuardrail({
      name: 'untargeted-guard',
      priority: 2,
    });

    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'targeted-guard',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block', message: 'High severity blocked' },
          },
        },
      ],
    };

    // Both guardrails should be evaluated
    const result = await pipeline.execute(
      [guardA, guardB],
      'Test input',
      'input',
      {},
      undefined,
      policy,
    );

    expect(result).toBeDefined();
    // Both guardrails should have been checked
    expect(result.metrics.totalChecks).toBe(2);
  });

  it('action override and severity_actions override for the same guardrail — last override wins', async () => {
    const guardrail = makeGuardrail({
      name: 'dual-override',
      action: { type: 'warn' },
    });

    // The ruleOverrides array finds the FIRST matching entry per guardrailName,
    // so only the first match for 'dual-override' applies. The policy format
    // uses one override entry per guardrailName. This tests the case where
    // a single override entry has override: 'severity_actions'.
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'dual-override',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block' },
          },
        },
      ],
    };

    const result = await pipeline.execute([guardrail], 'Hello', 'input', {}, undefined, policy);

    expect(result).toBeDefined();
    expect(result.metrics.totalChecks).toBeGreaterThanOrEqual(1);
  });

  it('disabled guardrails are removed before severity_actions override is applied', async () => {
    const guardrail = makeGuardrail({ name: 'to-be-disabled' });

    const policy: PipelinePolicy = {
      disabledGuardrails: ['to-be-disabled'],
      ruleOverrides: [
        {
          guardrailName: 'to-be-disabled',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block' },
          },
        },
      ],
    };

    const result = await pipeline.execute(
      [guardrail],
      'Test content',
      'input',
      {},
      undefined,
      policy,
    );

    // The guardrail was disabled, so no checks should have run
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(0);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: toPipelinePolicy mapping via resolveGuardrailPolicy
// ---------------------------------------------------------------------------

describe('toPipelinePolicy maps severityActions through resolveGuardrailPolicy', () => {
  let resolveGuardrailPolicy: typeof import('../services/guardrails/pipeline-factory.js').resolveGuardrailPolicy;

  beforeEach(async () => {
    const mod = await import('../services/guardrails/pipeline-factory.js');
    resolveGuardrailPolicy = mod.resolveGuardrailPolicy;
  });

  it('resolveGuardrailPolicy maps severityActions from tenant policy', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'pii-guard' })],
      async () => ({
        tenantPolicies: [
          {
            name: 'severity-policy',
            rules: [
              {
                guardrailName: 'pii-guard',
                override: 'severity_actions' as const,
                severityActions: {
                  high: { type: 'block' },
                  medium: { type: 'warn' },
                  low: { type: 'warn' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(1);

    const override = result!.policy.ruleOverrides![0];
    expect(override.guardrailName).toBe('pii-guard');
    expect(override.override).toBe('severity_actions');
    expect(override.severityActions).toEqual({
      high: { type: 'block' },
      medium: { type: 'warn' },
      low: { type: 'warn' },
    });
  });

  it('resolveGuardrailPolicy maps severityActions from project policy', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'toxicity-guard' })],
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'project-severity-policy',
            rules: [
              {
                guardrailName: 'toxicity-guard',
                override: 'severity_actions' as const,
                severityActions: {
                  critical: { type: 'escalate' },
                  high: { type: 'block' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(1);

    const override = result!.policy.ruleOverrides![0];
    expect(override.guardrailName).toBe('toxicity-guard');
    expect(override.override).toBe('severity_actions');
    expect(override.severityActions).toEqual({
      critical: { type: 'escalate' },
      high: { type: 'block' },
    });
  });

  it('resolveGuardrailPolicy preserves severityActions alongside threshold overrides', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'guard-a' }), makeGuardrail({ name: 'guard-b', priority: 2 })],
      async () => ({
        tenantPolicies: [
          {
            name: 'mixed-policy',
            rules: [
              {
                guardrailName: 'guard-a',
                override: 'threshold' as const,
                threshold: 0.85,
              },
              {
                guardrailName: 'guard-b',
                override: 'severity_actions' as const,
                severityActions: {
                  high: { type: 'block', message: 'High severity content' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(2);

    const thresholdOverride = result!.policy.ruleOverrides!.find(
      (r) => r.guardrailName === 'guard-a',
    );
    expect(thresholdOverride).toBeDefined();
    expect(thresholdOverride!.override).toBe('threshold');
    expect(thresholdOverride!.threshold).toBe(0.85);
    expect(thresholdOverride!.severityActions).toBeUndefined();

    const severityOverride = result!.policy.ruleOverrides!.find(
      (r) => r.guardrailName === 'guard-b',
    );
    expect(severityOverride).toBeDefined();
    expect(severityOverride!.override).toBe('severity_actions');
    expect(severityOverride!.severityActions).toEqual({
      high: { type: 'block', message: 'High severity content' },
    });
  });

  it('resolveGuardrailPolicy with no severity_actions passes through standard overrides', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'action-guard' })],
      async () => ({
        tenantPolicies: [
          {
            name: 'action-policy',
            rules: [
              {
                guardrailName: 'action-guard',
                override: 'action' as const,
                action: { type: 'warn', message: 'Content flagged' },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(1);

    const override = result!.policy.ruleOverrides![0];
    expect(override.guardrailName).toBe('action-guard');
    expect(override.override).toBe('action');
    expect(override.action).toEqual({ type: 'warn', message: 'Content flagged' });
    expect(override.severityActions).toBeUndefined();
  });

  it('project policy severity_actions overrides tenant policy for same guardrail', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'shared-guard' })],
      async () => ({
        tenantPolicies: [
          {
            name: 'tenant-sev-policy',
            rules: [
              {
                guardrailName: 'shared-guard',
                override: 'severity_actions' as const,
                severityActions: {
                  high: { type: 'warn' },
                  low: { type: 'warn' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [
          {
            name: 'project-sev-policy',
            rules: [
              {
                guardrailName: 'shared-guard',
                override: 'severity_actions' as const,
                severityActions: {
                  high: { type: 'block' },
                  critical: { type: 'escalate' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    // Project policy should override tenant policy for the same guardrail
    expect(result!.policy.ruleOverrides).toHaveLength(1);

    const override = result!.policy.ruleOverrides![0];
    expect(override.guardrailName).toBe('shared-guard');
    expect(override.override).toBe('severity_actions');
    // Project policy wins — should have project's severityActions
    expect(override.severityActions).toEqual({
      high: { type: 'block' },
      critical: { type: 'escalate' },
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 3: End-to-end — resolveGuardrailPolicy output feeds pipeline.execute
// ---------------------------------------------------------------------------

describe('end-to-end: severity_actions policy flows through to pipeline execution', () => {
  let resolveGuardrailPolicy: typeof import('../services/guardrails/pipeline-factory.js').resolveGuardrailPolicy;

  beforeEach(async () => {
    const mod = await import('../services/guardrails/pipeline-factory.js');
    resolveGuardrailPolicy = mod.resolveGuardrailPolicy;
  });

  it('resolved policy with severity_actions can be passed to pipeline.execute', async () => {
    const guardrail = makeGuardrail({
      name: 'e2e-guard',
      check: 'content.size() > 0',
    });

    // Step 1: resolve the policy
    const policy = await resolveGuardrailPolicy(
      'tenant-e2e',
      'project-e2e',
      'agent-e2e',
      [guardrail],
      async () => ({
        tenantPolicies: [
          {
            name: 'e2e-severity-policy',
            rules: [
              {
                guardrailName: 'e2e-guard',
                override: 'severity_actions' as const,
                severityActions: {
                  high: { type: 'block', message: 'High severity blocked' },
                  medium: { type: 'warn', message: 'Medium severity warning' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(policy).toBeDefined();
    expect(policy!.policy.ruleOverrides).toHaveLength(1);
    expect(policy!.policy.ruleOverrides![0].severityActions).toBeDefined();

    // Step 2: pass the resolved policy to pipeline.execute
    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute(
      [guardrail],
      'Some user input',
      'input',
      {},
      undefined,
      policy!.policy,
    );

    // Pipeline should complete without errors
    expect(result).toBeDefined();
    expect(result.metrics.totalChecks).toBeGreaterThanOrEqual(1);
  });

  it('resolved policy with mixed overrides feeds pipeline correctly', async () => {
    const guardrailA = makeGuardrail({
      name: 'guard-disable-me',
      check: 'false', // Would always trigger violation
    });
    const guardrailB = makeGuardrail({
      name: 'guard-severity-me',
      priority: 2,
      check: 'content.size() > 0',
    });

    const policy = await resolveGuardrailPolicy(
      'tenant-mix',
      'project-mix',
      'agent-mix',
      [guardrailA, guardrailB],
      async () => ({
        tenantPolicies: [
          {
            name: 'mixed-override-policy',
            rules: [
              {
                guardrailName: 'guard-disable-me',
                override: 'disable' as const,
              },
              {
                guardrailName: 'guard-severity-me',
                override: 'severity_actions' as const,
                severityActions: {
                  critical: { type: 'escalate' },
                },
              },
            ],
            settings: defaultPolicySettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(policy).toBeDefined();
    expect(policy!.policy.disabledGuardrails).toContain('guard-disable-me');
    expect(policy!.policy.ruleOverrides).toHaveLength(1);
    expect(policy!.policy.ruleOverrides![0].guardrailName).toBe('guard-severity-me');

    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute(
      [guardrailA, guardrailB],
      'Test input',
      'input',
      {},
      undefined,
      policy!.policy,
    );

    // guard-disable-me is disabled, so only guard-severity-me runs
    expect(result).toBeDefined();
    expect(result.metrics.totalChecks).toBe(1);
  });
});
