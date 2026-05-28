/**
 * POST /api/pipelines/runs/:runId/cancel — Cancel a running pipeline
 *
 * Verifies tenant ownership before issuing the cancellation.
 * Returns 404 if the run doesn't exist or belongs to another tenant,
 * 409 if the run is already in a terminal state.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { cancelRun } from '@/lib/pipeline-service';

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { runId } = await params;
  if (!runId) {
    return errorJson('runId is required', 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    const result = await cancelRun(runId, user.tenantId);

    if (!result.success) {
      // Distinguish between not-found and already-terminal
      if (result.error === 'Run not found') {
        return errorJson('Pipeline run not found', 404, ErrorCode.NOT_FOUND);
      }
      // Already in terminal state is a conflict
      return errorJson(result.error || 'Failed to cancel run', 409, ErrorCode.VALIDATION_ERROR);
    }

    return NextResponse.json({
      success: true,
      message: `Pipeline run ${runId} cancellation initiated`,
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/pipelines/runs/:runId/cancel');
  }
}
