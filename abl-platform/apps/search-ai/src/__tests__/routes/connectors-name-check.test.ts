/**
 * Connector Name Check & Admin Email Route Tests
 *
 * Tests for GET /:indexId/connectors/check-name and
 * POST /:indexId/connectors/generate-admin-email added to connectors.ts.
 *
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ── Mock dependencies before imports ──────────────────────────────────────

const mockCheckConnectorName = vi.fn();
const mockGenerateAdminEmail = vi.fn();
const mockListConnectors = vi.fn();
const mockCreateConnector = vi.fn();
const mockGetConnector = vi.fn();
const mockUpdateConnector = vi.fn();
const mockDeleteConnector = vi.fn();
const mockInitiateAuth = vi.fn();
const mockGetAuthStatus = vi.fn();
const mockAuthCallback = vi.fn();
const mockRevokeAuth = vi.fn();
const mockValidateFilters = vi.fn();
const mockGetFilterTemplates = vi.fn();
const mockApplyFilterTemplate = vi.fn();
const mockPreviewFilters = vi.fn();
const mockStartSync = vi.fn();
const mockStopSync = vi.fn();
const mockPauseSync = vi.fn();
const mockResumeSync = vi.fn();
const mockRestartSync = vi.fn();
const mockGetSyncStatus = vi.fn();
const mockTriggerDeltaSync = vi.fn();
const mockListDeltaTokens = vi.fn();
const mockResetDeltaToken = vi.fn();
const mockStartPermissionCrawl = vi.fn();
const mockGetPermissionStatus = vi.fn();
const mockUpdatePermissionMode = vi.fn();
const mockTriggerPermissionRecrawl = vi.fn();
const mockGetJobStatus = vi.fn();
const mockExecuteBulkAction = vi.fn();

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
  return {
    ConnectorError,
    checkConnectorName: (...args: any[]) => mockCheckConnectorName(...args),
    generateAdminEmail: (...args: any[]) => mockGenerateAdminEmail(...args),
    listConnectors: (...args: any[]) => mockListConnectors(...args),
    createConnector: (...args: any[]) => mockCreateConnector(...args),
    getConnector: (...args: any[]) => mockGetConnector(...args),
    updateConnector: (...args: any[]) => mockUpdateConnector(...args),
    deleteConnector: (...args: any[]) => mockDeleteConnector(...args),
    initiateAuth: (...args: any[]) => mockInitiateAuth(...args),
    getAuthStatus: (...args: any[]) => mockGetAuthStatus(...args),
    authCallback: (...args: any[]) => mockAuthCallback(...args),
    revokeAuth: (...args: any[]) => mockRevokeAuth(...args),
    validateFilters: (...args: any[]) => mockValidateFilters(...args),
    getFilterTemplates: (...args: any[]) => mockGetFilterTemplates(...args),
    applyFilterTemplate: (...args: any[]) => mockApplyFilterTemplate(...args),
    previewFilters: (...args: any[]) => mockPreviewFilters(...args),
    startSync: (...args: any[]) => mockStartSync(...args),
    stopSync: (...args: any[]) => mockStopSync(...args),
    pauseSync: (...args: any[]) => mockPauseSync(...args),
    resumeSync: (...args: any[]) => mockResumeSync(...args),
    restartSync: (...args: any[]) => mockRestartSync(...args),
    getSyncStatus: (...args: any[]) => mockGetSyncStatus(...args),
    triggerDeltaSync: (...args: any[]) => mockTriggerDeltaSync(...args),
    listDeltaTokens: (...args: any[]) => mockListDeltaTokens(...args),
    resetDeltaToken: (...args: any[]) => mockResetDeltaToken(...args),
    startPermissionCrawl: (...args: any[]) => mockStartPermissionCrawl(...args),
    getPermissionStatus: (...args: any[]) => mockGetPermissionStatus(...args),
    updatePermissionMode: (...args: any[]) => mockUpdatePermissionMode(...args),
    triggerPermissionRecrawl: (...args: any[]) => mockTriggerPermissionRecrawl(...args),
    getJobStatus: (...args: any[]) => mockGetJobStatus(...args),
    executeBulkAction: (...args: any[]) => mockExecuteBulkAction(...args),
  };
});

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../routes/searchai-route-ownership.js', () => ({
  assertSearchIndexAccess: vi.fn().mockResolvedValue(true),
  assertConnectorIndexAccess: vi.fn().mockResolvedValue(true),
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
import connectorsRouter from '../../routes/connectors.js';

describe('Connector Name Check & Admin Email Routes', () => {
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
    app.use(connectorsRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET /:indexId/connectors/check-name ─────────────────────────────────

  describe('GET /:indexId/connectors/check-name', () => {
    test('should return available: true for unique name', async () => {
      mockCheckConnectorName.mockResolvedValue({ available: true });

      const res = await request(app)
        .get('/idx-1/connectors/check-name?name=My%20Connector')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.available).toBe(true);
      expect(mockCheckConnectorName).toHaveBeenCalledWith('idx-1', 'tenant-123', 'My Connector');
    });

    test('should return available: false with suggestion for duplicate name', async () => {
      mockCheckConnectorName.mockResolvedValue({
        available: false,
        suggestion: 'My Connector (2)',
      });

      const res = await request(app)
        .get('/idx-1/connectors/check-name?name=My%20Connector')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.available).toBe(false);
      expect(res.body.data.suggestion).toBe('My Connector (2)');
    });

    test('should return 400 when name query param is missing', async () => {
      const res = await request(app).get('/idx-1/connectors/check-name').expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('should return 400 for empty name', async () => {
      const res = await request(app).get('/idx-1/connectors/check-name?name=').expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('should return 500 when service throws', async () => {
      mockCheckConnectorName.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/idx-1/connectors/check-name?name=test').expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CHECK_NAME_FAILED');
    });

    test('should pass tenantId from auth context', async () => {
      mockCheckConnectorName.mockResolvedValue({ available: true });

      await request(app).get('/idx-1/connectors/check-name?name=test').expect(200);

      expect(mockCheckConnectorName).toHaveBeenCalledWith('idx-1', 'tenant-123', 'test');
    });
  });

  // ── POST /:indexId/connectors/generate-admin-email ──────────────────────

  describe('POST /:indexId/connectors/generate-admin-email', () => {
    test('should generate admin email for app_registration_setup', async () => {
      const emailResponse = {
        subject: 'App Registration Request',
        body: 'Please create an app registration...',
        mailto: 'mailto:admin@example.com?subject=...',
      };
      mockGenerateAdminEmail.mockResolvedValue(emailResponse);

      const res = await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({ type: 'app_registration_setup' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.subject).toBe('App Registration Request');
      expect(res.body.data.mailto).toBeDefined();
      expect(mockGenerateAdminEmail).toHaveBeenCalledWith(
        'idx-1',
        'tenant-123',
        'app_registration_setup',
      );
    });

    test('should return 400 when type is missing', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('should return 400 for invalid type', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({ type: 'invalid_type' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('should return 500 when service throws', async () => {
      mockGenerateAdminEmail.mockRejectedValue(new Error('Template error'));

      const res = await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({ type: 'app_registration_setup' })
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GENERATE_EMAIL_FAILED');
    });

    test('should pass tenantId from auth context', async () => {
      mockGenerateAdminEmail.mockResolvedValue({
        subject: 'test',
        body: 'test',
        mailto: 'mailto:test',
      });

      await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({ type: 'app_registration_setup' })
        .expect(200);

      expect(mockGenerateAdminEmail).toHaveBeenCalledWith(
        'idx-1',
        'tenant-123',
        'app_registration_setup',
      );
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    test('check-name uses tenantId for isolation', async () => {
      mockCheckConnectorName.mockResolvedValue({ available: true });

      await request(app).get('/idx-1/connectors/check-name?name=test').expect(200);

      // Verify tenantId is the second argument
      expect(mockCheckConnectorName.mock.calls[0][1]).toBe('tenant-123');
    });

    test('generate-admin-email uses tenantId for isolation', async () => {
      mockGenerateAdminEmail.mockResolvedValue({
        subject: 'test',
        body: 'test',
        mailto: 'mailto:test',
      });

      await request(app)
        .post('/idx-1/connectors/generate-admin-email')
        .send({ type: 'app_registration_setup' })
        .expect(200);

      // Verify tenantId is the second argument
      expect(mockGenerateAdminEmail.mock.calls[0][1]).toBe('tenant-123');
    });

    test('cross-tenant access returns error from service layer', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockCheckConnectorName.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'Index not found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/check-name?name=test').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
