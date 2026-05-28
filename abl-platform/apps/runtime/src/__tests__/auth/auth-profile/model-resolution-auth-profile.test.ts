/**
 * ModelResolutionService — Auth Profile tests
 *
 * Verifies that tenant-model resolution delegates auth-profile lookup to the
 * hardened shared resolver and maps its result into LLM credentials.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-kernel', () => ({
  AppError: class AppError extends Error {
    constructor(
      message: string,
      public details?: unknown,
    ) {
      super(message);
    }
  },
  ErrorCodes: {
    NOT_FOUND: { code: 404, message: 'Not Found' },
    SERVICE_UNAVAILABLE: { code: 503, message: 'Service Unavailable' },
    TOO_MANY_REQUESTS: { code: 429, message: 'Too Many Requests' },
    INTERNAL_ERROR: { code: 500, message: 'Internal Error' },
  },
}));

vi.mock('../../../config/index.js', () => ({
  isConfigLoaded: () => false,
  getConfig: () => ({ modelResolutionCacheTtlMs: 0 }),
}));

const { mockResolveAuthProfileCredentials } = vi.hoisted(() => ({
  mockResolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('../../../repos/llm-resolution-repo.js', () => ({
  findAgentModelConfig: vi.fn().mockResolvedValue(null),
  findAgentModelConfigByDslName: vi.fn().mockResolvedValue(null),
  findModelConfigByModelId: vi.fn().mockResolvedValue(null),
  findModelConfigForTier: vi.fn().mockResolvedValue(null),
  findAnyModelConfig: vi.fn().mockResolvedValue(null),
  findTenantModelByIdWithPrimaryConnection: vi.fn().mockResolvedValue(null),
  findDefaultTenantModelForTier: vi.fn().mockResolvedValue(null),
  findAnyDefaultTenantModel: vi.fn().mockResolvedValue(null),
  findTenantModelByProvider: vi.fn().mockResolvedValue(null),
  findTenantLLMPolicy: vi.fn().mockResolvedValue(null),
  findDefaultUserCredential: vi.fn().mockResolvedValue(null),
  findDefaultTenantCredential: vi.fn().mockResolvedValue(null),
  findDefaultTenantModelForVoice: vi.fn().mockResolvedValue(null),
  findCredentialById: vi.fn().mockResolvedValue(null),
  findProjectOperationTierOverrides: vi.fn().mockResolvedValue(null),
  findProjectEnableThinking: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: (...args: unknown[]) => mockResolveAuthProfileCredentials(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

import { ModelResolutionService } from '../../../services/llm/model-resolution.js';

const services: ModelResolutionService[] = [];

function createService(): ModelResolutionService {
  const service = new ModelResolutionService(true, null);
  services.push(service);
  return service;
}

function callResolveViaAuthProfile(
  service: ModelResolutionService,
  authProfileId: string,
  tenantId: string,
) {
  return (
    service as unknown as {
      resolveViaAuthProfile(authProfileId: string, tenantId: string): Promise<unknown>;
    }
  ).resolveViaAuthProfile(authProfileId, tenantId);
}

describe('ModelResolutionService — Auth Profile resolution', () => {
  afterEach(() => {
    mockResolveAuthProfileCredentials.mockReset();
    for (const service of services) {
      service.clearCache();
    }
    services.length = 0;
  });

  it('resolveViaAuthProfile delegates to the shared resolver for api_key profiles', async () => {
    mockResolveAuthProfileCredentials.mockResolvedValue({
      profileId: 'auth-prof-1',
      authType: 'api_key',
      config: { endpoint: 'https://custom.endpoint.com' },
      secrets: { apiKey: 'sk-from-profile' },
    });

    const service = createService();
    const result = await callResolveViaAuthProfile(service, 'auth-prof-1', 'tenant-1');

    expect(result).toEqual({
      apiKey: 'sk-from-profile',
      endpoint: 'https://custom.endpoint.com',
      authType: 'api_key',
      authConfig: { endpoint: 'https://custom.endpoint.com' },
    });
    expect(mockResolveAuthProfileCredentials).toHaveBeenCalledWith('auth-prof-1', 'tenant-1');
  });

  it('resolveViaAuthProfile maps bearer access tokens from the shared resolver', async () => {
    mockResolveAuthProfileCredentials.mockResolvedValue({
      profileId: 'auth-prof-1',
      authType: 'bearer',
      config: {},
      secrets: { accessToken: 'bearer-token-123' },
    });

    const service = createService();
    const result = await callResolveViaAuthProfile(service, 'auth-prof-1', 'tenant-1');

    expect(result).toEqual({
      apiKey: 'bearer-token-123',
      endpoint: undefined,
      authType: 'bearer',
      authConfig: {},
    });
  });

  it('resolveViaAuthProfile returns null when the shared resolver returns null', async () => {
    mockResolveAuthProfileCredentials.mockResolvedValue(null);

    const service = createService();
    const result = await callResolveViaAuthProfile(service, 'auth-prof-1', 'tenant-1');

    expect(result).toBeNull();
  });

  it('resolveViaAuthProfile returns null when the shared resolver has no usable secret', async () => {
    mockResolveAuthProfileCredentials.mockResolvedValue({
      profileId: 'auth-prof-1',
      authType: 'api_key',
      config: {},
      secrets: {},
    });

    const service = createService();
    const result = await callResolveViaAuthProfile(service, 'auth-prof-1', 'tenant-1');

    expect(result).toBeNull();
  });

  it('resolveViaAuthProfile propagates shared resolver failures', async () => {
    mockResolveAuthProfileCredentials.mockRejectedValue(new Error('resolver unavailable'));

    const service = createService();
    await expect(callResolveViaAuthProfile(service, 'auth-prof-1', 'tenant-1')).rejects.toThrow(
      'resolver unavailable',
    );
  });
});
