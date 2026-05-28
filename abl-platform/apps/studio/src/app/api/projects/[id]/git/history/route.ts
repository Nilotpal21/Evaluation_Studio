/**
 * GET /api/projects/:id/git/history — Sync history
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureConnected, GitIntegration, GitSyncHistory } from '@agent-platform/database/models';

const log = createLogger('git-history-route');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const VALID_DIRECTIONS = new Set(['push', 'pull']);
const VALID_STATUSES = new Set(['success', 'failed', 'conflict']);

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_GIT,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const { tenantId, request } = ctx;
    const projectId = ctx.params.id;

    const { searchParams } = new URL(request.url);

    const limit = parseLimit(searchParams.get('limit'));
    const direction = searchParams.get('direction');
    const status = searchParams.get('status');
    const branch = searchParams.get('branch');

    if (direction && !VALID_DIRECTIONS.has(direction)) {
      return NextResponse.json({ error: 'Unsupported direction filter' }, { status: 400 });
    }

    if (status && !VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: 'Unsupported status filter' }, { status: 400 });
    }

    try {
      await ensureConnected();

      const integration = await GitIntegration.findOne({ projectId, tenantId }).lean();
      if (!integration) {
        return NextResponse.json({ error: 'No git integration configured' }, { status: 404 });
      }

      const filter: Record<string, unknown> = { projectId, tenantId };
      if (direction) {
        filter.direction = direction;
      }
      if (branch) {
        filter.branch = branch;
      }
      if (status) {
        filter.status = status;
      }

      const history = await GitSyncHistory.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean();

      return NextResponse.json({ history, total: history.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get sync history', { projectId, error: message });
      return NextResponse.json({ error: 'Failed to get sync history' }, { status: 500 });
    }
  },
);
