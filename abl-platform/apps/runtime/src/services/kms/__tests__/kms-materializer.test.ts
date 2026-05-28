/**
 * KMS Materializer Tests
 *
 * Validates: 5-level config inheritance chain, scope enumeration,
 * stale config cleanup, reconcileAll.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockTenantConfigFindOne = vi.fn();
const mockTenantConfigFind = vi.fn();
const mockMaterializedFindOneAndUpdate = vi.fn();
const mockMaterializedFind = vi.fn();
const mockMaterializedDeleteMany = vi.fn();
const mockDeploymentFind = vi.fn();
const mockProjectAgentFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantKMSConfig: {
    findOne: (...args: any[]) => ({
      lean: () => mockTenantConfigFindOne(...args),
    }),
    find: (...args: any[]) => ({
      lean: () => mockTenantConfigFind(...args),
    }),
  },
  MaterializedKMSConfig: {
    findOneAndUpdate: (...args: any[]) => mockMaterializedFindOneAndUpdate(...args),
    find: (...args: any[]) => ({
      lean: () => mockMaterializedFind(...args),
    }),
    deleteMany: (...args: any[]) => mockMaterializedDeleteMany(...args),
  },
  Deployment: {
    find: (...args: any[]) => ({
      lean: () => mockDeploymentFind(...args),
    }),
  },
  ProjectAgent: {
    find: (...args: any[]) => ({
      lean: () => mockProjectAgentFind(...args),
    }),
  },
}));

const { KMSMaterializer } = await import('../kms-materializer.js');

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT = 'tenant-1';

const TENANT_CONFIG = {
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
  environments: [],
  projects: [],
  dekEpochIntervalHours: 24,
  dekMaxUsageCount: 2 ** 30,
  dekRetentionDays: null,
  kekRotationPeriodDays: 365,
  failurePolicy: 'fail-closed',
  _v: 2,
};

// =============================================================================
// TESTS
// =============================================================================

describe('KMSMaterializer', () => {
  let materializer: InstanceType<typeof KMSMaterializer>;

  beforeEach(() => {
    materializer = new KMSMaterializer();
    vi.clearAllMocks();
  });

  describe('materialize', () => {
    it('should delete materialized docs when no tenant config exists', async () => {
      mockTenantConfigFindOne.mockResolvedValueOnce(null);
      mockMaterializedDeleteMany.mockResolvedValueOnce({ deletedCount: 0 });

      const count = await materializer.materialize(TENANT);

      expect(count).toBe(0);
      expect(mockMaterializedDeleteMany).toHaveBeenCalledWith({ tenantId: TENANT });
    });

    it('should materialize active scopes from deployments', async () => {
      mockTenantConfigFindOne.mockResolvedValueOnce(TENANT_CONFIG);
      mockDeploymentFind.mockResolvedValueOnce([
        { projectId: 'p1', environment: 'dev' },
        { projectId: 'p1', environment: 'staging' },
      ]);
      mockProjectAgentFind.mockResolvedValueOnce([]);
      mockMaterializedFindOneAndUpdate.mockResolvedValue({});
      mockMaterializedFind.mockResolvedValueOnce([]);

      const count = await materializer.materialize(TENANT);

      expect(count).toBe(2);
      expect(mockMaterializedFindOneAndUpdate).toHaveBeenCalledTimes(2);

      // Verify first upsert used tenant default provider
      const firstCall = mockMaterializedFindOneAndUpdate.mock.calls[0];
      expect(firstCall[0]).toEqual({
        tenantId: TENANT,
        projectId: 'p1',
        environment: 'dev',
      });
      expect(firstCall[1].$set.resolvedProvider.providerType).toBe('aws-kms');
    });

    it('should use 5-level resolution: project+env override wins', async () => {
      const configWithOverrides = {
        ...TENANT_CONFIG,
        projects: [
          {
            projectId: 'p1',
            defaultProvider: null,
            environments: [
              {
                environment: 'production',
                provider: {
                  providerType: 'azure-managed-hsm',
                  keyId: 'prod-hsm-key',
                  region: null,
                  vaultUrl: 'https://myhsm.managedhsm.azure.net',
                  externalEndpoint: null,
                  authMethod: 'managed-identity',
                  authConfigEncrypted: null,
                },
              },
            ],
          },
        ],
      };

      mockTenantConfigFindOne.mockResolvedValueOnce(configWithOverrides);
      mockDeploymentFind.mockResolvedValueOnce([{ projectId: 'p1', environment: 'production' }]);
      mockProjectAgentFind.mockResolvedValueOnce([]);
      mockMaterializedFindOneAndUpdate.mockResolvedValue({});
      mockMaterializedFind.mockResolvedValueOnce([]);

      await materializer.materialize(TENANT);

      const upsertCall = mockMaterializedFindOneAndUpdate.mock.calls[0];
      expect(upsertCall[1].$set.resolvedProvider.providerType).toBe('azure-managed-hsm');
    });

    it('should clean up stale materialized docs', async () => {
      mockTenantConfigFindOne.mockResolvedValueOnce(TENANT_CONFIG);
      mockDeploymentFind.mockResolvedValueOnce([{ projectId: 'p1', environment: 'dev' }]);
      mockProjectAgentFind.mockResolvedValueOnce([]);
      mockMaterializedFindOneAndUpdate.mockResolvedValue({});
      // Return a stale doc that's not in active scopes
      mockMaterializedFind.mockResolvedValueOnce([
        { _id: 'stale-1', projectId: 'p-removed', environment: 'dev' },
      ]);
      mockMaterializedDeleteMany.mockResolvedValueOnce({ deletedCount: 1 });

      await materializer.materialize(TENANT);

      expect(mockMaterializedDeleteMany).toHaveBeenCalledWith({
        _id: { $in: ['stale-1'] },
      });
    });
  });

  describe('reconcileAll', () => {
    it('should materialize all tenants with KMS configs', async () => {
      mockTenantConfigFind.mockResolvedValueOnce([
        { tenantId: 'tenant-A' },
        { tenantId: 'tenant-B' },
      ]);

      // Each tenant's materialize call
      mockTenantConfigFindOne.mockResolvedValue(TENANT_CONFIG);
      mockDeploymentFind.mockResolvedValue([]);
      mockProjectAgentFind.mockResolvedValue([]);
      mockMaterializedFind.mockResolvedValue([]);

      const total = await materializer.reconcileAll();

      expect(total).toBe(0); // No active scopes → 0 upserts
      expect(mockTenantConfigFindOne).toHaveBeenCalledTimes(2);
    });
  });
});
