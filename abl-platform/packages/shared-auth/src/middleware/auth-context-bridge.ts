/**
 * Bridge functions for TenantContextData <-> AuthContext conversion.
 * Used during migration from flat TenantContextData to discriminated AuthContext.
 */

import type { TenantContextData } from '../types/index.js';
import type {
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  CallerIdentity,
} from '../types/auth-context.js';

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveSdkVerifiedUserId(ctx: TenantContextData): string | undefined {
  return normalizeOptionalString(ctx.verifiedUserId);
}

function resolveSdkAuthScope(
  ctx: TenantContextData,
  verifiedUserId: string | undefined,
): 'session' | 'user' {
  if (ctx.authScope === 'session') {
    return 'session';
  }

  if (ctx.authScope === 'user') {
    return verifiedUserId ? 'user' : 'session';
  }

  return verifiedUserId ? 'user' : 'session';
}

function resolveSdkSessionPrincipalId(
  ctx: TenantContextData,
  authScope: 'session' | 'user',
): string | undefined {
  return (
    normalizeOptionalString(ctx.sessionPrincipal) ??
    normalizeOptionalString(ctx.sessionId) ??
    (authScope === 'session' ? normalizeOptionalString(ctx.userId) : undefined)
  );
}

/**
 * Convert legacy TenantContextData to typed AuthContext.
 * Extracts auth-type-specific fields into the correct discriminated variant.
 */
export function toAuthContext(ctx: TenantContextData): AuthContext {
  switch (ctx.authType) {
    case 'user':
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'user',
        permissions: ctx.permissions,
        userId: ctx.userId,
        role: ctx.role,
        isSuperAdmin: ctx.isSuperAdmin,
      } satisfies PlatformMemberContext;

    case 'sdk_session': {
      const verifiedUserId = resolveSdkVerifiedUserId(ctx);
      const authScope = resolveSdkAuthScope(ctx, verifiedUserId);
      const sessionPrincipalId = resolveSdkSessionPrincipalId(ctx, authScope);
      const identityTier = ctx.identityTier ?? 0;
      const callerIdentity: CallerIdentity = {
        customerId: verifiedUserId,
        // Persisted session rows still mirror this under anonymousId for compatibility.
        anonymousId: authScope === 'session' ? sessionPrincipalId : undefined,
        contactId: ctx.contactId,
        channelArtifact: ctx.channelArtifact,
        sessionPrincipalId,
        identityTier,
        verificationMethod: ctx.verificationMethod ?? 'none',
        authScope,
      };
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'sdk_session',
        permissions: ctx.permissions,
        projectId: ctx.projectId ?? '',
        channelId: ctx.channelId ?? '',
        deploymentId: ctx.deploymentId,
        sessionId: ctx.sessionId ?? sessionPrincipalId,
        callerIdentity,
        userContext: ctx.userContext,
      } satisfies ChannelUserContext;
    }

    case 'api_key':
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'api_key',
        permissions: ctx.permissions,
        apiKeyId: ctx.apiKeyId ?? '',
        clientId: ctx.clientId ?? '',
        createdBy: ctx.userId,
        projectScope: ctx.projectScope,
        environmentScope: ctx.environmentScope,
      } satisfies ApiKeyContext;
  }
}

/**
 * Convert typed AuthContext back to legacy TenantContextData.
 * Used for backward compatibility with code that still reads TenantContextData.
 */
export function toLegacyTenantContext(ctx: AuthContext): TenantContextData {
  const base: TenantContextData = {
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
    userId: '',
    role: '',
    permissions: ctx.permissions,
    authType: ctx.authType,
    isSuperAdmin: false,
  };

  switch (ctx.authType) {
    case 'user':
      return { ...base, userId: ctx.userId, role: ctx.role, isSuperAdmin: ctx.isSuperAdmin };

    case 'sdk_session':
      return {
        ...base,
        userId:
          ctx.callerIdentity.authScope === 'user'
            ? ctx.callerIdentity.customerId ||
              ctx.callerIdentity.sessionPrincipalId ||
              ctx.sessionId ||
              ''
            : ctx.callerIdentity.sessionPrincipalId ||
              ctx.callerIdentity.anonymousId ||
              ctx.sessionId ||
              '',
        role: 'sdk_session',
        projectId: ctx.projectId,
        channelId: ctx.channelId,
        deploymentId: ctx.deploymentId,
        sessionId: ctx.sessionId ?? ctx.callerIdentity.sessionPrincipalId,
        sessionPrincipal: ctx.callerIdentity.sessionPrincipalId,
        verifiedUserId: ctx.callerIdentity.customerId,
        contactId: ctx.callerIdentity.contactId,
        identityTier: ctx.callerIdentity.identityTier,
        verificationMethod: ctx.callerIdentity.verificationMethod,
        authScope: ctx.callerIdentity.authScope,
        channelArtifact: ctx.callerIdentity.channelArtifact,
        userContext: ctx.userContext,
      };

    case 'api_key':
      return {
        ...base,
        userId: ctx.createdBy,
        role: 'api_key',
        apiKeyId: ctx.apiKeyId,
        clientId: ctx.clientId,
        projectScope: ctx.projectScope,
        environmentScope: ctx.environmentScope,
      };
  }
}
