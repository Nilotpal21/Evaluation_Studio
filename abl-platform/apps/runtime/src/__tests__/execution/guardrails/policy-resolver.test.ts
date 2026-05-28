import { describe, it, expect } from 'vitest';
import { GuardrailPolicyResolver } from '../../../services/guardrails/policy-resolver';
import type {
  ResolvedGuardrailPolicy,
  PolicyInput,
} from '../../../services/guardrails/policy-resolver';

describe('GuardrailPolicyResolver', () => {
  it('should return agent DSL guardrails when no policies exist', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [
        {
          name: 'pii_check',
          description: 'Block PII',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'abl.contains_pii(input)',
          action: { type: 'block', message: 'PII detected' },
        },
      ],
      tenantPolicies: [],
      projectPolicies: [],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].name).toBe('pii_check');
  });

  it('should merge tenant policy rules with agent DSL guardrails', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [
        {
          name: 'pii_check',
          description: 'Block PII',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'abl.contains_pii(input)',
          action: { type: 'block', message: 'PII detected' },
        },
      ],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [{ guardrailName: 'pii_check', override: 'threshold', threshold: 0.5 }],
          settings: {
            failMode: 'open',
            timeouts: { local: 10, model: 500, llm: 2000 },
          },
        },
      ],
      projectPolicies: [],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(1);
    expect(result.settings.failMode).toBe('open');
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].guardrailName).toBe('pii_check');
  });

  it('should allow project policy to disable a guardrail', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [
        {
          name: 'length_check',
          description: 'Length check',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'abl.length(input) > 1000',
          action: { type: 'block' },
        },
      ],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [{ guardrailName: 'length_check', override: 'disable' }],
          settings: {
            failMode: 'open',
            timeouts: { local: 10, model: 500, llm: 2000 },
          },
        },
      ],
    };

    const result = resolver.resolve(input);
    // length_check should be disabled
    expect(result.disabledGuardrails).toContain('length_check');
  });

  it('should project policy settings override tenant settings', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [],
          settings: { failMode: 'closed', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [],
          settings: { failMode: 'open', timeouts: { local: 5, model: 300, llm: 1000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.settings.failMode).toBe('open'); // project wins
    expect(result.settings.timeouts.local).toBe(5);
  });

  it('should return default settings when no policies exist', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [],
      projectPolicies: [],
    };

    const result = resolver.resolve(input);
    expect(result.settings.failMode).toBe('open');
    expect(result.settings.timeouts.local).toBe(100);
    expect(result.guardrails).toHaveLength(0);
  });

  it('should merge provider overrides from project policy', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
          providerOverrides: [
            {
              providerName: 'my-vllm',
              endpoint: 'http://new-endpoint:8000',
              defaultThreshold: 0.9,
            },
          ],
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.providerOverrides).toHaveLength(1);
    expect(result.providerOverrides[0].providerName).toBe('my-vllm');
  });
});
