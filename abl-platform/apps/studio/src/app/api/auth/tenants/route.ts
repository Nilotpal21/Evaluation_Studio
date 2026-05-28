/**
 * GET /api/auth/tenants
 *
 * List all tenants the authenticated user belongs to.
 * Requires a valid JWT access token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getUserTenants } from '@/services/auth-service';

const workspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);
const log = createLogger('auth-tenants-route');

const tenantsResponseSchema = z.object({
  tenants: z.array(
    z.object({
      tenantId: z.string(),
      tenantName: z.string(),
      role: workspaceRoleSchema,
      orgId: z.string().optional(),
    }),
  ),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const tenants = await getUserTenants(user.id);
    return NextResponse.json({ tenants });
  } catch (error) {
    log.error('Error listing tenants', {
      err: error instanceof Error ? error.message : String(error),
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List user tenants',
    description: 'List all tenants (workspaces) the authenticated user belongs to.',
    response: tenantsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
