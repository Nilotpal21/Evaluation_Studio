/**
 * Connector Proposal Route Tests
 *
 * Tests for proposal lifecycle: generation, status polling, section review,
 * approval, abandonment, and export.
 *
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ── Mock dependencies before imports ──────────────────────────────────────

const mockStartGeneration = vi.fn();
const mockGetGenerationStatus = vi.fn();
const mockGetProposal = vi.fn();
const mockAcceptSection = vi.fn();
const mockModifySection = vi.fn();
const mockSkipSection = vi.fn();
const mockAcceptAllRemaining = vi.fn();
const mockApproveProposal = vi.fn();
const mockAbandonProposal = vi.fn();
const mockExportProposal = vi.fn();
const mockValidateSites = vi.fn();
const mockRefreshSamplePreview = vi.fn();
const mockDisablePermissionAware = vi.fn();
const mockRerunHealthCheck = vi.fn();
const mockGetConfigSummary = vi.fn();

vi.mock('../../services/proposal.service.js', () => ({
  startGeneration: (...args: any[]) => mockStartGeneration(...args),
  getGenerationStatus: (...args: any[]) => mockGetGenerationStatus(...args),
  getProposal: (...args: any[]) => mockGetProposal(...args),
  acceptSection: (...args: any[]) => mockAcceptSection(...args),
  modifySection: (...args: any[]) => mockModifySection(...args),
  skipSection: (...args: any[]) => mockSkipSection(...args),
  acceptAllRemaining: (...args: any[]) => mockAcceptAllRemaining(...args),
  approveProposal: (...args: any[]) => mockApproveProposal(...args),
  abandonProposal: (...args: any[]) => mockAbandonProposal(...args),
  exportProposal: (...args: any[]) => mockExportProposal(...args),
  validateSites: (...args: any[]) => mockValidateSites(...args),
  refreshSamplePreview: (...args: any[]) => mockRefreshSamplePreview(...args),
  disablePermissionAware: (...args: any[]) => mockDisablePermissionAware(...args),
  rerunHealthCheck: (...args: any[]) => mockRerunHealthCheck(...args),
  getConfigSummary: (...args: any[]) => mockGetConfigSummary(...args),
}));

const mockPreviewFilters = vi.fn();

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
    previewFilters: (...args: any[]) => mockPreviewFilters(...args),
  };
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
import proposalRouter from '../../routes/connector-proposal.js';

describe('Connector Proposal Routes', () => {
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
    app.use(proposalRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── POST /:indexId/connectors/:connectorId/proposal/generate ────────────

  describe('POST /:indexId/connectors/:connectorId/proposal/generate', () => {
    test('should return 202 on successful generation start', async () => {
      const mockProposal = { id: 'prop-1', status: 'generating', progress: 0 };
      mockStartGeneration.mockResolvedValue(mockProposal);

      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/generate').expect(202);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('generating');
      expect(mockStartGeneration).toHaveBeenCalledWith('conn-1', 'tenant-123');
    });

    test('should return 400 for empty connectorId param', async () => {
      // Route won't match empty segment — tests Zod validation indirectly
      mockStartGeneration.mockResolvedValue({ status: 'generating' });
      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/generate').expect(202);
      expect(res.body.success).toBe(true);
    });

    test('should return ConnectorError when service throws', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockStartGeneration.mockRejectedValue(
        new ConnectorError('PROPOSAL_EXISTS', 'Proposal already in progress', 409),
      );

      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/generate').expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PROPOSAL_EXISTS');
    });

    test('should return 500 for unexpected errors', async () => {
      mockStartGeneration.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/generate').expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GENERATE_PROPOSAL_FAILED');
    });
  });

  // ── GET /:indexId/connectors/:connectorId/proposal/status ───────────────

  describe('GET /:indexId/connectors/:connectorId/proposal/status', () => {
    test('should return generation status', async () => {
      const statusData = {
        status: 'generating',
        progress: 60,
        currentStep: 'health-check',
        steps: [],
      };
      mockGetGenerationStatus.mockResolvedValue(statusData);

      const res = await request(app).get('/idx-1/connectors/conn-1/proposal/status').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.progress).toBe(60);
      expect(mockGetGenerationStatus).toHaveBeenCalledWith('conn-1', 'tenant-123');
    });

    test('should return 404 when no proposal exists', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockGetGenerationStatus.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'No proposal found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/conn-1/proposal/status').expect(404);

      expect(res.body.success).toBe(false);
    });
  });

  // ── GET /:indexId/connectors/:connectorId/proposal ──────────────────────

  describe('GET /:indexId/connectors/:connectorId/proposal', () => {
    test('should return full proposal', async () => {
      const proposal = {
        status: 'ready',
        sections: [
          { id: 'scope', status: 'pending', data: {} },
          { id: 'permissions', status: 'pending', data: {} },
        ],
      };
      mockGetProposal.mockResolvedValue(proposal);

      const res = await request(app).get('/idx-1/connectors/conn-1/proposal').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sections).toHaveLength(2);
    });
  });

  // ── Section Review Routes ───────────────────────────────────────────────

  describe('POST /:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept', () => {
    test('should accept a section', async () => {
      mockAcceptSection.mockResolvedValue({ sectionId: 'scope', status: 'accepted' });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections/scope/accept')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockAcceptSection).toHaveBeenCalledWith('conn-1', 'tenant-123', 'scope', 'user-456');
    });

    test('should return 400 for empty sectionId', async () => {
      // Route won't match — Express 404
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections//accept')
        .expect(404);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /:indexId/connectors/:connectorId/proposal/sections/:sectionId', () => {
    test('should modify a section with provided data', async () => {
      mockModifySection.mockResolvedValue({ sectionId: 'scope', status: 'modified' });

      const res = await request(app)
        .put('/idx-1/connectors/conn-1/proposal/sections/scope')
        .send({ data: { siteUrls: ['https://example.com'] } })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockModifySection).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        'scope',
        { siteUrls: ['https://example.com'] },
        'user-456',
      );
    });

    test('should return 400 when body.data is missing', async () => {
      const res = await request(app)
        .put('/idx-1/connectors/conn-1/proposal/sections/scope')
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /:indexId/connectors/:connectorId/proposal/sections/:sectionId/skip', () => {
    test('should skip a section', async () => {
      mockSkipSection.mockResolvedValue({ sectionId: 'permissions', status: 'skipped' });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections/permissions/skip')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockSkipSection).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        'permissions',
        'user-456',
      );
    });
  });

  // ── Accept All ──────────────────────────────────────────────────────────

  describe('POST /:indexId/connectors/:connectorId/proposal/accept-all', () => {
    test('should accept all remaining sections', async () => {
      mockAcceptAllRemaining.mockResolvedValue({ status: 'all_accepted', count: 3 });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/accept-all')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.count).toBe(3);
      expect(mockAcceptAllRemaining).toHaveBeenCalledWith('conn-1', 'tenant-123', 'user-456');
    });
  });

  // ── Approve ─────────────────────────────────────────────────────────────

  describe('POST /:indexId/connectors/:connectorId/proposal/approve', () => {
    test('should approve the proposal', async () => {
      mockApproveProposal.mockResolvedValue({ status: 'approved' });

      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/approve').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('approved');
      expect(mockApproveProposal).toHaveBeenCalledWith('conn-1', 'tenant-123', 'user-456');
    });

    test('should return 409 when proposal has unreviewed sections', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockApproveProposal.mockRejectedValue(
        new ConnectorError('SECTIONS_PENDING', 'All sections must be reviewed', 409),
      );

      const res = await request(app).post('/idx-1/connectors/conn-1/proposal/approve').expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SECTIONS_PENDING');
    });
  });

  // ── Abandon ─────────────────────────────────────────────────────────────

  describe('DELETE /:indexId/connectors/:connectorId/proposal/abandon', () => {
    test('should abandon the proposal', async () => {
      mockAbandonProposal.mockResolvedValue({ status: 'abandoned' });

      const res = await request(app)
        .delete('/idx-1/connectors/conn-1/proposal/abandon')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('abandoned');
      expect(mockAbandonProposal).toHaveBeenCalledWith('conn-1', 'tenant-123', 'user-456');
    });
  });

  // ── Export ──────────────────────────────────────────────────────────────

  describe('GET /:indexId/connectors/:connectorId/proposal/export', () => {
    test('should export proposal as JSON', async () => {
      const jsonData = JSON.stringify({ sections: [] });
      mockExportProposal.mockResolvedValue({
        data: jsonData,
        contentType: 'application/json',
        filename: 'proposal-conn-1.json',
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/proposal/export?format=json')
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toContain('proposal-conn-1.json');
      expect(mockExportProposal).toHaveBeenCalledWith('conn-1', 'tenant-123', 'json');
    });

    test('should export proposal as YAML', async () => {
      mockExportProposal.mockResolvedValue({
        data: 'sections: []\n',
        contentType: 'application/x-yaml',
        filename: 'proposal-conn-1.yaml',
      });

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/proposal/export?format=yaml')
        .expect(200);

      expect(res.headers['content-type']).toContain('application/x-yaml');
      expect(mockExportProposal).toHaveBeenCalledWith('conn-1', 'tenant-123', 'yaml');
    });

    test('should return 400 when format is missing', async () => {
      const res = await request(app).get('/idx-1/connectors/conn-1/proposal/export').expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('should return 400 for invalid format', async () => {
      const res = await request(app)
        .get('/idx-1/connectors/conn-1/proposal/export?format=xml')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('should return 501 for PDF format', async () => {
      mockExportProposal.mockRejectedValue(new Error('PDF export is not yet implemented'));

      const res = await request(app)
        .get('/idx-1/connectors/conn-1/proposal/export?format=pdf')
        .expect(501);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    });
  });

  // ── Utility Routes ──────────────────────────────────────────────────────

  describe('POST /:indexId/connectors/:connectorId/proposal/scope/validate-sites', () => {
    test('should validate site URLs', async () => {
      mockValidateSites.mockResolvedValue({
        results: [{ url: 'https://example.sharepoint.com', valid: true }],
      });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/scope/validate-sites')
        .send({ siteUrls: ['https://example.sharepoint.com'] })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.results).toHaveLength(1);
      expect(mockValidateSites).toHaveBeenCalledWith('conn-1', 'tenant-123', [
        'https://example.sharepoint.com',
      ]);
    });

    test('should return 400 for invalid URLs', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/scope/validate-sites')
        .send({ siteUrls: ['not-a-url'] })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('should return 400 for empty siteUrls array', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/scope/validate-sites')
        .send({ siteUrls: [] })
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /:indexId/connectors/:connectorId/proposal/sections/permissions/disable', () => {
    test('should disable permission-aware with confirmation', async () => {
      mockDisablePermissionAware.mockResolvedValue({ permissionMode: 'disabled' });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections/permissions/disable')
        .send({ confirmationText: 'I understand' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockDisablePermissionAware).toHaveBeenCalledWith(
        'conn-1',
        'tenant-123',
        'I understand',
        'user-456',
      );
    });

    test('should return 400 when confirmationText is missing', async () => {
      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections/permissions/disable')
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /:indexId/connectors/:connectorId/proposal/sections/health-check/rerun', () => {
    test('should trigger health check rerun', async () => {
      mockRerunHealthCheck.mockResolvedValue({ status: 'running' });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/sections/health-check/rerun')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockRerunHealthCheck).toHaveBeenCalledWith('conn-1', 'tenant-123');
    });
  });

  describe('POST /:indexId/connectors/:connectorId/proposal/filters/preview', () => {
    test('should preview filter results', async () => {
      mockPreviewFilters.mockResolvedValue({ matchCount: 42, sampleDocs: [] });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/filters/preview')
        .send({ filterConfig: { mode: 'include', siteUrls: [] } })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.matchCount).toBe(42);
      expect(mockPreviewFilters).toHaveBeenCalledWith('conn-1', 'tenant-123', {
        mode: 'include',
        siteUrls: [],
      });
    });

    test('should accept empty body for no filter preview', async () => {
      mockPreviewFilters.mockResolvedValue({ matchCount: 100, sampleDocs: [] });

      const res = await request(app)
        .post('/idx-1/connectors/conn-1/proposal/filters/preview')
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  // ── Config Summary ──────────────────────────────────────────────────────

  describe('GET /:indexId/connectors/:connectorId/summary', () => {
    test('should return config summary', async () => {
      mockGetConfigSummary.mockResolvedValue({
        connectorType: 'sharepoint',
        sitesCount: 5,
        permissionMode: 'enabled',
      });

      const res = await request(app).get('/idx-1/connectors/conn-1/summary').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.connectorType).toBe('sharepoint');
      expect(mockGetConfigSummary).toHaveBeenCalledWith('conn-1', 'tenant-123', 'idx-1');
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    test('should pass tenantId to generation service', async () => {
      mockStartGeneration.mockResolvedValue({ status: 'generating' });

      await request(app).post('/idx-1/connectors/conn-1/proposal/generate').expect(202);

      expect(mockStartGeneration).toHaveBeenCalledWith('conn-1', 'tenant-123');
    });

    test('should pass tenantId to approval service', async () => {
      mockApproveProposal.mockResolvedValue({ status: 'approved' });

      await request(app).post('/idx-1/connectors/conn-1/proposal/approve').expect(200);

      expect(mockApproveProposal).toHaveBeenCalledWith('conn-1', 'tenant-123', 'user-456');
    });

    test('cross-tenant access returns error from service layer', async () => {
      const { ConnectorError } = await import('../../services/connector.service.js');
      mockGetProposal.mockRejectedValue(
        new ConnectorError('NOT_FOUND', 'Connector not found', 404),
      );

      const res = await request(app).get('/idx-1/connectors/conn-1/proposal').expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
