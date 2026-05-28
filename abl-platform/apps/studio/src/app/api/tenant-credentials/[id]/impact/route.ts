/**
 * GET /api/tenant-credentials/[id]/impact
 *
 * Returns models that have connections referencing this credential.
 * Used to show a warning before deleting a credential.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findLLMCredentialById, findModelsUsingCredential } from '@/repos/credential-repo';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const credential = await findLLMCredentialById(id, user.tenantId!);

  if (
    !credential ||
    credential.credentialScope !== 'tenant' ||
    credential.ownerId !== user.tenantId
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const impactedModels = await findModelsUsingCredential(id, user.tenantId!);

  return NextResponse.json({
    success: true,
    credentialId: id,
    impactedModels,
  });
}
