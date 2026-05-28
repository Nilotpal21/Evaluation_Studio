/**
 * Connector Utility Route Tests
 *
 * Tests utility service functions used by route handlers:
 * - GET site-statuses
 * - GET filter-analysis
 * - POST check-site-access — accessible/inaccessible URLs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Types } from 'mongoose';

// =============================================================================
// MOCKS
// =============================================================================

const mockConnector = {
  _id: '507f1f77bcf86cd799439011' as unknown as Types.ObjectId,
  tenantId: 'test-tenant',
  connectorType: 'sharepoint',
  oauthTokenId: 'oauth-token-1',
  syncState: {
    totalDocuments: 100,
    processedDocuments: 100,
    failedDocuments: 0,
    perSiteProgress: [
      { siteName: 'Engineering', percentage: 100, docsProcessed: 60, docsTotal: 60 },
      { siteName: 'Marketing', percentage: 50, docsProcessed: 20, docsTotal: 40 },
    ],
  },
  filterConfig: {
    standard: {
      fileExtensions: { mode: 'allowlist', extensions: ['.pdf', '.docx'] },
      maxFileSizeBytes: 10485760,
      modifiedAfter: '2025-01-01',
    },
    advancedFilters: { enabled: false, conditions: [] },
  },
};

const mockDiscovery = {
  connectorId: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  status: 'completed',
  resources: [
    { id: 'site-1', resourceType: 'site', displayName: 'Engineering', name: 'engineering' },
    { id: 'site-2', resourceType: 'site', displayName: 'Marketing', name: 'marketing' },
  ],
  profiles: [
    {
      resourceId: 'site-1',
      totalDocuments: 60,
      totalSizeBytes: 5242880,
      fileTypeDistribution: { '.pdf': 40, '.docx': 15, '.xlsx': 5 },
    },
    {
      resourceId: 'site-2',
      totalDocuments: 40,
      totalSizeBytes: 2621440,
      fileTypeDistribution: { '.pdf': 20, '.pptx': 20 },
    },
  ],
};

const mockFindConnectorByIdAndTenantLean = vi.fn();
const mockFindConnectorByIdAndTenant = vi.fn();
const mockFindOAuthToken = vi.fn();

vi.doMock('../../repos/connector.repository.js', () => ({
  findConnectorByIdAndTenantLean: mockFindConnectorByIdAndTenantLean,
  findConnectorByIdAndTenant: mockFindConnectorByIdAndTenant,
  findOAuthToken: mockFindOAuthToken,
}));

const mockFindOne = vi.fn();

vi.doMock('../../db/index.js', () => ({
  getLazyModel: vi.fn(() => ({
    findOne: mockFindOne,
  })),
}));

vi.doMock('../../services/connector.service.js', () => ({
  ConnectorError: class ConnectorError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number = 400,
    ) {
      super(message);
      this.name = 'ConnectorError';
    }
  },
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Utility Routes', () => {
  let utilityService: typeof import('../../services/connector-utility.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    utilityService = await import('../../services/connector-utility.service.js');
    mockFindConnectorByIdAndTenantLean.mockResolvedValue(mockConnector);
    mockFindConnectorByIdAndTenant.mockResolvedValue(mockConnector);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // getSiteStatuses
  // ===========================================================================

  describe('getSiteStatuses', () => {
    it('should return per-site statuses from syncState.perSiteProgress', async () => {
      const data = await utilityService.getSiteStatuses('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data).toHaveLength(2);
      expect(data[0].siteName).toBe('Engineering');
      expect(data[0].status).toBe('ok');
      expect(data[0].docsSynced).toBe(60);
      expect(data[1].siteName).toBe('Marketing');
      expect(data[1].status).toBe('failed'); // 20 != 40
    });

    it('should fall back to discovery data when no perSiteProgress', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue({
        ...mockConnector,
        syncState: { ...mockConnector.syncState, perSiteProgress: undefined },
      });

      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await utilityService.getSiteStatuses('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data).toHaveLength(2);
      expect(data[0].siteName).toBe('Engineering');
      expect(data[0].status).toBe('ok');
    });

    it('should return empty array when no discovery data', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue({
        ...mockConnector,
        syncState: { ...mockConnector.syncState, perSiteProgress: undefined },
      });
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      });

      const data = await utilityService.getSiteStatuses('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data).toEqual([]);
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(utilityService.getSiteStatuses('nonexistent', 'test-tenant')).rejects.toThrow(
        'Connector not found',
      );
    });

    it('should enforce tenant isolation', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        utilityService.getSiteStatuses('507f1f77bcf86cd799439011', 'wrong-tenant'),
      ).rejects.toThrow('Connector not found');

      expect(mockFindConnectorByIdAndTenantLean).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'wrong-tenant',
      );
    });
  });

  // ===========================================================================
  // getFilterAnalysis
  // ===========================================================================

  describe('getFilterAnalysis', () => {
    it('should return filter exclusions and total discovered files', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await utilityService.getFilterAnalysis(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.totalDiscoveredFiles).toBe(100);
      expect(data.exclusions).toBeDefined();
      expect(data.exclusions.length).toBeGreaterThan(0);
    });

    it('should include file extension exclusion for allowlist', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await utilityService.getFilterAnalysis(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      const extExclusion = data.exclusions.find((e) => e.filterType.includes('extension'));
      expect(extExclusion).toBeDefined();
    });

    it('should include max file size exclusion', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await utilityService.getFilterAnalysis(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      const sizeExclusion = data.exclusions.find((e) => e.filterType.includes('size'));
      expect(sizeExclusion).toBeDefined();
    });

    it('should include date filter exclusion', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await utilityService.getFilterAnalysis(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      const dateExclusion = data.exclusions.find((e) => e.filterType.includes('Modified'));
      expect(dateExclusion).toBeDefined();
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(utilityService.getFilterAnalysis('nonexistent', 'test-tenant')).rejects.toThrow(
        'Connector not found',
      );
    });
  });

  // ===========================================================================
  // checkSiteAccess
  // ===========================================================================

  describe('checkSiteAccess', () => {
    it('should return accessible for a valid site URL', async () => {
      mockFindOAuthToken.mockResolvedValue({ accessToken: 'test-token' });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ displayName: 'Engineering' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const data = await utilityService.checkSiteAccess(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'https://contoso.sharepoint.com/sites/engineering',
      );

      expect(data.accessible).toBe(true);
      expect(data.siteName).toBe('Engineering');

      vi.unstubAllGlobals();
    });

    it('should return inaccessible for a 403 response', async () => {
      mockFindOAuthToken.mockResolvedValue({ accessToken: 'test-token' });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });
      vi.stubGlobal('fetch', mockFetch);

      const data = await utilityService.checkSiteAccess(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'https://contoso.sharepoint.com/sites/restricted',
      );

      expect(data.accessible).toBe(false);
      expect(data.error).toContain('403');

      vi.unstubAllGlobals();
    });

    it('should return inaccessible when connector has no OAuth token', async () => {
      mockFindConnectorByIdAndTenant.mockResolvedValue({
        ...mockConnector,
        oauthTokenId: null,
      });

      const data = await utilityService.checkSiteAccess(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'https://contoso.sharepoint.com/sites/engineering',
      );

      expect(data.accessible).toBe(false);
      expect(data.error).toContain('not authenticated');
    });

    it('should return inaccessible when OAuth token not found', async () => {
      mockFindOAuthToken.mockResolvedValue(null);

      const data = await utilityService.checkSiteAccess(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'https://contoso.sharepoint.com/sites/engineering',
      );

      expect(data.accessible).toBe(false);
      expect(data.error).toContain('token not found');
    });

    it('should handle network errors gracefully', async () => {
      mockFindOAuthToken.mockResolvedValue({ accessToken: 'test-token' });

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const data = await utilityService.checkSiteAccess(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'https://contoso.sharepoint.com/sites/engineering',
      );

      expect(data.accessible).toBe(false);
      expect(data.error).toContain('ECONNREFUSED');

      vi.unstubAllGlobals();
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenant.mockResolvedValue(null);

      await expect(
        utilityService.checkSiteAccess(
          'nonexistent',
          'test-tenant',
          'https://contoso.sharepoint.com',
        ),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // Zod Validation
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate utility params', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      expect(schema.safeParse({ indexId: 'idx', connectorId: 'conn' }).success).toBe(true);
      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });

    it('should validate checkSiteAccess body requires a URL', () => {
      const { z } = require('zod');
      const schema = z.object({ siteUrl: z.string().url() });

      expect(schema.safeParse({ siteUrl: 'https://example.com' }).success).toBe(true);
      expect(schema.safeParse({ siteUrl: 'not-a-url' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });
});
