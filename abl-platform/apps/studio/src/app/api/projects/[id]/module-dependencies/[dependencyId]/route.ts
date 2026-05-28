/**
 * PATCH  /api/projects/:id/module-dependencies/:dependencyId — Upgrade dependency to a new release
 * DELETE /api/projects/:id/module-dependencies/:dependencyId — Remove a module dependency
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import {
  validateConfigOverrides,
  diffModuleContracts,
  EMPTY_MODULE_CONTRACT,
  type ModuleReleaseContract,
} from '@agent-platform/project-io';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { findMountedSymbolCollisions } from '../collision-utils';

const log = createLogger('module-dependencies-route');

// ─── Schemas ──────────────────────────────────────────────────────────────

const UpgradeSchema = z.object({
  targetReleaseId: z.string().min(1),
  configOverrides: z.record(z.string()).optional(),
});

type UpgradeInput = z.infer<typeof UpgradeSchema>;

// ─── PATCH — Upgrade dependency to a new release ──────────────────────────

export const PATCH = withRouteHandler<UpgradeInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_IMPORT,
    requireFeature: 'reusable_modules',
    bodySchema: UpgradeSchema,
  },
  async ({ body, user, params, tenantId }) => {
    const upgradeStartMs = Date.now();
    await ensureDb();
    const projectId = params.id;
    const dependencyId = params.dependencyId;

    if (!dependencyId) {
      return errorJson('Dependency ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { ProjectModuleDependency, ModuleRelease, Project, ProjectAgent, ProjectTool } =
      await import('@agent-platform/database/models');

    // 1. Load current dependency with tenantId + projectId scope
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId,
      projectId,
    });

    if (!dep) {
      return errorJson('Module dependency not found', 404, ErrorCode.NOT_FOUND);
    }

    const previousVersion = dep.resolvedVersion;

    // 2. Load target release — must belong to same module, not archived
    const targetRelease = await ModuleRelease.findOne({
      _id: body.targetReleaseId,
      tenantId,
      moduleProjectId: dep.moduleProjectId,
      archivedAt: { $in: [null, undefined] },
    });

    if (!targetRelease) {
      return errorJson('Target release not found or archived', 404, ErrorCode.NOT_FOUND);
    }

    const targetContract: ModuleReleaseContract = targetRelease.contract;
    const currentContract: ModuleReleaseContract | undefined = dep.contractSnapshot as
      | ModuleReleaseContract
      | undefined;

    // 3. Validate prerequisites from target release contract
    const prerequisites: { blocking: string[]; warnings: string[] } = {
      blocking: [],
      warnings: [],
    };

    if (targetContract.requiredSecrets?.length) {
      if (targetContract.requiredSecrets.length > 0) {
        prerequisites.warnings.push(
          `Module requires ${targetContract.requiredSecrets.length} runtime secret(s) that must be set separately`,
        );
      }
    }
    if (targetContract.requiredAuthProfiles?.length) {
      prerequisites.warnings.push(
        `Module requires ${targetContract.requiredAuthProfiles.length} auth profile(s)`,
      );
    }
    if (targetContract.requiredConnectors?.length) {
      prerequisites.warnings.push(
        `Module requires ${targetContract.requiredConnectors.length} connector(s)`,
      );
    }
    if (targetContract.requiredMcpServers?.length) {
      prerequisites.warnings.push(
        `Module requires ${targetContract.requiredMcpServers.length} MCP server(s)`,
      );
    }
    if (targetContract.requiredEnvVars?.length) {
      prerequisites.warnings.push(
        `Module requires ${targetContract.requiredEnvVars.length} environment variable(s)`,
      );
    }

    if (prerequisites.blocking.length > 0) {
      return errorJson(prerequisites.blocking, 400, ErrorCode.VALIDATION_ERROR);
    }

    // 4. Re-check mounted symbol collisions inside the write path.
    const { collisions } = await findMountedSymbolCollisions({
      tenantId,
      projectId,
      alias: dep.alias,
      contract: targetContract,
      ProjectAgent,
      ProjectTool,
    });
    if (collisions.length > 0) {
      return errorJson(
        collisions.map(
          (collision) =>
            `Mounted symbol "${collision.mountedName}" conflicts with existing ${collision.conflictsWith}`,
        ),
        409,
        ErrorCode.NAME_CONFLICT,
      );
    }

    // 5. Validate configOverrides against the target contract
    const mergedOverrides =
      body.configOverrides ?? (dep.configOverrides as Record<string, string>) ?? {};
    if (Object.keys(mergedOverrides).length > 0) {
      const validation = validateConfigOverrides(
        mergedOverrides,
        targetContract.requiredConfigKeys ?? [],
      );
      if (validation.blocking.length > 0) {
        return errorJson(validation.blocking, 400, ErrorCode.VALIDATION_ERROR);
      }
    }

    // 6. Compute contract diff for the response
    const diff = diffModuleContracts(currentContract ?? EMPTY_MODULE_CONTRACT, targetContract);
    const isConfigOnlyUpdate = body.targetReleaseId === dep.resolvedReleaseId;
    const nextSelector = isConfigOnlyUpdate
      ? dep.selector
      : { type: 'version' as const, value: targetRelease.version };

    // 7. Update the dependency in-place (atomic)
    const updated = await ProjectModuleDependency.findOneAndUpdate(
      { _id: dependencyId, tenantId, projectId },
      {
        $set: {
          selector: nextSelector,
          resolvedReleaseId: body.targetReleaseId,
          resolvedVersion: targetRelease.version,
          configOverrides: body.configOverrides ?? dep.configOverrides,
          contractSnapshot: targetContract,
        },
      },
      { new: true },
    );

    if (!updated) {
      return errorJson(
        'Failed to update dependency — it may have been removed',
        404,
        ErrorCode.NOT_FOUND,
      );
    }

    // 8. Increment project.moduleDependencyVersion
    await Project.findOneAndUpdate(
      { _id: projectId, tenantId },
      { $inc: { moduleDependencyVersion: 1 } },
    );

    // 9. Emit MODULE_UPGRADED audit event
    logAuditEvent({
      userId: user.id,
      tenantId,
      action: AuditActions.MODULE_UPGRADED,
      metadata: {
        projectId,
        dependencyId,
        alias: dep.alias,
        moduleProjectId: dep.moduleProjectId,
        previousVersion,
        targetVersion: targetRelease.version,
        targetReleaseId: body.targetReleaseId,
        hasBreakingChanges: diff.hasBreakingChanges,
      },
    }).catch((err: unknown) => {
      log.error('Failed to log MODULE_UPGRADED audit event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Module dependency upgraded', {
      projectId,
      dependencyId,
      moduleProjectId: dep.moduleProjectId,
      alias: dep.alias,
      previousVersion,
      targetVersion: targetRelease.version,
      hasBreakingChanges: diff.hasBreakingChanges,
      durationMs: Date.now() - upgradeStartMs,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: updated._id,
        alias: updated.alias,
        moduleProjectId: updated.moduleProjectId,
        moduleProjectName: updated.moduleProjectName,
        selector: nextSelector,
        resolvedReleaseId: updated.resolvedReleaseId,
        resolvedVersion: updated.resolvedVersion,
        previousVersion,
        diff: {
          hasBreakingChanges: diff.hasBreakingChanges,
          summary: diff.summary,
        },
      },
    });
  },
);

// ─── DELETE — Remove dependency ───────────────────────────────────────────

export const DELETE = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_IMPORT,
    requireFeature: 'reusable_modules',
  },
  async ({ user, params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;
    const dependencyId = params.dependencyId;

    if (!dependencyId) {
      return errorJson('Dependency ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { ProjectModuleDependency, Project } = await import('@agent-platform/database/models');

    // 1. Find dependency by ID with tenantId + projectId scope
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId,
      projectId,
    });

    if (!dep) {
      return errorJson('Module dependency not found', 404, ErrorCode.NOT_FOUND);
    }

    const depAlias = dep.alias;
    const depModuleProjectId = dep.moduleProjectId;

    // 2. Delete the dependency
    await ProjectModuleDependency.deleteOne({
      _id: dependencyId,
      tenantId,
      projectId,
    });

    // 3. Increment project.moduleDependencyVersion
    await Project.findOneAndUpdate(
      { _id: projectId, tenantId },
      { $inc: { moduleDependencyVersion: 1 } },
    );

    // 4. Emit MODULE_REMOVED audit event
    logAuditEvent({
      userId: user.id,
      tenantId,
      action: AuditActions.MODULE_REMOVED,
      metadata: {
        projectId,
        dependencyId,
        alias: depAlias,
        moduleProjectId: depModuleProjectId,
      },
    }).catch((err: unknown) => {
      log.error('Failed to log MODULE_REMOVED audit event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return actionJson({ message: 'Dependency removed' });
  },
);
