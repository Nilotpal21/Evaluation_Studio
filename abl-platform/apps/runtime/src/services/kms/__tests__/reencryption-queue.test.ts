/**
 * Re-encryption Queue Tests
 *
 * Validates: enqueue behavior when Redis/env disabled,
 * shutdown safety, and jobId deduplication format.
 *
 * Uses vi.resetModules() + dynamic import() to reset module-level state
 * (initialized, bullQueue, bullWorker, shutdownRequested) between tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// =============================================================================
// MOCKS
// =============================================================================

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockGetRedisClient = vi.fn();
const mockTenantKMSConfigUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
const mockLogKMSAuditEvent = vi.fn();
const mockResolverResolve = vi.fn().mockResolvedValue({
  provider: { providerType: 'local', keyId: 'platform-default' },
  keyId: 'platform-default',
  sourceConfigVersion: 0,
});
let capturedWorkerProcessor: ((job: any) => Promise<void>) | null = null;

type FindChain = {
  select?: ReturnType<typeof vi.fn>;
  sort?: ReturnType<typeof vi.fn>;
  lean?: ReturnType<typeof vi.fn>;
};

const initialDekFindChain = {
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue([]),
} satisfies FindChain;
const mockDEKEntryFind = vi.fn().mockReturnValue(initialDekFindChain);

vi.mock('../../redis/redis-client.js', () => ({
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
  getRedisHandle: () => null,
}));

vi.mock('bullmq', () => {
  // Use real classes so `new Queue(...)` / `new Worker(...)` work correctly.
  class MockQueue {
    add(...args: unknown[]) {
      return mockQueueAdd(...args);
    }
    close() {
      return mockQueueClose();
    }
  }
  class MockWorker {
    constructor(_name: string, processor: (job: any) => Promise<void>) {
      capturedWorkerProcessor = processor;
    }
    on(...args: unknown[]) {
      return mockWorkerOn(...args);
    }
    close() {
      return mockWorkerClose();
    }
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock('@agent-platform/database/models', () => ({
  DEKEntry: {
    countDocuments: vi.fn().mockResolvedValue(0),
    find: (...args: unknown[]) => mockDEKEntryFind(...args),
  },
  TenantKMSConfig: {
    updateOne: (...args: unknown[]) => mockTenantKMSConfigUpdateOne(...args),
  },
}));

vi.mock('@agent-platform/database/kms', () => ({
  getKMSProviderPool: vi.fn().mockReturnValue({
    getProvider: vi.fn().mockResolvedValue({}),
  }),
  getGlobalKMSResolver: vi.fn(() => ({
    resolve: (...args: unknown[]) => mockResolverResolve(...args),
  })),
}));

vi.mock('../kms-audit-logger.js', () => ({
  logKMSAuditEvent: (...args: unknown[]) => mockLogKMSAuditEvent(...args),
}));

// =============================================================================
// FIXTURES
// =============================================================================

const JOB_PAYLOAD = {
  tenantId: 'tenant-abc',
  reason: 'manual-rotation' as const,
};

const SCOPED_JOB_PAYLOAD = {
  tenantId: 'tenant-abc',
  reason: 'manual-rotation' as const,
  projectId: 'project-a',
  environment: 'prod',
};

const PROVIDER_DRIFT_JOB_PAYLOAD = {
  tenantId: 'tenant-abc',
  reason: 'provider-drift' as const,
  dedupeKey: 'target-provider:azure-keyvault:https://kv-abl-dev.vault.azure.net/:abl-platform-kms',
};

// =============================================================================
// HELPERS
// =============================================================================

async function importFreshModule() {
  const mod = await import('../reencryption-queue.js');
  return mod;
}

// =============================================================================
// TESTS
// =============================================================================

describe('ReencryptionQueue', () => {
  const originalEnv = process.env.KMS_REENCRYPTION_QUEUE_ENABLED;

  beforeEach(() => {
    vi.resetModules();
    mockGetRedisClient.mockReset();
    mockQueueAdd.mockReset().mockResolvedValue({ id: 'job-1' });
    mockQueueClose.mockReset().mockResolvedValue(undefined);
    mockWorkerOn.mockReset();
    mockWorkerClose.mockReset().mockResolvedValue(undefined);
    mockTenantKMSConfigUpdateOne.mockReset().mockResolvedValue({ acknowledged: true });
    mockLogKMSAuditEvent.mockReset();
    mockResolverResolve.mockReset().mockResolvedValue({
      provider: { providerType: 'local', keyId: 'platform-default' },
      keyId: 'platform-default',
      sourceConfigVersion: 0,
    });
    capturedWorkerProcessor = null;
    mockDEKEntryFind.mockReset().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KMS_REENCRYPTION_QUEUE_ENABLED;
    } else {
      process.env.KMS_REENCRYPTION_QUEUE_ENABLED = originalEnv;
    }
  });

  // ===========================================================================
  // enqueueReencryption
  // ===========================================================================

  describe('enqueueReencryption', () => {
    it('should return null when Redis is unavailable', { timeout: 15_000 }, async () => {
      mockGetRedisClient.mockReturnValue(null);

      const { enqueueReencryption } = await importFreshModule();
      const result = await enqueueReencryption(JOB_PAYLOAD);

      expect(result).toBeNull();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('should return null when queue is disabled via env', async () => {
      process.env.KMS_REENCRYPTION_QUEUE_ENABLED = 'false';

      const { enqueueReencryption } = await importFreshModule();
      const result = await enqueueReencryption(JOB_PAYLOAD);

      expect(result).toBeNull();
      expect(mockGetRedisClient).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('should enqueue and return job id when Redis is available', async () => {
      mockGetRedisClient.mockReturnValue({
        duplicate: vi.fn().mockReturnValue({}),
      });

      const { enqueueReencryption } = await importFreshModule();
      const result = await enqueueReencryption(JOB_PAYLOAD);

      expect(result).toBe('job-1');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // shutdownReencryptionQueue
  // ===========================================================================

  describe('shutdownReencryptionQueue', () => {
    it('should be safe to call when not initialized', async () => {
      mockGetRedisClient.mockReturnValue(null);

      const { shutdownReencryptionQueue } = await importFreshModule();
      await expect(shutdownReencryptionQueue()).resolves.toBeUndefined();
    });

    it('should close worker and queue when initialized', async () => {
      mockGetRedisClient.mockReturnValue({
        duplicate: vi.fn().mockReturnValue({}),
      });

      const { enqueueReencryption, shutdownReencryptionQueue } = await importFreshModule();

      // Initialize by enqueuing
      await enqueueReencryption(JOB_PAYLOAD);

      // Shutdown
      await shutdownReencryptionQueue();

      expect(mockWorkerClose).toHaveBeenCalledTimes(1);
      expect(mockQueueClose).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // interrupted completion bookkeeping
  // ===========================================================================

  describe('worker interruption handling', () => {
    it('does not stamp lastKekRotatedAt when shutdown interrupts processing', async () => {
      const duplicate = vi.fn().mockReturnValue({});
      mockGetRedisClient.mockReturnValue({ duplicate });

      const firstFindLean = vi.fn().mockResolvedValue([{ _id: 'dek-1' }, { _id: 'dek-2' }]);
      const secondFindLean = vi.fn().mockResolvedValue([
        {
          _id: 'dek-1',
          tenantId: JOB_PAYLOAD.tenantId,
          projectId: '_tenant',
          environment: '_tenant',
          wrappedDek: Buffer.from('cipher').toString('base64'),
          kekKeyId: 'platform-default',
          kekKeyVersion: 1,
          wrappingProvider: { providerType: 'local', keyId: 'platform-default' },
          epoch: 1,
        },
      ]);
      mockDEKEntryFind
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          sort: vi.fn().mockReturnThis(),
          lean: firstFindLean,
        })
        .mockReturnValueOnce({
          sort: vi.fn().mockReturnThis(),
          lean: secondFindLean,
        });

      let shutdownQueue: (() => Promise<void>) | null = null;
      let shutdownTriggered = false;
      const unwrapKey = vi.fn().mockImplementation(async () => {
        if (!shutdownTriggered && shutdownQueue) {
          shutdownTriggered = true;
          await shutdownQueue();
        }
        return Buffer.from('plaintext');
      });
      const wrapKey = vi.fn().mockResolvedValue({
        ciphertext: Buffer.from('rewrapped'),
        keyVersion: 2,
      });
      const getProvider = vi.fn().mockResolvedValue({
        wrapKey,
        unwrapKey,
      });

      vi.doMock('@agent-platform/database/kms', () => ({
        getKMSProviderPool: vi.fn().mockReturnValue({
          getProvider,
          getLocalProvider: vi.fn().mockReturnValue({ unwrapKey }),
        }),
        getGlobalKMSResolver: vi.fn(() => ({
          resolve: (...args: unknown[]) => mockResolverResolve(...args),
        })),
      }));

      const findOneAndUpdate = vi.fn().mockResolvedValue({});
      vi.doMock('@agent-platform/database/models', () => ({
        DEKEntry: {
          find: (...args: unknown[]) => mockDEKEntryFind(...args),
          findOneAndUpdate,
        },
        TenantKMSConfig: {
          updateOne: (...args: unknown[]) => mockTenantKMSConfigUpdateOne(...args),
        },
      }));

      mockResolverResolve.mockResolvedValue({
        provider: { providerType: 'local', keyId: 'platform-default' },
        keyId: 'platform-default',
        sourceConfigVersion: 0,
      });

      const { enqueueReencryption, shutdownReencryptionQueue } = await importFreshModule();
      shutdownQueue = shutdownReencryptionQueue;
      await enqueueReencryption(JOB_PAYLOAD);

      expect(capturedWorkerProcessor).not.toBeNull();
      await capturedWorkerProcessor!({ data: JOB_PAYLOAD, updateProgress: vi.fn() });

      expect(mockTenantKMSConfigUpdateOne).not.toHaveBeenCalled();
      expect(mockLogKMSAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          metadata: expect.objectContaining({ interrupted: true }),
        }),
      );
    });
  });

  // ===========================================================================
  // deduplication
  // ===========================================================================

  describe('deduplication', () => {
    it('should use legacy jobId with tenant+reason+date for unscoped jobs (rolling-deploy compatibility)', async () => {
      mockGetRedisClient.mockReturnValue({
        duplicate: vi.fn().mockReturnValue({}),
      });

      const { enqueueReencryption } = await importFreshModule();
      await enqueueReencryption(JOB_PAYLOAD);

      const dateKey = new Date().toISOString().slice(0, 10);
      const expectedJobId = `reencrypt-${JOB_PAYLOAD.tenantId}-${JOB_PAYLOAD.reason}-${dateKey}`;

      expect(mockQueueAdd).toHaveBeenCalledWith('reencrypt', JOB_PAYLOAD, {
        jobId: expectedJobId,
      });
    });

    it('should include project and environment in scoped job ids', async () => {
      mockGetRedisClient.mockReturnValue({
        duplicate: vi.fn().mockReturnValue({}),
      });

      const { enqueueReencryption } = await importFreshModule();
      await enqueueReencryption(SCOPED_JOB_PAYLOAD);

      const dateKey = new Date().toISOString().slice(0, 10);
      const expectedJobId = `reencrypt-${SCOPED_JOB_PAYLOAD.tenantId}-${SCOPED_JOB_PAYLOAD.projectId}-${SCOPED_JOB_PAYLOAD.environment}-${SCOPED_JOB_PAYLOAD.reason}-${dateKey}`;

      expect(mockQueueAdd).toHaveBeenCalledWith('reencrypt', SCOPED_JOB_PAYLOAD, {
        jobId: expectedJobId,
      });
    });

    it('should include hashed dedupe key in job ids when provided', async () => {
      mockGetRedisClient.mockReturnValue({
        duplicate: vi.fn().mockReturnValue({}),
      });

      const { enqueueReencryption } = await importFreshModule();
      await enqueueReencryption(PROVIDER_DRIFT_JOB_PAYLOAD);

      const dateKey = new Date().toISOString().slice(0, 10);
      const dedupeHash = createHash('sha256')
        .update(PROVIDER_DRIFT_JOB_PAYLOAD.dedupeKey)
        .digest('hex')
        .slice(0, 16);
      const expectedJobId = `reencrypt-${PROVIDER_DRIFT_JOB_PAYLOAD.tenantId}-${PROVIDER_DRIFT_JOB_PAYLOAD.reason}-${dedupeHash}-${dateKey}`;

      expect(mockQueueAdd).toHaveBeenCalledWith('reencrypt', PROVIDER_DRIFT_JOB_PAYLOAD, {
        jobId: expectedJobId,
      });
    });
  });

  describe('scoped processing', () => {
    it('filters DEKs by project and environment for scoped jobs', async () => {
      const duplicate = vi.fn().mockReturnValue({});
      mockGetRedisClient.mockReturnValue({ duplicate });

      const mockFindOneAndUpdate = vi.fn().mockResolvedValue({});
      vi.doMock('@agent-platform/database/models', () => ({
        DEKEntry: {
          find: (...args: unknown[]) => mockDEKEntryFind(...args),
          findOneAndUpdate: mockFindOneAndUpdate,
        },
        TenantKMSConfig: {
          updateOne: (...args: unknown[]) => mockTenantKMSConfigUpdateOne(...args),
        },
      }));

      mockDEKEntryFind
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          sort: vi.fn().mockReturnThis(),
          lean: vi.fn().mockResolvedValue([]),
        })
        .mockReturnValueOnce({
          sort: vi.fn().mockReturnThis(),
          lean: vi.fn().mockResolvedValue([]),
        });

      const { enqueueReencryption } = await importFreshModule();
      await enqueueReencryption(SCOPED_JOB_PAYLOAD);

      expect(capturedWorkerProcessor).not.toBeNull();
      await capturedWorkerProcessor!({ data: SCOPED_JOB_PAYLOAD, updateProgress: vi.fn() });

      expect(mockDEKEntryFind).toHaveBeenNthCalledWith(1, {
        tenantId: SCOPED_JOB_PAYLOAD.tenantId,
        projectId: SCOPED_JOB_PAYLOAD.projectId,
        environment: SCOPED_JOB_PAYLOAD.environment,
        status: { $in: ['active', 'decrypt_only'] },
      });
      expect(mockTenantKMSConfigUpdateOne).not.toHaveBeenCalled();
    });
  });
});
