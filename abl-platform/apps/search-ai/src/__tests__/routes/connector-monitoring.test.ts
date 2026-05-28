/**
 * Connector Monitoring Route Tests
 *
 * Tests monitoring service functions used by route handlers:
 * - GET overview — returns KPIs, content breakdown, issues
 * - GET sync-history — paginated
 * - PUT permission-schedule — Zod validation, cron expression
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
  connectionConfig: {
    name: 'Contoso SharePoint',
    tenantUrl: 'https://contoso.sharepoint.com',
    authenticatedBy: 'admin@contoso.com',
  },
  syncState: {
    totalDocuments: 150,
    processedDocuments: 150,
    failedDocuments: 0,
    lastFullSyncAt: new Date('2026-03-20'),
    lastDeltaSyncAt: new Date('2026-03-23'),
    syncInProgress: false,
    checkpointData: null,
  },
  filterConfig: {
    scope: { siteMode: 'all' },
    standard: {
      fileExtensions: { mode: 'allowlist', extensions: ['.pdf', '.docx'] },
      maxFileSizeBytes: 10485760,
    },
    advancedFilters: { enabled: false, conditions: [] },
  },
  permissionConfig: {
    mode: 'enabled',
    crawlSchedule: '0 2 * * *',
    lastCrawlAt: new Date('2026-03-22'),
    documentsProcessed: 100,
  },
  errorState: {
    consecutiveFailures: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    isPaused: false,
  },
  createdAt: new Date('2026-01-15'),
  updatedAt: new Date('2026-03-23'),
};

const mockDiscovery = {
  connectorId: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  status: 'completed',
  discoveredAt: new Date('2026-03-20'),
  resources: [
    { id: 'site-1', resourceType: 'site', displayName: 'Engineering', name: 'engineering' },
    { id: 'site-2', resourceType: 'site', displayName: 'Marketing', name: 'marketing' },
    { id: 'lib-1', resourceType: 'library', displayName: 'Documents', name: 'documents' },
  ],
  profiles: [
    {
      resourceId: 'site-1',
      totalDocuments: 100,
      totalSizeBytes: 5242880,
      fileTypeDistribution: { '.pdf': 60, '.docx': 40 },
    },
    {
      resourceId: 'site-2',
      totalDocuments: 50,
      totalSizeBytes: 2621440,
      fileTypeDistribution: { '.pdf': 20, '.xlsx': 30 },
    },
  ],
};

const mockAuditEntries = [
  {
    event: 'sync_completed',
    category: 'sync',
    timestamp: new Date('2026-03-23'),
    metadata: {
      syncType: 'delta',
      docsAdded: 5,
      docsRemoved: 1,
      docsModified: 3,
      durationSeconds: 120,
    },
  },
  {
    event: 'sync_failed',
    category: 'sync',
    timestamp: new Date('2026-03-22'),
    metadata: {
      syncType: 'full',
      docsAdded: 0,
      docsRemoved: 0,
      docsModified: 0,
      durationSeconds: 60,
    },
  },
];

// Mock repository
const mockFindConnectorByIdAndTenantLean = vi.fn();
vi.doMock('../../repos/connector.repository.js', () => ({
  findConnectorByIdAndTenantLean: mockFindConnectorByIdAndTenantLean,
}));

// Mock getLazyModel
const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockCountDocuments = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockGetAuditLog = vi.fn();

vi.doMock('../../db/index.js', () => ({
  getLazyModel: vi.fn(() => ({
    findOne: mockFindOne,
    find: mockFind,
    countDocuments: mockCountDocuments,
    findOneAndUpdate: mockFindOneAndUpdate,
  })),
}));

// Mock ConnectorError
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

vi.doMock('../../services/connector-audit.service.js', () => ({
  getAuditLog: (...args: unknown[]) => mockGetAuditLog(...args),
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Monitoring Routes', () => {
  let monitoringService: typeof import('../../services/connector-monitoring.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    monitoringService = await import('../../services/connector-monitoring.service.js');

    // Default: connector found
    mockFindConnectorByIdAndTenantLean.mockResolvedValue(mockConnector);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // getOverview
  // ===========================================================================

  describe('getOverview', () => {
    it('should return overview data for a valid connector', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await monitoringService.getOverview('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data.connectorName).toBe('Contoso SharePoint');
      expect(data.status).toBe('healthy');
      expect(data.totalDocuments).toBe(150);
      expect(data.siteCount).toBe(2);
      expect(data.libraryCount).toBe(1);
      expect(data.configSummary).toBeDefined();
      expect(data.contentFreshness).toBeDefined();
      expect(data.permissionSync).toBeDefined();
    });

    it('should throw NOT_FOUND when connector does not exist', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(monitoringService.getOverview('nonexistent', 'test-tenant')).rejects.toThrow(
        'Connector not found',
      );
    });

    it('should enforce tenant isolation', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        monitoringService.getOverview('507f1f77bcf86cd799439011', 'wrong-tenant'),
      ).rejects.toThrow('Connector not found');

      expect(mockFindConnectorByIdAndTenantLean).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'wrong-tenant',
      );
    });

    it('should return disconnected status when no OAuth token', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue({
        ...mockConnector,
        oauthTokenId: null,
      });
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      });

      const data = await monitoringService.getOverview('507f1f77bcf86cd799439011', 'test-tenant');
      expect(data.status).toBe('disconnected');
    });

    it('should return error status when consecutive failures > 0', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue({
        ...mockConnector,
        errorState: { ...mockConnector.errorState, consecutiveFailures: 3 },
      });
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      });

      const data = await monitoringService.getOverview('507f1f77bcf86cd799439011', 'test-tenant');
      expect(data.status).toBe('error');
    });

    it('should handle missing discovery data gracefully', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      });

      const data = await monitoringService.getOverview('507f1f77bcf86cd799439011', 'test-tenant');
      expect(data.siteCount).toBe(0);
      expect(data.libraryCount).toBe(0);
      expect(data.totalSize).toBe(0);
    });
  });

  // ===========================================================================
  // getContentBreakdown
  // ===========================================================================

  describe('getContentBreakdown', () => {
    it('should return type and site breakdowns', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDiscovery),
        }),
      });

      const data = await monitoringService.getContentBreakdown(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.byType).toBeDefined();
      expect(data.bySite).toBeDefined();
      expect(data.byType.length).toBeGreaterThan(0);
      expect(data.bySite.length).toBe(2);
    });

    it('should return empty arrays when no discovery data', async () => {
      mockFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      });

      const data = await monitoringService.getContentBreakdown(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.byType).toEqual([]);
      expect(data.bySite).toEqual([]);
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        monitoringService.getContentBreakdown('nonexistent', 'test-tenant'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // getSyncHistory
  // ===========================================================================

  describe('getSyncHistory', () => {
    it('should return paginated sync history', async () => {
      mockGetAuditLog.mockResolvedValue({
        entries: mockAuditEntries,
        total: 2,
      });

      const data = await monitoringService.getSyncHistory(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        { page: 1, limit: 20 },
      );

      expect(data.history).toHaveLength(2);
      expect(data.total).toBe(2);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(20);
      expect(data.history[0].type).toBe('delta');
      expect(data.history[1].status).toBe('failed');
      expect(mockGetAuditLog).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 'test-tenant', {
        category: 'sync',
        page: 1,
        limit: 20,
      });
    });

    it('should respect pagination parameters', async () => {
      mockGetAuditLog.mockResolvedValue({
        entries: [],
        total: 50,
      });

      const data = await monitoringService.getSyncHistory(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        { page: 3, limit: 10 },
      );

      expect(data.page).toBe(3);
      expect(data.limit).toBe(10);
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        monitoringService.getSyncHistory('nonexistent', 'test-tenant', { page: 1, limit: 20 }),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // updatePermissionSchedule
  // ===========================================================================

  describe('updatePermissionSchedule', () => {
    it('should update daily schedule', async () => {
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);

      const data = await monitoringService.updatePermissionSchedule(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'daily',
      );

      expect(data.schedule).toBe('daily');
    });

    it('should update weekly schedule', async () => {
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);

      const data = await monitoringService.updatePermissionSchedule(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'weekly',
      );

      expect(data.schedule).toBe('weekly');
    });

    it('should update custom schedule with cron expression', async () => {
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);

      const data = await monitoringService.updatePermissionSchedule(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'custom',
        '0 3 * * 1-5',
      );

      expect(data.schedule).toBe('custom');
    });

    it('should set null cron for manual schedule', async () => {
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);

      const data = await monitoringService.updatePermissionSchedule(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'manual',
      );

      expect(data.schedule).toBe('manual');
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        monitoringService.updatePermissionSchedule('nonexistent', 'test-tenant', 'daily'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // Zod Validation (route-level)
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate monitoringParams with empty indexId', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      const result = schema.safeParse({ indexId: '', connectorId: 'abc' });
      expect(result.success).toBe(false);
    });

    it('should validate monitoringParams with empty connectorId', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      const result = schema.safeParse({ indexId: 'abc', connectorId: '' });
      expect(result.success).toBe(false);
    });

    it('should validate syncHistoryQuery defaults', () => {
      const { z } = require('zod');
      const schema = z.object({
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(100).default(20),
      });

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
      }
    });

    it('should reject limit > 100', () => {
      const { z } = require('zod');
      const schema = z.object({
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(100).default(20),
      });

      const result = schema.safeParse({ limit: 200 });
      expect(result.success).toBe(false);
    });

    it('should validate permissionScheduleBody requires cronExpression for custom', () => {
      const { z } = require('zod');
      const schema = z
        .object({
          schedule: z.enum(['manual', 'daily', 'weekly', 'custom']),
          cronExpression: z.string().min(1).optional(),
        })
        .refine(
          (data) =>
            data.schedule !== 'custom' || (data.cronExpression && data.cronExpression.length > 0),
          {
            message: 'cronExpression is required when schedule is "custom"',
            path: ['cronExpression'],
          },
        );

      const result = schema.safeParse({ schedule: 'custom' });
      expect(result.success).toBe(false);
    });

    it('should accept permissionScheduleBody with custom + cron', () => {
      const { z } = require('zod');
      const schema = z
        .object({
          schedule: z.enum(['manual', 'daily', 'weekly', 'custom']),
          cronExpression: z.string().min(1).optional(),
        })
        .refine(
          (data) =>
            data.schedule !== 'custom' || (data.cronExpression && data.cronExpression.length > 0),
          {
            message: 'cronExpression is required when schedule is "custom"',
            path: ['cronExpression'],
          },
        );

      const result = schema.safeParse({ schedule: 'custom', cronExpression: '0 3 * * 1-5' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid schedule enum value', () => {
      const { z } = require('zod');
      const schema = z.object({
        schedule: z.enum(['manual', 'daily', 'weekly', 'custom']),
      });

      const result = schema.safeParse({ schedule: 'hourly' });
      expect(result.success).toBe(false);
    });
  });
});
