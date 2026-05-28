/**
 * GET /api/pipelines/runs/:runId — Get detailed run status
 *
 * Uses the hybrid query approach from pipeline-service:
 * checks MongoDB first for persisted records, falls back to
 * Restate for live workflow status.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { getRunStatus } from '@/lib/pipeline-service';

type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { runId } = await params;
  if (!runId) {
    return errorJson('runId is required', 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    const run = await getRunStatus(runId, user.tenantId);
    if (!run) {
      return errorJson('Pipeline run not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({
      success: true,
      run,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/pipelines/runs/:runId');
  }
}
