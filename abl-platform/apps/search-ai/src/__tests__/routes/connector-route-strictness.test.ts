import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

const {
  mockListConnectors,
  mockGetAuditLog,
  mockPreviewImport,
  mockRestoreVersion,
  mockCreateTemplate,
  mockExecuteRetry,
  mockUpdatePermissionSchedule,
  mockListTemplates,
  mockUpdateNotificationConfig,
  mockSendHeartbeat,
  mockModifySection,
  mockEmergencyRevoke,
  mockCheckSiteAccess,
  mockConnectorConfigFindOne,
  mockSearchIndexFindOne,
  mockSearchSourceFindOne,
} = vi.hoisted(() => ({
  mockListConnectors: vi.fn(),
  mockGetAuditLog: vi.fn(),
  mockPreviewImport: vi.fn(),
  mockRestoreVersion: vi.fn(),
  mockCreateTemplate: vi.fn(),
  mockExecuteRetry: vi.fn(),
  mockUpdatePermissionSchedule: vi.fn(),
  mockListTemplates: vi.fn(),
  mockUpdateNotificationConfig: vi.fn(),
  mockSendHeartbeat: vi.fn(),
  mockModifySection: vi.fn(),
  mockEmergencyRevoke: vi.fn(),
  mockCheckSiteAccess: vi.fn(),
  mockConnectorConfigFindOne: vi.fn(),
  mockSearchIndexFindOne: vi.fn(),
  mockSearchSourceFindOne: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
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

  return {
    ConnectorError,
    listConnectors: (...args: unknown[]) => mockListConnectors(...args),
    cloneConnector: vi.fn(),
    previewFilters: vi.fn(),
  };
});

vi.mock('../../services/connector-audit.service.js', () => ({
  getAuditLog: (...args: unknown[]) => mockGetAuditLog(...args),
  exportAuditLog: vi.fn(),
}));

vi.mock('../../services/connector-config-mgmt.service.js', () => ({
  exportConfig: vi.fn(),
  getConfigDrift: vi.fn(),
  reapplyTemplate: vi.fn(),
  updateTemplateFromCurrent: vi.fn(),
  ignoreDrift: vi.fn(),
  previewImport: (...args: unknown[]) => mockPreviewImport(...args),
  confirmImport: vi.fn(),
}));

vi.mock('../../services/connector-config-version.service.js', () => ({
  getVersionHistory: vi.fn(),
  getVersionSnapshot: vi.fn(),
  createVersion: vi.fn(),
  diffVersions: vi.fn(),
  restoreVersion: (...args: unknown[]) => mockRestoreVersion(...args),
}));

vi.mock('../../services/connector-error.service.js', () => ({
  classifyError: vi.fn(),
  executeRetry: (...args: unknown[]) => mockExecuteRetry(...args),
}));

vi.mock('../../repos/connector.repository.js', () => ({
  findConnectorByIdAndTenantLean: vi.fn(),
}));

vi.mock('../../services/connector-monitoring.service.js', () => ({
  getOverview: vi.fn(),
  getContentBreakdown: vi.fn(),
  getSyncHistory: vi.fn(),
  updatePermissionSchedule: (...args: unknown[]) => mockUpdatePermissionSchedule(...args),
}));

vi.mock('../../services/connector-template.service.js', () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
  createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
  applyTemplate: vi.fn(),
  importConnectorConfig: vi.fn(),
}));

vi.mock('../../services/connector-notification.service.js', () => ({
  getNotificationConfig: vi.fn(),
  updateNotificationConfig: (...args: unknown[]) => mockUpdateNotificationConfig(...args),
  testWebhook: vi.fn(),
}));

vi.mock('../../services/connector-presence.service.js', () => ({
  sendHeartbeat: (...args: unknown[]) => mockSendHeartbeat(...args),
  getActiveEditors: vi.fn(),
}));

vi.mock('../../services/proposal.service.js', () => ({
  startGeneration: vi.fn(),
  getGenerationStatus: vi.fn(),
  getProposal: vi.fn(),
  acceptSection: vi.fn(),
  modifySection: (...args: unknown[]) => mockModifySection(...args),
  skipSection: vi.fn(),
  acceptAllRemaining: vi.fn(),
  approveProposal: vi.fn(),
  abandonProposal: vi.fn(),
  exportProposal: vi.fn(),
  validateSites: vi.fn(),
  refreshSamplePreview: vi.fn(),
  disablePermissionAware: vi.fn(),
  rerunHealthCheck: vi.fn(),
  getConfigSummary: vi.fn(),
}));

