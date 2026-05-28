/**
 * GET  /api/keys - List platform API keys for a project
 * POST /api/keys - Create a new platform API key
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkScopeCeiling, PLATFORM_KEY_SCOPE_KEYS } from '@agent-platform/shared-auth';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import { ensureDb } from '@/lib/ensure-db';
import { generatePlatformKey, generateClientId } from './platform-key-utils';
import type { IApiKey } from '@agent-platform/database/models';

const log = createLogger('platform-keys');

// ─── Zod Schemas ────────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  projectId: z.string().min(1),
});

const PLATFORM_KEY_SCOPE_VALUES = [...PLATFORM_KEY_SCOPE_KEYS] as [string, ...string[]];
const PlatformKeyScopeSchema = z.enum(PLATFORM_KEY_SCOPE_VALUES);

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(PlatformKeyScopeSchema).min(1),
  projectIds: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
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

const ListKeysResponseSchema = z.object({
  keys: z.array(KeyResponseSchema),
});

const CreateKeyResponseSchema = KeyResponseSchema.extend({
  key: z.string(),
});

// ─── Handlers ───────────────────────────────────────────────────────────

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  if (!user.tenantId) {
    return NextResponse.json({ error: 'Tenant context required' }, { status: 403 });
  }

  const projectId = request.nextUrl.searchParams.get('projectId');
  const parsed = ListQuerySchema.safeParse({ projectId });
  if (!parsed.success) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    await ensureDb();

    const projectAccess = await requireSdkProjectAccess(parsed.data.projectId, user, 'read');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }

    const { ApiKey } = await import('@agent-platform/database/models');
    const now = new Date();
    const keys: IApiKey[] = await ApiKey.find({
      tenantId: user.tenantId,
      projectIds: { $in: [parsed.data.projectId] },
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
      .limit(100)
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({
      keys: keys.map((k) => ({
        id: k._id,
        prefix: k.prefix,
        name: k.name,
        clientId: k.clientId,
        scopes: k.scopes,
        projectIds: k.projectIds,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    log.error('Failed to list platform keys', {
      error: error instanceof Error ? error.message : String(error),
      projectId: parsed.data.projectId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  if (!user.tenantId) {
    return NextResponse.json({ error: 'Tenant context required' }, { status: 403 });
  }

  const parsed = await validateBody(request, CreateKeySchema);
  if (!parsed.success) {
    return parsed.response as NextResponse;
  }

  try {
    await ensureDb();

    // Validate access to ALL projectIds — prevents privilege escalation
    for (const pid of parsed.data.projectIds) {
      const access = await requireSdkProjectAccess(pid, user, 'write');
      if (isSdkProjectAccessError(access)) return access;
    }

    if (!user.role) {
      return NextResponse.json(
        { error: 'Tenant role required to create platform keys' },
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

    const { rawKey, prefix, keyHash } = generatePlatformKey();
    const clientId = generateClientId();

    const { ApiKey } = await import('@agent-platform/database/models');
    const apiKey = await ApiKey.create({
      tenantId: user.tenantId,
      name: parsed.data.name,
      clientId,
      keyHash,
      prefix,
      scopes: parsed.data.scopes,
      projectIds: parsed.data.projectIds,
      environments: [],
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      createdBy: user.id,
    });

    log.info('Platform key created', {
      keyId: apiKey._id,
      prefix,
      clientId,
      scopes: parsed.data.scopes,
      projectIds: parsed.data.projectIds,
      userId: user.id,
    });

    return NextResponse.json(
      {
        id: apiKey._id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        clientId: apiKey.clientId,
        scopes: apiKey.scopes,
        projectIds: apiKey.projectIds,
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        lastUsedAt: null,
        createdAt: apiKey.createdAt.toISOString(),
        key: rawKey,
      },
      { status: 201 },
    );
  } catch (error) {
    log.error('Failed to create platform key', {
      error: error instanceof Error ? error.message : String(error),
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────

export const GET = withOpenAPI(
  {
    summary: 'List platform API keys',
    description: 'Retrieve all active platform API keys for a project.',
    query: ListQuerySchema,
    response: ListKeysResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create platform API key',
    description:
      'Create a new platform API key. The raw key is returned only once in the response.',
    body: CreateKeySchema,
    response: CreateKeyResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
