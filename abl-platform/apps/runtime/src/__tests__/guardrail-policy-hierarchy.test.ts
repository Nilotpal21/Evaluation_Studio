/**
 * Policy scoping hierarchy tests — tenant → project → agent override.
 *
 * Validates the full GuardrailPolicyResolver resolution chain:
 *   1. Tenant-level policy applies when no project/agent override exists
 *   2. Project-level policy overrides tenant-level for that project
 *   3. Agent-level (DSL) guardrails are always included
 *   4. Agent-level `disable` override turns off a tenant-level guardrail
 *   5. Agent-level `threshold` override changes sensitivity
 *   6. Agent-level `action` override changes action type
 *   7. Multiple policies at same scope merge correctly
 *   8. Cross-tenant isolation: tenant A's policies don't affect tenant B
 */
import { describe, it, expect, vi } from 'vitest';
import type { Guardrail, PipelinePolicy } from '@abl/compiler';
import { GuardrailPolicyResolver } from '../services/guardrails/policy-resolver.js';
import type {
  PolicyData,
  PolicyInput,
  PolicyRule,
} from '../services/guardrails/policy-resolver.js';
import { resolveGuardrailPolicy } from '../services/guardrails/pipeline-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver = new GuardrailPolicyResolver();

function makeGuardrail(name: string, overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name,
    description: `DSL guardrail: ${name}`,
    kind: 'output',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

function makePolicy(
  name: string,
  rules: PolicyRule[],
  settingsOverride?: Partial<PolicyData['settings']>,
  providerOverrides?: PolicyData['providerOverrides'],
): PolicyData {
  return {
    name,
    rules,
    settings: {
      failMode: 'open',
      timeouts: { local: 10, model: 500, llm: 2000 },
      ...settingsOverride,
    },
    providerOverrides,
  };
}

function makeInput(
  tenantPolicies: PolicyData[],
  projectPolicies: PolicyData[],
  agentGuardrails: Guardrail[] = [],
): PolicyInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentDefId: 'agent-1',
    agentGuardrails,
    tenantPolicies,
    projectPolicies,
  };
}

// ===========================================================================
// 1. Tenant-level policy applies when no project/agent override exists
// ===========================================================================

describe('Tenant-level policy baseline', () => {
  it('tenant policy settings become the resolved settings', () => {
    const tenantPolicy = makePolicy('tenant-default', [], { failMode: 'closed' });
    const result = resolver.resolve(makeInput([tenantPolicy], []));

    expect(result.settings.failMode).toBe('closed');
  });

  it('tenant policy rules create overrides for DSL guardrails', () => {
    const tenantPolicy = makePolicy('tenant-rules', [
      {
        guardrailName: 'pii-check',
        override: 'threshold',
        threshold: 0.8,
      },
    ]);
    const result = resolver.resolve(makeInput([tenantPolicy], [], [makeGuardrail('pii-check')]));

    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].guardrailName).toBe('pii-check');
    expect(result.ruleOverrides[0].threshold).toBe(0.8);
  });

  it('tenant policy can define synthetic guardrails', () => {
    const tenantPolicy = makePolicy('tenant-synthetic', [
      {
        guardrailName: 'tenant-added-guard',
        override: 'define',
        kind: 'output',
        tier: 'local',
        check: 'abl.length(output) < 5000',
        message: 'Output too long',
      },
    ]);
    const result = resolver.resolve(makeInput([tenantPolicy], []));

    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].name).toBe('tenant-added-guard');
    expect(result.guardrails[0].check).toBe('abl.length(output) < 5000');
  });

  it('tenant policy providerOverrides are included', () => {
    const tenantPolicy = makePolicy('tenant-providers', [], {}, [
      { providerName: 'openai-moderation', defaultThreshold: 0.7 },
    ]);
    const result = resolver.resolve(makeInput([tenantPolicy], []));

    expect(result.providerOverrides).toHaveLength(1);
    expect(result.providerOverrides[0].providerName).toBe('openai-moderation');
    expect(result.providerOverrides[0].defaultThreshold).toBe(0.7);
  });
});

// ===========================================================================
// 2. Project-level policy overrides tenant-level
// ===========================================================================

