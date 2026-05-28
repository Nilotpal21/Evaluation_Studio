/**
 * Tests for Device Auth Service
 *
 * Unit tests with mocked Mongoose models (DeviceAuthRequest) and repo functions
 * (findUserById) from '@agent-platform/database/models' and '../repos/auth-repo.js'.
 * JWT utilities (resolveFirstMembership, buildAccessTokenPayload, signAccessToken,
 * createStoredRefreshToken) from '../utils/jwt-utils.js' are also mocked.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MONGOOSE MODEL MOCKS
// =============================================================================

const mockDeviceAuthCreate = vi.fn();
const mockDeviceAuthFindOne = vi.fn();
const mockDeviceAuthUpdateOne = vi.fn();

/** Simulates Mongoose chainable query with .lean() */
function chainable(result: any) {
  const chain: any = {
    lean: vi.fn(() => Promise.resolve(result)),
    sort: vi.fn(function (this: any) {
      return this;
    }),
  };
  chain.sort.mockReturnValue(chain);
  return chain;
}

vi.mock('@agent-platform/database/models', () => ({
  DeviceAuthRequest: {
    create: (...args: any[]) => mockDeviceAuthCreate(...args),
    findOne: (...args: any[]) => {
      const result = mockDeviceAuthFindOne(...args);
      return chainable(result);
    },
    updateOne: (...args: any[]) => mockDeviceAuthUpdateOne(...args),
  },
}));

// =============================================================================
// REPO & UTILITY MOCKS
// =============================================================================

const mockFindUserById = vi.fn();
vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  findUserById: (...args: any[]) => mockFindUserById(...args),
}));

const mockResolveFirstMembership = vi.fn();
const mockBuildAccessTokenPayload = vi.fn();
const mockSignAccessToken = vi.fn();
const mockCreateStoredRefreshToken = vi.fn();

vi.mock('../utils/jwt-utils.js', () => ({
  resolveFirstMembership: (...args: any[]) => mockResolveFirstMembership(...args),
  buildAccessTokenPayload: (...args: any[]) => mockBuildAccessTokenPayload(...args),
  signAccessToken: (...args: any[]) => mockSignAccessToken(...args),
  createStoredRefreshToken: (...args: any[]) => mockCreateStoredRefreshToken(...args),
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    jwt: { secret: 'test-jwt-secret-at-least-32-chars-long' },
  }),
}));

// =============================================================================
// IMPORT SUBJECTS (after mocks are registered)
// =============================================================================

import {
  generateUserCode,
  hashToken,
  createDeviceAuthRequest,
  getDeviceAuthByUserCode,
  authorizeDeviceRequest,
  pollDeviceToken,
  createDeviceTokenPair,
} from '../services/device-auth-service.js';

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Pure utility functions (no DB dependency)
// =============================================================================

