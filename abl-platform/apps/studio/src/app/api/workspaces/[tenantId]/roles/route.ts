/**
 * GET  /api/workspaces/:tenantId/roles — List custom role definitions
 * POST /api/workspaces/:tenantId/roles — Create a custom role
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

const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.string().min(1)).min(1, 'At least one permission is required'),
  parentRoleId: z.string().min(1).nullish(),
});

// ─── GET — List custom roles for this tenant ─────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  try {
    const { tenantId } = await params;

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
    const docs = await RoleDefinition.find({ tenantId, isSystem: false }).sort({ name: 1 }).lean();

    const roles = docs.map((doc: any) => ({
      id: String(doc._id),
      name: doc.name,
      description: doc.description || null,
      permissions: doc.permissions || [],
      parentRoleId: doc.parentRoleId || null,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    }));

    return NextResponse.json({ success: true, roles });
  } catch (error: unknown) {
    return handleApiError(error, 'CustomRoles.GET');
  }
}

// ─── POST — Create a custom role ─────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  try {
    const { tenantId } = await params;

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

    const parsed = createRoleSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => {
        const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
        return `${prefix}${i.message}`;
      });
      return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    const { name, description, permissions, parentRoleId } = parsed.data;

    // Validate permissions against allowlist
    const { valid, invalid } = validateCustomRolePermissions(permissions);
    if (!valid) {
      return errorJson(
        `Invalid permissions: ${invalid.join(', ')}`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    await ensureDb();
    const { RoleDefinition } = await import('@agent-platform/database/models');
    const rawRoles = (await RoleDefinition.find({ tenantId }).lean()) as Array<
      Record<string, unknown>
    >;
    const ceiling = getPermissionCeiling(workspaceAccess.membership.role);
    const ceilingValidation = validateEffectiveRolePermissionCeiling(
      rawRoles,
      {
        id: `new:${name}`,
        name,
        permissions,
        parentRoleId: parentRoleId ?? null,
      },
      ceiling,
    );
    if (ceilingValidation.error) {
      return errorJson(ceilingValidation.error, 400, ErrorCode.VALIDATION_ERROR);
    }
    if (ceilingValidation.exceedingPermissions.length > 0) {
      return errorJson(
        `Cannot grant permissions you do not hold: ${ceilingValidation.exceedingPermissions.join(', ')}`,
        403,
        ErrorCode.FORBIDDEN,
      );
    }

    const doc = await RoleDefinition.create({
      tenantId,
      name,
      description: description ?? null,
      isSystem: false,
      permissions,
      parentRoleId: parentRoleId ?? null,
      createdBy: authResult.id,
    });

    const plain = doc.toObject();

    return NextResponse.json(
      {
        success: true,
        role: {
          id: String(plain._id),
          name: plain.name,
          description: plain.description || null,
          permissions: plain.permissions,
          parentRoleId: plain.parentRoleId || null,
          createdBy: plain.createdBy,
          createdAt: plain.createdAt ? new Date(plain.createdAt).toISOString() : null,
        },
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    return handleApiError(error, 'CustomRoles.POST');
  }
}
