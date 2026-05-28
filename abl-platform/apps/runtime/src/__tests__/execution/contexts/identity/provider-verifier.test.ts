/**
 * ProviderVerifier + WebhookVerifier Tests
 *
 * Tests the two lightweight identity verifiers:
 *   - ProviderVerifier: sync check for channel-provider-verified artifacts
 *   - WebhookVerifier: async challenge/response via customer-configured webhook
 */

import { randomBytes, createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderVerifier } from '../../../../contexts/identity/infrastructure/verifiers/provider-verifier.js';
import { WebhookVerifier } from '../../../../contexts/identity/infrastructure/verifiers/webhook-verifier.js';
import type {
  VerificationInput,
  VerificationProof,
} from '../../../../contexts/identity/domain/identity-verifier.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../../../contexts/identity/infrastructure/verification-token-store.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'whatsapp',
    identityValue: '+15551234567',
    identityType: 'phone',
    ...overrides,
  };
}

function makeMockTokenStore(): VerificationTokenStore {
  const store = new Map<string, StoredVerificationAttempt>();
  return {
    create: vi.fn(async (attempt: StoredVerificationAttempt) => {
      store.set(`${attempt.tenantId}:${attempt.id}`, attempt);
    }),
    get: vi.fn(async (tenantId: string, attemptId: string) => {
      return store.get(`${tenantId}:${attemptId}`) ?? null;
    }),
    incrementAttempts: vi.fn(async () => {}),
    markVerified: vi.fn(async () => {}),
  };
}

// =============================================================================
// PROVIDER VERIFIER
// =============================================================================

