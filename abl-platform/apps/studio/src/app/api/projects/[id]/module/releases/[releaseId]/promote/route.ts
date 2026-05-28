/**
 * POST /api/projects/:id/module/releases/:releaseId/promote
 *
 * Promotes a module release to an environment pointer with optimistic concurrency.
 */

import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('module-promote-route');

const PromoteSchema = z.object({
  environment: z.enum(['dev', 'staging', 'production']),
  expectedRevision: z.number().int().min(0).optional(),
});

type PromoteInput = z.infer<typeof PromoteSchema>;

export const POST = withRouteHandler<PromoteInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_PUBLISH,
    requireFeature: 'reusable_modules',
    bodySchema: PromoteSchema,
  },
  async ({ user, params, tenantId, body }) => {
    const promoteStartMs = Date.now();
    await ensureDb();

    const projectId = params.id;
    const releaseId = params.releaseId;
    const { environment, expectedRevision } = body;

    if (!releaseId) {
      return errorJson('Release ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { ModuleRelease, ModuleEnvironmentPointer } =
      await import('@agent-platform/database/models');

    // Verify release exists and belongs to this project+tenant
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId,
      moduleProjectId: projectId,
    }).lean();

    if (!release) {
      return errorJson('Release not found', 404, ErrorCode.NOT_FOUND);
    }

    // Check if release is archived
    if (release.archivedAt) {
      return errorJson('Cannot promote an archived release', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (expectedRevision !== undefined) {
      // Optimistic concurrency: update only if revision matches
      const result = await ModuleEnvironmentPointer.findOneAndUpdate(
        {
          tenantId,
          moduleProjectId: projectId,
          environment,
          revision: expectedRevision,
        },
        {
          $set: {
            moduleReleaseId: releaseId,
            updatedBy: user.id,
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );

      if (!result) {
        return errorJson(
          `The ${environment} pointer was updated by another user. Please refresh and retry.`,
          409,
          ErrorCode.POINTER_CONFLICT,
        );
      }

      const newRevision = result.revision;

      log.info('Release promoted', {
        releaseId,
        environment,
        projectId,
        revision: newRevision,
        durationMs: Date.now() - promoteStartMs,
      });

      logAuditEvent({
        userId: user.id,
        tenantId,
        action: AuditActions.MODULE_PROMOTED,
        metadata: {
          projectId,
          releaseId,
          environment,
          version: release.version,
          revision: newRevision,
        },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to log audit event', { error: message });
      });

      return actionJson({
        message: `Release promoted to ${environment}`,
        pointer: {
          environment,
          moduleReleaseId: releaseId,
          revision: newRevision,
        },
      });
    } else {
      // First promotion or caller unaware of current revision — upsert
      const result = await ModuleEnvironmentPointer.findOneAndUpdate(
        {
          tenantId,
          moduleProjectId: projectId,
          environment,
        },
        {
          $set: {
            moduleReleaseId: releaseId,
            updatedBy: user.id,
          },
          $setOnInsert: {
            tenantId,
            moduleProjectId: projectId,
            environment,
          },
          $inc: { revision: 1 },
        },
        { upsert: true, new: true },
      );

      const newRevision = result.revision;

      log.info('Release promoted', {
        releaseId,
        environment,
        projectId,
        revision: newRevision,
        durationMs: Date.now() - promoteStartMs,
      });

      logAuditEvent({
        userId: user.id,
        tenantId,
        action: AuditActions.MODULE_PROMOTED,
        metadata: {
          projectId,
          releaseId,
          environment,
          version: release.version,
          revision: newRevision,
        },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to log audit event', { error: message });
      });

      return actionJson({
        message: `Release promoted to ${environment}`,
        pointer: {
          environment,
          moduleReleaseId: releaseId,
          revision: newRevision,
        },
      });
    }
  },
);
