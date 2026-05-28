/**
 * POST /api/pipelines/runs/:runId/redrive
 *
 * Re-fires a pipeline run using its stored triggerInput, without requiring
 * the user to reconstruct the payload manually. Useful after fixing a pipeline
 * config and wanting to replay the exact same event that previously failed.
 *
 * Creates a NEW run — the original run is untouched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { handleApiError, errorJson, ErrorCode } from '@/lib/api-response';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { buildRateLimitKey, rateLimiter, RateLimitScope } from '@/lib/rate-limiter';
import { getRestateIngressUrl } from '@/lib/restate-url';
import { PipelineRunRecordModel } from '@agent-platform/pipeline-engine/schemas';

type RouteParams = { params: Promise<{ runId: string }> };
const REDRIVE_RATE_LIMIT = { limit: 10, windowMs: 60_000, scope: RateLimitScope.USER } as const;

function redriveRateLimitResponse(request: NextRequest, user: { tenantId: string; id: string }) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const key = buildRateLimitKey(
    REDRIVE_RATE_LIMIT.scope,
    user.tenantId,
    user.id,
    ip,
    request.nextUrl.pathname,
  );
  const result = rateLimiter.check(key, REDRIVE_RATE_LIMIT);
  if (result.allowed) return null;

  const retryAfterSec = Math.ceil(result.resetMs / 1000);
  return NextResponse.json(
    {
      success: false,
      errors: [{ msg: 'Too many requests', code: ErrorCode.RATE_LIMITED }],
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(retryAfterSec),
      },
    },
  );
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const rateLimited = redriveRateLimitResponse(request, user);
  if (rateLimited) return rateLimited;

  const { runId } = await params;
  if (!runId) {
    return errorJson('runId is required', 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    // Load the original run — tenant-scoped for isolation
    const run = await PipelineRunRecordModel.findOne({
      runId,
      tenantId: user.tenantId,
    }).lean();

    if (!run) {
      return errorJson('Pipeline run not found', 404, ErrorCode.NOT_FOUND);
    }

    const access = await requireProjectAccess(String(run.projectId), user);
    if (isAccessError(access)) return access;

    if (!run.triggerInput || Object.keys(run.triggerInput).length === 0) {
      return errorJson(
        'This run has no stored triggerInput — it cannot be re-driven. Only runs created after ABLP-564 Phase 1 persist triggerInput.',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const triggerId = run.trigger?.triggerId;
    if (!triggerId) {
      return errorJson(
        'Run has no triggerId recorded — cannot re-drive.',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Call Restate directly (same path as the /test endpoint)
    const triggerResponse = await fetch(`${getRestateIngressUrl()}/PipelineTrigger/triggerManual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: run.pipelineId,
        tenantId: user.tenantId,
        projectId: run.projectId,
        triggeredBy: `redrive by ${formatUserLabel(user)}`,
        triggerId,
        data: run.triggerInput,
      }),
    });

    if (!triggerResponse.ok) {
      let errText = '';
      try {
        errText = await triggerResponse.text();
      } catch (textErr) {
        const msg = textErr instanceof Error ? textErr.message : String(textErr);
        return errorJson(`Failed to re-drive run: ${msg}`, 502, ErrorCode.INTERNAL_ERROR);
      }
      if (errText.includes('PIPELINE_NOT_FOUND') || errText.includes('TRIGGER_NOT_FOUND')) {
        return errorJson('Pipeline or trigger not found', 404, ErrorCode.NOT_FOUND);
      }
      return errorJson('Failed to re-drive run', 502, ErrorCode.INTERNAL_ERROR);
    }

    let payload: { runId?: string } | null;
    try {
      payload = (await triggerResponse.json()) as { runId?: string };
    } catch {
      return errorJson(
        'Failed to parse response from pipeline trigger',
        502,
        ErrorCode.INTERNAL_ERROR,
      );
    }
    if (!payload?.runId) {
      return errorJson('Failed to start re-drive run', 502, ErrorCode.INTERNAL_ERROR);
    }

    return NextResponse.json({ success: true, runId: payload.runId });
  } catch (error) {
    return handleApiError(error, 'Redrive POST');
  }
}
