/**
 * POST /api/projects/:id/pipelines/:pipelineId/deactivate
 *
 * Thin proxy to the runtime deactivate endpoint.
 * projectId is in the URL path — consistent with all other project-scoped Studio routes.
 *
 * Studio invalidates the Redis-backed definition cache after a successful
 * response so the pipeline-engine stops matching this pipeline on Kafka events.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; pipelineId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, pipelineId } = await params;

  try {
    const runtimeUrl = getRuntimeUrl();
    const res = await fetch(
      `${runtimeUrl}/api/projects/${projectId}/pipelines/${pipelineId}/deactivate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.get('Authorization') ?? '',
          'x-tenant-id': user.tenantId,
        },
      },
    );

    const body = await res.json();

    if (res.ok) {
      const { invalidateDefinitionCache } = await import('@/lib/invalidate-definition-cache');
      await invalidateDefinitionCache();
    }

    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return handleApiError(error, 'Pipeline Deactivate');
  }
}
