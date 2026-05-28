/**
 * GET /api/projects/:id/module-catalog — List module projects visible to this tenant
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';

// ─── GET — List module catalog ────────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ request, params, tenantId }) => {
    await ensureDb();

    const { Project, ModuleRelease, ModuleEnvironmentPointer } =
      await import('@agent-platform/database/models');

    const projectId = params.id;
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    // Find module projects visible to this tenant with visibility filtering:
    // - 'tenant' modules are visible to all users in the same tenant
    // - 'private' modules are only visible to the owning project (not shown in catalog)
    // - modules with no visibility set (null/undefined) are treated as visible (backward compat)
    const filter: Record<string, unknown> = {
      kind: 'module',
      tenantId,
      _id: { $ne: projectId },
      $or: [
        { moduleVisibility: 'tenant' },
        { moduleVisibility: { $in: [null, undefined] } },
        { moduleVisibility: { $exists: false } },
      ],
    };
    if (!includeArchived) {
      filter.archivedAt = { $in: [null, undefined] };
    }

    const modules = await Project.find(filter)
      .select('_id name description moduleVisibility createdAt')
      .sort({ name: 1 })
      .limit(100)
      .lean();

    const moduleIds = modules
      .map((mod: Record<string, unknown>) =>
        mod._id !== null && mod._id !== undefined ? String(mod._id) : '',
      )
      .filter(Boolean);

    // Batch: latest non-archived release per module (aggregation)
    const latestReleases = await ModuleRelease.aggregate([
      {
        $match: {
          tenantId,
          moduleProjectId: { $in: moduleIds },
          archivedAt: { $in: [null, undefined] },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$moduleProjectId',
          version: { $first: '$version' },
          createdAt: { $first: '$createdAt' },
          contract: { $first: '$contract' },
        },
      },
    ]);

    const releaseByModuleId = new Map<string, Record<string, unknown>>();
    for (const r of latestReleases) {
      releaseByModuleId.set(String(r._id), r);
    }

    // Batch: all environment pointers for these modules
    const allPointers = await ModuleEnvironmentPointer.find({
      tenantId,
      moduleProjectId: { $in: moduleIds },
    })
      .select('moduleProjectId environment moduleReleaseId revision')
      .lean();

    const pointersByModuleId = new Map<string, Array<Record<string, unknown>>>();
    for (const p of allPointers as Array<Record<string, unknown>>) {
      const key = String(p.moduleProjectId);
      let list = pointersByModuleId.get(key);
      if (!list) {
        list = [];
        pointersByModuleId.set(key, list);
      }
      list.push(p);
    }

    // Merge results in memory
    const enriched = modules.map((mod: Record<string, unknown>) => {
      const modId = mod._id !== null && mod._id !== undefined ? String(mod._id) : '';
      const release = releaseByModuleId.get(modId);
      const contract = release?.contract as Record<string, unknown> | null | undefined;
      const providedAgents = contract?.providedAgents;
      const providedTools = contract?.providedTools;
      const pointers = pointersByModuleId.get(modId) ?? [];

      return {
        moduleProjectId: modId,
        name: mod.name,
        description: mod.description,
        moduleVisibility: mod.moduleVisibility,
        latestVersion: release?.version ?? null,
        latestReleaseDate: release?.createdAt ?? null,
        providedAgentCount: Array.isArray(providedAgents) ? providedAgents.length : 0,
        providedToolCount: Array.isArray(providedTools) ? providedTools.length : 0,
        environments: pointers.map((p) => ({
          environment: p.environment,
          moduleReleaseId:
            p.moduleReleaseId !== null && p.moduleReleaseId !== undefined
              ? String(p.moduleReleaseId)
              : undefined,
          revision: p.revision,
        })),
      };
    });

    return NextResponse.json({
      success: true,
      data: enriched,
    });
  },
);
