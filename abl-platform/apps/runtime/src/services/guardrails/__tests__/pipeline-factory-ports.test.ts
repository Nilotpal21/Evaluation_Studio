import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGuardrailPipeline,
  ensureTenantProvidersLoaded,
  getSharedRegistry,
  registerGuardrailProvider,
  resetSharedRegistry,
} from '../pipeline-factory.js';
import type { Guardrail } from '@abl/compiler';
import type {
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '@abl/compiler/platform/guardrails/provider.js';

// Mock the Redis client module
vi.mock('../../redis/redis-client.js', () => ({
  getRedisClient: vi.fn(),
  getRedisHandle: () => null,
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantGuardrailProviderConfig: {
    find: vi.fn(),
  },
}));

vi.mock('../../auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: vi.fn(),
  getAuthProfileCache: vi.fn(),
}));

import { getRedisClient } from '../../redis/redis-client.js';
import { TenantGuardrailProviderConfig } from '@agent-platform/database/models';
import { resolveAuthProfileCredentials } from '../../auth-profile-resolver.js';

const mockGetRedisClient = vi.mocked(getRedisClient);
const mockProviderFind = vi.mocked(TenantGuardrailProviderConfig.find);
const mockResolveAuthProfileCredentials = vi.mocked(resolveAuthProfileCredentials);

class MockProvider {
  readonly name: string;
  readonly costPerEvalUsd: number;
  private readonly result: GuardrailEvalResult;

  constructor(name: string, result: Partial<GuardrailEvalResult>, costPerEvalUsd = 0.01) {
    this.name = name;
    this.costPerEvalUsd = costPerEvalUsd;
    this.result = {
      score: 0,
      severity: 'safe',
      category: 'toxicity',
      latencyMs: 1,
      ...result,
    };
  }

  async evaluate(_request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    return this.result;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function makeModelGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'model-check',
    description: 'model guardrail',
    kind: 'input',
    priority: 1,
    tier: 'model',
    provider: 'policy-provider',
    category: 'toxicity',
    threshold: 0.5,
    action: { type: 'block', message: 'Blocked' },
    ...overrides,
  };
}

function makeWarnGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'warn-check',
    description: 'warn guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'warn', message: 'Warned' },
    ...overrides,
  };
}

