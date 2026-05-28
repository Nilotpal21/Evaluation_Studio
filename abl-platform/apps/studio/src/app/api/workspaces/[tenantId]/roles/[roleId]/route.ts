/**
 * GET    /api/workspaces/:tenantId/roles/:roleId — Get a custom role
 * PATCH  /api/workspaces/:tenantId/roles/:roleId — Update a custom role
 * DELETE /api/workspaces/:tenantId/roles/:roleId — Delete a custom role
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateCustomRolePermissions, getPermissionCeiling } from '@agent-platform/shared/rbac';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { validateEffectiveRolePermissionCeiling } from '@/lib/custom-role-effective-permissions';

// ─── Validation ───────────────────────────────────────────────────────────

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.string().min(1)).min(1, 'At least one permission is required').optional(),
  parentRoleId: z.string().min(1).nullish(),
});

type Params = { tenantId: string; roleId: string };

// ─── GET — Fetch a single custom role ────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: Promise<Params> }) {
  try {
    const { tenantId, roleId } = await params;

    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    const workspaceAccess = await requireWorkspacePermission(
      tenantId,
      authResult,
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
      {
        denyBehavior: 'not_found',
      },
    );
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    await ensureDb();
    const { RoleDefinition } = await import('@agent-platform/database/models');
    const doc = await RoleDefinition.findOne({ _id: roleId, tenantId }).lean();

    if (!doc) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const role = doc as any;
    return NextResponse.json({
      success: true,
      role: {
        id: String(role._id),
        name: role.name,
        description: role.description || null,
        isSystem: role.isSystem,
        permissions: role.permissions || [],
        parentRoleId: role.parentRoleId || null,
        createdBy: role.createdBy,
        createdAt: role.createdAt ? new Date(role.createdAt).toISOString() : null,
        updatedAt: role.updatedAt ? new Date(role.updatedAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'CustomRole.GET');
  }
}

// ─── PATCH — Update a custom role ────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: { params: Promise<Params> }) {
  try {
    const { tenantId, roleId } = await params;

    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    const workspaceAccess = await requireWorkspacePermission(
      tenantId,
      authResult,
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
      {
        denyBehavior: 'not_found',
      },
    );
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const parsed = updateRoleSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => {
        const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
        return `${prefix}${i.message}`;
      });
      return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    await ensureDb();
    const { RoleDefinition } = await import('@agent-platform/database/models');

    // Verify role exists and is not a system role
    const existing = await RoleDefinition.findOne({ _id: roleId, tenantId }).lean();
    if (!existing) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }
    if ((existing as any).isSystem) {
      return errorJson('Cannot modify system roles', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { name, description, permissions, parentRoleId } = parsed.data;

    // Validate direct permissions if being updated.
    if (permissions) {
      const { valid, invalid } = validateCustomRolePermissions(permissions);
      if (!valid) {
        return errorJson(
          `Invalid permissions: ${invalid.join(', ')}`,
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }

    if (permissions !== undefined || parentRoleId !== undefined) {
      const rawRoles = (await RoleDefinition.find({ tenantId }).lean()) as Array<
        Record<string, unknown>
      >;
      const effectivePermissions = validateEffectiveRolePermissionCeiling(
        rawRoles,
        {
          id: roleId,
          name: name ?? String((existing as any).name ?? ''),
          permissions:
            permissions ??
            (Array.isArray((existing as any).permissions) ? (existing as any).permissions : []),
          parentRoleId:
            parentRoleId !== undefined
              ? (parentRoleId ?? null)
              : (((existing as any).parentRoleId as string | null | undefined) ?? null),
        },
        getPermissionCeiling(workspaceAccess.membership.role),
      );
      if (effectivePermissions.error) {
        return errorJson(effectivePermissions.error, 400, ErrorCode.VALIDATION_ERROR);
      }
      if (effectivePermissions.exceedingPermissions.length > 0) {
        return errorJson(
          `Cannot grant permissions you do not hold: ${effectivePermissions.exceedingPermissions.join(', ')}`,
          403,
          ErrorCode.FORBIDDEN,
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description ?? null;
    if (permissions !== undefined) updateData.permissions = permissions;
    if (parentRoleId !== undefined) updateData.parentRoleId = parentRoleId ?? null;

    if (Object.keys(updateData).length === 0) {
      return errorJson('No fields to update', 400, ErrorCode.VALIDATION_ERROR);
    }

    const updated = await RoleDefinition.findOneAndUpdate(
      { _id: roleId, tenantId, isSystem: false },
      { $set: updateData },
      { new: true, runValidators: true },
    ).lean();

    if (!updated) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const role = updated as any;
    return NextResponse.json({
      success: true,
      role: {
        id: String(role._id),
        name: role.name,
        description: role.description || null,
        permissions: role.permissions || [],
        parentRoleId: role.parentRoleId || null,
        createdBy: role.createdBy,
        updatedAt: role.updatedAt ? new Date(role.updatedAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'CustomRole.PATCH');
  }
}

// ─── DELETE — Delete a custom role ───────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: { params: Promise<Params> }) {
  try {
    const { tenantId, roleId } = await params;

    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    const workspaceAccess = await requireWorkspacePermission(
      tenantId,
      authResult,
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
      {
        denyBehavior: 'not_found',
      },
    );
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    await ensureDb();
    const { RoleDefinition, Project, ProjectMember } =
      await import('@agent-platform/database/models');

    // Verify role exists and is not a system role
    const existing = await RoleDefinition.findOne({ _id: roleId, tenantId }).lean();
    if (!existing) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }
    if ((existing as any).isSystem) {
      return errorJson('Cannot delete system roles', 400, ErrorCode.VALIDATION_ERROR);
    }

    const tenantProjects = (await Project.find({ tenantId }, { _id: 1 }).lean()) as Array<{
      _id: unknown;
    }>;
    const tenantProjectIds = tenantProjects.map((project) => String(project._id));

    // Clear only members in this tenant's projects; ProjectMember has no tenantId field.
    await ProjectMember.updateMany(
      { projectId: { $in: tenantProjectIds }, customRoleId: roleId },
      { $set: { customRoleId: null, role: 'viewer' } },
    );

    await RoleDefinition.deleteOne({ _id: roleId, tenantId, isSystem: false });

    return NextResponse.json({ success: true, message: 'Role deleted' });
  } catch (error: unknown) {
    return handleApiError(error, 'CustomRole.DELETE');
  }
}
