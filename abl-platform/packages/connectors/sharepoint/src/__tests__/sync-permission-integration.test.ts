/**
 * Sync-Permission Integration Tests
 *
 * Tests the integration between sync coordinators and permission crawling:
 * - Permission crawling is triggered after document sync
 * - Crawling mode respects connector configuration
 * - Sync continues even if permission crawl fails
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointFullSyncCoordinator } from '../sync/full-sync-coordinator.js';
import { SharePointDeltaSyncCoordinator } from '../sync/delta-sync-coordinator.js';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import type { IConnectorConfig } from '@agent-platform/database';
import { DriveDeltaToken } from '@agent-platform/database';
import { createFilterConfig } from './helpers/filter-config-factory.js';

// =============================================================================
// Mocks
// =============================================================================

const mockDriveItemsData: any[] = [];

const mockGraphClient = {
  getSites: vi.fn(),
  getDrives: vi.fn(),
  getDriveItemsRecursive: vi.fn(),
  getDriveItemsStream: async function* (driveId: string, batchSize: number = 100) {
    // Yield mock items in batches
    const items = mockDriveItemsData;
    for (let i = 0; i < items.length; i += batchSize) {
      yield items.slice(i, i + batchSize);
    }
  },
  getDeltaItems: vi.fn(),
  getDriveItemContent: vi.fn().mockResolvedValue(Buffer.from('file-content')),
  getItemPermissions: vi.fn(),
  getGroupMembers: vi.fn(),
};

// Mock database models (for DriveDeltaToken imports in delta sync tests)
vi.mock('@agent-platform/database', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/database')>(
    '@agent-platform/database',
  );
  return {
    ...actual,
    DriveDeltaToken: {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
    },
  };
});

// Mock fs/promises used by BaseSyncCoordinator for logging and file upload
vi.mock('fs/promises', () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock SharePointPermissionCrawler
const mockCrawlDocuments = vi.fn().mockResolvedValue({
  success: true,
  mode: 'simplified',
  documentsProcessed: 2,
  averageAccuracy: 95,
  durationMs: 100,
  errors: [],
});

vi.mock('../permissions/sharepoint-permission-crawler.js', () => {
  return {
    SharePointPermissionCrawler: class {
      crawlDocuments = mockCrawlDocuments;
    },
  };
});

/**
 * Create mock models with all methods required by BaseSyncCoordinator.performSync().
 */
function createFullSyncMockModels() {
  let docCounter = 0;
  const leanMock = vi.fn().mockResolvedValue(null);
  const connectorFindOneMock = vi.fn().mockReturnValue({ lean: leanMock });

  return {
    SearchDocument: {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
      create: vi.fn().mockImplementation((data: any) => ({
        _id: `doc-${++docCounter}`,
        ...data,
        save: vi.fn().mockResolvedValue(undefined),
      })),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
    } as any,
    SearchSource: {
      findOne: vi.fn().mockResolvedValue({ _id: 'source-1', indexId: 'index-1', status: 'active' }),
      findById: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
      findByIdAndUpdate: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
      findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
    } as any,
    SyncCheckpoint: {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((data: any) => ({
        _id: 'checkpoint-1',
        ...data,
        save: vi.fn().mockResolvedValue(undefined),
      })),
    } as any,
    ConnectorConfig: {
      findOne: connectorFindOneMock,
      findById: vi.fn().mockResolvedValue(null),
      findByIdAndUpdate: vi.fn().mockResolvedValue(null),
    } as any,
    DriveDeltaToken: (() => {
      const dtLeanMock = vi.fn().mockResolvedValue(null);
      const dtFindOneMock = vi.fn().mockReturnValue({ lean: dtLeanMock });
      return {
        findOne: dtFindOneMock,
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
        _leanMock: dtLeanMock,
      };
    })() as any,
  };
}

// =============================================================================
// Test Data
// =============================================================================

