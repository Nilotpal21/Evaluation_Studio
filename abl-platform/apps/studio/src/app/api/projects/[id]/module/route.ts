/**
 * GET  /api/projects/:id/module — Get current module settings
 * POST /api/projects/:id/module — Enable/disable module mode and set visibility
 *
 * Feature-gated: requireFeature 'reusable_modules' checks tenant plan/deals
 * server-side (fail-closed). Frontend also checks via useFeatures() hook.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('api:projects:module-settings');

const ModuleSettingsSchema = z.object({
  enabled: z.boolean(),
  moduleVisibility: z.enum(['tenant', 'private']).optional(),
});

// ─── GET — Current module settings ──────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ params, tenantId }) => {
    await ensureDb();

    const projectId = params.id;
    const { Project } = await import('@agent-platform/database/models');

    const project = await Project.findOne(
      { _id: projectId, tenantId },
      { kind: 1, moduleVisibility: 1 },
    ).lean();

    if (!project) {
      return errorJson('Project not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({
      success: true,
      data: {
        enabled: project.kind === 'module',
        moduleVisibility: project.moduleVisibility ?? null,
      },
    });
  },
);

// ─── POST — Enable/disable module mode ──────────────────────────────────

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_MANAGE,
    requireFeature: 'reusable_modules',
    bodySchema: ModuleSettingsSchema,
  },
  async ({ user, params, tenantId, body }) => {
    await ensureDb();

    const projectId = params.id;
    const { Project, ProjectModuleDependency } = await import('@agent-platform/database/models');

    const project = await Project.findOne({ _id: projectId, tenantId }).lean();
    if (!project) {
      return errorJson('Project not found', 404, ErrorCode.NOT_FOUND);
    }

    if (body.enabled) {
      // Enable module mode: application -> module
      const update: Record<string, unknown> = {
        kind: 'module',
      };
      if (body.moduleVisibility) {
        update.moduleVisibility = body.moduleVisibility;
      }

      await Project.findOneAndUpdate({ _id: projectId, tenantId }, { $set: update });

      log.info('Module mode enabled', {
        projectId,
        tenantId,
        moduleVisibility: body.moduleVisibility ?? 'private',
      });

      logAuditEvent({
        userId: user.id,
        tenantId,
        action: AuditActions.MODULE_ENABLED,
        metadata: { projectId, moduleVisibility: body.moduleVisibility ?? 'private' },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to log audit event', { error: message });
      });

      return actionJson({ message: 'Module mode enabled' });
    } else {
      // Disable module mode: module -> application
      // Block if there are active consumer dependencies
      // NOTE: Small TOCTOU window exists between this count check and the kind update below.
      // A new consumer dependency could be created in between. Accepted risk: the window is
      // sub-millisecond, and if it occurs, the consumer's next deploy will fail gracefully
      // (module lookup returns 404). A distributed lock or transaction could close this gap
      // but adds complexity disproportionate to the risk.
      const consumerCount = await ProjectModuleDependency.countDocuments({
        tenantId,
        moduleProjectId: projectId,
      });

      if (consumerCount > 0) {
        return errorJson(
          `Cannot disable module mode: ${consumerCount} consumer project(s) depend on this module. Remove all consumer dependencies first.`,
          409,
          ErrorCode.MODULE_HAS_CONSUMERS,
        );
      }

      await Project.findOneAndUpdate(
        { _id: projectId, tenantId },
        { $set: { kind: 'application' }, $unset: { moduleVisibility: '' } },
      );

      log.info('Module mode disabled', { projectId, tenantId });

      logAuditEvent({
        userId: user.id,
        tenantId,
        action: AuditActions.MODULE_DISABLED,
        metadata: { projectId },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to log audit event', { error: message });
      });

      return actionJson({ message: 'Module mode disabled' });
    }
  },
);
