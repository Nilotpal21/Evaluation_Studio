/**
 * Azure Document Intelligence usage routes (LLD §3 Phase 3 Task 3.11).
 *
 *   GET   /api/projects/:projectId/integrations/azure-document-intelligence/usage
 *   PATCH /api/projects/:projectId/integrations/azure-document-intelligence/usage-caps
 *
 * Mounted on the authenticated `projectRouter`. Each handler resolves
 * `(tenantId, projectId)` via `requireTenantProject` and additionally validates
 * `req.params` with Zod (LLD §1 D-17). 404 `FEATURE_DISABLED` is returned when
 * the feature flag is off so existence of the route is not leaked (LLD §1 D-18).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';

interface ConnectorConnectionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  authProfileId: string;
  status: 'active' | 'expired' | 'revoked';
  usageCount?: number;
  usagePeriodStart?: Date;
  usageSoftCap?: number | null;
  usageHardCap?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorConnectionUsageModel {
  findOne(filter: Record<string, unknown>): Promise<ConnectorConnectionDoc | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ConnectorConnectionDoc | null>;
}

export interface AzureDIUsageRouterDeps {
  connectorConnectionModel: ConnectorConnectionUsageModel;
}

const AZURE_DI_CONNECTOR_NAME = 'azure-document-intelligence';

const ProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict();

// `min(0)` is deliberate: a tenant admin may set `usageHardCap: 0` as an
// emergency kill switch (next call rejects with `QUOTA_EXCEEDED`) or
// `usageSoftCap: 0` as part of a phased rollout. Both flow through the same
// runtime check as larger values; the UI surfaces an "approaching cap"
// warning once `usageCount/usageSoftCap >= 0.8`, which fires immediately
// when soft cap is 0 — the intended behaviour.
const UpdateCapsBodySchema = z
  .object({
    usageSoftCap: z.number().int().min(0).nullable().optional(),
    usageHardCap: z.number().int().min(0).nullable().optional(),
  })
  .strict()
  .refine(
    (data) => data.usageSoftCap !== undefined || data.usageHardCap !== undefined,
    'At least one of usageSoftCap or usageHardCap must be provided',
  );

const FEATURE_DISABLED_RESPONSE = {
  success: false as const,
  error: { code: 'FEATURE_DISABLED', message: 'Feature not available' },
};

const CONNECTION_NOT_FOUND_RESPONSE = {
  success: false as const,
  error: {
    code: 'CONNECTION_NOT_FOUND',
    message: 'No Azure Document Intelligence connection bound to this project',
  },
};

function isFeatureEnabled(): boolean {
  return process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true';
}

function snapshotUsage(doc: ConnectorConnectionDoc): {
  usageCount: number;
  usageSoftCap: number | null;
  usageHardCap: number | null;
  usagePeriodStart: Date | null;
} {
  return {
    usageCount: typeof doc.usageCount === 'number' ? doc.usageCount : 0,
    usageSoftCap: typeof doc.usageSoftCap === 'number' ? doc.usageSoftCap : null,
    usageHardCap: typeof doc.usageHardCap === 'number' ? doc.usageHardCap : null,
    usagePeriodStart: doc.usagePeriodStart ?? null,
  };
}

export function createAzureDIUsageRouter(deps: AzureDIUsageRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/azure-document-intelligence/usage',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isFeatureEnabled()) {
        res.status(404).json(FEATURE_DISABLED_RESPONSE);
        return;
      }
      const params = ProjectParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: params.error.issues[0]?.message ?? 'invalid',
          },
        });
        return;
      }
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      const connection = await deps.connectorConnectionModel.findOne({
        tenantId,
        projectId,
        connectorName: AZURE_DI_CONNECTOR_NAME,
      });
      if (!connection) {
        res.status(404).json(CONNECTION_NOT_FOUND_RESPONSE);
        return;
      }
      res.json({ success: true, data: snapshotUsage(connection) });
    }),
  );

  router.patch(
    '/azure-document-intelligence/usage-caps',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isFeatureEnabled()) {
        res.status(404).json(FEATURE_DISABLED_RESPONSE);
        return;
      }
      const params = ProjectParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: params.error.issues[0]?.message ?? 'invalid',
          },
        });
        return;
      }
      const body = UpdateCapsBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_BODY',
            message: body.error.issues[0]?.message ?? 'invalid',
          },
        });
        return;
      }
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      const update: Record<string, unknown> = {};
      if (body.data.usageSoftCap !== undefined) update.usageSoftCap = body.data.usageSoftCap;
      if (body.data.usageHardCap !== undefined) update.usageHardCap = body.data.usageHardCap;

      const updated = await deps.connectorConnectionModel.findOneAndUpdate(
        { tenantId, projectId, connectorName: AZURE_DI_CONNECTOR_NAME },
        { $set: update },
        { new: true },
      );
      if (!updated) {
        res.status(404).json(CONNECTION_NOT_FOUND_RESPONSE);
        return;
      }
      res.json({ success: true, data: snapshotUsage(updated) });
    }),
  );

  return router;
}
