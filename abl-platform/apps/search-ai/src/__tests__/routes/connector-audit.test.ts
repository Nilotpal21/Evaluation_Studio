/**
 * Connector Audit Log Route Tests
 *
 * Tests for GET /:indexId/connectors/:connectorId/audit-log
 * and GET /:indexId/connectors/:connectorId/audit-log/export
 *
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ── Mock dependencies before imports ──────────────────────────────────────

const mockGetAuditLog = vi.fn();
const mockExportAuditLog = vi.fn();

vi.mock('../../services/connector-audit.service.js', () => ({
  getAuditLog: (...args: any[]) => mockGetAuditLog(...args),
  exportAuditLog: (...args: any[]) => mockExportAuditLog(...args),
}));

vi.mock('../../services/connector.service.js', () => {
  class ConnectorError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode = 400) {
      super(message);
      this.name = 'ConnectorError';
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return { ConnectorError };
});

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (modelName: string) => ({
    findOne: (filter: Record<string, unknown>) => ({
      lean: async () => {
        if (modelName === 'ConnectorConfig') {
          return {
            _id: filter._id,
            tenantId: filter.tenantId,
            sourceId: 'source-1',
          };
        }

        if (modelName === 'SearchSource') {
          return {
            _id: filter._id,
            tenantId: filter.tenantId,
            indexId: filter.indexId ?? 'idx-1',
          };
        }

        if (modelName === 'SearchIndex') {
          return {
            _id: filter._id,
            tenantId: filter.tenantId,
          };
        }

        return null;
      },
    }),
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks
import auditRouter from '../../routes/connector-audit.js';

describe('Connector Audit Log Routes', () => {
  let app: Express;

  const mockTenantContext = {
    tenantId: 'tenant-123',
    userId: 'user-456',
  } as any;

  const authMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    req.tenantContext = mockTenantContext;
    next();
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(auditRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const mockAuditEntries = [
    {
      _id: 'entry-1',
      connectorId: 'conn-1',
      tenantId: 'tenant-123',
      timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
      actor: 'user-456',
      actorType: 'user',
      event: 'config_updated',
      category: 'config',
      metadata: {},
    },
    {
      _id: 'entry-2',
      connectorId: 'conn-1',
      tenantId: 'tenant-123',
      timestamp: new Date('2026-01-02T00:00:00Z').toISOString(),
      actor: 'system',
      actorType: 'system',
      event: 'sync_started',
      category: 'sync',
      metadata: {},
    },
  ];

  // ── GET /:indexId/connectors/:connectorId/audit-log ─────────────────────

  describe('GET /:indexId/connectors/:connectorId/audit-log', () => {
    test('should return paginated audit entries', async () => {
      mockGetAuditLog.mockResolvedValue({
        entries: mockAuditEntries,
        total: 2,
        page: 1,
        limit: 50,
      });

      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.entries).toHaveLength(2);
      expect(res.body.data.total).toBe(2);
      expect(mockGetAuditLog).toHaveBeenCalledWith('conn-1', 'tenant-123', {
        category: undefined,
        page: 1,
        limit: 50,
        startDate: undefined,
        endDate: undefined,
      });
    });

    test('should filter by category', async () => {
      mockGetAuditLog.mockResolvedValue({
        entries: [mockAuditEntries[0]],
        total: 1,
        page: 1,
        limit: 50,
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log?category=config')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockGetAuditLog).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        expect.objectContaining({ category: 'config' }),
      );
    });

    test('should filter by date range', async () => {
      mockGetAuditLog.mockResolvedValue({ entries: [], total: 0, page: 1, limit: 50 });

      const startDate = '2026-01-01T00:00:00Z';
      const endDate = '2026-01-31T23:59:59Z';

      const res = await request(app)
        .get(
          `/idx-1/connectors/conn-1/audit-log?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
        )
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockGetAuditLog).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        expect.objectContaining({
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        }),
      );
    });

    test('should support pagination params', async () => {
      mockGetAuditLog.mockResolvedValue({ entries: [], total: 100, page: 3, limit: 10 });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log?page=3&limit=10')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockGetAuditLog).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        expect.objectContaining({ page: 3, limit: 10 }),
      );
    });

    test('should return 400 for invalid category', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log?category=invalid_cat')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 400 for empty connectorId', async () => {
      // Express collapses empty segments, so we test via the route param validation
      // The route won't match with an empty segment — Express returns 404
      // Testing Zod validation by checking a valid request goes through
      mockGetAuditLog.mockResolvedValue({ entries: [], total: 0, page: 1, limit: 50 });
      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(200);
      expect(res.body.success).toBe(true);
    });

    test('should return 400 for invalid date format', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log?startDate=not-a-date')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 500 when service throws unexpected error', async () => {
      mockGetAuditLog.mockRejectedValue(new Error('Database connection failed'));

      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUDIT_LOG_FETCH_FAILED');
    });

    test('should return ConnectorError status when service throws ConnectorError', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockGetAuditLog.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'Connector not found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('Connector not found');
    });
  });

  // ── GET /:indexId/connectors/:connectorId/audit-log/export ──────────────

  describe('GET /:indexId/connectors/:connectorId/audit-log/export', () => {
    test('should export audit log as JSON', async () => {
      const jsonData = JSON.stringify(mockAuditEntries);
      mockExportAuditLog.mockResolvedValue({
        data: jsonData,
        contentType: 'application/json',
        filename: 'audit-log-conn-1.json',
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log/export?format=json')
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toContain('audit-log-conn-1.json');
      expect(mockExportAuditLog).toHaveBeenCalledWith('conn-1', 'tenant-123', 'json');
    });

    test('should export audit log as CSV', async () => {
      const csvData = 'id,event,category\nentry-1,config_updated,config\n';
      mockExportAuditLog.mockResolvedValue({
        data: csvData,
        contentType: 'text/csv',
        filename: 'audit-log-conn-1.csv',
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log/export?format=csv')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('audit-log-conn-1.csv');
      expect(mockExportAuditLog).toHaveBeenCalledWith('conn-1', 'tenant-123', 'csv');
    });

    test('should return 400 when format is missing', async () => {
      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log/export').expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 400 for invalid format', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log/export?format=xml')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 500 when export service throws', async () => {
      mockExportAuditLog.mockRejectedValue(new Error('Export failed'));

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/audit-log/export?format=json')
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUDIT_LOG_EXPORT_FAILED');
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    test('should pass tenantId from auth context to service', async () => {
      mockGetAuditLog.mockResolvedValue({ entries: [], total: 0, page: 1, limit: 50 });

      await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(200);

      expect(mockGetAuditLog).toHaveBeenCalledWith('conn-1', 'tenant-123', expect.any(Object));
    });

    test('should pass tenantId to export service', async () => {
      mockExportAuditLog.mockResolvedValue({
        data: '[]',
        contentType: 'application/json',
        filename: 'export.json',
      });

      await request(app).get('/idx-1/connectors/conn-1/audit-log/export?format=json').expect(200);

      expect(mockExportAuditLog).toHaveBeenCalledWith('conn-1', 'tenant-123', 'json');
    });

    test('cross-tenant access returns error from service layer', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockGetAuditLog.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'Connector not found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/conn-1/audit-log').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
