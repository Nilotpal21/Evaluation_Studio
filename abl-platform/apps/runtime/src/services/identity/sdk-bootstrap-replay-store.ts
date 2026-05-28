import { createLogger } from '@abl/compiler/platform';

const log = createLogger('sdk-bootstrap-replay-store');

interface ConsumeBootstrapJtiParams {
  jti: string;
  tenantId: string;
  projectId: string;
  channelId: string;
  expiresAtMs: number;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'number' &&
    (error as { code: number }).code === 11000
  );
}

export async function consumeSdkBootstrapJti(
  params: ConsumeBootstrapJtiParams,
): Promise<{ success: true } | { success: false; reason: 'expired' | 'replayed' | 'unavailable' }> {
  if (!params.jti.trim()) {
    return { success: false, reason: 'replayed' };
  }

  const expiresAt = new Date(params.expiresAtMs);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { success: false, reason: 'expired' };
  }

  try {
    const { SDKBootstrapArtifactNonce } = await import('@agent-platform/database/models');
    await SDKBootstrapArtifactNonce.create({
      _id: params.jti,
      tenantId: params.tenantId,
      projectId: params.projectId,
      channelId: params.channelId,
      expiresAt,
    });
    return { success: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { success: false, reason: 'replayed' };
    }

    log.error('Failed to persist SDK bootstrap replay guard', {
      jti: params.jti,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, reason: 'unavailable' };
  }
}
