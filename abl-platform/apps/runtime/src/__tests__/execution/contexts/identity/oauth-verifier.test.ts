/**
 * OAuthVerifier Tests
 *
 * Tests the OAuth identity verifier adapter that uses Arctic v3 for OAuth-based
 * identity verification. The flow is two-step:
 *   initiate() -> generates state + PKCE code verifier, stores them in the
 *                 VerificationTokenStore, creates an authorization URL, returns
 *                 { success: true, attemptId, challengeData: { userAction: 'redirect', redirectUrl } }
 *   complete()  -> loads the attempt from the store, exchanges the authorization code
 *                 for tokens via the Arctic provider, extracts verified email from
 *                 the userinfo endpoint, marks verified, returns
 *                 { success: true, identityTier: 2, verifiedIdentity: email }
 *
 * All Arctic provider interactions are mocked — no real HTTP calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuthVerifier } from '../../../../contexts/identity/infrastructure/verifiers/oauth-verifier.js';
import type { VerificationInput } from '../../../../contexts/identity/domain/identity-verifier.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../../../contexts/identity/infrastructure/verification-token-store.js';
import type { OAuthProviderAdapter } from '../../../../contexts/identity/infrastructure/verifiers/oauth-verifier.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'web',
    identityValue: 'user@example.com',
    identityType: 'email',
    ...overrides,
  };
}

function createMockStore(): VerificationTokenStore {
  const storage = new Map<string, StoredVerificationAttempt>();

  return {
    create: vi.fn(async (attempt: StoredVerificationAttempt) => {
      storage.set(`${attempt.tenantId}:${attempt.id}`, { ...attempt });
    }),
    get: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      return attempt ? { ...attempt } : null;
    }),
    incrementAttempts: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      if (attempt) {
        const updated = { ...attempt, attempts: attempt.attempts + 1 };
        storage.set(`${tenantId}:${attemptId}`, updated);
      }
    }),
    markVerified: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      if (attempt) {
        const updated = { ...attempt, status: 'verified' as const };
        storage.set(`${tenantId}:${attemptId}`, updated);
      }
    }),
  };
}

function createMockProvider(overrides?: Partial<OAuthProviderAdapter>): OAuthProviderAdapter {
  return {
    createAuthorizationURL: vi.fn((state: string, _codeVerifier: string) => {
      return new URL(`https://accounts.example.com/auth?state=${state}&scope=openid+email`);
    }),
    validateAuthorizationCode: vi.fn(async () => ({
      accessToken: 'mock-access-token-xyz',
    })),
    fetchUserEmail: vi.fn(async () => 'verified@example.com'),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('OAuthVerifier', () => {
  let store: VerificationTokenStore;
  let provider: OAuthProviderAdapter;
  let verifier: OAuthVerifier;

  beforeEach(() => {
    store = createMockStore();
    provider = createMockProvider();
    verifier = new OAuthVerifier(store, provider);
  });

  // ---------------------------------------------------------------------------
  // method
  // ---------------------------------------------------------------------------

  describe('method', () => {
    it('is "oauth"', () => {
      expect(verifier.method).toBe('oauth');
    });
  });

  // ---------------------------------------------------------------------------
  // supports()
  // ---------------------------------------------------------------------------

  describe('supports()', () => {
    it('returns true for any input (OAuth is triggered by orchestration)', () => {
      expect(verifier.supports(makeInput())).toBe(true);
    });

    it('returns true regardless of channel type or identity type', () => {
      expect(verifier.supports(makeInput({ channelType: 'voice', identityType: 'phone' }))).toBe(
        true,
      );
      expect(verifier.supports(makeInput({ channelType: 'sms', identityType: 'cookie' }))).toBe(
        true,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // initiate()
  // ---------------------------------------------------------------------------

  describe('initiate()', () => {
    it('returns success with attemptId and challengeData containing redirectUrl', async () => {
      const input = makeInput();
      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBeDefined();
      expect(typeof result.attemptId).toBe('string');
      expect(result.challengeData).toBeDefined();
      expect(result.challengeData?.userAction).toBe('redirect');
      expect(typeof result.challengeData?.redirectUrl).toBe('string');
      expect(result.challengeData?.redirectUrl as string).toContain(
        'https://accounts.example.com/auth',
      );
    });

    it('stores a verification attempt in the token store', async () => {
      const input = makeInput();
      const result = await verifier.initiate(input);

      expect(store.create).toHaveBeenCalledTimes(1);
      const storedAttempt = (store.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as StoredVerificationAttempt;
      expect(storedAttempt.tenantId).toBe('tenant-001');
      expect(storedAttempt.sessionId).toBe('sess-abc');
      expect(storedAttempt.method).toBe('oauth');
      expect(storedAttempt.status).toBe('pending');
      expect(storedAttempt.identityValue).toBe('user@example.com');
      expect(storedAttempt.id).toBe(result.attemptId);
    });

    it('stores state and code verifier in codeHash as JSON for redirect round-trip', async () => {
      const input = makeInput();
      await verifier.initiate(input);

      const storedAttempt = (store.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as StoredVerificationAttempt;
      // codeHash stores JSON with state and codeVerifier for the redirect round-trip
      const parsed = JSON.parse(storedAttempt.codeHash);
      expect(parsed.state).toBeDefined();
      expect(typeof parsed.state).toBe('string');
      expect(parsed.codeVerifier).toBeDefined();
      expect(typeof parsed.codeVerifier).toBe('string');
    });

    it('passes state and code verifier to the Arctic provider', async () => {
      const input = makeInput();
      await verifier.initiate(input);

      expect(provider.createAuthorizationURL).toHaveBeenCalledTimes(1);
      const [state, codeVerifier] = (provider.createAuthorizationURL as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(typeof state).toBe('string');
      expect(state.length).toBeGreaterThan(0);
      expect(typeof codeVerifier).toBe('string');
      expect(codeVerifier.length).toBeGreaterThan(0);
    });

    it('generates unique attempt IDs across calls', async () => {
      const result1 = await verifier.initiate(makeInput());
      const result2 = await verifier.initiate(makeInput());
      expect(result1.attemptId).not.toBe(result2.attemptId);
    });
  });

  // ---------------------------------------------------------------------------
  // complete()
  // ---------------------------------------------------------------------------

  describe('complete()', () => {
    it('returns success with identityTier 2 and verified email on valid code', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      // Extract the state from the stored attempt for the proof
      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);

      const result = await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'authorization-code-from-callback',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(2);
      expect(result.verifiedIdentity).toBe('verified@example.com');
    });

    it('exchanges the authorization code via the Arctic provider', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const stored = await store.get('tenant-001', attemptId);
      const { state, codeVerifier } = JSON.parse(stored!.codeHash);

      await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code-123',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(provider.validateAuthorizationCode).toHaveBeenCalledWith(
        'auth-code-123',
        codeVerifier,
      );
    });

    it('fetches the user email from the provider after token exchange', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);

      await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code-456',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(provider.fetchUserEmail).toHaveBeenCalledWith('mock-access-token-xyz');
    });

    it('marks the attempt as verified in the token store', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);

      await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code-789',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(store.markVerified).toHaveBeenCalledWith('tenant-001', attemptId);
    });

    it('rejects when state does not match', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const result = await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code-999',
        metadata: { tenantId: 'tenant-001', state: 'wrong-state-value' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_STATE_MISMATCH');
    });

    it('rejects when attempt is not found', async () => {
      const result = await verifier.complete('nonexistent-attempt', {
        type: 'oauth_token',
        value: 'auth-code',
        metadata: { tenantId: 'tenant-001', state: 'some-state' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_ATTEMPT_NOT_FOUND');
    });

    it('rejects when attempt is expired', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      // Manipulate the stored attempt to be expired
      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);
      const expiredAttempt: StoredVerificationAttempt = {
        ...stored!,
        expiresAt: new Date(Date.now() - 1000),
      };
      (store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expiredAttempt);

      const result = await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_EXPIRED');
    });

    it('rejects when token exchange fails', async () => {
      const failingProvider = createMockProvider({
        validateAuthorizationCode: vi.fn(async () => {
          throw new Error('Invalid authorization code');
        }),
      });
      const failingVerifier = new OAuthVerifier(store, failingProvider);

      const input = makeInput();
      const initResult = await failingVerifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);

      const result = await failingVerifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'bad-code',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_TOKEN_EXCHANGE_FAILED');
    });

    it('rejects when userinfo fetch fails', async () => {
      const failingProvider = createMockProvider({
        fetchUserEmail: vi.fn(async () => {
          throw new Error('Userinfo endpoint unreachable');
        }),
      });
      const failingVerifier = new OAuthVerifier(store, failingProvider);

      const input = makeInput();
      const initResult = await failingVerifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const stored = await store.get('tenant-001', attemptId);
      const { state } = JSON.parse(stored!.codeHash);

      const result = await failingVerifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'good-code',
        metadata: { tenantId: 'tenant-001', state },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_USERINFO_FAILED');
    });

    it('enforces tenant isolation — cannot complete attempt from different tenant', async () => {
      const input = makeInput({ tenantId: 'tenant-001' });
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const result = await verifier.complete(attemptId, {
        type: 'oauth_token',
        value: 'auth-code',
        metadata: { tenantId: 'tenant-002', state: 'some-state' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OAUTH_ATTEMPT_NOT_FOUND');
    });
  });
});