describe('Project-level overrides tenant-level', () => {
  it('project failMode overrides tenant failMode', () => {
    const tenantPolicy = makePolicy('tenant-open', [], { failMode: 'open' });
    const projectPolicy = makePolicy('project-closed', [], { failMode: 'closed' });

    const result = resolver.resolve(makeInput([tenantPolicy], [projectPolicy]));
    expect(result.settings.failMode).toBe('closed');
  });

  it('project rule override replaces tenant rule for same guardrail', () => {
    const tenantPolicy = makePolicy('tenant-threshold', [
      { guardrailName: 'safety-check', override: 'threshold', threshold: 0.5 },
    ]);
    const projectPolicy = makePolicy('project-threshold', [
      { guardrailName: 'safety-check', override: 'threshold', threshold: 0.9 },
    ]);

    const result = resolver.resolve(
      makeInput([tenantPolicy], [projectPolicy], [makeGuardrail('safety-check')]),
    );

    // Project override should win
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].threshold).toBe(0.9);
  });

  it('project disable overrides tenant threshold for same guardrail', () => {
    const tenantPolicy = makePolicy('tenant-threshold', [
      { guardrailName: 'strict-check', override: 'threshold', threshold: 0.3 },
    ]);
    const projectPolicy = makePolicy('project-disable', [
      { guardrailName: 'strict-check', override: 'disable' },
    ]);

    const result = resolver.resolve(
      makeInput([tenantPolicy], [projectPolicy], [makeGuardrail('strict-check')]),
    );

    // Guardrail should be disabled (project overrides tenant)
    expect(result.disabledGuardrails).toContain('strict-check');
    // The threshold override from tenant is still in ruleOverrides
    // (disable takes precedence at pipeline execution time)
    expect(result.ruleOverrides).toHaveLength(1);
  });

  it('project synthetic guardrail replaces tenant synthetic with same name', () => {
    const tenantPolicy = makePolicy('tenant-define', [
      {
        guardrailName: 'custom-guard',
        override: 'define',
        kind: 'output',
        tier: 'local',
        check: 'abl.length(output) < 1000',
        message: 'Tenant limit',
      },
    ]);
    const projectPolicy = makePolicy('project-define', [
      {
        guardrailName: 'custom-guard',
        override: 'define',
        kind: 'output',
        tier: 'local',
        check: 'abl.length(output) < 500',
        message: 'Project limit (stricter)',
      },
    ]);

    const result = resolver.resolve(makeInput([tenantPolicy], [projectPolicy]));

    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].check).toBe('abl.length(output) < 500');
  });

  it('project providerOverrides append to tenant providerOverrides', () => {
    const tenantPolicy = makePolicy('tenant-providers', [], {}, [
      { providerName: 'api-a', defaultThreshold: 0.5 },
    ]);
    const projectPolicy = makePolicy('project-providers', [], {}, [
      { providerName: 'api-b', defaultThreshold: 0.3 },
    ]);

    const result = resolver.resolve(makeInput([tenantPolicy], [projectPolicy]));

    expect(result.providerOverrides).toHaveLength(2);
    expect(result.providerOverrides.map((o) => o.providerName)).toContain('api-a');
    expect(result.providerOverrides.map((o) => o.providerName)).toContain('api-b');
  });
});

// ===========================================================================
// 3. Agent-level (DSL) guardrails are always included
// ===========================================================================

describe('Agent DSL guardrails preservation', () => {
  it('DSL guardrails are always present in resolved output', () => {
    const dslGuardrails = [
      makeGuardrail('dsl-pii', { tier: 'model', provider: 'builtin-pii' }),
      makeGuardrail('dsl-toxicity', { tier: 'llm', llmCheck: 'Check for toxicity' }),
    ];

    const tenantPolicy = makePolicy('tenant-policy', []);
    const result = resolver.resolve(makeInput([tenantPolicy], [], dslGuardrails));

    expect(result.guardrails).toHaveLength(2);
    expect(result.guardrails.map((g) => g.name)).toContain('dsl-pii');
    expect(result.guardrails.map((g) => g.name)).toContain('dsl-toxicity');
  });

  it('policy define rule does NOT overwrite DSL guardrail with same name', () => {
    const dslGuardrails = [
      makeGuardrail('shared-name', { check: 'dsl_original_check()', kind: 'output' }),
    ];

    const tenantPolicy = makePolicy('tenant-override-attempt', [
      {
        guardrailName: 'shared-name',
        override: 'define',
        kind: 'input',
        check: 'policy_replacement_check()',
      },
    ]);

    const result = resolver.resolve(makeInput([tenantPolicy], [], dslGuardrails));

    // DSL guardrail should be preserved, policy define should be ignored
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].check).toBe('dsl_original_check()');
    expect(result.guardrails[0].kind).toBe('output');
  });
});

