import { describe, it, expect } from 'vitest';
import type { TenantContextData } from '../types/index.js';
import type {
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
} from '../types/auth-context.js';
import { toAuthContext, toLegacyTenantContext } from '../middleware/auth-context-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserTenantContext(): TenantContextData {
  return {
    tenantId: 'tenant-1',
    orgId: 'org-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: ['agent:read', 'agent:write'],
    authType: 'user',
    isSuperAdmin: true,
  };
}

function makeSdkTenantContext(): TenantContextData {
  return {
    tenantId: 'tenant-1',
    orgId: 'org-1',
    userId: 'verified-user-1',
    role: 'sdk_session',
    permissions: ['session:read'],
    authType: 'sdk_session',
    isSuperAdmin: false,
    projectId: 'proj-1',
    channelId: 'web-channel',
    deploymentId: 'deploy-1',
    sessionId: 'sdk-session-1',
    sessionPrincipal: 'sdk-session-1',
    verifiedUserId: 'verified-user-1',
    contactId: 'contact-verified-1',
    identityTier: 2,
    verificationMethod: 'hmac',
    authScope: 'user',
    channelArtifact: 'artifact-hash',
    userContext: {
      userId: 'display-user-1',
      customAttributes: { plan: 'pro' },
    },
  };
}

function makeApiKeyTenantContext(): TenantContextData {
  return {
    tenantId: 'tenant-1',
    orgId: 'org-1',
    userId: 'creator-1',
    role: 'api_key',
    permissions: ['agent:execute'],
    authType: 'api_key',
    isSuperAdmin: false,
    apiKeyId: 'key-1',
    clientId: 'client-1',
    projectScope: ['proj-1', 'proj-2'],
    environmentScope: ['production'],
  };
}

// ---------------------------------------------------------------------------
// toAuthContext
// ---------------------------------------------------------------------------

