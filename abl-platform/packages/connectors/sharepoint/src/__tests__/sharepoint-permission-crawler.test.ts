/**
 * SharePoint Permission Crawler Tests
 *
 * Tests for permission crawling from SharePoint to Neo4j: user/group permissions,
 * full vs simplified modes, batch processing, and error handling.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointPermissionCrawler } from '../permissions/sharepoint-permission-crawler.js';
import type {
  DocumentToCrawl,
  PermissionCrawlConfig,
} from '../permissions/sharepoint-permission-crawler.js';
import type { GraphClient } from '../client/graph-client.js';
import type { Permission } from '../client/graph-types.js';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockGraphClient() {
  return {
    getItemPermissions: vi.fn(),
    getDrivePermissions: vi.fn().mockResolvedValue([]),
    getGroupMembers: vi.fn(),
    getGroupOwners: vi.fn().mockResolvedValue([]),
    getUser: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue({ data: { value: [] } }),
  } as any;
}

function createMockPermissionService() {
  return {
    upsertDocument: vi.fn().mockResolvedValue(undefined),
    upsertUser: vi.fn().mockResolvedValue(undefined),
    upsertGroup: vi.fn().mockResolvedValue(undefined),
    setPermission: vi.fn().mockResolvedValue(undefined),
    setMembership: vi.fn().mockResolvedValue(undefined),
    removeAllDocumentPermissions: vi.fn().mockResolvedValue(0),
  };
}

function createMockConfig(overrides: Partial<PermissionCrawlConfig> = {}): PermissionCrawlConfig {
  return {
    mode: 'enabled',
    tenantId: 'tenant-1',
    sourceId: 'connector-1',
    neo4jConfig: {
      uri: 'neo4j://localhost:7687',
      username: 'neo4j',
      password: 'password',
      database: 'neo4j',
    },
    ...overrides,
  };
}

function createMockDocument(overrides: Partial<DocumentToCrawl> = {}): DocumentToCrawl {
  return {
    documentId: 'doc-1',
    driveId: 'drive-1',
    itemId: 'item-1',
    name: 'Document.docx',
    path: '/site/library/Document.docx',
    ...overrides,
  };
}

function createUserPermission(email: string, roles: string[] = ['read']): Permission {
  return {
    id: `perm-${email}`,
    roles,
    grantedToV2: {
      user: {
        id: `user-${email}`,
        email,
        displayName: email.split('@')[0],
      },
    },
  };
}

function createGroupPermission(groupId: string, roles: string[] = ['read']): Permission {
  return {
    id: `perm-${groupId}`,
    roles,
    grantedToV2: {
      group: {
        id: groupId,
        displayName: `Group ${groupId}`,
        email: `group-${groupId}@contoso.com`,
      },
    },
  };
}

// =============================================================================
// SharePoint Permission Crawler Tests
// =============================================================================

describe('SharePointPermissionCrawler', () => {
  let mockGraphClient: ReturnType<typeof createMockGraphClient>;
  let mockPermissionService: ReturnType<typeof createMockPermissionService>;
  let mockConfig: PermissionCrawlConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGraphClient = createMockGraphClient();
    mockPermissionService = createMockPermissionService();
    mockConfig = createMockConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Constructor & Initialization ──────────────────────────────────────

  describe('constructor', () => {
    test('initializes with config and graph client', () => {
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        mockConfig,
        mockPermissionService as any,
      );

      expect(crawler).toBeDefined();
    });
  });

  // ─── Disabled Mode ─────────────────────────────────────────────────────

  describe('disabled mode', () => {
    test('returns early without processing documents', async () => {
      const disabledConfig = createMockConfig({ mode: 'disabled' });
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        disabledConfig,
        mockPermissionService as any,
      );

      const documents = [createMockDocument(), createMockDocument({ documentId: 'doc-2' })];

      const result = await crawler.crawlDocuments(documents);

      expect(result).toEqual({
        success: true,
        mode: 'disabled',
        documentsProcessed: 0,
        averageAccuracy: 0,
        durationMs: 0,
        errors: [],
      });

      // Verify no API calls were made
      expect(mockGraphClient.getItemPermissions).not.toHaveBeenCalled();
      expect(mockPermissionService.upsertDocument).not.toHaveBeenCalled();
    });
  });

  // ─── Simplified Mode ───────────────────────────────────────────────────

  describe('enabled mode', () => {
    test('crawls document with user permission', async () => {
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        mockConfig,
        mockPermissionService as any,
      );
      const doc = createMockDocument();
      const permissions = [createUserPermission('john@contoso.com', ['read'])];

      mockGraphClient.getItemPermissions.mockResolvedValue(permissions);

      const result = await crawler.crawlDocuments([doc]);

      // Verify document node created
      expect(mockPermissionService.upsertDocument).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Document.docx',
        path: '/site/library/Document.docx',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Verify user node created
      expect(mockPermissionService.upsertUser).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        email: 'john@contoso.com',
        idpUserId: 'user-john@contoso.com',
        idpProvider: 'azuread',
        displayName: 'john',
      });

      // Verify permission relationship created
      expect(mockPermissionService.setPermission).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        userEmail: 'john@contoso.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      // Verify result
      expect(result.success).toBe(true);

      expect(result.documentsProcessed).toBe(1);
      expect(result.averageAccuracy).toBe(100);
    });

    test('crawls document with group permission', async () => {
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        mockConfig,
        mockPermissionService as any,
      );
      const doc = createMockDocument();
      const permissions = [createGroupPermission('group-123', ['read'])];

      mockGraphClient.getItemPermissions.mockResolvedValue(permissions);

      const result = await crawler.crawlDocuments([doc]);

      // Verify group node created
      expect(mockPermissionService.upsertGroup).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        groupId: 'sharepoint:group-123',
        idpGroupId: 'group-123',
        source: 'sharepoint',
        displayName: 'Group group-123',
        email: 'group-group-123@contoso.com',
      });

      // Verify group permission relationship created (not expanded to members)
      expect(mockPermissionService.setPermission).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        groupId: 'sharepoint:group-123',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      expect(result.averageAccuracy).toBe(100);
    });
  });

  // ─── Full Mode ─────────────────────────────────────────────────────────

  describe('enabled mode — group resolution', () => {
    test('resolves group members recursively', async () => {
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        mockConfig,
        mockPermissionService as any,
      );
      const doc = createMockDocument();
      const permissions = [createGroupPermission('group-123', ['read'])];

      mockGraphClient.getItemPermissions.mockResolvedValue(permissions);
      // Mock Azure AD group resolution: resolveAzureADGroupId calls graphClient.get('/groups', ...)
      mockGraphClient.get.mockResolvedValue({
        data: {
          value: [
            {
              id: 'group-123',
              displayName: 'Group group-123',
              mail: 'group-group-123@contoso.com',
            },
          ],
        },
      });
      mockGraphClient.getGroupMembers.mockResolvedValue([
        {
          id: 'member-1',
          mail: 'member1@contoso.com',
          userPrincipalName: 'member1@contoso.com',
          displayName: 'Member One',
        },
      ]);

      const result = await crawler.crawlDocuments([doc]);

      // Verify group members were resolved
      expect(mockGraphClient.getGroupMembers).toHaveBeenCalledWith('group-123');

      // Verify member users created
      expect(mockPermissionService.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'member1@contoso.com',
        }),
      );

      expect(result.success).toBe(true);
      expect(result.averageAccuracy).toBe(100);
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    test('handles GraphClient API failure', async () => {
      const crawler = new SharePointPermissionCrawler(
        mockGraphClient,
        mockConfig,
        mockPermissionService as any,
      );
      const doc = createMockDocument();

      mockGraphClient.getItemPermissions.mockRejectedValue(new Error('API timeout'));

      const result = await crawler.crawlDocuments([doc]);

      expect(result.success).toBe(false);
      expect(result.documentsProcessed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe('API timeout');
    });
  });
});
