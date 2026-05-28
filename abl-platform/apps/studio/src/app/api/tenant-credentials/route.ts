/**
 * GET  /api/tenant-credentials - List tenant's org-level credentials
 * POST /api/tenant-credentials - Create a new tenant credential
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findLLMCredentials, createLLMCredential } from '@/repos/credential-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const createTenantCredentialSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum([
    'openai',
    'anthropic',
    'azure',
    'microsoft_foundry_anthropic',
    'google',
    'gemini',
    'groq',
    'cohere',
    'mistral',
    'openrouter',
    'fireworks',
    'togetherai',
    'perplexity',
    'deepseek',
    'xai',
    'bedrock',
    'ultravox',
    'vertex',
    'vertex_ai',
    'google_vertex',
    'custom',
  ]),
  apiKey: z.string().min(1),
  endpoint: z.string().url().optional(),
  customHeaders: z.record(z.string()).optional(),
  authType: z
    .enum(['api_key', 'oauth2', 'azure_ad', 'aws_iam', 'custom_header'])
    .default('api_key'),
  authConfig: z.record(z.unknown()).optional(),
});

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials.
  // Return 404 (not 403) to avoid leaking resource existence to unauthorized users.
  if (user.role !== 'ADMIN' && user.role !== 'OWNER') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!user.tenantId) {
    return NextResponse.json({ error: 'No tenant context' }, { status: 400 });
  }

  try {
    const credentials = await findLLMCredentials({
      credentialScope: 'tenant',
      ownerId: user.tenantId,
    });

    const safeCreds = credentials.map((c: any) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      authType: c.authType,
      isActive: c.isActive,
      isDefault: c.isDefault,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastUsedAt: c.lastUsedAt,
    }));

    return NextResponse.json({ credentials: safeCreds });
  } catch (error) {
    console.error('[TenantCredentials] List error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials.
  // Return 404 (not 403) to avoid leaking resource existence to unauthorized users.
  if (user.role !== 'ADMIN' && user.role !== 'OWNER') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!user.tenantId) {
    return NextResponse.json({ error: 'No tenant context' }, { status: 400 });
  }

  const body = await request.json();
  const result = createTenantCredentialSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    // Pass plaintext — the Mongoose encryption plugin on LLMCredential
    // handles encryption transparently in the pre-save hook.
    const credential = await createLLMCredential({
      tenantId: user.tenantId,
      credentialScope: 'tenant',
      ownerId: user.tenantId,
      provider: result.data.provider,
      name: result.data.name,
      encryptedApiKey: result.data.apiKey,
      encryptedEndpoint: result.data.endpoint || null,
      customHeaders: result.data.customHeaders || null,
      authType: result.data.authType,
      authConfig: result.data.authConfig ? JSON.stringify(result.data.authConfig) : null,
    });

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.CREDENTIAL_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { credentialId: credential.id, provider: result.data.provider, scope: 'tenant' },
    });

    return NextResponse.json(
      {
        id: credential.id,
        name: credential.name,
        provider: credential.provider,
        authType: credential.authType,
        isActive: credential.isActive,
        isDefault: credential.isDefault,
        createdAt: credential.createdAt,
      },
      { status: 201 },
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      return NextResponse.json(
        { error: 'A credential with this name and provider already exists' },
        { status: 409 },
      );
    }
    console.error('[TenantCredentials] Create error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = getHandler;
export const POST = postHandler;
