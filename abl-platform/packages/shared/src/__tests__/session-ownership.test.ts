import { describe, test, expect } from 'vitest';
import { matchesSessionOwner, buildSessionListFilter } from '../middleware/session-ownership.js';
import type { CallerIdentity, ChannelUserContext } from '../types/auth-context.js';
import type { CallerContext } from '../types/index.js';

describe('matchesSessionOwner', () => {
  test('tier 2: customerId match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 2: customerId mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-xyz',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier 1: channelArtifact match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const identity: CallerIdentity = {
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 1: channelArtifact mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const identity: CallerIdentity = {
      channelArtifact: 'hash-999',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier 0: anonymousId match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 0: anonymousId mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      anonymousId: 'anon-2',
      identityTier: 0,
      verificationMethod: 'none',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier 0: both sides tier 0 with no identity fields denies access (no anonymous-to-anonymous passthrough)', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      identityTier: 0,
      verificationMethod: 'none',
    };
    // No identity fields on either side — matchesSessionOwner returns false
    // to prevent anonymous-to-anonymous passthrough
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier mismatch: tier 1 request vs tier 0 session returns false', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('customerId takes priority over channelArtifact', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      channelArtifact: 'hash-999',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-abc',
      channelArtifact: 'hash-different',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });
});

describe('buildSessionListFilter', () => {
  test('SDK auth: filters by customerId when available', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: {
        customerId: 'cust-1',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({
      tenantId: 't1',
      projectId: 'proj-1',
      channelId: 'webchat',
      customerId: 'cust-1',
    });
  });

  test('SDK auth: filters by channelArtifact when no customerId', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: {
        channelArtifact: 'hash-abc',
        identityTier: 1,
        verificationMethod: 'cookie',
      },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({
      tenantId: 't1',
      projectId: 'proj-1',
      channelId: 'webchat',
      channelArtifact: 'hash-abc',
    });
  });

  test('SDK auth: filters by anonymousId as last resort', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: {
        anonymousId: 'anon-1',
        identityTier: 0,
        verificationMethod: 'none',
      },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({
      tenantId: 't1',
      projectId: 'proj-1',
      channelId: 'webchat',
      anonymousId: 'anon-1',
    });
  });

  test('SDK auth: no identity returns impossible filter', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: {
        identityTier: 0,
        verificationMethod: 'none',
      },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toHaveProperty('_id');
  });

  test('platform member auth: returns project-scoped filter only', () => {
    const ctx = {
      tenantId: 't1',
      authType: 'user' as const,
      permissions: ['sessions:read'],
      userId: 'user-1',
      role: 'admin',
      isSuperAdmin: false,
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({ tenantId: 't1', projectId: 'proj-1' });
  });

  test('API key auth: returns project-scoped filter only', () => {
    const ctx = {
      tenantId: 't1',
      authType: 'api_key' as const,
      permissions: ['sessions:read'],
      apiKeyId: 'key-1',
      clientId: 'client-1',
      createdBy: 'user-1',
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({ tenantId: 't1', projectId: 'proj-1' });
  });
});
