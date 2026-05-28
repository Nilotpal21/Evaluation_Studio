import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEvaluateProjectPermission = vi.fn();
const mockFindStoredSessionByAnyId = vi.fn();

vi.mock('../../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  evaluateProjectPermission: (...args: any[]) => mockEvaluateProjectPermission(...args),
}));

vi.mock('../../../repos/session-repo.js', () => ({
  findStoredSessionByAnyId: (...args: any[]) => mockFindStoredSessionByAnyId(...args),
}));

import { resolveProjectSessionAccess } from '../../../middleware/session-access.js';

function createReq(overrides: Record<string, unknown> = {}) {
  return {
    tenantContext: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      authType: 'user',
      role: 'MEMBER',
      permissions: ['session:read'],
      isSuperAdmin: false,
    },
    params: {},
    query: {},
    body: {},
    headers: {},
    method: 'GET',
    originalUrl: '/api/projects/proj-1/sessions/sess-1',
    reportAccessDenied: vi.fn(),
    ...overrides,
  } as any;
}

describe('resolveProjectSessionAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateProjectPermission.mockResolvedValue({ allowed: true });
    mockFindStoredSessionByAnyId.mockResolvedValue(null);
  });

  it('returns the RBAC denial and logs it when project access fails', async () => {
    mockEvaluateProjectPermission.mockResolvedValueOnce({
      allowed: false,
      statusCode: 404,
      publicError: 'Project not found',
      reasonCode: 'PROJECT_MEMBERSHIP_REQUIRED',
      reason: 'You are not a member of this project',
      concealAsNotFound: true,
      scope: 'project',
      projectId: 'proj-1',
    });
    const req = createReq();

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Project not found',
        publicMessage: undefined,
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'runtime_rbac',
        scope: 'project',
        reasonCode: 'PROJECT_MEMBERSHIP_REQUIRED',
        resourceId: 'sess-1',
        requiredPermission: 'session:read',
      }),
    );
    expect(mockEvaluateProjectPermission).toHaveBeenCalledWith(req, 'session:read', 'proj-1', {
      concealNotMember: true,
    });
    expect(mockFindStoredSessionByAnyId).not.toHaveBeenCalled();
  });

  it('conceals missing sessions after project access is granted', async () => {
    const req = createReq();
    mockFindStoredSessionByAnyId.mockResolvedValueOnce(null);

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_NOT_FOUND',
        resourceId: 'sess-1',
      }),
    );
  });

  it('returns the stored session resolved by the canonical lookup helper', async () => {
    const req = createReq();
    const session = {
      id: 'db-session-1',
      runtimeSessionId: 'runtime-session-1',
      projectId: 'proj-1',
      initiatedById: 'user-1',
    };
    mockFindStoredSessionByAnyId.mockResolvedValueOnce(session);

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'runtime-session-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({ session });
    expect(mockFindStoredSessionByAnyId).toHaveBeenCalledWith('runtime-session-1', 'tenant-1');
    expect(req.reportAccessDenied).not.toHaveBeenCalled();
  });

  it('conceals project-mismatched sessions', async () => {
    const req = createReq();
    mockFindStoredSessionByAnyId.mockResolvedValueOnce({
      id: 'sess-1',
      projectId: 'proj-other',
      initiatedById: 'user-1',
    });

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'project',
        reasonCode: 'SESSION_PROJECT_MISMATCH',
        resourceId: 'sess-1',
        metadata: { sessionProjectId: 'proj-other' },
      }),
    );
  });

  it('conceals stored sessions that belong to a different project', async () => {
    const req = createReq();
    mockFindStoredSessionByAnyId.mockResolvedValueOnce({
      id: 'db-session-2',
      runtimeSessionId: 'runtime-session-2',
      projectId: 'proj-other',
      initiatedById: 'user-1',
    });

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'runtime-session-2',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'project',
        reasonCode: 'SESSION_PROJECT_MISMATCH',
        resourceId: 'runtime-session-2',
        metadata: { sessionProjectId: 'proj-other' },
      }),
    );
  });

  it('conceals sessions owned by a different tenant member', async () => {
    const req = createReq();
    mockFindStoredSessionByAnyId.mockResolvedValueOnce({
      id: 'sess-1',
      projectId: 'proj-1',
      initiatedById: 'user-2',
    });

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_OWNER_MISMATCH',
        resourceId: 'sess-1',
      }),
    );
  });

  it('returns the session without logging when the caller owns it', async () => {
    const req = createReq();
    const session = {
      id: 'sess-1',
      projectId: 'proj-1',
      initiatedById: 'user-1',
    };
    mockFindStoredSessionByAnyId.mockResolvedValueOnce(session);

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({ session });
    expect(req.reportAccessDenied).not.toHaveBeenCalled();
  });

  it('allows verified sdk callers that match the persisted session caller identity', async () => {
    const req = createReq({
      tenantContext: {
        tenantId: 'tenant-1',
        userId: 'cust-1',
        authType: 'sdk_session',
        role: 'sdk_session',
        permissions: ['session:read'],
        projectId: 'proj-1',
        channelId: 'sdk-channel-1',
        sessionPrincipal: 'sdk-session-verified',
        verifiedUserId: 'cust-1',
        authScope: 'user',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
    });
    const session = {
      id: 'sess-1',
      projectId: 'proj-1',
      customerId: 'cust-1',
      channelId: 'sdk-channel-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      channel: 'sdk_http',
    };
    mockFindStoredSessionByAnyId.mockResolvedValueOnce(session);

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({ session });
    expect(req.reportAccessDenied).not.toHaveBeenCalled();
  });

  it('conceals session-scoped sdk callers that do not own the persisted session principal', async () => {
    const req = createReq({
      tenantContext: {
        tenantId: 'tenant-1',
        userId: 'sdk-session-1',
        authType: 'sdk_session',
        role: 'sdk_session',
        permissions: ['session:read'],
        projectId: 'proj-1',
        channelId: 'sdk-channel-1',
        sessionPrincipal: 'sdk-session-1',
        authScope: 'session',
        identityTier: 1,
        verificationMethod: 'cookie',
      },
    });
    mockFindStoredSessionByAnyId.mockResolvedValueOnce({
      id: 'sess-1',
      projectId: 'proj-1',
      anonymousId: 'sdk-session-2',
      channelId: 'sdk-channel-1',
      identityTier: 1,
      verificationMethod: 'cookie',
      channel: 'sdk_http',
    });

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_OWNER_MISMATCH',
        resourceId: 'sess-1',
      }),
    );
  });

  it('conceals session-scoped sdk callers when a legacy session row only has channelArtifact ownership', async () => {
    const req = createReq({
      tenantContext: {
        tenantId: 'tenant-1',
        userId: 'sdk-session-1',
        authType: 'sdk_session',
        role: 'sdk_session',
        permissions: ['session:read'],
        projectId: 'proj-1',
        channelId: 'sdk-channel-1',
        sessionPrincipal: 'sdk-session-1',
        authScope: 'session',
        identityTier: 1,
        verificationMethod: 'cookie',
      },
    });
    mockFindStoredSessionByAnyId.mockResolvedValueOnce({
      id: 'sess-legacy-artifact',
      projectId: 'proj-1',
      channelArtifact: 'artifact-abc',
      channelId: 'sdk-channel-1',
      identityTier: 1,
      verificationMethod: 'cookie',
      channel: 'sdk_http',
    });

    const result = await resolveProjectSessionAccess(req, {
      sessionId: 'sess-legacy-artifact',
      projectId: 'proj-1',
      requiredPermission: 'session:read',
    });

    expect(result).toEqual({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'session_ownership',
        scope: 'user',
        reasonCode: 'SESSION_OWNER_MISMATCH',
        resourceId: 'sess-legacy-artifact',
      }),
    );
  });
});
