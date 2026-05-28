/**
 * Studio BFF proxy → workflow-engine Docling toggle endpoints.
 *
 * - `POST /api/projects/:projectId/integrations/docling/enable`
 * - `POST /api/projects/:projectId/integrations/docling/disable`
 * - `GET  /api/projects/:projectId/integrations/docling/quota`
 *
 * The proxy enforces Studio's auth chain (`requireAuth` + project access) and
 * forwards to the workflow-engine's authenticated `projectRouter`. Tenant
 * scoping is explicit — Studio route handlers don't have AsyncLocalStorage
 * tenant injection (see `apps/studio/CLAUDE.md`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { proxyToWorkflowEngine } from '@/lib/workflow-engine-proxy';
import { errorJson, ErrorCode } from '@/lib/api-response';

const ALLOWED_ACTIONS = new Set(['enable', 'disable', 'quota']);

function buildPath(projectId: string, action: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/integrations/docling/${encodeURIComponent(action)}`;
}

interface ResolvedContext {
  tenantId: string;
  projectId: string;
  action: string;
}

async function resolveContext(
  request: NextRequest,
  params: { id: string; action: string },
): Promise<ResolvedContext | NextResponse> {
  if (!ALLOWED_ACTIONS.has(params.action)) {
    return errorJson('Unsupported docling action', 400, ErrorCode.VALIDATION_ERROR);
  }
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  if (!user.tenantId) {
    return errorJson('Tenant context required', 400, ErrorCode.VALIDATION_ERROR);
  }
  const access = await requireProjectAccess(params.id, user);
  if (isAccessError(access)) return access;
  return { tenantId: user.tenantId, projectId: params.id, action: params.action };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<NextResponse> {
  const resolved = await resolveContext(request, await params);
  if (resolved instanceof NextResponse) return resolved;
  if (resolved.action === 'quota') {
    return errorJson('Use GET for quota', 405, ErrorCode.VALIDATION_ERROR);
  }

  return proxyToWorkflowEngine(request, buildPath(resolved.projectId, resolved.action), {
    method: 'POST',
    body: {},
    tenantId: resolved.tenantId,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<NextResponse> {
  const resolved = await resolveContext(request, await params);
  if (resolved instanceof NextResponse) return resolved;
  if (resolved.action !== 'quota') {
    return errorJson('GET only supported for quota', 405, ErrorCode.VALIDATION_ERROR);
  }

  return proxyToWorkflowEngine(request, buildPath(resolved.projectId, resolved.action), {
    method: 'GET',
    tenantId: resolved.tenantId,
  });
}