// ===========================================================================
// 4. Disable override turns off guardrails
// ===========================================================================

describe('Disable override', () => {
  it('tenant disable rule adds guardrail to disabled list', () => {
    const tenantPolicy = makePolicy('tenant-disable', [
      { guardrailName: 'noisy-guard', override: 'disable' },
    ]);

    const result = resolver.resolve(makeInput([tenantPolicy], [], [makeGuardrail('noisy-guard')]));
    expect(result.disabledGuardrails).toContain('noisy-guard');
  });

  it('project disable rule adds guardrail to disabled list', () => {
    const projectPolicy = makePolicy('project-disable', [
      { guardrailName: 'project-disabled-guard', override: 'disable' },
    ]);

    const result = resolver.resolve(
      makeInput([], [projectPolicy], [makeGuardrail('project-disabled-guard')]),
    );
    expect(result.disabledGuardrails).toContain('project-disabled-guard');
  });

  it('duplicate disable from both scopes produces single entry', () => {
    const tenantPolicy = makePolicy('tenant-disable', [
      { guardrailName: 'double-disabled', override: 'disable' },
    ]);
    const projectPolicy = makePolicy('project-disable', [
      { guardrailName: 'double-disabled', override: 'disable' },
    ]);

    const result = resolver.resolve(
      makeInput([tenantPolicy], [projectPolicy], [makeGuardrail('double-disabled')]),
    );

    const count = result.disabledGuardrails.filter((n) => n === 'double-disabled').length;
    expect(count).toBe(1);
  });
});

// ===========================================================================
// 5. Threshold override changes sensitivity
// ===========================================================================

describe('Threshold override', () => {
  it('threshold override is included in ruleOverrides', () => {
    const policy = makePolicy('threshold-policy', [
      { guardrailName: 'sensitivity-check', override: 'threshold', threshold: 0.9 },
    ]);

    const result = resolver.resolve(makeInput([policy], [], [makeGuardrail('sensitivity-check')]));

    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].override).toBe('threshold');
    expect(result.ruleOverrides[0].threshold).toBe(0.9);
  });

  it('project threshold overrides tenant threshold', () => {
    const tenantPolicy = makePolicy('tenant-threshold', [
      { guardrailName: 'sensitive-check', override: 'threshold', threshold: 0.3 },
    ]);
    const projectPolicy = makePolicy('project-threshold', [
      { guardrailName: 'sensitive-check', override: 'threshold', threshold: 0.7 },
    ]);

    const result = resolver.resolve(
      makeInput([tenantPolicy], [projectPolicy], [makeGuardrail('sensitive-check')]),
    );

    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].threshold).toBe(0.7);
  });
});

// ===========================================================================
// 6. Action override changes action type
// ===========================================================================

describe('Action override', () => {
  it('action override changes guardrail action in ruleOverrides', () => {
    const policy = makePolicy('action-policy', [
      {
        guardrailName: 'downgraded-check',
        override: 'action',
        action: { type: 'warn', message: 'Downgraded to warning' },
      },
    ]);

    const result = resolver.resolve(makeInput([policy], [], [makeGuardrail('downgraded-check')]));

    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].override).toBe('action');
    expect((result.ruleOverrides[0].action as any).type).toBe('warn');
  });

  it('severity_actions override is preserved in ruleOverrides', () => {
    const policy = makePolicy('severity-policy', [
      {
        guardrailName: 'severity-check',
        override: 'severity_actions',
        severityActions: {
          low: { type: 'warn', message: 'Low severity warning' },
          high: { type: 'block', message: 'High severity block' },
        },
      },
    ]);

    const result = resolver.resolve(makeInput([policy], [], [makeGuardrail('severity-check')]));

    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].override).toBe('severity_actions');
    expect(result.ruleOverrides[0].severityActions).toBeDefined();
    expect((result.ruleOverrides[0].severityActions as any).low.type).toBe('warn');
    expect((result.ruleOverrides[0].severityActions as any).high.type).toBe('block');
  });
});

