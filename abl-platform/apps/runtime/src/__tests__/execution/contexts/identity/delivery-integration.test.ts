/**
 * Verification Code Delivery Integration Tests
 *
 * Tests the delivery dispatch in the identity verification route handler:
 *   - OTP initiate with delivery service → delivery called, code stripped, deliveryStatus: 'sent'
 *   - Email-link initiate with delivery service → delivery called, token stripped, deliveryStatus: 'sent'
 *   - OTP initiate WITHOUT delivery service → code preserved in response (ALPHA backward compat)
 *   - Delivery failure → code still stripped, deliveryStatus: 'failed'
 *
 * Uses real verifiers, real token store (InMemoryRedis), and a DI-injected mock
 * delivery service. No vi.mock() — the delivery service is an injected dependency.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { createIdentityVerificationRouter } from '../../../../routes/identity-verification.js';
import type { IdentityVerificationRouterDeps } from '../../../../routes/identity-verification.js';
import { VerifyIdentity } from '../../../../contexts/identity/use-cases/verify-identity.js';
import { RedisVerificationTokenStore } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import type { RedisLike } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import { OtpVerifier } from '../../../../contexts/identity/infrastructure/verifiers/otp-verifier.js';
import { EmailLinkVerifier } from '../../../../contexts/identity/infrastructure/verifiers/email-link-verifier.js';
import type {
  IdentityVerifier,
  VerificationProof,
  VerificationResult,
} from '../../../../contexts/identity/domain/identity-verifier.js';
import type { VerificationDeliveryService } from '../../../../contexts/identity/domain/verification-delivery.js';
import type { VerificationMethod } from '@agent-platform/shared-auth';

// =============================================================================
// IN-MEMORY REDIS (same pattern as identity-e2e-http.test.ts)
// =============================================================================

class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    let expiresAt: number | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX' && typeof args[i + 1] === 'number') {
        expiresAt = Date.now() + (args[i + 1] as number) * 1000;
        break;
      }
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async eval(script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = args[0] as string;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    const obj = JSON.parse(entry.value);
    if (script.includes("obj['attempts']")) {
      obj.attempts = (obj.attempts ?? 0) + 1;
      entry.value = JSON.stringify(obj);
      return obj.attempts;
    }
    if (script.includes("obj['status'] = 'verified'")) {
      obj.status = 'verified';
      entry.value = JSON.stringify(obj);
      return 1;
    }
    return null;
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

const OTP_HMAC_SECRET = 'delivery-test-otp-secret';
const EMAIL_LINK_SIGNING_KEY = 'delivery-test-email-link-key';
const TEST_TENANT = 'tenant-delivery-test';

// =============================================================================
// MOCK DELIVERY SERVICE (injected via DI — not vi.mock)
// =============================================================================

function createMockDeliveryService(): VerificationDeliveryService & {
  calls: Array<{ channel: 'email' | 'sms'; to: string; code: string }>;
  shouldFail: boolean;
} {
  const calls: Array<{ channel: 'email' | 'sms'; to: string; code: string }> = [];
  return {
    calls,
    shouldFail: false,
    async deliverCode(
      channel: 'email' | 'sms',
      to: string,
      code: string,
    ): Promise<{ delivered: boolean; error?: string }> {
      calls.push({ channel, to, code });
      if ((this as { shouldFail: boolean }).shouldFail) {
        return { delivered: false, error: 'Delivery service unavailable' };
      }
      return { delivered: true };
    },
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function buildApp(opts: {
  deliveryService?: VerificationDeliveryService;
  methods?: VerificationMethod[];
}) {
  const redis = new InMemoryRedis();
  const tokenStore = new RedisVerificationTokenStore(() => redis);

  const allVerifiers: Record<string, IdentityVerifier> = {
    otp: new OtpVerifier(tokenStore, OTP_HMAC_SECRET),
    email_link: new EmailLinkVerifier(EMAIL_LINK_SIGNING_KEY, tokenStore),
  };

  const methodsToInclude = opts.methods ?? ['otp', 'email_link'];
  const verifiers = new Map<VerificationMethod, IdentityVerifier>();
  for (const method of methodsToInclude) {
    if (allVerifiers[method]) {
      verifiers.set(method as VerificationMethod, allVerifiers[method]);
    }
  }

  const verifyIdentity = new VerifyIdentity(verifiers);

  const completeVerification = async (
    attemptId: string,
    proof: VerificationProof,
  ): Promise<VerificationResult> => {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const stored = await tokenStore.get(tenantId, attemptId);
    if (!stored) {
      return {
        success: false,
        error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
      };
    }
    const verifier = verifiers.get(stored.method as VerificationMethod);
    if (!verifier) {
      return {
        success: false,
        error: { code: 'NO_VERIFIER', message: 'No verifier for method' },
      };
    }
    return verifier.complete(attemptId, proof);
  };

  const deps: IdentityVerificationRouterDeps = {
    verifyIdentity,
    tokenStore,
    completeVerification,
    deliveryService: opts.deliveryService,
  };

  const app = express();
  app.use(express.json());

  // Inject tenantContext for tests
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (tenantId) {
      req.tenantContext = {
        tenantId,
        sessionId: 'test-session',
        channelId: 'web_chat',
      } as typeof req.tenantContext;
    }
    next();
  });

  app.use('/api/identity/verify', createIdentityVerificationRouter(deps));

  return { app, tokenStore, redis };
}

function startServer(app: express.Application): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Verification Code Delivery Integration', () => {
  describe('OTP with delivery service', () => {
    let server: http.Server;
    let baseUrl: string;
    let deliveryService: ReturnType<typeof createMockDeliveryService>;

    beforeAll(async () => {
      deliveryService = createMockDeliveryService();
      const { app } = buildApp({ deliveryService, methods: ['otp'] });
      ({ server, baseUrl } = await startServer(app));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it('delivers OTP code via email and strips code from response', async () => {
      const res = await fetch(`${baseUrl}/api/identity/verify/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          method: 'otp',
          identityValue: 'user@example.com',
          identityType: 'email',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.attemptId).toBeTruthy();

      // Code MUST be stripped from response when delivery service is configured
      expect(body.challengeData.code).toBeUndefined();

      // deliveryStatus MUST be present
      expect(body.challengeData.deliveryStatus).toBe('sent');

      // Delivery service MUST have been called with correct args
      expect(deliveryService.calls).toHaveLength(1);
      expect(deliveryService.calls[0].channel).toBe('email');
      expect(deliveryService.calls[0].to).toBe('user@example.com');
      expect(deliveryService.calls[0].code).toMatch(/^\d{6}$/); // 6-digit OTP
    });

    it('strips code even when delivery fails', async () => {
      deliveryService.shouldFail = true;
      deliveryService.calls.length = 0;

      const res = await fetch(`${baseUrl}/api/identity/verify/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          method: 'otp',
          identityValue: 'user2@example.com',
          identityType: 'email',
        }),
      });

      const body = await res.json();
      expect(body.success).toBe(true);

      // Code MUST STILL be stripped (security-first)
      expect(body.challengeData.code).toBeUndefined();

      // Delivery status should indicate failure
      expect(body.challengeData.deliveryStatus).toBe('failed');

      // Delivery service was still called
      expect(deliveryService.calls).toHaveLength(1);

      deliveryService.shouldFail = false;
    });
  });

  describe('Email-link with delivery service', () => {
    let server: http.Server;
    let baseUrl: string;
    let deliveryService: ReturnType<typeof createMockDeliveryService>;

    beforeAll(async () => {
      deliveryService = createMockDeliveryService();
      const { app } = buildApp({ deliveryService, methods: ['email_link'] });
      ({ server, baseUrl } = await startServer(app));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it('delivers email-link token and strips token from response', async () => {
      const res = await fetch(`${baseUrl}/api/identity/verify/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          method: 'email_link',
          identityValue: 'link-user@example.com',
          identityType: 'email',
        }),
      });

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.attemptId).toBeTruthy();

      // Token MUST be stripped from response
      expect(body.challengeData.token).toBeUndefined();

      // deliveryStatus MUST be present
      expect(body.challengeData.deliveryStatus).toBe('sent');

      // Delivery service MUST have been called
      expect(deliveryService.calls).toHaveLength(1);
      expect(deliveryService.calls[0].channel).toBe('email');
      expect(deliveryService.calls[0].to).toBe('link-user@example.com');
      expect(deliveryService.calls[0].code).toBeTruthy(); // hex token
    });

    it('strips token even when delivery fails', async () => {
      deliveryService.shouldFail = true;
      deliveryService.calls.length = 0;

      const res = await fetch(`${baseUrl}/api/identity/verify/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          method: 'email_link',
          identityValue: 'link-fail@example.com',
          identityType: 'email',
        }),
      });

      const body = await res.json();
      expect(body.success).toBe(true);

      // Token MUST STILL be stripped (security-first)
      expect(body.challengeData.token).toBeUndefined();

      // Delivery status should indicate failure
      expect(body.challengeData.deliveryStatus).toBe('failed');

      // Delivery service was still called
      expect(deliveryService.calls).toHaveLength(1);

      deliveryService.shouldFail = false;
    });
  });

  describe('OTP WITHOUT delivery service (backward compat)', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      // No delivery service — ALPHA behavior
      const { app } = buildApp({ methods: ['otp'] });
      ({ server, baseUrl } = await startServer(app));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it('returns raw OTP code in response when no delivery service', async () => {
      const res = await fetch(`${baseUrl}/api/identity/verify/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          method: 'otp',
          identityValue: 'alpha-user@example.com',
          identityType: 'email',
        }),
      });

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.attemptId).toBeTruthy();

      // Code MUST be present (ALPHA backward compat)
      expect(body.challengeData.code).toBeTruthy();
      expect(body.challengeData.code).toMatch(/^\d{6}$/);

      // No deliveryStatus field
      expect(body.challengeData.deliveryStatus).toBeUndefined();
    });
  });
});
