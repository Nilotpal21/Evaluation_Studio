/**
 * Webhook Identity Verifier
 *
 * Adapter implementing the IdentityVerifier port for customer-configured webhook
 * verification. Sends a random challenge to a customer URL, then verifies the
 * response matches the stored challenge.
 *
 * Two-step flow:
 *   1. initiate() -> generates a random challenge, sends it to the webhook URL via
 *      the injected sendChallenge function, stores the hashed challenge in the token store.
 *   2. complete() -> loads the stored attempt, hashes the submitted proof, compares
 *      against the stored hash. Marks verified on match.
 *
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import { createVerificationAttempt, isExpired } from '../../domain/verification-attempt.js';
import type { VerificationTokenStore } from '../verification-token-store.js';

const log = createLogger('webhook-verifier');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Challenge token byte length (16 bytes = 32 hex chars). */
const CHALLENGE_BYTE_LENGTH = 16;

/** Webhook challenge TTL in milliseconds (5 minutes). */
const WEBHOOK_TTL_MS = 300_000;

/** Private/reserved IPv4 CIDR ranges that must be blocked for SSRF prevention. */
const BLOCKED_IPV4_PREFIXES = [
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '127.',
  '0.',
  '169.254.',
];

/** Hostnames that must be blocked for SSRF prevention. */
const BLOCKED_HOSTNAMES = ['localhost', '[::1]', 'metadata.google.internal'];

/**
 * Validates a webhook URL to prevent SSRF attacks.
 * Rejects private IPs, localhost, cloud metadata endpoints, and non-HTTPS schemes in production.
 */
function validateWebhookUrl(rawUrl: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Only http and https schemes are allowed' };
  }

  // Block known dangerous hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { valid: false, error: 'Webhook URL targets a blocked hostname' };
  }

  // Block private/reserved IP ranges
  for (const prefix of BLOCKED_IPV4_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return { valid: false, error: 'Webhook URL targets a private/reserved IP range' };
    }
  }

  // Block IPv6 loopback and link-local (e.g., [::1], [fe80::...])
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (
      ipv6 === '::1' ||
      ipv6.startsWith('fe80:') ||
      ipv6.startsWith('fc') ||
      ipv6.startsWith('fd')
    ) {
      return { valid: false, error: 'Webhook URL targets a private/reserved IPv6 address' };
    }
  }

  return { valid: true };
}

// =============================================================================
// TYPES
// =============================================================================

export interface SendChallengePayload {
  readonly url: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly identityValue: string;
  readonly challenge: string;
}

export type SendChallengeFn = (payload: SendChallengePayload) => Promise<{ success: boolean }>;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export interface WebhookVerifierOptions {
  /**
   * Allow private/reserved IP addresses in webhook URLs.
   * ONLY set to `true` in test environments. Defaults to `false`.
   */
  readonly allowPrivateUrls?: boolean;
}

export class WebhookVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'webhook';
  private readonly allowPrivateUrls: boolean;

  constructor(
    private readonly tokenStore: VerificationTokenStore,
    private readonly sendChallenge: SendChallengeFn,
    private readonly hmacKey: string,
    opts?: WebhookVerifierOptions,
  ) {
    this.allowPrivateUrls = opts?.allowPrivateUrls ?? false;
  }

  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    const webhookUrl = input.metadata?.webhookUrl;
    if (typeof webhookUrl !== 'string') {
      return {
        success: false,
        error: { code: 'WEBHOOK_URL_MISSING', message: 'metadata.webhookUrl is required' },
      };
    }

    if (!this.allowPrivateUrls) {
      const urlValidation = validateWebhookUrl(webhookUrl);
      if (!urlValidation.valid) {
        log.warn('Blocked webhook URL', { tenantId: input.tenantId, reason: urlValidation.error });
        return {
          success: false,
          error: {
            code: 'WEBHOOK_URL_INVALID',
            message: urlValidation.error ?? 'Invalid webhook URL',
          },
        };
      }
    }

    const challenge = randomBytes(CHALLENGE_BYTE_LENGTH).toString('hex');
    const codeHash = createHmac('sha256', this.hmacKey).update(challenge).digest('hex');

    const attempt = createVerificationAttempt({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionPrincipalId: input.sessionPrincipalId,
      method: 'webhook',
      identityValue: input.identityValue,
      identityType: input.identityType,
      policySource: input.policySource,
      grantScope: input.grantScope,
      traceId: input.traceId,
      expiresAt: new Date(Date.now() + WEBHOOK_TTL_MS),
    });

    await this.tokenStore.create({ ...attempt, codeHash });

    try {
      await this.sendChallenge({
        url: webhookUrl,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        identityValue: input.identityValue,
        challenge,
      });
    } catch (error) {
      log.error('Failed to send challenge to webhook URL', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: input.tenantId,
      });
      return {
        success: false,
        error: { code: 'WEBHOOK_SEND_FAILED', message: 'Failed to send challenge to webhook URL' },
      };
    }

    return {
      success: true,
      attemptId: attempt.id,
      challengeData: { userAction: 'await_webhook' },
    };
  }

  async complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const stored = await this.tokenStore.get(tenantId, attemptId);

    if (!stored) {
      return {
        success: false,
        error: { code: 'WEBHOOK_ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
      };
    }

    if (isExpired(stored)) {
      return {
        success: false,
        error: { code: 'WEBHOOK_EXPIRED', message: 'Webhook challenge has expired' },
      };
    }

    const submittedHash = createHmac('sha256', this.hmacKey).update(proof.value).digest('hex');
    const storedBuf = Buffer.from(stored.codeHash, 'hex');
    const submittedBuf = Buffer.from(submittedHash, 'hex');

    if (storedBuf.length !== submittedBuf.length || !timingSafeEqual(storedBuf, submittedBuf)) {
      await this.tokenStore.incrementAttempts(tenantId, attemptId);
      return {
        success: false,
        error: { code: 'WEBHOOK_CHALLENGE_MISMATCH', message: 'Challenge response does not match' },
      };
    }

    await this.tokenStore.markVerified(tenantId, attemptId);

    return {
      success: true,
      identityTier: 1,
      verifiedIdentity: stored.identityValue,
    };
  }

  supports(input: VerificationInput): boolean {
    return input.metadata != null && typeof input.metadata.webhookUrl === 'string';
  }
}
