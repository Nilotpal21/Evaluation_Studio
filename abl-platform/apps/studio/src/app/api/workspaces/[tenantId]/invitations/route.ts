/**
 * GET/POST /api/workspaces/:tenantId/invitations
 * List and create workspace invitations
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findInvitations } from '@/repos/workspace-repo';
import { createInvitation } from '@/services/invitation-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

// Path parameter schema
const paramsSchema = z.object({
  tenantId: z.string(),
});

// Invitation response schema
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
  status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const invitationsResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});

// Create invitation request schema
const createInvitationRequestSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']).optional(),
});

const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
});

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId } = await params;

  // Tenant isolation
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
    const invitations = await findInvitations(tenantId);
    const sanitized = invitations.map((inv: any) => ({
      id: inv._id || inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    }));
    return NextResponse.json({ invitations: sanitized });
  } catch (error) {
    log.error('List invitations error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId } = await params;

  // Tenant isolation
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
    const body = await request.json();
    const parsed = createInvitationRequestSchema.safeParse(body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return NextResponse.json(
        { error: firstError?.message || 'Invalid request' },
        { status: 400 },
      );
    }

    const { email, role } = parsed.data;

    // Prevent self-invite
    if (email.toLowerCase().trim() === authResult.email.toLowerCase()) {
      return NextResponse.json({ error: 'You cannot invite yourself' }, { status: 400 });
    }

    // Delegate to invitation service — handles validation, token generation,
    // duplicate checks, existing member checks, role hierarchy, and email sending
    const invitation = await createInvitation({
      tenantId,
      email,
      role: role || 'MEMBER',
      invitedBy: authResult.id,
    });

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.INVITATION_SENT,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { inviteeEmail: email, role: role || 'MEMBER' },
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode || 400 });
    }
    log.error('Create invitation error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Operation failed. Please try again.' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List workspace invitations',
    description: 'Get all pending invitations for a workspace. Requires admin role.',
    tags: ['Workspaces', 'Invitations'],
    params: paramsSchema,
    response: invitationsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create workspace invitation',
    description: 'Invite a user to join a workspace by email. Requires admin role.',
    tags: ['Workspaces', 'Invitations'],
    params: paramsSchema,
    body: createInvitationRequestSchema,
    response: createInvitationResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