// ===========================================================================
// 7. Multiple policies at same scope merge correctly
// ===========================================================================

describe('Multiple policies at same scope', () => {
  it('multiple tenant policies merge rules correctly', () => {
    const policy1 = makePolicy('tenant-a', [
      { guardrailName: 'guard-a', override: 'threshold', threshold: 0.5 },
    ]);
    const policy2 = makePolicy('tenant-b', [
      { guardrailName: 'guard-b', override: 'threshold', threshold: 0.7 },
    ]);

    const result = resolver.resolve(
      makeInput([policy1, policy2], [], [makeGuardrail('guard-a'), makeGuardrail('guard-b')]),
    );

    expect(result.ruleOverrides).toHaveLength(2);
    const guardA = result.ruleOverrides.find((r) => r.guardrailName === 'guard-a');
    const guardB = result.ruleOverrides.find((r) => r.guardrailName === 'guard-b');
    expect(guardA?.threshold).toBe(0.5);
    expect(guardB?.threshold).toBe(0.7);
  });

  it('later policy at same scope wins for same guardrail name', () => {
    const policy1 = makePolicy('tenant-first', [
      { guardrailName: 'contested', override: 'threshold', threshold: 0.3 },
    ]);
    const policy2 = makePolicy('tenant-second', [
      { guardrailName: 'contested', override: 'threshold', threshold: 0.9 },
    ]);

    const result = resolver.resolve(
      makeInput([policy1, policy2], [], [makeGuardrail('contested')]),
    );

    // Second policy should win (it processes after the first and replaces)
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].threshold).toBe(0.9);
  });

  it('settings from later policy at same scope override earlier', () => {
    const policy1 = makePolicy('tenant-open', [], { failMode: 'open' });
    const policy2 = makePolicy('tenant-closed', [], { failMode: 'closed' });

    const result = resolver.resolve(makeInput([policy1, policy2], []));
    expect(result.settings.failMode).toBe('closed');
  });

  it('multiple project policies merge rules', () => {
    const projectA = makePolicy('project-a', [
      { guardrailName: 'proj-guard-1', override: 'disable' },
    ]);
    const projectB = makePolicy('project-b', [
      { guardrailName: 'proj-guard-2', override: 'threshold', threshold: 0.6 },
    ]);

    const result = resolver.resolve(
      makeInput(
        [],
        [projectA, projectB],
        [makeGuardrail('proj-guard-1'), makeGuardrail('proj-guard-2')],
      ),
    );

    expect(result.disabledGuardrails).toContain('proj-guard-1');
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].guardrailName).toBe('proj-guard-2');
  });
});

// ===========================================================================
// 8. Cross-tenant isolation
// ===========================================================================

