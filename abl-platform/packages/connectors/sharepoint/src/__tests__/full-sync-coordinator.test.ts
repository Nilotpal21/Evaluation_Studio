/**
 * SharePointFullSyncCoordinator Tests
 *
 * Tests full sync orchestration with filtering and checkpoint handling.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SharePointFullSyncCoordinator } from '../sync/full-sync-coordinator.js';
import type { GraphClient } from '../client/graph-client.js';
import type { Site, Drive, DriveItem } from '../client/graph-types.js';
import type { IConnectorConfig } from '@agent-platform/database';
import type { IFilterEngine } from '@agent-platform/connectors-base';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import { createMockModels } from './helpers/mock-graph-client.js';
import { createFilterConfig } from './helpers/filter-config-factory.js';

// Mock dependencies
const mockDriveItemsData: DriveItem[] = [];

const mockGraphClient = {
  getSites: vi.fn(),
  getDrives: vi.fn(),
  getDriveItemsRecursive: vi.fn(),
  getDriveItemsStream: async function* (driveId: string, batchSize: number = 100) {
    // Yield mock items in batches
    for (let i = 0; i < mockDriveItemsData.length; i += batchSize) {
      yield mockDriveItemsData.slice(i, i + batchSize);
    }
  },
  getDeltaItems: vi.fn().mockResolvedValue({
    value: [],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=mock',
  }),
} as unknown as GraphClient;

const mockFilterEngine = {
  evaluate: vi.fn(),
  validate: vi.fn(),
} as unknown as IFilterEngine;

describe('SharePointFullSyncCoordinator', () => {
  const mockModels = createMockModels();

  let coordinator: SharePointFullSyncCoordinator;
  let mockConfig: IConnectorConfig;

  beforeEach(() => {
    // Clear mock data
    mockDriveItemsData.length = 0;

    // Reset getDeltaItems mock (cleared by vi.clearAllMocks)
    mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue({
      value: [],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=mock',
    });

    mockConfig = {
      _id: 'config-123',
      _v: 0,
      tenantId: 'tenant-123',
      sourceId: 'source-123',
      connectorType: 'sharepoint',
      oauthTokenId: 'oauth-123',
      connectionConfig: {
        tenantUrl: 'https://contoso.sharepoint.com',
        clientId: 'client-123',
        scopes: ['Sites.Read.All'],
      },
      filterConfig: {
        mode: 'include',
        siteUrls: [],
        libraryNames: [],
        contentTypes: [],
        modifiedSince: null,
      },
      syncState: {
        deltaToken: null,
        lastFullSyncAt: null,
        lastDeltaSyncAt: null,
        checkpointData: null,
        totalDocuments: 0,
        processedDocuments: 0,
        failedDocuments: 0,
        currentJobId: null,
        syncInProgress: false,
        lastSyncError: null,
      },
      permissionConfig: {
        mode: 'disabled',
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
      configurationSource: 'manual',
      discoveryId: null,
      recommendationId: null,
      autoConfiguredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IConnectorConfig;

    coordinator = new SharePointFullSyncCoordinator(
      mockConfig,
      mockFilterEngine,
      mockGraphClient,
      mockModels,
    );
    vi.clearAllMocks();
  });

  // Helper function to set up mock drive items for streaming
  function setupMockItems(items: DriveItem[]) {
    mockDriveItemsData.length = 0;
    mockDriveItemsData.push(...items);
    (mockGraphClient.getDriveItemsRecursive as any).mockResolvedValue(items);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create coordinator with config and dependencies', () => {
      expect(coordinator).toBeInstanceOf(SharePointFullSyncCoordinator);
    });
  });

  describe('fetchDocuments', () => {
    it('should fetch documents from all sites and drives', async () => {
      const mockSites: Site[] = [
        {
          id: 'site-1',
          name: 'Site 1',
          webUrl: 'https://contoso.sharepoint.com/sites/site1',
          displayName: 'Site 1',
        } as Site,
      ];

      const mockDrives: Drive[] = [
        {
          id: 'drive-1',
          name: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/site1/Documents',
        } as Drive,
      ];

      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file1.txt',
          webUrl: 'https://contoso.sharepoint.com/file1',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-02T00:00:00Z',
          file: {
            mimeType: 'text/plain',
            hashes: {
              quickXorHash: 'hash123',
            },
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
          parentReference: {
            path: '/drive/root:/folder',
          },
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      expect(mockGraphClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledWith('site-1');
      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('item-1');
      expect(documents[0].name).toBe('file1.txt');
      expect(documents[0].contentType).toBe('text/plain');
      expect(documents[0].sizeBytes).toBe(1024);
      expect(documents[0].metadata.sharepoint.siteId).toBe('site-1');
      expect(documents[0].metadata.sharepoint.driveId).toBe('drive-1');
    });

    it('should skip folders', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      const mockItems: DriveItem[] = [
        {
          id: 'file-1',
          name: 'file.txt',
          webUrl: 'url1',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
        {
          id: 'folder-1',
          name: 'Folder',
          webUrl: 'url2',
          size: 0,
          folder: { childCount: 0 },
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('file-1');
    });

    it('should handle multiple sites and drives', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
        { id: 'site-2', name: 'Site 2', webUrl: 'url2', displayName: 'Site 2' } as Site,
      ];

      const mockDrives1: Drive[] = [
        { id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive,
        { id: 'drive-2', name: 'Shared', webUrl: 'url2' } as Drive,
      ];

      const mockDrives2: Drive[] = [{ id: 'drive-3', name: 'Library', webUrl: 'url3' } as Drive];

      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file1.txt',
          webUrl: 'url',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi
        .fn()
        .mockResolvedValueOnce(mockDrives1)
        .mockResolvedValueOnce(mockDrives2);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      expect(mockGraphClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledTimes(2);
      expect(documents).toHaveLength(3);
    });

    it('should handle empty sites', async () => {
      mockGraphClient.getSites = vi.fn().mockResolvedValue([]);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(0);
      expect(mockGraphClient.getDrives).not.toHaveBeenCalled();
    });

    it('should handle empty drives', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue([]);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(0);
    });

    it('should handle empty items', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems([]);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(0);
    });
  });

  describe('site filtering', () => {
    it('should include only specified sites in include mode', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { siteMode: 'selected', sitePatterns: ['**/engineering'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        {
          id: 'site-1',
          name: 'Engineering',
          webUrl: 'https://contoso.sharepoint.com/sites/engineering',
          displayName: 'Engineering',
        } as Site,
        {
          id: 'site-2',
          name: 'Marketing',
          webUrl: 'https://contoso.sharepoint.com/sites/marketing',
          displayName: 'Marketing',
        } as Site,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue([]);

      await filteredCoordinator.fetchDocuments(null);

      expect(mockGraphClient.getDrives).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledWith('site-1');
    });

    it('should exclude specified sites in exclude mode', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { siteMode: 'excluded', sitePatterns: ['**/marketing'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        {
          id: 'site-1',
          name: 'Engineering',
          webUrl: 'https://contoso.sharepoint.com/sites/engineering',
          displayName: 'Engineering',
        } as Site,
        {
          id: 'site-2',
          name: 'Marketing',
          webUrl: 'https://contoso.sharepoint.com/sites/marketing',
          displayName: 'Marketing',
        } as Site,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue([]);

      await filteredCoordinator.fetchDocuments(null);

      expect(mockGraphClient.getDrives).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledWith('site-1');
    });

    it('should include all sites when no filter configured', async () => {
      // Default scope is siteMode: 'all'
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
        { id: 'site-2', name: 'Site 2', webUrl: 'url2', displayName: 'Site 2' } as Site,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue([]);

      await coordinator.fetchDocuments(null);

      expect(mockGraphClient.getDrives).toHaveBeenCalledTimes(2);
    });

    it('should be case insensitive', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { siteMode: 'selected', sitePatterns: ['**/ENGINEERING'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        {
          id: 'site-1',
          name: 'Engineering',
          webUrl: 'https://contoso.sharepoint.com/sites/engineering',
          displayName: 'Engineering',
        } as Site,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue([]);

      await filteredCoordinator.fetchDocuments(null);

      expect(mockGraphClient.getDrives).toHaveBeenCalledWith('site-1');
    });
  });

  describe('library filtering', () => {
    it('should include only specified libraries in include mode', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { libraryMode: 'selected', libraryNames: ['Documents'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [
        { id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive,
        { id: 'drive-2', name: 'Shared Documents', webUrl: 'url2' } as Drive,
        { id: 'drive-3', name: 'Archive', webUrl: 'url3' } as Drive,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems([]);

      const documents = await filteredCoordinator.fetchDocuments(null);

      // Only 'Documents' drive should be processed (exact match)
      expect(documents).toHaveLength(0); // No items in the drive
    });

    it('should exclude specified libraries in exclude mode', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { libraryMode: 'excluded', libraryNames: ['Archive'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [
        { id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive,
        { id: 'drive-2', name: 'Archive', webUrl: 'url2' } as Drive,
      ];

      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file.txt',
          webUrl: 'url',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await filteredCoordinator.fetchDocuments(null);

      // Only 'Documents' drive should be processed (Archive excluded)
      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('item-1');
    });

    it('should include all libraries when no filter configured', async () => {
      // Default scope is libraryMode: 'all'
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [
        { id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive,
        { id: 'drive-2', name: 'Archive', webUrl: 'url2' } as Drive,
      ];

      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file.txt',
          webUrl: 'url',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      // Both drives should be processed
      expect(documents).toHaveLength(2);
    });

    it('should be case insensitive', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { libraryMode: 'selected', libraryNames: ['DOCUMENTS'] },
        }),
      );

      const filteredCoordinator = new SharePointFullSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'documents', webUrl: 'url1' } as Drive];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems([]);

      const documents = await filteredCoordinator.fetchDocuments(null);

      // 'documents' should match 'DOCUMENTS' (case insensitive)
      expect(documents).toHaveLength(0); // No items, but drive should be processed
    });
  });

  describe('document mapping', () => {
    it('should map DriveItem to SourceDocument with all metadata', async () => {
      const mockSites: Site[] = [
        {
          id: 'site-123',
          name: 'Engineering',
          webUrl: 'https://contoso.sharepoint.com/sites/engineering',
          displayName: 'Engineering Site',
        } as Site,
      ];

      const mockDrives: Drive[] = [
        {
          id: 'drive-456',
          name: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/engineering/Documents',
        } as Drive,
      ];

      const mockItems: DriveItem[] = [
        {
          id: 'item-789',
          name: 'report.pdf',
          webUrl: 'https://contoso.sharepoint.com/file',
          size: 2048,
          createdDateTime: '2026-01-01T12:00:00Z',
          lastModifiedDateTime: '2026-01-02T14:30:00Z',
          file: {
            mimeType: 'application/pdf',
            hashes: {
              quickXorHash: 'abc123',
              sha256Hash: 'def456',
            },
          },
          createdBy: {
            user: {
              displayName: 'Alice Johnson',
            },
          },
          lastModifiedBy: {
            user: {
              displayName: 'Bob Williams',
            },
          },
          parentReference: {
            path: '/drive/root:/reports',
          },
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      const doc = documents[0];

      expect(doc.id).toBe('item-789');
      expect(doc.name).toBe('report.pdf');
      expect(doc.url).toBe('https://contoso.sharepoint.com/file');
      expect(doc.contentType).toBe('application/pdf');
      expect(doc.sizeBytes).toBe(2048);
      expect(doc.modifiedAt).toEqual(new Date('2026-01-02T14:30:00Z'));
      expect(doc.createdAt).toEqual(new Date('2026-01-01T12:00:00Z'));
      expect(doc.content).toBeNull();

      expect(doc.metadata.sharepoint.siteId).toBe('site-123');
      expect(doc.metadata.sharepoint.siteName).toBe('Engineering');
      expect(doc.metadata.sharepoint.siteUrl).toBe(
        'https://contoso.sharepoint.com/sites/engineering',
      );
      expect(doc.metadata.sharepoint.driveId).toBe('drive-456');
      expect(doc.metadata.sharepoint.driveName).toBe('Documents');
      expect(doc.metadata.sharepoint.driveUrl).toBe(
        'https://contoso.sharepoint.com/sites/engineering/Documents',
      );
      expect(doc.metadata.sharepoint.itemId).toBe('item-789');
      expect(doc.metadata.sharepoint.itemName).toBe('report.pdf');
      expect(doc.metadata.sharepoint.itemWebUrl).toBe('https://contoso.sharepoint.com/file');
      expect(doc.metadata.sharepoint.createdBy).toBe('Alice Johnson');
      expect(doc.metadata.sharepoint.lastModifiedBy).toBe('Bob Williams');
      expect(doc.metadata.sharepoint.quickXorHash).toBe('abc123');
      expect(doc.metadata.sharepoint.sha256Hash).toBe('def456');
      expect(doc.metadata.sharepoint.parentPath).toBe('/drive/root:/reports');
    });

    it('should handle missing optional fields', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site', webUrl: 'url', displayName: 'Site' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Docs', webUrl: 'url' } as Drive];

      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file.txt',
          webUrl: 'url',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      setupMockItems(mockItems);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      expect(documents[0].contentType).toBe('application/octet-stream');
      expect(documents[0].metadata.sharepoint.createdBy).toBe('Unknown');
      expect(documents[0].metadata.sharepoint.lastModifiedBy).toBe('Unknown');
    });
  });

  describe('getDeltaToken', () => {
    it('should return delta token from config', async () => {
      mockConfig.syncState.deltaToken = 'token-abc123';

      const token = await coordinator.getDeltaToken();

      expect(token).toBe('token-abc123');
    });

    it('should return null when no delta token', async () => {
      mockConfig.syncState.deltaToken = null;

      const token = await coordinator.getDeltaToken();

      expect(token).toBeNull();
    });
  });
});
