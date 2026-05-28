import { describe, test, expect } from 'vitest';
import { toAuthContext, toLegacyTenantContext } from '../middleware/auth-context-bridge.js';
import type { TenantContextData } from '../types/index.js';

describe('toAuthContext', () => {
  test('converts User JWT TenantContextData to PlatformMemberContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-123',
      role: 'ADMIN',
      permissions: ['project:*'],
      authType: 'user',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('user');
    if (ctx.authType === 'user') {
      expect(ctx.userId).toBe('user-123');
      expect(ctx.role).toBe('ADMIN');
      expect(ctx.isSuperAdmin).toBe(false);
    }
  });

  test('converts verified SDK session TenantContextData to ChannelUserContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'verified-user-1',
      role: 'sdk_session',
      permissions: ['session:execute'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-42',
      channelId: 'webchat',
      deploymentId: 'dep-1',
      sessionId: 'sdk-session-1',
      sessionPrincipal: 'sdk-session-1',
      verifiedUserId: 'verified-user-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      channelArtifact: 'hash-abc',
      userContext: { userId: 'display-user-1' },
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('sdk_session');
    if (ctx.authType === 'sdk_session') {
      expect(ctx.projectId).toBe('proj-42');
      expect(ctx.channelId).toBe('webchat');
      expect(ctx.callerIdentity.identityTier).toBe(2);
      expect(ctx.callerIdentity.verificationMethod).toBe('hmac');
      expect(ctx.callerIdentity.channelArtifact).toBe('hash-abc');
      expect(ctx.callerIdentity.customerId).toBe('verified-user-1');
      expect(ctx.callerIdentity.sessionPrincipalId).toBe('sdk-session-1');
      expect(ctx.callerIdentity.authScope).toBe('user');
      expect(ctx.userContext).toEqual({ userId: 'display-user-1' });
    }
  });

  test('SDK session without projectId defaults to empty string', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: [],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'sdk_session') {
      expect(ctx.projectId).toBe('');
    }
  });

  test('converts API key TenantContextData to ApiKeyContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-456',
      role: 'api_key',
      permissions: ['session:read'],
      authType: 'api_key',
      isSuperAdmin: false,
      apiKeyId: 'key-1',
      clientId: 'ci-system',
      projectScope: ['proj-1'],
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('api_key');
    if (ctx.authType === 'api_key') {
      expect(ctx.apiKeyId).toBe('key-1');
      expect(ctx.clientId).toBe('ci-system');
      expect(ctx.createdBy).toBe('user-456');
      expect(ctx.projectScope).toEqual(['proj-1']);
    }
  });

  test('SDK session without identity fields defaults to tier 0', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: [],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'sdk_session') {
      expect(ctx.callerIdentity.identityTier).toBe(0);
      expect(ctx.callerIdentity.verificationMethod).toBe('none');
    }
  });

  test('SDK session at tier 1 does NOT populate customerId even with userContext.userId', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: [],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
      identityTier: 1,
      verificationMethod: 'cookie',
      channelArtifact: 'hash-abc',
      userContext: { userId: 'cust-xyz' },
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'sdk_session') {
      expect(ctx.callerIdentity.customerId).toBeUndefined();
      expect(ctx.callerIdentity.channelArtifact).toBe('hash-abc');
      expect(ctx.callerIdentity.identityTier).toBe(1);
    }
  });

  test('SDK session at tier 2 does NOT promote userContext.userId without verifiedUserId', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk-session-2',
      role: 'sdk_session',
      permissions: [],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
      sessionId: 'sdk-session-2',
      sessionPrincipal: 'sdk-session-2',
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: 'hash-verified',
      userContext: { userId: 'cust-xyz' },
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'sdk_session') {
      expect(ctx.callerIdentity.customerId).toBeUndefined();
      expect(ctx.callerIdentity.anonymousId).toBe('sdk-session-2');
      expect(ctx.callerIdentity.sessionPrincipalId).toBe('sdk-session-2');
      expect(ctx.callerIdentity.identityTier).toBe(2);
      expect(ctx.callerIdentity.authScope).toBe('session');
      expect(ctx.userContext).toEqual({ userId: 'cust-xyz' });
    }
  });

  test('preserves orgId when present', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      orgId: 'org-42',
      userId: 'user-123',
      role: 'MEMBER',
      permissions: ['project:read'],
      authType: 'user',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.orgId).toBe('org-42');
  });

  test('API key without optional fields uses empty string defaults', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-789',
      role: 'api_key',
      permissions: [],
      authType: 'api_key',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'api_key') {
      expect(ctx.apiKeyId).toBe('');
      expect(ctx.clientId).toBe('');
      expect(ctx.createdBy).toBe('user-789');
      expect(ctx.projectScope).toBeUndefined();
      expect(ctx.environmentScope).toBeUndefined();
    }
  });
});

describe('toLegacyTenantContext', () => {
  test('round-trips PlatformMemberContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-123',
      role: 'ADMIN',
      permissions: ['project:*'],
      authType: 'user',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    const back = toLegacyTenantContext(ctx);
    expect(back.tenantId).toBe('t1');
    expect(back.userId).toBe('user-123');
    expect(back.role).toBe('ADMIN');
    expect(back.authType).toBe('user');
  });

  test('round-trips SDK session context', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: ['session:execute'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-42',
      channelId: 'webchat',
      deploymentId: 'dep-1',
      sessionId: 'sess-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: 'hash-abc',
      userContext: { userId: 'cust-xyz' },
    };
    const ctx = toAuthContext(legacy);
    const back = toLegacyTenantContext(ctx);
    expect(back.tenantId).toBe('t1');
    expect(back.userId).toBe('sess-1');
    expect(back.role).toBe('sdk_session');
    expect(back.authType).toBe('sdk_session');
    expect(back.projectId).toBe('proj-42');
    expect(back.channelId).toBe('webchat');
    expect(back.deploymentId).toBe('dep-1');
    expect(back.sessionId).toBe('sess-1');
    expect(back.sessionPrincipal).toBe('sess-1');
    expect(back.identityTier).toBe(2);
    expect(back.verificationMethod).toBe('hmac');
    expect(back.channelArtifact).toBe('hash-abc');
    expect(back.userContext).toEqual({ userId: 'cust-xyz' });
  });

  test('round-trips API key context', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-456',
      role: 'api_key',
      permissions: ['session:read'],
      authType: 'api_key',
      isSuperAdmin: false,
      apiKeyId: 'key-1',
      clientId: 'ci-system',
      projectScope: ['proj-1'],
      environmentScope: ['staging'],
    };
    const ctx = toAuthContext(legacy);
    const back = toLegacyTenantContext(ctx);
    expect(back.tenantId).toBe('t1');
    expect(back.userId).toBe('user-456');
    expect(back.role).toBe('api_key');
    expect(back.authType).toBe('api_key');
    expect(back.apiKeyId).toBe('key-1');
    expect(back.clientId).toBe('ci-system');
    expect(back.projectScope).toEqual(['proj-1']);
    expect(back.environmentScope).toEqual(['staging']);
  });

  test('PlatformMemberContext preserves isSuperAdmin=true', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-super',
      role: 'OWNER',
      permissions: ['*'],
      authType: 'user',
      isSuperAdmin: true,
    };
    const ctx = toAuthContext(legacy);
    const back = toLegacyTenantContext(ctx);
    expect(back.isSuperAdmin).toBe(true);
  });
});