function createMockConfig(permissionMode: 'full' | 'simplified' | 'disabled'): IConnectorConfig {
  return {
    _id: 'connector-123',
    tenantId: 'tenant-123',
    sourceId: 'source-123',
    connectorType: 'sharepoint',
    oauthTokenId: 'token-123',
    connectionConfig: {},
    filterConfig: createFilterConfig(),
    syncState: {
      lastFullSyncAt: null,
      lastDeltaSyncAt: null,
      deltaToken: null,
      checkpointData: null,
      totalDocuments: 0,
      processedDocuments: 0,
      failedDocuments: 0,
      currentJobId: null,
      syncInProgress: false,
      lastSyncError: null,
    },
    permissionConfig: {
      mode: permissionMode,
      crawlSchedule: null,
      lastCrawlAt: null,
      currentJobId: null,
      crawlInProgress: false,
      documentsProcessed: 0,
      averageAccuracy: 0,
      lastCrawlError: null,
    },
    errorState: {
      consecutiveFailures: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      isPaused: false,
      pausedAt: null,
      pauseReason: null,
    },
    _v: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any as IConnectorConfig;
}

const mockSite = {
  id: 'site-1',
  name: 'Test Site',
  webUrl: 'https://contoso.sharepoint.com/sites/test',
};

const mockDrive = {
  id: 'drive-1',
  name: 'Documents',
  webUrl: 'https://contoso.sharepoint.com/sites/test/Shared%20Documents',
};

const mockDriveItems = [
  {
    id: 'item-1',
    name: 'Document1.docx',
    webUrl: 'https://contoso.sharepoint.com/sites/test/Shared%20Documents/Document1.docx',
    size: 1024,
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    lastModifiedDateTime: '2024-01-15T10:00:00Z',
    createdDateTime: '2024-01-10T10:00:00Z',
    createdBy: { user: { displayName: 'John Doe' } },
    lastModifiedBy: { user: { displayName: 'Jane Smith' } },
  },
  {
    id: 'item-2',
    name: 'Document2.xlsx',
    webUrl: 'https://contoso.sharepoint.com/sites/test/Shared%20Documents/Document2.xlsx',
    size: 2048,
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    lastModifiedDateTime: '2024-01-16T10:00:00Z',
    createdDateTime: '2024-01-11T10:00:00Z',
    createdBy: { user: { displayName: 'John Doe' } },
    lastModifiedBy: { user: { displayName: 'Jane Smith' } },
  },
];

const mockPermissions = [
  {
    id: 'perm-1',
    roles: ['read'],
    grantedToV2: {
      user: {
        id: 'user-1',
        email: 'john@contoso.com',
        displayName: 'John Doe',
      },
    },
  },
];

// =============================================================================
// Full Sync Coordinator Tests
// =============================================================================

describe('SharePointFullSyncCoordinator - Permission Integration', () => {
  let mockModels: ReturnType<typeof createFullSyncMockModels>;
  let config: IConnectorConfig;
  let filterEngine: SharePointFilterEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockModels = createFullSyncMockModels();

    // Set environment variables for Neo4j config
    process.env.NEO4J_URI = 'neo4j://localhost:7687';
    process.env.NEO4J_USERNAME = 'neo4j';
    process.env.NEO4J_PASSWORD = 'password';
    process.env.NEO4J_DATABASE = 'neo4j';

    // Setup mock responses
    mockGraphClient.getSites.mockResolvedValue([mockSite]);
    mockGraphClient.getDrives.mockResolvedValue([mockDrive]);
    mockGraphClient.getDriveItemsRecursive.mockResolvedValue(mockDriveItems);
    // Set up data for streaming
    mockDriveItemsData.length = 0;
    mockDriveItemsData.push(...mockDriveItems);
    mockGraphClient.getDeltaItems.mockResolvedValue({
      value: [],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=xyz',
    });
    mockGraphClient.getDriveItemContent.mockResolvedValue(Buffer.from('mock-content'));
    mockGraphClient.getItemPermissions.mockResolvedValue(mockPermissions);
  });

  afterEach(() => {
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_DATABASE;
  });

  test('crawls permissions when mode is simplified', async () => {
    config = createMockConfig('simplified');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    const coordinator = new SharePointFullSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    const result = await coordinator.performSync('full');

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(2);

    // Verify permission crawler was called with documents
    expect(mockCrawlDocuments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          driveId: 'drive-1',
          itemId: 'item-1',
          name: 'Document1.docx',
        }),
        expect.objectContaining({
          driveId: 'drive-1',
          itemId: 'item-2',
          name: 'Document2.xlsx',
        }),
      ]),
    );
  });

  test('crawls permissions when mode is full', async () => {
    config = createMockConfig('full');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    const coordinator = new SharePointFullSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    const result = await coordinator.performSync('full');

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(2);

    // Verify permission crawler was called
    expect(mockCrawlDocuments).toHaveBeenCalled();
  });

  test('skips permission crawling when mode is disabled', async () => {
    config = createMockConfig('disabled');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    mockCrawlDocuments.mockClear(); // Clear previous calls

    const coordinator = new SharePointFullSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    const result = await coordinator.performSync('full');

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(2);

    // Verify permission crawler was NOT called
    expect(mockCrawlDocuments).not.toHaveBeenCalled();
  });

  test('continues sync even if permission crawl fails', async () => {
    config = createMockConfig('simplified');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    // Mock permission crawler to fail
    mockCrawlDocuments.mockRejectedValueOnce(new Error('Permission crawl failed'));

    const coordinator = new SharePointFullSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    const result = await coordinator.performSync('full');

    // Sync should still succeed
    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(2);

    // Reset mock for next tests
    mockCrawlDocuments.mockResolvedValue({
      success: true,
      mode: 'simplified',
      documentsProcessed: 2,
      averageAccuracy: 95,
      durationMs: 100,
      errors: [],
    });
  });
});

