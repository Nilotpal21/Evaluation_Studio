/**
 * KMS Resolver Tests
 *
 * Validates: L1 cache hit/miss, MaterializedKMSConfig lookup,
 * TenantKMSConfig fallback, platform default, tenant eviction.
 *
 * resolve() now accepts (tenantId, projectId, environment) —
 * queries MaterializedKMSConfig first, falls back to TenantKMSConfig.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockMaterializedFindOne = vi.fn();
const mockTenantFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  MaterializedKMSConfig: {
    findOne: (...args: any[]) => ({
      lean: () => mockMaterializedFindOne(...args),
    }),
  },
  TenantKMSConfig: {
    findOne: (...args: any[]) => ({
      lean: () => mockTenantFindOne(...args),
    }),
  },
}));

const { KMSResolver } = await import('@agent-platform/database/kms');

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT = 'tenant-1';
const PROJECT = 'project-1';
const ENV = 'dev';

const MATERIALIZED_DOC = {
  _id: 'mat-1',
  tenantId: TENANT,
  projectId: PROJECT,
  environment: ENV,
  resolvedProvider: {
    providerType: 'aws-kms',
    keyId: 'arn:aws:kms:us-east-1:123:key/abc',
    region: 'us-east-1',
    vaultUrl: null,
    externalEndpoint: null,
    authMethod: 'default-credentials',
    authConfigEncrypted: null,
  },
  resolvedKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
  dekEpochIntervalHours: 12,
  dekMaxUsageCount: 1_000_000,
  failurePolicy: 'fail-closed',
  sourceConfigVersion: 3,
};

const TENANT_KMS_DOC = {
  _id: 'cfg-1',
  tenantId: TENANT,
  defaultProvider: {
    providerType: 'aws-kms',
    keyId: 'arn:aws:kms:us-east-1:123:key/abc',
    region: 'us-east-1',
    vaultUrl: null,
    externalEndpoint: null,
    authMethod: 'default-credentials',
    authConfigEncrypted: null,
  },
  dekEpochIntervalHours: 12,
  dekMaxUsageCount: 1_000_000,
  failurePolicy: 'fail-closed',
  _v: 3,
};

// =============================================================================
// TESTS
// =============================================================================

describe('KMSResolver', () => {
  let resolver: InstanceType<typeof KMSResolver>;

  beforeEach(() => {
    resolver = new KMSResolver({ cacheTtlMs: 1000 });
    mockMaterializedFindOne.mockReset();
    mockTenantFindOne.mockReset();
  });

  afterEach(() => {
    resolver.clearCache();
  });

  describe('resolve', () => {
    it('should return config from MaterializedKMSConfig when available', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(MATERIALIZED_DOC);

      const result = await resolver.resolve(TENANT, PROJECT, ENV);

      expect(result.provider.providerType).toBe('aws-kms');
      expect(result.keyId).toBe('arn:aws:kms:us-east-1:123:key/abc');
      expect(result.dekEpochIntervalHours).toBe(12);
      expect(result.dekMaxUsageCount).toBe(1_000_000);
      expect(result.sourceConfigVersion).toBe(3);
      // Should NOT have queried TenantKMSConfig
      expect(mockTenantFindOne).not.toHaveBeenCalled();
    });

    it('should fall back to TenantKMSConfig when no materialized doc', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(null);
      mockTenantFindOne.mockResolvedValueOnce(TENANT_KMS_DOC);

      const result = await resolver.resolve(TENANT, PROJECT, ENV);

      expect(result.provider.providerType).toBe('aws-kms');
      expect(result.dekEpochIntervalHours).toBe(12);
      expect(result.dekMaxUsageCount).toBe(1_000_000);
    });

    it('should cache result in L1 on second call', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(MATERIALIZED_DOC);

      // First call — hits MongoDB
      await resolver.resolve(TENANT, PROJECT, ENV);
      expect(mockMaterializedFindOne).toHaveBeenCalledTimes(1);

      // Second call — L1 cache hit
      const result = await resolver.resolve(TENANT, PROJECT, ENV);
      expect(mockMaterializedFindOne).toHaveBeenCalledTimes(1); // No additional call
      expect(result.provider.providerType).toBe('aws-kms');
    });

    it('should return platform default when no config exists', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(null);
      mockTenantFindOne.mockResolvedValueOnce(null);

      const result = await resolver.resolve(TENANT, PROJECT, ENV);

      expect(result.provider.providerType).toBe('local');
      expect(result.keyId).toBe('platform-default');
      expect(result.dekEpochIntervalHours).toBe(24);
      expect(result.dekMaxUsageCount).toBe(2 ** 30);
      expect(result.sourceConfigVersion).toBe(0);
    });

    it('should surface lookup errors when MongoDB throws', async () => {
      mockMaterializedFindOne.mockRejectedValueOnce(new Error('connection refused'));
      mockTenantFindOne.mockRejectedValueOnce(new Error('connection refused'));

      await expect(resolver.resolve(TENANT, PROJECT, ENV)).rejects.toThrow(
        'KMS resolution failed for tenant=tenant-1, project=project-1, environment=dev.',
      );
    });

    it('should use default projectId and environment when not provided', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(null);
      mockTenantFindOne.mockResolvedValueOnce(TENANT_KMS_DOC);

      await resolver.resolve(TENANT);

      // Should have queried with defaults
      expect(mockMaterializedFindOne).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: '_tenant',
        environment: '_shared',
      });
    });

    it('should resolve different scopes independently', async () => {
      mockMaterializedFindOne.mockResolvedValueOnce(MATERIALIZED_DOC).mockResolvedValueOnce(null);
      mockTenantFindOne.mockResolvedValueOnce(null);

      const r1 = await resolver.resolve(TENANT, 'project-1', 'dev');
      const r2 = await resolver.resolve(TENANT, 'project-2', 'staging');

      expect(r1.provider.providerType).toBe('aws-kms');
      expect(r2.provider.providerType).toBe('local'); // platform default
    });
  });

  describe('L1 cache TTL', () => {
    it('should expire cache entries after TTL', async () => {
      mockMaterializedFindOne.mockResolvedValue(MATERIALIZED_DOC);

      // Short TTL resolver
      const shortResolver = new KMSResolver({ cacheTtlMs: 50 });

      await shortResolver.resolve(TENANT, PROJECT, ENV);
      expect(mockMaterializedFindOne).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 60));

      await shortResolver.resolve(TENANT, PROJECT, ENV);
      expect(mockMaterializedFindOne).toHaveBeenCalledTimes(2);

      shortResolver.clearCache();
    });
  });

  describe('evictTenant', () => {
    it('should evict all cached configs for a tenant', async () => {
      mockMaterializedFindOne.mockResolvedValue(MATERIALIZED_DOC);

      await resolver.resolve(TENANT, 'p1', 'dev');
      await resolver.resolve(TENANT, 'p2', 'staging');
      expect(resolver.cacheSize).toBe(2);

      resolver.evictTenant(TENANT);
      expect(resolver.cacheSize).toBe(0);
    });

    it('should not evict other tenants', async () => {
      mockMaterializedFindOne.mockResolvedValue(MATERIALIZED_DOC);

      await resolver.resolve('tenant-A', PROJECT, ENV);
      await resolver.resolve('tenant-B', PROJECT, ENV);
      expect(resolver.cacheSize).toBe(2);

      resolver.evictTenant('tenant-A');
      expect(resolver.cacheSize).toBe(1);
    });
  });

  describe('getPlatformDefault', () => {
    it('should return a copy of the platform default', () => {
      const d1 = KMSResolver.getPlatformDefault();
      const d2 = KMSResolver.getPlatformDefault();

      expect(d1.provider.providerType).toBe('local');
      expect(d1.dekEpochIntervalHours).toBe(24);
      expect(d1.dekMaxUsageCount).toBe(2 ** 30);
      expect(d1).not.toBe(d2); // Different object references
    });
  });
});
