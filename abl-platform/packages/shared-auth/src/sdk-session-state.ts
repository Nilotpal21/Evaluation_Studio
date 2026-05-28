import type { SDKAuthScope, SDKSessionTokenPayload } from './types/index.js';

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSdkSessionPrincipal(
  payload: Pick<SDKSessionTokenPayload, 'sessionPrincipal' | 'sessionId'>,
): string | undefined {
  return (
    normalizeOptionalString(payload.sessionPrincipal) ?? normalizeOptionalString(payload.sessionId)
  );
}

export function resolveSdkSessionAuthScope(
  payload: Pick<SDKSessionTokenPayload, 'authScope' | 'verifiedUserId'>,
): SDKAuthScope {
  if (payload.authScope === 'session' || payload.authScope === 'user') {
    return payload.authScope;
  }

  return normalizeOptionalString(payload.verifiedUserId) ? 'user' : 'session';
}

export type SdkSessionIdentityState =
  | {
      success: true;
      sessionPrincipal: string;
      authScope: SDKAuthScope;
      principalUserId: string;
      verifiedUserId?: string;
    }
  | {
      success: false;
      reason:
        | 'missing_verified_user'
        | 'missing_session_principal'
        | 'missing_project_scope'
        | 'missing_channel_scope';
    };

export function resolveSdkSessionIdentityState(
  payload: Pick<
    SDKSessionTokenPayload,
    'sessionPrincipal' | 'sessionId' | 'authScope' | 'verifiedUserId' | 'projectId' | 'channelId'
  >,
): SdkSessionIdentityState {
  if (!normalizeOptionalString(payload.projectId)) {
    return { success: false, reason: 'missing_project_scope' };
  }

  if (!normalizeOptionalString(payload.channelId)) {
    return { success: false, reason: 'missing_channel_scope' };
  }

  const verifiedUserId = normalizeOptionalString(payload.verifiedUserId);
  const authScope = resolveSdkSessionAuthScope({
    authScope: payload.authScope,
    verifiedUserId,
  });

  if (authScope === 'user' && !verifiedUserId) {
    return { success: false, reason: 'missing_verified_user' };
  }

  const sessionPrincipal = resolveSdkSessionPrincipal(payload);
  if (!sessionPrincipal) {
    return { success: false, reason: 'missing_session_principal' };
  }

  return {
    success: true,
    sessionPrincipal,
    authScope,
    principalUserId: authScope === 'user' ? verifiedUserId! : sessionPrincipal,
    ...(verifiedUserId ? { verifiedUserId } : {}),
  };
}
