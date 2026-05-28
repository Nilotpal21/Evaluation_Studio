/**
 * DELETE /api/projects/:id/variable-namespaces/:variableNamespaceId/members/:variableId - Remove variable from variable namespace
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';

type RouteParams = {
  params: Promise<{ id: string; variableNamespaceId: string; variableId: string }>;
};

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, variableNamespaceId, variableId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const type = request.nextUrl.searchParams.get('type');
  if (!type || !['env', 'config'].includes(type)) {
    return NextResponse.json(
      { success: false, error: 'type query param required (env or config)' },
      { status: 400 },
    );
  }

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace, VariableNamespaceMembership } =
      await import('@agent-platform/database/models');

    // Delete the membership
    const result = await VariableNamespaceMembership.deleteOne({
      tenantId,
      namespaceId: variableNamespaceId,
      variableId,
      variableType: type,
    });

    if (result.deletedCount === 0) {
      return NextResponse.json({ success: true, movedToDefault: false });
    }

    // Check if variable is now orphaned (no memberships) — move to default
    let movedToDefault = false;
    const remaining = await VariableNamespaceMembership.countDocuments({
      tenantId,
      variableId,
      variableType: type,
    });

    if (remaining === 0) {
      const defaultNs = await VariableNamespace.findOne({
        tenantId,
        projectId,
        isDefault: true,
      }).lean();
      if (defaultNs) {
        try {
          await VariableNamespaceMembership.create({
            tenantId,
            projectId,
            namespaceId: String((defaultNs as any)._id),
            variableId,
            variableType: type,
          });
          movedToDefault = true;
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
            movedToDefault = true; // Already there
          } else {
            throw err;
          }
        }
      }
    }

    return NextResponse.json({ success: true, movedToDefault });
  } catch (error) {
    console.error('[VariableNamespaceMembers] Remove error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
