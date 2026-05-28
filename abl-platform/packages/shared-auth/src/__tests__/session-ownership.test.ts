import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { CallerContext, TenantContextData } from '../types/index.js';
import type { CallerIdentity } from '../types/auth-context.js';
import {
  matchesSessionOwner,
  isElevatedPlatformRole,
  matchesPlatformMemberSessionOwner,
  buildSessionListFilter,
  createRequireSessionOwnership,
  evaluateSessionOwnershipAccess,
} from '../middleware/session-ownership.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallerContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    tenantId: 'tenant-1',
    channel: 'web',
    identityTier: 0,
    verificationMethod: 'none',
    ...overrides,
  };
}

function makeCallerIdentity(overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    identityTier: 0,
    verificationMethod: 'none',
    ...overrides,
  };
}

function makeTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: [],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

function createMocks(tenantContext?: TenantContextData) {
  const req = {
    tenantContext,
    params: {} as Record<string, string>,
    query: {} as Record<string, string>,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    reportAccessDenied: vi.fn(),
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

// ---------------------------------------------------------------------------
// matchesSessionOwner
// ---------------------------------------------------------------------------

describe('matchesSessionOwner', () => {
  it('matches on tier 2 (customerId)', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      channelId: 'channel-1',
      identityTier: 2,
    });
    const request = makeCallerIdentity({
      customerId: 'cust-1',
      identityTier: 2,
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(true);
  });

  it('mismatches on tier 2 (customerId)', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      channelId: 'channel-1',
      identityTier: 2,
    });
    const request = makeCallerIdentity({
      customerId: 'cust-other',
      identityTier: 2,
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(false);
  });

  it('matches on tier 1 (channelArtifact)', () => {
    const session = makeCallerContext({
      channelArtifact: 'artifact-abc',
      channelId: 'channel-1',
      identityTier: 1,
    });
    const request = makeCallerIdentity({
      channelArtifact: 'artifact-abc',
      identityTier: 1,
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(true);
  });

  it('mismatches on tier 1 (channelArtifact)', () => {
    const session = makeCallerContext({
      channelArtifact: 'artifact-abc',
      channelId: 'channel-1',
      identityTier: 1,
    });
    const request = makeCallerIdentity({
      channelArtifact: 'artifact-xyz',
      identityTier: 1,
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(false);
  });

  it('matches on tier 0 (anonymousId)', () => {
    const session = makeCallerContext({
      anonymousId: 'anon-1',
      channelId: 'channel-1',
      identityTier: 0,
    });
    const request = makeCallerIdentity({
      anonymousId: 'anon-1',
      identityTier: 0,
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(true);
  });

  it('matches on explicit session principal', () => {
    const session = makeCallerContext({
      sessionPrincipalId: 'sdk-session-1',
      anonymousId: 'sdk-session-1',
      channelId: 'channel-1',
      identityTier: 0,
      authScope: 'session',
    });
    const request = makeCallerIdentity({
      sessionPrincipalId: 'sdk-session-1',
      identityTier: 0,
      authScope: 'session',
    });
    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(true);
  });

  it('does not fall back to channelArtifact for session-scoped SDK callers when the stored session lacks a principal', () => {
    const session = makeCallerContext({
      channelArtifact: 'artifact-abc',
      channelId: 'channel-1',
      identityTier: 1,
      verificationMethod: 'cookie',
    });
    const request = makeCallerIdentity({
      sessionPrincipalId: 'sdk-session-1',
      anonymousId: 'sdk-session-1',
      channelArtifact: 'artifact-abc',
      identityTier: 1,
      verificationMethod: 'cookie',
      authScope: 'session',
    });

    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(false);
  });

  it('returns false when the SDK channel id does not match even if identity matches', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      channelId: 'channel-1',
      identityTier: 2,
    });
    const request = makeCallerIdentity({
      customerId: 'cust-1',
      identityTier: 2,
    });

    expect(matchesSessionOwner(session, request, 'channel-2')).toBe(false);
  });

  it('returns false when the session row is missing channel scope for an SDK caller', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      identityTier: 2,
    });
    const request = makeCallerIdentity({
      customerId: 'cust-1',
      identityTier: 2,
    });

    expect(matchesSessionOwner(session, request, 'channel-1')).toBe(false);
  });

  it('returns false when the request channel scope is an empty string', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      identityTier: 2,
      channelId: 'channel-1',
    });
    const request = makeCallerIdentity({
      customerId: 'cust-1',
      identityTier: 2,
    });

    expect(matchesSessionOwner(session, request, '')).toBe(false);
  });

  it('does not allow anonymous tier 0 passthrough with no stable identity', () => {
    const session = makeCallerContext({ identityTier: 0 });
    const request = makeCallerIdentity({ identityTier: 0 });
    expect(matchesSessionOwner(session, request)).toBe(false);
  });

  it('does not allow a request anonymousId to resume a session with no anonymousId', () => {
    const session = makeCallerContext({ identityTier: 0 });
    const request = makeCallerIdentity({
      anonymousId: 'anon-legacy-token',
      identityTier: 0,
    });
    expect(matchesSessionOwner(session, request)).toBe(false);
  });

  it('returns false for cross-tier (tier 2 session, tier 0 request)', () => {
    const session = makeCallerContext({
      customerId: 'cust-1',
      identityTier: 2,
    });
    const request = makeCallerIdentity({ identityTier: 0 });
    expect(matchesSessionOwner(session, request)).toBe(false);
  });

  it('returns false for cross-tier (tier 0 session, tier 2 request)', () => {
    const session = makeCallerContext({ identityTier: 0 });
    const request = makeCallerIdentity({
      customerId: 'cust-1',
      identityTier: 2,
    });
    expect(matchesSessionOwner(session, request)).toBe(false);
  });
});

