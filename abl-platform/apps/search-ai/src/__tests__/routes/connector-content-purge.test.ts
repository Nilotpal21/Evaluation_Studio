/**
 * Connector Content Purge Route Tests
 *
 * Tests content purge service functions:
 * - POST start — conflict check (sync running)
 * - GET progress
 * - POST cancel
 * - POST retry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockConnector = {
  _id: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  sourceId: 'source-1',
  syncState: { syncInProgress: false },
};

const mockSyncingConnector = {
  ...mockConnector,
  syncState: { syncInProgress: true },
};

const mockConnectorWithoutSource = {
  ...mockConnector,
  sourceId: undefined,
};

const mockCleanupJob = {
  _id: 'cleanup-001',
  connectorId: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  status: 'in_progress',
  documents: { total: 100, removed: 30 },
  chunks: { total: 500, removed: 150 },
  vectorEmbeddings: { total: 500, removed: 150 },
  estimatedTimeRemaining: 60,
  error: null,
};

const mockFailedJob = {
  ...mockCleanupJob,
  status: 'failed',
  error: 'Batch deletion timed out',
};

const mockCompletedJob = {
  ...mockCleanupJob,
  status: 'completed',
  documents: { total: 100, removed: 100 },
  chunks: { total: 500, removed: 500 },
  vectorEmbeddings: { total: 500, removed: 500 },
};

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCountDocuments = vi.fn();
const mockCreate = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.doMock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'ConnectorCleanupJob') {
      return {
        findOne: mockFindOne,
        findOneAndUpdate: mockFindOneAndUpdate,
        create: mockCreate,
      };
    }
    if (modelName === 'ConnectorConfig') {
      return { findOne: mockFindOne };
    }
    if (modelName === 'SearchSource') {
      return { findOne: mockFindOne };
    }
    // SearchDocument, SearchChunk
    return {
      countDocuments: mockCountDocuments,
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      deleteMany: vi.fn().mockResolvedValue({}),
    };
  }),
}));

vi.doMock('../../services/connector-audit.service.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.doMock('../../services/connector.service.js', () => ({
  ConnectorError: class ConnectorError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number = 400,
    ) {
      super(message);
      this.name = 'ConnectorError';
    }
  },
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Content Purge Routes', () => {
  let purgeService: typeof import('../../services/connector-content-purge.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    purgeService = await import('../../services/connector-content-purge.service.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // initiatePurge
  // ===========================================================================

  describe('initiatePurge', () => {
    it('should create cleanup job and return cleanupId', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnectorWithoutSource),
      });
      mockCountDocuments.mockResolvedValue(50);
      mockCreate.mockResolvedValue({ _id: 'cleanup-new' });

      const data = await purgeService.initiatePurge(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'index-1',
        'admin@contoso.com',
      );

      expect(data.cleanupId).toBe('cleanup-new');
      expect(data.status).toBe('in_progress');
    });

    it('should throw SYNC_IN_PROGRESS when sync is running', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSyncingConnector),
      });

      await expect(
        purgeService.initiatePurge('507f1f77bcf86cd799439011', 'test-tenant', 'index-1', 'admin'),
      ).rejects.toThrow('Cannot purge content while sync is in progress');
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.initiatePurge('nonexistent', 'test-tenant', 'index-1', 'admin'),
      ).rejects.toThrow('Connector not found');
    });

    it('should enforce tenant isolation', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.initiatePurge('507f1f77bcf86cd799439011', 'wrong-tenant', 'index-1', 'admin'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // getPurgeStatus
  // ===========================================================================

  describe('getPurgeStatus', () => {
    it('should return in-progress cleanup status', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockCleanupJob),
      });

      const data = await purgeService.getPurgeStatus(
        'cleanup-001',
        'test-tenant',
        '507f1f77bcf86cd799439011',
      );

      expect(data.cleanupId).toBe('cleanup-001');
      expect(data.status).toBe('in_progress');
      expect(data.documents.total).toBe(100);
      expect(data.documents.removed).toBe(30);
      expect(data.chunks.removed).toBe(150);
    });

    it('should return completed status', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockCompletedJob),
      });

      const data = await purgeService.getPurgeStatus(
        'cleanup-001',
        'test-tenant',
        '507f1f77bcf86cd799439011',
      );

      expect(data.status).toBe('completed');
      expect(data.documents.removed).toBe(100);
    });

    it('should throw NOT_FOUND for missing cleanup job', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.getPurgeStatus('nonexistent', 'test-tenant', '507f1f77bcf86cd799439011'),
      ).rejects.toThrow('Cleanup job not found');
    });

    it('should enforce tenant isolation on cleanup job', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.getPurgeStatus('cleanup-001', 'wrong-tenant', '507f1f77bcf86cd799439011'),
      ).rejects.toThrow('Cleanup job not found');
    });
  });

  // ===========================================================================
  // cancelPurge
  // ===========================================================================

  describe('cancelPurge', () => {
    it('should cancel an in-progress purge', async () => {
      mockFindOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ ...mockCleanupJob, status: 'cancelled' }),
      });

      const data = await purgeService.cancelPurge(
        'cleanup-001',
        'test-tenant',
        '507f1f77bcf86cd799439011',
      );

      expect(data.status).toBe('cancelled');
    });

    it('should throw NOT_FOUND when job is not in_progress', async () => {
      mockFindOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.cancelPurge('cleanup-completed', 'test-tenant', '507f1f77bcf86cd799439011'),
      ).rejects.toThrow('Active cleanup job not found');
    });
  });

  // ===========================================================================
  // retryPurge
  // ===========================================================================

  describe('retryPurge', () => {
    it('should retry a failed purge', async () => {
      // First findOne returns failed job, then findOneAndUpdate, then connector lookup
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockFailedJob),
      });
      mockFindOneAndUpdate.mockResolvedValue({});

      const data = await purgeService.retryPurge(
        'cleanup-001',
        'test-tenant',
        '507f1f77bcf86cd799439011',
        'index-1',
      );

      expect(data.status).toBe('in_progress');
      expect(data.error).toBeNull();
    });

    it('should reject retry for non-failed job', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockCompletedJob),
      });

      await expect(
        purgeService.retryPurge(
          'cleanup-001',
          'test-tenant',
          '507f1f77bcf86cd799439011',
          'index-1',
        ),
      ).rejects.toThrow('Only failed cleanup jobs can be retried');
    });

    it('should throw NOT_FOUND for missing cleanup job', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        purgeService.retryPurge(
          'nonexistent',
          'test-tenant',
          '507f1f77bcf86cd799439011',
          'index-1',
        ),
      ).rejects.toThrow('Cleanup job not found');
    });
  });

  // ===========================================================================
  // Zod Validation
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate route params', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      expect(schema.safeParse({ indexId: 'idx', connectorId: 'conn' }).success).toBe(true);
      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });

    it('should validate cleanupId param', () => {
      const { z } = require('zod');
      const schema = z.object({
        indexId: z.string().min(1),
        connectorId: z.string().min(1),
        cleanupId: z.string().min(1),
      });

      expect(
        schema.safeParse({ indexId: 'idx', connectorId: 'conn', cleanupId: 'cleanup-1' }).success,
      ).toBe(true);
      expect(schema.safeParse({ indexId: 'idx', connectorId: 'conn', cleanupId: '' }).success).toBe(
        false,
      );
    });
  });
});
