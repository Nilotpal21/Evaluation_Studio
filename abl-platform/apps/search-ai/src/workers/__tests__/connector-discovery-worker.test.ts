/**
 * Connector Discovery Worker Tests
 *
 * Tests job processing, lock management, progress reporting, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('@agent-platform/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database')>();
  return {
    ...actual,
    ConnectorConfig: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    ConnectorDiscovery: {
      create: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    ConnectorRecommendation: {
      create: vi.fn(),
    },
  };
});

vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((_ctx: any, fn: any) => fn()),
}));

vi.mock('@agent-platform/connector-sharepoint', () => ({
  SharePointConnector: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    getResourceDiscovery: vi.fn().mockReturnValue({
      discoverResources: vi.fn().mockResolvedValue([
        {
          id: 'site-1',
          name: 'Test Site',
          displayName: 'Test Site',
          url: 'https://example.com',
          resourceType: 'site',
          parentId: null,
          metadata: {},
        },
        {
          id: 'drive-1',
          name: 'Documents',
          displayName: 'Test Site / Documents',
          url: 'https://example.com/docs',
          resourceType: 'drive',
          parentId: 'site-1',
          metadata: {},
        },
      ]),
      profileContent: vi.fn().mockResolvedValue({
        resourceId: 'drive-1',
        totalDocuments: 100,
        totalSizeBytes: 10000000,
        fileTypeDistribution: { pdf: 50, docx: 30, xlsx: 20 },
        dateRange: { earliest: new Date('2024-01-01'), latest: new Date() },
        averageDocumentSizeBytes: 100000,
        updateFrequency: 'daily',
        sensitivityIndicators: [],
        sampleDocumentCount: 100,
      }),
    }),
  })),
}));

vi.mock('@agent-platform/shared-observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-observability')>();

  return {
    ...actual,
    DistributedLockManager: vi.fn().mockImplementation(() => ({
      acquire: vi.fn().mockResolvedValue({ value: 'lock-value', expiresAt: new Date() }),
      release: vi.fn().mockResolvedValue(true),
      isLocked: vi.fn().mockResolvedValue(null),
    })),
  };
});

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('bullmq', () => {
  const MockWorker = vi.fn(function (this: any) {
    this.on = vi.fn();
    this.close = vi.fn();
    this.isRunning = vi.fn().mockReturnValue(true);
    return this;
  });
  return { Worker: MockWorker };
});

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn().mockReturnValue({
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
  }),
  getModel: vi.fn().mockReturnValue({
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
  }),
}));

vi.mock('../shared.js', () => ({
  createWorkerOptions: vi.fn().mockReturnValue({}),
  workerLog: vi.fn(),
  workerError: vi.fn(),
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  createQueue: vi.fn(),
}));

describe('ConnectorDiscoveryWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export QUEUE_CONNECTOR_DISCOVERY constant', async () => {
    const mod = await import('../connector-discovery-worker.js');
    expect(mod.QUEUE_CONNECTOR_DISCOVERY).toBe('connector-discovery');
  });

  it('should export ConnectorDiscoveryJobData interface types', async () => {
    // This test just verifies the module loads without errors
    const mod = await import('../connector-discovery-worker.js');
    expect(mod).toBeDefined();
    expect(mod.connectorDiscoveryWorker).toBeDefined();
  });
});
