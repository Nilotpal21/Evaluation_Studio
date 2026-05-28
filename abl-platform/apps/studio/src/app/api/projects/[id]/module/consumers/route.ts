/**
 * GET /api/projects/:id/module/consumers
 *
 * Lists consumer projects that depend on this module project.
 * Enriches results with project names and active deployment status.
 * Supports cursor-based pagination.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { resolveSelector } from '@agent-platform/project-io';

const log = createLogger('module-consumers-route');

const ACTIVE_DEPLOYMENT_STATUSES = ['active', 'draining'];

// ─── Types ───────────────────────────────────────────────────────────────

interface ModuleConsumer {
  dependencyId: string;
  projectId: string;
  projectName: string;
  alias: string;
  resolvedVersion: string;
  resolvedReleaseId: string;
  selectorType: string;
  selectorValue: string;
  hasActiveDeployment: boolean;
  createdAt: Date | string;
}

// ─── GET — List consumers ────────────────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_MANAGE,
    requireFeature: 'reusable_modules',
  },
  async ({ request, params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;

    const { ProjectModuleDependency, Project, DeploymentModuleSnapshot, Deployment } =
      await import('@agent-platform/database/models');

    // Parse pagination from query params
    const url = new URL(request.url);
    const parsedLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const limit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit));
    const cursor = url.searchParams.get('cursor');

    // Build filter: find dependencies where THIS project is the module being consumed
    const filter: Record<string, unknown> = {
      tenantId,
      moduleProjectId: projectId,
    };

    if (cursor) {
      if (cursor.length > 100) {
        return errorJson('Invalid cursor format', 400, ErrorCode.VALIDATION_ERROR);
      }
      filter._id = { $lt: cursor };
    }

    // Query dependencies with one extra for hasMore detection
    const dependencies = await ProjectModuleDependency.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = dependencies.length > limit;
    const results = hasMore ? dependencies.slice(0, limit) : dependencies;
    const nextCursor =
      hasMore && results.length > 0
        ? String((results[results.length - 1] as Record<string, unknown>)._id)
        : null;

    const liveResults = await Promise.all(
      results.map(async (dependency: Record<string, unknown>) => {
        const selector = dependency.selector as { type?: string; value?: string } | undefined;
        let resolvedReleaseId = dependency.resolvedReleaseId as string;
        let resolvedVersion = dependency.resolvedVersion as string;

        if (selector?.type === 'environment' && selector.value) {
          const selectorResult = await resolveSelector(tenantId, projectId, {
            type: 'environment',
            value: selector.value,
          });
          if (selectorResult && !('error' in selectorResult)) {
            resolvedReleaseId = selectorResult.releaseId;
            resolvedVersion = selectorResult.version;
          }
        }

        return {
          dependency,
          resolvedReleaseId,
          resolvedVersion,
        };
      }),
    );

    // Collect unique consumer project IDs for name enrichment
    const consumerProjectIds = [
      ...new Set(liveResults.map(({ dependency }) => dependency.projectId as string)),
    ];

    // Collect unique resolved release IDs for deployment checks
    const releaseIds = [...new Set(liveResults.map((d) => d.resolvedReleaseId))];

    // Enrich with project names
    const projectNameMap = new Map<string, string>();
    if (consumerProjectIds.length > 0) {
      const projects = await Project.find({
        _id: { $in: consumerProjectIds },
        tenantId,
      })
        .select('_id name')
        .lean();

      for (const p of projects) {
        const proj = p as Record<string, unknown>;
        projectNameMap.set(String(proj._id), proj.name as string);
      }
    }

    // Check for active deployments referencing these releases
    const activeDeploymentReleaseIds = new Set<string>();
    if (releaseIds.length > 0) {
      const snapshots = await DeploymentModuleSnapshot.find({
        tenantId,
        moduleReleaseIds: { $in: releaseIds },
      })
        .select('deploymentId moduleReleaseIds')
        .lean();

      const snapshotDeploymentIds = [
        ...new Set(
          snapshots
            .map((snap: Record<string, unknown>) => snap.deploymentId as string | undefined)
            .filter((deploymentId: string | undefined): deploymentId is string =>
              Boolean(deploymentId),
            ),
        ),
      ];
      const liveDeploymentIds = new Set<string>();
      if (snapshotDeploymentIds.length > 0) {
        const deployments = await Deployment.find({
          _id: { $in: snapshotDeploymentIds },
          tenantId,
          status: { $in: ACTIVE_DEPLOYMENT_STATUSES },
        })
          .select('_id')
          .lean();

        for (const deployment of deployments) {
          liveDeploymentIds.add(String((deployment as Record<string, unknown>)._id));
        }
      }

      for (const snap of snapshots) {
        const s = snap as Record<string, unknown>;
        const deploymentId = s.deploymentId as string | undefined;
        if (!deploymentId || !liveDeploymentIds.has(deploymentId)) {
          continue;
        }

        const ids = s.moduleReleaseIds as string[];
        for (const rid of ids) {
          activeDeploymentReleaseIds.add(rid);
        }
      }
    }

    // Build response
    const consumers: ModuleConsumer[] = liveResults.map((item) => {
      const d = item.dependency;
      const depProjectId = d.projectId as string;
      const selector = d.selector as { type: string; value: string };

      return {
        dependencyId: String(d._id),
        projectId: depProjectId,
        projectName: projectNameMap.get(depProjectId) ?? 'Unknown',
        alias: d.alias as string,
        resolvedVersion: item.resolvedVersion,
        resolvedReleaseId: item.resolvedReleaseId,
        selectorType: selector.type,
        selectorValue: selector.value,
        hasActiveDeployment: activeDeploymentReleaseIds.has(item.resolvedReleaseId),
        createdAt: d.createdAt,
      };
    });

    // Summary counts — totalConsumers is the global count, not just this page
    const totalConsumers = await ProjectModuleDependency.countDocuments({
      tenantId,
      moduleProjectId: projectId,
    });
    const activeDeployments = consumers.filter((c) => c.hasActiveDeployment).length;

    log.info('Listed module consumers', {
      projectId,
      consumerCount: totalConsumers,
      activeDeployments,
    });

    return NextResponse.json({
      success: true,
      data: consumers,
      pagination: { nextCursor, hasMore },
      summary: { totalConsumers, activeDeployments },
    });
  },
);