describe('isElevatedPlatformRole', () => {
  it('returns true for OWNER and ADMIN', () => {
    expect(isElevatedPlatformRole('OWNER')).toBe(true);
    expect(isElevatedPlatformRole('ADMIN')).toBe(true);
  });

  it('returns false for member roles and missing role', () => {
    expect(isElevatedPlatformRole('MEMBER')).toBe(false);
    expect(isElevatedPlatformRole('VIEWER')).toBe(false);
    expect(isElevatedPlatformRole(undefined)).toBe(false);
  });
});

describe('matchesPlatformMemberSessionOwner', () => {
  it('matches when owner user id equals requester user id', () => {
    expect(matchesPlatformMemberSessionOwner('user-1', 'user-1')).toBe(true);
  });

  it('returns false for mismatched or missing user ids', () => {
    expect(matchesPlatformMemberSessionOwner('user-1', 'user-2')).toBe(false);
    expect(matchesPlatformMemberSessionOwner(undefined, 'user-1')).toBe(false);
    expect(matchesPlatformMemberSessionOwner('user-1', undefined)).toBe(false);
  });
});

describe('evaluateSessionOwnershipAccess', () => {
  it('allows non-admin platform members to access project-owned Studio sessions', () => {
    const access = evaluateSessionOwnershipAccess(
      makeTenantContext({ authType: 'user', role: 'MEMBER', userId: 'user-1' }),
      {
        ownerUserId: 'user-2',
        source: { type: 'studio', workspaceUserId: 'user-2' },
      },
    );

    expect(access.allowed).toBe(true);
  });

  it('keeps non-admin platform ownership checks for public sessions', () => {
    const access = evaluateSessionOwnershipAccess(
      makeTenantContext({ authType: 'user', role: 'MEMBER', userId: 'user-1' }),
      {
        ownerUserId: 'user-2',
        source: { type: 'public', contactId: 'contact-1' },
      },
    );

    expect(access).toEqual(
      expect.objectContaining({
        allowed: false,
        statusCode: 404,
        reasonCode: 'SESSION_OWNER_MISMATCH',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildSessionListFilter
// ---------------------------------------------------------------------------

describe('buildSessionListFilter', () => {
  it('returns base filter for non-sdk authType', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'user',
        permissions: [],
        userId: 'user-1',
        role: 'ADMIN',
        isSuperAdmin: false,
      },
      'proj-1',
    );
    expect(filter).toEqual({ tenantId: 'tenant-1', projectId: 'proj-1' });
  });

  it('filters by customerId for sdk_session with customerId', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        callerIdentity: {
          customerId: 'cust-1',
          identityTier: 2,
          verificationMethod: 'hmac',
        },
      },
      'proj-1',
    );
    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      customerId: 'cust-1',
    });
  });

  it('filters by channelArtifact when no customerId', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        callerIdentity: {
          channelArtifact: 'art-hash',
          identityTier: 1,
          verificationMethod: 'cookie',
        },
      },
      'proj-1',
    );
    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      channelArtifact: 'art-hash',
    });
  });

  it('filters by anonymousId when no customerId or channelArtifact', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        callerIdentity: {
          anonymousId: 'anon-1',
          identityTier: 0,
          verificationMethod: 'none',
        },
      },
      'proj-1',
    );
    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      anonymousId: 'anon-1',
    });
  });

  it('filters session-scoped SDK callers by the explicit session principal', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        sessionId: 'sdk-session-1',
        callerIdentity: {
          sessionPrincipalId: 'sdk-session-1',
          anonymousId: 'sdk-session-1',
          identityTier: 0,
          verificationMethod: 'none',
          authScope: 'session',
        },
      },
      'proj-1',
    );

    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      anonymousId: 'sdk-session-1',
    });
  });

  it('returns an impossible filter for session-scoped SDK callers that lack a session principal', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        callerIdentity: {
          channelArtifact: 'artifact-abc',
          identityTier: 1,
          verificationMethod: 'cookie',
          authScope: 'session',
        },
      },
      'proj-1',
    );

    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      _id: { $exists: false },
    });
  });

  it('returns impossible filter when sdk_session has no identity fields', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'sdk_session',
        permissions: [],
        projectId: 'proj-1',
        channelId: 'web',
        callerIdentity: {
          identityTier: 0,
          verificationMethod: 'none',
        },
      },
      'proj-1',
    );
    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'web',
      _id: { $exists: false },
    });
  });

  it('returns base filter for api_key authType', () => {
    const filter = buildSessionListFilter(
      {
        tenantId: 'tenant-1',
        authType: 'api_key',
        permissions: [],
        apiKeyId: 'key-1',
        clientId: 'client-1',
        createdBy: 'user-1',
      },
      'proj-1',
    );
    expect(filter).toEqual({ tenantId: 'tenant-1', projectId: 'proj-1' });
  });
});

