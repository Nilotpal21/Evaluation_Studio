/**
 * GET /api/projects/:id/git/status — Compare local vs remote
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { listProjectLocalizationAssets } from '@/lib/localization-assets';
import { buildLayerPreview, resolveLayers } from '@agent-platform/project-io/export';
import {
  ensureConnected,
  GitIntegration,
  ProjectAgent,
  type IProjectAgent,
} from '@agent-platform/database/models';

const log = createLogger('git-status-route');

const MAX_AGENTS_FOR_STATUS = 1000;

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_GIT,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;

    try {
      await ensureConnected();

      const integration = await GitIntegration.findOne({ projectId, tenantId }).lean();
      if (!integration) {
        return NextResponse.json({ error: 'No git integration configured' }, { status: 404 });
      }

      const agents = await ProjectAgent.find({ projectId, tenantId })
        .limit(MAX_AGENTS_FOR_STATUS)
        .lean();
      const [localeAssets, localLayers] = await Promise.all([
        listProjectLocalizationAssets(projectId, tenantId),
        buildLayerPreview({ projectId, tenantId }),
      ]);

      const localAgents = agents.map((a: IProjectAgent) => ({
        name: a.name,
        sourceHash: a.sourceHash ?? null,
        lastEditedAt: a.lastEditedAt ?? a.updatedAt ?? null,
      }));

      return NextResponse.json({
        integration: {
          provider: integration.provider,
          repositoryUrl: integration.repositoryUrl,
          defaultBranch: integration.defaultBranch,
          lastSyncAt: integration.lastSyncAt,
          lastSyncCommit: integration.lastSyncCommit,
          lastSyncStatus: integration.lastSyncStatus,
        },
        localLayers,
        defaultLayers: resolveLayers(),
        localAgents,
        localLocaleFiles: localeAssets.map((asset) => ({
          id: asset.id,
          relativePath: asset.relativePath,
          filePath: asset.filePath,
          localeCode: asset.localeCode,
          scope: asset.scope,
          updatedAt: asset.updatedAt,
        })),
        message:
          'Status shows canonical git-managed local state. Use your git provider to compare with remote.',
      });
    } catch (error) {
      log.error('Git status failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ error: 'Failed to get git status' }, { status: 500 });
    }
  },
);
