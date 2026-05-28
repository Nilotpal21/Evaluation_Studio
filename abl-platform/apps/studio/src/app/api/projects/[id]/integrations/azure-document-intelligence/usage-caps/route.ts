/**
 * Studio BFF proxy → workflow-engine Azure DI usage-caps endpoint
 * (LLD §3 Phase 3 Task 3.14).
 *
 * PATCH /api/projects/:projectId/integrations/azure-document-intelligence/usage-caps
 *
 * Body: `{ usageSoftCap?: number | null, usageHardCap?: number | null }`
 *
 * Validates payload locally with Zod (strict) before proxying — Studio routes
 * have no AsyncLocalStorage tenant injection so the body cannot be re-read
 * after consumption (see apps/studio/CLAUDE.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { proxyToWorkflowEngine } from '@/lib/workflow-engine-proxy';
import { errorJson, ErrorCode } from '@/lib/api-response';

const BodySchema = z
  .object({
    usageSoftCap: z.number().int().min(0).nullable().optional(),
    usageHardCap: z.number().int().min(0).nullable().optional(),
  })
  .strict()
  .refine(
    (data) => data.usageSoftCap !== undefined || data.usageHardCap !== undefined,
    'At least one of usageSoftCap or usageHardCap must be provided',
  );

function buildPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/integrations/azure-document-intelligence/usage-caps`;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await params;
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  if (!user.tenantId) {
    return errorJson('Tenant context required', 400, ErrorCode.VALIDATION_ERROR);
  }
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorJson(
      parsed.error.issues[0]?.message ?? 'Invalid request body',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  return proxyToWorkflowEngine(request, buildPath(projectId), {
    method: 'PATCH',
    body: parsed.data,
    tenantId: user.tenantId,
  });
}
