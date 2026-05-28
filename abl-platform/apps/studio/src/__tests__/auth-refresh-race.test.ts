/**
 * Auth Refresh Token Race & Replay Tests
 *
 * Tests for ABLP-529: atomic refresh-token rotation with family/generation
 * lineage tracking. Verifies:
 * - Concurrent rotation (race-loss → sibling minted)
 * - Replay within grace window (sibling minted, no mass-revoke)
 * - Replay after grace window (family revoked)
 * - Reuse with generation delta > 1 (family revoked)
 * - Normal single rotation (new pair, lineage preserved)
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock server-only (imported by auth-service)
vi.mock('server-only', () => ({}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/super-admin', () => ({
  checkIsSuperAdmin: () => false,
}));

// =============================================================================
// MOCKS
// =============================================================================

const mockFindUserById = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockFindUserByGoogleId = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockCreateRefreshTokenRepo = vi.fn();
const mockFindRefreshToken = vi.fn();
const mockUpdateRefreshToken = vi.fn();
const mockRotateRefreshToken = vi.fn();
const mockFindRefreshTokensByFamily = vi.fn();
const mockRevokeRefreshTokenFamily = vi.fn();
const mockRevokeUserRefreshTokens = vi.fn();
const mockRevokeRefreshTokenByToken = vi.fn();
const mockFindTenantMembership = vi.fn();
const mockFindDefaultTenantMembership = vi.fn();
const mockFindUserTenantMemberships = vi.fn();
const mockHasInactiveTenantMemberships = vi.fn();
const mockCountPendingInvitations = vi.fn();
const mockFindPendingInvitationsForEmail = vi.fn();

vi.mock('@/repos/auth-repo', () => ({
  findUserById: (...args: unknown[]) => mockFindUserById(...args),
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  findUserByGoogleId: (...args: unknown[]) => mockFindUserByGoogleId(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  createRefreshToken: (...args: unknown[]) => mockCreateRefreshTokenRepo(...args),
  findRefreshToken: (...args: unknown[]) => mockFindRefreshToken(...args),
  updateRefreshToken: (...args: unknown[]) => mockUpdateRefreshToken(...args),
  rotateRefreshToken: (...args: unknown[]) => mockRotateRefreshToken(...args),
  findRefreshTokensByFamily: (...args: unknown[]) => mockFindRefreshTokensByFamily(...args),
  revokeRefreshTokenFamily: (...args: unknown[]) => mockRevokeRefreshTokenFamily(...args),
  revokeUserRefreshTokens: (...args: unknown[]) => mockRevokeUserRefreshTokens(...args),
  revokeRefreshTokenByToken: (...args: unknown[]) => mockRevokeRefreshTokenByToken(...args),
  findTenantMembership: (...args: unknown[]) => mockFindTenantMembership(...args),
  findDefaultTenantMembership: (...args: unknown[]) => mockFindDefaultTenantMembership(...args),
  findUserTenantMemberships: (...args: unknown[]) => mockFindUserTenantMemberships(...args),
  hasInactiveTenantMemberships: (...args: unknown[]) => mockHasInactiveTenantMemberships(...args),
  countPendingInvitations: (...args: unknown[]) => mockCountPendingInvitations(...args),
  findPendingInvitationsForEmail: (...args: unknown[]) =>
    mockFindPendingInvitationsForEmail(...args),
}));

vi.mock('@/lib/token-hash', () => ({
  hashToken: (token: string) => `hashed:${token}`,
}));

vi.mock('@/config', () => ({
  getConfig: () => ({
    jwt: {
      secret: 'test-jwt-secret-that-is-long-enough-for-signing-tokens',
      accessExpiry: '15m',
      refreshExpiry: '7d',
    },
    auth: {
      mfa: { partialTokenTtlSeconds: 300, issuer: 'KorePlatform' },
      tokens: {
        sdkSessionTtlSeconds: 14400,
        deviceAuthTtlMs: 15 * 60 * 1000,
        refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
        mfaCookieMaxAgeSeconds: 300,
      },
      lockout: { maxFailedAttempts: 5, lockDurationMs: 15 * 60 * 1000 },
      sso: { authCodeTtlSeconds: 60, oidcStateTtlSeconds: 600, samlAssertionTtlSeconds: 3600 },
      rateLimits: { login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 } },
    },
    server: { frontendUrl: 'http://localhost:5173' },
  }),
  isConfigLoaded: () => true,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getFrontendUrl: () => 'http://localhost:5173',
  getEmailRegex: () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  getMicrosoftConfig: () => ({}),
  getLinkedInConfig: () => ({}),
}));

vi.mock('@agent-platform/shared/errors', () => {
  class AppError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, opts?: { code?: string; statusCode?: number }) {
      super(message);
      this.name = 'AppError';
      this.code = opts?.code || 'INTERNAL_ERROR';
      this.statusCode = opts?.statusCode || 500;
    }
  }
  return {
    AppError,
    ErrorCodes: {
      BAD_REQUEST: { code: 'BAD_REQUEST', statusCode: 400 },
      UNAUTHORIZED: { code: 'UNAUTHORIZED', statusCode: 401 },
      FORBIDDEN: { code: 'FORBIDDEN', statusCode: 403 },
      NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
      CONFLICT: { code: 'CONFLICT', statusCode: 409 },
      GONE: { code: 'GONE', statusCode: 410 },
      UNPROCESSABLE_ENTITY: { code: 'UNPROCESSABLE_ENTITY', statusCode: 422 },
      TOO_MANY_REQUESTS: { code: 'TOO_MANY_REQUESTS', statusCode: 429 },
      SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', statusCode: 503 },
      INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
    },
  };
});

vi.mock('@agent-platform/shared', () => ({
  slugify: (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, ''),
}));

vi.mock('@/services/invitation-service', () => ({
  acceptInvitationById: vi.fn(),
}));

const authServiceModulePromise = import('../services/auth-service');

// =============================================================================
// HELPERS
// =============================================================================

const TEST_USER = { id: 'user-1', email: 'test@example.com' };

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-1',
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 600_000),
    familyId: 'family-1',
    generation: 1,
    createdAt: new Date(),
    user: TEST_USER,
    ...overrides,
  };
}

function makeFamilyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-fam',
    userId: 'user-1',
    familyId: 'family-1',
    generation: 1,
    revokedAt: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Refresh Token Rotation — Race & Replay', () => {
  let authService: typeof import('../services/auth-service');

  beforeAll(async () => {
    authService = await authServiceModulePromise;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserTenantMemberships.mockResolvedValue([]);
    mockHasInactiveTenantMemberships.mockResolvedValue(false);
    mockFindDefaultTenantMembership.mockResolvedValue(null);
  });

  // ─── Test 1: Normal single rotation ──────────────────────────────────

  test('normal rotation: new pair with lineage, old row revoked, generation incremented', async () => {
    const tokenRecord = makeTokenRecord();
    mockFindRefreshToken.mockResolvedValue(tokenRecord);
    mockRotateRefreshToken.mockResolvedValue({ ...tokenRecord, revokedAt: new Date() });
    mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-2' });

    const result = await authService.refreshTokens('old-token');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeTruthy();
    expect(result!.refreshToken).toBeTruthy();

    // Atomic rotation was called
    expect(mockRotateRefreshToken).toHaveBeenCalledWith('rt-1', { revokedAt: expect.any(Date) });

    // New token created with lineage
    expect(mockCreateRefreshTokenRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-1',
        generation: 2,
        rotatedFromId: 'rt-1',
      }),
    );

    // No mass-revoke
    expect(mockRevokeUserRefreshTokens).not.toHaveBeenCalled();
    expect(mockRevokeRefreshTokenFamily).not.toHaveBeenCalled();
  });

  // ─── Test 2: Concurrent rotation — race-loss mints sibling ──────────

  test('concurrent refresh x2: loser mints sibling, no mass-revoke', async () => {
    const tokenRecord = makeTokenRecord();
    mockFindRefreshToken.mockResolvedValue(tokenRecord);

    // Loser: rotateRefreshToken returns null (another caller already rotated it)
    mockRotateRefreshToken.mockResolvedValue(null);

    // Family has the original (revoked) and the winner's token (gen 2)
    const winnerCreatedAt = new Date();
    mockFindRefreshTokensByFamily.mockResolvedValue([
      makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date() }),
      makeFamilyRow({ id: 'rt-2', generation: 2, createdAt: winnerCreatedAt }),
    ]);

    // Loser mints sibling at gen 3
    mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-3' });

    const result = await authService.refreshTokens('old-token');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeTruthy();
    expect(result!.refreshToken).toBeTruthy();

    // Sibling minted at max(2) + 1 = 3
    expect(mockCreateRefreshTokenRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-1',
        generation: 3,
        rotatedFromId: 'rt-1',
      }),
    );

    // No mass-revoke fired
    expect(mockRevokeUserRefreshTokens).not.toHaveBeenCalled();
    expect(mockRevokeRefreshTokenFamily).not.toHaveBeenCalled();
  });

  // ─── Test 3: Replay within grace window — sibling minted ────────────

  test('replay within grace window: mints sibling, no mass-revoke', async () => {
    // Presented token is already revoked (replay scenario)
    const tokenRecord = makeTokenRecord({
      revokedAt: new Date(Date.now() - 2000), // revoked 2s ago
    });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);

    // Family: gen 1 revoked, gen 2 active (created recently within grace window)
    mockFindRefreshTokensByFamily.mockResolvedValue([
      makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date(Date.now() - 2000) }),
      makeFamilyRow({ id: 'rt-2', generation: 2, createdAt: new Date() }),
    ]);

    mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-3' });

    const result = await authService.refreshTokens('old-token');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeTruthy();
    expect(result!.refreshToken).toBeTruthy();

    // Sibling minted
    expect(mockCreateRefreshTokenRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'family-1',
        generation: 3,
      }),
    );

    // No mass-revoke
    expect(mockRevokeUserRefreshTokens).not.toHaveBeenCalled();
    expect(mockRevokeRefreshTokenFamily).not.toHaveBeenCalled();
  });

  test('retries sibling mint when the next generation collides', async () => {
    const tokenRecord = makeTokenRecord({
      revokedAt: new Date(Date.now() - 2000),
    });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);
    mockFindRefreshTokensByFamily
      .mockResolvedValueOnce([
        makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date(Date.now() - 2000) }),
        makeFamilyRow({ id: 'rt-2', generation: 2, createdAt: new Date() }),
      ])
      .mockResolvedValueOnce([
        makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date(Date.now() - 2000) }),
        makeFamilyRow({ id: 'rt-2', generation: 2, createdAt: new Date() }),
        makeFamilyRow({ id: 'rt-3', generation: 3, createdAt: new Date() }),
      ]);

    const duplicateGenerationError = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
    });
    mockCreateRefreshTokenRepo
      .mockRejectedValueOnce(duplicateGenerationError)
      .mockResolvedValueOnce({ id: 'rt-4' });

    const result = await authService.refreshTokens('old-token');

    expect(result).not.toBeNull();
    expect(mockCreateRefreshTokenRepo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        familyId: 'family-1',
        generation: 3,
      }),
    );
    expect(mockCreateRefreshTokenRepo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        familyId: 'family-1',
        generation: 4,
      }),
    );
    expect(mockRevokeRefreshTokenFamily).not.toHaveBeenCalled();
  });

  // ─── Test 4: Replay AFTER grace window — family revoked ─────────────

  test('replay after grace window: family revoked, returns null', async () => {
    // Presented token revoked long ago
    const tokenRecord = makeTokenRecord({
      revokedAt: new Date(Date.now() - 60_000), // revoked 60s ago
    });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);

    // Family: gen 1 revoked, gen 2 active but created outside grace window
    mockFindRefreshTokensByFamily.mockResolvedValue([
      makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date(Date.now() - 60_000) }),
      makeFamilyRow({
        id: 'rt-2',
        generation: 2,
        createdAt: new Date(Date.now() - 30_000), // 30s ago, outside default 10s grace
      }),
    ]);

    const result = await authService.refreshTokens('old-token');

    expect(result).toBeNull();

    // Family revoked
    expect(mockRevokeRefreshTokenFamily).toHaveBeenCalledWith('family-1');

    // No user-wide mass-revoke
    expect(mockRevokeUserRefreshTokens).not.toHaveBeenCalled();
  });

  // ─── Test 5: Generation delta > 1 — reuse attack ───────────────────

  test('reuse with generation delta > 1: family revoked, returns null', async () => {
    // Presented token at gen 1, but family is already at gen 3
    const tokenRecord = makeTokenRecord({
      revokedAt: new Date(Date.now() - 5000), // revoked
      generation: 1,
    });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);

    // Family: gen 1 revoked, gen 2 revoked, gen 3 active
    mockFindRefreshTokensByFamily.mockResolvedValue([
      makeFamilyRow({ id: 'rt-1', generation: 1, revokedAt: new Date() }),
      makeFamilyRow({ id: 'rt-2', generation: 2, revokedAt: new Date() }),
      makeFamilyRow({ id: 'rt-3', generation: 3, createdAt: new Date() }),
    ]);

    const result = await authService.refreshTokens('old-token');

    expect(result).toBeNull();

    // Family revoked because gen delta > 1 (presented gen 1, max gen 3)
    expect(mockRevokeRefreshTokenFamily).toHaveBeenCalledWith('family-1');

    // No new token minted
    expect(mockCreateRefreshTokenRepo).not.toHaveBeenCalled();
  });

  // ─── Test 6: Pre-migration token without familyId ───────────────────

  test('revoked token without familyId falls back to legacy mass-revoke', async () => {
    const tokenRecord = makeTokenRecord({
      revokedAt: new Date(),
      familyId: null,
      generation: 1,
    });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);

    const result = await authService.refreshTokens('old-token');

    expect(result).toBeNull();
    expect(mockRevokeUserRefreshTokens).toHaveBeenCalledWith('user-1');
    expect(mockRevokeRefreshTokenFamily).not.toHaveBeenCalled();
  });

  // ─── Test 7: Winner path populates familyId on pre-migration token ──

  test('winner path assigns new familyId when token has null familyId', async () => {
    const tokenRecord = makeTokenRecord({ familyId: null });
    mockFindRefreshToken.mockResolvedValue(tokenRecord);
    mockRotateRefreshToken.mockResolvedValue({ ...tokenRecord, revokedAt: new Date() });
    mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-2' });

    const result = await authService.refreshTokens('old-token');

    expect(result).not.toBeNull();

    // A new familyId (UUID) should have been generated
    const createCall = mockCreateRefreshTokenRepo.mock.calls[0][0];
    expect(createCall.familyId).toBeTruthy();
    expect(createCall.familyId).not.toBe('null');
    expect(createCall.generation).toBe(2);
  });
});
