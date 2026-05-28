import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  signSdkBootstrapArtifact,
  verifySdkBootstrapArtifact,
  type SDKShareBootstrapArtifact,
} from '@agent-platform/shared';
import {
  isStudioSdkSessionPermission,
  getStudioSdkBootstrapSecret,
  MISSING_STUDIO_SDK_BOOTSTRAP_SECRET_ERROR,
} from '@/lib/studio-sdk-session';

const log = createLogger('sdk-share-token');

export type ShareTokenPayload = SDKShareBootstrapArtifact;

export function signShareToken(
  payload: Omit<ShareTokenPayload, 'type'> | ShareTokenPayload,
): string {
  const secret = getStudioSdkBootstrapSecret();
  if (!secret) {
    throw new Error(MISSING_STUDIO_SDK_BOOTSTRAP_SECRET_ERROR);
  }

  return signSdkBootstrapArtifact(
    {
      ...payload,
      type: 'share',
    },
    secret,
  );
}

export function verifyShareToken(token: string): ShareTokenPayload | null {
  const secret = getStudioSdkBootstrapSecret();
  if (!secret) {
    log.error('Cannot verify share token: bootstrap signing secret not configured');
    return null;
  }

  const payload = verifySdkBootstrapArtifact(token, secret);
  if (!payload || payload.type !== 'share') {
    return null;
  }

  if (
    payload.permissions &&
    !payload.permissions.every((permission) => isStudioSdkSessionPermission(permission))
  ) {
    return null;
  }

  return payload;
}
