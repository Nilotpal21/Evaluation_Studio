/**
 * Connector Proposal Routes
 *
 * Thin route layer for proposal lifecycle: generation, section review,
 * approval, abandonment, export, and utilities.
 *
 * Mounted under /api/indexes (via server.ts).
 * Auth middleware is applied at the router level.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as proposalService from '../services/proposal.service.js';
import * as connectorService from '../services/connector.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { sendGeneratedExport } from './export-response.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-proposal-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Validation Schemas ──────────────────────────────────────────────────

const connectorParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const sectionParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
  sectionId: z.string().min(1),
});

const modifySectionBody = z.strictObject({
  data: z.record(z.unknown()),
});

const validateSitesBody = z.strictObject({
  siteUrls: z.array(z.string().url()).min(1).max(100),
});

const disablePermissionBody = z.strictObject({
  confirmationText: z.string().min(1),
});

const exportQuery = z.strictObject({
  format: z.enum(['pdf', 'json', 'yaml']),
});

const filtersPreviewBody = z.strictObject({
  filterConfig: z.record(z.unknown()).optional(),
});

// ─── Error Handling ──────────────────────────────────────────────────────

/** Map ConnectorError to HTTP response; log unexpected errors. */
function handleError(res: Response, error: unknown, fallbackCode: string): void {
  if (error instanceof ConnectorError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(`${fallbackCode}: ${msg}`);
  res.status(500).json({
    success: false,
    error: { code: fallbackCode, message: msg },
  });
}

// ─── Generation & Status ─────────────────────────────────────────────────

/** POST /:indexId/connectors/:connectorId/proposal/generate — Start async generation */
router.post(
  '/:indexId/connectors/:connectorId/proposal/generate',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const proposal = await proposalService.startGeneration(connectorId, tenantId);
      res.status(202).json({ success: true, data: proposal });
    } catch (error) {
      handleError(res, error, 'GENERATE_PROPOSAL_FAILED');
    }
  },
);

/** GET /:indexId/connectors/:connectorId/proposal/status — Poll generation progress */
router.get(
  '/:indexId/connectors/:connectorId/proposal/status',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const data = await proposalService.getGenerationStatus(connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'GET_STATUS_FAILED');
    }
  },
);

/** GET /:indexId/connectors/:connectorId/proposal — Get full proposal */
router.get('/:indexId/connectors/:connectorId/proposal', async (req: Request, res: Response) => {
  try {
    const parsed = connectorParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }
    const { connectorId } = parsed.data;
    const tenantId = req.tenantContext!.tenantId;

    const data = await proposalService.getProposal(connectorId, tenantId);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'GET_PROPOSAL_FAILED');
  }
});

// ─── Section Review ──────────────────────────────────────────────────────

/** POST /:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept */
router.post(
  '/:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept',
  async (req: Request, res: Response) => {
    try {
      const parsed = sectionParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId, sectionId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.acceptSection(connectorId, tenantId, sectionId, actor);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'ACCEPT_SECTION_FAILED');
    }
  },
);

/** PUT /:indexId/connectors/:connectorId/proposal/sections/:sectionId — Modify section */
router.put(
  '/:indexId/connectors/:connectorId/proposal/sections/:sectionId',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = sectionParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
        });
        return;
      }
      const bodyParsed = modifySectionBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }
      const { connectorId, sectionId } = paramsParsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.modifySection(
        connectorId,
        tenantId,
        sectionId,
        bodyParsed.data.data,
        actor,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'MODIFY_SECTION_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/sections/:sectionId/skip */
router.post(
  '/:indexId/connectors/:connectorId/proposal/sections/:sectionId/skip',
  async (req: Request, res: Response) => {
    try {
      const parsed = sectionParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId, sectionId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.skipSection(connectorId, tenantId, sectionId, actor);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'SKIP_SECTION_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/accept-all */
router.post(
  '/:indexId/connectors/:connectorId/proposal/accept-all',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.acceptAllRemaining(connectorId, tenantId, actor);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'ACCEPT_ALL_FAILED');
    }
  },
);

// ─── Approval & Lifecycle ────────────────────────────────────────────────

/** POST /:indexId/connectors/:connectorId/proposal/approve */
router.post(
  '/:indexId/connectors/:connectorId/proposal/approve',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.approveProposal(connectorId, tenantId, actor);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'APPROVE_PROPOSAL_FAILED');
    }
  },
);

