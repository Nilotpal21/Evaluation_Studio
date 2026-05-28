import { NextResponse } from 'next/server';
import type { IAuthProfile, ILLMCredential } from '@agent-platform/database/models';
import { ensureDb } from '@/lib/ensure-db';
import {
  canUseAuthProfile,
  isAuthProfileExpired,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';

const MODEL_AUTH_TYPES = ['api_key', 'bearer'] as const;

interface ModelConfigCredentialActor {
  id: string;
  permissions?: string[];
}

export interface ValidateModelConfigCredentialRefsParams {
  projectId: string;
  tenantId: string;
  user: ModelConfigCredentialActor;
  provider?: string | null;
  authProfileId?: string | null;
  credentialId?: string | null;
}

function normalizeRef(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function providerMatches(modelProvider: string | null | undefined, credential: ILLMCredential) {
  if (!modelProvider || !credential.provider) return true;
  const modelProviderKey = modelProvider.trim().toLowerCase();
  const credentialProviderKey = credential.provider.trim().toLowerCase();
  return (
    modelProviderKey === credentialProviderKey ||
    modelProviderKey === 'custom' ||
    credentialProviderKey === 'custom'
  );
}

export async function validateModelConfigCredentialRefs({
  projectId,
  tenantId,
  user,
  provider,
  authProfileId,
  credentialId,
}: ValidateModelConfigCredentialRefsParams): Promise<NextResponse | null> {
  const normalizedAuthProfileId = normalizeRef(authProfileId);
  const normalizedCredentialId = normalizeRef(credentialId);

  if (!normalizedAuthProfileId && !normalizedCredentialId) {
    return null;
  }

  await ensureDb();
  const { AuthProfile, LLMCredential } = await import('@agent-platform/database/models');

  if (normalizedAuthProfileId) {
    const profile = (await AuthProfile.findOne({
      _id: normalizedAuthProfileId,
      tenantId,
      status: 'active',
      authType: { $in: [...MODEL_AUTH_TYPES] },
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    })) as IAuthProfile | null;

    if (!profile || !canUseAuthProfile(profile, user)) {
      return NextResponse.json({ error: 'Auth profile not found' }, { status: 404 });
    }

    if (isAuthProfileExpired(profile)) {
      return NextResponse.json(
        { error: 'Auth profile has expired and must be renewed before use' },
        { status: 400 },
      );
    }
  }

  if (normalizedCredentialId) {
    const credential = (await LLMCredential.findOne({
      _id: normalizedCredentialId,
      tenantId,
      isActive: true,
      $or: [
        { credentialScope: 'tenant', ownerId: tenantId },
        { credentialScope: 'user', ownerId: user.id },
      ],
    })) as ILLMCredential | null;

    if (!credential) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }

    if (!providerMatches(provider, credential)) {
      return NextResponse.json(
        { error: 'Credential provider does not match model provider' },
        { status: 400 },
      );
    }
  }

  return null;
}
