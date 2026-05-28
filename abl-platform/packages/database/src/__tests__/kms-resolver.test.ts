import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverMocks = vi.hoisted(() => {
  const state = {
    materializedDoc: null as any,
    materializedError: null as Error | null,
    tenantDoc: null as any,
    tenantError: null as Error | null,
  };

  return {
    state,
    MaterializedKMSConfig: {
      findOne: vi.fn(() => {
        if (state.materializedError) throw state.materializedError;
        return {
          lean: () => state.materializedDoc,
        };
      }),
    },
    TenantKMSConfig: {
      findOne: vi.fn(() => {
        if (state.tenantError) throw state.tenantError;
        return {
          lean: () => state.tenantDoc,
        };
      }),
    },
    User: {
      findOne: vi.fn(() => ({ lean: () => null })),
    },
    PlatformAccessRequest: {
      find: vi.fn(() => ({ sort: () => ({ lean: () => [] }) })),
    },
    PlatformAdmin: {
      findOne: vi.fn(() => ({ lean: () => null })),
    },
    PlatformAllowedDomain: {
      findOne: vi.fn(() => ({ lean: () => null })),
    },
  };
});

vi.mock('../models/index.js', () => ({
  MaterializedKMSConfig: resolverMocks.MaterializedKMSConfig,
  TenantKMSConfig: resolverMocks.TenantKMSConfig,
  CrawlError: {},
  User: resolverMocks.User,
  PlatformAccessRequest: resolverMocks.PlatformAccessRequest,
  PlatformAdmin: resolverMocks.PlatformAdmin,
  PlatformAllowedDomain: resolverMocks.PlatformAllowedDomain,
  PlatformAllowedEmail: {},
  WorkspaceInvitation: {},
}));

import { KMSResolver } from '../kms/kms-resolver.js';

describe('KMSResolver', () => {
  beforeEach(() => {
    resolverMocks.state.materializedDoc = null;
    resolverMocks.state.materializedError = null;
    resolverMocks.state.tenantDoc = null;
    resolverMocks.state.tenantError = null;
    resolverMocks.MaterializedKMSConfig.findOne.mockClear();
    resolverMocks.TenantKMSConfig.findOne.mockClear();
    delete process.env.KMS_PROVIDER;
    KMSResolver._resetPlatformDefaultForTesting();
  });

  it('falls back to platform default when both config sources cleanly return no config', async () => {
    const resolver = new KMSResolver();

    const resolved = await resolver.resolve('tenant-no-config');

    expect(resolved.provider.providerType).toBe('local');
    expect(resolved.keyId).toBe('platform-default');
    expect(resolved.sourceConfigVersion).toBe(0);
  });

  it('throws when materialized lookup fails and no tenant config resolves', async () => {
    resolverMocks.state.materializedError = new Error('materialized lookup unavailable');
    const resolver = new KMSResolver();

    await expect(resolver.resolve('tenant-materialized-fail')).rejects.toThrow(
      /materialized lookup unavailable/i,
    );
  });

  it('uses tenant config when materialized lookup fails but tenant config resolves', async () => {
    resolverMocks.state.materializedError = new Error('materialized lookup unavailable');
    resolverMocks.state.tenantDoc = {
      tenantId: 'tenant-custom',
      defaultProvider: {
        providerType: 'local',
        keyId: 'tenant-default-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      },
      dekEpochIntervalHours: 48,
      dekMaxUsageCount: 1234,
      failurePolicy: 'fail-closed',
      _v: 7,
    };
    const resolver = new KMSResolver();

    const resolved = await resolver.resolve('tenant-custom');

    expect(resolved.provider.providerType).toBe('local');
    expect(resolved.keyId).toBe('tenant-default-key');
    expect(resolved.dekEpochIntervalHours).toBe(48);
    expect(resolved.dekMaxUsageCount).toBe(1234);
    expect(resolved.sourceConfigVersion).toBe(7);
  });

  it('throws when tenant config lookup fails and no materialized config exists', async () => {
    resolverMocks.state.tenantError = new Error('tenant config lookup unavailable');
    const resolver = new KMSResolver();

    await expect(resolver.resolve('tenant-tenantconfig-fail')).rejects.toThrow(
      /tenant config lookup unavailable/i,
    );
  });

  it('runs internal KMS config lookups in the injected tenant context runner', async () => {
    const tenantContextRunner = vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) =>
      fn(),
    );
    resolverMocks.MaterializedKMSConfig.findOne.mockImplementationOnce(() => {
      return {
        lean: () => null,
      };
    });

    const resolver = new KMSResolver({ tenantContextRunner });

    const resolved = await resolver.resolve('019cadcb-fba1-7dc4-830c-1d3c3dbb0ecf');

    expect(resolved.provider.providerType).toBe('local');
    expect(tenantContextRunner).toHaveBeenCalledTimes(2);
    expect(tenantContextRunner).toHaveBeenNthCalledWith(
      1,
      '019cadcb-fba1-7dc4-830c-1d3c3dbb0ecf',
      expect.any(Function),
    );
    expect(tenantContextRunner).toHaveBeenNthCalledWith(
      2,
      '019cadcb-fba1-7dc4-830c-1d3c3dbb0ecf',
      expect.any(Function),
    );
  });
});
