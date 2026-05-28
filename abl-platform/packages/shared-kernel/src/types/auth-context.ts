/**
 * Discriminated Auth Context Types
 *
 * Three auth flows produce three distinct context types:
 * - PlatformMemberContext (User JWT) — RBAC permission-based access
 * - ChannelUserContext (SDK Session Token) — ownership-based access
 * - ApiKeyContext (API Key) — scope-based access
 */

import type { AuthType, ChannelArtifactType, IdentityTier, VerificationMethod } from './index.js';

// ─── CallerIdentity ──────────────────────────────────────────────
/** End-user identity carried by SDK session tokens. */
export interface CallerIdentity {
  customerId?: string;
  anonymousId?: string;
  contactId?: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
}

// ─── Base ────────────────────────────────────────────────────────
interface AuthContextBase {
  tenantId: string;
  orgId?: string;
  authType: AuthType;
  permissions: string[];
}

// ─── Flow 1: Platform Member ─────────────────────────────────────
export interface PlatformMemberContext extends AuthContextBase {
  authType: 'user';
  userId: string;
  role: string;
  isSuperAdmin: boolean;
}

// ─── Flow 2: Channel End-User ────────────────────────────────────
export interface ChannelUserContext extends AuthContextBase {
  authType: 'sdk_session';
  projectId: string;
  channelId: string;
  deploymentId?: string;
  sessionId?: string;
  callerIdentity: CallerIdentity;
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
}

// ─── Flow 3: Machine-to-Machine ──────────────────────────────────
export interface ApiKeyContext extends AuthContextBase {
  authType: 'api_key';
  apiKeyId: string;
  clientId: string;
  createdBy: string;
  projectScope?: string[];
  environmentScope?: string[];
}

// ─── Union ───────────────────────────────────────────────────────
export type AuthContext = PlatformMemberContext | ChannelUserContext | ApiKeyContext;

// ─── Type Guards ─────────────────────────────────────────────────
export function isPlatformMember(ctx: AuthContext): ctx is PlatformMemberContext {
  return ctx.authType === 'user';
}
export function isChannelUser(ctx: AuthContext): ctx is ChannelUserContext {
  return ctx.authType === 'sdk_session';
}
export function isApiKey(ctx: AuthContext): ctx is ApiKeyContext {
  return ctx.authType === 'api_key';
}
