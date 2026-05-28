/**
 * GET/POST /api/organizations/:orgId/workspaces
 * List and link/create workspaces under an organization
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { updateTenant } from '@/repos/workspace-repo';
import { findOrgMember } from '@/repos/org-repo';
import { getOrganizationWorkspaces, linkWorkspaceToOrg } from '@/services/organization-service';
import { createWorkspace } from '@/services/workspace-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const ADMIN_ROLES = ['ORG_OWNER', 'ORG_ADMIN'];

async function checkOrgAccess(userId: string, orgId: string, requiredRoles?: string[]) {
  const membership = await findOrgMember(orgId, userId);
  if (!membership) return false;
  if (requiredRoles && !requiredRoles.includes(membership.role)) return false;
  return true;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { orgId } = await params;

  const hasAccess = await checkOrgAccess(authResult.id, orgId);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 });
  }

  try {
    const workspaces = await getOrganizationWorkspaces(orgId);
    return NextResponse.json({ workspaces });
  } catch (error) {
    console.error('[Org] List workspaces error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { orgId } = await params;

  const isAdmin = await checkOrgAccess(authResult.id, orgId, ADMIN_ROLES);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { tenantId, name } = body;

    if (tenantId) {
      // Link existing workspace
      await linkWorkspaceToOrg(tenantId, orgId, authResult.id);

      await logAuditEvent({
        userId: authResult.id,
        tenantId,
        action: AuditActions.WORKSPACE_LINKED_TO_ORG,
        ip: request.headers.get('x-forwarded-for') || undefined,
        metadata: { orgId },
      });

      return NextResponse.json({ success: true, linked: tenantId });
    } else if (name) {
      // Create new workspace under org
      const workspace = await createWorkspace({ name, ownerId: authResult.id });

      // Link to org
      await updateTenant(workspace.id, { organizationId: orgId });

      await logAuditEvent({
        userId: authResult.id,
        tenantId: workspace.id,
        action: AuditActions.WORKSPACE_CREATED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        metadata: { orgId, workspaceName: workspace.name },
      });

      return NextResponse.json({ workspace }, { status: 201 });
    }

    return NextResponse.json(
      { error: 'Provide either tenantId to link or name to create' },
      { status: 400 },
    );
  } catch (error) {
    console.error('[Org] Workspace management error:', error);
    return NextResponse.json({ error: 'Operation failed. Please try again.' }, { status: 400 });
  }
}
