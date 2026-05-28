/**
 * SharePointDeltaSyncCoordinator Tests
 *
 * Tests incremental sync using delta queries with per-drive token management,
 * filtering, and deletion handling.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SharePointDeltaSyncCoordinator } from '../sync/delta-sync-coordinator.js';
import type { GraphClient } from '../client/graph-client.js';
import type { Site, Drive, DriveItem, DriveItemCollection } from '../client/graph-types.js';
import type { IConnectorConfig } from '@agent-platform/database';
import type { IFilterEngine } from '@agent-platform/connectors-base';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import { createMockModels } from './helpers/mock-graph-client.js';
import { createFilterConfig } from './helpers/filter-config-factory.js';

// Mock database models
vi.mock('@agent-platform/database', async () => {
  const actual = await vi.importActual('@agent-platform/database');
  return {
    ...actual,
    DriveDeltaToken: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    SearchDocument: {
      updateMany: vi.fn(),
    },
  };
});

// Import after mocking
import { DriveDeltaToken, SearchDocument } from '@agent-platform/database';

// Mock dependencies
const mockGraphClient = {
  getSites: vi.fn(),
  getDrives: vi.fn(),
  getDeltaItems: vi.fn(),
} as unknown as GraphClient;

const mockFilterEngine = {
  evaluate: vi.fn(),
  validate: vi.fn(),
} as unknown as IFilterEngine;

describe('SharePointDeltaSyncCoordinator', () => {
  const mockModels = {
    SearchDocument,
    SearchSource: {} as any,
    SyncCheckpoint: {} as any,
    ConnectorConfig: {} as any,
    DriveDeltaToken,
  };

  let coordinator: SharePointDeltaSyncCoordinator;
  let mockConfig: IConnectorConfig;

  beforeEach(() => {
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
        deltaToken: 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=abc123',
        lastFullSyncAt: new Date('2026-01-01T00:00:00Z'),
        lastDeltaSyncAt: null,
        checkpointData: null,
        totalDocuments: 100,
        processedDocuments: 100,
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

    coordinator = new SharePointDeltaSyncCoordinator(
      mockConfig,
      mockFilterEngine,
      mockGraphClient,
      mockModels,
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create coordinator with config and dependencies', () => {
      expect(coordinator).toBeInstanceOf(SharePointDeltaSyncCoordinator);
    });
  });

  describe('fetchDocuments', () => {
    it('should fetch only changed documents using delta token', async () => {
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

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'item-1',
            name: 'modified-file.txt',
            webUrl: 'https://contoso.sharepoint.com/file1',
            size: 2048,
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T12:00:00Z',
            file: {
              mimeType: 'text/plain',
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
          } as DriveItem,
        ],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=xyz789',
      };

      // Mock delta token lookup
      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          deltaLink: 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=abc123',
        }),
      } as any);

      // Mock delta token save
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      const documents = await coordinator.fetchDocuments(null);

      expect(mockGraphClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledWith('site-1');
      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledWith(
        'drive-1',
        'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=abc123',
      );
      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('item-1');
      expect(documents[0].name).toBe('modified-file.txt');

      // Verify delta token was saved
      expect(DriveDeltaToken.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 'tenant-123', connectorId: 'config-123', driveId: 'drive-1' },
        expect.objectContaining({
          $set: expect.objectContaining({ deltaLink: expect.any(String) }),
        }),
        expect.any(Object),
      );
    });

    it('should skip drive when no delta token exists', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      // Mock no delta token found
      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);

      const documents = await coordinator.fetchDocuments(null);

      // Should skip drive without token
      expect(documents).toHaveLength(0);
      expect(mockGraphClient.getDeltaItems).not.toHaveBeenCalled();
    });

    it('should skip folders in delta response', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'file-1',
            name: 'file.txt',
            webUrl: 'url1',
            size: 1024,
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
          } as DriveItem,
          {
            id: 'folder-1',
            name: 'Folder',
            webUrl: 'url2',
            size: 0,
            folder: { childCount: 0 },
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
          } as DriveItem,
        ],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('file-1');
    });

    it('should mark deleted items with @removed flag', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'file-1',
            name: 'active-file.txt',
            webUrl: 'url1',
            size: 1024,
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
          } as DriveItem,
          {
            id: 'file-2',
            name: 'deleted-file.txt',
            webUrl: 'url2',
            '@removed': {
              reason: 'deleted',
            },
          } as any,
        ],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);
      vi.mocked(SearchDocument.updateMany).mockResolvedValue({ modifiedCount: 1 } as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      expect(documents[0].id).toBe('file-1');

      // Verify deleted item was marked in database
      expect(SearchDocument.updateMany).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-123',
          sourceId: 'source-123',
          'metadata.sharepoint.itemId': { $in: ['file-2'] },
        },
        {
          $set: {
            isDeleted: true,
            deletedAt: expect.any(Date),
          },
        },
      );
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

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'item-1',
            name: 'file.txt',
            webUrl: 'url',
            size: 1024,
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
          } as DriveItem,
        ],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi
        .fn()
        .mockResolvedValueOnce(mockDrives1)
        .mockResolvedValueOnce(mockDrives2);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      const documents = await coordinator.fetchDocuments(null);

      expect(mockGraphClient.getSites).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDrives).toHaveBeenCalledTimes(2);
      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledTimes(3);
      expect(documents).toHaveLength(3);
    });

    it('should handle empty delta response', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Documents', webUrl: 'url1' } as Drive];

      const mockDeltaResponse: DriveItemCollection = {
        value: [],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=new123',
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

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

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
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

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
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

    it('should be case insensitive', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { siteMode: 'selected', sitePatterns: ['**/ENGINEERING'] },
        }),
      );

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
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

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
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

      const mockDeltaResponse: DriveItemCollection = {
        value: [],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      await filteredCoordinator.fetchDocuments(null);

      // Exact match: only "Documents" matches (not "Shared Documents" or "Archive")
      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledWith('drive-1', expect.any(String));
    });

    it('should exclude specified libraries in exclude mode', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { libraryMode: 'excluded', libraryNames: ['Archive'] },
        }),
      );

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
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

      const mockDeltaResponse: DriveItemCollection = {
        value: [],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      await filteredCoordinator.fetchDocuments(null);

      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledTimes(1);
      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledWith('drive-1', expect.any(String));
    });

    it('should be case insensitive', async () => {
      const spFilterEngine = new SharePointFilterEngine(
        createFilterConfig({
          scope: { libraryMode: 'selected', libraryNames: ['DOCUMENTS'] },
        }),
      );

      const filteredCoordinator = new SharePointDeltaSyncCoordinator(
        mockConfig,
        spFilterEngine,
        mockGraphClient,
        mockModels,
      );

      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'documents', webUrl: 'url1' } as Drive];

      const mockDeltaResponse: DriveItemCollection = {
        value: [],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      await filteredCoordinator.fetchDocuments(null);

      expect(mockGraphClient.getDeltaItems).toHaveBeenCalledWith('drive-1', expect.any(String));
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

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'item-789',
            name: 'report.pdf',
            webUrl: 'https://contoso.sharepoint.com/file',
            size: 2048,
            createdDateTime: '2026-01-01T12:00:00Z',
            lastModifiedDateTime: '2026-01-02T14:30:00Z',
            file: {
              mimeType: 'application/pdf',
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
          } as DriveItem,
        ],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

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
    });

    it('should handle missing optional fields', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Site', webUrl: 'url', displayName: 'Site' } as Site,
      ];

      const mockDrives: Drive[] = [{ id: 'drive-1', name: 'Docs', webUrl: 'url' } as Drive];

      const mockDeltaResponse: DriveItemCollection = {
        value: [
          {
            id: 'item-1',
            name: 'file.txt',
            webUrl: 'url',
            size: 1024,
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
          } as DriveItem,
        ],
      };

      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ deltaLink: 'token123' }),
      } as any);
      vi.mocked(DriveDeltaToken.findOneAndUpdate).mockResolvedValue({} as any);

      mockGraphClient.getSites = vi.fn().mockResolvedValue(mockSites);
      mockGraphClient.getDrives = vi.fn().mockResolvedValue(mockDrives);
      mockGraphClient.getDeltaItems = vi.fn().mockResolvedValue(mockDeltaResponse);

      const documents = await coordinator.fetchDocuments(null);

      expect(documents).toHaveLength(1);
      expect(documents[0].contentType).toBe('application/octet-stream');
      expect(documents[0].metadata.sharepoint.createdBy).toBe('Unknown');
      expect(documents[0].metadata.sharepoint.lastModifiedBy).toBe('Unknown');
    });
  });

  describe('getDeltaToken', () => {
    it('should return null (deprecated method)', async () => {
      const token = await coordinator.getDeltaToken();

      expect(token).toBeNull();
    });
  });
});
