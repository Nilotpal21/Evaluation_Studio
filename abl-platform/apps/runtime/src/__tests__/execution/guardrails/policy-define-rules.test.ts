import { describe, it, expect } from 'vitest';
import { GuardrailPolicyResolver } from '../../../services/guardrails/policy-resolver';
import type { PolicyInput } from '../../../services/guardrails/policy-resolver';

describe('GuardrailPolicyResolver – define rules', () => {
  it('should create synthetic guardrails from define rules when agent has no DSL guardrails', () => {
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
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              category: 'harmful_content',
              threshold: 0.5,
              description: 'Policy-defined content safety check',
              priority: 10,
              message: 'Content blocked by policy',
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].name).toBe('content_safety');
    expect(result.guardrails[0].kind).toBe('output');
    expect(result.guardrails[0].tier).toBe('model');
    expect(result.guardrails[0].provider).toBe('azure-content-safety');
    expect(result.guardrails[0].threshold).toBe(0.5);
    expect(result.guardrails[0].priority).toBe(10);
    expect(result.guardrails[0].description).toBe('Policy-defined content safety check');
  });

  it('should NOT overwrite DSL-defined guardrails with define rules of the same name', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [
        {
          name: 'content_safety',
          description: 'DSL content safety',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'abl.is_safe(input)',
          action: { type: 'block', message: 'Blocked by DSL' },
        },
      ],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              threshold: 0.5,
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(1);
    // DSL version is kept — not overwritten by the policy define
    expect(result.guardrails[0].description).toBe('DSL content safety');
    expect(result.guardrails[0].kind).toBe('input');
    expect(result.guardrails[0].tier).toBe('local');
  });

  it('should handle multiple define rules from different scopes', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [
            {
              guardrailName: 'pii_redaction',
              override: 'define',
              kind: 'output',
              tier: 'local',
              check: 'abl.contains_pii(output)',
              message: 'PII detected',
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              threshold: 0.5,
              message: 'Unsafe content',
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(2);
    const names = result.guardrails.map((g) => g.name).sort();
    expect(names).toEqual(['content_safety', 'pii_redaction']);
  });

  it('should allow project define to override tenant define for same guardrail name', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              threshold: 0.3,
              message: 'Tenant policy block',
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              threshold: 0.7,
              message: 'Project policy block',
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].name).toBe('content_safety');
    // Project wins — threshold should be 0.7
    expect(result.guardrails[0].threshold).toBe(0.7);
    expect(result.guardrails[0].action).toEqual({ type: 'block', message: 'Project policy block' });
  });

  it('should handle mix of define and override rules in same policy', () => {
    const resolver = new GuardrailPolicyResolver();
    const input: PolicyInput = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [
        {
          name: 'existing_guard',
          description: 'Existing DSL guard',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'abl.length(input) > 0',
          action: { type: 'block', message: 'Empty input' },
        },
      ],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'new_guard',
              override: 'define',
              kind: 'output',
              tier: 'model',
              provider: 'azure-content-safety',
              threshold: 0.5,
              message: 'Policy-defined guard',
            },
            {
              guardrailName: 'existing_guard',
              override: 'threshold',
              threshold: 0.8,
            },
          ],
          settings: { failMode: 'open', timeouts: { local: 10, model: 500, llm: 2000 } },
        },
      ],
    };

    const result = resolver.resolve(input);
    // 2 guardrails: the original DSL one + the policy-defined one
    expect(result.guardrails).toHaveLength(2);
    expect(result.guardrails.map((g) => g.name).sort()).toEqual(['existing_guard', 'new_guard']);
    // 1 rule override for the existing guard threshold change
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].guardrailName).toBe('existing_guard');
    expect(result.ruleOverrides[0].threshold).toBe(0.8);
  });
});
