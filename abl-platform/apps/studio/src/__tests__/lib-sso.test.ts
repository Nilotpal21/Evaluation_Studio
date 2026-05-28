/**
 * Tests for SSO and DB utilities:
 * - sso-auth-codes.ts (storeAuthCode, consumeAuthCode)
 * - sso-state-store.ts (storeOIDCState, consumeOIDCState)
 * - ensure-db.ts (ensureDb)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock database module for ensure-db tests
// ---------------------------------------------------------------------------

const mockEnsureConnected = vi.fn().mockResolvedValue(undefined);
const mockSetMasterKey = vi.fn();
const mockSetEncryptionFacade = vi.fn();
const mockSetGlobalKMSResolver = vi.fn();
const mockDekFacade = { id: 'test-facade' };
const mockDekResolver = { id: 'test-resolver' };
const mockInitDEKFacade = vi.fn().mockResolvedValue({
  facade: mockDekFacade,
  resolver: mockDekResolver,
});
const mockDbReady = Promise.resolve();
const mockIsDatabaseAvailable = vi.fn(() => true);

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: (...args: unknown[]) => mockEnsureConnected(...args),
  setMasterKey: (...args: unknown[]) => mockSetMasterKey(...args),
  setEncryptionFacade: (...args: unknown[]) => mockSetEncryptionFacade(...args),
}));

vi.mock('@agent-platform/database/kms', () => ({
  initDEKFacade: (...args: unknown[]) => mockInitDEKFacade(...args),
  setGlobalKMSResolver: (...args: unknown[]) => mockSetGlobalKMSResolver(...args),
}));

vi.mock('@/db', () => ({
  dbReady: mockDbReady,
  isDatabaseAvailable: (...args: unknown[]) => mockIsDatabaseAvailable(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/redis-client (imported by @/services/sso/sso-state-store)
// Redis is unavailable — forces in-memory fallback
// ---------------------------------------------------------------------------

vi.mock('@/lib/redis-client', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
}));

// ---------------------------------------------------------------------------
// Mock @/lib/auth-constants (imported by @/services/sso/sso-state-store)
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth-constants', () => ({
  REDIS_PREFIX_SAML_ASSERTION: 'sso:saml:assertion:',
  REDIS_PREFIX_OIDC_STATE: 'sso:oidc:state:',
  REDIS_PREFIX_AUTH_CODE: 'sso:authcode:',
  SSO_STATE_CLEANUP_INTERVAL_MS: 60_000,
}));

// ---------------------------------------------------------------------------
// Mock @/config (imported by sso-auth-codes and sso-state-store lib modules)
// ---------------------------------------------------------------------------

vi.mock('@/config', () => ({
  getConfig: () => ({
    auth: {
      sso: {
        authCodeTtlSeconds: 60,
        oidcStateTtlSeconds: 300, // 5 minutes
        samlAssertionTtlSeconds: 3600,
      },
    },
  }),
  isConfigLoaded: () => true,
}));

// ---------------------------------------------------------------------------
// Mock @/services/sso/sso-state-store — load real implementation via
// relative path to bypass the @/ alias dynamic-import resolution issue.
// All its dependencies are mocked above (redis-client, auth-constants).
// ---------------------------------------------------------------------------

vi.mock('@/services/sso/sso-state-store', async () => {
  return await vi.importActual('../services/sso/sso-state-store');
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockInitDEKFacade.mockResolvedValue({
    facade: mockDekFacade,
    resolver: mockDekResolver,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// sso-auth-codes.ts
// ===========================================================================

describe('sso-auth-codes', () => {
  const sampleAuthData = {
    accessToken: 'access-token-123',
    refreshToken: 'refresh-token-456',
    expiresIn: 3600,
    needsOnboarding: false,
    pendingInvitations: 2,
  };

  describe('storeAuthCode', () => {
    it('should store an auth code that can be consumed', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      await storeAuthCode('code-abc', sampleAuthData);
      const result = await consumeAuthCode('code-abc');

      expect(result).toEqual(sampleAuthData);
    });

    it('should store multiple codes independently', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      const data1 = { ...sampleAuthData, accessToken: 'token-1' };
      const data2 = { ...sampleAuthData, accessToken: 'token-2' };

      await storeAuthCode('code-1', data1);
      await storeAuthCode('code-2', data2);

      const result1 = await consumeAuthCode('code-1');
      const result2 = await consumeAuthCode('code-2');

      expect(result1?.accessToken).toBe('token-1');
      expect(result2?.accessToken).toBe('token-2');
    });
  });

  describe('consumeAuthCode', () => {
    it('should return null for non-existent code', async () => {
      const { consumeAuthCode } = await import('../lib/sso-auth-codes');
      const result = await consumeAuthCode('nonexistent-code');
      expect(result).toBeNull();
    });

    it('should delete code after consumption (single-use)', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      await storeAuthCode('single-use-code', sampleAuthData);

      const first = await consumeAuthCode('single-use-code');
      expect(first).not.toBeNull();

      const second = await consumeAuthCode('single-use-code');
      expect(second).toBeNull();
    });

    it('should return null for expired codes', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      await storeAuthCode('expiring-code', sampleAuthData);

      // Advance time past the 60-second TTL
      vi.advanceTimersByTime(61_000);

      const result = await consumeAuthCode('expiring-code');
      // The code is either auto-deleted by setTimeout or expired by time check
      expect(result).toBeNull();
    });

    it('should strip createdAt from the returned data', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      await storeAuthCode('clean-data-code', sampleAuthData);
      const result = await consumeAuthCode('clean-data-code');

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('createdAt');
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn');
    });

    it('should handle optional fields correctly', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      const minimalData = {
        accessToken: 'min-token',
        refreshToken: 'min-refresh',
        expiresIn: 1800,
      };

      await storeAuthCode('minimal-code', minimalData);
      const result = await consumeAuthCode('minimal-code');

      expect(result).toEqual(minimalData);
    });

    it('should include needsOnboarding and pendingInvitations when provided', async () => {
      const { storeAuthCode, consumeAuthCode } = await import('../lib/sso-auth-codes');

      const fullData = {
        accessToken: 'full-token',
        refreshToken: 'full-refresh',
        expiresIn: 3600,
        needsOnboarding: true,
        pendingInvitations: 5,
      };

      await storeAuthCode('full-code', fullData);
      const result = await consumeAuthCode('full-code');

      expect(result?.needsOnboarding).toBe(true);
      expect(result?.pendingInvitations).toBe(5);
    });
  });
});

// ===========================================================================
// sso-state-store.ts
// ===========================================================================

describe('sso-state-store', () => {
  describe('storeOIDCState', () => {
    it('should store state that can be consumed', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('state-xyz', 'org-123');
      const result = await consumeOIDCState('state-xyz');

      expect(result).toEqual({ orgId: 'org-123' });
    });

    it('should preserve admin redirect metadata when provided', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState(
        'state-admin',
        'org-admin',
        'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
      );
      const result = await consumeOIDCState('state-admin');

      expect(result).toEqual({
        orgId: 'org-admin',
        adminRedirect: 'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
      });
    });

    it('should overwrite existing state with same key', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('dup-state', 'org-old');
      await storeOIDCState('dup-state', 'org-new');

      const result = await consumeOIDCState('dup-state');
      expect(result).toEqual({ orgId: 'org-new' });
    });

    it('should store multiple states independently', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('state-a-multi', 'org-a');
      await storeOIDCState('state-b-multi', 'org-b');

      expect(await consumeOIDCState('state-a-multi')).toEqual({ orgId: 'org-a' });
      expect(await consumeOIDCState('state-b-multi')).toEqual({ orgId: 'org-b' });
    });
  });

  describe('consumeOIDCState', () => {
    it('should return null for non-existent state', async () => {
      const { consumeOIDCState } = await import('../lib/sso-state-store');
      const result = await consumeOIDCState('never-stored');
      expect(result).toBeNull();
    });

    it('should delete state after consumption (single-use)', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('once-only-state', 'org-once');

      const first = await consumeOIDCState('once-only-state');
      expect(first).toEqual({ orgId: 'org-once' });

      const second = await consumeOIDCState('once-only-state');
      expect(second).toBeNull();
    });

    it('should return null for expired state (after TTL)', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('expiring-state', 'org-exp');

      // Default TTL is 600 seconds (10 minutes) when config is not loaded
      vi.advanceTimersByTime(601_000);

      const result = await consumeOIDCState('expiring-state');
      expect(result).toBeNull();
    });

    it('should still be valid just before TTL expires', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('almost-expired-state', 'org-valid');

      // Advance to just under 5 minutes (but within TTL since setTimeout hasn't fired yet)
      vi.advanceTimersByTime(4 * 60 * 1000);

      const result = await consumeOIDCState('almost-expired-state');
      expect(result).toEqual({ orgId: 'org-valid' });
    });

    it('should return orgId as the only field', async () => {
      const { storeOIDCState, consumeOIDCState } = await import('../lib/sso-state-store');

      await storeOIDCState('clean-state', 'org-clean');
      const result = await consumeOIDCState('clean-state');

      expect(result).toEqual({ orgId: 'org-clean' });
      expect(Object.keys(result!)).toEqual(['orgId']);
    });
  });
});

// ===========================================================================
// ensure-db.ts
// ===========================================================================

describe('ensure-db', () => {
  let originalEnv: string | undefined;
  let originalManagedEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ENCRYPTION_MASTER_KEY;
    originalManagedEnv = process.env.MONGODB_MANAGED;
    process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    // We need to reset the module to clear the _masterKeySet flag
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_MASTER_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_MASTER_KEY;
    }

    if (originalManagedEnv !== undefined) {
      process.env.MONGODB_MANAGED = originalManagedEnv;
    } else {
      delete process.env.MONGODB_MANAGED;
    }
  });

  describe('ensureDb', () => {
    it('should call ensureConnected', async () => {
      const { ensureDb } = await import('../lib/ensure-db');
      await ensureDb();
      expect(mockEnsureConnected).toHaveBeenCalled();
    });

    it('should set master key when ENCRYPTION_MASTER_KEY is defined', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'b'.repeat(64);
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb();

      expect(mockSetMasterKey).toHaveBeenCalledWith('b'.repeat(64));
      expect(mockInitDEKFacade).toHaveBeenCalledWith({ masterKeyHex: 'b'.repeat(64) });
      expect(mockSetEncryptionFacade).toHaveBeenCalledWith(mockDekFacade);
      expect(mockSetGlobalKMSResolver).toHaveBeenCalledWith(mockDekResolver);
    });

    it('should fail when ENCRYPTION_MASTER_KEY is not defined', async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb()
        .then(() => {
          throw new Error('Expected ensureDb to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'ENCRYPTION_MASTER_KEY is required for Studio database access',
          );
        });
      expect(mockSetMasterKey).not.toHaveBeenCalled();
      expect(mockInitDEKFacade).not.toHaveBeenCalled();
    });

    it('should only set master key once across multiple calls', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'c'.repeat(64);
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb();
      await ensureDb();
      await ensureDb();

      expect(mockSetMasterKey).toHaveBeenCalledTimes(1);
      expect(mockInitDEKFacade).toHaveBeenCalledTimes(1);
    });

    it('should call ensureConnected on every invocation', async () => {
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb();
      await ensureDb();
      await ensureDb();

      expect(mockEnsureConnected).toHaveBeenCalledTimes(3);
    });

    it('should propagate errors from ensureConnected', async () => {
      mockEnsureConnected.mockRejectedValueOnce(new Error('Connection failed'));
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb()
        .then(() => {
          throw new Error('Expected ensureDb to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'Connection failed',
          );
        });
    });

    it('should bootstrap the managed MongoDB connection when MONGODB_MANAGED is true', async () => {
      process.env.MONGODB_MANAGED = 'true';
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb();

      expect(mockEnsureConnected).not.toHaveBeenCalled();
      expect(mockIsDatabaseAvailable).toHaveBeenCalled();
      expect(mockInitDEKFacade).toHaveBeenCalledTimes(1);
    });

    it('should fail when managed MongoDB is unavailable', async () => {
      process.env.MONGODB_MANAGED = 'true';
      mockIsDatabaseAvailable.mockReturnValueOnce(false);
      const { ensureDb } = await import('../lib/ensure-db');

      await ensureDb()
        .then(() => {
          throw new Error('Expected ensureDb to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'Managed MongoDB connection is not available',
          );
        });
      expect(mockEnsureConnected).not.toHaveBeenCalled();
    });
  });
});
