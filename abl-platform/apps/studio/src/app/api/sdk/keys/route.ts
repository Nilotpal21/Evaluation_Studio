/**
 * GET  /api/sdk/keys - List SDK API keys for a project
 * POST /api/sdk/keys - Create a new public API key
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findPublicApiKeys, createPublicApiKey } from '@/repos/sdk-repo';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';

const queryParamsSchema = z.object({
  projectId: z.string().min(1),
});

const apiKeyPermissionsSchema = z.object({
  chat: z.boolean().default(true),
  voice: z.boolean().default(false),
});

const createKeySchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  allowedOrigins: z.array(z.string().url()).max(50).optional(),
  permissions: apiKeyPermissionsSchema.optional(),
  expiresAt: z.string().datetime().optional(),
});

const apiKeyItemSchema = z.object({
  id: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  allowedOrigins: z.array(z.string()).nullable(),
  permissions: apiKeyPermissionsSchema,
  isActive: z.boolean(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});

const listKeysResponseSchema = z.object({
  keys: z.array(apiKeyItemSchema),
});

const createKeyResponseSchema = z.object({
  id: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  key: z.string(),
  allowedOrigins: z.array(z.string()).nullable(),
  permissions: apiKeyPermissionsSchema,
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});

const log = createLogger('studio-sdk-keys');
const DEFAULT_API_KEY_PERMISSIONS = { chat: true, voice: false } as const;

function normalizeAllowedOrigins(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === 'string') {
      try {
        const reparsed = JSON.parse(value[0]);
        if (Array.isArray(reparsed)) {
          return reparsed.filter((entry): entry is string => typeof entry === 'string');
        }
      } catch {
        // Fall through to direct array handling.
      }
    }

    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizePermissions(value: unknown): z.infer<typeof apiKeyPermissionsSchema> {
  if (typeof value === 'string') {
    try {
      return normalizePermissions(JSON.parse(value));
    } catch {
      return { ...DEFAULT_API_KEY_PERMISSIONS };
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_API_KEY_PERMISSIONS };
  }

  const record = value as Record<string, unknown>;
  return {
    chat: typeof record.chat === 'boolean' ? record.chat : DEFAULT_API_KEY_PERMISSIONS.chat,
    voice: typeof record.voice === 'boolean' ? record.voice : DEFAULT_API_KEY_PERMISSIONS.voice,
  };
}

function formatApiKeyResponse(key: {
  id: string;
  keyPrefix: string;
  name: string;
  allowedOrigins?: unknown;
  permissions?: unknown;
  isActive: boolean;
  lastUsedAt?: Date | string | null;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
}) {
  return {
    id: key.id,
    keyPrefix: key.keyPrefix,
    name: key.name,
    allowedOrigins: normalizeAllowedOrigins(key.allowedOrigins),
    permissions: normalizePermissions(key.permissions),
    isActive: key.isActive,
    lastUsedAt: key.lastUsedAt ?? null,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt ?? null,
  };
}

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    const projectAccess = await requireSdkProjectAccess(projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }

    // Use repo function
    const keys = await findPublicApiKeys({
      projectId,
      tenantId: projectAccess.project.tenantId,
      isActive: true,
    });

    return NextResponse.json({
      keys: keys.map((key) => formatApiKeyResponse(key)),
    });
  } catch (error) {
    log.error('Failed to list SDK keys', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const parsed = await validateBody(request, createKeySchema);
  if (!parsed.success) {
    return parsed.response as NextResponse;
  }

  try {
    const projectAccess = await requireSdkProjectAccess(parsed.data.projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }
    const { project } = projectAccess;

    // Generate the public API key
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 11); // "pk_" + first 8 hex chars
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // Use repo function
    const apiKey = await createPublicApiKey(parsed.data.projectId, project.tenantId, {
      keyPrefix,
      keyHash,
      name: parsed.data.name,
      allowedOrigins: parsed.data.allowedOrigins ?? null,
      permissions: {
        chat: parsed.data.permissions?.chat ?? DEFAULT_API_KEY_PERMISSIONS.chat,
        voice: parsed.data.permissions?.voice ?? DEFAULT_API_KEY_PERMISSIONS.voice,
      },
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    // Return the raw key ONLY on creation (never stored/retrievable again)
    return NextResponse.json(
      {
        ...formatApiKeyResponse(apiKey),
        key: rawKey,
      },
      { status: 201 },
    );
  } catch (error) {
    log.error('Failed to create SDK key', {
      error: error instanceof Error ? error.message : String(error),
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List SDK API keys',
    description: 'Retrieve active SDK API keys for a project.',
    query: queryParamsSchema,
    response: listKeysResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create SDK API key',
    description: 'Create a new public API key for SDK access. The raw key is only returned once.',
    body: createKeySchema,
    response: createKeyResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
