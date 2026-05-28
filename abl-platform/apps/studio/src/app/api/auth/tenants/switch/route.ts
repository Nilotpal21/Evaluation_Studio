/**
 * POST /api/auth/tenants/switch
 *
 * Switch the authenticated user's active tenant.
 * Returns a new access token scoped to the requested tenant.
 *
 * Body: { tenantId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getUserById, switchTenant } from '@/services/auth-service';

const switchTenantRequestSchema = z.object({
  tenantId: z.string(),
});

const workspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);
const log = createLogger('auth-switch-tenant-route');

const switchTenantResponseSchema = z.object({
  accessToken: z.string(),
  tenantId: z.string(),
  role: workspaceRoleSchema,
  orgId: z.string().nullable().optional(),
});

async function handler(request: NextRequest) {
  const authUser = await requireAuth(request);
  if (isAuthError(authUser)) return authUser;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = switchTenantRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'tenantId is required' }, { status: 400 });
  }

  try {
    const user = await getUserById(authUser.id);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 });
    }

    const result = await switchTenant(user, parsed.data.tenantId);
    return NextResponse.json({
      accessToken: result.accessToken,
      tenantId: result.tenantContext.tenantId,
      role: result.tenantContext.role,
      orgId: result.tenantContext.orgId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Not a member of this tenant') {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    log.error('Tenant switch error', {
      err: error instanceof Error ? error.message : String(error),
      userId: authUser.id,
      tenantId: parsed.data.tenantId,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Switch active tenant',
    description:
      "Switch the authenticated user's active tenant. Returns a new access token scoped to the requested tenant.",
    body: switchTenantRequestSchema,
    response: switchTenantResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
