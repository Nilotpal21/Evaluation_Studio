/**
 * POST /api/projects/:id/export/async -- Queue an async export
 * GET  /api/projects/:id/export/async?jobId=xxx -- Poll job status
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ProjectAgent } from '@agent-platform/database/models';
import {
  enqueueExportJob,
  getExportJobStatus,
  shouldUseAsyncExport,
  type ExportJobData,
} from '@/services/export-queue';
import { ensureExportWorker } from '@/services/export-worker';
import type { ExportDslFormat } from '@agent-platform/project-io';

const log = createLogger('export-async-route');

function parseDslFormat(raw: string | undefined): ExportDslFormat {
  return raw === 'yaml' ? 'yaml' : 'source';
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_EXPORT,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    let body: {
      format?: string;
      layers?: string[];
      dslFormat?: string;
      includeDeployments?: boolean;
      forceAsync?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // Check agent count for auto-async decision
    const agentCount = await ProjectAgent.countDocuments({ projectId, tenantId });

    if (!shouldUseAsyncExport(agentCount, body.forceAsync)) {
      return NextResponse.json(
        {
          async: false,
          message: `Project has ${agentCount} agents -- use the sync export endpoint instead`,
        },
        { status: 200 },
      );
    }

    // Ensure worker is running
    await ensureExportWorker();

    const jobData: ExportJobData = {
      projectId,
      tenantId,
      userId: user.id,
      format: (body.format ?? 'zip') as 'folder' | 'zip' | 'tar.gz',
      layers: body.layers,
      dslFormat: parseDslFormat(body.dslFormat),
      includeDeployments: body.includeDeployments ?? false,
    };

    const jobId = await enqueueExportJob(jobData);

    log.info('Async export job queued', { projectId, jobId, agentCount });

    return NextResponse.json({
      async: true,
      jobId,
      statusUrl: `/api/projects/${projectId}/export/async?jobId=${jobId}`,
    });
  },
);

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_EXPORT,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const { tenantId, request } = ctx;
    const projectId = ctx.params.id;
    const jobId = request.nextUrl.searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'jobId query parameter is required' }, { status: 400 });
    }

    const status = await getExportJobStatus(jobId);
    if (!status) {
      return NextResponse.json({ error: 'Export job not found or expired' }, { status: 404 });
    }

    // Verify ownership — return 404 (not 403) to avoid leaking existence
    if (status.tenantId !== tenantId || status.projectId !== projectId) {
      return NextResponse.json({ error: 'Export job not found or expired' }, { status: 404 });
    }

    return NextResponse.json(status);
  },
);
