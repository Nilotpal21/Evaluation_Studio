/**
 * GraphClient Tests
 *
 * Tests Microsoft Graph API client with rate limiting and retry logic.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GraphClient } from '../client/graph-client.js';
import type { Site, Drive, DriveItem, Permission, GroupMember } from '../client/graph-types.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('GraphClient', () => {
  let client: GraphClient;

  beforeEach(() => {
    client = new GraphClient({
      accessToken: 'test-access-token',
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create client with default base URL', () => {
      expect(client).toBeInstanceOf(GraphClient);
    });

    it('should accept custom base URL', () => {
      const customClient = new GraphClient({
        accessToken: 'test-token',
        baseUrl: 'https://custom.graph.com',
      });
      expect(customClient).toBeInstanceOf(GraphClient);
    });
  });

  describe('getSites', () => {
    it('should fetch all sites with pagination', async () => {
      const mockSites: Site[] = [
        {
          id: 'site-1',
          name: 'Site 1',
          webUrl: 'https://contoso.sharepoint.com/sites/site1',
          displayName: 'Site 1',
        } as Site,
        {
          id: 'site-2',
          name: 'Site 2',
          webUrl: 'https://contoso.sharepoint.com/sites/site2',
          displayName: 'Site 2',
        } as Site,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockSites,
        }),
      });

      const sites = await client.getSites();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sites?search=*'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-access-token',
          }),
        }),
      );
      expect(sites).toEqual(mockSites);
    });

    it('should handle pagination with nextLink', async () => {
      const mockPage1: Site[] = [
        { id: 'site-1', name: 'Site 1', webUrl: 'url1', displayName: 'Site 1' } as Site,
      ];
      const mockPage2: Site[] = [
        { id: 'site-2', name: 'Site 2', webUrl: 'url2', displayName: 'Site 2' } as Site,
      ];

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({
            value: mockPage1,
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites?$skiptoken=abc',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({
            value: mockPage2,
          }),
        });

      const sites = await client.getSites();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(sites).toHaveLength(2);
      expect(sites[0].id).toBe('site-1');
      expect(sites[1].id).toBe('site-2');
    });
  });

  describe('getSiteByUrl', () => {
    it('should fetch site by URL', async () => {
      const mockSite: Site = {
        id: 'site-123',
        name: 'Engineering',
        webUrl: 'https://contoso.sharepoint.com/sites/engineering',
        displayName: 'Engineering',
      } as Site;

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockSite,
      });

      const site = await client.getSiteByUrl('https://contoso.sharepoint.com/sites/engineering');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sites/contoso.sharepoint.com:/sites/engineering'),
        expect.any(Object),
      );
      expect(site).toEqual(mockSite);
    });
  });

  describe('searchSites', () => {
    it('should search sites by keyword', async () => {
      const mockSites: Site[] = [
        { id: 'site-1', name: 'Engineering', webUrl: 'url1', displayName: 'Engineering' } as Site,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockSites,
        }),
      });

      const sites = await client.searchSites('engineering');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sites?search=engineering'),
        expect.any(Object),
      );
      expect(sites).toEqual(mockSites);
    });
  });

  describe('getDrives', () => {
    it('should fetch all drives in a site', async () => {
      const mockDrives: Drive[] = [
        {
          id: 'drive-1',
          name: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/site1/Documents',
        } as Drive,
        {
          id: 'drive-2',
          name: 'Shared Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/site1/Shared',
        } as Drive,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockDrives,
        }),
      });

      const drives = await client.getDrives('site-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sites/site-123/drives'),
        expect.any(Object),
      );
      expect(drives).toEqual(mockDrives);
    });
  });

  describe('getDrive', () => {
    it('should fetch a specific drive', async () => {
      const mockDrive: Drive = {
        id: 'drive-123',
        name: 'Documents',
        webUrl: 'https://contoso.sharepoint.com/Documents',
      } as Drive;

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockDrive,
      });

      const drive = await client.getDrive('drive-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123'),
        expect.any(Object),
      );
      expect(drive).toEqual(mockDrive);
    });
  });

  describe('getDriveItems', () => {
    it('should fetch drive items', async () => {
      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'file1.txt',
          webUrl: 'url1',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockItems,
        }),
      });

      const response = await client.getDriveItems('drive-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123/root/children'),
        expect.any(Object),
      );
      expect(response.value).toEqual(mockItems);
    });

    it('should use provided nextLink for pagination', async () => {
      const mockItems: DriveItem[] = [
        {
          id: 'item-2',
          name: 'file2.txt',
          webUrl: 'url2',
          size: 2048,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-01T00:00:00Z',
        } as DriveItem,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockItems,
        }),
      });

      const nextLink =
        'https://graph.microsoft.com/v1.0/drives/drive-123/root/children?$skiptoken=abc';
      const response = await client.getDriveItems('drive-123', nextLink);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('$skiptoken=abc'),
        expect.any(Object),
      );
      expect(response.value).toEqual(mockItems);
    });
  });

  describe('getDriveItemsRecursive', () => {
    it('should fetch all items recursively including folders', async () => {
      const mockFile: DriveItem = {
        id: 'file-1',
        name: 'file.txt',
        webUrl: 'url1',
        size: 1024,
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T00:00:00Z',
      } as DriveItem;

      const mockFolder: DriveItem = {
        id: 'folder-1',
        name: 'folder1',
        webUrl: 'url2',
        size: 0,
        folder: { childCount: 1 },
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T00:00:00Z',
      } as DriveItem;

      const mockNestedFile: DriveItem = {
        id: 'file-2',
        name: 'nested.txt',
        webUrl: 'url3',
        size: 2048,
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T00:00:00Z',
      } as DriveItem;

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({
            value: [mockFile, mockFolder],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({
            value: [mockNestedFile],
          }),
        });

      const items = await client.getDriveItemsRecursive('drive-123');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(items).toHaveLength(3);
      expect(items[0].id).toBe('file-1');
      expect(items[1].id).toBe('folder-1');
      expect(items[2].id).toBe('file-2');
    });
  });

  describe('getDriveItemContent', () => {
    it('should download file content', async () => {
      const mockContent = new ArrayBuffer(8);

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
        arrayBuffer: async () => mockContent,
      });

      const content = await client.getDriveItemContent('drive-123', 'item-456');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123/items/item-456/content'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/octet-stream',
          }),
        }),
      );
      expect(content).toBeInstanceOf(Buffer);
    });
  });

  describe('getDeltaItems', () => {
    it('should fetch delta changes without token', async () => {
      const mockItems: DriveItem[] = [
        {
          id: 'item-1',
          name: 'changed.txt',
          webUrl: 'url1',
          size: 1024,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-01-02T00:00:00Z',
        } as DriveItem,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockItems,
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/drives/drive-123/root/delta?token=abc',
        }),
      });

      const response = await client.getDeltaItems('drive-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123/root/delta'),
        expect.any(Object),
      );
      expect(response.value).toEqual(mockItems);
      expect(response['@odata.deltaLink']).toBeDefined();
    });

    it('should use delta token when provided', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: [],
        }),
      });

      const deltaToken = 'https://graph.microsoft.com/v1.0/drives/drive-123/root/delta?token=xyz';
      await client.getDeltaItems('drive-123', deltaToken);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('token=xyz'),
        expect.any(Object),
      );
    });
  });

  describe('getItemPermissions', () => {
    it('should fetch permissions for an item', async () => {
      const mockPermissions: Permission[] = [
        {
          id: 'perm-1',
          grantedToV2: {
            user: {
              id: 'user-1',
              displayName: 'John Doe',
            },
          },
          roles: ['read'],
        } as Permission,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockPermissions,
        }),
      });

      const permissions = await client.getItemPermissions('drive-123', 'item-456');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123/items/item-456/permissions'),
        expect.any(Object),
      );
      expect(permissions).toEqual(mockPermissions);
    });
  });

  describe('getDrivePermissions', () => {
    it('should fetch permissions for a drive', async () => {
      const mockPermissions: Permission[] = [
        {
          id: 'perm-1',
          grantedToV2: {
            user: {
              id: 'user-1',
              displayName: 'Jane Smith',
            },
          },
          roles: ['write'],
        } as Permission,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockPermissions,
        }),
      });

      const permissions = await client.getDrivePermissions('drive-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/drives/drive-123/root/permissions'),
        expect.any(Object),
      );
      expect(permissions).toEqual(mockPermissions);
    });
  });

  describe('getGroupMembers', () => {
    it('should fetch group members with pagination', async () => {
      const mockMembers: GroupMember[] = [
        {
          id: 'user-1',
          displayName: 'User 1',
          mail: 'user1@contoso.com',
        } as GroupMember,
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          value: mockMembers,
        }),
      });

      const members = await client.getGroupMembers('group-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/groups/group-123/members'),
        expect.any(Object),
      );
      expect(members).toEqual(mockMembers);
    });
  });

  describe('subscribeToDriveChanges', () => {
    it('should create a webhook subscription', async () => {
      const mockSubscription = {
        id: 'sub-123',
        resource: '/drives/drive-123/root',
        changeType: 'updated',
        notificationUrl: 'https://webhook.example.com/notify',
        expirationDateTime: new Date(Date.now() + 86400000).toISOString(),
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockSubscription,
      });

      const subscription = await client.subscribeToDriveChanges(
        'drive-123',
        'https://webhook.example.com/notify',
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions'),
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        }),
      );
      expect(subscription).toEqual(mockSubscription);
    });
  });

  describe('renewSubscription', () => {
    it('should renew a webhook subscription', async () => {
      const mockSubscription = {
        id: 'sub-123',
        expirationDateTime: new Date(Date.now() + 86400000).toISOString(),
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockSubscription,
      });

      const subscription = await client.renewSubscription('sub-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions/sub-123'),
        expect.objectContaining({
          method: 'PATCH',
        }),
      );
      expect(subscription.id).toBe('sub-123');
    });
  });

  describe('deleteSubscription', () => {
    it('should delete a webhook subscription', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: new Headers(),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      });

      await client.deleteSubscription('sub-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions/sub-123'),
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
    });
  });

  describe('error handling', () => {
    it('should throw error on HTTP 404', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          error: {
            code: 'itemNotFound',
            message: 'The resource could not be found',
          },
        }),
      });

      await expect(client.getSiteByUrl('https://contoso.sharepoint.com/invalid')).rejects.toThrow();
    });

    it('should throw error on HTTP 401', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          error: {
            code: 'InvalidAuthenticationToken',
            message: 'Access token is invalid',
          },
        }),
      });

      await expect(client.getSites()).rejects.toThrow();
    });
  });
});
