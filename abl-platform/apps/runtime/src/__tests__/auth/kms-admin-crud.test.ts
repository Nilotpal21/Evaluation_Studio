/**
 * KMS Admin Route -- CRUD / Business Logic Tests
 *
 * Tests the actual endpoint logic (GET /config, PUT /config, GET /keys,
 * POST /keys/rotate, GET /health) with all middleware and external deps
 * mocked out. Authorization is tested separately in kms-admin-authz.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// MOCKS -- declared before any import that transitively pulls in the modules
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/feature-gate.js', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// --- Hoisted mocks (must be declared via vi.hoisted to survive vi.mock hoisting) ---
const {
  mockTenantKMSConfig,
  mockDEKEntry,
  mockMaterialize,
  mockResolve,
  mockEnqueueReencryption,
  mockValidateExternalKMSEndpoint,
  mockGetKMSProviderPool,
  mockIsKMSProviderPoolAvailable,
  mockVerifyProviderReadiness,
  mockComputeFingerprint,
  mockGetClickHouseClient,
  mockGetEncryptionFacade,
  mockLogKMSAuditEvent,
  globalResolverState,
} = vi.hoisted(() => {
  const state = { resolver: null as any };
  return {
    mockTenantKMSConfig: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    mockDEKEntry: {
      find: vi.fn(),
      countDocuments: vi.fn(),
      updateMany: vi.fn(),
      distinct: vi.fn(),
    },
    mockMaterialize: vi.fn().mockResolvedValue(undefined),
    mockResolve: vi.fn(),
    mockEnqueueReencryption: vi.fn(),
    mockValidateExternalKMSEndpoint: vi.fn(),
    mockGetKMSProviderPool: vi.fn(),
    mockIsKMSProviderPoolAvailable: vi.fn(),
    mockVerifyProviderReadiness: vi.fn(),
    mockComputeFingerprint: vi.fn(),
    mockGetClickHouseClient: vi.fn(),
    mockGetEncryptionFacade: vi.fn(() => null),
    mockLogKMSAuditEvent: vi.fn(),
    globalResolverState: state,
  };
});

// --- Database models ---
vi.mock('@agent-platform/database/models', () => ({
  TenantKMSConfig: mockTenantKMSConfig,
  DEKEntry: mockDEKEntry,
}));

// --- KMS services ---
vi.mock('../../services/kms/kms-materializer.js', () => {
  return {
    KMSMaterializer: class {
      materialize = mockMaterialize;
    },
  };
});

vi.mock('../../services/kms/kms-resolver.js', () => {
  return {
    KMSResolver: class {
      resolve = mockResolve;
    },
  };
});

vi.mock('../../services/kms/kms-audit-logger.js', () => ({
  logKMSAuditEvent: mockLogKMSAuditEvent,
}));

vi.mock('../../services/kms/reencryption-queue.js', () => ({
  enqueueReencryption: mockEnqueueReencryption,
}));

vi.mock('../../services/kms/external-kms-validator.js', () => ({
  validateExternalKMSEndpoint: mockValidateExternalKMSEndpoint,
}));

vi.mock('@agent-platform/database/kms', () => ({
  getKMSProviderPool: mockGetKMSProviderPool,
  isKMSProviderPoolAvailable: mockIsKMSProviderPoolAvailable,
  verifyProviderReadiness: mockVerifyProviderReadiness,
  computeFingerprint: mockComputeFingerprint,
  encryptAuthConfig: vi.fn().mockResolvedValue('encrypted-base64-blob'),
  setGlobalKMSResolver: (r: any) => {
    globalResolverState.resolver = r;
  },
  clearGlobalKMSResolver: () => {
    globalResolverState.resolver = null;
  },
  getGlobalKMSResolver: () => globalResolverState.resolver,
  KMSResolver: class {
    resolve = mockResolve;
    evictTenant = vi.fn();
    publishInvalidation = vi.fn().mockResolvedValue(undefined);
    clearCache = vi.fn();
    static getPlatformDefault = vi.fn().mockReturnValue({
      provider: { providerType: 'local', keyId: 'platform-default' },
      keyId: 'platform-default',
      failurePolicy: 'fail-closed',
      sourceConfigVersion: 0,
    });
  },
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: mockGetClickHouseClient,
  toClickHouseDateTime: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d.toISOString().replace('T', ' ').replace('Z', '');
  },
  toClickHouseDateTimeSec: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
  },
}));

vi.mock('@agent-platform/shared-encryption', () => ({
  getEncryptionFacade: mockGetEncryptionFacade,
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedisHandle: () => null,
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import request from 'supertest';
import kmsAdminRouter from '../../routes/kms-admin.js';

// =============================================================================
// HELPERS
// =============================================================================

const TENANT_ID = 'tenant-crud-test';
const BASE_PATH = `/api/tenants/${TENANT_ID}/kms`;

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tenants/:tenantId/kms', kmsAdminRouter);
  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('KMS Admin Route -- CRUD Business Logic', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up a default global resolver for tests
    globalResolverState.resolver = {
      resolve: mockResolve,
      evictTenant: vi.fn(),
      publishInvalidation: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn(),
    };
    // Default findOne mock: returns null via .lean() chain (no existing config)
    mockTenantKMSConfig.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockGetEncryptionFacade.mockReturnValue(null);
    mockLogKMSAuditEvent.mockReset();
    mockDEKEntry.distinct.mockResolvedValue([]);
    mockComputeFingerprint.mockImplementation(
      (provider: any) =>
        `${provider.providerType}:${provider.keyId ?? provider.vaultUrl ?? 'default'}`,
    );
    mockVerifyProviderReadiness.mockResolvedValue({
      healthy: true,
      providerType: 'aws-kms',
      latencyMs: 18,
      cryptoVerified: true,
      cryptoProbeLatencyMs: 6,
      checkedKeyId: 'tenant-kek',
      healthLatencyMs: 12,
    });
    app = createTestApp();
  });

  afterEach(async () => {
    const { clearGlobalKMSResolver } = await import('@agent-platform/database/kms');
    clearGlobalKMSResolver();
  });

  // ===========================================================================
  // GET /config
  // ===========================================================================

  describe('GET /config', () => {
    it('should return unconfigured status when no config exists', async () => {
      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app).get(`${BASE_PATH}/config`);

      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(false);
      expect(res.body.data.usingDefault).toBe(true);
      expect(res.body.data.tenantId).toBe(TENANT_ID);
      expect(res.body.data.platformDefaultProvider).toBeUndefined();
    });

    it('should surface the configured platform default provider when tenant config is absent', async () => {
      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      const { KMSResolver } = await import('@agent-platform/database/kms');
      vi.mocked(KMSResolver.getPlatformDefault).mockReturnValue({
        provider: {
          providerType: 'azure-keyvault',
          keyId: 'platform-kek',
          region: null,
          vaultUrl: 'https://platform-kms.vault.azure.net',
          externalEndpoint: null,
          authMethod: 'default-credentials',
          authConfigEncrypted: null,
        },
        keyId: 'platform-kek',
        dekEpochIntervalHours: 24,
        dekMaxUsageCount: 2 ** 30,
        failurePolicy: 'fail-closed',
        sourceConfigVersion: 0,
      });

      const res = await request(app).get(`${BASE_PATH}/config`);

      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain('Azure Key Vault');
      expect(res.body.data.platformDefaultProvider).toBeUndefined();
    });

    it('should return sanitized config when config exists', async () => {
      const storedConfig = {
        _id: 'mongo-id-123',
        __v: 0,
        tenantId: TENANT_ID,
        defaultProvider: {
          providerType: 'aws-kms',
          authConfigEncrypted: 'secret-cipher-text',
        },
        dekEpochIntervalHours: 24,
      };

      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(storedConfig),
      });

      const res = await request(app).get(`${BASE_PATH}/config`);

      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.tenantId).toBe(TENANT_ID);
      // authConfigEncrypted must be redacted
      expect(res.body.data.defaultProvider.authConfigEncrypted).toBe('[REDACTED]');
      // Internal MongoDB fields must be stripped
      expect(res.body.data._id).toBeUndefined();
      expect(res.body.data.__v).toBeUndefined();
    });

    it('should handle database errors gracefully', async () => {
      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      });

      const res = await request(app).get(`${BASE_PATH}/config`);

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({
        code: 'KMS_CONFIG_ERROR',
        message: 'Failed to retrieve KMS configuration',
      });
    });

    it('should resolve effective scoped config details', async () => {
      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          tenantId: TENANT_ID,
          defaultProvider: { providerType: 'local', keyId: 'platform-default' },
          environments: [
            {
              environment: 'prod',
              provider: {
                providerType: 'aws-kms',
                keyId: 'tenant-env-key',
                region: 'us-east-1',
              },
            },
          ],
          projects: [
            {
              projectId: 'project-a',
              defaultProvider: {
                providerType: 'azure-keyvault',
                keyId: 'project-key',
                vaultUrl: 'https://vault.example',
              },
              environments: [
                {
                  environment: 'prod',
                  provider: {
                    providerType: 'external',
                    keyId: 'external-prod',
                    externalEndpoint: 'https://kms.example.com',
                    authMethod: 'api-key',
                  },
                },
              ],
            },
          ],
        }),
      });
      mockResolve.mockResolvedValue({
        provider: {
          providerType: 'external',
          keyId: 'external-prod',
          externalEndpoint: 'https://kms.example.com',
          authMethod: 'api-key',
        },
        keyId: 'external-prod',
        failurePolicy: 'fail-closed',
        sourceConfigVersion: 9,
      });

      const res = await request(app).get(
        `${BASE_PATH}/config/resolve?projectId=project-a&environment=prod`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.source).toBe('project_environment');
      expect(res.body.data.provider).toEqual(
        expect.objectContaining({
          providerType: 'external',
          keyId: 'external-prod',
        }),
      );
      expect(res.body.data.chain).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'project_environment', matched: true }),
          expect.objectContaining({ source: 'tenant_environment', matched: false }),
        ]),
      );
    });
  });

  // ===========================================================================
  // PUT /config
  // ===========================================================================

  describe('PUT /config', () => {
    const validBody = {
      defaultProvider: {
        providerType: 'aws-kms',
        keyId: 'arn:aws:kms:...',
        region: 'us-east-1',
      },
      byokEnabled: true,
      complianceLevel: 'hipaa',
      failurePolicy: 'fail-closed',
    };

    const savedConfig = {
      _id: 'mongo-id-456',
      __v: 1,
      tenantId: TENANT_ID,
      defaultProvider: {
        providerType: 'aws-kms',
        keyId: 'arn:aws:kms:...',
        region: 'us-east-1',
      },
      dekEpochIntervalHours: 24,
      byokEnabled: true,
    };

    it('should create new config via upsert', async () => {
      mockTenantKMSConfig.findOne
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(null),
        })
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(savedConfig),
        });
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      const res = await request(app).put(`${BASE_PATH}/config`).send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.tenantId).toBe(TENANT_ID);
      expect(res.body.data.configActive).toBe(true);

      // Verify findOneAndUpdate was called with correct filter and $set
      expect(mockTenantKMSConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: TENANT_ID },
        expect.objectContaining({
          $set: expect.objectContaining({
            tenantId: TENANT_ID,
            defaultProvider: expect.objectContaining({
              providerType: 'aws-kms',
              keyId: 'arn:aws:kms:...',
            }),
            byokEnabled: true,
            complianceLevel: 'hipaa',
            failurePolicy: 'fail-closed',
          }),
        }),
        { upsert: true, new: true, lean: true },
      );
    });

    it('should invalidate cache after save', async () => {
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);
      const resolver = globalResolverState.resolver;

      await request(app).put(`${BASE_PATH}/config`).send(validBody);

      // Materialization is deprecated — cache invalidation replaced it
      expect(resolver.evictTenant).toHaveBeenCalledWith(TENANT_ID);
    });

    it('should invalidate cache via global KMS resolver', async () => {
      const mockEvictTenant = vi.fn();
      const mockPublishInvalidation = vi.fn().mockResolvedValue(undefined);
      const { setGlobalKMSResolver } = await import('@agent-platform/database/kms');
      setGlobalKMSResolver({
        evictTenant: mockEvictTenant,
        publishInvalidation: mockPublishInvalidation,
      } as any);

      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      await request(app).put(`${BASE_PATH}/config`).send(validBody);

      expect(mockEvictTenant).toHaveBeenCalledWith(TENANT_ID);
      expect(mockPublishInvalidation).toHaveBeenCalledWith(TENANT_ID);
    });

    it('should increment _v (not __v)', async () => {
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      await request(app).put(`${BASE_PATH}/config`).send(validBody);

      const callArgs = mockTenantKMSConfig.findOneAndUpdate.mock.calls[0];
      const updateDoc = callArgs[1];
      expect(updateDoc.$inc).toEqual({ _v: 1 });
    });

    it('should handle findOneAndUpdate failure', async () => {
      mockTenantKMSConfig.findOneAndUpdate.mockRejectedValue(new Error('Write conflict'));

      const res = await request(app)
        .put(`${BASE_PATH}/config`)
        .send({ defaultProvider: { providerType: 'local', keyId: 'platform-default' } });

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({
        code: 'KMS_CONFIG_ERROR',
        message: 'Failed to update KMS configuration',
      });
    });

    it('should reject tenant environment cloud provider when BYOK is disabled', async () => {
      const res = await request(app)
        .put(`${BASE_PATH}/config`)
        .send({
          environments: [
            {
              environment: 'prod',
              provider: {
                providerType: 'aws-kms',
                keyId: 'arn:aws:kms:region:acct:key/123',
                region: 'us-east-1',
              },
            },
          ],
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KMS_BYOK_DISABLED');
    });
  });

  // ===========================================================================
  // Scoped config
  // ===========================================================================

  describe('scoped config management', () => {
    it('should reject project-level cloud provider when tenant BYOK is disabled', async () => {
      mockTenantKMSConfig.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          tenantId: TENANT_ID,
          byokEnabled: false,
          byopEnabled: false,
          projects: [],
          environments: [],
          _v: 4,
        }),
      });

      const res = await request(app)
        .put(`${BASE_PATH}/config/projects/project-a`)
        .send({
          defaultProvider: {
            providerType: 'aws-kms',
            keyId: 'arn:aws:kms:region:acct:key/project-a',
            region: 'us-east-1',
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KMS_BYOK_DISABLED');
    });

    it('should upsert tenant environment override without storing tier metadata', async () => {
      const existingConfig = {
        tenantId: TENANT_ID,
        defaultProvider: { providerType: 'local', keyId: 'platform-default' },
        environments: [],
        projects: [],
        _v: 3,
      };
      const savedConfig = {
        ...existingConfig,
        environments: [
          {
            environment: 'prod',
            provider: { providerType: 'local', keyId: 'platform-default' },
          },
        ],
      };

      mockTenantKMSConfig.findOne
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(existingConfig),
        })
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(savedConfig),
        });
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      const res = await request(app)
        .put(`${BASE_PATH}/config/environments/prod`)
        .send({ provider: { providerType: 'local', keyId: 'platform-default' } });

      expect(res.status).toBe(200);
      expect(mockTenantKMSConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, _v: 3 },
        expect.objectContaining({
          $set: expect.objectContaining({
            environments: [
              expect.objectContaining({
                environment: 'prod',
                provider: expect.objectContaining({
                  providerType: 'local',
                  keyId: 'platform-default',
                }),
              }),
            ],
          }),
        }),
        { upsert: false, new: true, lean: true },
      );
    });

    it('should delete project environment override and prune empty project scope', async () => {
      const existingConfig = {
        tenantId: TENANT_ID,
        defaultProvider: { providerType: 'local', keyId: 'platform-default' },
        environments: [],
        projects: [
          {
            projectId: 'project-a',
            defaultProvider: null,
            environments: [
              {
                environment: 'prod',
                provider: { providerType: 'local', keyId: 'platform-default' },
              },
            ],
          },
        ],
        _v: 8,
      };
      const savedConfig = {
        ...existingConfig,
        projects: [],
      };

      mockTenantKMSConfig.findOne
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(existingConfig),
        })
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(savedConfig),
        });
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      const res = await request(app).delete(
        `${BASE_PATH}/config/projects/project-a/environments/prod`,
      );

      expect(res.status).toBe(200);
      expect(mockTenantKMSConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, _v: 8 },
        expect.objectContaining({
          $set: expect.objectContaining({
            projects: [],
          }),
        }),
        { upsert: false, new: true, lean: true },
      );
    });

    it('should audit tenant environment override deletion', async () => {
      const existingConfig = {
        tenantId: TENANT_ID,
        defaultProvider: { providerType: 'local', keyId: 'platform-default' },
        environments: [
          {
            environment: 'prod',
            provider: { providerType: 'local', keyId: 'platform-default' },
          },
        ],
        projects: [],
        _v: 2,
      };
      const savedConfig = {
        ...existingConfig,
        environments: [],
      };

      mockTenantKMSConfig.findOne
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(existingConfig),
        })
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue(savedConfig),
        });
      mockTenantKMSConfig.findOneAndUpdate.mockResolvedValue(savedConfig);

      const res = await request(app).delete(`${BASE_PATH}/config/environments/prod`);

      expect(res.status).toBe(200);
      expect(mockLogKMSAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          operation: 'tenant_environment_config_delete',
          environment: 'prod',
          success: true,
        }),
      );
    });
  });

  // ===========================================================================
  // GET /keys
  // ===========================================================================

  describe('GET /keys', () => {
    const sampleDEKs = [
      {
        _id: 'dek-2',
        dekId: 'dek-2',
        tenantId: TENANT_ID,
        projectId: '_tenant',
        environment: '_tenant',
        epoch: 2,
        kekKeyId: 'platform-default',
        kekKeyVersion: 4,
        status: 'active',
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
      {
        _id: 'dek-1',
        dekId: 'dek-1',
        tenantId: TENANT_ID,
        projectId: '_tenant',
        environment: '_tenant',
        epoch: 1,
        kekKeyId: 'platform-default',
        kekKeyVersion: 3,
        status: 'decrypt_only',
        createdAt: '2026-04-08T00:00:00.000Z',
        updatedAt: '2026-04-08T00:00:00.000Z',
      },
    ];

    it('should list DEKs for tenant', async () => {
      const mockLean = vi.fn().mockResolvedValue(sampleDEKs);
      const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
      const mockSelect = vi.fn().mockReturnValue({ sort: mockSort });

      mockDEKEntry.find.mockReturnValue({ select: mockSelect });
      mockDEKEntry.countDocuments
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
      mockDEKEntry.distinct
        .mockResolvedValueOnce(['project-a', '_tenant'])
        .mockResolvedValueOnce(['prod', '_tenant']);

      const res = await request(app).get(`${BASE_PATH}/keys`);

      expect(res.status).toBe(200);
      expect(res.body.data.entries).toEqual([
        expect.objectContaining({
          _id: 'dek-2',
          id: 'dek-2',
          dekId: 'dek-2',
          tenantId: TENANT_ID,
          epoch: 2,
          status: 'active',
          wrappingProvider: {
            providerType: 'local',
            keyId: 'platform-default',
            region: null,
            vaultUrl: null,
            externalEndpoint: null,
            authMethod: null,
          },
        }),
        expect.objectContaining({
          _id: 'dek-1',
          id: 'dek-1',
          dekId: 'dek-1',
          tenantId: TENANT_ID,
          epoch: 1,
          status: 'decrypt_only',
          wrappingProvider: {
            providerType: 'local',
            keyId: 'platform-default',
            region: null,
            vaultUrl: null,
            externalEndpoint: null,
            authMethod: null,
          },
        }),
      ]);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.hasMore).toBe(false);
      expect(res.body.data.summary).toEqual({
        total: 2,
        activeCount: 1,
        decryptOnlyCount: 1,
        destroyedCount: 0,
        expiringSoonCount: 1,
        latestCreatedAt: '2026-04-09T00:00:00.000Z',
      });
      expect(res.body.data.filters).toEqual({
        statuses: [
          { status: 'active', count: 1 },
          { status: 'decrypt_only', count: 1 },
          { status: 'destroyed', count: 0 },
        ],
        projects: ['project-a', '_tenant'],
        environments: ['prod', '_tenant'],
      });
    });

    it('should never expose wrappedDek', async () => {
      const mockLean = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
      const mockSelect = vi.fn().mockReturnValue({ sort: mockSort });

      mockDEKEntry.find.mockReturnValue({ select: mockSelect });
      mockDEKEntry.countDocuments.mockResolvedValue(0);

      await request(app).get(`${BASE_PATH}/keys`);

      expect(mockSelect).toHaveBeenCalledWith('-wrappedDek');
    });

    it('should respect limit and offset', async () => {
      const mockLean = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
      const mockSelect = vi.fn().mockReturnValue({ sort: mockSort });

      mockDEKEntry.find.mockReturnValue({ select: mockSelect });
      mockDEKEntry.countDocuments.mockResolvedValue(0);

      await request(app).get(`${BASE_PATH}/keys?limit=10&offset=20`);

      expect(mockSkip).toHaveBeenCalledWith(20);
      expect(mockLimit).toHaveBeenCalledWith(10);
    });
  });

  // ===========================================================================
  // POST /keys/rotate
  // ===========================================================================

  describe('POST /keys/rotate', () => {
    it('should rotate active DEKs to decrypt_only', async () => {
      mockEnqueueReencryption.mockResolvedValue('job-abc');
      mockDEKEntry.updateMany.mockResolvedValue({ modifiedCount: 3 });

      await request(app).post(`${BASE_PATH}/keys/rotate`).send({ reason: 'key-compromise' });

      expect(mockDEKEntry.updateMany).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, status: 'active' },
        { $set: { status: 'decrypt_only', retiredAt: expect.any(Date) } },
      );
    });

    it('should enqueue re-encryption job', async () => {
      mockEnqueueReencryption.mockResolvedValue('job-xyz');
      mockDEKEntry.updateMany.mockResolvedValue({ modifiedCount: 1 });

      await request(app).post(`${BASE_PATH}/keys/rotate`).send({ reason: 'kek-age-exceeded' });

      expect(mockEnqueueReencryption).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          reason: 'kek-age-exceeded',
        }),
      );
    });

    it('should scope rotation to project and environment when provided', async () => {
      mockEnqueueReencryption.mockResolvedValue('job-scope');
      mockDEKEntry.updateMany.mockResolvedValue({ modifiedCount: 2 });

      await request(app).post(`${BASE_PATH}/keys/rotate`).send({
        reason: 'manual-rotation',
        projectId: 'project-a',
        environment: 'prod',
      });

      expect(mockEnqueueReencryption).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          reason: 'manual-rotation',
          projectId: 'project-a',
          environment: 'prod',
        }),
      );
      expect(mockDEKEntry.updateMany).toHaveBeenCalledWith(
        {
          tenantId: TENANT_ID,
          status: 'active',
          projectId: 'project-a',
          environment: 'prod',
        },
        { $set: { status: 'decrypt_only', retiredAt: expect.any(Date) } },
      );
    });

    it('should return rotation count and job ID', async () => {
      mockEnqueueReencryption.mockResolvedValue('job-123');
      mockDEKEntry.updateMany.mockResolvedValue({ modifiedCount: 5 });

      const res = await request(app)
        .post(`${BASE_PATH}/keys/rotate`)
        .send({ reason: 'manual-rotation' });

      expect(res.status).toBe(200);
      expect(res.body.data.rotated).toBe(5);
      expect(res.body.data.reencryptionJobId).toBe('job-123');
      expect(res.body.data.message).toContain('5 DEKs moved to decrypt_only');
    });

    it('should use tenant-wide facade sentinel when no scope is provided', async () => {
      const mockForceRotate = vi.fn().mockResolvedValue(4);
      mockGetEncryptionFacade.mockReturnValue({
        forceRotate: mockForceRotate,
      });
      mockEnqueueReencryption.mockResolvedValue('job-facade');

      const res = await request(app)
        .post(`${BASE_PATH}/keys/rotate`)
        .send({ reason: 'manual-rotation' });

      expect(res.status).toBe(200);
      expect(mockForceRotate).toHaveBeenCalledWith(TENANT_ID, undefined, undefined);
      expect(mockDEKEntry.updateMany).not.toHaveBeenCalled();
    });

    it('should reject invalid reason values', async () => {
      const res = await request(app)
        .post(`${BASE_PATH}/keys/rotate`)
        .send({ reason: 'invalid-reason' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASON');
    });

    it('should default to manual-rotation when reason omitted', async () => {
      mockEnqueueReencryption.mockResolvedValue('job-default');
      mockDEKEntry.updateMany.mockResolvedValue({ modifiedCount: 1 });

      await request(app).post(`${BASE_PATH}/keys/rotate`).send({});

      expect(mockEnqueueReencryption).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          reason: 'manual-rotation',
        }),
      );
    });
  });

  // ===========================================================================
  // GET /audit
  // ===========================================================================

  describe('GET /audit', () => {
    it('should return paginated audit rows, summary, and operation facets', async () => {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            {
              event_id: 'evt-1',
              timestamp: '2026-04-14 10:20:30.000',
              operation: 'config_update',
              key_id: 'tenant-kek',
              provider_type: 'azure-keyvault',
              actor_id: 'user-1',
              actor_type: 'user',
              success: 1,
              latency_ms: 48,
              metadata: '{"configActive":true}',
            },
          ]),
        })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([{ total: 42 }]),
        })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            {
              total: 42,
              success_count: 37,
              failure_count: 5,
              unique_keys: 3,
              unique_actors: 2,
              avg_latency_ms: 64,
              last_event_at: '2026-04-14 10:20:30.000',
            },
          ]),
        })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { operation: 'config_update', count: 30 },
            { operation: 'validate_external', count: 12 },
          ]),
        });

      mockGetClickHouseClient.mockReturnValue({ query: mockQuery });

      const res = await request(app).get(
        `${BASE_PATH}/audit?operation=config_update&success=success&startDate=2026-04-01&endDate=2026-04-14&limit=10&offset=20`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.entries).toHaveLength(1);
      expect(res.body.data.total).toBe(42);
      expect(res.body.data.limit).toBe(10);
      expect(res.body.data.offset).toBe(20);
      expect(res.body.data.hasMore).toBe(true);
      expect(res.body.data.summary).toEqual({
        total: 42,
        successCount: 37,
        failureCount: 5,
        uniqueKeys: 3,
        uniqueActors: 2,
        avgLatencyMs: 64,
        lastEventAt: '2026-04-14 10:20:30.000',
      });
      expect(res.body.data.operations).toEqual([
        { operation: 'config_update', count: 30 },
        { operation: 'validate_external', count: 12 },
      ]);

      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockQuery.mock.calls[0][0].query_params).toMatchObject({
        tenantId: TENANT_ID,
        operation: 'config_update',
        success: 1,
        startDate: '2026-04-01 00:00:00.000',
        endDate: '2026-04-14 23:59:59.999',
        limit: 10,
        offset: 20,
      });
      expect(mockQuery.mock.calls[1][0].query_params).toMatchObject({
        tenantId: TENANT_ID,
        operation: 'config_update',
        success: 1,
        startDate: '2026-04-01 00:00:00.000',
        endDate: '2026-04-14 23:59:59.999',
      });
      expect(mockQuery.mock.calls[3][0].query_params).toMatchObject({
        tenantId: TENANT_ID,
        startDate: '2026-04-01 00:00:00.000',
        endDate: '2026-04-14 23:59:59.999',
      });
    });

    it('should reject invalid audit date filters', async () => {
      const res = await request(app).get(`${BASE_PATH}/audit?startDate=not-a-date`);

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'INVALID_START_DATE',
        message: 'Invalid startDate. Expected YYYY-MM-DD or ISO timestamp.',
      });
    });

    it('should return an empty but well-formed payload when ClickHouse is unavailable', async () => {
      mockGetClickHouseClient.mockReturnValue({
        query: vi.fn().mockRejectedValue(new Error('ClickHouse offline')),
      });

      const res = await request(app).get(`${BASE_PATH}/audit`);

      expect(res.status).toBe(200);
      expect(res.body.data.entries).toEqual([]);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.hasMore).toBe(false);
      expect(res.body.data.operations).toEqual([]);
      expect(res.body.data.summary).toEqual({
        total: 0,
        successCount: 0,
        failureCount: 0,
        uniqueKeys: 0,
        uniqueActors: 0,
        avgLatencyMs: null,
        lastEventAt: null,
      });
      expect(res.body.data.message).toContain('ClickHouse');
    });
  });

  // ===========================================================================
  // GET /health
  // ===========================================================================

  describe('GET /health', () => {
    it('should return health with provider info', async () => {
      const mockGetProvider = vi.fn().mockResolvedValue({ providerType: 'aws-kms' });
      mockDEKEntry.find.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              wrappingProvider: { providerType: 'aws-kms', keyId: 'tenant-kek' },
            },
          ]),
        }),
      });

      mockResolve.mockResolvedValue({
        provider: { providerType: 'aws-kms', keyId: 'tenant-kek' },
        keyId: 'tenant-kek',
        failurePolicy: 'fail-closed',
      });
      mockIsKMSProviderPoolAvailable.mockReturnValue(true);
      mockGetKMSProviderPool.mockReturnValue({ getProvider: mockGetProvider });
      mockDEKEntry.countDocuments
        .mockResolvedValueOnce(3) // active
        .mockResolvedValueOnce(7); // decrypt_only

      const res = await request(app).get(`${BASE_PATH}/health`);

      expect(res.status).toBe(200);
      expect(res.body.data.healthy).toBe(true);
      expect(res.body.data.provider).toBe('aws-kms');
      expect(res.body.data.failurePolicy).toBe('fail-closed');
      expect(res.body.data.deks).toEqual({ active: 3, decryptOnly: 7 });
      expect(mockVerifyProviderReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ providerType: 'aws-kms' }),
        'tenant-kek',
      );
      expect(res.body.data.providerHealth).toEqual({
        healthy: true,
        providerType: 'aws-kms',
        latencyMs: 18,
        cryptoVerified: true,
        cryptoProbeLatencyMs: 6,
        checkedKeyId: 'tenant-kek',
        healthLatencyMs: 12,
      });
      expect(res.body.data.migration).toEqual({
        migrationActive: true,
        cryptoVerified: true,
        legacyLocalDekCount: 0,
        implicitLocalMetadataCount: 0,
        driftedDekCount: 0,
        authConfigDependencyCount: 0,
        localMasterKeyStillRequired: false,
        dekMigrationComplete: true,
        warnings: [],
      });
    });

    it('should return unhealthy when pool unavailable', async () => {
      mockResolve.mockResolvedValue({
        provider: { providerType: 'local' },
        failurePolicy: 'fail-closed',
      });
      mockIsKMSProviderPoolAvailable.mockReturnValue(false);

      const res = await request(app).get(`${BASE_PATH}/health`);

      expect(res.status).toBe(200);
      expect(res.body.data.healthy).toBe(false);
      expect(res.body.data.message).toBe('KMS provider pool not available');
    });

    it('should surface crypto probe failures as unhealthy', async () => {
      mockDEKEntry.find.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi
            .fn()
            .mockResolvedValue([
              { wrappingProvider: null },
              { wrappingProvider: { providerType: 'local', keyId: 'platform-default' } },
            ]),
        }),
      });
      mockResolve.mockResolvedValue({
        provider: { providerType: 'azure-keyvault' },
        keyId: 'azure-key',
        failurePolicy: 'fail-closed',
      });
      mockIsKMSProviderPoolAvailable.mockReturnValue(true);
      mockGetKMSProviderPool.mockReturnValue({
        getProvider: vi.fn().mockResolvedValue({ providerType: 'azure-keyvault' }),
      });
      mockVerifyProviderReadiness.mockResolvedValue({
        healthy: false,
        providerType: 'azure-keyvault',
        latencyMs: 51,
        message: 'wrapKey permission denied',
        cryptoVerified: false,
        cryptoProbeLatencyMs: 20,
        checkedKeyId: 'azure-key',
        healthLatencyMs: 7,
      });
      mockDEKEntry.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const res = await request(app).get(`${BASE_PATH}/health`);

      expect(res.status).toBe(200);
      expect(res.body.data.healthy).toBe(false);
      expect(res.body.data.providerHealth).toEqual({
        healthy: false,
        providerType: 'azure-keyvault',
        latencyMs: 51,
        message: 'wrapKey permission denied',
        cryptoVerified: false,
        cryptoProbeLatencyMs: 20,
        checkedKeyId: 'azure-key',
        healthLatencyMs: 7,
      });
      expect(res.body.data.migration).toEqual({
        migrationActive: true,
        cryptoVerified: false,
        legacyLocalDekCount: 2,
        implicitLocalMetadataCount: 1,
        driftedDekCount: 2,
        authConfigDependencyCount: 0,
        localMasterKeyStillRequired: true,
        dekMigrationComplete: false,
        warnings: [
          'Target provider failed the crypto readiness probe.',
          '2 DEK entries still depend on local wrapping or legacy local fallback.',
          '1 DEK entries are missing wrappingProvider metadata and still rely on local fallback semantics.',
          '2 active or decrypt-only DEKs do not match the current target provider fingerprint.',
        ],
      });
    });
  });
});
