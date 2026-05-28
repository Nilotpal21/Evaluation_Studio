import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveGuardrailPolicy } from '../../../services/guardrails/pipeline-factory';
import type { Guardrail } from '@abl/compiler';
import type { PolicyData } from '../../../services/guardrails/policy-resolver';

const { mockGuardrailPolicyFind, mockProjectAgentFindOne } = vi.hoisted(() => ({
  mockGuardrailPolicyFind: vi.fn(),
  mockProjectAgentFindOne: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  isDatabaseReady: () => true,
}));

vi.mock('@agent-platform/database/models', () => ({
  GuardrailPolicy: {
    find: mockGuardrailPolicyFind,
  },
  ProjectAgent: {
    findOne: mockProjectAgentFindOne,
  },
}));

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

const defaultSettings: PolicyData['settings'] = {
  failMode: 'open',
  timeouts: { local: 10, model: 500, llm: 2000 },
};

describe('resolveGuardrailPolicy', () => {
  afterEach(() => {
    mockGuardrailPolicyFind.mockReset();
    mockProjectAgentFindOne.mockReset();
  });

  it('should return undefined when no policies are found', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({ tenantPolicies: [], projectPolicies: [] }),
    );
    expect(result).toBeUndefined();
  });

  it('should resolve tenant policy with disabled guardrails', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({
        tenantPolicies: [
          {
            name: 'tenant-policy',
            rules: [{ guardrailName: 'test-guard', override: 'disable' }],
            settings: defaultSettings,
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.disabledGuardrails).toContain('test-guard');
  });

  it('should resolve project policy overriding threshold', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'project-policy',
            rules: [
              {
                guardrailName: 'test-guard',
                override: 'threshold',
                threshold: 0.8,
              },
            ],
            settings: { ...defaultSettings, failMode: 'closed' },
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.settings?.failMode).toBe('closed');
    expect(result!.policy.ruleOverrides).toHaveLength(1);
    expect(result!.policy.ruleOverrides![0].threshold).toBe(0.8);
  });

  it('should pass through failMode from policy settings', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({
        tenantPolicies: [
          {
            name: 'closed-policy',
            rules: [],
            settings: { ...defaultSettings, failMode: 'closed' },
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.settings?.failMode).toBe('closed');
  });

  it('should pass through timeout settings from the resolved policy', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({
        tenantPolicies: [
          {
            name: 'timeout-policy',
            rules: [],
            settings: {
              failMode: 'closed',
              timeouts: { local: 11, model: 22, llm: 33 },
            },
          },
        ],
        projectPolicies: [],
      }),
    );

    expect(result).toBeDefined();
    expect((result!.policy.settings as any)?.timeouts).toEqual({
      local: 11,
      model: 22,
      llm: 33,
    });
  });

  it('should preserve executable provider override fields in the resolved pipeline policy', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ tier: 'model', provider: 'custom-api', threshold: undefined })],
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'provider-override-policy',
            rules: [],
            settings: defaultSettings,
            providerOverrides: [
              {
                providerName: 'custom-api',
                endpoint: 'https://guardrails.example.com/eval',
                defaultCategory: 'self_harm',
                defaultThreshold: 0.85,
                costPerEvalUsd: 0.25,
                retry: { maxRetries: 2, backoffBaseMs: 10 },
                isActive: true,
                circuitBreaker: { failureThreshold: 4, resetTimeoutMs: 3000 },
              },
            ],
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.providerOverrides).toEqual([
      expect.objectContaining({
        providerName: 'custom-api',
        endpoint: 'https://guardrails.example.com/eval',
        defaultCategory: 'self_harm',
        defaultThreshold: 0.85,
        costPerEvalUsd: 0.25,
        retry: { maxRetries: 2, backoffBaseMs: 10 },
        isActive: true,
        circuitBreaker: { failureThreshold: 4, resetTimeoutMs: 3000 },
      }),
    ]);
  });

  it('should preserve caching, budget, and webhook controls in the resolved pipeline policy', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'operational-policy',
            rules: [],
            settings: {
              ...defaultSettings,
              webhookUrl: 'https://hooks.example.com/guardrails',
              webhookSecret: 'whsec_test',
            } as PolicyData['settings'],
            caching: {
              enabled: true,
              exactMatch: true,
              semanticMatch: false,
              semanticThreshold: 0.95,
              defaultTtlSeconds: 123,
            },
            budget: {
              monthlyLimitUsd: 42,
              currentSpendUsd: 0,
              overspendAction: 'disable_model_checks',
            },
          } as PolicyData,
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.caching).toEqual(
      expect.objectContaining({
        enabled: true,
        exactMatch: true,
        defaultTtlSeconds: 123,
      }),
    );
    expect(result!.policy.budget).toEqual(
      expect.objectContaining({
        monthlyLimitUsd: 42,
        overspendAction: 'disable_model_checks',
      }),
    );
    expect(result!.policy.webhook).toEqual({
      url: 'https://hooks.example.com/guardrails',
      secret: 'whsec_test',
    });
  });

  it('should apply project policies before agent policies when loading from the database', async () => {
    mockProjectAgentFindOne.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    mockGuardrailPolicyFind.mockReturnValue({
      limit: () => ({
        lean: async () => [
          {
            name: 'agent-override',
            rules: [{ guardrailName: 'test-guard', override: 'threshold', threshold: 0.9 }],
            settings: { ...defaultSettings, failMode: 'closed' },
            scope: { type: 'agent', projectId: 'project-1', agentDefId: 'agent-1' },
            status: 'active',
            isActive: true,
            updatedAt: new Date('2026-05-02T10:00:00.000Z'),
          },
          {
            name: 'project-baseline',
            rules: [{ guardrailName: 'test-guard', override: 'threshold', threshold: 0.4 }],
            settings: defaultSettings,
            scope: { type: 'project', projectId: 'project-1' },
            status: 'active',
            isActive: true,
            updatedAt: new Date('2026-05-02T11:00:00.000Z'),
          },
        ],
      }),
    });

    const result = await resolveGuardrailPolicy('tenant-1', 'project-1', 'agent-1', [
      makeGuardrail(),
    ]);

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(1);
    expect(result!.policy.ruleOverrides![0].threshold).toBe(0.9);
    expect(result!.policy.settings?.failMode).toBe('closed');
  });

  it('should apply imported agent policies stored with the target ProjectAgent id', async () => {
    mockProjectAgentFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: 'agent-db-id' }),
      }),
    });
    mockGuardrailPolicyFind.mockReturnValue({
      limit: () => ({
        lean: async () => [
          {
            name: 'imported-agent-policy',
            rules: [{ guardrailName: 'test-guard', override: 'threshold', threshold: 0.88 }],
            settings: { ...defaultSettings, failMode: 'closed' },
            scope: { type: 'agent', projectId: 'project-1', agentDefId: 'agent-db-id' },
            status: 'active',
            isActive: true,
            updatedAt: new Date('2026-05-02T10:00:00.000Z'),
          },
        ],
      }),
    });

    const result = await resolveGuardrailPolicy('tenant-1', 'project-1', 'TransferAgent', [
      makeGuardrail(),
    ]);

    expect(mockProjectAgentFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'TransferAgent',
    });
    expect(mockGuardrailPolicyFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([
          {
            'scope.type': 'agent',
            'scope.agentDefId': { $in: ['TransferAgent', 'agent-db-id'] },
            'scope.projectId': 'project-1',
          },
        ]),
      }),
    );
    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toHaveLength(1);
    expect(result!.policy.ruleOverrides![0].threshold).toBe(0.88);
    expect(result!.policy.settings?.failMode).toBe('closed');
  });

  it('should ignore non-project operational controls when loading from the database', async () => {
    mockProjectAgentFindOne.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    mockGuardrailPolicyFind.mockReturnValue({
      limit: () => ({
        lean: async () => [
          {
            name: 'tenant-policy',
            rules: [],
            settings: {
              ...defaultSettings,
              webhookUrl: 'https://hooks.example.com/tenant',
              webhookSecret: 'whsec_tenant',
            },
            caching: {
              enabled: true,
              exactMatch: true,
              semanticMatch: false,
              semanticThreshold: 0.95,
              defaultTtlSeconds: 60,
            },
            budget: {
              monthlyLimitUsd: 10,
              currentSpendUsd: 7,
              overspendAction: 'disable_model_checks',
            },
            scope: { type: 'tenant' },
            status: 'active',
            isActive: true,
            updatedAt: new Date('2026-05-02T09:00:00.000Z'),
          },
          {
            name: 'agent-policy',
            rules: [],
            settings: {
              ...defaultSettings,
              webhookUrl: 'https://hooks.example.com/agent',
              webhookSecret: 'whsec_agent',
            },
            caching: {
              enabled: true,
              exactMatch: true,
              semanticMatch: false,
              semanticThreshold: 0.95,
              defaultTtlSeconds: 123,
            },
            budget: {
              monthlyLimitUsd: 42,
              currentSpendUsd: 0,
              overspendAction: 'disable_model_checks',
            },
            scope: { type: 'agent', projectId: 'project-1', agentDefId: 'agent-1' },
            status: 'active',
            isActive: true,
            updatedAt: new Date('2026-05-02T10:00:00.000Z'),
          },
        ],
      }),
    });

    const result = await resolveGuardrailPolicy('tenant-1', 'project-1', 'agent-1', [
      makeGuardrail(),
    ]);

    expect(result).toBeDefined();
    expect(result!.policy.caching).toBeUndefined();
    expect(result!.policy.budget).toBeUndefined();
    expect(result!.policy.webhook).toBeUndefined();
  });

  it('should return undefined on DB error (fail-open)', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail()],
      async () => {
        throw new Error('DB connection failed');
      },
    );

    expect(result).toBeUndefined();
  });

  it('should include additionalGuardrails from define rules when agent has no DSL guardrails', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [], // No DSL guardrails
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'project-policy',
            rules: [
              {
                guardrailName: 'content_safety',
                override: 'define' as const,
                kind: 'output' as const,
                tier: 'model' as const,
                provider: 'openai_moderation',
                category: 'hate',
                threshold: 0.5,
                action: { type: 'block', message: 'Blocked.' },
              },
            ],
            settings: defaultSettings,
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.additionalGuardrails).toBeDefined();
    expect(result!.policy.additionalGuardrails).toHaveLength(1);
    expect(result!.policy.additionalGuardrails![0].name).toBe('content_safety');
    expect(result!.policy.additionalGuardrails![0].kind).toBe('output');
  });

  it('should not include DSL guardrails in additionalGuardrails', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeGuardrail({ name: 'dsl-guard' })], // Has DSL guardrails
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'project-policy',
            rules: [
              {
                guardrailName: 'policy-guard',
                override: 'define' as const,
                kind: 'output' as const,
                tier: 'model' as const,
                provider: 'openai_moderation',
                threshold: 0.5,
                action: { type: 'block', message: 'Blocked.' },
              },
            ],
            settings: defaultSettings,
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.additionalGuardrails).toBeDefined();
    expect(result!.policy.additionalGuardrails).toHaveLength(1);
    expect(result!.policy.additionalGuardrails![0].name).toBe('policy-guard');
    // DSL guardrail should NOT be in additionalGuardrails
  });

  it('should ignore malformed define rules that do not specify an executable check', async () => {
    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [],
      async () => ({
        tenantPolicies: [],
        projectPolicies: [
          {
            name: 'malformed-policy',
            rules: [
              {
                guardrailName: 'broken-guard',
                override: 'define' as const,
                kind: 'input' as const,
                action: { type: 'block', message: 'Should never execute' },
              },
            ],
            settings: { ...defaultSettings, failMode: 'closed' },
          },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.policy.additionalGuardrails).toBeUndefined();
  });
});
