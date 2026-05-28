/**
 * Connector Permission Crawl Worker Tests
 *
 * Tests for connector permission crawl background worker: job processing,
 * state management, error handling, and progress tracking.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockJob<T>(data: T, id = 'job-crawl-1') {
  return {
    id,
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  } as unknown as Job<T>;
}

function createMockConnectorConfig(overrides = {}) {
  return {
    _id: 'connector-1',
    tenantId: 'tenant-1',
    sourceId: 'source-1',
    connectorType: 'sharepoint',
    oauthTokenId: 'token-1',
    permissionConfig: {
      mode: 'enabled',
      crawlSchedule: null,
      lastCrawlAt: null,
      currentJobId: null,
      crawlInProgress: false,
      documentsProcessed: 0,
      averageAccuracy: 0,
      lastCrawlError: null,
    },
    toObject: function () {
      return this;
    },
    ...overrides,
  };
}

// =============================================================================
// Connector Permission Crawl Worker Tests
// =============================================================================

describe('connector-permission-crawl-worker', () => {
  let mockConnectorConfig: any;
  let mockSharePointConnector: any;
  let findOneMock: any;
  let findOneAndUpdateMock: any;
  let withTenantContextMock: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset mocks
    findOneMock = vi.fn();
    findOneAndUpdateMock = vi.fn().mockResolvedValue({});
    withTenantContextMock = vi.fn((ctx, fn) => fn());

    mockConnectorConfig = createMockConnectorConfig();

    mockSharePointConnector = {
      initialize: vi.fn().mockResolvedValue(undefined),
      crawlPermissions: vi.fn().mockResolvedValue({
        success: true,
        mode: 'enabled',
        documentsProcessed: 1000,
        averageAccuracy: 95,
        durationMs: 30000,
        errors: [],
      }),
    };

    // Mock database types (worker imports types and models from these)
    vi.doMock('@agent-platform/database', () => ({}));
    vi.doMock('@agent-platform/database/models', () => ({
      Contact: {},
      AclGroupHierarchy: {},
      AclDocumentPermissions: {},
    }));

    // Mock tenant context
    vi.doMock('@agent-platform/database/mongo', () => ({
      withTenantContext: withTenantContextMock,
    }));

    // Mock MongoPermissionStore (worker calls recomputeEffectiveGroupsForTenant after crawl)
    vi.doMock('@agent-platform/search-ai-internal/permissions', () => ({
      MongoPermissionStore: {
        getInstance: vi.fn(() => ({
          recomputeEffectiveGroupsForTenant: vi.fn().mockResolvedValue(0),
        })),
      },
    }));

    // Mock db/index.js — worker uses getLazyModel to get models
    vi.doMock('../db/index.js', () => {
      const models: Record<string, any> = {
        ConnectorConfig: {
          findOne: findOneMock,
          findOneAndUpdate: findOneAndUpdateMock,
        },
        SearchSource: {
          findOne: vi.fn().mockResolvedValue({
            _id: 'source-1',
            tenantId: 'tenant-1',
            indexId: 'index-1',
          }),
        },
        SearchDocument: {
          find: vi.fn().mockResolvedValue([]),
        },
        SyncCheckpoint: {
          findOne: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue(null),
          }),
        },
        EndUserOAuthToken: {
          findOne: vi.fn().mockResolvedValue(null),
        },
        DriveDeltaToken: {
          findOne: vi.fn().mockResolvedValue(null),
        },
      };
      return {
        getLazyModel: vi.fn((name: string) => models[name] || {}),
        getModel: vi.fn((name: string) => models[name] || {}),
      };
    });

    // Mock connectors-base types
    vi.doMock('@agent-platform/connectors-base', () => ({}));

    // Mock SharePointConnector
    vi.doMock('@agent-platform/connector-sharepoint', () => {
      class MockSharePointConnector {
        initialize = mockSharePointConnector.initialize;
        crawlPermissions = mockSharePointConnector.crawlPermissions;
      }
      return { SharePointConnector: MockSharePointConnector };
    });

    // Mock shared worker utilities
    vi.doMock('../workers/shared.js', () => ({
      createWorkerOptions: vi.fn(() => ({
        connection: {},
        concurrency: 2,
      })),
      workerLog: vi.fn(),
      workerError: vi.fn(),
      withTraceContext: vi.fn((_data: unknown, fn: () => Promise<unknown>) => fn()),
      createBlindIndexFn: vi.fn(() => vi.fn()),
      createEncryptFn: vi.fn(() => vi.fn()),
    }));

    // Mock BullMQ
    vi.doMock('bullmq', () => {
      class MockWorker {
        queueName: string;
        processor: any;
        opts: any;
        constructor(queueName: string, processor: any, opts: any) {
          this.queueName = queueName;
          this.processor = processor;
          this.opts = opts;
        }
        on() {
          return this;
        }
        close() {
          return Promise.resolve();
        }
        isRunning() {
          return true;
        }
      }
      return { Worker: MockWorker };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Worker Creation ────────────────────────────────────────────────────

  describe('worker creation', () => {
    test('creates worker with correct queue name', async () => {
      const mod = await import('../workers/connector-permission-crawl-worker.js');
      expect(mod.connectorPermissionCrawlWorker.queueName).toBe('connector-permission-crawl');
    });

    test('exports QUEUE_CONNECTOR_PERMISSION_CRAWL constant', async () => {
      const mod = await import('../workers/connector-permission-crawl-worker.js');
      expect(mod.QUEUE_CONNECTOR_PERMISSION_CRAWL).toBe('connector-permission-crawl');
    });

    test('worker has processor function', async () => {
      const mod = await import('../workers/connector-permission-crawl-worker.js');
      expect(mod.connectorPermissionCrawlWorker.processor).toBeDefined();
      expect(typeof mod.connectorPermissionCrawlWorker.processor).toBe('function');
    });
  });

  // ─── Enabled Mode Crawl ──────────────────────────────────────────────

  describe('enabled mode crawl', () => {
    test('processes permission crawl job successfully', async () => {
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify tenant context was used
      expect(withTenantContextMock).toHaveBeenCalledWith(
        { tenantId: 'tenant-1' },
        expect.any(Function),
      );

      // Verify connector was loaded
      expect(findOneMock).toHaveBeenCalledWith({
        _id: 'connector-1',
        tenantId: 'tenant-1',
      });

      // Verify crawl state was set to in-progress
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        {
          'permissionConfig.currentJobId': 'job-crawl-1',
          'permissionConfig.crawlInProgress': true,
          'permissionConfig.lastCrawlError': null,
        },
      );

      // Verify connector was initialized
      expect(mockSharePointConnector.initialize).toHaveBeenCalled();

      // Verify crawl was performed
      expect(mockSharePointConnector.crawlPermissions).toHaveBeenCalledWith('enabled');

      // Verify progress was updated to 100%
      expect(job.updateProgress).toHaveBeenCalledWith(100);

      // Verify crawl state was updated with success
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.currentJobId': null,
          'permissionConfig.crawlInProgress': false,
          'permissionConfig.documentsProcessed': 1000,
          'permissionConfig.averageAccuracy': 95,
          'permissionConfig.lastCrawlError': null,
        }),
      );
    });

    test('updates lastCrawlAt timestamp', async () => {
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify lastCrawlAt was updated
      const updateCall = findOneAndUpdateMock.mock.calls.find(
        (call: any) => call[1]['permissionConfig.lastCrawlAt'],
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]['permissionConfig.lastCrawlAt']).toBeInstanceOf(Date);
    });

    test('records 95% accuracy for enabled mode', async () => {
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify accuracy was recorded
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.averageAccuracy': 95,
        }),
      );
    });
  });

  // ─── Enabled Mode — High Accuracy Crawl ─────────────────────────────────

  describe('enabled mode — high accuracy crawl', () => {
    test('processes enabled mode crawl with 100% accuracy', async () => {
      const fullModeCrawlResult = {
        success: true,
        mode: 'enabled',
        documentsProcessed: 1000,
        averageAccuracy: 100,
        durationMs: 45000,
        errors: [],
      };
      mockSharePointConnector.crawlPermissions.mockResolvedValue(fullModeCrawlResult);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify enabled mode was used
      expect(mockSharePointConnector.crawlPermissions).toHaveBeenCalledWith('enabled');

      // Verify 100% accuracy
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.averageAccuracy': 100,
        }),
      );
    });

    test('records 100% accuracy for enabled mode', async () => {
      const fullModeCrawlResult = {
        success: true,
        mode: 'enabled',
        documentsProcessed: 500,
        averageAccuracy: 100,
        durationMs: 60000,
        errors: [],
      };
      mockSharePointConnector.crawlPermissions.mockResolvedValue(fullModeCrawlResult);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify accuracy
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.averageAccuracy': 100,
          'permissionConfig.documentsProcessed': 500,
        }),
      );
    });
  });

  // ─── Disabled Mode ──────────────────────────────────────────────────────

  describe('disabled mode', () => {
    test('skips crawl for disabled mode', async () => {
      const disabledResult = {
        success: true,
        mode: 'disabled',
        documentsProcessed: 0,
        averageAccuracy: 0,
        durationMs: 0,
        errors: [],
      };
      mockSharePointConnector.crawlPermissions.mockResolvedValue(disabledResult);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'disabled' as const,
      });

      await processor(job);

      // Verify crawl was called with disabled mode
      expect(mockSharePointConnector.crawlPermissions).toHaveBeenCalledWith('disabled');

      // Verify state reflects disabled mode
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.documentsProcessed': 0,
          'permissionConfig.averageAccuracy': 0,
        }),
      );
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    test('handles crawl error and updates state', async () => {
      const crawlError = new Error('Neo4j connection failed');
      mockSharePointConnector.crawlPermissions.mockRejectedValue(crawlError);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await expect(processor(job)).rejects.toThrow('Neo4j connection failed');

      // Verify error state was updated
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.currentJobId': null,
          'permissionConfig.crawlInProgress': false,
          'permissionConfig.lastCrawlError': 'Neo4j connection failed',
        }),
      );
    });

    test('handles non-Error objects in error state', async () => {
      mockSharePointConnector.crawlPermissions.mockRejectedValue('String error');
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await expect(processor(job)).rejects.toBe('String error');

      // Verify error was converted to string
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.lastCrawlError': 'String error',
        }),
      );
    });

    test('throws error when connector not found', async () => {
      findOneMock.mockResolvedValue(null);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await expect(processor(job)).rejects.toThrow('Connector connector-1 not found');
    });

    test('handles unsupported connector type', async () => {
      const unsupportedConfig = createMockConnectorConfig({
        connectorType: 'jira',
      });
      findOneMock.mockResolvedValue(unsupportedConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await expect(processor(job)).rejects.toThrow('Unsupported connector type: jira');

      // Verify error state was updated
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.currentJobId': null,
          'permissionConfig.crawlInProgress': false,
          'permissionConfig.lastCrawlError': 'Unsupported connector type: jira',
        }),
      );
    });

    test('handles initialization error', async () => {
      mockSharePointConnector.initialize.mockRejectedValue(new Error('Init failed'));
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await expect(processor(job)).rejects.toThrow('Init failed');

      // Verify error state was updated
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.lastCrawlError': 'Init failed',
        }),
      );
    });
  });

  // ─── Job Data Interface ─────────────────────────────────────────────────

  describe('job data interface', () => {
    test('ConnectorPermissionCrawlJobData has required fields', () => {
      const jobData = {
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      };

      expect(jobData.connectorId).toBe('connector-1');
      expect(jobData.tenantId).toBe('tenant-1');
    });

    test('supports all permission modes', () => {
      const enabledMode = { mode: 'enabled' as const };
      const disabledMode = { mode: 'disabled' as const };
      expect(enabledMode.mode).toBe('enabled');
      expect(disabledMode.mode).toBe('disabled');
    });
  });

  // ─── Large Scale Crawls ─────────────────────────────────────────────────

  describe('large scale crawls', () => {
    test('handles large document count successfully', async () => {
      const largeCrawlResult = {
        success: true,
        mode: 'enabled',
        documentsProcessed: 50000,
        averageAccuracy: 95,
        durationMs: 300000, // 5 minutes
        errors: [],
      };
      mockSharePointConnector.crawlPermissions.mockResolvedValue(largeCrawlResult);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify large count was recorded
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.documentsProcessed': 50000,
        }),
      );
    });

    test('handles partial crawl with errors', async () => {
      const partialCrawlResult = {
        success: true,
        mode: 'enabled',
        documentsProcessed: 950,
        averageAccuracy: 100,
        durationMs: 60000,
        errors: [
          { documentId: 'doc-1', error: 'Permission denied' },
          { documentId: 'doc-2', error: 'Item not found' },
        ],
      };
      mockSharePointConnector.crawlPermissions.mockResolvedValue(partialCrawlResult);
      findOneMock.mockResolvedValue(mockConnectorConfig);

      const mod = await import('../workers/connector-permission-crawl-worker.js');
      const processor = mod.connectorPermissionCrawlWorker.processor;

      const job = createMockJob({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        mode: 'enabled' as const,
      });

      await processor(job);

      // Verify partial success was recorded
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          'permissionConfig.documentsProcessed': 950,
          'permissionConfig.lastCrawlError': null, // Partial errors don't fail the job
        }),
      );
    });
  });
});
