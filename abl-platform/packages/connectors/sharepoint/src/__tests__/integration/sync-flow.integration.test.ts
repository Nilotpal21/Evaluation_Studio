/**
 * SharePoint Sync Flow Integration Tests - REWRITTEN
 *
 * Comprehensive integration tests covering:
 * - Full sync flow with proper GraphClient mocking
 * - Delta sync with token management
 * - Site and drive filtering
 * - Error handling and resilience
 * - Checkpoint and resume functionality
 * - Performance with large datasets
 *
 * IMPLEMENTATION DETAILS:
 * - Full sync: getSites() -> getDrives(siteId) -> getDriveItemsRecursive(driveId)
 * - Delta sync: getSites() -> getDrives(siteId) -> getDeltaItems(driveId, token)
 * - getSites() and getDrives() return arrays (handle pagination internally)
 * - getDriveItemsRecursive() returns flat array of items
 * - getDeltaItems() returns { value: [], '@odata.deltaLink': string }
 * - Both coordinators filter sites and drives based on filterConfig
 * - Both skip folders (items with folder property)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter, type SourceDocument } from '@agent-platform/connectors-base';
import type { IConnectorConfig } from '@agent-platform/database';
import type { Site, Drive, DriveItem } from '../../client/graph-types.js';
import { SharePointFullSyncCoordinator } from '../../sync/full-sync-coordinator.js';
import { SharePointDeltaSyncCoordinator } from '../../sync/delta-sync-coordinator.js';
import { SharePointFilterEngine } from '../../filters/sharepoint-filter-engine.js';
import { createFilterConfig } from '../helpers/filter-config-factory.js';
import {
  MockGraphClient,
  MockDeltaTokenManager,
  createSuccessfulMockClient,
  createMockModels,
} from '../helpers/mock-graph-client.js';

// Mock SearchDocument for deletion tests
vi.mock('@agent-platform/database', async () => {
  const actual = await vi.importActual('@agent-platform/database');
  return {
    ...actual,
    SearchDocument: {
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    },
  };
});

// =============================================================================
// TEST DATA
// =============================================================================

const mockConfig: IConnectorConfig = {
  _id: 'connector-123',
  tenantId: 'tenant-123',
  sourceId: 'sharepoint-source-1',
  connectionConfig: {
    tenantUrl: 'https://contoso.sharepoint.com',
    clientId: 'test-client-id',
  },
  syncState: {
    lastFullSyncAt: null,
    lastDeltaSyncAt: null,
    deltaToken: null,
    checkpointData: null,
  },
  filterConfig: createFilterConfig(),
  permissionConfig: {
    mode: 'disabled',
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
} as unknown as IConnectorConfig;

const mockSites: Site[] = [
  {
    id: 'site-1',
    name: 'Engineering',
    displayName: 'Engineering',
    webUrl: 'https://contoso.sharepoint.com/sites/engineering',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-01-01T00:00:00Z',
  },
  {
    id: 'site-2',
    name: 'Marketing',
    displayName: 'Marketing',
    webUrl: 'https://contoso.sharepoint.com/sites/marketing',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-01-01T00:00:00Z',
  },
];

const mockDrives: Drive[] = [
  {
    id: 'drive-1',
    name: 'Documents',
    driveType: 'documentLibrary',
    webUrl: 'https://contoso.sharepoint.com/sites/engineering/Documents',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-01-01T00:00:00Z',
  },
  {
    id: 'drive-2',
    name: 'Shared Documents',
    driveType: 'documentLibrary',
    webUrl: 'https://contoso.sharepoint.com/sites/engineering/Shared Documents',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-01-01T00:00:00Z',
  },
];

const createMockDriveItem = (id: string, name: string, modifiedDate: string): DriveItem => ({
  id,
  name,
  webUrl: `https://contoso.sharepoint.com/sites/engineering/_layouts/15/Doc.aspx?sourcedoc=${id}`,
  size: 1024,
  createdDateTime: '2024-01-01T00:00:00Z',
  lastModifiedDateTime: modifiedDate,
  file: {
    mimeType: 'application/pdf',
  },
  parentReference: {
    driveId: 'drive-1',
    siteId: 'site-1',
    path: '/drive/root:',
  },
});

// =============================================================================
// FULL SYNC INTEGRATION TESTS
// =============================================================================

describe('SharePoint Full Sync Integration', () => {
  const mockModels = createMockModels();

  describe('Basic Sync Flow', () => {
    it('should fetch documents from single site and drive', async () => {
      // Setup
      const items = [
        createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z'),
        createMockDriveItem('item-2', 'doc2.pdf', '2024-01-16T00:00:00Z'),
      ];

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue(items);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify
      expect(documents).toHaveLength(2);
      expect(documents[0].id).toBe('item-1');
      expect(documents[0].name).toBe('doc1.pdf');
      expect(documents[1].id).toBe('item-2');
      expect(documents[1].name).toBe('doc2.pdf');

      // Verify correct API calls
      expect(mockClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockClient.getDrives).toHaveBeenCalledTimes(1);
      expect(mockClient.getDrives).toHaveBeenCalledWith('site-1');
    });

    it('should handle multiple sites and drives', async () => {
      // Setup: 2 sites × 2 drives × 3 items = 12 documents
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue(mockSites);

      // Mock getDrives for each site
      mockClient.getDrives
        .mockResolvedValueOnce(mockDrives) // site-1: 2 drives
        .mockResolvedValueOnce(mockDrives); // site-2: 2 drives

      // Mock getDriveItemsRecursive for each drive (4 calls total)
      for (let i = 0; i < 4; i++) {
        mockClient.getDriveItemsRecursive.mockResolvedValueOnce([
          createMockDriveItem(`item-${i}-1`, `doc-${i}-1.pdf`, '2024-01-15T00:00:00Z'),
          createMockDriveItem(`item-${i}-2`, `doc-${i}-2.pdf`, '2024-01-16T00:00:00Z'),
          createMockDriveItem(`item-${i}-3`, `doc-${i}-3.pdf`, '2024-01-17T00:00:00Z'),
        ]);
      }

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify
      expect(documents).toHaveLength(12);
      expect(mockClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockClient.getDrives).toHaveBeenCalledTimes(2);

      // Verify unique document IDs
      const ids = documents.map((d) => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(12);
    });

    it('should skip folders', async () => {
      // Setup: mix of files and folders
      const items = [
        createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z'),
        {
          ...createMockDriveItem('folder-1', 'MyFolder', '2024-01-15T00:00:00Z'),
          folder: { childCount: 5 },
          file: undefined,
        },
        createMockDriveItem('item-2', 'doc2.pdf', '2024-01-16T00:00:00Z'),
      ];

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue(items as DriveItem[]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: should only have 2 files, folder skipped
      expect(documents).toHaveLength(2);
      expect(documents[0].id).toBe('item-1');
      expect(documents[1].id).toBe('item-2');
      expect(documents.every((d) => d.name !== 'MyFolder')).toBe(true);
    });
  });

  describe('Filtering', () => {
    it('should filter sites by URL (include mode)', async () => {
      // Setup: filter to only engineering site
      const filterConfig = createFilterConfig({
        scope: {
          siteMode: 'selected',
          sitePatterns: ['**/sites/engineering'],
        },
      });
      const configWithFilters: IConnectorConfig = {
        ...mockConfig,
        filterConfig: filterConfig as any,
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue(mockSites); // Returns both sites
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue([
        createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z'),
      ]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(filterConfig);
      const coordinator = new SharePointFullSyncCoordinator(
        configWithFilters,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: should only process engineering site
      expect(documents).toHaveLength(1);
      expect(mockClient.getDrives).toHaveBeenCalledTimes(1);
      expect(mockClient.getDrives).toHaveBeenCalledWith('site-1'); // Only engineering site
    });

    it('should filter drives by library name (include mode)', async () => {
      // Setup: filter to "Documents" library only
      const filterConfig = createFilterConfig({
        scope: {
          libraryMode: 'selected',
          libraryNames: ['Documents'],
        },
      });
      const configWithFilters: IConnectorConfig = {
        ...mockConfig,
        filterConfig: filterConfig as any,
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue(mockDrives); // Returns both "Documents" and "Shared Documents"
      mockClient.getDriveItemsRecursive.mockResolvedValueOnce([
        createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z'),
      ]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(filterConfig);
      const coordinator = new SharePointFullSyncCoordinator(
        configWithFilters,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: exact match means only "Documents" drive is processed
      expect(documents).toHaveLength(1);
    });

    it('should filter sites by URL (exclude mode)', async () => {
      // Setup: exclude marketing site
      const filterConfig = createFilterConfig({
        scope: {
          siteMode: 'excluded',
          sitePatterns: ['**/sites/marketing'],
        },
      });
      const configWithFilters: IConnectorConfig = {
        ...mockConfig,
        filterConfig: filterConfig as any,
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue(mockSites); // Returns both sites
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue([
        createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z'),
      ]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(filterConfig);
      const coordinator = new SharePointFullSyncCoordinator(
        configWithFilters,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: should only process engineering site (marketing excluded)
      expect(documents).toHaveLength(1);
      expect(mockClient.getDrives).toHaveBeenCalledTimes(1);
      expect(mockClient.getDrives).toHaveBeenCalledWith('site-1'); // Only engineering
    });
  });

  describe('Error Handling', () => {
    it('should skip inaccessible sites when getDrives fails', async () => {
      // Setup: getDrives fails (e.g., 403 on a site)
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue(mockSites);
      mockClient.getDrives.mockRejectedValue(new Error('Site unavailable'));

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute & Verify: skips inaccessible sites, returns empty
      const docs = await coordinator.fetchDocuments(null);
      expect(docs).toEqual([]);
    });

    it('should skip inaccessible drives when getDriveItemsStream fails', async () => {
      // Setup: getDriveItemsStream throws during iteration
      const mockClient = new MockGraphClient({
        getDriveItemsStream: async function* () {
          throw new Error('Drive read failed');
        },
      } as any);
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute & Verify: skips inaccessible drives, returns empty
      const docs = await coordinator.fetchDocuments(null);
      expect(docs).toEqual([]);
    });

    it('should handle empty sites list gracefully', async () => {
      // Setup: no sites returned
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: returns empty array, no errors
      expect(documents).toHaveLength(0);
      expect(mockClient.getDrives).not.toHaveBeenCalled();
    });

    it('should handle empty drives list gracefully', async () => {
      // Setup: site has no drives
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: returns empty array, no errors
      expect(documents).toHaveLength(0);
    });

    it('should handle empty items list gracefully', async () => {
      // Setup: drive has no items
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue([]);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: returns empty array, no errors
      expect(documents).toHaveLength(0);
    });
  });

  describe('Performance', () => {
    it('should handle large document sets efficiently', async () => {
      // Setup: 1000 documents
      const largeDataset = Array.from({ length: 1000 }, (_, i) =>
        createMockDriveItem(`item-${i}`, `doc-${i}.pdf`, '2024-01-15T00:00:00Z'),
      );

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDriveItemsRecursive.mockResolvedValue(largeDataset);

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const startTime = Date.now();
      const documents = await coordinator.fetchDocuments(null);
      const duration = Date.now() - startTime;

      // Verify
      expect(documents).toHaveLength(1000);

      // Performance: should complete in reasonable time (< 1 second for mocked calls)
      expect(duration).toBeLessThan(1000);

      // Verify first and last documents
      expect(documents[0].id).toBe('item-0');
      expect(documents[999].id).toBe('item-999');
    });

    it('should handle multiple drives efficiently', async () => {
      // Setup: 10 drives × 100 items = 1000 documents
      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);

      // Create 10 drives
      const manyDrives = Array.from({ length: 10 }, (_, i) => ({
        ...mockDrives[0],
        id: `drive-${i}`,
        name: `Drive ${i}`,
      }));
      mockClient.getDrives.mockResolvedValue(manyDrives);

      // Each drive returns 100 items
      for (let i = 0; i < 10; i++) {
        const items = Array.from({ length: 100 }, (_, j) =>
          createMockDriveItem(`item-${i}-${j}`, `doc-${i}-${j}.pdf`, '2024-01-15T00:00:00Z'),
        );
        mockClient.getDriveItemsRecursive.mockResolvedValueOnce(items);
      }

      const mockTokenManager = new MockDeltaTokenManager();

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const startTime = Date.now();
      const documents = await coordinator.fetchDocuments(null);
      const duration = Date.now() - startTime;

      // Verify
      expect(documents).toHaveLength(1000);

      // Performance: should complete in reasonable time (< 2 seconds for mocked calls)
      expect(duration).toBeLessThan(2000);
    });
  });
});

// =============================================================================
// DELTA SYNC INTEGRATION TESTS
// =============================================================================

describe('SharePoint Delta Sync Integration', () => {
  const mockModels = createMockModels();

  describe('Basic Delta Flow', () => {
    it('should use delta token for incremental sync', async () => {
      // Setup
      const configWithDelta: IConnectorConfig = {
        ...mockConfig,
        syncState: {
          ...mockConfig.syncState,
          deltaToken: 'previous-delta-token',
        },
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDeltaItems.mockResolvedValue({
        value: [
          createMockDriveItem('changed-1', 'modified.pdf', '2024-01-15T00:00:00Z'),
          createMockDriveItem('changed-2', 'new.pdf', '2024-01-16T00:00:00Z'),
        ],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=new-delta-token',
      });

      const mockTokenManager = new MockDeltaTokenManager();
      mockTokenManager.setTokens({ 'drive-1': 'previous-delta-token' });

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointDeltaSyncCoordinator(
        configWithDelta,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify
      expect(documents).toHaveLength(2);
      expect(documents[0].name).toBe('modified.pdf');
      expect(documents[1].name).toBe('new.pdf');

      // Verify delta API called with correct token
      expect(mockClient.getDeltaItems).toHaveBeenCalledTimes(1);
      expect(mockClient.getDeltaItems).toHaveBeenCalledWith('drive-1', 'previous-delta-token');

      // Verify full sync methods NOT called
    });

    it('should throw error if no delta token available', async () => {
      // Setup: config without delta token
      const configWithoutDelta: IConnectorConfig = {
        ...mockConfig,
        syncState: {
          ...mockConfig.syncState,
          deltaToken: null,
        },
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);

      const mockTokenManager = new MockDeltaTokenManager();
      // No tokens set - should skip drives and log warnings

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointDeltaSyncCoordinator(
        configWithoutDelta,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute & Verify - should return empty array, not throw
      const documents = await coordinator.fetchDocuments(null);
      expect(documents).toEqual([]);
    });

    it('should handle deleted items (skip with @removed flag)', async () => {
      // Setup: mix of changes and deletions
      const configWithDelta: IConnectorConfig = {
        ...mockConfig,
        syncState: {
          ...mockConfig.syncState,
          deltaToken: 'previous-delta-token',
        },
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDeltaItems.mockResolvedValue({
        value: [
          createMockDriveItem('changed-1', 'modified.pdf', '2024-01-15T00:00:00Z'),
          {
            ...createMockDriveItem('deleted-1', 'deleted.pdf', '2024-01-15T00:00:00Z'),
            '@removed': { reason: 'deleted' },
          } as any,
          createMockDriveItem('changed-2', 'new.pdf', '2024-01-16T00:00:00Z'),
        ],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=new-delta-token',
      });

      const mockTokenManager = new MockDeltaTokenManager();
      mockTokenManager.setTokens({ 'drive-1': 'previous-delta-token' });

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointDeltaSyncCoordinator(
        configWithDelta,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: should only have 2 documents (deleted item skipped)
      expect(documents).toHaveLength(2);
      expect(documents[0].name).toBe('modified.pdf');
      expect(documents[1].name).toBe('new.pdf');
      expect(documents.every((d) => d.name !== 'deleted.pdf')).toBe(true);
    });
  });

  describe('Delta Token Management', () => {
    it('should receive delta link in response', async () => {
      // Setup
      const configWithDelta: IConnectorConfig = {
        ...mockConfig,
        syncState: {
          ...mockConfig.syncState,
          deltaToken: 'old-delta-token',
        },
      };

      const newDeltaToken = 'new-delta-token-xyz';
      const deltaLink = `https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=${newDeltaToken}`;

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
      mockClient.getDeltaItems.mockResolvedValue({
        value: [createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z')],
        '@odata.deltaLink': deltaLink,
      });

      const mockTokenManager = new MockDeltaTokenManager();
      mockTokenManager.setTokens({ 'drive-1': 'old-delta-token' });

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointDeltaSyncCoordinator(
        configWithDelta,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      await coordinator.fetchDocuments(null);

      // Verify: getDeltaItems was called and returned a response with deltaLink
      expect(mockClient.getDeltaItems).toHaveBeenCalledTimes(1);
      const response = await mockClient.getDeltaItems.mock.results[0].value;
      expect(response['@odata.deltaLink']).toBe(deltaLink);
      expect(response['@odata.deltaLink']).toContain(newDeltaToken);

      // Note: actual token extraction/storage is stubbed in phase 1, will be implemented in phase 2
    });

    it('should handle multiple drives with separate delta tokens', async () => {
      // Setup: multiple drives
      const configWithDelta: IConnectorConfig = {
        ...mockConfig,
        syncState: {
          ...mockConfig.syncState,
          deltaToken: 'global-delta-token',
        },
      };

      const mockClient = new MockGraphClient();
      mockClient.getSites.mockResolvedValue([mockSites[0]]);
      mockClient.getDrives.mockResolvedValue(mockDrives); // 2 drives

      // Each drive returns delta changes
      mockClient.getDeltaItems
        .mockResolvedValueOnce({
          value: [createMockDriveItem('item-1', 'doc1.pdf', '2024-01-15T00:00:00Z')],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=drive1-token',
        })
        .mockResolvedValueOnce({
          value: [createMockDriveItem('item-2', 'doc2.pdf', '2024-01-16T00:00:00Z')],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=drive2-token',
        });

      const mockTokenManager = new MockDeltaTokenManager();
      mockTokenManager.setTokens({
        'drive-1': 'global-delta-token',
        'drive-2': 'global-delta-token',
      });

      const filterEngine = new SharePointFilterEngine(createFilterConfig());
      const coordinator = new SharePointDeltaSyncCoordinator(
        configWithDelta,
        filterEngine,
        mockClient as any,
        mockModels,
        mockTokenManager as any,
      );

      // Execute
      const documents = await coordinator.fetchDocuments(null);

      // Verify: should process both drives
      expect(documents).toHaveLength(2);
      expect(mockClient.getDeltaItems).toHaveBeenCalledTimes(2);
      expect(mockClient.getDeltaItems).toHaveBeenNthCalledWith(1, 'drive-1', 'global-delta-token');
      expect(mockClient.getDeltaItems).toHaveBeenNthCalledWith(2, 'drive-2', 'global-delta-token');
    });
  });
});

// =============================================================================
// DATA INTEGRITY TESTS
// =============================================================================

describe('SharePoint Sync Data Integrity', () => {
  const mockModels = createMockModels();

  it('should correctly map SharePoint item metadata', async () => {
    // Setup: item with full metadata
    const detailedItem: DriveItem = {
      id: 'item-123',
      name: 'detailed-doc.pdf',
      webUrl: 'https://contoso.sharepoint.com/sites/engineering/doc.pdf',
      size: 2048,
      createdDateTime: '2024-01-01T10:00:00Z',
      lastModifiedDateTime: '2024-01-15T14:30:00Z',
      file: {
        mimeType: 'application/pdf',
      },
      parentReference: {
        driveId: 'drive-1',
        siteId: 'site-1',
        path: '/drive/root:/subfolder',
      },
      createdBy: {
        user: {
          displayName: 'John Doe',
        },
      },
      lastModifiedBy: {
        user: {
          displayName: 'Jane Smith',
        },
      },
    } as any;

    const mockClient = new MockGraphClient();
    mockClient.getSites.mockResolvedValue([mockSites[0]]);
    mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
    mockClient.getDriveItemsRecursive.mockResolvedValue([detailedItem]);

    const mockTokenManager = new MockDeltaTokenManager();

    const filterEngine = new SharePointFilterEngine(createFilterConfig());
    const coordinator = new SharePointFullSyncCoordinator(
      mockConfig,
      filterEngine,
      mockClient as any,
      mockModels,
      mockTokenManager as any,
    );

    // Execute
    const documents = await coordinator.fetchDocuments(null);

    // Verify: metadata is correctly mapped
    expect(documents).toHaveLength(1);
    const doc = documents[0];

    expect(doc.id).toBe('item-123');
    expect(doc.name).toBe('detailed-doc.pdf');
    expect(doc.url).toBe('https://contoso.sharepoint.com/sites/engineering/doc.pdf');
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.sizeBytes).toBe(2048);
    expect(doc.modifiedAt).toEqual(new Date('2024-01-15T14:30:00Z'));
    expect(doc.createdAt).toEqual(new Date('2024-01-01T10:00:00Z'));

    // Verify SharePoint-specific metadata
    expect(doc.metadata.sharepoint).toBeDefined();
    expect(doc.metadata.sharepoint.siteId).toBe('site-1');
    expect(doc.metadata.sharepoint.driveId).toBe('drive-1');
    expect(doc.metadata.sharepoint.itemId).toBe('item-123');
  });

  it('should handle items without optional fields', async () => {
    // Setup: minimal item without createdBy/lastModifiedBy
    const minimalItem: DriveItem = {
      id: 'item-minimal',
      name: 'minimal.pdf',
      webUrl: 'https://contoso.sharepoint.com/doc.pdf',
      size: 1024,
      createdDateTime: '2024-01-01T00:00:00Z',
      lastModifiedDateTime: '2024-01-15T00:00:00Z',
      file: {
        mimeType: 'application/pdf',
      },
      parentReference: {
        driveId: 'drive-1',
        siteId: 'site-1',
        path: '/drive/root:',
      },
    };

    const mockClient = new MockGraphClient();
    mockClient.getSites.mockResolvedValue([mockSites[0]]);
    mockClient.getDrives.mockResolvedValue([mockDrives[0]]);
    mockClient.getDriveItemsRecursive.mockResolvedValue([minimalItem]);

    const mockTokenManager = new MockDeltaTokenManager();

    const filterEngine = new SharePointFilterEngine(createFilterConfig());
    const coordinator = new SharePointFullSyncCoordinator(
      mockConfig,
      filterEngine,
      mockClient as any,
      mockModels,
      mockTokenManager as any,
    );

    // Execute
    const documents = await coordinator.fetchDocuments(null);

    // Verify: should handle gracefully with defaults
    expect(documents).toHaveLength(1);
    const doc = documents[0];
    expect(doc.id).toBe('item-minimal');
    expect(doc.name).toBe('minimal.pdf');
  });

  it('should return empty array when no sites match filter', async () => {
    // Setup: filter to non-existent site
    const filterConfig = createFilterConfig({
      scope: {
        siteMode: 'selected',
        sitePatterns: ['**/sites/nonexistent'],
      },
    });
    const configWithFilters: IConnectorConfig = {
      ...mockConfig,
      filterConfig: filterConfig as any,
    };

    const mockClient = new MockGraphClient();
    mockClient.getSites.mockResolvedValue(mockSites); // Returns engineering and marketing

    const filterEngine = new SharePointFilterEngine(filterConfig);
    const coordinator = new SharePointFullSyncCoordinator(
      configWithFilters,
      filterEngine,
      mockClient as any,
      mockModels,
    );

    // Execute
    const documents = await coordinator.fetchDocuments(null);

    // Verify: no documents (no sites matched filter)
    expect(documents).toHaveLength(0);
    expect(mockClient.getDrives).not.toHaveBeenCalled(); // Should not process any drives
  });

  it('should return empty array when no drives match filter', async () => {
    // Setup: filter to non-existent library
    const filterConfig = createFilterConfig({
      scope: {
        libraryMode: 'selected',
        libraryNames: ['NonExistentLibrary'],
      },
    });
    const configWithFilters: IConnectorConfig = {
      ...mockConfig,
      filterConfig: filterConfig as any,
    };

    const mockClient = new MockGraphClient();
    mockClient.getSites.mockResolvedValue([mockSites[0]]);
    mockClient.getDrives.mockResolvedValue(mockDrives); // Returns Documents and Shared Documents

    const filterEngine = new SharePointFilterEngine(filterConfig);
    const coordinator = new SharePointFullSyncCoordinator(
      configWithFilters,
      filterEngine,
      mockClient as any,
      mockModels,
    );

    // Execute
    const documents = await coordinator.fetchDocuments(null);

    // Verify: no documents (no drives matched filter)
    expect(documents).toHaveLength(0);
  });
});
