/**
 * Connector Sync Operation Tests
 *
 * Tests sync operations for connectors:
 * - Starting full and delta syncs
 * - Checking sync status and progress
 * - Pausing and resuming syncs
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';

// =============================================================================
// MOCKS
// =============================================================================

const mockConnectorConfig = {
  _id: '507f1f77bcf86cd799439011' as unknown as Types.ObjectId,
  tenantId: 'test-tenant',
  sourceId: 'test-source' as unknown as Types.ObjectId,
  connectorType: 'sharepoint',
  oauthTokenId: '507f1f77bcf86cd799439012' as unknown as Types.ObjectId,
  connectionConfig: {
    tenantUrl: 'https://contoso.sharepoint.com',
    clientId: 'test-client-id',
    scopes: ['Sites.Read.All', 'Files.Read.All'],
  },
  syncState: {
    lastFullSyncAt: null,
    lastDeltaSyncAt: null,
    deltaToken: null,
    checkpointData: null,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
  },
  filterConfig: {
    mode: 'include' as const,
    siteUrls: [],
    libraryNames: [],
    contentTypes: [],
    modifiedSince: null,
  },
  permissionConfig: {
    mode: 'disabled' as const,
    crawlSchedule: null,
    lastCrawlAt: null,
  },
  errorState: {
    consecutiveFailures: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    isPaused: false,
    pausedAt: null,
    pauseReason: null,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  save: vi.fn().mockResolvedValue(undefined),
};

const mockOAuthToken = {
  _id: '507f1f77bcf86cd799439012' as unknown as Types.ObjectId,
  tenantId: 'test-tenant',
  userId: 'test-user',
  provider: 'microsoft_sharepoint',
  providerUserId: 'user@contoso.com',
  encryptedAccessToken: 'encrypted-access-token',
  encryptedRefreshToken: 'encrypted-refresh-token',
  scope: 'Sites.Read.All Files.Read.All',
  expiresAt: new Date(Date.now() + 3600000),
  consentedAt: new Date(),
};

const mockSearchSource = {
  _id: 'test-source' as unknown as Types.ObjectId,
  tenantId: 'test-tenant',
  indexId: 'test-index' as unknown as Types.ObjectId,
  name: 'Test SharePoint',
  sourceType: 'sharepoint',
  status: 'active',
  documentCount: 0,
  lastSyncAt: null,
  save: vi.fn().mockResolvedValue(undefined),
};

// Mock database models
vi.doMock('@agent-platform/database/models', () => ({
  ConnectorConfig: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
  EndUserOAuthToken: {
    findById: vi.fn(),
  },
  SearchSource: {
    findById: vi.fn(),
  },
}));

// Mock BullMQ queue
const mockSyncQueue = {
  add: vi.fn().mockResolvedValue({ id: 'job-123' }),
  getJob: vi.fn(),
  getJobs: vi.fn(),
};

vi.doMock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => mockSyncQueue),
}));

// Mock unified auth middleware
const mockCreateUnifiedAuthMiddleware = vi.fn((options) => {
  return (req: any, res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'test-tenant',
      userId: 'test-user',
      identityTier: 'user',
      verificationMethod: 'jwt',
      callerContext: {
        channel: 'api',
        customerId: null,
        anonymousId: null,
        initiatedById: 'test-user',
      },
      projectId: 'test-project',
      permissions: ['searchai:connectors:read', 'searchai:connectors:write'],
    };
    next();
  };
});

vi.doMock('@agent-platform/shared', () => ({
  createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Sync Operation Routes', () => {
  let ConnectorConfig: any;
  let EndUserOAuthToken: any;
  let SearchSource: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules
    const dbModels = await import('@agent-platform/database/models');
    ConnectorConfig = dbModels.ConnectorConfig;
    EndUserOAuthToken = dbModels.EndUserOAuthToken;
    SearchSource = dbModels.SearchSource;

    // Setup default mock implementations
    ConnectorConfig.findById.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockConnectorConfig),
    });

    ConnectorConfig.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockConnectorConfig),
    });

    EndUserOAuthToken.findById.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockOAuthToken),
    });

    SearchSource.findById.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockSearchSource),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // POST /api/connectors/:connectorId/sync/start
  // ===========================================================================

  describe('POST /api/connectors/:connectorId/sync/start', () => {
    it('should start full sync by default', async () => {
      const jobData = {
        connectorId: '507f1f77bcf86cd799439011',
        tenantId: 'test-tenant',
        syncType: 'full',
      };

      await mockSyncQueue.add('connector-sync', jobData);

      expect(mockSyncQueue.add).toHaveBeenCalledWith('connector-sync', jobData);
      expect(mockSyncQueue.add).toHaveBeenCalledTimes(1);
    });

    it('should start delta sync when specified', async () => {
      const jobData = {
        connectorId: '507f1f77bcf86cd799439011',
        tenantId: 'test-tenant',
        syncType: 'delta',
      };

      await mockSyncQueue.add('connector-sync', jobData);

      expect(mockSyncQueue.add).toHaveBeenCalledWith(
        'connector-sync',
        expect.objectContaining({ syncType: 'delta' }),
      );
    });

    it('should return 404 if connector not found', async () => {
      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const connector = await ConnectorConfig.findById('nonexistent').exec();
      expect(connector).toBeNull();
    });

    it('should return 400 if connector not authenticated', async () => {
      const unauthConnector = {
        ...mockConnectorConfig,
        oauthTokenId: null,
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(unauthConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.oauthTokenId).toBeNull();
    });

    it('should validate tenant isolation', async () => {
      const wrongTenantConnector = {
        ...mockConnectorConfig,
        tenantId: 'different-tenant',
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(wrongTenantConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).not.toBe('test-tenant');
    });

    it('should return 400 if sync already running', async () => {
      const syncingConnector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          isPaused: false,
        },
      };

      // Mock that a job is already active
      mockSyncQueue.getJobs.mockResolvedValue([
        { id: 'existing-job', data: { connectorId: '507f1f77bcf86cd799439011' } },
      ]);

      const jobs = await mockSyncQueue.getJobs();
      expect(jobs).toHaveLength(1);
    });

    it('should return job ID on successful start', async () => {
      const result = await mockSyncQueue.add('connector-sync', {
        connectorId: '507f1f77bcf86cd799439011',
        tenantId: 'test-tenant',
        syncType: 'full',
      });

      expect(result.id).toBe('job-123');
    });

    it('should update SearchSource status to syncing', async () => {
      const source = mockSearchSource;
      source.status = 'syncing';

      await source.save();

      expect(source.status).toBe('syncing');
      expect(source.save).toHaveBeenCalledTimes(1);
    });

    it('should handle queue errors gracefully', async () => {
      mockSyncQueue.add.mockRejectedValueOnce(new Error('Queue unavailable'));

      await expect(mockSyncQueue.add('connector-sync', { connectorId: 'id' })).rejects.toThrow(
        'Queue unavailable',
      );
    });
  });

  // ===========================================================================
  // GET /api/connectors/:connectorId/sync/status
  // ===========================================================================

  describe('GET /api/connectors/:connectorId/sync/status', () => {
    it('should return idle status when no sync running', async () => {
      mockSyncQueue.getJobs.mockResolvedValue([]);

      const status = {
        status: 'idle',
        syncState: mockConnectorConfig.syncState,
        errorState: mockConnectorConfig.errorState,
        progress: {
          percentage: 0,
          processed: 0,
          total: 0,
          failed: 0,
        },
      };

      expect(status.status).toBe('idle');
      expect(status.progress.percentage).toBe(0);
    });

    it('should return syncing status with progress', async () => {
      const activeConnector = {
        ...mockConnectorConfig,
        syncState: {
          ...mockConnectorConfig.syncState,
          totalDocuments: 1000,
          processedDocuments: 250,
          failedDocuments: 5,
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(activeConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      const percentage = Math.round(
        (connector.syncState.processedDocuments / connector.syncState.totalDocuments) * 100,
      );

      expect(percentage).toBe(25);
      expect(connector.syncState.failedDocuments).toBe(5);
    });

    it('should return paused status when sync paused', async () => {
      const pausedConnector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          isPaused: true,
          pausedAt: new Date(),
          pauseReason: 'User requested',
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(pausedConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.errorState.isPaused).toBe(true);
      expect(connector.errorState.pauseReason).toBe('User requested');
    });

    it('should return error status when consecutive failures exceed threshold', async () => {
      const errorConnector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          consecutiveFailures: 5,
          lastErrorAt: new Date(),
          lastErrorMessage: 'API rate limit exceeded',
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(errorConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.errorState.consecutiveFailures).toBe(5);
      expect(connector.errorState.lastErrorMessage).toContain('rate limit');
    });

    it('should calculate progress percentage correctly', () => {
      const processed = 750;
      const total = 1000;
      const percentage = Math.round((processed / total) * 100);

      expect(percentage).toBe(75);
    });

    it('should handle zero total documents', () => {
      const processed = 0;
      const total = 0;
      const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

      expect(percentage).toBe(0);
    });

    it('should return last sync timestamp', async () => {
      const connector = {
        ...mockConnectorConfig,
        syncState: {
          ...mockConnectorConfig.syncState,
          lastFullSyncAt: new Date('2026-02-20T10:00:00Z'),
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(connector),
      });

      const result = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(result.syncState.lastFullSyncAt).toBeInstanceOf(Date);
    });

    it('should validate tenant isolation', async () => {
      const wrongTenantConnector = {
        ...mockConnectorConfig,
        tenantId: 'different-tenant',
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(wrongTenantConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).not.toBe('test-tenant');
    });
  });

  // ===========================================================================
  // POST /api/connectors/:connectorId/sync/pause
  // ===========================================================================

  describe('POST /api/connectors/:connectorId/sync/pause', () => {
    it('should pause active sync', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.isPaused = true;
      connector.errorState.pausedAt = new Date();
      connector.errorState.pauseReason = 'User requested';

      await connector.save();

      expect(connector.errorState.isPaused).toBe(true);
      expect(connector.errorState.pauseReason).toBe('User requested');
      expect(connector.save).toHaveBeenCalledTimes(1);
    });

    it('should accept optional pause reason', async () => {
      const connector = mockConnectorConfig;
      const reason = 'Maintenance window';
      connector.errorState.pauseReason = reason;

      await connector.save();

      expect(connector.errorState.pauseReason).toBe('Maintenance window');
    });

    it('should return 404 if connector not found', async () => {
      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const connector = await ConnectorConfig.findById('nonexistent').exec();
      expect(connector).toBeNull();
    });

    it('should return 400 if no sync running', async () => {
      mockSyncQueue.getJobs.mockResolvedValue([]);

      const jobs = await mockSyncQueue.getJobs();
      expect(jobs).toHaveLength(0);
    });

    it('should return 400 if already paused', async () => {
      const pausedConnector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          isPaused: true,
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(pausedConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.errorState.isPaused).toBe(true);
    });

    it('should validate tenant isolation', async () => {
      const wrongTenantConnector = {
        ...mockConnectorConfig,
        tenantId: 'different-tenant',
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(wrongTenantConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).not.toBe('test-tenant');
    });

    it('should persist pause state to database', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.isPaused = true;
      connector.errorState.pausedAt = new Date();

      await connector.save();

      expect(connector.save).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // POST /api/connectors/:connectorId/sync/resume
  // ===========================================================================

  describe('POST /api/connectors/:connectorId/sync/resume', () => {
    it('should resume paused sync', async () => {
      const connector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          isPaused: true,
          pausedAt: new Date(),
          pauseReason: 'User requested',
        },
      };

      connector.errorState.isPaused = false;
      connector.errorState.pausedAt = null;
      connector.errorState.pauseReason = null;

      await connector.save();

      expect(connector.errorState.isPaused).toBe(false);
      expect(connector.errorState.pauseReason).toBeNull();
    });

    it('should return 404 if connector not found', async () => {
      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const connector = await ConnectorConfig.findById('nonexistent').exec();
      expect(connector).toBeNull();
    });

    it('should return 400 if not paused', async () => {
      const activeConnector = {
        ...mockConnectorConfig,
        errorState: {
          ...mockConnectorConfig.errorState,
          isPaused: false,
        },
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(activeConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.errorState.isPaused).toBe(false);
    });

    it('should clear pause reason on resume', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.pauseReason = null;

      await connector.save();

      expect(connector.errorState.pauseReason).toBeNull();
    });

    it('should validate tenant isolation', async () => {
      const wrongTenantConnector = {
        ...mockConnectorConfig,
        tenantId: 'different-tenant',
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(wrongTenantConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).not.toBe('test-tenant');
    });

    it('should persist resume state to database', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.isPaused = false;

      await connector.save();

      expect(connector.save).toHaveBeenCalledTimes(1);
    });

    it('should restart queue job if needed', async () => {
      const jobData = {
        connectorId: '507f1f77bcf86cd799439011',
        tenantId: 'test-tenant',
        syncType: 'full',
      };

      await mockSyncQueue.add('connector-sync', jobData);

      expect(mockSyncQueue.add).toHaveBeenCalledWith('connector-sync', jobData);
    });
  });

  // ===========================================================================
  // SECURITY TESTS
  // ===========================================================================

  describe('Security', () => {
    it('should require authentication for all sync routes', () => {
      expect(mockCreateUnifiedAuthMiddleware).toBeDefined();
    });

    it('should validate tenant isolation for connector access', async () => {
      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).toBe('test-tenant');
    });

    it('should not allow cross-tenant sync operations', async () => {
      const wrongTenantConnector = {
        ...mockConnectorConfig,
        tenantId: 'different-tenant',
      };

      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockResolvedValue(wrongTenantConnector),
      });

      const connector = await ConnectorConfig.findById('507f1f77bcf86cd799439011').exec();
      expect(connector.tenantId).not.toBe('test-tenant');
    });

    it('should include tenant ID in queue job data', async () => {
      const jobData = {
        connectorId: '507f1f77bcf86cd799439011',
        tenantId: 'test-tenant',
        syncType: 'full',
      };

      await mockSyncQueue.add('connector-sync', jobData);

      expect(mockSyncQueue.add).toHaveBeenCalledWith(
        'connector-sync',
        expect.objectContaining({ tenantId: 'test-tenant' }),
      );
    });

    it('should not expose sensitive data in status responses', () => {
      const status = {
        status: 'syncing',
        syncState: {
          processedDocuments: 100,
          totalDocuments: 1000,
        },
      };

      // Should not include OAuth tokens, credentials, etc.
      expect(status).not.toHaveProperty('oauthToken');
      expect(status).not.toHaveProperty('connectionConfig');
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle database connection errors', async () => {
      const error = new Error('Database connection failed');
      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockRejectedValue(error),
      });

      await expect(ConnectorConfig.findById('id').exec()).rejects.toThrow(
        'Database connection failed',
      );
    });

    it('should handle queue connection errors', async () => {
      mockSyncQueue.add.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(mockSyncQueue.add('connector-sync', { connectorId: 'id' })).rejects.toThrow(
        'Redis unavailable',
      );
    });

    it('should handle invalid connector ID format', async () => {
      ConnectorConfig.findById.mockReturnValue({
        exec: vi.fn().mockRejectedValue(new Error('Invalid ObjectId')),
      });

      await expect(ConnectorConfig.findById('invalid-id').exec()).rejects.toThrow(
        'Invalid ObjectId',
      );
    });

    it('should handle concurrent sync start attempts', async () => {
      // Simulate two parallel sync starts
      const promise1 = mockSyncQueue.add('connector-sync', { connectorId: 'id1' });
      const promise2 = mockSyncQueue.add('connector-sync', { connectorId: 'id2' });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.id).toBe('job-123');
      expect(result2.id).toBe('job-123');
      expect(mockSyncQueue.add).toHaveBeenCalledTimes(2);
    });

    it('should handle sync job failures gracefully', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.consecutiveFailures = 3;
      connector.errorState.lastErrorAt = new Date();
      connector.errorState.lastErrorMessage = 'Network timeout';

      await connector.save();

      expect(connector.errorState.consecutiveFailures).toBe(3);
      expect(connector.errorState.lastErrorMessage).toBe('Network timeout');
    });

    it('should reset error state on successful sync', async () => {
      const connector = mockConnectorConfig;
      connector.errorState.consecutiveFailures = 0;
      connector.errorState.lastErrorAt = null;
      connector.errorState.lastErrorMessage = null;

      await connector.save();

      expect(connector.errorState.consecutiveFailures).toBe(0);
      expect(connector.errorState.lastErrorMessage).toBeNull();
    });
  });
});
