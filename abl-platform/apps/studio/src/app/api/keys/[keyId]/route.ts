/**
 * PATCH  /api/keys/:keyId - Update a platform API key (name, scopes)
 * DELETE /api/keys/:keyId - Revoke a platform API key (soft delete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkScopeCeiling, PLATFORM_KEY_SCOPE_KEYS } from '@agent-platform/shared-auth';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('platform-keys');

type RouteParams = { params: Promise<{ keyId: string }> };

// ─── Zod Schemas ────────────────────────────────────────────────────────

const PLATFORM_KEY_SCOPE_VALUES = [...PLATFORM_KEY_SCOPE_KEYS] as [string, ...string[]];
const PlatformKeyScopeSchema = z.enum(PLATFORM_KEY_SCOPE_VALUES);

const UpdateKeySchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    scopes: z.array(PlatformKeyScopeSchema).min(1).optional(),
  })
  .strict();

const DeleteQuerySchema = z.object({
  projectId: z.string().min(1),
});

const KeyResponseSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const DeleteResponseSchema = z.object({
  success: z.boolean(),
});

// ─── Handlers ───────────────────────────────────────────────────────────

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  if (!user.tenantId) {
    return NextResponse.json({ error: 'Tenant context required' }, { status: 403 });
  }

  const { keyId } = await params;

  const parsed = await validateBody(request, UpdateKeySchema);
  if (!parsed.success) {
    // .strict() schema rejects unknown fields like projectIds with a Zod error
    return parsed.response as NextResponse;
  }

  try {
    await ensureDb();

    const projectAccess = await requireSdkProjectAccess(parsed.data.projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }

    const updateFields: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updateFields.name = parsed.data.name;
    if (parsed.data.scopes !== undefined) {
      if (!user.role) {
        return NextResponse.json(
          { error: 'Tenant role required to update platform key scopes' },
          { status: 403 },
        );
      }

      const scopeCeilingResult = checkScopeCeiling(parsed.data.scopes, user.role);
      if (!scopeCeilingResult.allowed) {
        return NextResponse.json(
          {
            error: 'Scope ceiling exceeded',
            code: 'SCOPE_CEILING_EXCEEDED',
            denied: scopeCeilingResult.denied,
          },
          { status: 403 },
        );
      }

      updateFields.scopes = parsed.data.scopes;
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { ApiKey } = await import('@agent-platform/database/models');
    const updated = await ApiKey.findOneAndUpdate(
      {
        _id: keyId,
        tenantId: user.tenantId,
        projectIds: { $in: [parsed.data.projectId] },
        revokedAt: null, // Cannot update a revoked key
      },
      { $set: updateFields },
      { new: true },
    ).lean();

    if (!updated) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    log.info('Platform key updated', {
      keyId,
      updatedFields: Object.keys(updateFields),
      userId: user.id,
    });

    return NextResponse.json({
      id: updated._id,
      prefix: updated.prefix,
      name: updated.name,
      clientId: updated.clientId,
      scopes: updated.scopes,
      projectIds: updated.projectIds,
      expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      lastUsedAt: updated.lastUsedAt ? updated.lastUsedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (error) {
    log.error('Failed to update platform key', {
      error: error instanceof Error ? error.message : String(error),
      keyId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  if (!user.tenantId) {
    return NextResponse.json({ error: 'Tenant context required' }, { status: 403 });
  }

  const { keyId } = await params;

  const projectId = request.nextUrl.searchParams.get('projectId');
  const parsed = DeleteQuerySchema.safeParse({ projectId });
  if (!parsed.success) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    await ensureDb();

    const projectAccess = await requireSdkProjectAccess(parsed.data.projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }

    const { ApiKey } = await import('@agent-platform/database/models');
    const result = await ApiKey.updateOne(
      {
        _id: keyId,
        tenantId: user.tenantId,
        projectIds: { $in: [parsed.data.projectId] },
        revokedAt: null, // Guard: prevents overwriting original revokedAt timestamp
      },
      { $set: { revokedAt: new Date() } },
    );

    if (result.modifiedCount === 0) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    log.info('Platform key revoked', {
      keyId,
      projectId: parsed.data.projectId,
      userId: user.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Failed to revoke platform key', {
      error: error instanceof Error ? error.message : String(error),
      keyId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────

export const PATCH = withOpenAPI(
  {
    summary: 'Update platform API key',
    description: 'Update the name or scopes of a platform API key. ProjectIds cannot be modified.',
    params: z.object({ keyId: z.string().min(1) }),
    body: UpdateKeySchema,
    response: KeyResponseSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Revoke platform API key',
    description: 'Soft-revoke a platform API key by setting revokedAt timestamp.',
    params: z.object({ keyId: z.string().min(1) }),
    query: DeleteQuerySchema,
    response: DeleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
