/**
 * GET /api/projects/:id/module-catalog/:moduleProjectId — Module detail with releases and pointers
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';

// ─── GET — Module catalog detail ──────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ params, tenantId }) => {
    await ensureDb();

    const { Project, ModuleRelease, ModuleEnvironmentPointer } =
      await import('@agent-platform/database/models');

    const projectId = params.id;
    const moduleProjectId = params.moduleProjectId;
    if (!moduleProjectId) {
      return errorJson('Module project ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Self-lookup guard: a project cannot view itself in the catalog (consistent with catalog list)
    if (moduleProjectId === projectId) {
      return errorJson('Module not found', 404, ErrorCode.NOT_FOUND);
    }

    // Verify module exists and is visible to this tenant (same visibility filter as catalog list)
    const moduleProject = await Project.findOne({
      _id: moduleProjectId,
      tenantId,
      kind: 'module',
      $or: [
        { moduleVisibility: 'tenant' },
        { moduleVisibility: { $in: [null, undefined] } },
        { moduleVisibility: { $exists: false } },
      ],
    }).lean();

    if (!moduleProject) {
      return errorJson('Module not found', 404, ErrorCode.NOT_FOUND);
    }

    const mod = moduleProject as Record<string, unknown>;

    // Get all non-archived releases (newest first)
    const releases = await ModuleRelease.find({
      tenantId,
      moduleProjectId,
      archivedAt: { $in: [null, undefined] },
    })
      .sort({ createdAt: -1 })
      .select('_id version releaseNotes contract sourceHash createdAt createdBy')
      .limit(50)
      .lean();

    // Get environment pointers
    const pointers = await ModuleEnvironmentPointer.find({
      tenantId,
      moduleProjectId,
    }).lean();

    return NextResponse.json({
      success: true,
      data: {
        moduleProjectId,
        name: mod.name,
        description: mod.description,
        moduleVisibility: mod.moduleVisibility,
        releases: (releases as Array<Record<string, unknown>>).map((r) => ({
          id: r._id !== null && r._id !== undefined ? String(r._id) : undefined,
          version: r.version,
          releaseNotes: r.releaseNotes,
          contract: r.contract,
          sourceHash: r.sourceHash,
          createdAt: r.createdAt,
          createdBy: r.createdBy,
        })),
        environments: (pointers as Array<Record<string, unknown>>).map((p) => ({
          environment: p.environment,
          moduleReleaseId:
            p.moduleReleaseId !== null && p.moduleReleaseId !== undefined
              ? String(p.moduleReleaseId)
              : undefined,
          revision: p.revision,
        })),
      },
    });
  },
);
