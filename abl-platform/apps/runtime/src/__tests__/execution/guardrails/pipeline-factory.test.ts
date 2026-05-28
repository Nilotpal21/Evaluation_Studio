import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockTenantGuardrailProviderFindLean = vi.fn();
const mockResolveAuthProfileCredentials = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantGuardrailProviderConfig: {
    find: (...args: unknown[]) => ({
      lean: () => mockTenantGuardrailProviderFindLean(...args),
    }),
  },
}));

vi.mock('../../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: (...args: unknown[]) => mockResolveAuthProfileCredentials(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

import {
  createGuardrailPipeline,
  ensureTenantProvidersLoaded,
  invalidateTenantProviderCache,
  registerGuardrailProvider,
  getSharedRegistry,
  resetSharedRegistry,
} from '../../../services/guardrails/pipeline-factory';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '@abl/compiler';

describe('GuardrailPipelineFactory', () => {
  beforeEach(() => {
    resetSharedRegistry();
    vi.clearAllMocks();
    mockTenantGuardrailProviderFindLean.mockResolvedValue([]);
    mockResolveAuthProfileCredentials.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create pipeline with PII provider registered', () => {
    const pipeline = createGuardrailPipeline();
    expect(pipeline).toBeDefined();

    const registry = getSharedRegistry();
    const providers = registry.listProviders();
    expect(providers).toContain('builtin-pii');
  });

  it('should share registry across multiple pipeline creations', () => {
    createGuardrailPipeline();
    const registry1 = getSharedRegistry();

    createGuardrailPipeline();
    const registry2 = getSharedRegistry();

    expect(registry1).toBe(registry2);
  });

  it('should allow registering custom providers', () => {
    const mockProvider: GuardrailModelProvider = {
      name: 'custom-test',
      costPerEvalUsd: 0.01,
      evaluate: async (_req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.0,
        severity: 'safe',
        category: 'test',
        latencyMs: 1,
      }),
      isAvailable: async () => true,
    };

    registerGuardrailProvider(mockProvider);

    const registry = getSharedRegistry();
    const providers = registry.listProviders();
    expect(providers).toContain('custom-test');
  });

  it('should create pipeline without llmEval for Tier 3 skip', async () => {
    const pipeline = createGuardrailPipeline();
    // Executing with no Tier 3 guardrails should work fine
    const result = await pipeline.execute([], 'test content', 'input', {});
    expect(result.passed).toBe(true);
  });

  it('should create pipeline with llmEval for Tier 3', () => {
    const mockLlmEval = async (prompt: string) => '{"score": 0.0}';
    const pipeline = createGuardrailPipeline(mockLlmEval);
    expect(pipeline).toBeDefined();
  });

  it('keeps DB-loaded tenant providers after TTL until explicit invalidation', async () => {
    vi.useFakeTimers();

    mockTenantGuardrailProviderFindLean.mockResolvedValue([
      {
        name: 'tenant-provider',
        endpoint: 'https://guardrails.example.test/eval',
        adapterType: 'custom_http',
        customMapping: {},
        costPerEvalUsd: 0,
        updatedAt: '2026-04-19T00:00:00.000Z',
      },
    ]);

    await ensureTenantProvidersLoaded('tenant-A');

    const registry = getSharedRegistry('tenant-A');
    expect(registry.get('tenant-provider')).toBeDefined();

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(registry.get('tenant-provider')).toBeDefined();
    expect(registry.listProviders()).toContain('tenant-provider');

    invalidateTenantProviderCache('tenant-A');

    const resetRegistry = getSharedRegistry('tenant-A');
    expect(resetRegistry.get('tenant-provider')).toBeUndefined();
    expect(resetRegistry.listProviders()).toEqual(['builtin-pii']);
  });

  it('reloads tenant providers from DB after explicit invalidation', async () => {
    mockTenantGuardrailProviderFindLean
      .mockResolvedValueOnce([
        {
          name: 'provider-v1',
          endpoint: 'https://guardrails.example.test/v1',
          adapterType: 'custom_http',
          customMapping: {},
          costPerEvalUsd: 0,
          updatedAt: '2026-04-19T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          name: 'provider-v2',
          endpoint: 'https://guardrails.example.test/v2',
          adapterType: 'custom_http',
          customMapping: {},
          costPerEvalUsd: 0,
          updatedAt: '2026-04-19T01:00:00.000Z',
        },
      ]);

    await ensureTenantProvidersLoaded('tenant-B');
    expect(getSharedRegistry('tenant-B').get('provider-v1')).toBeDefined();

    invalidateTenantProviderCache('tenant-B');

    await ensureTenantProvidersLoaded('tenant-B');
    const registry = getSharedRegistry('tenant-B');

    expect(registry.get('provider-v1')).toBeUndefined();
    expect(registry.get('provider-v2')).toBeDefined();
  });

  it('revalidates auth profile credentials when the tenant provider cache refreshes', async () => {
    vi.useFakeTimers();

    mockTenantGuardrailProviderFindLean.mockResolvedValue([
      {
        name: 'tenant-openai',
        endpoint: 'https://api.openai.com/v1/moderations',
        adapterType: 'openai_moderation',
        authProfileId: 'profile-1',
        model: 'omni-moderation-latest',
        defaultCategory: 'self_harm',
        defaultThreshold: 0.8,
        costPerEvalUsd: 0,
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    mockResolveAuthProfileCredentials
      .mockResolvedValueOnce({ secrets: { apiKey: 'sk-first' } })
      .mockResolvedValueOnce(null);

    await ensureTenantProvidersLoaded('tenant-credential-refresh');
    expect(getSharedRegistry('tenant-credential-refresh').get('tenant-openai')).toBeDefined();

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await ensureTenantProvidersLoaded('tenant-credential-refresh');

    expect(mockResolveAuthProfileCredentials).toHaveBeenCalledTimes(2);
    expect(getSharedRegistry('tenant-credential-refresh').get('tenant-openai')).toBeUndefined();
  });
});
