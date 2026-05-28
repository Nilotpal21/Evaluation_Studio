/**
 * GET /api/pipelines/:pipelineId/runs — List runs for a pipeline
 *
 * Returns pipeline run records filtered by pipelineId and tenantId,
 * sorted by startedAt descending. Supports limit/offset pagination.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { PipelineRunRecordModel } from '@agent-platform/pipeline-engine/schemas';

type RouteParams = { params: Promise<{ pipelineId: string }> };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { pipelineId } = await params;
  if (!pipelineId) {
    return errorJson('pipelineId is required', 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10), 1),
      MAX_LIMIT,
    );
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);
    const status = searchParams.get('status') || undefined;

    // Build tenant-isolated filter
    const filter: Record<string, unknown> = {
      tenantId: user.tenantId,
      pipelineId,
    };
    if (status) {
      filter.status = status;
    }

    const [runs, total] = await Promise.all([
      PipelineRunRecordModel.find(filter).sort({ startedAt: -1 }).skip(offset).limit(limit).lean(),
      PipelineRunRecordModel.countDocuments(filter),
    ]);

    return NextResponse.json({
      success: true,
      data: runs,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + runs.length < total,
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/pipelines/:pipelineId/runs');
  }
}