vi.mock('../../services/connector-security.service.js', () => ({
  getSecurityOverview: vi.fn(),
  getBlastRadius: vi.fn(),
  exportSecurityDocument: vi.fn(),
  emergencyRevoke: (...args: unknown[]) => mockEmergencyRevoke(...args),
}));

vi.mock('../../services/connector-utility.service.js', () => ({
  getSiteStatuses: vi.fn(),
  getFilterAnalysis: vi.fn(),
  checkSiteAccess: (...args: unknown[]) => mockCheckSiteAccess(...args),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'ConnectorConfig') {
      return { findOne: mockConnectorConfigFindOne, findOneAndUpdate: vi.fn() };
    }

    if (modelName === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }

    if (modelName === 'SearchSource') {
      return { findOne: mockSearchSourceFindOne };
    }

    if (modelName === 'CanonicalSchema') {
      return { findOne: vi.fn(), create: vi.fn() };
    }

    if (modelName === 'FieldMapping') {
      return { deleteMany: vi.fn(), insertMany: vi.fn() };
    }

    return {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      insertMany: vi.fn(),
    };
  }),
}));

vi.mock('@agent-platform/search-ai-internal/canonical', () => ({
  getAvailableField: vi.fn(),
  toCanonicalField: vi.fn(),
}));

vi.mock('../../services/connector-field-preview.service.js', () => ({
  generateFieldPreview: vi.fn(),
}));

vi.mock('../../services/canonical-mapping/index.js', () => ({
  getCanonicalMapperService: vi.fn(),
}));

import connectorsRouter from '../../routes/connectors.js';
import auditRouter from '../../routes/connector-audit.js';
import configMgmtRouter from '../../routes/connector-config-mgmt.js';
import configVersionsRouter from '../../routes/connector-config-versions.js';
import errorRecoveryRouter from '../../routes/connector-error-recovery.js';
import fieldConfigRouter from '../../routes/connector-field-config.js';
import monitoringRouter from '../../routes/connector-monitoring.js';
import multiRouter from '../../routes/connector-multi.js';
import notificationsRouter from '../../routes/connector-notifications.js';
import presenceRouter from '../../routes/connector-presence.js';
import proposalRouter from '../../routes/connector-proposal.js';
import securityRouter from '../../routes/connector-security.js';
import utilitiesRouter from '../../routes/connector-utilities.js';

function createApp(router: any): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantContext = {
      tenantId: 'tenant-123',
      userId: 'user-456',
      projectScope: ['project-allowed'],
    } as any;
    req.user = { email: 'user@example.com', name: 'User Example' } as any;
    next();
  });
  app.use(router);
  return app;
}

