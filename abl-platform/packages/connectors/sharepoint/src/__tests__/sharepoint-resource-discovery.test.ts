/**
 * SharePoint Resource Discovery Tests
 *
 * Tests discovery and profiling with mock GraphClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharePointResourceDiscovery } from '../discovery/sharepoint-resource-discovery.js';
import type { GraphClient } from '../client/graph-client.js';
import type { Site, Drive, DriveItem } from '../client/graph-types.js';

// ─── Mock Factories ─────────────────────────────────────────────────────

function createMockSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    name: 'TestSite',
    displayName: 'Test Site',
    webUrl: 'https://contoso.sharepoint.com/sites/test',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-06-01T00:00:00Z',
    ...overrides,
  };
}

function createMockDrive(overrides: Partial<Drive> = {}): Drive {
  return {
    id: 'drive-1',
    name: 'Documents',
    driveType: 'documentLibrary',
    webUrl: 'https://contoso.sharepoint.com/sites/test/Documents',
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-06-01T00:00:00Z',
    ...overrides,
  };
}

function createMockDriveItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id: 'item-1',
    name: 'document.pdf',
    webUrl: 'https://contoso.sharepoint.com/sites/test/doc.pdf',
    createdDateTime: '2024-01-15T00:00:00Z',
    lastModifiedDateTime: '2024-05-20T00:00:00Z',
    size: 1024 * 100, // 100KB
    file: { mimeType: 'application/pdf' },
    ...overrides,
  };
}

function createMockGraphClient(overrides: Partial<GraphClient> = {}): GraphClient {
  return {
    getSites: vi.fn().mockResolvedValue([]),
    getDrives: vi.fn().mockResolvedValue([]),
    getDriveItemsStream: vi.fn().mockImplementation(async function* () {}),
    ...overrides,
  } as unknown as GraphClient;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('SharePointResourceDiscovery', () => {
  describe('discoverResources', () => {
    it('should discover sites and their drives', async () => {
      const mockClient = createMockGraphClient({
        getSites: vi
          .fn()
          .mockResolvedValue([
            createMockSite({ id: 'site-1', displayName: 'Engineering' }),
            createMockSite({ id: 'site-2', displayName: 'Marketing' }),
          ]),
        getDrives: vi
          .fn()
          .mockResolvedValueOnce([
            createMockDrive({ id: 'drive-1', name: 'Documents' }),
            createMockDrive({ id: 'drive-2', name: 'Shared' }),
          ])
          .mockResolvedValueOnce([createMockDrive({ id: 'drive-3', name: 'Assets' })]),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const resources = await discovery.discoverResources();

      // 2 sites + 3 drives
      expect(resources).toHaveLength(5);
      expect(resources.filter((r) => r.resourceType === 'site')).toHaveLength(2);
      expect(resources.filter((r) => r.resourceType === 'drive')).toHaveLength(3);

      // Check parentId linkage
      const drives = resources.filter((r) => r.resourceType === 'drive');
      expect(drives[0].parentId).toBe('site-1');
      expect(drives[1].parentId).toBe('site-1');
      expect(drives[2].parentId).toBe('site-2');
    });

    it('should handle empty tenant (no sites)', async () => {
      const mockClient = createMockGraphClient({
        getSites: vi.fn().mockResolvedValue([]),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const resources = await discovery.discoverResources();

      expect(resources).toHaveLength(0);
    });

    it('should handle partial failure (some sites forbidden)', async () => {
      const mockClient = createMockGraphClient({
        getSites: vi
          .fn()
          .mockResolvedValue([
            createMockSite({ id: 'site-1', displayName: 'Accessible' }),
            createMockSite({ id: 'site-2', displayName: 'Forbidden' }),
          ]),
        getDrives: vi
          .fn()
          .mockResolvedValueOnce([createMockDrive()])
          .mockRejectedValueOnce(new Error('403 Forbidden')),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const resources = await discovery.discoverResources();

      // site-1 + drive + site-2 + error entry
      expect(resources.length).toBeGreaterThanOrEqual(4);
      const errorResources = resources.filter((r) => r.resourceType === 'site-error');
      expect(errorResources).toHaveLength(1);
      expect(errorResources[0].metadata.error).toContain('403 Forbidden');
    });

    it('should report progress via callback', async () => {
      const mockClient = createMockGraphClient({
        getSites: vi.fn().mockResolvedValue([createMockSite()]),
        getDrives: vi.fn().mockResolvedValue([createMockDrive()]),
      } as any);

      const progressCallback = vi.fn();
      const discovery = new SharePointResourceDiscovery(mockClient);
      await discovery.discoverResources(progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      const lastCall = progressCallback.mock.calls[progressCallback.mock.calls.length - 1][0];
      expect(lastCall.phase).toBe('discovering');
      expect(lastCall.percentComplete).toBe(100);
    });

    it('should handle large tenant (many sites)', async () => {
      const sites = Array.from({ length: 50 }, (_, i) =>
        createMockSite({ id: `site-${i}`, displayName: `Site ${i}` }),
      );
      const mockClient = createMockGraphClient({
        getSites: vi.fn().mockResolvedValue(sites),
        getDrives: vi.fn().mockResolvedValue([createMockDrive()]),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const resources = await discovery.discoverResources();

      // 50 sites + 50 drives
      expect(resources).toHaveLength(100);
    });
  });

  describe('profileContent', () => {
    it('should profile drive content from sample', async () => {
      const items: DriveItem[] = [
        createMockDriveItem({ name: 'report.pdf', size: 50000 }),
        createMockDriveItem({ name: 'slides.pptx', size: 200000 }),
        createMockDriveItem({ name: 'data.xlsx', size: 30000 }),
        createMockDriveItem({ name: 'image.jpg', size: 500000, file: { mimeType: 'image/jpeg' } }),
      ];

      const mockClient = createMockGraphClient({
        getDriveItemsStream: vi.fn().mockImplementation(async function* () {
          yield items;
        }),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const profile = await discovery.profileContent('drive-1');

      expect(profile.resourceId).toBe('drive-1');
      expect(profile.totalDocuments).toBe(4);
      expect(profile.totalSizeBytes).toBe(780000);
      expect(profile.averageDocumentSizeBytes).toBe(195000);
      expect(profile.fileTypeDistribution).toHaveProperty('pdf', 1);
      expect(profile.fileTypeDistribution).toHaveProperty('pptx', 1);
      expect(profile.fileTypeDistribution).toHaveProperty('xlsx', 1);
      expect(profile.fileTypeDistribution).toHaveProperty('jpg', 1);
      expect(profile.sampleDocumentCount).toBe(4);
    });

    it('should skip folders in profiling', async () => {
      const items: DriveItem[] = [
        createMockDriveItem({ name: 'document.pdf', file: { mimeType: 'application/pdf' } }),
        {
          ...createMockDriveItem({ name: 'FolderName' }),
          file: undefined,
          folder: { childCount: 5 },
        } as DriveItem,
      ];

      const mockClient = createMockGraphClient({
        getDriveItemsStream: vi.fn().mockImplementation(async function* () {
          yield items;
        }),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const profile = await discovery.profileContent('drive-1');

      expect(profile.totalDocuments).toBe(1); // Only the file
    });

    it('should detect sensitivity in file names', async () => {
      const items: DriveItem[] = [
        createMockDriveItem({ name: 'employee-ssn-list.xlsx' }),
        createMockDriveItem({ name: 'payroll-2024.xlsx' }),
      ];

      const mockClient = createMockGraphClient({
        getDriveItemsStream: vi.fn().mockImplementation(async function* () {
          yield items;
        }),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const profile = await discovery.profileContent('drive-1');

      expect(profile.sensitivityIndicators).toContain('pii');
      expect(profile.sensitivityIndicators).toContain('financial');
    });

    it('should handle empty drive', async () => {
      const mockClient = createMockGraphClient({
        getDriveItemsStream: vi.fn().mockImplementation(async function* () {
          yield [];
        }),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const profile = await discovery.profileContent('drive-1');

      expect(profile.totalDocuments).toBe(0);
      expect(profile.totalSizeBytes).toBe(0);
      expect(profile.averageDocumentSizeBytes).toBe(0);
    });

    it('should respect sample size limit', async () => {
      const items = Array.from({ length: 200 }, (_, i) =>
        createMockDriveItem({ id: `item-${i}`, name: `file-${i}.pdf` }),
      );

      const mockClient = createMockGraphClient({
        getDriveItemsStream: vi.fn().mockImplementation(async function* () {
          yield items;
        }),
      } as any);

      const discovery = new SharePointResourceDiscovery(mockClient);
      const profile = await discovery.profileContent('drive-1', 50);

      expect(profile.totalDocuments).toBeLessThanOrEqual(50);
    });
  });
});
