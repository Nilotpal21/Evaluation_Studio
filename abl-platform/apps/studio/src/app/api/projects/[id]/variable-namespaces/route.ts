/**
 * GET  /api/projects/:id/variable-namespaces - List variable namespaces for a project
 * POST /api/projects/:id/variable-namespaces - Create a variable namespace
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { MAX_VARIABLE_NAMESPACES_PER_PROJECT } from '@abl/compiler/platform/constants.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(_request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace, VariableNamespaceMembership } =
      await import('@agent-platform/database/models');

    let namespaces = await VariableNamespace.find({ tenantId, projectId })
      .sort({ order: 1 })
      .lean();

    // Auto-provision default namespace if none exist
    if (namespaces.length === 0) {
      try {
        await VariableNamespace.create({
          tenantId,
          projectId,
          name: 'default',
          displayName: 'Default',
          isDefault: true,
          order: 0,
          createdBy: 'system:auto-provision',
        });
        namespaces = await VariableNamespace.find({ tenantId, projectId })
          .sort({ order: 1 })
          .lean();
      } catch (err: unknown) {
        // Race condition — another request may have created it
        namespaces = await VariableNamespace.find({ tenantId, projectId })
          .sort({ order: 1 })
          .lean();
      }
    }

    // Enrich with member counts
    const nsIds = namespaces.map((ns: any) => String(ns._id));
    const memberships =
      nsIds.length > 0
        ? await VariableNamespaceMembership.find({
            tenantId,
            projectId,
            namespaceId: { $in: nsIds },
          }).lean()
        : [];

    const counts: Record<string, { env: number; config: number }> = {};
    for (const m of memberships as any[]) {
      const nsId = String(m.namespaceId);
      if (!counts[nsId]) counts[nsId] = { env: 0, config: 0 };
      if (m.variableType === 'env') counts[nsId].env++;
      else if (m.variableType === 'config') counts[nsId].config++;
    }

    const enriched = namespaces.map((ns: any) => ({
      id: String(ns._id),
      name: ns.name,
      displayName: ns.displayName,
      description: ns.description ?? null,
      icon: ns.icon ?? null,
      color: ns.color ?? null,
      order: ns.order,
      isDefault: ns.isDefault,
      memberCounts: counts[String(ns._id)] || { env: 0, config: 0 },
      createdAt: ns.createdAt,
    }));

    return NextResponse.json({ success: true, namespaces: enriched });
  } catch (error) {
    return handleApiError(error, 'VariableNamespaces.List');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const { name, displayName, description, icon, color } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
  }
  if (!displayName || typeof displayName !== 'string') {
    return NextResponse.json({ success: false, error: 'displayName is required' }, { status: 400 });
  }
  if (name.length < 1 || name.length > 50 || !NAME_PATTERN.test(name)) {
    return NextResponse.json(
      { success: false, error: 'name must be 1-50 lowercase chars starting with a letter' },
      { status: 400 },
    );
  }
  if (name === 'default') {
    return NextResponse.json(
      { success: false, error: "Cannot create a namespace named 'default'" },
      { status: 400 },
    );
  }

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespace } = await import('@agent-platform/database/models');

    const count = await VariableNamespace.countDocuments({ tenantId, projectId });
    if (count >= MAX_VARIABLE_NAMESPACES_PER_PROJECT) {
      return NextResponse.json(
        {
          success: false,
          error: `Maximum of ${MAX_VARIABLE_NAMESPACES_PER_PROJECT} namespaces reached`,
        },
        { status: 400 },
      );
    }

    const namespace = await VariableNamespace.create({
      tenantId,
      projectId,
      name,
      displayName,
      description: description ?? null,
      icon: icon ?? null,
      color: color ?? null,
      order: count,
      isDefault: false,
      createdBy: formatUserLabel(user),
    });

    return NextResponse.json(
      {
        success: true,
        namespace: {
          id: String(namespace._id),
          name: namespace.name,
          displayName: namespace.displayName,
          description: namespace.description,
          icon: namespace.icon,
          color: namespace.color,
          order: namespace.order,
          isDefault: namespace.isDefault,
          memberCounts: { env: 0, config: 0 },
          createdAt: namespace.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, 'VariableNamespaces.Create');
  }
}
