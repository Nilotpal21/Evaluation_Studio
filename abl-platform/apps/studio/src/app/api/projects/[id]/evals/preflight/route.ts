/**
 * POST /api/projects/:id/evals/preflight - Run eval preflight checks
 *
 * Calls the EvalPreflight Restate service to validate all integration
 * points before starting an eval run.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRestateIngressUrl } from '@/lib/restate-url';
import { sanitizeEvalPreflightResult } from '@/lib/eval-preflight-sanitizer';

const log = createLogger('api:evals:preflight');
const PREFLIGHT_TIMEOUT_MS = 30_000;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${getRestateIngressUrl()}/EvalPreflight/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: user.tenantId,
          projectId,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.warn('Preflight service returned error', {
        projectId,
        status: response.status,
        error: errorText.substring(0, 500),
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'PREFLIGHT_SERVICE_ERROR',
            message: 'Preflight service returned an error. Please try again or contact support.',
          },
        },
        { status: 502 },
      );
    }

    const result = sanitizeEvalPreflightResult(await response.json());
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return handleApiError(error, 'EvalPreflight.check');
  }
}
