/**
 * @agent-platform/shared-auth
 *
 * Auth middleware, permission guards, RBAC, and session ownership.
 * Extracted from @agent-platform/shared for focused decomposition.
 */

// ─── Types ────────────────────────────────────────────────────────────
export type {
  JWTPayload,
  AuthType,
  TenantContextData,
  SDKSessionTokenPayload,
  AuthUser,
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  SDKAuthScope,
  SDKSessionSource,
  VerificationMethod,
} from './types/index.js';

export type {
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  CallerIdentity,
} from './types/auth-context.js';

export { isPlatformMember, isChannelUser, isApiKey } from './types/auth-context.js';

// ─── SDK Session State ───────────────────────────────────────────────
export {
  resolveSdkSessionPrincipal,
  resolveSdkSessionAuthScope,
  resolveSdkSessionIdentityState,
  type SdkSessionIdentityState,
} from './sdk-session-state.js';

// ─── Purpose-Scoped JWTs ─────────────────────────────────────────────
export {
  AuthError,
  PLATFORM_JWT_ISSUER,
  PLATFORM_ACCESS_TOKEN_AUDIENCE,
  SDK_SESSION_TOKEN_AUDIENCE,
  STUDIO_SESSION_TOKEN_AUDIENCE,
  FEEDBACK_TOKEN_AUDIENCE,
  GUPSHUP_WEBHOOK_TOKEN_AUDIENCE,
  FEEDBACK_TOKEN_PURPOSE,
  GUPSHUP_WEBHOOK_TOKEN_PURPOSE,
  signPlatformAccessToken,
  verifyPlatformAccessToken,
  signSDKSessionToken,
  verifySDKSessionToken,
  verifyStudioSessionToken,
  signFeedbackToken,
  verifyFeedbackToken,
  signGupshupWebhookToken,
  verifyGupshupWebhookToken,
  signCitationToken,
  verifyCitationToken,
  CITATION_TOKEN_AUDIENCE,
  CITATION_TOKEN_PURPOSE,
  type AuthErrorCode,
  type FeedbackTokenPayload,
  type GupshupWebhookTokenPayload,
  type CitationTokenPayload,
} from './purpose-jwt.js';

// ─── SDK Token Envelopes ─────────────────────────────────────────────
export {
  SDKTokenEnvelopeError,
  createLocalSdkJweKeyHandle,
  isCompactJwe,
  readCompactJweProtectedHeader,
  unwrapCompactToken,
  wrapCompactToken,
  type CreateLocalSdkJweKeyHandleInput,
  type SDKJweKeyHandle,
  type SDKJweProtectedHeader,
  type SDKTokenEnvelopeErrorCode,
  type SDKTokenEnvelopeMode,
  type SDKTokenEnvelopePurpose,
  type UnwrapCompactTokenInput,
  type WrapCompactTokenInput,
} from './sdk-token-envelope.js';

// ─── Middleware ────────────────────────────────────────────────────────
export * from './middleware/index.js';

// ─── Services ────────────────────────────────────────────────────────
export {
  resolveTenantContext,
  type TenantResolutionInput,
  type TenantResolutionDeps,
} from './services/tenant-resolver.js';

// ─── RBAC ─────────────────────────────────────────────────────────────
export * from './rbac/index.js';

// ─── Platform Key Scopes ──────────────────────────────────────────────
export * from './scopes/index.js';

// ─── IdP Token Validation ─────────────────────────────────────────────
export * from './idp/index.js';