describe('ProviderVerifier', () => {
  let verifier: ProviderVerifier;

  beforeEach(() => {
    verifier = new ProviderVerifier();
  });

  describe('method', () => {
    it('is "provider"', () => {
      expect(verifier.method).toBe('provider');
    });
  });

  describe('supports()', () => {
    it('returns true when metadata.providerVerified is true', () => {
      const input = makeInput({ metadata: { providerVerified: true } });
      expect(verifier.supports(input)).toBe(true);
    });

    it('returns true when metadata.providerVerified is false', () => {
      const input = makeInput({ metadata: { providerVerified: false } });
      expect(verifier.supports(input)).toBe(true);
    });

    it('returns false when metadata is undefined', () => {
      const input = makeInput({ metadata: undefined });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when providerVerified is not a boolean', () => {
      const input = makeInput({ metadata: { providerVerified: 'yes' } });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when providerVerified is missing from metadata', () => {
      const input = makeInput({ metadata: { someOther: 'field' } });
      expect(verifier.supports(input)).toBe(false);
    });
  });

  describe('initiate()', () => {
    it('returns immediate success when providerVerified is true', async () => {
      const input = makeInput({ metadata: { providerVerified: true } });
      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns failure when providerVerified is false', async () => {
      const input = makeInput({ metadata: { providerVerified: false } });
      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('PROVIDER_NOT_VERIFIED');
    });

    it('returns failure when metadata is missing', async () => {
      const input = makeInput({ metadata: undefined });
      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROVIDER_NOT_VERIFIED');
    });
  });

  describe('complete()', () => {
    it('returns success with identityTier 1 by default', async () => {
      const result = await verifier.complete('any-attempt-id', {
        type: 'provider_assertion',
        value: 'unused',
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(1);
    });

    it('returns identityTier 2 when provider verification strength is strong', async () => {
      const result = await verifier.complete('any-attempt-id', {
        type: 'provider_assertion',
        value: 'unused',
        metadata: {
          providerVerificationStrength: 'strong',
        },
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(2);
    });
  });
});

// =============================================================================
// WEBHOOK VERIFIER
// =============================================================================

describe('WebhookVerifier', () => {
  let tokenStore: VerificationTokenStore;
  let sendChallenge: ReturnType<typeof vi.fn>;
  let verifier: WebhookVerifier;

  beforeEach(() => {
    tokenStore = makeMockTokenStore();
    sendChallenge = vi.fn(async () => ({ success: true }));
    verifier = new WebhookVerifier(tokenStore, sendChallenge, 'test-webhook-hmac-key');
  });

  describe('method', () => {
    it('is "webhook"', () => {
      expect(verifier.method).toBe('webhook');
    });
  });

  describe('supports()', () => {
    it('returns true when metadata.webhookUrl is a string', () => {
      const input = makeInput({ metadata: { webhookUrl: 'https://example.com/verify' } });
      expect(verifier.supports(input)).toBe(true);
    });

    it('returns false when metadata is undefined', () => {
      const input = makeInput({ metadata: undefined });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when webhookUrl is not a string', () => {
      const input = makeInput({ metadata: { webhookUrl: 42 } });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when webhookUrl is missing', () => {
      const input = makeInput({ metadata: { someOther: 'field' } });
      expect(verifier.supports(input)).toBe(false);
    });
  });

  describe('initiate()', () => {
    it('sends challenge to webhook URL and stores attempt', async () => {
      const input = makeInput({
        metadata: { webhookUrl: 'https://example.com/verify' },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBeDefined();
      expect(result.challengeData?.userAction).toBe('await_webhook');
      expect(sendChallenge).toHaveBeenCalledOnce();

      // Verify the challenge was sent with expected fields
      const callArgs = sendChallenge.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.url).toBe('https://example.com/verify');
      expect(callArgs.tenantId).toBe('tenant-001');
      expect(callArgs.sessionId).toBe('sess-abc');
      expect(callArgs.identityValue).toBe('+15551234567');
      expect(typeof callArgs.challenge).toBe('string');
    });

    it('stores the attempt in the token store', async () => {
      const input = makeInput({
        metadata: { webhookUrl: 'https://example.com/verify' },
      });

      await verifier.initiate(input);

      expect(tokenStore.create).toHaveBeenCalledOnce();
    });

    it('returns failure when sendChallenge rejects', async () => {
      sendChallenge.mockRejectedValueOnce(new Error('Network error'));

      const input = makeInput({
        metadata: { webhookUrl: 'https://example.com/verify' },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_SEND_FAILED');
    });

    it('returns failure when webhookUrl is missing', async () => {
      const input = makeInput({ metadata: {} });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_URL_MISSING');
    });

    it('rejects localhost URLs (SSRF prevention)', async () => {
      const input = makeInput({ metadata: { webhookUrl: 'http://localhost:3000/callback' } });
      const result = await verifier.initiate(input);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_URL_INVALID');
    });

    it('rejects private IP ranges (SSRF prevention)', async () => {
      const cases = [
        'http://10.0.0.1/callback',
        'http://172.16.0.1/callback',
        'http://192.168.1.1/callback',
        'http://127.0.0.1/callback',
        'http://169.254.169.254/latest/meta-data/',
      ];

      for (const url of cases) {
        const input = makeInput({ metadata: { webhookUrl: url } });
        const result = await verifier.initiate(input);
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('WEBHOOK_URL_INVALID');
      }
    });

    it('rejects cloud metadata endpoint hostnames (SSRF prevention)', async () => {
      const input = makeInput({
        metadata: { webhookUrl: 'http://metadata.google.internal/computeMetadata/v1/' },
      });
      const result = await verifier.initiate(input);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_URL_INVALID');
    });

    it('rejects non-http schemes (SSRF prevention)', async () => {
      const cases = ['file:///etc/passwd', 'ftp://evil.com/payload', 'gopher://evil.com/payload'];
      for (const url of cases) {
        const input = makeInput({ metadata: { webhookUrl: url } });
        const result = await verifier.initiate(input);
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('WEBHOOK_URL_INVALID');
      }
    });

    it('accepts valid external HTTPS URLs', async () => {
      const input = makeInput({
        metadata: { webhookUrl: 'https://customer.example.com/webhook/verify' },
      });
      const result = await verifier.initiate(input);
      expect(result.success).toBe(true);
      expect(sendChallenge).toHaveBeenCalledOnce();
    });
  });

  describe('complete()', () => {
    it('verifies correct challenge response', async () => {
      // First initiate to create an attempt
      const input = makeInput({
        metadata: { webhookUrl: 'https://example.com/verify' },
      });
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      // Get the challenge that was sent
      const callArgs = sendChallenge.mock.calls[0]![0] as Record<string, unknown>;
      const challenge = callArgs.challenge as string;

      const proof: VerificationProof = {
        type: 'provider_assertion',
        value: challenge,
        metadata: { tenantId: 'tenant-001' },
      };

      const result = await verifier.complete(attemptId, proof);

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(1);
      expect(tokenStore.markVerified).toHaveBeenCalledOnce();
    });

    it('rejects incorrect challenge response', async () => {
      const input = makeInput({
        metadata: { webhookUrl: 'https://example.com/verify' },
      });
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const proof: VerificationProof = {
        type: 'provider_assertion',
        value: 'wrong-challenge-value',
        metadata: { tenantId: 'tenant-001' },
      };

      const result = await verifier.complete(attemptId, proof);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_CHALLENGE_MISMATCH');
    });

    it('returns error when attempt is not found', async () => {
      const proof: VerificationProof = {
        type: 'provider_assertion',
        value: 'some-value',
        metadata: { tenantId: 'tenant-001' },
      };

      const result = await verifier.complete('nonexistent-id', proof);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WEBHOOK_ATTEMPT_NOT_FOUND');
    });
  });
});
