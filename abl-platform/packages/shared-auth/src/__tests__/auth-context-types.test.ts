import { describe, it, expect } from 'vitest';
import type {
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  AuthContext,
} from '../types/auth-context.js';
import { isPlatformMember, isChannelUser, isApiKey } from '../types/auth-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlatformMember(): PlatformMemberContext {
  return {
    tenantId: 'tenant-1',
    authType: 'user',
    permissions: ['agent:read'],
    userId: 'user-1',
    role: 'ADMIN',
    isSuperAdmin: false,
  };
}

function makeChannelUser(): ChannelUserContext {
  return {
    tenantId: 'tenant-1',
    authType: 'sdk_session',
    permissions: ['session:read'],
    projectId: 'proj-1',
    channelId: 'web-channel',
    callerIdentity: {
      identityTier: 0,
      verificationMethod: 'none',
    },
  };
}

function makeApiKey(): ApiKeyContext {
  return {
    tenantId: 'tenant-1',
    authType: 'api_key',
    permissions: ['agent:execute'],
    apiKeyId: 'key-1',
    clientId: 'client-1',
    createdBy: 'creator-1',
  };
}

// ---------------------------------------------------------------------------
// isPlatformMember
// ---------------------------------------------------------------------------

describe('isPlatformMember', () => {
  it('returns true for PlatformMemberContext', () => {
    expect(isPlatformMember(makePlatformMember())).toBe(true);
  });

  it('returns false for ChannelUserContext', () => {
    expect(isPlatformMember(makeChannelUser())).toBe(false);
  });

  it('returns false for ApiKeyContext', () => {
    expect(isPlatformMember(makeApiKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isChannelUser
// ---------------------------------------------------------------------------

describe('isChannelUser', () => {
  it('returns true for ChannelUserContext', () => {
    expect(isChannelUser(makeChannelUser())).toBe(true);
  });

  it('returns false for PlatformMemberContext', () => {
    expect(isChannelUser(makePlatformMember())).toBe(false);
  });

  it('returns false for ApiKeyContext', () => {
    expect(isChannelUser(makeApiKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isApiKey
// ---------------------------------------------------------------------------

describe('isApiKey', () => {
  it('returns true for ApiKeyContext', () => {
    expect(isApiKey(makeApiKey())).toBe(true);
  });

  it('returns false for PlatformMemberContext', () => {
    expect(isApiKey(makePlatformMember())).toBe(false);
  });

  it('returns false for ChannelUserContext', () => {
    expect(isApiKey(makeChannelUser())).toBe(false);
  });
});
