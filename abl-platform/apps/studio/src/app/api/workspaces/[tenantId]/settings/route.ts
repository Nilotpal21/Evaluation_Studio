/**
 * GET  /api/workspaces/:tenantId/settings — Read workspace settings
 * PATCH /api/workspaces/:tenantId/settings — Update workspace name/slug
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findTenantById, updateTenant, findTenantBySlug } from '@/repos/workspace-repo';

// ─── Validation ─────────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
});

// ─── GET — Read workspace settings ──────────────────────────────────────

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
      WORKSPACE_PERMISSIONS.MANAGE_SETTINGS,
      {
        denyBehavior: 'not_found',
        tenantStatuses: ['active'],
        memberStatuses: ['active'],
      },
    );
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({
      success: true,
      workspace: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        ownerId: tenant.ownerId,
        createdAt: tenant.createdAt ? new Date(tenant.createdAt).toISOString() : null,
        updatedAt: tenant.updatedAt ? new Date(tenant.updatedAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'WorkspaceSettings.GET');
  }
}

// ─── PATCH — Update workspace settings ──────────────────────────────────

export async function PATCH(
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
      WORKSPACE_PERMISSIONS.MANAGE_SETTINGS,
      {
        denyBehavior: 'not_found',
        tenantStatuses: ['active'],
        memberStatuses: ['active'],
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

    const parsed = updateSettingsSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => {
        const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
        return `${prefix}${i.message}`;
      });
      return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    const { name, slug } = parsed.data;

    if (!name && !slug) {
      return errorJson('No fields to update', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Check slug uniqueness if changing
    if (slug) {
      const existing = await findTenantBySlug(slug);
      if (existing && existing.id !== tenantId) {
        return errorJson('This slug is already taken', 409, ErrorCode.NAME_CONFLICT);
      }
    }

    const updateData: Record<string, string> = {};
    if (name) updateData.name = name;
    if (slug) updateData.slug = slug;

    const updated = await updateTenant(tenantId, updateData);

    return NextResponse.json({
      success: true,
      workspace: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        status: updated.status,
        ownerId: updated.ownerId,
        createdAt: updated.createdAt ? new Date(updated.createdAt).toISOString() : null,
        updatedAt: updated.updatedAt ? new Date(updated.updatedAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'WorkspaceSettings.PATCH');
  }
}
