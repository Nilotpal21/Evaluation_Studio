/**
 * POST /api/pipelines/runs/:runId/events/:eventName - Resume a paused pipeline
 *
 * Used for wait-for-event nodes: the caller provides the awakeableId
 * (from the pipeline run status) and an optional payload to unblock
 * the suspended workflow step.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { getRestateIngressUrl } from '@/lib/restate-url';

type RouteParams = { params: Promise<{ runId: string; eventName: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { runId, eventName } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const awakeableId = body.awakeableId;
  if (!awakeableId || typeof awakeableId !== 'string') {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'MISSING_AWAKEABLE_ID',
          message: 'awakeableId is required in the request body',
        },
      },
      { status: 400 },
    );
  }

  try {
    const restateUrl = getRestateIngressUrl();
    const res = await fetch(
      `${restateUrl}/restate/awakeables/${encodeURIComponent(awakeableId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body.payload ?? {}),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText);
    }

    return NextResponse.json({
      success: true,
      data: { runId, eventName, resumed: true },
    });
  } catch (error) {
    return handleApiError(error, `POST /api/pipelines/runs/${runId}/events/${eventName}`);
  }
}
