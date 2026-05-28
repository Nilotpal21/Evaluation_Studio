/**
 * Permission Recrawl Worker Tests
 *
 * Tests the background worker that periodically recrawls permissions.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PermissionRecrawlJobData } from '../workers/permission-recrawl-worker.js';

// =============================================================================
// Mocks
// =============================================================================

// Mock Worker to capture processor function
const mockWorkerInstances: any[] = [];

class MockWorker {
  queueName: string;
  opts: any;
  on = vi.fn();
  close = vi.fn();

  constructor(queueName: string, processor: any, opts?: any) {
    this.queueName = queueName;
    this.opts = { processor, ...opts };
    mockWorkerInstances.push(this);
  }
}

class MockQueue {
  add = vi.fn();
  close = vi.fn();

  constructor(_name: string, _opts?: any) {}
}

class MockQueueEvents {
  on = vi.fn();
  close = vi.fn();

  constructor(_name: string, _opts?: any) {}
}

vi.mock('bullmq', () => ({
  Worker: MockWorker,
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
}));

const mockConnectorConfig = {
  findOne: vi.fn(),
  save: vi.fn(),
};

vi.mock('@agent-platform/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database')>();
  return {
    ...actual,
    ConnectorConfig: mockConnectorConfig,
  };
});

// Module-level mock objects that will be shared across tests
const mockCrawlJob = {
  id: 'crawl-job-123',
  waitUntilFinished: vi.fn().mockResolvedValue(undefined),
};

const mockCrawlQueue = {
  add: vi.fn().mockResolvedValue(mockCrawlJob),
  queueEvents: {},
};

// Mock createQueue to return the shared mock queue instance
// Path must be relative to the test file (test is in __tests__/, worker is in workers/)
vi.mock('../workers/shared.js', () => ({
  createQueue: vi.fn(() => mockCrawlQueue),
  getSharedRedisClient: vi.fn(() => ({})),
  getRedisConnection: vi.fn(() => ({})),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../workers/connector-permission-crawl-worker.js', () => ({
  QUEUE_CONNECTOR_PERMISSION_CRAWL: 'connector_permission_crawl',
}));

// =============================================================================
// Test Data
// =============================================================================

const mockConfig = {
  _id: 'connector-123',
  tenantId: 'tenant-123',
  connectorType: 'sharepoint',
  oauthTokenId: 'token-123',
  filterConfig: {},
  permissionConfig: {
    mode: 'enabled',
    crawlInProgress: false,
    currentJobId: null,
    lastCrawlAt: null,
    documentsProcessed: 0,
    averageAccuracy: 0,
    lastCrawlError: null,
  },
  save: vi.fn().mockResolvedValue(undefined),
};

const mockRedisHandle = {
  duplicate: vi.fn(() => ({})),
};

// =============================================================================
// Tests
// =============================================================================

describe('Permission Recrawl Worker', () => {
  let worker: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up default mocks (individual tests can override with mockResolvedValueOnce)
    mockConnectorConfig.findOne.mockResolvedValue(mockConfig);
    mockCrawlQueue.add.mockResolvedValue(mockCrawlJob);
    mockCrawlJob.waitUntilFinished.mockResolvedValue(undefined);

    // Import worker after mocks are setup
    const workerModule = await import('../workers/permission-recrawl-worker.js');
    worker = workerModule;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ─── Scheduled Recrawl ─────────────────────────────────────────────────

  test('schedulePermissionRecrawlJobs enqueues jobs for enabled connectors', async () => {
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'job-123' }),
    };

    // Mock multiple connectors
    mockConnectorConfig.findOne = vi.fn();
    const mockFind = vi.fn().mockResolvedValue([
      {
        _id: 'conn-1',
        tenantId: 'tenant-1',
        permissionConfig: { mode: 'enabled', crawlInProgress: false },
      },
      {
        _id: 'conn-2',
        tenantId: 'tenant-2',
        permissionConfig: { mode: 'enabled', crawlInProgress: false },
      },
    ]);
    (mockConnectorConfig as any).find = mockFind;

    await worker.schedulePermissionRecrawlJobs(mockQueue);

    expect(mockFind).toHaveBeenCalledWith({
      'permissionConfig.mode': 'enabled',
      'permissionConfig.crawlInProgress': false,
    });

    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'recrawl',
      {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        trigger: 'scheduled',
      },
      expect.objectContaining({
        jobId: expect.stringContaining('recrawl-conn-1'),
        priority: 5,
      }),
    );
  });

  test('schedulePermissionRecrawlJobs skips disabled connectors', async () => {
    const mockQueue = {
      add: vi.fn(),
    };

    const mockFind = vi
      .fn()
      .mockResolvedValue([
        { _id: 'conn-1', tenantId: 'tenant-1', permissionConfig: { mode: 'disabled' } },
      ]);
    (mockConnectorConfig as any).find = mockFind;

    await worker.schedulePermissionRecrawlJobs(mockQueue);

    // Query should exclude disabled connectors
    expect(mockFind).toHaveBeenCalledWith({
      'permissionConfig.mode': 'enabled',
      'permissionConfig.crawlInProgress': false,
    });
  });

  test('schedulePermissionRecrawlJobs skips connectors already in progress', async () => {
    const mockQueue = {
      add: vi.fn(),
    };

    const mockFind = vi.fn().mockResolvedValue([]);
    (mockConnectorConfig as any).find = mockFind;

    await worker.schedulePermissionRecrawlJobs(mockQueue);

    expect(mockFind).toHaveBeenCalledWith({
      'permissionConfig.mode': 'enabled',
      'permissionConfig.crawlInProgress': false, // Excludes in-progress
    });
  });

  // ─── Manual Trigger ────────────────────────────────────────────────────

  test('triggerManualRecrawl enqueues high-priority job', async () => {
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'manual-job-123' }),
    };

    const jobId = await worker.triggerManualRecrawl(mockQueue, 'conn-1', 'tenant-1');

    expect(mockQueue.add).toHaveBeenCalledWith(
      'recrawl',
      {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        trigger: 'manual',
      },
      expect.objectContaining({
        jobId: expect.stringContaining('manual-recrawl-conn-1'),
        priority: 1, // High priority
      }),
    );

    expect(jobId).toBe('manual-job-123');
  });

  // ─── Post-Sync Trigger ─────────────────────────────────────────────────

  test('triggerPostSyncRecrawl enqueues job for enabled connector', async () => {
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'post-sync-job-123' }),
    };

    mockConnectorConfig.findOne.mockResolvedValue({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      permissionConfig: { mode: 'enabled' },
    });

    await worker.triggerPostSyncRecrawl(mockQueue, 'conn-1', 'tenant-1');

    expect(mockQueue.add).toHaveBeenCalledWith(
      'recrawl',
      {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        trigger: 'post-sync',
      },
      expect.objectContaining({
        jobId: expect.stringContaining('post-sync-recrawl-conn-1'),
        priority: 3, // Medium priority
      }),
    );
  });

  test('triggerPostSyncRecrawl skips disabled connector', async () => {
    const mockQueue = {
      add: vi.fn(),
    };

    mockConnectorConfig.findOne.mockResolvedValue({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      permissionConfig: { mode: 'disabled' },
    });

    await worker.triggerPostSyncRecrawl(mockQueue, 'conn-1', 'tenant-1');

    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('triggerPostSyncRecrawl handles non-existent connector', async () => {
    const mockQueue = {
      add: vi.fn(),
    };

    mockConnectorConfig.findOne.mockResolvedValue(null);

    await worker.triggerPostSyncRecrawl(mockQueue, 'conn-999', 'tenant-1');

    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  test('handles connector not found error', async () => {
    const mockJob = {
      id: 'job-123',
      data: {
        connectorId: 'conn-999',
        tenantId: 'tenant-1',
        trigger: 'manual',
      },
      updateProgress: vi.fn(),
    } as unknown as Job<PermissionRecrawlJobData>;

    mockConnectorConfig.findOne.mockResolvedValue(null);

    const workerModule = await import('../workers/permission-recrawl-worker.js');
    const workerInstance = workerModule.createPermissionRecrawlWorker(mockRedisHandle as any);

    // Extract the processor function
    const processor = (workerInstance as any).opts.processor;

    await expect(processor(mockJob)).rejects.toThrow('Connector conn-999 not found');
  });

  test('skips recrawl for disabled connector with success', async () => {
    const mockJob = {
      id: 'job-123',
      data: {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        trigger: 'scheduled',
      },
      updateProgress: vi.fn(),
    } as unknown as Job<PermissionRecrawlJobData>;

    mockConnectorConfig.findOne.mockResolvedValue({
      ...mockConfig,
      permissionConfig: { ...mockConfig.permissionConfig, mode: 'disabled' },
    });

    const workerModule = await import('../workers/permission-recrawl-worker.js');
    const workerInstance = workerModule.createPermissionRecrawlWorker(mockRedisHandle as any);
    const processor = (workerInstance as any).opts.processor;

    const result = await processor(mockJob);

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(0);
  });

  test('delegates to permission crawl worker', async () => {
    const mockJob = {
      id: 'job-123',
      data: {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        trigger: 'manual',
      },
      updateProgress: vi.fn(),
    } as unknown as Job<PermissionRecrawlJobData>;

    mockConnectorConfig.findOne
      .mockResolvedValueOnce({
        ...mockConfig,
        permissionConfig: { ...mockConfig.permissionConfig, mode: 'enabled' },
      })
      .mockResolvedValueOnce({
        ...mockConfig,
        permissionConfig: {
          ...mockConfig.permissionConfig,
          documentsProcessed: 5,
          averageAccuracy: 97,
          lastCrawlError: null,
        },
      });

    const workerModule = await import('../workers/permission-recrawl-worker.js');
    const workerInstance = workerModule.createPermissionRecrawlWorker(mockRedisHandle as any);
    const processor = (workerInstance as any).opts.processor;

    const result = await processor(mockJob);

    // Should delegate to permission crawl worker
    expect(mockCrawlQueue.add).toHaveBeenCalledWith(
      'permission-crawl',
      {
        connectorId: 'conn-1',
        tenantId: 'tenant-1',
        mode: 'enabled',
      },
      expect.objectContaining({
        jobId: expect.stringContaining('recrawl-conn-1'),
        priority: 1, // Manual trigger = high priority
      }),
    );

    // Should return result from updated config
    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(5);
    expect(result.averageAccuracy).toBe(97);
  });
});