describe('Connector route strictness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTemplate.mockReset();
    mockConnectorConfigFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'conn-1',
        tenantId: 'tenant-123',
        sourceId: 'source-1',
      }),
    });
    mockSearchSourceFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'source-1',
        tenantId: 'tenant-123',
        indexId: 'idx-1',
      }),
    });
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-123',
        projectId: 'project-allowed',
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    {
      description: 'connectors list rejects unknown query keys',
      router: connectorsRouter,
      method: 'get',
      path: '/idx-1/connectors?search=test&unexpected=1',
      expectedCode: 'INVALID_QUERY',
      mockFn: mockListConnectors,
    },
    {
      description: 'audit log rejects unknown query keys',
      router: auditRouter,
      method: 'get',
      path: '/idx-1/connectors/conn-1/audit-log?page=1&unexpected=1',
      expectedCode: 'INVALID_QUERY',
      mockFn: mockGetAuditLog,
    },
    {
      description: 'config import preview rejects unknown body keys',
      router: configMgmtRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/config/import',
      body: { config: {}, unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockPreviewImport,
    },
    {
      description: 'config restore rejects unknown body keys',
      router: configVersionsRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/config/versions/restore',
      body: { version: 1, unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockRestoreVersion,
    },
    {
      description: 'retry action rejects unknown body keys',
      router: errorRecoveryRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/retry',
      body: { action: 'retry_auth', unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockExecuteRetry,
    },
    {
      description: 'monitoring schedule rejects unknown body keys',
      router: monitoringRouter,
      method: 'put',
      path: '/idx-1/connectors/conn-1/permission-schedule',
      body: { schedule: 'manual', unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockUpdatePermissionSchedule,
    },
    {
      description: 'template list rejects unknown query keys',
      router: multiRouter,
      method: 'get',
      path: '/idx-1/connector-templates?search=test&unexpected=1',
      expectedCode: 'INVALID_QUERY',
      mockFn: mockListTemplates,
    },
    {
      description: 'notification updates reject unknown body keys',
      router: notificationsRouter,
      method: 'put',
      path: '/idx-1/connectors/conn-1/notifications',
      body: { emailAlertsEnabled: true, unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockUpdateNotificationConfig,
    },
    {
      description: 'presence heartbeat rejects unknown body keys',
      router: presenceRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/presence/heartbeat',
      body: { activeTab: 'overview', unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockSendHeartbeat,
    },
    {
      description: 'proposal section updates reject unknown body keys',
      router: proposalRouter,
      method: 'put',
      path: '/idx-1/connectors/conn-1/proposal/sections/scope',
      body: { data: {}, unexpected: true },
      expectedCode: 'VALIDATION_ERROR',
      mockFn: mockModifySection,
    },
    {
      description: 'security revoke rejects unknown body keys',
      router: securityRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/security/emergency-revoke',
      body: { confirmPhrase: 'CONFIRM', unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockEmergencyRevoke,
    },
    {
      description: 'site access checks reject unknown body keys',
      router: utilitiesRouter,
      method: 'post',
      path: '/idx-1/connectors/conn-1/check-site-access',
      body: { siteUrl: 'https://example.com', unexpected: true },
      expectedCode: 'INVALID_BODY',
      mockFn: mockCheckSiteAccess,
    },
  ])('$description', async ({ router, method, path, body, expectedCode, mockFn }) => {
    const app = createApp(router);
    const req =
      method === 'get'
        ? request(app).get(path)
        : method === 'put'
          ? request(app).put(path)
          : request(app).post(path);
    if (body) {
      req.send(body);
    }

    const res = await req.expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(expectedCode);
    expect(mockFn).not.toHaveBeenCalled();
  });

  test('field-config rejects unknown nested field keys before touching business persistence', async () => {
    const app = createApp(fieldConfigRouter);

    const res = await request(app)
      .put('/idx-1/connectors/conn-1/field-config')
      .send({
        fields: [
          {
            sourcePath: 'Title',
            displayName: 'Title',
            fieldType: 'string',
            selected: true,
            includeInEmbedding: true,
            canonicalMapping: 'title',
            confidence: 0.9,
            mappingSource: 'user',
            unexpected: true,
          },
        ],
      })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_BODY');
    expect(mockConnectorConfigFindOne).toHaveBeenCalledTimes(1);
  });

  test('connector-scoped routes reject cross-project connector ownership before services run', async () => {
    mockSearchIndexFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    const app = createApp(monitoringRouter);

    const res = await request(app)
      .put('/idx-1/connectors/conn-1/permission-schedule')
      .send({ schedule: 'manual' })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-1',
      tenantId: 'tenant-123',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockUpdatePermissionSchedule).not.toHaveBeenCalled();
  });

  test('index-scoped connector routes reject cross-project index ownership before services run', async () => {
    mockSearchIndexFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    const app = createApp(multiRouter);

    const res = await request(app).get('/idx-1/connector-templates?search=test').expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-1',
      tenantId: 'tenant-123',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  test('template creation rejects source connectors outside the route index before service runs', async () => {
    mockSearchSourceFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });
    const app = createApp(multiRouter);

    const res = await request(app)
      .post('/idx-1/connector-templates')
      .send({ sourceConnectorId: 'conn-1', name: 'Safe template' })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchSourceFindOne).toHaveBeenCalledWith({
      _id: 'source-1',
      tenantId: 'tenant-123',
      indexId: 'idx-1',
    });
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });
});
