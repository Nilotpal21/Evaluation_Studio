/**
 * GET  /api/projects/:id/module-dependencies  — List current dependencies
 * POST /api/projects/:id/module-dependencies  — Confirm import (persist dependency)
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { resolveSelector, validateConfigOverrides } from '@agent-platform/project-io';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { findMountedSymbolCollisions } from './collision-utils';

const log = createLogger('module-dependencies-route');

// ─── Constants ────────────────────────────────────────────────────────────

/** Alias pattern: lowercase start, alphanumeric + underscore, 2-25 chars total */
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{1,24}$/;

/** Reserved alias prefixes */
const RESERVED_PREFIXES = ['system_', 'internal_', 'test_'];

/** Maximum dependencies per consumer project */
const MAX_DEPENDENCIES = 5;

/** Module visibility filter shared with the catalog endpoints */
const VISIBLE_MODULE_FILTER = [
  { moduleVisibility: 'tenant' },
  { moduleVisibility: { $in: [null, undefined] } },
  { moduleVisibility: { $exists: false } },
];

// ─── Schemas ──────────────────────────────────────────────────────────────

const ConfirmImportSchema = z.object({
  moduleProjectId: z.string().min(1),
  alias: z.string().min(1).regex(ALIAS_PATTERN, 'Invalid alias format'),
  selector: z.object({
    type: z.enum(['version', 'environment']),
    value: z.string().min(1),
  }),
  resolvedReleaseId: z.string().min(1),
  configOverrides: z.record(z.string()).optional(),
});

type ConfirmImportInput = z.infer<typeof ConfirmImportSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────

function validateAlias(alias: string): string | null {
  if (!ALIAS_PATTERN.test(alias)) {
    return 'Alias must start with a lowercase letter, contain only a-z, 0-9, underscore, and be 2-25 characters';
  }
  if (alias.includes('__')) {
    return 'Alias must not contain consecutive underscores "__"';
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (alias.startsWith(prefix)) {
      return `Alias must not start with reserved prefix "${prefix}"`;
    }
  }
  return null;
}

// ─── GET — List current dependencies ──────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;
    const { ProjectModuleDependency, ModuleRelease } =
      await import('@agent-platform/database/models');

    const deps = (await ProjectModuleDependency.find({ tenantId, projectId })
      .sort({ createdAt: -1 })
      .lean()) as Array<Record<string, unknown>>;

    // Batch-query latest non-archived release per dependent module for update-available enrichment
    const depModuleIds = [...new Set(deps.map((d: Record<string, unknown>) => d.moduleProjectId))];

    let latestMap = new Map<string, { latestVersion: string; latestReleaseId: string }>();

    if (depModuleIds.length > 0) {
      const latestReleases = await ModuleRelease.aggregate([
        {
          $match: {
            tenantId,
            moduleProjectId: { $in: depModuleIds },
            archivedAt: { $in: [null, undefined] },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$moduleProjectId',
            latestVersion: { $first: '$version' },
            latestReleaseId: { $first: '$_id' },
          },
        },
      ]);

      latestMap = new Map(
        latestReleases.map(
          (r: { _id: string; latestVersion: string; latestReleaseId: { toString(): string } }) => [
            r._id,
            {
              latestVersion: r.latestVersion,
              latestReleaseId: r.latestReleaseId.toString(),
            },
          ],
        ),
      );
    }

    const resolvedDeps = await Promise.all(
      deps.map(async (d: Record<string, unknown>) => {
        let resolvedReleaseId = d.resolvedReleaseId;
        let resolvedVersion = d.resolvedVersion;
        let contractSnapshot = d.contractSnapshot;

        const selector = d.selector as
          | {
              type?: 'version' | 'environment';
              value?: string;
            }
          | undefined;

        if (
          selector?.type === 'environment' &&
          typeof d.moduleProjectId === 'string' &&
          typeof selector.value === 'string'
        ) {
          const selectorResult = await resolveSelector(tenantId, d.moduleProjectId, {
            type: 'environment',
            value: selector.value,
          });

          if (!('error' in selectorResult)) {
            const currentRelease = await ModuleRelease.findOne({
              _id: selectorResult.releaseId,
              tenantId,
              moduleProjectId: d.moduleProjectId,
              archivedAt: { $in: [null, undefined] },
            });

            if (currentRelease) {
              resolvedReleaseId = String(currentRelease._id);
              resolvedVersion = currentRelease.version;
              contractSnapshot = currentRelease.contract;
            }
          }
        }

        const latest = latestMap.get(d.moduleProjectId as string);
        const updateAvailable =
          selector?.type === 'version' && latest && latest.latestVersion !== resolvedVersion
            ? {
                latestVersion: latest.latestVersion,
                latestReleaseId: latest.latestReleaseId,
              }
            : undefined;

        return {
          id: d._id?.toString(),
          alias: d.alias,
          moduleProjectId: d.moduleProjectId,
          moduleProjectName: d.moduleProjectName ?? d.moduleProjectId,
          selector,
          resolvedReleaseId,
          resolvedVersion,
          configOverrides: d.configOverrides,
          contractSnapshot,
          updateAvailable,
          createdAt: d.createdAt,
          createdBy: d.createdBy,
        };
      }),
    );

    return NextResponse.json({
      success: true,
      data: resolvedDeps,
    });
  },
);

