/**
 * Project-scoped integration endpoints (LLD Phase 2 Task 2.8).
 *
 * `/api/projects/:projectId/integrations/docling/{enable,disable,quota}`
 *
 * Auth chain: routes live on the **authenticated `projectRouter`**
 * (`requireAuth` + `tenantContext` + `requireProjectPermission` already
 * applied at the mount site). Each handler additionally calls
 * `requireTenantProject` and short-circuits on the typed reject envelope.
 *
 * The Docling toggle binds a project to a synthetic no-auth `ConnectorConnection`
 * — no real AuthProfile is created. The resolver's `metadata.authType === 'none'`
 * short-circuit (Phase 2 commit 2.A) means `tenant-encryption-facade.decrypt`
 * is never invoked on the binding, so a sentinel `authProfileId` value is safe.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';

/** Connector binding shape this router writes. */
interface ConnectorConnectionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  authProfileId: string;
  metadata?: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorConnectionModel {
  findOne(filter: Record<string, unknown>): Promise<ConnectorConnectionDoc | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ConnectorConnectionDoc | null>;
  findOneAndDelete(filter: Record<string, unknown>): Promise<ConnectorConnectionDoc | null>;
}

export interface IntegrationsRouterDeps {
  connectorConnectionModel: ConnectorConnectionModel;
}

/** Sentinel auth profile id used for the no-auth Docling binding. */
const DOCLING_SYNTHETIC_AUTH_PROFILE_ID = 'system-docling-none';
const DOCLING_CONNECTOR_NAME = 'docling';

const ProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict();

const FEATURE_DISABLED_RESPONSE = {
  success: false as const,
  error: { code: 'FEATURE_DISABLED', message: 'Feature not available' },
};

function isFeatureEnabled(): boolean {
  return process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true';
}

function readQuotaConfig(): { limitPerMinute: number; burst: number; scope: 'workspace' } {
  const raw = process.env.DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const limitPerMinute = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  // v1 simplification: the HLD calls for `10/min sustained + 5 burst`, but
  // `rate-limiter-flexible` does not natively support two-tier (sustained +
  // burst) configurations and `burst === limitPerMinute` is what the single-
  // bucket implementation actually delivers. Reporting `burst: limitPerMinute`
  // keeps the field present for the UI without overstating the limit.
  return { limitPerMinute, burst: limitPerMinute, scope: 'workspace' };
}

export function createIntegrationsRouter(deps: IntegrationsRouterDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * POST /docling/enable — idempotently upserts the synthetic no-auth
   * Docling `ConnectorConnection` for this project. Returns 404
   * `FEATURE_DISABLED` when the env flag is off (D-18: do not leak feature
   * presence to unauthorized requests).
   */
  router.post(
    '/docling/enable',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isFeatureEnabled()) {
        res.status(404).json(FEATURE_DISABLED_RESPONSE);
        return;
      }
      const params = ProjectParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: params.error.issues[0]?.message ?? 'invalid' },
        });
        return;
      }
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      const connection = await deps.connectorConnectionModel.findOneAndUpdate(
        { tenantId, projectId, connectorName: DOCLING_CONNECTOR_NAME },
        {
          $set: {
            status: 'active',
            authProfileId: DOCLING_SYNTHETIC_AUTH_PROFILE_ID,
            displayName: 'Docling',
            scope: 'tenant',
            metadata: { authType: 'none', synthetic: true },
          },
        },
        { upsert: true, new: true },
      );

      res.json({ success: true, data: connection });
    }),
  );

  /**
   * POST /docling/disable — removes the binding. The synthetic `authProfileId`
   * is sentinel-only (no AuthProfile row exists), so deletion is trivial.
   * Subsequent workflow runs fail-fast with `INTEGRATION_DISABLED` at the
   * picker / dispatch boundary because the `ConnectorConnection` is gone.
   */
  router.post(
    '/docling/disable',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isFeatureEnabled()) {
        res.status(404).json(FEATURE_DISABLED_RESPONSE);
        return;
      }
      const params = ProjectParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: params.error.issues[0]?.message ?? 'invalid' },
        });
        return;
      }
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      await deps.connectorConnectionModel.findOneAndDelete({
        tenantId,
        projectId,
        connectorName: DOCLING_CONNECTOR_NAME,
      });

      res.json({ success: true, data: { deleted: true } });
    }),
  );

  /**
   * GET /docling/quota — static config read for the UI's rate-limit info
   * line plus the current binding state so the toggle can hydrate without a
   * second round-trip. Returns even when the feature flag is off so the
   * Studio settings page can render a single "Feature unavailable" hint
   * without 404-bouncing.
   */
  router.get(
    '/docling/quota',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;
      const quota = readQuotaConfig();
      const enabled = isFeatureEnabled();
      const existing = await deps.connectorConnectionModel.findOne({
        tenantId,
        projectId,
        connectorName: DOCLING_CONNECTOR_NAME,
      });
      res.json({
        success: true,
        data: { ...quota, enabled, binding: existing !== null },
      });
    }),
  );

  return router;
}