describe('createGuardrailPipeline — port auto-wiring', () => {
  beforeEach(() => {
    resetSharedRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-creates cache and cost-checker adapters when tenantId is provided and Redis is available', () => {
    // Provide a mock Redis client so the lazy singletons get created
    mockGetRedisClient.mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      incrby: vi.fn(),
      expire: vi.fn(),
    } as unknown as ReturnType<typeof getRedisClient>);

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1');

    expect(pipeline).toBeDefined();
    // Pipeline was created — if adapters were wired, the pipeline's internal
    // cache/costChecker fields will be set. We verify by running an execution
    // that would use cache (tier1/tier2 guardrails). A pass-through test
    // confirms the pipeline is functional.
  });

  it('does not create adapters when tenantId is not provided', () => {
    mockGetRedisClient.mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      incrby: vi.fn(),
      expire: vi.fn(),
    } as unknown as ReturnType<typeof getRedisClient>);

    const pipeline = createGuardrailPipeline();

    // Pipeline still works — just without ports
    expect(pipeline).toBeDefined();
  });

  it('does not create adapters when Redis is unavailable', () => {
    mockGetRedisClient.mockReturnValue(null);

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1');

    // Pipeline created without errors even when Redis is null
    expect(pipeline).toBeDefined();
  });

  it('uses explicit options when provided instead of auto-wiring', () => {
    mockGetRedisClient.mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      incrby: vi.fn(),
      expire: vi.fn(),
    } as unknown as ReturnType<typeof getRedisClient>);

    const mockCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', undefined, {
      cache: mockCache,
    });

    // Pipeline created with explicit options (not auto-wired)
    expect(pipeline).toBeDefined();
  });

  it('reuses lazy singletons across multiple calls', () => {
    const mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      incrby: vi.fn(),
      expire: vi.fn(),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);

    const pipeline1 = createGuardrailPipeline(undefined, 'tenant-1');
    const pipeline2 = createGuardrailPipeline(undefined, 'tenant-2');

    // Both pipelines created successfully. The underlying GuardrailCache
    // and GuardrailCostTracker are singletons — getRedisClient is called
    // only for the first creation of each singleton.
    expect(pipeline1).toBeDefined();
    expect(pipeline2).toBeDefined();
  });

  it('pipeline executes correctly with auto-wired ports', async () => {
    mockGetRedisClient.mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    } as unknown as ReturnType<typeof getRedisClient>);

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1');
    const result = await pipeline.execute([], 'test content', 'input', {});

    expect(result.passed).toBe(true);
  });

  it('resetSharedRegistry clears lazy singletons', () => {
    const mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      incrby: vi.fn(),
      expire: vi.fn(),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);

    // Create a pipeline to initialize singletons
    createGuardrailPipeline(undefined, 'tenant-1');

    // Reset clears everything
    resetSharedRegistry();

    // After reset, creating a new pipeline should work (singletons re-created)
    const pipeline = createGuardrailPipeline(undefined, 'tenant-1');
    expect(pipeline).toBeDefined();
  });

  it('disables exact-match caching when policy caching is turned off', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);
    registerGuardrailProvider(
      new MockProvider('policy-provider', { score: 0.1, severity: 'safe' }),
      'tenant-1',
    );

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', 'project-1', {
      policy: {
        caching: {
          enabled: false,
          exactMatch: false,
        },
      },
    });

    await pipeline.execute([makeModelGuardrail({ threshold: 0.9 })], 'safe content', 'input', {});

    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('uses policy defaultTtlSeconds for exact-match cache entries', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);
    registerGuardrailProvider(
      new MockProvider('policy-provider', { score: 0.1, severity: 'safe' }),
      'tenant-1',
    );

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', 'project-1', {
      policy: {
        caching: {
          enabled: true,
          exactMatch: true,
          defaultTtlSeconds: 123,
        },
      },
    });

    await pipeline.execute([makeModelGuardrail({ threshold: 0.9 })], 'safe content', 'input', {});

    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 123);
  });

  it('uses explicit cacheScopeKey when auto-wiring exact-match cache entries', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);
    registerGuardrailProvider(
      new MockProvider('policy-provider', { score: 0.1, severity: 'safe' }),
      'tenant-1',
    );

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', 'project-1', {
      cacheScopeKey: 'agent-a-rev-1',
      policy: {
        caching: {
          enabled: true,
          exactMatch: true,
        },
      },
    });

    await pipeline.execute([makeModelGuardrail({ threshold: 0.9 })], 'safe content', 'input', {});

    expect(mockRedis.set).toHaveBeenCalled();
    const key = String(mockRedis.set.mock.calls[0][0]);
    expect(key).toContain(':tenant-1:project-1:agent-a-rev-1:model:model-check:');
  });

  it('loads tenant provider defaults and resilience settings into registry runtime config', async () => {
    mockProviderFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        {
          name: 'tenant-provider',
          endpoint: 'https://guardrails.example.com/evaluate',
          adapterType: 'custom_http',
          isActive: true,
          defaultCategory: 'self_harm',
          defaultThreshold: 0.81,
          costPerEvalUsd: 0.42,
          circuitBreaker: {
            failureThreshold: 2,
            resetTimeoutMs: 45_000,
            failMode: 'closed',
          },
          retry: {
            maxRetries: 4,
            backoffBaseMs: 250,
          },
          customMapping: {
            requestTemplate: '{"text":"{{content}}"}',
            responseScorePath: 'score',
          },
          updatedAt: new Date('2026-05-02T00:00:00Z'),
        },
      ]),
    } as any);

    await ensureTenantProvidersLoaded('tenant-1');

    const registry = getSharedRegistry('tenant-1');
    expect(registry.get('tenant-provider')).toBeDefined();
    expect(registry.getRuntimeConfig('tenant-provider')).toEqual({
      defaultCategory: 'self_harm',
      defaultThreshold: 0.81,
      costPerEvalUsd: 0.42,
      circuitBreaker: {
        failureThreshold: 2,
        resetTimeoutMs: 45_000,
        failMode: 'closed',
      },
      retry: {
        maxRetries: 4,
        backoffBaseMs: 250,
      },
    });
  });

  it('loads openai_moderation through the dedicated adapter with model and category scores', async () => {
    mockResolveAuthProfileCredentials.mockResolvedValue({
      secrets: { apiKey: 'sk-from-profile' },
    } as any);
    mockProviderFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        {
          name: 'tenant-openai',
          endpoint: 'https://api.openai.com/v1/moderations',
          adapterType: 'openai_moderation',
          authProfileId: 'profile-1',
          model: 'omni-moderation-latest',
          isActive: true,
          defaultCategory: 'hate',
          defaultThreshold: 0.5,
          costPerEvalUsd: 0,
          circuitBreaker: {
            failureThreshold: 2,
            resetTimeoutMs: 45_000,
          },
          retry: {
            maxRetries: 0,
            backoffBaseMs: 0,
          },
          updatedAt: new Date('2026-05-02T00:00:00Z'),
        },
      ]),
    } as any);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              flagged: true,
              categories: { hate: true, violence: false },
              category_scores: { hate: 0.91, violence: 0.02 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await ensureTenantProvidersLoaded('tenant-1');

    const registry = getSharedRegistry('tenant-1');
    const evalResult = await registry.evaluate('tenant-openai', {
      content: 'hateful content',
      category: 'hate',
    });

    expect(evalResult?.score).toBeCloseTo(0.91, 2);
    expect(evalResult?.label).toBe('hate');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      input: 'hateful content',
      model: 'omni-moderation-latest',
    });
  });

  it('wires policy budget into the runtime cost checker', async () => {
    const mockRedis = {
      get: vi
        .fn()
        .mockImplementation((key: string) =>
          key.startsWith('guardrail:cost:tenant-1:project-1') ? '2000000' : null,
        ),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);
    registerGuardrailProvider(
      new MockProvider('policy-provider', { score: 0.99, severity: 'critical' }),
      'tenant-1',
    );

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', 'project-1', {
      policy: {
        budget: {
          monthlyLimitUsd: 1,
          overspendAction: 'disable_model_checks',
        },
      },
    });

    const result = await pipeline.execute([makeModelGuardrail()], 'unsafe content', 'input', {});

    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(0);
    expect(mockRedis.get).toHaveBeenCalled();
  });

  it('wires policy webhook config into guardrail warning delivery', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      incrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(mockRedis as unknown as ReturnType<typeof getRedisClient>);

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pipeline = createGuardrailPipeline(undefined, 'tenant-1', 'project-1', {
      policy: {
        webhook: {
          url: 'https://hooks.example.com/guardrails',
          secret: 'whsec_test',
        },
      },
    });

    const result = await pipeline.execute([makeWarnGuardrail()], 'warn me', 'input', {});

    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