describe('toAuthContext', () => {
  it('converts user TenantContextData to PlatformMemberContext', () => {
    const result = toAuthContext(makeUserTenantContext());
    expect(result.authType).toBe('user');
    const ctx = result as PlatformMemberContext;
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.orgId).toBe('org-1');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.role).toBe('ADMIN');
    expect(ctx.permissions).toEqual(['agent:read', 'agent:write']);
    expect(ctx.isSuperAdmin).toBe(true);
  });

  it('converts sdk_session TenantContextData to ChannelUserContext', () => {
    const result = toAuthContext(makeSdkTenantContext());
    expect(result.authType).toBe('sdk_session');
    const ctx = result as ChannelUserContext;
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.projectId).toBe('proj-1');
    expect(ctx.channelId).toBe('web-channel');
    expect(ctx.deploymentId).toBe('deploy-1');
    expect(ctx.sessionId).toBe('sdk-session-1');
    expect(ctx.callerIdentity.customerId).toBe('verified-user-1');
    expect(ctx.callerIdentity.sessionPrincipalId).toBe('sdk-session-1');
    expect(ctx.callerIdentity.contactId).toBe('contact-verified-1');
    expect(ctx.callerIdentity.channelArtifact).toBe('artifact-hash');
    expect(ctx.callerIdentity.identityTier).toBe(2);
    expect(ctx.callerIdentity.verificationMethod).toBe('hmac');
    expect(ctx.callerIdentity.authScope).toBe('user');
    expect(ctx.userContext).toEqual({
      userId: 'display-user-1',
      customAttributes: { plan: 'pro' },
    });
  });

  it('uses the SDK session principal for session-scoped callers', () => {
    const tenantCtx = makeSdkTenantContext();
    tenantCtx.userId = 'sdk-session-2';
    tenantCtx.sessionId = 'sdk-session-2';
    tenantCtx.sessionPrincipal = 'sdk-session-2';
    tenantCtx.verifiedUserId = undefined;
    tenantCtx.identityTier = 0;
    tenantCtx.verificationMethod = 'none';
    tenantCtx.authScope = 'session';
    const result = toAuthContext(tenantCtx) as ChannelUserContext;
    expect(result.callerIdentity.customerId).toBeUndefined();
    expect(result.callerIdentity.anonymousId).toBe('sdk-session-2');
    expect(result.callerIdentity.sessionPrincipalId).toBe('sdk-session-2');
    expect(result.callerIdentity.authScope).toBe('session');
  });

  it('does not promote metadata userContext.userId into verified identity', () => {
    const tenantCtx = makeSdkTenantContext();
    tenantCtx.userId = 'sdk-session-4';
    tenantCtx.sessionId = 'sdk-session-4';
    tenantCtx.sessionPrincipal = 'sdk-session-4';
    tenantCtx.verifiedUserId = undefined;
    tenantCtx.identityTier = 2;
    tenantCtx.verificationMethod = 'hmac';
    tenantCtx.authScope = undefined;
    tenantCtx.userContext = {
      userId: 'display-user-4',
      customAttributes: { plan: 'pro' },
    };

    const result = toAuthContext(tenantCtx) as ChannelUserContext;

    expect(result.callerIdentity.customerId).toBeUndefined();
    expect(result.callerIdentity.anonymousId).toBe('sdk-session-4');
    expect(result.callerIdentity.sessionPrincipalId).toBe('sdk-session-4');
    expect(result.callerIdentity.identityTier).toBe(2);
    expect(result.callerIdentity.verificationMethod).toBe('hmac');
    expect(result.callerIdentity.authScope).toBe('session');
    expect(result.userContext).toEqual({
      userId: 'display-user-4',
      customAttributes: { plan: 'pro' },
    });
  });

  it('falls back to session scope when identityTier is undefined', () => {
    const tenantCtx = makeSdkTenantContext();
    tenantCtx.userId = 'sdk-session-3';
    tenantCtx.sessionId = 'sdk-session-3';
    tenantCtx.sessionPrincipal = 'sdk-session-3';
    tenantCtx.verifiedUserId = undefined;
    tenantCtx.identityTier = undefined;
    tenantCtx.authScope = undefined;
    const result = toAuthContext(tenantCtx) as ChannelUserContext;
    expect(result.callerIdentity.customerId).toBeUndefined();
    expect(result.callerIdentity.anonymousId).toBe('sdk-session-3');
    expect(result.callerIdentity.sessionPrincipalId).toBe('sdk-session-3');
    expect(result.callerIdentity.identityTier).toBe(0);
  });

  it('defaults verificationMethod to none when undefined', () => {
    const tenantCtx = makeSdkTenantContext();
    tenantCtx.verificationMethod = undefined;
    const result = toAuthContext(tenantCtx) as ChannelUserContext;
    expect(result.callerIdentity.verificationMethod).toBe('none');
  });

  it('handles sdk_session with missing projectId and channelId', () => {
    const tenantCtx = makeSdkTenantContext();
    tenantCtx.projectId = undefined;
    tenantCtx.channelId = undefined;
    const result = toAuthContext(tenantCtx) as ChannelUserContext;
    expect(result.projectId).toBe('');
    expect(result.channelId).toBe('');
  });

  it('converts api_key TenantContextData to ApiKeyContext', () => {
    const result = toAuthContext(makeApiKeyTenantContext());
    expect(result.authType).toBe('api_key');
    const ctx = result as ApiKeyContext;
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.apiKeyId).toBe('key-1');
    expect(ctx.clientId).toBe('client-1');
    expect(ctx.createdBy).toBe('creator-1');
    expect(ctx.projectScope).toEqual(['proj-1', 'proj-2']);
    expect(ctx.environmentScope).toEqual(['production']);
  });

  it('converts api_key TenantContextData with undefined optional fields', () => {
    const tenantCtx: TenantContextData = {
      tenantId: 'tenant-1',
      orgId: 'org-1',
      userId: 'creator-1',
      role: 'api_key',
      permissions: ['agent:execute'],
      authType: 'api_key',
      isSuperAdmin: false,
      // apiKeyId, clientId, projectScope, environmentScope all undefined
    };
    const result = toAuthContext(tenantCtx);
    expect(result.authType).toBe('api_key');
    const ctx = result as ApiKeyContext;
    expect(ctx.apiKeyId).toBe('');
    expect(ctx.clientId).toBe('');
    expect(ctx.createdBy).toBe('creator-1');
    expect(ctx.projectScope).toBeUndefined();
    expect(ctx.environmentScope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toLegacyTenantContext
// ---------------------------------------------------------------------------

describe('toLegacyTenantContext', () => {
  it('converts PlatformMemberContext back to TenantContextData', () => {
    const authCtx: PlatformMemberContext = {
      tenantId: 'tenant-1',
      orgId: 'org-1',
      authType: 'user',
      permissions: ['agent:read'],
      userId: 'user-1',
      role: 'ADMIN',
      isSuperAdmin: true,
    };
    const result = toLegacyTenantContext(authCtx);
    expect(result.tenantId).toBe('tenant-1');
    expect(result.userId).toBe('user-1');
    expect(result.role).toBe('ADMIN');
    expect(result.authType).toBe('user');
    expect(result.isSuperAdmin).toBe(true);
  });

  it('converts ChannelUserContext back to TenantContextData', () => {
    const authCtx: ChannelUserContext = {
      tenantId: 'tenant-1',
      orgId: 'org-1',
      authType: 'sdk_session',
      permissions: ['session:read'],
      projectId: 'proj-1',
      channelId: 'web-channel',
      deploymentId: 'deploy-1',
      sessionId: 'sdk-session-1',
      callerIdentity: {
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash',
        customerId: 'end-user-1',
        contactId: 'contact-legacy-1',
        sessionPrincipalId: 'sdk-session-1',
        authScope: 'user',
      },
      userContext: { userId: 'display-user-1' },
    };
    const result = toLegacyTenantContext(authCtx);
    expect(result.userId).toBe('end-user-1');
    expect(result.role).toBe('sdk_session');
    expect(result.projectId).toBe('proj-1');
    expect(result.channelId).toBe('web-channel');
    expect(result.sessionId).toBe('sdk-session-1');
    expect(result.sessionPrincipal).toBe('sdk-session-1');
    expect(result.verifiedUserId).toBe('end-user-1');
    expect(result.contactId).toBe('contact-legacy-1');
    expect(result.identityTier).toBe(2);
    expect(result.verificationMethod).toBe('hmac');
    expect(result.authScope).toBe('user');
    expect(result.channelArtifact).toBe('artifact-hash');
  });

  it('converts ApiKeyContext back to TenantContextData', () => {
    const authCtx: ApiKeyContext = {
      tenantId: 'tenant-1',
      orgId: 'org-1',
      authType: 'api_key',
      permissions: ['agent:execute'],
      apiKeyId: 'key-1',
      clientId: 'client-1',
      createdBy: 'creator-1',
      projectScope: ['proj-1'],
      environmentScope: ['production'],
    };
    const result = toLegacyTenantContext(authCtx);
    expect(result.userId).toBe('creator-1');
    expect(result.role).toBe('api_key');
    expect(result.apiKeyId).toBe('key-1');
    expect(result.clientId).toBe('client-1');
    expect(result.projectScope).toEqual(['proj-1']);
    expect(result.environmentScope).toEqual(['production']);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: toAuthContext → toLegacyTenantContext ≈ original
// ---------------------------------------------------------------------------

describe('round-trip conversion', () => {
  it('round-trips user context', () => {
    const original = makeUserTenantContext();
    const authCtx = toAuthContext(original);
    const roundTripped = toLegacyTenantContext(authCtx);
    expect(roundTripped.tenantId).toBe(original.tenantId);
    expect(roundTripped.userId).toBe(original.userId);
    expect(roundTripped.role).toBe(original.role);
    expect(roundTripped.authType).toBe(original.authType);
    expect(roundTripped.isSuperAdmin).toBe(original.isSuperAdmin);
    expect(roundTripped.permissions).toEqual(original.permissions);
  });

  it('round-trips sdk_session context', () => {
    const original = makeSdkTenantContext();
    const authCtx = toAuthContext(original);
    const roundTripped = toLegacyTenantContext(authCtx);
    expect(roundTripped.tenantId).toBe(original.tenantId);
    expect(roundTripped.userId).toBe(original.userId);
    expect(roundTripped.projectId).toBe(original.projectId);
    expect(roundTripped.channelId).toBe(original.channelId);
    expect(roundTripped.deploymentId).toBe(original.deploymentId);
    expect(roundTripped.sessionId).toBe(original.sessionId);
    expect(roundTripped.verifiedUserId).toBe(original.verifiedUserId);
    expect(roundTripped.identityTier).toBe(original.identityTier);
    expect(roundTripped.verificationMethod).toBe(original.verificationMethod);
    expect(roundTripped.authScope).toBe(original.authScope);
    expect(roundTripped.channelArtifact).toBe(original.channelArtifact);
  });

  it('round-trips api_key context', () => {
    const original = makeApiKeyTenantContext();
    const authCtx = toAuthContext(original);
    const roundTripped = toLegacyTenantContext(authCtx);
    expect(roundTripped.tenantId).toBe(original.tenantId);
    expect(roundTripped.apiKeyId).toBe(original.apiKeyId);
    expect(roundTripped.clientId).toBe(original.clientId);
    expect(roundTripped.projectScope).toEqual(original.projectScope);
    expect(roundTripped.environmentScope).toEqual(original.environmentScope);
  });
});