describe('Cross-tenant isolation', () => {
  it('resolver operates only on provided policies (no cross-tenant leakage)', () => {
    // Tenant A has a disable rule
    const tenantAPolicy = makePolicy('tenant-a-policy', [
      { guardrailName: 'shared-guard', override: 'disable' },
    ]);

    // Resolve for Tenant A
    const resultA = resolver.resolve({
      tenantId: 'tenant-a',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [makeGuardrail('shared-guard')],
      tenantPolicies: [tenantAPolicy],
      projectPolicies: [],
    });
    expect(resultA.disabledGuardrails).toContain('shared-guard');

    // Resolve for Tenant B (no policies)
    const resultB = resolver.resolve({
      tenantId: 'tenant-b',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [makeGuardrail('shared-guard')],
      tenantPolicies: [],
      projectPolicies: [],
    });
    // Tenant B should NOT see Tenant A's disable
    expect(resultB.disabledGuardrails).not.toContain('shared-guard');
    expect(resultB.disabledGuardrails).toHaveLength(0);
  });

  it('different tenants can have different settings for same guardrail name', () => {
    const tenantAPolicy = makePolicy('a-policy', [
      { guardrailName: 'common-guard', override: 'threshold', threshold: 0.3 },
    ]);
    const tenantBPolicy = makePolicy('b-policy', [
      { guardrailName: 'common-guard', override: 'threshold', threshold: 0.9 },
    ]);

    const resultA = resolver.resolve({
      tenantId: 'tenant-a',
      projectId: 'p',
      agentDefId: 'a',
      agentGuardrails: [makeGuardrail('common-guard')],
      tenantPolicies: [tenantAPolicy],
      projectPolicies: [],
    });

    const resultB = resolver.resolve({
      tenantId: 'tenant-b',
      projectId: 'p',
      agentDefId: 'a',
      agentGuardrails: [makeGuardrail('common-guard')],
      tenantPolicies: [tenantBPolicy],
      projectPolicies: [],
    });

    expect(resultA.ruleOverrides[0].threshold).toBe(0.3);
    expect(resultB.ruleOverrides[0].threshold).toBe(0.9);
  });

  it('tenant A synthetic guardrails do not appear in tenant B resolution', () => {
    const tenantAPolicy = makePolicy('a-synthetic', [
      {
        guardrailName: 'tenant-a-only',
        override: 'define',
        kind: 'output',
        tier: 'local',
        check: 'true',
      },
    ]);

    const resultA = resolver.resolve({
      tenantId: 'tenant-a',
      projectId: 'p',
      agentDefId: 'a',
      agentGuardrails: [],
      tenantPolicies: [tenantAPolicy],
      projectPolicies: [],
    });

    const resultB = resolver.resolve({
      tenantId: 'tenant-b',
      projectId: 'p',
      agentDefId: 'a',
      agentGuardrails: [],
      tenantPolicies: [],
      projectPolicies: [],
    });

    expect(resultA.guardrails.map((g) => g.name)).toContain('tenant-a-only');
    expect(resultB.guardrails.map((g) => g.name)).not.toContain('tenant-a-only');
  });
});

// ===========================================================================
// 9. resolveGuardrailPolicy integration (pipeline-factory function)
// ===========================================================================

describe('resolveGuardrailPolicy integration', () => {
  it('returns PipelinePolicy with correct shape from loader', async () => {
    const loader = vi.fn().mockResolvedValue({
      tenantPolicies: [
        makePolicy(
          'tenant-policy',
          [
            { guardrailName: 'dsl-guard', override: 'threshold', threshold: 0.8 },
            { guardrailName: 'extra-guard', override: 'disable' },
          ],
          { failMode: 'closed' },
        ),
      ],
      projectPolicies: [],
    });

    const dslGuardrails = [makeGuardrail('dsl-guard')];
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      dslGuardrails,
      loader,
    );

    expect(result).toBeDefined();
    expect(result!.policy.settings?.failMode).toBe('closed');
    expect(result!.policy.disabledGuardrails).toContain('extra-guard');
    expect(result!.policy.ruleOverrides).toHaveLength(1);
    expect(result!.policy.ruleOverrides![0].guardrailName).toBe('dsl-guard');
    expect(result!.policy.ruleOverrides![0].threshold).toBe(0.8);
  });

  it('returns undefined when no policies exist', async () => {
    const loader = vi.fn().mockResolvedValue({
      tenantPolicies: [],
      projectPolicies: [],
    });

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail('any-guard')],
      loader,
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined when loader throws (fail-gracefully)', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('Database connection failed'));

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail('any-guard')],
      loader,
    );

    expect(result).toBeUndefined();
  });

  it('additionalGuardrails includes policy-defined guardrails not in DSL', async () => {
    const loader = vi.fn().mockResolvedValue({
      tenantPolicies: [
        makePolicy('tenant-define', [
          {
            guardrailName: 'policy-added-guard',
            override: 'define',
            kind: 'output',
            tier: 'local',
            check: 'abl.length(output) < 2000',
            message: 'Too long',
          },
        ]),
      ],
      projectPolicies: [],
    });

    const dslGuardrails = [makeGuardrail('dsl-guard')];
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      dslGuardrails,
      loader,
    );

    expect(result).toBeDefined();
    expect(result!.policy.additionalGuardrails).toBeDefined();
    expect(result!.policy.additionalGuardrails).toHaveLength(1);
    expect(result!.policy.additionalGuardrails![0].name).toBe('policy-added-guard');
  });
});
