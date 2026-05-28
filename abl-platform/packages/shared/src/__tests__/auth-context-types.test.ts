import { describe, test, expect } from 'vitest';
import {
  isPlatformMember,
  isChannelUser,
  isApiKey,
  type AuthContext,
  type PlatformMemberContext,
  type ChannelUserContext,
  type ApiKeyContext,
  type CallerIdentity,
} from '../types/auth-context.js';

describe('AuthContext type guards', () => {
  const platformCtx: PlatformMemberContext = {
    tenantId: 't1',
    authType: 'user',
    permissions: ['project:*'],
    userId: 'user-123',
    role: 'ADMIN',
    isSuperAdmin: false,
  };

  const channelCtx: ChannelUserContext = {
    tenantId: 't1',
    authType: 'sdk_session',
    permissions: ['session:execute'],
    projectId: 'proj-1',
    channelId: 'webchat',
    callerIdentity: {
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    },
  };

  const apiKeyCtx: ApiKeyContext = {
    tenantId: 't1',
    authType: 'api_key',
    permissions: ['session:read'],
    apiKeyId: 'key-1',
    clientId: 'ci-system',
    createdBy: 'user-456',
    projectScope: ['proj-1'],
  };

  test('isPlatformMember narrows correctly', () => {
    expect(isPlatformMember(platformCtx)).toBe(true);
    expect(isPlatformMember(channelCtx)).toBe(false);
    expect(isPlatformMember(apiKeyCtx)).toBe(false);
  });

  test('isChannelUser narrows correctly', () => {
    expect(isChannelUser(channelCtx)).toBe(true);
    expect(isChannelUser(platformCtx)).toBe(false);
    expect(isChannelUser(apiKeyCtx)).toBe(false);
  });

  test('isApiKey narrows correctly', () => {
    expect(isApiKey(apiKeyCtx)).toBe(true);
    expect(isApiKey(platformCtx)).toBe(false);
    expect(isApiKey(channelCtx)).toBe(false);
  });

  test('switch on authType provides exhaustive narrowing', () => {
    function getLabel(ctx: AuthContext): string {
      switch (ctx.authType) {
        case 'user':
          return `member:${ctx.userId}`;
        case 'sdk_session':
          return `channel:${ctx.channelId}`;
        case 'api_key':
          return `key:${ctx.apiKeyId}`;
      }
    }
    expect(getLabel(platformCtx)).toBe('member:user-123');
    expect(getLabel(channelCtx)).toBe('channel:webchat');
    expect(getLabel(apiKeyCtx)).toBe('key:key-1');
  });

  test('CallerIdentity with all tiers', () => {
    const tier0: CallerIdentity = {
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const tier1: CallerIdentity = {
      channelArtifact: 'hash123',
      channelArtifactType: 'cookie',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const tier2: CallerIdentity = {
      customerId: 'cust-1',
      identityTier: 2,
      verificationMethod: 'hmac',
    };

    expect(tier0.identityTier).toBe(0);
    expect(tier1.identityTier).toBe(1);
    expect(tier2.identityTier).toBe(2);
  });
});
