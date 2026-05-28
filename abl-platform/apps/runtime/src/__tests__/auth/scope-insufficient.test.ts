/**
 * Scope Insufficient Detection Tests (INT-29b runtime detection + INT-27)
 *
 * Covers:
 *   - Standard OAuth error body: { error: 'insufficient_scope' }
 *   - WWW-Authenticate header with scope= parameter
 *   - Sanitized response: no tenantId, profileId, scope names, or provider details
 *   - Audit event emission with full scope diff
 *   - Non-scope 401/403 returns null (no detection)
 *   - AUTH_PROFILE_DELETED error for deleted profiles
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  detectInsufficientScope: vi.fn(),
  emitAuthProfileAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkProviderResponseForScopeError,
  AuthProfileDeletedError,
  AuthProfileNotFoundError,
} from '../../services/auth-profile/resolve-tool-auth.js';
import {
  detectInsufficientScope,
  emitAuthProfileAuditEvent,
} from '@agent-platform/shared/services/auth-profile';

const mockDetect = vi.mocked(detectInsufficientScope);
const mockEmitAudit = vi.mocked(emitAuthProfileAuditEvent);

const CTX = {
  tenantId: 'tenant-123',
  projectId: 'proj-456',
  profileId: 'profile-789',
  toolName: 'github-api',
  sessionId: 'session-abc',
  userId: 'user-def',
};

describe('checkProviderResponseForScopeError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for non-scope 401 responses', async () => {
    mockDetect.mockReturnValue(null);

    const result = await checkProviderResponseForScopeError(
      { status: 401, body: { error: 'unauthorized' } },
      CTX,
    );

    expect(result).toBeNull();
  });

  it('returns null for 200 responses', async () => {
    mockDetect.mockReturnValue(null);

    const result = await checkProviderResponseForScopeError(
      { status: 200, body: { data: 'ok' } },
      CTX,
    );

    expect(result).toBeNull();
  });

  it('detects standard insufficient_scope error body', async () => {
    mockDetect.mockReturnValue({
      granted: ['read:user'],
      missing: ['write:repo'],
    });

    const result = await checkProviderResponseForScopeError(
      {
        status: 403,
        body: { error: 'insufficient_scope' },
      },
      CTX,
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'REAUTHORIZATION_REQUIRED',
        message: 'This action requires additional permissions. Please re-authorize.',
      },
    });
  });

  it('detects WWW-Authenticate header with scope=', async () => {
    mockDetect.mockReturnValue({
      granted: [],
      missing: ['read:org', 'write:repo'],
    });

    const result = await checkProviderResponseForScopeError(
      {
        status: 401,
        body: {},
        headers: {
          'www-authenticate':
            'Bearer realm="example", scope="read:org write:repo", error="insufficient_scope"',
        },
      },
      CTX,
    );

    expect(result).not.toBeNull();
    expect(result?.error.code).toBe('REAUTHORIZATION_REQUIRED');
  });

  it('sanitized response does not contain tenantId, profileId, or scope names', async () => {
    mockDetect.mockReturnValue({
      granted: ['read:user'],
      missing: ['admin:enterprise'],
    });

    const result = await checkProviderResponseForScopeError(
      { status: 403, body: { error: 'insufficient_scope' } },
      CTX,
    );

    expect(result).not.toBeNull();
    const json = JSON.stringify(result);

    // Must NOT contain sensitive identifiers
    expect(json).not.toContain('tenant-123');
    expect(json).not.toContain('profile-789');
    expect(json).not.toContain('admin:enterprise');
    expect(json).not.toContain('read:user');
    expect(json).not.toContain('github');
  });

  it('emits audit event with full scope diff for admin visibility', async () => {
    mockDetect.mockReturnValue({
      granted: ['read:user'],
      missing: ['write:repo'],
    });

    await checkProviderResponseForScopeError(
      { status: 403, body: { error: 'insufficient_scope' } },
      CTX,
    );

    expect(mockEmitAudit).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      projectId: 'proj-456',
      profileId: 'profile-789',
      eventType: 'scope_insufficient_detected',
      actorUserId: 'user-def',
      actorContext: {
        source: 'tool_config',
        sessionId: 'session-abc',
      },
      eventPayload: {
        source: 'tool_call',
        requestedScopes: ['write:repo'],
        grantedScopes: ['read:user'],
        missingScopes: ['write:repo'],
        toolName: 'github-api',
        httpStatus: 403,
      },
    });
  });

  it('works without optional context fields', async () => {
    mockDetect.mockReturnValue({ granted: [], missing: [] });

    const result = await checkProviderResponseForScopeError(
      { status: 401, body: { error: 'insufficient_scope' } },
      { tenantId: 'tenant-1', toolName: 'test-tool' },
    );

    expect(result).not.toBeNull();
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: '',
        actorUserId: null,
        projectId: null,
      }),
    );
  });
});

describe('AuthProfileDeletedError (INT-27)', () => {
  it('creates structured error with correct code', () => {
    const err = new AuthProfileDeletedError('my-profile', 'github-api');

    expect(err.code).toBe('AUTH_PROFILE_DELETED');
    expect(err.profileName).toBe('my-profile');
    expect(err.toolName).toBe('github-api');
    expect(err.message).toContain('my-profile');
    expect(err.message).toContain('github-api');
    expect(err.name).toBe('AuthProfileDeletedError');
  });

  it('is an instance of Error', () => {
    const err = new AuthProfileDeletedError('p', 't');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('AuthProfileNotFoundError', () => {
  it('creates structured error with correct code and fields', () => {
    const err = new AuthProfileNotFoundError('my-profile', 'github-api', true);

    expect(err.code).toBe('AUTH_PROFILE_NOT_FOUND');
    expect(err.profileName).toBe('my-profile');
    expect(err.toolName).toBe('github-api');
    expect(err.jitAuth).toBe(true);
    expect(err.message).toContain('JIT auth');
  });

  it('provides non-JIT suffix when jitAuth is false', () => {
    const err = new AuthProfileNotFoundError('my-profile', 'tool', false);
    expect(err.message).toContain('not found or inactive');
    expect(err.message).not.toContain('JIT');
  });
});