describe('Device Auth Service', () => {
  describe('generateUserCode', () => {
    test('generates 9-character code with dash (XXXX-XXXX)', () => {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code).toHaveLength(9); // 4 + 1 dash + 4
    });

    test('does not contain ambiguous characters (0, O, 1, I)', () => {
      for (let i = 0; i < 100; i++) {
        const code = generateUserCode();
        expect(code).not.toMatch(/[0OI1]/);
      }
    });

    test('generates unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        codes.add(generateUserCode());
      }
      expect(codes.size).toBe(50);
    });
  });

  describe('hashToken', () => {
    test('returns SHA-256 hex string', () => {
      const hash = hashToken('test-token');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('is deterministic', () => {
      expect(hashToken('same-input')).toBe(hashToken('same-input'));
    });

    test('different inputs produce different hashes', () => {
      expect(hashToken('input-a')).not.toBe(hashToken('input-b'));
    });
  });

  // ===========================================================================
  // DB-dependent tests with mocked Mongoose models
  // ===========================================================================

  describe('createDeviceAuthRequest', () => {
    test('creates request with hashed device code', async () => {
      mockDeviceAuthCreate.mockResolvedValue({});

      const result = await createDeviceAuthRequest(['read_traces']);

      expect(mockDeviceAuthCreate).toHaveBeenCalledTimes(1);
      const createArg = mockDeviceAuthCreate.mock.calls[0][0];
      // The stored deviceCode should be a SHA-256 hash (64 hex chars), not the raw code
      expect(createArg.deviceCode).toMatch(/^[a-f0-9]{64}$/);
      // The returned deviceCode should be the raw unhashed code (64 hex chars from randomBytes(32))
      expect(result.deviceCode).toHaveLength(64);
      // Stored hash should match hashing the returned raw code
      expect(createArg.deviceCode).toBe(hashToken(result.deviceCode));
    });

    test('stores scopes as array', async () => {
      mockDeviceAuthCreate.mockResolvedValue({});

      await createDeviceAuthRequest(['read_traces', 'write_agents']);

      const createArg = mockDeviceAuthCreate.mock.calls[0][0];
      expect(createArg.scopes).toEqual(['read_traces', 'write_agents']);
    });

    test('sets expiry to 15 minutes from now', async () => {
      mockDeviceAuthCreate.mockResolvedValue({});
      const before = Date.now();

      const result = await createDeviceAuthRequest(['read_traces']);

      const after = Date.now();
      const createArg = mockDeviceAuthCreate.mock.calls[0][0];
      const expectedMin = before + 15 * 60 * 1000;
      const expectedMax = after + 15 * 60 * 1000;
      const storedExpiry = createArg.expiresAt.getTime();
      expect(storedExpiry).toBeGreaterThanOrEqual(expectedMin);
      expect(storedExpiry).toBeLessThanOrEqual(expectedMax);
      // Also returned in the result
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBe(storedExpiry);
    });
  });

  describe('getDeviceAuthByUserCode', () => {
    test('looks up by userCode', async () => {
      const mockRecord = {
        _id: 'req-1',
        userCode: 'ABCD-EFGH',
        deviceCode: 'hashed-code',
        scopes: ['read_traces'],
        expiresAt: new Date(Date.now() + 600_000),
      };
      mockDeviceAuthFindOne.mockReturnValue(mockRecord);

      const result = await getDeviceAuthByUserCode('ABCD-EFGH');

      expect(mockDeviceAuthFindOne).toHaveBeenCalledWith({ userCode: 'ABCD-EFGH' });
      expect(result).toEqual(mockRecord);
    });

    test('returns null when not found', async () => {
      mockDeviceAuthFindOne.mockReturnValue(null);

      const result = await getDeviceAuthByUserCode('ZZZZ-ZZZZ');

      expect(result).toBeNull();
    });
  });

  describe('authorizeDeviceRequest', () => {
    test('returns true when update succeeds', async () => {
      mockDeviceAuthUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      const result = await authorizeDeviceRequest('ABCD-EFGH', 'user-1');

      expect(result).toBe(true);
      expect(mockDeviceAuthUpdateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = mockDeviceAuthUpdateOne.mock.calls[0];
      expect(filter.userCode).toBe('ABCD-EFGH');
      expect(filter.authorizedAt).toBeNull();
      expect(filter.consumedAt).toBeNull();
      expect(filter.expiresAt).toHaveProperty('$gt');
      expect(update.$set.userId).toBe('user-1');
      expect(update.$set.authorizedAt).toBeInstanceOf(Date);
    });

    test('returns false when no matching request', async () => {
      mockDeviceAuthUpdateOne.mockResolvedValue({ modifiedCount: 0 });

      const result = await authorizeDeviceRequest('NOPE-NOPE', 'user-1');

      expect(result).toBe(false);
    });
  });

  describe('pollDeviceToken', () => {
    test('returns expired for unknown device code', async () => {
      mockDeviceAuthFindOne.mockReturnValue(null);

      const result = await pollDeviceToken('unknown-device-code');

      expect(result).toEqual({ status: 'expired' });
    });

    test('returns expired when past expiresAt', async () => {
      mockDeviceAuthFindOne.mockReturnValue({
        _id: 'req-1',
        expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
        consumedAt: null,
        authorizedAt: null,
        userId: null,
      });

      const result = await pollDeviceToken('some-device-code');

      expect(result).toEqual({ status: 'expired' });
    });

    test('returns consumed when already consumed', async () => {
      mockDeviceAuthFindOne.mockReturnValue({
        _id: 'req-1',
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: new Date(), // already consumed
        authorizedAt: new Date(),
        userId: 'user-1',
      });

      const result = await pollDeviceToken('some-device-code');

      expect(result).toEqual({ status: 'consumed' });
    });

    test('returns pending when not yet authorized', async () => {
      mockDeviceAuthFindOne.mockReturnValue({
        _id: 'req-1',
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
        authorizedAt: null,
        userId: null,
      });

      const result = await pollDeviceToken('some-device-code');

      expect(result).toEqual({ status: 'pending' });
    });

    test('returns authorized with userId and marks consumed', async () => {
      mockDeviceAuthFindOne.mockReturnValue({
        _id: 'req-1',
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
        authorizedAt: new Date(),
        userId: 'user-1',
        scopes: ['read_traces', 'write_agents'],
      });
      mockDeviceAuthUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      const result = await pollDeviceToken('some-device-code');

      expect(result).toEqual({
        status: 'authorized',
        userId: 'user-1',
        scopes: ['read_traces', 'write_agents'],
      });
      // Should mark as consumed via updateOne
      expect(mockDeviceAuthUpdateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = mockDeviceAuthUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'req-1' });
      expect(update.$set.consumedAt).toBeInstanceOf(Date);
    });

    test('hashes device code before lookup', async () => {
      mockDeviceAuthFindOne.mockReturnValue(null);
      const rawDeviceCode = 'my-raw-device-code';
      const expectedHash = hashToken(rawDeviceCode);

      await pollDeviceToken(rawDeviceCode);

      expect(mockDeviceAuthFindOne).toHaveBeenCalledWith({ deviceCode: expectedHash });
    });
  });

  describe('createDeviceTokenPair', () => {
    test('creates JWT and refresh token for valid user', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com', name: 'Test User' };
      const mockMembership = {
        tenantId: 'tenant-1',
        role: 'ADMIN',
        tenant: { organizationId: 'org-1' },
      };
      const mockPayload = {
        sub: 'user-1',
        email: 'test@example.com',
        type: 'access',
        tenantId: 'tenant-1',
        role: 'ADMIN',
      };

      mockFindUserById.mockResolvedValue(mockUser);
      mockResolveFirstMembership.mockResolvedValue(mockMembership);
      mockBuildAccessTokenPayload.mockReturnValue(mockPayload);
      mockSignAccessToken.mockReturnValue('signed-jwt-token');
      mockCreateStoredRefreshToken.mockResolvedValue('raw-refresh-token');

      const result = await createDeviceTokenPair('user-1');

      // Verify correct call chain
      expect(mockFindUserById).toHaveBeenCalledWith('user-1');
      expect(mockResolveFirstMembership).toHaveBeenCalledWith('user-1');
      expect(mockBuildAccessTokenPayload).toHaveBeenCalledWith(mockUser, mockMembership);
      expect(mockSignAccessToken).toHaveBeenCalledWith(
        mockPayload,
        'test-jwt-secret-at-least-32-chars-long',
        86400, // 24 hours in seconds
      );
      expect(mockCreateStoredRefreshToken).toHaveBeenCalledWith('user-1');

      // Verify result shape
      expect(result).toEqual({
        accessToken: 'signed-jwt-token',
        refreshToken: 'raw-refresh-token',
        expiresIn: 86400,
      });
    });

    test('throws when user not found', async () => {
      mockFindUserById.mockResolvedValue(null);

      await expect(createDeviceTokenPair('nonexistent-user')).rejects.toThrow('User not found');

      expect(mockFindUserById).toHaveBeenCalledWith('nonexistent-user');
      // Should not attempt JWT creation
      expect(mockResolveFirstMembership).not.toHaveBeenCalled();
      expect(mockSignAccessToken).not.toHaveBeenCalled();
    });

    test('works without tenant membership', async () => {
      const mockUser = { id: 'user-2', email: 'solo@example.com', name: 'Solo User' };

      mockFindUserById.mockResolvedValue(mockUser);
      mockResolveFirstMembership.mockResolvedValue(null); // no membership
      mockBuildAccessTokenPayload.mockReturnValue({
        sub: 'user-2',
        email: 'solo@example.com',
        type: 'access',
      });
      mockSignAccessToken.mockReturnValue('signed-jwt-no-tenant');
      mockCreateStoredRefreshToken.mockResolvedValue('raw-refresh-no-tenant');

      const result = await createDeviceTokenPair('user-2');

      // buildAccessTokenPayload called with null membership
      expect(mockBuildAccessTokenPayload).toHaveBeenCalledWith(mockUser, null);

      expect(result).toEqual({
        accessToken: 'signed-jwt-no-tenant',
        refreshToken: 'raw-refresh-no-tenant',
        expiresIn: 86400,
      });
    });
  });
});
