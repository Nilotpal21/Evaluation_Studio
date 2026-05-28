/**
 * Auth-related types for @agent-platform/shared-auth.
 *
 * These are the subset of shared types needed by auth middleware.
 * Canonical definitions live here; @agent-platform/shared re-exports them
 * for backwards compatibility.
 */

/**
 * JWT access token payload (Scenario 1: User login).
 */
export interface JWTPayload {
  sub: string; // User ID
  email: string;
  type: 'access' | 'mfa_pending';
  tokenClass?: 'user'; // Distinguishes from other token types
  tenantId?: string; // REQUIRED in new tokens -- scoped to active tenant
  projectId?: string; // Optional active project scope for project-bound internal hops
  orgId?: string; // Parent organization (if tenant belongs to one)
  role?: string; // Resolved TenantMember role: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
  name?: string | null;
  internal?: boolean;
  isSuperAdmin?: boolean;
  iat?: number;
  exp?: number;
}

/**
 * Auth type -- which authentication path was used.
 */
export type AuthType = 'user' | 'sdk_session' | 'api_key';

export type ChannelArtifactType =
  | 'caller_id'
  | 'cookie'
  | 'device_id'
  | 'psid'
  | 'aad_id'
  | 'phone'
  | 'email_thread'
  | 'api_client'
  | 'sip_uri';

export type IdentityTier = 0 | 1 | 2;

/**
 * Scope for OAuth/auth-preflight artifacts issued to SDK callers.
 * - session: anonymous/metadata-only callers; grants are limited to one SDK session principal
 * - user: verified end-user identity; grants may be reused across sessions for that user
 */
export type SDKAuthScope = 'session' | 'user';

export type VerificationMethod =
  | 'none'
  | 'cookie'
  | 'caller_id'
  | 'hmac'
  | 'server_secret'
  | 'otp'
  | 'oauth'
  | 'provider'
  | 'email_link'
  | 'webhook';

export type SDKSessionSource = 'sdk' | 'channel' | 'public' | 'studio';

/**
 * Tenant context data propagated via AsyncLocalStorage.
 * All three auth flows converge to this shape in the request pipeline.
 */
export interface TenantContextData {
  tenantId: string;
  orgId?: string;
  userId: string; // Effective auth principal (platform user, verified SDK user, or SDK session principal)
  role: string; // TenantMember role (scenario 1) or "sdk_session" / "api_key" (scenario 2/3)
  permissions: string[]; // Resolved permissions (all scenarios)
  authType: AuthType; // Which auth path was used
  isSuperAdmin: boolean;
  // SDK-specific (scenario 2 only)
  projectId?: string;
  deploymentId?: string;
  channelId?: string;
  sessionId?: string;
  sessionPrincipal?: string;
  // SDK identity fields (scenario 2 only -- propagated from SDKSessionTokenPayload)
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  authScope?: SDKAuthScope;
  verifiedUserId?: string;
  contactId?: string;
  channelArtifact?: string; // Pre-hashed artifact from sdk/init
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
  // API key-specific (scenario 3 only)
  apiKeyId?: string;
  clientId?: string; // Identifies integrating system
  projectScope?: string[]; // Restricted project IDs
  environmentScope?: string[]; // Restricted environments
}

/**
 * SDK session token payload (Scenario 2: pk_* key exchange -> short-lived session token).
 */
export interface SDKSessionTokenPayload {
  type: 'sdk_session';
  /** Session ownership source discriminator. End-user SDK routes reject studio-scoped tokens. */
  source?: SDKSessionSource;
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  environment?: string;
  channelId: string;
  sessionId?: string;
  /** Stable SDK session principal used for anonymous ownership and session-scoped auth. */
  sessionPrincipal?: string;
  contactId?: string;
  permissions: string[];
  /** User context for personalization (caller attributes, not test mocks) */
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
  /** Verified end-user identity. Only this field may enable user-scoped behavior. */
  verifiedUserId?: string;
  // Session identity fields (Phase 1)
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  authScope?: SDKAuthScope;
  channelArtifact?: string;
  bootstrapType?: 'public_key' | 'studio_preview' | 'studio_share' | 'customer';
  /** Original public bootstrap key used to mint the session, when applicable. */
  bootstrapKeyId?: string;
  /** Source bootstrap artifact expiry in epoch milliseconds; used to cap refresh for preview/share. */
  bootstrapExpiresAt?: number;
  /** Token envelope used when this payload was issued for browser-carried SDK auth. */
  tokenEnvelope?: 'signed' | 'jwe';
  iat: number;
  exp: number;
}

/**
 * Minimal user shape for request attachment.
 * Consumers should cast to their full User type as needed.
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface CallerContext {
  tenantId: string;
  contactId?: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  /** Explicit SDK session principal. Persisted session rows still mirror this in anonymousId. */
  sessionPrincipalId?: string;
  anonymousId?: string;
  customerId?: string;
  channel: string;
  channelId?: string;
  initiatedById?: string;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  authScope?: SDKAuthScope;
  sourceIp?: string;
  userAgent?: string;
  /** Contact display name resolved from the Contact entity during session init. */
  contactDisplayName?: string | null;
  /** Cross-session contact dataValues, pre-populated from ContactContext on session init. */
  contactContext?: Record<string, unknown>;
  /** Cross-session contact preferences, pre-populated from ContactContext on session init. */
  contactPreferences?: Record<string, unknown>;
}