// ---------------------------------------------------------------------------
// createRequireSessionOwnership
// ---------------------------------------------------------------------------

describe('createRequireSessionOwnership', () => {
  it('returns 401 when no tenantContext', async () => {
    const middleware = createRequireSessionOwnership({
      findSession: vi.fn(),
    });
    const { req, res, next } = createMocks(undefined);
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      }),
    );
  });

  it('calls next when no sessionId in params', async () => {
    const middleware = createRequireSessionOwnership({
      findSession: vi.fn(),
    });
    const { req, res, next } = createMocks(makeTenantContext());
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next for elevated user auth without requiring a persisted session lookup', async () => {
    const findSession = vi.fn().mockResolvedValue(null);
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(makeTenantContext({ authType: 'user', role: 'ADMIN' }));
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(findSession).not.toHaveBeenCalled();
  });

  it('calls next for non-admin user accessing own session', async () => {
    const findSession = vi.fn().mockResolvedValue({ ownerUserId: 'user-1' });
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({ authType: 'user', role: 'MEMBER', userId: 'user-1' }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next for non-admin user accessing a project-owned Studio session', async () => {
    const findSession = vi.fn().mockResolvedValue({
      ownerUserId: 'user-2',
      source: { type: 'studio', workspaceUserId: 'user-2' },
    });
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({ authType: 'user', role: 'MEMBER', userId: 'user-1' }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 404 for non-admin user accessing another users session', async () => {
    const findSession = vi.fn().mockResolvedValue({ ownerUserId: 'user-2' });
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({ authType: 'user', role: 'MEMBER', userId: 'user-1' }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_OWNER_MISMATCH',
        resourceId: 'sess-1',
      }),
    );
  });

  it('calls next for api_key auth', async () => {
    const middleware = createRequireSessionOwnership({
      findSession: vi.fn(),
    });
    const { req, res, next } = createMocks(makeTenantContext({ authType: 'api_key' }));
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next when sdk_session ownership matches', async () => {
    const findSession = vi.fn().mockResolvedValue({
      callerContext: makeCallerContext({
        channelId: 'web',
        sessionPrincipalId: 'sdk-session-1',
        anonymousId: 'sdk-session-1',
        identityTier: 0,
        authScope: 'session',
      }),
    });
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({
        authType: 'sdk_session',
        channelId: 'web',
        projectId: 'proj-1',
        sessionId: 'sdk-session-1',
        identityTier: 0,
        verificationMethod: 'none',
        authScope: 'session',
        userContext: { userId: 'metadata-only' },
      }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    // Anonymous SDK sessions must carry the same stable session principal to match.
    expect(next).toHaveBeenCalled();
  });

  it('returns 404 when sdk_session ownership does not match', async () => {
    const findSession = vi.fn().mockResolvedValue({
      callerContext: makeCallerContext({
        customerId: 'cust-other',
        identityTier: 2,
      }),
    });
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({
        authType: 'sdk_session',
        channelId: 'web',
        projectId: 'proj-1',
        sessionId: 'sdk-session-b',
        identityTier: 0,
        verificationMethod: 'none',
        authScope: 'session',
      }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_OWNER_MISMATCH',
        resourceId: 'sess-1',
      }),
    );
  });

  it('returns 404 when session not found', async () => {
    const findSession = vi.fn().mockResolvedValue(null);
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({
        authType: 'sdk_session',
        channelId: 'web',
        projectId: 'proj-1',
        identityTier: 0,
        verificationMethod: 'none',
      }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_NOT_FOUND',
        resourceId: 'sess-1',
      }),
    );
  });

  it('returns 404 when session has no callerContext', async () => {
    const findSession = vi.fn().mockResolvedValue({});
    const middleware = createRequireSessionOwnership({ findSession });
    const { req, res, next } = createMocks(
      makeTenantContext({
        authType: 'sdk_session',
        channelId: 'web',
        projectId: 'proj-1',
        identityTier: 0,
        verificationMethod: 'none',
      }),
    );
    (req as any).params = { sessionId: 'sess-1' };
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
