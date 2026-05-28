/**
 * GET  /api/projects/:id/module/releases/:releaseId — Release detail
 * POST /api/projects/:id/module/releases/:releaseId — Archive action
 */

import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { resolveSelector } from '@agent-platform/project-io';

const log = createLogger('module-release-detail-route');
const ACTIVE_DEPLOYMENT_STATUSES = ['active', 'draining'];

// ─── Schemas ──────────────────────────────────────────────────────────────

const ArchiveActionSchema = z.object({
  action: z.enum(['archive']),
});

type ArchiveActionInput = z.infer<typeof ArchiveActionSchema>;

// ─── GET — Release detail ────────────────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;
    const releaseId = params.releaseId;

    if (!releaseId) {
      return errorJson('Release ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { ModuleRelease } = await import('@agent-platform/database/models');

    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId,
      moduleProjectId: projectId,
    }).lean();

    if (!release) {
      return errorJson('Release not found', 404, ErrorCode.NOT_FOUND);
    }

    const r = release as Record<string, unknown>;

    // Return release fields excluding compiledIR (security — don't leak full IR)
    return actionJson({
      data: {
        id: String(r._id),
        version: r.version,
        releaseNotes: r.releaseNotes,
        contract: r.contract,
        artifact: r.artifact,
        sourceHash: r.sourceHash,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        archivedAt: r.archivedAt,
        archivedBy: r.archivedBy,
      },
    });
  },
);

// ─── POST — Archive release ──────────────────────────────────────────────

export const POST = withRouteHandler<ArchiveActionInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_MANAGE,
    requireFeature: 'reusable_modules',
    bodySchema: ArchiveActionSchema,
  },
  async ({ user, params, tenantId, request }) => {
    await ensureDb();
    const projectId = params.id;
    const releaseId = params.releaseId;

    if (!releaseId) {
      return errorJson('Release ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const {
      ModuleRelease,
      ModuleEnvironmentPointer,
      DeploymentModuleSnapshot,
      ProjectModuleDependency,
      Deployment,
    } = await import('@agent-platform/database/models');

    // Verify release exists and belongs to this project+tenant
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId,
      moduleProjectId: projectId,
    }).lean();

    if (!release) {
      return errorJson('Release not found', 404, ErrorCode.NOT_FOUND);
    }

    // Check if already archived
    if (release.archivedAt) {
      return errorJson('Release is already archived', 400, ErrorCode.VALIDATION_ERROR);
    }

    // ── Two-layer archival guard ──────────────────────────────────────────

    // (a) Check active environment pointers
    const hasPointer = await ModuleEnvironmentPointer.exists({
      tenantId,
      moduleProjectId: projectId,
      moduleReleaseId: releaseId,
    });

    if (hasPointer) {
      return errorJson(
        'Release is in use by an environment pointer',
        409,
        ErrorCode.MODULE_HAS_CONSUMERS,
      );
    }

    // (b) Primary: Check live deployments that reference Phase 2+ snapshots.
    const deploymentSnapshots = await DeploymentModuleSnapshot.find({
      tenantId,
      moduleReleaseIds: releaseId,
    })
      .select('deploymentId')
      .lean();

    const deploymentIds = [
      ...new Set(
        deploymentSnapshots
          .map((snapshot: Record<string, unknown>) => snapshot.deploymentId as string | undefined)
          .filter((deploymentId: string | undefined): deploymentId is string =>
            Boolean(deploymentId),
          ),
      ),
    ];

    if (deploymentIds.length > 0) {
      const liveDeployment = await Deployment.exists({
        _id: { $in: deploymentIds },
        tenantId,
        status: { $in: ACTIVE_DEPLOYMENT_STATUSES },
      });

      if (liveDeployment) {
        return errorJson(
          'Release is in use by an active deployment',
          409,
          ErrorCode.MODULE_HAS_CONSUMERS,
        );
      }
    }

    // (c) Fallback: Check pre-Phase-2 dependency records. Environment selectors
    // are resolved live because resolvedReleaseId is a denormalized preview/import snapshot.
    const dependencyRefs = await ProjectModuleDependency.find({
      tenantId,
      moduleProjectId: projectId,
      resolvedReleaseId: releaseId,
    })
      .select('projectId selector resolvedReleaseId')
      .lean();

    let hasLiveDependencyRef = false;
    for (const dependencyRef of dependencyRefs) {
      const selector = (dependencyRef as Record<string, unknown>).selector as
        | { type?: string; value?: string }
        | undefined;

      if (selector?.type !== 'environment') {
        hasLiveDependencyRef = true;
        break;
      }

      const selectorResult = await resolveSelector(tenantId, projectId, {
        type: 'environment',
        value: selector.value ?? '',
      });
      if ('error' in selectorResult) {
        log.warn('Skipping stale environment-selector dependency during archive guard', {
          projectId,
          releaseId,
          selectorValue: selector.value,
          error: selectorResult.error,
        });
        continue;
      }

      if (selectorResult.releaseId === releaseId) {
        hasLiveDependencyRef = true;
        break;
      }
    }

    if (hasLiveDependencyRef) {
      return errorJson(
        'Release is in use by consumer projects',
        409,
        ErrorCode.MODULE_HAS_CONSUMERS,
      );
    }

    // ── Archive the release ──────────────────────────────────────────────

    const updated = await ModuleRelease.findOneAndUpdate(
      { _id: releaseId, tenantId, moduleProjectId: projectId },
      {
        $set: {
          archivedAt: new Date(),
          archivedBy: user.id,
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return errorJson('Failed to archive release', 500, ErrorCode.INTERNAL_ERROR);
    }

    // Emit audit event
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const userAgent = request.headers.get('user-agent') ?? undefined;

    logAuditEvent({
      userId: user.id,
      tenantId,
      action: AuditActions.MODULE_RELEASE_ARCHIVED,
      ip: ip ?? undefined,
      userAgent,
      metadata: {
        projectId,
        releaseId,
        version: release.version,
      },
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to log MODULE_RELEASE_ARCHIVED audit event', { error: message });
    });

    log.info('Module release archived', {
      projectId,
      releaseId,
      version: release.version,
    });

    return actionJson({
      message: 'Release archived',
      releaseId,
      version: release.version,
    });
  },
);
