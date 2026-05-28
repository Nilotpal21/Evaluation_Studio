/**
 * GET  /api/projects/:id/config-variables - List config variables for a project
 * POST /api/projects/:id/config-variables - Create a config variable
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { isAccessError } from '@/lib/project-access';
import { requireProjectMemberOrAdmin } from '@/lib/require-project-member-or-admin';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';
import {
  findConfigVariablesByProject,
  findConfigVariableByKey,
  createConfigVariable,
  countConfigVariables,
} from '@/repos/config-variable-repo';
import {
  MAX_CONFIG_VARIABLES_PER_PROJECT,
  MAX_CONFIG_VAR_VALUE_LENGTH,
  MAX_CONFIG_VAR_KEY_LENGTH,
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE,
} from '@abl/compiler/platform/constants.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const logger = createLogger('config-variables-list');

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const createSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(MAX_CONFIG_VAR_KEY_LENGTH)
      .regex(
        KEY_PATTERN,
        'Key must start with a letter and contain only letters, digits, and underscores',
      ),
    value: z.string().min(1).max(MAX_CONFIG_VAR_VALUE_LENGTH),
    description: z.string().max(500).optional(),
    variableNamespaceIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectMemberOrAdmin(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const tenantId = access.project.tenantId;
    const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

    // Optional namespace filtering
    const namespaceId = request.nextUrl.searchParams.get('namespaceId');
    let namespaceFilter: Set<string> | undefined;
    if (namespaceId) {
      const memberships = await VariableNamespaceMembership.find({
        tenantId,
        projectId,
        namespaceId,
        variableType: 'config',
      }).lean();
      namespaceFilter = new Set(memberships.map((m: any) => String(m.variableId)));
    }

    let variables = await findConfigVariablesByProject(projectId, tenantId);

    // Filter by namespace if requested
    if (namespaceFilter) {
      variables = variables.filter((v: any) => namespaceFilter!.has(String(v._id ?? v.id)));
    }

    // Enrich with namespace list
    const varIds = variables.map((v: any) => String(v._id ?? v.id));
    const allMemberships =
      varIds.length > 0
        ? await VariableNamespaceMembership.find({
            tenantId,
            projectId,
            variableId: { $in: varIds },
            variableType: 'config',
          }).lean()
        : [];
    const nsMembershipMap = new Map<string, string[]>();
    for (const m of allMemberships as any[]) {
      const vid = String(m.variableId);
      if (!nsMembershipMap.has(vid)) nsMembershipMap.set(vid, []);
      nsMembershipMap.get(vid)!.push(String(m.namespaceId));
    }

    const enriched = variables.map((v: any) => ({
      ...v,
      variableNamespaceIds: nsMembershipMap.get(String(v._id ?? v.id)) ?? [],
    }));

    return NextResponse.json({ success: true, variables: enriched });
  } catch (error) {
    logger.error('[ConfigVariables] List error:', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectMemberOrAdmin(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const result = createSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  const { key, value, description, variableNamespaceIds: rawNsIds } = result.data;
  const normalizedKey = key.toUpperCase();
  const variableNamespaceIds: string[] = rawNsIds ?? [];

  try {
    const tenantIdForCreate = access.project.tenantId;

    // Check for duplicate key
    const existing = await findConfigVariableByKey(projectId, normalizedKey, tenantIdForCreate);
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Config variable "${normalizedKey}" already exists` },
        { status: 409 },
      );
    }

    // Check count limit
    const count = await countConfigVariables(projectId, tenantIdForCreate);
    if (count >= MAX_CONFIG_VARIABLES_PER_PROJECT) {
      return NextResponse.json(
        {
          success: false,
          error: `Maximum of ${MAX_CONFIG_VARIABLES_PER_PROJECT} config variables per project reached`,
        },
        { status: 400 },
      );
    }

    // Validate namespace IDs BEFORE creating the variable to prevent orphans
    const { VariableNamespaceMembership, VariableNamespace } =
      await import('@agent-platform/database/models');

    if (variableNamespaceIds.length > MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot assign to more than ${MAX_VARIABLE_NAMESPACES_PER_VARIABLE} namespaces`,
        },
        { status: 400 },
      );
    }

    const membershipNamespaceIds =
      variableNamespaceIds.length > 0
        ? variableNamespaceIds
        : await getOrCreateDefaultVariableNamespaceIds({
            tenantId: tenantIdForCreate,
            projectId,
            createdBy: formatUserLabel(user),
            required: true,
          });

    if (membershipNamespaceIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Default variable namespace is unavailable' },
        { status: 500 },
      );
    }

    if (variableNamespaceIds.length > 0) {
      for (const nsId of variableNamespaceIds) {
        const ns = await VariableNamespace.findOne({
          _id: nsId,
          tenantId: tenantIdForCreate,
          projectId,
        }).lean();
        if (!ns) {
          return NextResponse.json(
            { success: false, error: `Namespace ${nsId} not found in this project` },
            { status: 400 },
          );
        }
      }
    }

    // Now safe to create the variable
    const variable = await createConfigVariable({
      tenantId: tenantIdForCreate,
      projectId,
      key: normalizedKey,
      value,
      description,
      createdBy: formatUserLabel(user),
    });

    const varId = String(variable._id ?? variable.id);

    // Create namespace memberships
    const docs = membershipNamespaceIds.map((nsId) => ({
      tenantId: tenantIdForCreate,
      projectId,
      namespaceId: nsId,
      variableId: varId,
      variableType: 'config' as const,
    }));
    try {
      await VariableNamespaceMembership.insertMany(docs, { ordered: false });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
        // Duplicate memberships are acceptable
      } else {
        throw err;
      }
    }

    return NextResponse.json({ success: true, variable }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
      return NextResponse.json(
        { success: false, error: `Config variable "${normalizedKey}" already exists` },
        { status: 409 },
      );
    }
    logger.error('[ConfigVariables] Create error:', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
