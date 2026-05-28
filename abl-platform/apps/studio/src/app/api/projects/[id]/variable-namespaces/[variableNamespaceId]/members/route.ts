/**
 * POST /api/projects/:id/variable-namespaces/:variableNamespaceId/members - Add variables to variable namespace
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { MAX_VARIABLE_NAMESPACES_PER_VARIABLE } from '@abl/compiler/platform/constants.js';

type RouteParams = { params: Promise<{ id: string; variableNamespaceId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, variableNamespaceId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const { variables } = body;

  if (!Array.isArray(variables) || variables.length === 0) {
    return NextResponse.json(
      { success: false, error: 'variables array is required' },
      { status: 400 },
    );
  }

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace, VariableNamespaceMembership } =
      await import('@agent-platform/database/models');

    // Validate namespace exists
    const ns = await VariableNamespace.findOne({ _id: variableNamespaceId, tenantId }).lean();
    if (!ns || (ns as any).projectId !== projectId) {
      return NextResponse.json(
        { success: false, error: 'Variable namespace not found' },
        { status: 404 },
      );
    }

    let added = 0;
    let skipped = 0;
    const errors: Array<{ variableId: string; reason: string }> = [];

    for (const v of variables) {
      // Check namespace count for this variable
      const existingCount = await VariableNamespaceMembership.countDocuments({
        tenantId,
        variableId: v.variableId,
        variableType: v.variableType,
      });
      if (existingCount >= MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
        errors.push({ variableId: v.variableId, reason: 'Max namespaces reached' });
        continue;
      }

      try {
        await VariableNamespaceMembership.create({
          tenantId,
          projectId,
          namespaceId: variableNamespaceId,
          variableId: v.variableId,
          variableType: v.variableType,
        });
        added++;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
          skipped++;
        } else {
          errors.push({ variableId: v.variableId, reason: 'Create failed' });
        }
      }
    }

    return NextResponse.json({ success: true, added, skipped, errors });
  } catch (error) {
    console.error('[VariableNamespaceMembers] Add error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