/** DELETE /:indexId/connectors/:connectorId/proposal/abandon */
router.delete(
  '/:indexId/connectors/:connectorId/proposal/abandon',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.abandonProposal(connectorId, tenantId, actor);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'ABANDON_PROPOSAL_FAILED');
    }
  },
);

// ─── Config Summary ──────────────────────────────────────────────────────

/** GET /:indexId/connectors/:connectorId/summary */
router.get('/:indexId/connectors/:connectorId/summary', async (req: Request, res: Response) => {
  try {
    const parsed = connectorParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }
    const { indexId, connectorId } = parsed.data;
    const tenantId = req.tenantContext!.tenantId;

    const data = await proposalService.getConfigSummary(connectorId, tenantId, indexId);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'GET_SUMMARY_FAILED');
  }
});

// ─── Utilities ───────────────────────────────────────────────────────────

/** POST /:indexId/connectors/:connectorId/proposal/scope/validate-sites */
router.post(
  '/:indexId/connectors/:connectorId/proposal/scope/validate-sites',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = connectorParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
        });
        return;
      }
      const bodyParsed = validateSitesBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }
      const { connectorId } = paramsParsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const data = await proposalService.validateSites(
        connectorId,
        tenantId,
        bodyParsed.data.siteUrls,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'VALIDATE_SITES_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/preview/refresh */
router.post(
  '/:indexId/connectors/:connectorId/proposal/preview/refresh',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const data = await proposalService.refreshSamplePreview(connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'REFRESH_PREVIEW_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/sections/permissions/disable */
router.post(
  '/:indexId/connectors/:connectorId/proposal/sections/permissions/disable',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = connectorParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
        });
        return;
      }
      const bodyParsed = disablePermissionBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }
      const { connectorId } = paramsParsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const actor = req.tenantContext!.userId ?? 'system';

      const data = await proposalService.disablePermissionAware(
        connectorId,
        tenantId,
        bodyParsed.data.confirmationText,
        actor,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'DISABLE_PERMISSION_FAILED');
    }
  },
);

/** GET /:indexId/connectors/:connectorId/proposal/export */
router.get(
  '/:indexId/connectors/:connectorId/proposal/export',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = connectorParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
        });
        return;
      }
      const queryParsed = exportQuery.safeParse(req.query);
      if (!queryParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: queryParsed.error.message },
        });
        return;
      }
      const { connectorId } = paramsParsed.data;
      const tenantId = req.tenantContext!.tenantId;
      const { format } = queryParsed.data;

      const result = await proposalService.exportProposal(connectorId, tenantId, format);
      sendGeneratedExport(res, result);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not yet implemented')) {
        res.status(501).json({
          success: false,
          error: { code: 'NOT_IMPLEMENTED', message: 'PDF export is not yet implemented' },
        });
        return;
      }
      handleError(res, error, 'EXPORT_PROPOSAL_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/sections/health-check/rerun */
router.post(
  '/:indexId/connectors/:connectorId/proposal/sections/health-check/rerun',
  async (req: Request, res: Response) => {
    try {
      const parsed = connectorParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }
      const { connectorId } = parsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const data = await proposalService.rerunHealthCheck(connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'RERUN_HEALTH_CHECK_FAILED');
    }
  },
);

/** POST /:indexId/connectors/:connectorId/proposal/filters/preview */
router.post(
  '/:indexId/connectors/:connectorId/proposal/filters/preview',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = connectorParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
        });
        return;
      }
      const bodyParsed = filtersPreviewBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }
      const { connectorId } = paramsParsed.data;
      const tenantId = req.tenantContext!.tenantId;

      const data = await connectorService.previewFilters(
        connectorId,
        tenantId,
        bodyParsed.data.filterConfig,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'FILTERS_PREVIEW_FAILED');
    }
  },
);

export default router;
