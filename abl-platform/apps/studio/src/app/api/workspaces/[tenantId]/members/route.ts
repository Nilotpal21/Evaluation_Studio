/**
 * GET /api/workspaces/:tenantId/members
 * List workspace members with user details.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findTenantMembers } from '@/repos/workspace-repo';

const log = createLogger('workspace-members');

// Path parameter schema
const paramsSchema = z.object({
  tenantId: z.string(),
});

// Response schema
const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string().optional(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
  status: z.enum(['active', 'deactivated', 'suspended', 'locked']).optional(),
  joinedAt: z.string(),
});

const membersResponseSchema = z.object({
  members: z.array(memberSchema),
});

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId } = await params;

  // Tenant isolation: users can only access their own tenant's members
  if (authResult.tenantId && tenantId !== authResult.tenantId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const workspaceAccess = await requireWorkspacePermission(
    tenantId,
    authResult,
    WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    {
      denyBehavior: 'forbidden',
    },
  );
  if (workspaceAccess instanceof NextResponse) {
    return workspaceAccess;
  }

  try {
    const memberships = await findTenantMembers(tenantId, { includeUser: true });

    const members = memberships
      .filter((m: any) => m.user !== null)
      .map((m: any) => ({
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        name: m.user.name || undefined,
        role: m.role,
        status: m.status || 'active',
        joinedAt: m.createdAt.toISOString(),
      }));

    return NextResponse.json({ members });
  } catch (error) {
    log.error('List workspace members error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List workspace members',
    description: 'Get all members of a workspace with their user details. Requires admin role.',
    tags: ['Workspaces'],
    params: paramsSchema,
    response: membersResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);
