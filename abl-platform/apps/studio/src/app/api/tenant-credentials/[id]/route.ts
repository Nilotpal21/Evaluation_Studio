/**
 * GET    /api/tenant-credentials/[id] - Get credential detail
 * PATCH  /api/tenant-credentials/[id] - Update a tenant credential
 * DELETE /api/tenant-credentials/[id] - Delete a tenant credential
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import {
  findLLMCredentialById,
  updateLLMCredential,
  deleteLLMCredential,
  removeConnectionsByCredential,
} from '@/repos/credential-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const updateTenantCredentialSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  apiKey: z.string().min(1).optional(),
  endpoint: z.string().url().nullable().optional(),
  customHeaders: z.record(z.string()).nullable().optional(),
  authType: z.enum(['api_key', 'oauth2', 'azure_ad', 'custom_header']).optional(),
  authConfig: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

async function getHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials.
  // Return 404 (not 403) to avoid leaking resource existence to unauthorized users.
  if (user.role !== 'ADMIN' && user.role !== 'OWNER') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await params;
  const credential = await findLLMCredentialById(id, user.tenantId!);

  if (
    !credential ||
    credential.credentialScope !== 'tenant' ||
    credential.ownerId !== user.tenantId
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: credential.id,
    name: credential.name,
    provider: credential.provider,
    authType: credential.authType,
    isActive: credential.isActive,
    isDefault: credential.isDefault,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    lastUsedAt: credential.lastUsedAt,
  });
}

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials.
  // Return 404 (not 403) to avoid leaking resource existence to unauthorized users.
  if (user.role !== 'ADMIN' && user.role !== 'OWNER') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await params;
  const credential = await findLLMCredentialById(id, user.tenantId!);

  if (
    !credential ||
    credential.credentialScope !== 'tenant' ||
    credential.ownerId !== user.tenantId
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await request.json();
  const result = updateTenantCredentialSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  const updates: any = {};
  if (result.data.name) updates.name = result.data.name;
  if (result.data.authType) updates.authType = result.data.authType;
  if (result.data.authConfig) updates.authConfig = JSON.stringify(result.data.authConfig);
  if (result.data.isActive !== undefined) updates.isActive = result.data.isActive;
  if (result.data.isDefault !== undefined) updates.isDefault = result.data.isDefault;
  if (result.data.customHeaders !== undefined) updates.customHeaders = result.data.customHeaders;

  // Pass plaintext — the Mongoose encryption plugin on LLMCredential
  // handles encryption transparently via the pre-save hook.
  if (result.data.apiKey) {
    updates.encryptedApiKey = result.data.apiKey;
  }
  if (result.data.endpoint !== undefined) {
    updates.encryptedEndpoint = result.data.endpoint || null;
  }

  const updated = await updateLLMCredential(id, user.tenantId!, updates);

  await logAuditEvent({
    userId: user.id,
    action: AuditActions.CREDENTIAL_UPDATED,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: { credentialId: id, scope: 'tenant' },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    provider: updated.provider,
    authType: updated.authType,
    isActive: updated.isActive,
    isDefault: updated.isDefault,
    updatedAt: updated.updatedAt,
  });
}

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials.
  // Return 404 (not 403) to avoid leaking resource existence to unauthorized users.
  if (user.role !== 'ADMIN' && user.role !== 'OWNER') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await params;
  const credential = await findLLMCredentialById(id, user.tenantId!);

  if (
    !credential ||
    credential.credentialScope !== 'tenant' ||
    credential.ownerId !== user.tenantId
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Cascade: remove connections referencing this credential from all models
  const removedCount = await removeConnectionsByCredential(id, user.tenantId!);

  await deleteLLMCredential(id, user.tenantId!);

  await logAuditEvent({
    userId: user.id,
    action: AuditActions.CREDENTIAL_DELETED,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: {
      credentialId: id,
      provider: credential.provider,
      scope: 'tenant',
      connectionsRemoved: removedCount,
    },
  });

  return NextResponse.json({ success: true, connectionsRemoved: removedCount });
}

export const GET = getHandler;
export const PATCH = patchHandler;
export const DELETE = deleteHandler;
