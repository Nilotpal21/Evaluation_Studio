/**
 * GET    /api/credentials/:id - Get credential details (masked)
 * PATCH  /api/credentials/:id - Update credential
 * DELETE /api/credentials/:id - Delete credential
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import {
  findLLMCredentialById,
  updateLLMCredential,
  deleteLLMCredential,
} from '@/repos/credential-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

type RouteParams = { params: Promise<{ id: string }> };

const updateCredentialSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  apiKey: z.string().min(1).optional(),
  endpoint: z.string().url().optional().nullable(),
  authType: z.enum(['api_key', 'oauth2', 'azure_ad', 'custom_header']).optional(),
  authConfig: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const getCredentialResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  authType: z.string(),
  maskedEndpoint: z.string().nullable(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullable(),
  lastValidatedAt: z.date().nullable(),
});

const updateCredentialResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  authType: z.string(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  updatedAt: z.date(),
});

const deleteCredentialResponseSchema = z.object({
  success: z.boolean(),
});

function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const credential = await findLLMCredentialById(id, user.tenantId!);

    if (!credential || credential.credentialScope !== 'user' || credential.ownerId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // The Mongoose encryption plugin (v3 tenant-scoped) auto-decrypts
    // encryptedEndpoint in the post-find hook. Mask it for display.
    let maskedEndpoint: string | null = null;
    if (credential.encryptedEndpoint) {
      maskedEndpoint = maskValue(credential.encryptedEndpoint);
    }

    return NextResponse.json({
      id: credential.id,
      name: credential.name,
      provider: credential.provider,
      authType: credential.authType,
      maskedEndpoint,
      isActive: credential.isActive,
      isDefault: credential.isDefault,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      lastUsedAt: credential.lastUsedAt,
      lastValidatedAt: credential.lastValidatedAt,
    });
  } catch (error) {
    console.error('[Credentials] Get error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const body = await request.json();
  const result = updateCredentialSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    // Verify ownership
    const existing = await findLLMCredentialById(id, user.tenantId!);
    if (!existing || existing.credentialScope !== 'user' || existing.ownerId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Store plaintext — the Mongoose encryption plugin (v3 tenant-scoped)
    // handles encryption transparently in the pre-save hook.
    // Do NOT double-encrypt with user-scoped encryption here.
    const updateData: Record<string, unknown> = {};

    if (result.data.name !== undefined) updateData.name = result.data.name;
    if (result.data.authType !== undefined) updateData.authType = result.data.authType;
    if (result.data.isActive !== undefined) updateData.isActive = result.data.isActive;
    if (result.data.isDefault !== undefined) updateData.isDefault = result.data.isDefault;
    if (result.data.authConfig !== undefined) {
      updateData.authConfig = JSON.stringify(result.data.authConfig);
    }
    if (result.data.apiKey !== undefined) {
      updateData.encryptedApiKey = result.data.apiKey;
    }
    if (result.data.endpoint !== undefined) {
      updateData.encryptedEndpoint = result.data.endpoint || null;
    }

    const credential = await updateLLMCredential(id, user.tenantId!, updateData);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.CREDENTIAL_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { credentialId: id },
    });

    return NextResponse.json({
      id: credential.id,
      name: credential.name,
      provider: credential.provider,
      authType: credential.authType,
      isActive: credential.isActive,
      isDefault: credential.isDefault,
      updatedAt: credential.updatedAt,
    });
  } catch (error) {
    console.error('[Credentials] Update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const existing = await findLLMCredentialById(id, user.tenantId!);
    if (!existing || existing.credentialScope !== 'user' || existing.ownerId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await deleteLLMCredential(id, user.tenantId!);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.CREDENTIAL_DELETED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { credentialId: id, provider: existing.provider },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Credentials] Delete error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get credential details',
    description:
      'Retrieve details of a specific LLM credential with masked sensitive data (endpoint).',
    response: getCredentialResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PATCH = withOpenAPI(
  {
    summary: 'Update credential',
    description:
      'Update an LLM credential. Can modify name, apiKey, endpoint, authType, authConfig, isActive, or isDefault.',
    body: updateCredentialSchema,
    response: updateCredentialResponseSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Delete credential',
    description: 'Delete an LLM credential. Requires ownership verification.',
    response: deleteCredentialResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
