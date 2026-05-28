/**
 * Connector Config Version Route Tests
 *
 * Tests for version history, snapshot retrieval, creation, diff, and restore.
 *
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ── Mock dependencies before imports ──────────────────────────────────────

const mockGetVersionHistory = vi.fn();
const mockGetVersionSnapshot = vi.fn();
const mockCreateVersion = vi.fn();
const mockDiffVersions = vi.fn();
const mockRestoreVersion = vi.fn();

vi.mock('../../services/connector-config-version.service.js', () => ({
  getVersionHistory: (...args: any[]) => mockGetVersionHistory(...args),
  getVersionSnapshot: (...args: any[]) => mockGetVersionSnapshot(...args),
  createVersion: (...args: any[]) => mockCreateVersion(...args),
  diffVersions: (...args: any[]) => mockDiffVersions(...args),
  restoreVersion: (...args: any[]) => mockRestoreVersion(...args),
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

vi.mock('../../routes/searchai-route-ownership.js', () => ({
  requireConnectorIndexAccessFromParams: () => (_req: any, _res: any, next: any) => next(),
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
import versionRouter from '../../routes/connector-config-versions.js';

describe('Connector Config Version Routes', () => {
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
    app.use(versionRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const mockVersion = (version: number, overrides: Record<string, unknown> = {}) => ({
    _id: `ver-${version}`,
    connectorId: 'conn-1',
    tenantId: 'tenant-123',
    version,
    configSnapshot: { connectionConfig: { tenantUrl: 'https://example.com' } },
    changedFields: ['connectionConfig.tenantUrl'],
    changedBy: 'user-456',
    changeSource: 'user',
    summary: `Version ${version} changes`,
    createdAt: new Date(`2026-01-0${version}T00:00:00Z`).toISOString(),
    ...overrides,
  });

  // ── GET /:indexId/connectors/:connectorId/config/versions ───────────────

  describe('GET /:indexId/connectors/:connectorId/config/versions', () => {
    test('should return paginated version history', async () => {
      mockGetVersionHistory.mockResolvedValue({
        versions: [mockVersion(3), mockVersion(2), mockVersion(1)],
        total: 3,
      });

      const res = await request(app).get('/idx-1/connectors/conn-1/config/versions').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.versions).toHaveLength(3);
      expect(res.body.data.versions[0].version).toBe(3);
      expect(mockGetVersionHistory).toHaveBeenCalledWith('conn-1', 'tenant-123', {});
    });

    test('should pass pagination params to service', async () => {
      mockGetVersionHistory.mockResolvedValue({ versions: [], total: 0 });

      await request(app).get('/idx-1/connectors/conn-1/config/versions?page=2&limit=5').expect(200);

      expect(mockGetVersionHistory).toHaveBeenCalledWith('conn-1', 'tenant-123', {
        page: 2,
        limit: 5,
      });
    });

    test('should return 400 for invalid page param', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions?page=-1')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 400 for limit exceeding 100', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions?limit=200')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });

    test('should return 500 when service throws', async () => {
      mockGetVersionHistory.mockRejectedValue(new Error('DB timeout'));

      const res = await request(app).get('/idx-1/connectors/conn-1/config/versions').expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_HISTORY_FAILED');
    });
  });

  // ── GET /:indexId/connectors/:connectorId/config/versions/:versionNumber ─

  describe('GET /:indexId/connectors/:connectorId/config/versions/:versionNumber', () => {
    test('should return a specific version snapshot', async () => {
      mockGetVersionSnapshot.mockResolvedValue(mockVersion(2));

      const res = await request(app).get('/idx-1/connectors/conn-1/config/versions/2').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.version.version).toBe(2);
      expect(mockGetVersionSnapshot).toHaveBeenCalledWith('conn-1', 'tenant-123', 2);
    });

    test('should return 404 when version not found', async () => {
      mockGetVersionSnapshot.mockResolvedValue(null);

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions/999')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
    });

    test('should return 400 for non-numeric version', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions/abc')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PARAMS');
    });

    test('should return 400 for negative version number', async () => {
      const res = await request(app).get('/idx-1/connectors/conn-1/config/versions/-1').expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PARAMS');
    });
  });

  // ── GET /:indexId/connectors/:connectorId/config/versions/diff ──────────

  describe('GET /:indexId/connectors/:connectorId/config/versions/diff', () => {
    test('should return diff when from/to params are valid', async () => {
      mockDiffVersions.mockResolvedValue({
        from: 1,
        to: 2,
        changes: [{ field: 'connectionConfig.tenantUrl', before: 'old', after: 'new' }],
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions/diff?from=1&to=2')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockDiffVersions).toHaveBeenCalledWith('conn-1', 'tenant-123', 1, 2);
    });

    test('should return 400 when from/to params are missing', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/config/versions/diff')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_QUERY');
    });
  });

  // ── POST /:indexId/connectors/:connectorId/config/versions/restore ──────

  describe('POST /:indexId/connectors/:connectorId/config/versions/restore', () => {
    test('should restore a previous version', async () => {
      mockRestoreVersion.mockResolvedValue(mockVersion(4, { changeSource: 'restore' }));

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions/restore')
        .send({ version: 2 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.version.changeSource).toBe('restore');
      expect(mockRestoreVersion).toHaveBeenCalledWith('conn-1', 'tenant-123', 2, 'user-456');
    });

    test('should return 400 when version is missing', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions/restore')
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    test('should return 400 for non-positive version', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions/restore')
        .send({ version: -1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });
  });

  // ── POST /:indexId/connectors/:connectorId/config/versions ──────────────

  describe('POST /:indexId/connectors/:connectorId/config/versions', () => {
    const validBody = {
      configSnapshot: { connectionConfig: { tenantUrl: 'https://example.com' } },
      changedFields: ['connectionConfig.tenantUrl'],
      changedBy: 'user-456',
      changeSource: 'user' as const,
      summary: 'Updated tenant URL',
    };

    test('should create a new version and return 201', async () => {
      mockCreateVersion.mockResolvedValue(mockVersion(1));

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send(validBody)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.version).toBeDefined();
      expect(mockCreateVersion).toHaveBeenCalledWith({
        connectorId: 'conn-1',
        tenantId: 'tenant-123',
        ...validBody,
      });
    });

    test('should return 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send({ configSnapshot: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    test('should return 400 for invalid changeSource', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send({ ...validBody, changeSource: 'invalid' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    test('should return 400 for empty changedBy', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send({ ...validBody, changedBy: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    test('should return ConnectorError status on optimistic concurrency failure', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockCreateVersion.mockRejectedValue(
        new ConnectorError('VERSION_CONFLICT', 'Concurrent version creation', 409),
      );

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send(validBody)
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    test('should pass tenantId from auth context to version history', async () => {
      mockGetVersionHistory.mockResolvedValue({ versions: [], total: 0 });

      await request(app).get('/idx-1/connectors/conn-1/config/versions').expect(200);

      expect(mockGetVersionHistory).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        expect.any(Object),
      );
    });

    test('should pass tenantId from auth context to version creation', async () => {
      mockCreateVersion.mockResolvedValue(mockVersion(1));

      await request(app)
        .post('/idx-1/connectors/conn-1/config/versions')
        .send({
          configSnapshot: { key: 'value' },
          changedFields: ['key'],
          changedBy: 'user-456',
          changeSource: 'user',
          summary: 'Test',
        })
        .expect(201);

      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-123' }),
      );
    });

    test('cross-tenant access returns error from service layer', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockGetVersionSnapshot.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'Connector not found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/conn-1/config/versions/1').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