// ─── POST — Confirm import ────────────────────────────────────────────────

export const POST = withRouteHandler<ConfirmImportInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_IMPORT,
    requireFeature: 'reusable_modules',
    bodySchema: ConfirmImportSchema,
  },
  async ({ body, user, params, tenantId, project }) => {
    const importStartMs = Date.now();
    await ensureDb();
    const projectId = params.id;
    const consumerProjectKind = (project as Record<string, unknown> | undefined)?.kind;

    if (consumerProjectKind === 'module') {
      return errorJson(
        'Module projects cannot import module dependencies in Phase 1',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // 0. Self-import guard
    if (body.moduleProjectId === projectId) {
      return errorJson(
        'A project cannot import itself as a module dependency',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // 1. Validate alias
    const aliasError = validateAlias(body.alias);
    if (aliasError) {
      return errorJson(aliasError, 400, ErrorCode.VALIDATION_ERROR);
    }

    const { ProjectModuleDependency, ModuleRelease, Project, ProjectAgent, ProjectTool } =
      await import('@agent-platform/database/models');

    // 2. Check max dependencies
    // NOTE: Small TOCTOU window between this count check and the create below.
    // Two concurrent imports could both pass this check and exceed MAX_DEPENDENCIES.
    // Accepted risk: MAX_DEPENDENCIES is 5, exceeding by 1 is non-catastrophic,
    // and the unique alias index prevents true duplicates. The alias uniqueness
    // index (tenantId + projectId + alias) provides the hard DB-level guard.
    const existingCount = await ProjectModuleDependency.countDocuments({ tenantId, projectId });
    if (existingCount >= MAX_DEPENDENCIES) {
      return errorJson(
        `Maximum of ${MAX_DEPENDENCIES} module dependencies per project reached`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // 3. Check alias uniqueness within project
    const aliasConflict = await ProjectModuleDependency.findOne({
      tenantId,
      projectId,
      alias: body.alias,
    });
    if (aliasConflict) {
      return errorJson(
        `Alias "${body.alias}" is already in use in this project`,
        409,
        ErrorCode.NAME_CONFLICT,
      );
    }

    // 4. Verify module project exists and is visible (same tenant, kind=module)
    const moduleProject = await Project.findOne({
      _id: body.moduleProjectId,
      tenantId,
      kind: 'module',
      $or: VISIBLE_MODULE_FILTER,
    });
    if (!moduleProject) {
      return errorJson('Module project not found', 404, ErrorCode.NOT_FOUND);
    }

    // 5. Resolve selector again so imports track the current pointer target
    const selectorResult = await resolveSelector(tenantId, body.moduleProjectId, body.selector);
    if ('error' in selectorResult) {
      return errorJson(selectorResult.error, 404, ErrorCode.NOT_FOUND);
    }
    if (selectorResult.releaseId !== body.resolvedReleaseId) {
      return errorJson(
        'The selected module release changed after preview. Refresh and retry the import.',
        409,
        ErrorCode.POINTER_CONFLICT,
      );
    }

    // 6. Verify resolved release exists
    const release = await ModuleRelease.findOne({
      _id: selectorResult.releaseId,
      tenantId,
      moduleProjectId: body.moduleProjectId,
      archivedAt: null,
    });
    if (!release) {
      return errorJson('Resolved release not found or archived', 404, ErrorCode.NOT_FOUND);
    }

    // 7. Re-check mounted symbol collisions so confirm import cannot bypass preview validation
    const contractSnapshot = release.contract;
    const { collisions } = await findMountedSymbolCollisions({
      tenantId,
      projectId,
      alias: body.alias,
      contract: contractSnapshot,
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

    // 8. Validate configOverrides if provided
    if (body.configOverrides && Object.keys(body.configOverrides).length > 0) {
      if (!contractSnapshot) {
        return errorJson(
          'Release has no contract — cannot validate config overrides',
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
      const validation = validateConfigOverrides(
        body.configOverrides,
        contractSnapshot.requiredConfigKeys ?? [],
      );
      if (validation.blocking.length > 0) {
        return errorJson(validation.blocking, 400, ErrorCode.VALIDATION_ERROR);
      }
    }

    // 9. Create ProjectModuleDependency document
    let dep;
    try {
      dep = await ProjectModuleDependency.create({
        tenantId,
        projectId,
        moduleProjectId: body.moduleProjectId,
        moduleProjectName: (moduleProject as Record<string, unknown>).name as string,
        alias: body.alias,
        selector: body.selector,
        resolvedReleaseId: selectorResult.releaseId,
        resolvedVersion: release.version,
        configOverrides: body.configOverrides ?? {},
        contractSnapshot,
        createdBy: user.id,
      });
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as Record<string, unknown>).code === 11000
      ) {
        return errorJson(
          `Alias "${body.alias}" is already in use in this project`,
          409,
          ErrorCode.NAME_CONFLICT,
        );
      }
      throw err;
    }

    // 10. Increment project.moduleDependencyVersion
    await Project.findOneAndUpdate(
      { _id: projectId, tenantId },
      { $inc: { moduleDependencyVersion: 1 } },
    );

    // 11. Emit MODULE_IMPORTED audit event
    logAuditEvent({
      userId: user.id,
      tenantId,
      action: AuditActions.MODULE_IMPORTED,
      metadata: {
        projectId,
        moduleProjectId: body.moduleProjectId,
        alias: body.alias,
        resolvedReleaseId: selectorResult.releaseId,
        dependencyId: dep._id,
      },
    }).catch((err: unknown) => {
      log.error('Failed to log MODULE_IMPORTED audit event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Module dependency imported', {
      projectId,
      moduleProjectId: body.moduleProjectId,
      alias: body.alias,
      resolvedReleaseId: selectorResult.releaseId,
      durationMs: Date.now() - importStartMs,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          id: dep._id,
          alias: dep.alias,
          moduleProjectId: dep.moduleProjectId,
          moduleProjectName: dep.moduleProjectName,
          selector: dep.selector,
          resolvedReleaseId: dep.resolvedReleaseId,
          resolvedVersion: dep.resolvedVersion,
          configOverrides: dep.configOverrides,
          contractSnapshot: dep.contractSnapshot,
          createdAt: dep.createdAt,
          createdBy: dep.createdBy,
        },
      },
      { status: 201 },
    );
  },
);
