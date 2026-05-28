/**
 * Policy Scoping Hierarchy Tests
 *
 * Tests the GuardrailPolicyResolver's resolution chain:
 *   1. Platform defaults (base)
 *   2. Tenant-scoped policies (override defaults)
 *   3. Project-scoped policies (override tenant)
 *   4. Agent DSL guardrails (always included as-is, never overwritten by policy)
 *
 * Verifies: disable overrides, threshold overrides, action overrides,
 * policy merging, cross-tenant isolation, and define-mode guardrails.
 */
import { describe, it, expect } from 'vitest';
import {
  GuardrailPolicyResolver,
  type PolicyData,
  type PolicyInput,
  type PolicyRule,
} from '../policy-resolver.js';
import type { Guardrail } from '@abl/compiler';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test-guard',
    description: 'Test guardrail',
    kind: 'input',
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
  settings?: Partial<PolicyData['settings']>,
): PolicyData {
  return {
    name,
    rules,
    settings: {
      failMode: 'open',
      ...settings,
    },
  };
}

function makeInput(overrides: Partial<PolicyInput>): PolicyInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentDefId: 'agent-1',
    agentGuardrails: [],
    tenantPolicies: [],
    projectPolicies: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GuardrailPolicyResolver', () => {
  const resolver = new GuardrailPolicyResolver();

  // ─── 1. Tenant-level policy applies when no project/agent override ────

  describe('tenant-level policy applies when no overrides', () => {
    it('should include tenant-defined guardrails', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('tenant-safety', [
            {
              guardrailName: 'tenant-pii-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'builtin-pii',
              category: 'pii',
              threshold: 0.5,
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(1);
      expect(result.guardrails[0].name).toBe('tenant-pii-check');
      expect(result.guardrails[0].kind).toBe('input');
      expect(result.guardrails[0].provider).toBe('builtin-pii');
    });

    it('should apply tenant settings (failMode)', () => {
      const input = makeInput({
        tenantPolicies: [makePolicy('tenant-config', [], { failMode: 'closed' })],
      });

      const result = resolver.resolve(input);

      expect(result.settings.failMode).toBe('closed');
    });

    it('should apply tenant provider overrides', () => {
      const input = makeInput({
        tenantPolicies: [
          {
            name: 'tenant-providers',
            rules: [],
            settings: { failMode: 'open' },
            providerOverrides: [
              {
                providerName: 'custom-safety',
                endpoint: 'https://tenant-safety.example.com',
                circuitBreaker: { failureThreshold: 5 },
              },
            ],
          },
        ],
      });

      const result = resolver.resolve(input);

      expect(result.providerOverrides).toHaveLength(1);
      expect(result.providerOverrides[0].providerName).toBe('custom-safety');
      expect(result.providerOverrides[0].endpoint).toBe('https://tenant-safety.example.com');
    });
  });

  // ─── 2. Project-level overrides tenant-level ──────────────────────────

  describe('project-level overrides tenant-level', () => {
    it('should override tenant settings with project settings', () => {
      const input = makeInput({
        tenantPolicies: [makePolicy('tenant-config', [], { failMode: 'open' })],
        projectPolicies: [makePolicy('project-config', [], { failMode: 'closed' })],
      });

      const result = resolver.resolve(input);

      expect(result.settings.failMode).toBe('closed');
    });

    it('should override tenant-defined guardrail with project-level define', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('tenant-safety', [
            {
              guardrailName: 'safety-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'builtin-pii',
              threshold: 0.3,
            },
          ]),
        ],
        projectPolicies: [
          makePolicy('project-safety', [
            {
              guardrailName: 'safety-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'custom-safety',
              threshold: 0.7,
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      // Project define should replace tenant define
      const guard = result.guardrails.find((g) => g.name === 'safety-check');
      expect(guard).toBeDefined();
      expect(guard!.provider).toBe('custom-safety');
      expect(guard!.threshold).toBe(0.7);
    });

    it('should override tenant rule overrides with project rule overrides', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'pii-check' })],
        tenantPolicies: [
          makePolicy('tenant-rules', [
            {
              guardrailName: 'pii-check',
              override: 'threshold',
              threshold: 0.3,
            },
          ]),
        ],
        projectPolicies: [
          makePolicy('project-rules', [
            {
              guardrailName: 'pii-check',
              override: 'threshold',
              threshold: 0.8,
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      // Project override should replace tenant override
      const override = result.ruleOverrides.find((r) => r.guardrailName === 'pii-check');
      expect(override).toBeDefined();
      expect(override!.threshold).toBe(0.8);
    });
  });

  // ─── 3. Agent DSL guardrails always included ──────────────────────────

  describe('agent DSL guardrails are always included', () => {
    it('should include DSL guardrails alongside policy-defined ones', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'dsl-check', check: 'abl.length(input) > 5' })],
        tenantPolicies: [
          makePolicy('tenant-safety', [
            {
              guardrailName: 'tenant-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'builtin-pii',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(2);
      expect(result.guardrails.map((g) => g.name)).toContain('dsl-check');
      expect(result.guardrails.map((g) => g.name)).toContain('tenant-check');
    });

    it('should never overwrite DSL guardrails with policy define', () => {
      const input = makeInput({
        agentGuardrails: [
          makeGuardrail({
            name: 'shared-check',
            check: 'abl.length(input) > 5',
            tier: 'local',
          }),
        ],
        tenantPolicies: [
          makePolicy('tenant-safety', [
            {
              guardrailName: 'shared-check',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'openai-moderation',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      // DSL guardrail should NOT be overwritten
      const guard = result.guardrails.find((g) => g.name === 'shared-check');
      expect(guard).toBeDefined();
      expect(guard!.tier).toBe('local'); // Original DSL value preserved
      expect(guard!.check).toBe('abl.length(input) > 5');
      expect(result.guardrails).toHaveLength(1); // No duplicate
    });
  });

  // ─── 4. Disable override turns off a guardrail ────────────────────────

  describe('disable override', () => {
    it('should disable a tenant-defined guardrail', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('tenant-safety', [
            {
              guardrailName: 'strict-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'builtin-pii',
            },
          ]),
        ],
        projectPolicies: [
          makePolicy('project-override', [{ guardrailName: 'strict-check', override: 'disable' }]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.disabledGuardrails).toContain('strict-check');
    });

    it('should disable a DSL-defined guardrail via policy', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'dsl-pii-check' })],
        tenantPolicies: [
          makePolicy('tenant-override', [{ guardrailName: 'dsl-pii-check', override: 'disable' }]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.disabledGuardrails).toContain('dsl-pii-check');
      // DSL guardrail is still in the list (it's disabled at pipeline evaluation time)
      expect(result.guardrails.map((g) => g.name)).toContain('dsl-pii-check');
    });

    it('should not duplicate disable entries', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('tenant-disable', [{ guardrailName: 'some-check', override: 'disable' }]),
        ],
        projectPolicies: [
          makePolicy('project-disable', [{ guardrailName: 'some-check', override: 'disable' }]),
        ],
      });

      const result = resolver.resolve(input);

      const disableCount = result.disabledGuardrails.filter((n) => n === 'some-check').length;
      expect(disableCount).toBe(1);
    });
  });

  // ─── 5. Threshold override changes sensitivity ────────────────────────

  describe('threshold override', () => {
    it('should apply threshold override from tenant policy', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'toxicity-check', threshold: 0.5 })],
        tenantPolicies: [
          makePolicy('tenant-thresholds', [
            {
              guardrailName: 'toxicity-check',
              override: 'threshold',
              threshold: 0.3,
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      const override = result.ruleOverrides.find((r) => r.guardrailName === 'toxicity-check');
      expect(override).toBeDefined();
      expect(override!.override).toBe('threshold');
      expect(override!.threshold).toBe(0.3);
    });

    it('project threshold should override tenant threshold', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'check' })],
        tenantPolicies: [
          makePolicy('tenant', [{ guardrailName: 'check', override: 'threshold', threshold: 0.3 }]),
        ],
        projectPolicies: [
          makePolicy('project', [
            { guardrailName: 'check', override: 'threshold', threshold: 0.9 },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      const override = result.ruleOverrides.find((r) => r.guardrailName === 'check');
      expect(override!.threshold).toBe(0.9);
    });
  });

  // ─── 6. Action override changes from block to warn ────────────────────

  describe('action override', () => {
    it('should override action from block to warn', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'strict-check', action: { type: 'block' } })],
        projectPolicies: [
          makePolicy('project-relaxed', [
            {
              guardrailName: 'strict-check',
              override: 'action',
              action: { type: 'warn', message: 'Relaxed to warning' },
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      const override = result.ruleOverrides.find((r) => r.guardrailName === 'strict-check');
      expect(override).toBeDefined();
      expect(override!.override).toBe('action');
      expect((override!.action as Record<string, string>).type).toBe('warn');
    });

    it('should support severity_actions override', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'graded-check' })],
        tenantPolicies: [
          makePolicy('tenant', [
            {
              guardrailName: 'graded-check',
              override: 'severity_actions',
              severityActions: {
                high: { type: 'block', message: 'High severity blocked' },
                medium: { type: 'warn', message: 'Medium severity warned' },
              },
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      const override = result.ruleOverrides.find((r) => r.guardrailName === 'graded-check');
      expect(override).toBeDefined();
      expect(override!.override).toBe('severity_actions');
      expect(override!.severityActions).toBeDefined();
    });
  });

  // ─── 7. Multiple policies at same scope merge correctly ───────────────

  describe('multiple policies at same scope merge', () => {
    it('should merge rules from multiple tenant policies', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('safety-policy', [
            {
              guardrailName: 'safety-check',
              override: 'define',
              kind: 'input',
              tier: 'model',
              provider: 'builtin-pii',
            },
          ]),
          makePolicy('compliance-policy', [
            {
              guardrailName: 'compliance-check',
              override: 'define',
              kind: 'output',
              tier: 'llm',
              llmCheck: 'Check for compliance violations',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(2);
      expect(result.guardrails.map((g) => g.name)).toContain('safety-check');
      expect(result.guardrails.map((g) => g.name)).toContain('compliance-check');
    });

    it('should merge settings from multiple policies (last wins)', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('policy-a', [], { failMode: 'open' }),
          makePolicy('policy-b', [], { failMode: 'closed' }),
        ],
      });

      const result = resolver.resolve(input);

      // Last policy's settings win
      expect(result.settings.failMode).toBe('closed');
    });

    it('should merge provider overrides from multiple policies', () => {
      const input = makeInput({
        tenantPolicies: [
          {
            name: 'policy-a',
            rules: [],
            settings: { failMode: 'open' },
            providerOverrides: [{ providerName: 'provider-a', endpoint: 'https://a.com' }],
          },
          {
            name: 'policy-b',
            rules: [],
            settings: { failMode: 'open' },
            providerOverrides: [{ providerName: 'provider-b', endpoint: 'https://b.com' }],
          },
        ],
      });

      const result = resolver.resolve(input);

      expect(result.providerOverrides).toHaveLength(2);
    });

    it('should not clobber rules for different guardrails', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'check-a' }), makeGuardrail({ name: 'check-b' })],
        tenantPolicies: [
          makePolicy('policy', [
            { guardrailName: 'check-a', override: 'threshold', threshold: 0.3 },
            { guardrailName: 'check-b', override: 'threshold', threshold: 0.7 },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.ruleOverrides).toHaveLength(2);
      const overrideA = result.ruleOverrides.find((r) => r.guardrailName === 'check-a');
      const overrideB = result.ruleOverrides.find((r) => r.guardrailName === 'check-b');
      expect(overrideA!.threshold).toBe(0.3);
      expect(overrideB!.threshold).toBe(0.7);
    });
  });

  // ─── 8. Cross-tenant isolation ────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('tenant A policies should not affect tenant B resolution', () => {
      const tenantAPolicies = [
        makePolicy('tenant-a-safety', [
          {
            guardrailName: 'tenant-a-check',
            override: 'define',
            kind: 'input',
            tier: 'model',
            provider: 'builtin-pii',
          },
          { guardrailName: 'shared-check', override: 'threshold', threshold: 0.1 },
        ]),
      ];

      const tenantBPolicies = [
        makePolicy('tenant-b-safety', [
          {
            guardrailName: 'tenant-b-check',
            override: 'define',
            kind: 'output',
            tier: 'llm',
            llmCheck: 'Check tenant B compliance',
          },
        ]),
      ];

      // Resolve for tenant A
      const resultA = resolver.resolve(
        makeInput({
          tenantId: 'tenant-a',
          agentGuardrails: [makeGuardrail({ name: 'shared-check' })],
          tenantPolicies: tenantAPolicies,
        }),
      );

      // Resolve for tenant B
      const resultB = resolver.resolve(
        makeInput({
          tenantId: 'tenant-b',
          agentGuardrails: [makeGuardrail({ name: 'shared-check' })],
          tenantPolicies: tenantBPolicies,
        }),
      );

      // Tenant A should have tenant-a-check but not tenant-b-check
      expect(resultA.guardrails.map((g) => g.name)).toContain('tenant-a-check');
      expect(resultA.guardrails.map((g) => g.name)).not.toContain('tenant-b-check');

      // Tenant B should have tenant-b-check but not tenant-a-check
      expect(resultB.guardrails.map((g) => g.name)).toContain('tenant-b-check');
      expect(resultB.guardrails.map((g) => g.name)).not.toContain('tenant-a-check');

      // Tenant A's threshold override should not leak to tenant B
      expect(resultA.ruleOverrides).toHaveLength(1);
      expect(resultA.ruleOverrides[0].threshold).toBe(0.1);
      expect(resultB.ruleOverrides).toHaveLength(0);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should return defaults when no policies provided', () => {
      const input = makeInput({
        agentGuardrails: [makeGuardrail({ name: 'only-dsl' })],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(1);
      expect(result.disabledGuardrails).toHaveLength(0);
      expect(result.ruleOverrides).toHaveLength(0);
      expect(result.settings.failMode).toBe('open');
    });

    it('should handle empty guardrails and policies', () => {
      const input = makeInput({});
      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(0);
      expect(result.disabledGuardrails).toHaveLength(0);
      expect(result.ruleOverrides).toHaveLength(0);
    });

    it('should create synthetic guardrail with correct defaults from define rule', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('policy', [
            {
              guardrailName: 'minimal-define',
              override: 'define',
              check: 'true',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails).toHaveLength(1);
      const guard = result.guardrails[0];
      expect(guard.name).toBe('minimal-define');
      expect(guard.kind).toBe('output'); // default
      expect(guard.priority).toBe(50); // default
      expect(guard.tier).toBe('local'); // default (no provider/llmCheck)
      expect(guard.action.type).toBe('block'); // default
    });

    it('should infer tier from provider presence in define rule', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('policy', [
            {
              guardrailName: 'model-define',
              override: 'define',
              provider: 'custom-safety',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails[0].tier).toBe('model');
    });

    it('should infer tier from llmCheck presence in define rule', () => {
      const input = makeInput({
        tenantPolicies: [
          makePolicy('policy', [
            {
              guardrailName: 'llm-define',
              override: 'define',
              llmCheck: 'Check for safety issues',
            },
          ]),
        ],
      });

      const result = resolver.resolve(input);

      expect(result.guardrails[0].tier).toBe('llm');
    });
  });
});
