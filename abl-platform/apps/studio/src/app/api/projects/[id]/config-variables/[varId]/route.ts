/**
 * GET    /api/projects/:id/config-variables/:varId - Get a single config variable
 * PATCH  /api/projects/:id/config-variables/:varId - Update a config variable
 * DELETE /api/projects/:id/config-variables/:varId - Delete a config variable
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { isAccessError } from '@/lib/project-access';
import { requireProjectMemberOrAdmin } from '@/lib/require-project-member-or-admin';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';
import {
  findConfigVariableById,
  updateConfigVariable,
  deleteConfigVariable,
} from '@/repos/config-variable-repo';
import {
  MAX_CONFIG_VAR_VALUE_LENGTH,
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE,
} from '@abl/compiler/platform/constants.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const logger = createLogger('config-variables');

const updateSchema = z
  .object({
    value: z.string().max(MAX_CONFIG_VAR_VALUE_LENGTH).optional(),
    description: z.string().max(500).nullable().optional(),
    variableNamespaceIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.value !== undefined ||
      data.description !== undefined ||
      data.variableNamespaceIds !== undefined,
    {
      message: 'At least one of value, description, or variableNamespaceIds must be provided',
    },
  );

type RouteParams = { params: Promise<{ id: string; varId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, varId } = await params;
  const access = await requireProjectMemberOrAdmin(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const variable = await findConfigVariableById(varId, user.tenantId!, projectId);
    if (!variable) {
      return NextResponse.json(
        { success: false, error: 'Config variable not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, variable });
  } catch (error) {
    logger.error('[ConfigVariables] Get error:', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, varId } = await params;
  const access = await requireProjectMemberOrAdmin(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const result = updateSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const tenantId = user.tenantId!;
    const { VariableNamespaceMembership, VariableNamespace } =
      await import('@agent-platform/database/models');

    // Validate namespace membership changes before updating the variable row so
    // bad namespace input cannot partially update the variable value.
    const variableNamespaceIds = result.data.variableNamespaceIds;
    let targetNamespaceIds: string[] | undefined;
    if (variableNamespaceIds !== undefined) {
      if (variableNamespaceIds.length > MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
        return NextResponse.json(
          {
            success: false,
            error: `Cannot assign to more than ${MAX_VARIABLE_NAMESPACES_PER_VARIABLE} namespaces`,
          },
          { status: 400 },
        );
      }

      const existing = await findConfigVariableById(varId, tenantId, projectId);
      if (!existing) {
        return NextResponse.json(
          { success: false, error: 'Config variable not found' },
          { status: 404 },
        );
      }

      targetNamespaceIds =
        variableNamespaceIds.length > 0
          ? variableNamespaceIds
          : await getOrCreateDefaultVariableNamespaceIds({
              tenantId,
              projectId,
              createdBy: formatUserLabel(user),
              required: true,
            });

      if (targetNamespaceIds.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Default variable namespace is unavailable' },
          { status: 500 },
        );
      }

      for (const nsId of targetNamespaceIds) {
        const ns = await VariableNamespace.findOne({ _id: nsId, tenantId, projectId }).lean();
        if (!ns) {
          return NextResponse.json(
            { success: false, error: `Namespace ${nsId} not found in this project` },
            { status: 400 },
          );
        }
      }
    }

    const doc = await updateConfigVariable(
      varId,
      tenantId,
      {
        ...(result.data.value !== undefined ? { value: result.data.value } : {}),
        ...('description' in result.data ? { description: result.data.description } : {}),
        updatedBy: user.id,
      },
      projectId,
    );

    if (!doc) {
      return NextResponse.json(
        { success: false, error: 'Config variable not found' },
        { status: 404 },
      );
    }

    // Handle namespace membership replacement if variableNamespaceIds provided
    if (targetNamespaceIds !== undefined) {
      // Replace: delete old, create new
      await VariableNamespaceMembership.deleteMany({
        variableId: varId,
        variableType: 'config',
        tenantId,
        projectId,
      });

      const membershipDocs = targetNamespaceIds.map((nsId) => ({
        tenantId,
        projectId,
        namespaceId: nsId,
        variableId: varId,
        variableType: 'config' as const,
      }));
      try {
        await VariableNamespaceMembership.insertMany(membershipDocs, { ordered: false });
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
          // Duplicate is acceptable
        } else {
          throw err;
        }
      }
    }

    return NextResponse.json({ success: true, variable: doc });
  } catch (error) {
    logger.error('[ConfigVariables] Update error:', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, varId } = await params;
  const access = await requireProjectMemberOrAdmin(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const tenantId = user.tenantId!;
    const existing = await findConfigVariableById(varId, tenantId, projectId);
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Config variable not found' },
        { status: 404 },
      );
    }

    await deleteConfigVariable(varId, tenantId, projectId);

    // Cascade delete namespace memberships (scoped to tenant)
    const { VariableNamespaceMembership: MembershipModel } =
      await import('@agent-platform/database/models');
    await MembershipModel.deleteMany({
      variableId: varId,
      variableType: 'config',
      tenantId,
      projectId,
    });

    return NextResponse.json({ success: true, deleted: varId });
  } catch (error) {
    logger.error('[ConfigVariables] Delete error:', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
