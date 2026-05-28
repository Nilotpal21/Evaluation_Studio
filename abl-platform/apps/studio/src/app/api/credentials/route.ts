/**
 * GET  /api/credentials - List user's LLM credentials
 * POST /api/credentials - Create a new LLM credential
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findLLMCredentials, createLLMCredential } from '@/repos/credential-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const CREDENTIAL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\s\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

const createCredentialSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Credential name is required')
    .max(100, 'Credential name must be 100 characters or less')
    .regex(
      CREDENTIAL_NAME_PATTERN,
      'Credential name must start and end with a letter or number, and can only contain letters, numbers, spaces, hyphens, underscores, and periods',
    ),
  provider: z.enum([
    'openai',
    'anthropic',
    'azure',
    'microsoft_foundry_anthropic',
    'google',
    'openrouter',
    'groq',
    'custom',
  ]),
  apiKey: z.string().min(1, 'API key is required'),
  endpoint: z.string().url().optional(),
  authType: z.enum(['api_key', 'oauth2', 'azure_ad', 'custom_header']).default('api_key'),
  authConfig: z.record(z.unknown()).optional(),
});

const credentialItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  authType: z.string(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

const listCredentialsResponseSchema = z.object({
  credentials: z.array(credentialItemSchema),
});

const createCredentialResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  authType: z.string(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.date(),
});

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const credentials = await findLLMCredentials({
      credentialScope: 'user',
      ownerId: user.id,
    });

    // Return only safe fields (no encrypted data)
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
    console.error('[Credentials] List error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const body = await request.json();
  const result = createCredentialSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    // Store plaintext — the Mongoose encryption plugin (v3 tenant-scoped)
    // handles encryption transparently in the pre-save hook.
    // Do NOT double-encrypt with user-scoped encryption here.
    const credential = await createLLMCredential({
      tenantId: user.tenantId || user.id,
      credentialScope: 'user',
      ownerId: user.id,
      provider: result.data.provider,
      name: result.data.name,
      encryptedApiKey: result.data.apiKey,
      encryptedEndpoint: result.data.endpoint || null,
      authType: result.data.authType,
      authConfig: result.data.authConfig ? JSON.stringify(result.data.authConfig) : null,
    });

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.CREDENTIAL_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { credentialId: credential.id, provider: result.data.provider },
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
    console.error('[Credentials] Create error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List LLM credentials',
    description:
      'Retrieve all LLM credentials for the authenticated user. Returns only safe fields (no encrypted data).',
    response: listCredentialsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create LLM credential',
    description: 'Create a new LLM credential with encrypted API key and optional endpoint.',
    body: createCredentialSchema,
    response: createCredentialResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
