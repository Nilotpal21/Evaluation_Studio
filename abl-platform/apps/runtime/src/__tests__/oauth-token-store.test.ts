import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMongoOAuthTokenStore,
  buildMongoSessionOAuthArtifactStore,
} from '../services/oauth-token-store.js';

const mockLean = vi.fn();
const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockUpdateOne = vi.fn();
const mockDeleteOne = vi.fn();
const mockDeleteMany = vi.fn();
const mockSessionLean = vi.fn();
const mockSessionFindOne = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionUpdateOne = vi.fn();
const mockSessionDeleteOne = vi.fn();
const mockSessionDeleteMany = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  EndUserOAuthToken: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
    deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
  },
  SessionOAuthArtifact: {
    findOne: (...args: unknown[]) => mockSessionFindOne(...args),
    create: (...args: unknown[]) => mockSessionCreate(...args),
    updateOne: (...args: unknown[]) => mockSessionUpdateOne(...args),
    deleteOne: (...args: unknown[]) => mockSessionDeleteOne(...args),
    deleteMany: (...args: unknown[]) => mockSessionDeleteMany(...args),
  },
}));

describe('buildMongoOAuthTokenStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLean.mockReset();
    mockFindOne.mockReset();
    mockCreate.mockReset();
    mockUpdateOne.mockReset();
    mockDeleteOne.mockReset();
    mockDeleteMany.mockReset();
    mockSessionLean.mockReset();
    mockSessionFindOne.mockReset();
    mockSessionCreate.mockReset();
    mockSessionUpdateOne.mockReset();
    mockSessionDeleteOne.mockReset();
    mockSessionDeleteMany.mockReset();
  });

  it('maps mongoose __v to OAuthTokenRecord.version on lookup', async () => {
    mockFindOne.mockReturnValue({
      lean: mockLean.mockResolvedValue({
        encryptedAccessToken: 'enc-access',
        encryptedRefreshToken: 'enc-refresh',
        scope: 'scope.read',
        expiresAt: new Date('2026-03-19T10:00:00.000Z'),
        __v: 4,
      }),
    });

    const store = await buildMongoOAuthTokenStore();
    const token = await store.findToken('tenant-1', 'user-1', 'provider-1');

    expect(token).toEqual({
      encryptedAccessToken: 'enc-access',
      encryptedRefreshToken: 'enc-refresh',
      scope: 'scope.read',
      expiresAt: new Date('2026-03-19T10:00:00.000Z'),
      version: 4,
    });
  });

  it('uses the supplied version for CAS updates', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const store = await buildMongoOAuthTokenStore();
    const result = await store.compareAndSwapToken({
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'provider-1',
      expectedVersion: 7,
      next: {
        kind: 'upsert',
        token: {
          encryptedAccessToken: 'enc-access',
          encryptedRefreshToken: null,
          scope: 'scope.read',
          expiresAt: null,
          version: 7,
        },
      },
    });

    expect(result).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'provider-1',
        revokedAt: null,
        __v: 7,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          providerUserId: 'user-1',
          consentedAt: expect.any(Date),
        }),
        $inc: { __v: 1 },
      }),
    );
  });

  it('reactivates a revoked token before attempting a fresh insert', async () => {
    mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    const store = await buildMongoOAuthTokenStore();
    const result = await store.compareAndSwapToken({
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'provider-1',
      expectedVersion: null,
      next: {
        kind: 'upsert',
        token: {
          encryptedAccessToken: 'enc-access',
          encryptedRefreshToken: null,
          scope: 'scope.read',
          expiresAt: null,
        },
      },
    });

    expect(result).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'provider-1',
        revokedAt: { $ne: null },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          providerUserId: 'user-1',
          consentedAt: expect.any(Date),
          revokedAt: null,
        }),
        $inc: { __v: 1 },
      }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('buildMongoSessionOAuthArtifactStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionLean.mockReset();
    mockSessionFindOne.mockReset();
    mockSessionCreate.mockReset();
    mockSessionUpdateOne.mockReset();
    mockSessionDeleteOne.mockReset();
    mockSessionDeleteMany.mockReset();
  });

  it('maps mongoose __v and session metadata on lookup', async () => {
    mockSessionFindOne.mockReturnValue({
      lean: mockSessionLean.mockResolvedValue({
        encryptedAccessToken: 'enc-access',
        encryptedRefreshToken: 'enc-refresh',
        scope: 'scope.read',
        expiresAt: new Date('2026-03-19T10:00:00.000Z'),
        sessionExpiresAt: new Date('2026-03-19T12:00:00.000Z'),
        runtimeSessionId: 'runtime-session-1',
        channelId: 'channel-1',
        authProfileId: 'profile-1',
        authProfileRef: 'google-oauth',
        __v: 4,
      }),
    });

    const store = await buildMongoSessionOAuthArtifactStore();
    const token = await store.findToken({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionPrincipal: 'sdk-session-1',
      provider: 'provider-1',
    });

    expect(token).toEqual({
      encryptedAccessToken: 'enc-access',
      encryptedRefreshToken: 'enc-refresh',
      scope: 'scope.read',
      expiresAt: new Date('2026-03-19T10:00:00.000Z'),
      sessionId: 'runtime-session-1',
      channelId: 'channel-1',
      authProfileId: 'profile-1',
      authProfileRef: 'google-oauth',
      sessionExpiresAt: new Date('2026-03-19T12:00:00.000Z'),
      version: 4,
    });
  });

  it('prefers canonical sessionId over the legacy runtimeSessionId field on lookup', async () => {
    mockSessionFindOne.mockReturnValue({
      lean: mockSessionLean.mockResolvedValue({
        encryptedAccessToken: 'enc-access',
        encryptedRefreshToken: 'enc-refresh',
        scope: 'scope.read',
        expiresAt: new Date('2026-03-19T10:00:00.000Z'),
        sessionExpiresAt: new Date('2026-03-19T12:00:00.000Z'),
        sessionId: 'session-1',
        runtimeSessionId: 'legacy-runtime-session-1',
        channelId: 'channel-1',
        __v: 2,
      }),
    });

    const store = await buildMongoSessionOAuthArtifactStore();
    const token = await store.findToken({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionPrincipal: 'sdk-session-1',
      provider: 'provider-1',
    });

    expect(token?.sessionId).toBe('session-1');
  });

  it('uses the supplied version for session CAS updates', async () => {
    mockSessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const store = await buildMongoSessionOAuthArtifactStore();
    const result = await store.compareAndSwapToken({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionPrincipal: 'sdk-session-1',
      sessionId: 'runtime-session-1',
      provider: 'provider-1',
      expectedVersion: 7,
      channelId: 'channel-1',
      authProfileId: 'profile-1',
      authProfileRef: 'google-oauth',
      sessionExpiresAt: new Date('2026-03-19T12:00:00.000Z'),
      next: {
        kind: 'upsert',
        token: {
          encryptedAccessToken: 'enc-access',
          encryptedRefreshToken: null,
          scope: 'scope.read',
          expiresAt: null,
          version: 7,
        },
      },
    });

    expect(result).toBe(true);
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
        provider: 'provider-1',
        __v: 7,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          runtimeSessionId: 'runtime-session-1',
          sessionExpiresAt: new Date('2026-03-19T12:00:00.000Z'),
          channelId: 'channel-1',
          authProfileId: 'profile-1',
          authProfileRef: 'google-oauth',
          consentedAt: expect.any(Date),
        }),
        $inc: { __v: 1 },
      }),
    );
  });

  it('deletes all artifacts for a canonical session id', async () => {
    mockSessionDeleteMany.mockResolvedValue({ deletedCount: 2 });

    const store = await buildMongoSessionOAuthArtifactStore();
    const deleted = await store.deleteBySessionId('runtime-session-1');

    expect(deleted).toBe(2);
    expect(mockSessionDeleteMany).toHaveBeenCalledWith({
      $or: [{ sessionId: 'runtime-session-1' }, { runtimeSessionId: 'runtime-session-1' }],
    });
  });
});
