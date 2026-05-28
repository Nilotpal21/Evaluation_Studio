import type {
  CallerContext,
  IdentityTier,
  SDKAuthScope,
  VerificationMethod,
} from '@agent-platform/shared-auth';

const VERIFICATION_METHODS: VerificationMethod[] = [
  'none',
  'cookie',
  'caller_id',
  'hmac',
  'otp',
  'oauth',
  'provider',
];

function isIdentityTier(value: unknown): value is IdentityTier {
  return value === 0 || value === 1 || value === 2;
}

function isVerificationMethod(value: unknown): value is VerificationMethod {
  return typeof value === 'string' && VERIFICATION_METHODS.includes(value as VerificationMethod);
}

export interface StoredSessionCallerContextSource {
  tenantId?: unknown;
  channel?: unknown;
  customerId?: unknown;
  sessionPrincipalId?: unknown;
  anonymousId?: unknown;
  contactId?: unknown;
  channelArtifact?: unknown;
  channelId?: unknown;
  identityTier?: unknown;
  verificationMethod?: unknown;
}

function resolveSdkAuthScope(params: {
  customerId?: string;
  sessionPrincipalId?: string;
}): SDKAuthScope | undefined {
  if (params.customerId) {
    return 'user';
  }

  if (params.sessionPrincipalId) {
    return 'session';
  }

  return undefined;
}

export function buildStoredSessionCallerContext(
  session: StoredSessionCallerContextSource,
  tenantId: string,
): CallerContext | undefined {
  const customerId = typeof session.customerId === 'string' ? session.customerId : undefined;
  const sessionPrincipalId =
    typeof session.sessionPrincipalId === 'string'
      ? session.sessionPrincipalId
      : typeof session.anonymousId === 'string'
        ? session.anonymousId
        : undefined;
  const anonymousId =
    typeof session.anonymousId === 'string' ? session.anonymousId : sessionPrincipalId;
  const channelArtifact =
    typeof session.channelArtifact === 'string' ? session.channelArtifact : undefined;

  if (!customerId && !anonymousId && !channelArtifact) {
    return undefined;
  }

  return {
    tenantId: typeof session.tenantId === 'string' ? session.tenantId : tenantId,
    channel: typeof session.channel === 'string' ? session.channel : 'unknown',
    customerId,
    contactId: typeof session.contactId === 'string' ? session.contactId : undefined,
    sessionPrincipalId,
    anonymousId,
    channelArtifact,
    channelId: typeof session.channelId === 'string' ? session.channelId : undefined,
    identityTier: isIdentityTier(session.identityTier) ? session.identityTier : 0,
    verificationMethod: isVerificationMethod(session.verificationMethod)
      ? session.verificationMethod
      : 'none',
    authScope: resolveSdkAuthScope({
      customerId,
      sessionPrincipalId: sessionPrincipalId ?? anonymousId,
    }),
  };
}