// =============================================================================
// Delta Sync Coordinator Tests
// =============================================================================

describe('SharePointDeltaSyncCoordinator - Permission Integration', () => {
  let mockModels: ReturnType<typeof createFullSyncMockModels>;
  let config: IConnectorConfig;
  let filterEngine: SharePointFilterEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockModels = createFullSyncMockModels();

    // Set environment variables for Neo4j config
    process.env.NEO4J_URI = 'neo4j://localhost:7687';
    process.env.NEO4J_USERNAME = 'neo4j';
    process.env.NEO4J_PASSWORD = 'password';
    process.env.NEO4J_DATABASE = 'neo4j';

    // Setup mock responses
    mockGraphClient.getSites.mockResolvedValue([mockSite]);
    mockGraphClient.getDrives.mockResolvedValue([mockDrive]);
    mockGraphClient.getDeltaItems.mockResolvedValue({
      value: [mockDriveItems[0]], // Only one changed item
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=xyz',
    });
    mockGraphClient.getDriveItemContent.mockResolvedValue(Buffer.from('mock-content'));
    mockGraphClient.getItemPermissions.mockResolvedValue(mockPermissions);

    // Configure mock DriveDeltaToken to return existing token for drive-1
    // DeltaTokenManager calls model.findOne({...}).lean()
    (mockModels.DriveDeltaToken as any)._leanMock.mockImplementation(() => {
      return Promise.resolve({
        _id: 'token-1',
        tenantId: 'tenant-123',
        connectorId: 'connector-123',
        driveId: 'drive-1',
        deltaLink: 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=abc',
        lastSyncAt: new Date(),
        itemsProcessedSinceToken: 10,
      });
    });
  });

  afterEach(() => {
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_DATABASE;
  });

  test('crawls permissions for changed documents in delta sync', async () => {
    config = createMockConfig('simplified');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    mockCrawlDocuments.mockClear(); // Clear previous calls

    const coordinator = new SharePointDeltaSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    await coordinator.performSync('delta');

    // Verify permission crawler was called with changed documents
    // Note: We only verify the permission crawl behavior, not overall sync success
    // (which has separate test coverage in delta-sync-coordinator.test.ts)
    expect(mockCrawlDocuments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          driveId: 'drive-1',
          itemId: 'item-1',
        }),
      ]),
    );
  });

  test('skips permission crawling in delta sync when disabled', async () => {
    config = createMockConfig('disabled');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    mockCrawlDocuments.mockClear(); // Clear previous calls

    const coordinator = new SharePointDeltaSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    await coordinator.performSync('delta');

    // Verify permission crawler was NOT called
    expect(mockCrawlDocuments).not.toHaveBeenCalled();
  });

  test('handles deleted documents without permission crawl', async () => {
    config = createMockConfig('simplified');
    filterEngine = new SharePointFilterEngine(config.filterConfig as any);

    mockCrawlDocuments.mockClear(); // Clear previous calls

    // Mock delta response with deleted item
    mockGraphClient.getDeltaItems.mockResolvedValue({
      value: [
        {
          id: 'item-1',
          name: 'Deleted.docx',
          '@removed': { reason: 'deleted' },
        },
      ],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=xyz',
    });

    const coordinator = new SharePointDeltaSyncCoordinator(
      config,
      filterEngine,
      mockGraphClient as any,
      mockModels as any,
    );

    await coordinator.performSync('delta');

    // Verify permission crawler was NOT called (no documents to crawl - only deletions)
    expect(mockCrawlDocuments).not.toHaveBeenCalled();
  });
});
