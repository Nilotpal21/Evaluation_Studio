/**
 * PUT    /api/projects/:id/variable-namespaces/:variableNamespaceId - Update a variable namespace
 * DELETE /api/projects/:id/variable-namespaces/:variableNamespaceId - Delete a variable namespace
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string; variableNamespaceId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, variableNamespaceId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const { displayName, description, icon, color } = body;

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace } = await import('@agent-platform/database/models');

    const existing = await VariableNamespace.findOne({ _id: variableNamespaceId, tenantId }).lean();
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Variable namespace not found' },
        { status: 404 },
      );
    }

    if ((existing as any).isDefault && displayName !== undefined) {
      return NextResponse.json(
        { success: false, error: 'Cannot update displayName of the default namespace' },
        { status: 400 },
      );
    }

    const updateData: Record<string, any> = { updatedBy: formatUserLabel(user) };
    if (displayName !== undefined) updateData.displayName = displayName;
    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (color !== undefined) updateData.color = color;

    const updated = await VariableNamespace.findOneAndUpdate(
      { _id: variableNamespaceId, tenantId },
      { $set: updateData },
      { new: true },
    ).lean();

    return NextResponse.json({
      success: true,
      namespace: {
        id: String((updated as any)._id),
        name: (updated as any).name,
        displayName: (updated as any).displayName,
        description: (updated as any).description,
        icon: (updated as any).icon,
        color: (updated as any).color,
        order: (updated as any).order,
        isDefault: (updated as any).isDefault,
        createdAt: (updated as any).createdAt,
      },
    });
  } catch (error) {
    return handleApiError(error, 'VariableNamespaces.Update');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(_request);
  if (isAuthError(user)) return user;

  const { id: projectId, variableNamespaceId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace, VariableNamespaceMembership } =
      await import('@agent-platform/database/models');

    const existing = await VariableNamespace.findOne({
      _id: variableNamespaceId,
      tenantId,
    }).lean();
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Variable namespace not found' },
        { status: 404 },
      );
    }
    if ((existing as any).isDefault) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete the default namespace' },
        { status: 400 },
      );
    }

    // Find default namespace to reassign orphans
    const defaultNs = await VariableNamespace.findOne({
      tenantId,
      projectId,
      isDefault: true,
    }).lean();

    let movedToDefault = 0;

    // Find all memberships for this namespace
    const memberships = await VariableNamespaceMembership.find({
      tenantId,
      projectId,
      namespaceId: variableNamespaceId,
    }).lean();

    // For each member, check if it has other memberships; if orphaned, move to default
    for (const membership of memberships as any[]) {
      const allMemberships = await VariableNamespaceMembership.find({
        tenantId,
        variableId: membership.variableId,
        variableType: membership.variableType,
      }).lean();
      const others = (allMemberships as any[]).filter(
        (m: any) => String(m.namespaceId) !== variableNamespaceId,
      );
      if (others.length === 0 && defaultNs) {
        try {
          await VariableNamespaceMembership.create({
            tenantId,
            projectId,
            namespaceId: String((defaultNs as any)._id),
            variableId: membership.variableId,
            variableType: membership.variableType,
          });
          movedToDefault++;
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
            // Already exists
          } else {
            throw err;
          }
        }
      }
    }

    // Delete all memberships for this namespace
    await VariableNamespaceMembership.deleteMany({ tenantId, namespaceId: variableNamespaceId });

    // Delete the namespace
    await VariableNamespace.deleteOne({ _id: variableNamespaceId, tenantId });

    return NextResponse.json({ success: true, movedToDefault });
  } catch (error) {
    return handleApiError(error, 'VariableNamespaces.Delete');
  }
}
