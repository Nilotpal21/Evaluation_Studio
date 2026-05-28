/**
 * Webhook Signature Verification
 *
 * Verifies inbound webhook signatures using HMAC-SHA256 with timing-safe
 * comparison. Includes replay protection via timestamp header validation.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('webhook-verification');

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface WebhookVerificationConfig {
  /** HMAC secret for signature verification */
  secret: string;
  /** Header name containing the signature (e.g. 'x-kore-signature') */
  signatureHeader: string;
  /** Header name containing the timestamp (e.g. 'x-kore-timestamp') */
  timestampHeader?: string;
  /** Maximum age of a webhook event in ms (default: 5 minutes) */
  replayWindowMs?: number;
  /**
   * Optional nonce dedup store for replay prevention within the window.
   * When provided, each verified signature is tracked; duplicates are rejected.
   * Implementations should auto-expire entries after replayWindowMs.
   */
  nonceStore?: WebhookNonceStore;
}

export interface WebhookNonceStore {
  /**
   * Mark a nonce as seen. Returns true if the nonce was NEW (first time).
   * Returns false if it was already seen (replay).
   */
  markSeen(nonce: string, ttlMs: number): Promise<boolean>;
}

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify an inbound webhook signature.
 *
 * 1. Checks timestamp header for replay protection (if configured)
 * 2. Computes HMAC-SHA256 of the raw body using the shared secret
 * 3. Compares the computed signature with the provided one using timingSafeEqual
 */
export async function verifyWebhookSignature(
  config: WebhookVerificationConfig,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer | string,
): Promise<WebhookVerificationResult> {
  const {
    secret,
    signatureHeader,
    timestampHeader,
    replayWindowMs = REPLAY_WINDOW_MS,
    nonceStore,
  } = config;

  // 1. Replay protection via timestamp header
  let ts: string | undefined;
  if (timestampHeader) {
    const tsRaw = getHeader(headers, timestampHeader);
    if (!tsRaw) {
      return { valid: false, error: 'Missing timestamp header' };
    }

    // Support both epoch-ms integers and ISO 8601 strings
    let tsNum = Number(tsRaw);
    if (isNaN(tsNum)) {
      tsNum = new Date(tsRaw).getTime();
    }
    if (isNaN(tsNum)) {
      return { valid: false, error: 'Invalid timestamp header value' };
    }

    ts = tsRaw;

    const age = Math.abs(Date.now() - tsNum);
    if (age > replayWindowMs) {
      log.warn('Webhook replay protection: timestamp outside window', {
        ageMs: age,
        maxMs: replayWindowMs,
      });
      return { valid: false, error: 'Webhook timestamp outside replay window' };
    }
  }

  // 2. Signature verification
  const providedSig = getHeader(headers, signatureHeader);
  if (!providedSig) {
    return { valid: false, error: 'Missing signature header' };
  }

  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;
  const computedSig = createHmac('sha256', secret).update(bodyBuffer).digest('hex');

  // Strip optional "sha256=" prefix
  const normalizedSig = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;

  // 3. Timing-safe comparison
  try {
    const a = Buffer.from(normalizedSig, 'hex');
    const b = Buffer.from(computedSig, 'hex');

    if (a.length !== b.length) {
      return { valid: false, error: 'Signature length mismatch' };
    }

    if (!timingSafeEqual(a, b)) {
      return { valid: false, error: 'Signature verification failed' };
    }
  } catch {
    return { valid: false, error: 'Invalid signature format' };
  }

  // 4. Nonce dedup — reject replayed requests within the window
  // Use timestamp + signature as the nonce key so that the same payload
  // sent at different timestamps (legitimate retries) gets unique nonces,
  // while exact replays with the same timestamp are blocked.
  if (nonceStore) {
    const nonceKey = ts ? `${ts}:${computedSig}` : computedSig;
    const isNew = await nonceStore.markSeen(nonceKey, replayWindowMs);
    if (!isNew) {
      log.warn('Webhook replay detected: duplicate signature', { signatureHeader });
      return { valid: false, error: 'Webhook verification failed' };
    }
  }

  return { valid: true };
}

/**
 * Create a Redis-backed WebhookNonceStore.
 * Uses SET NX PX for atomic nonce tracking with auto-expiry.
 */
export function createRedisNonceStore(redis: {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<string | null>;
}): WebhookNonceStore {
  return {
    async markSeen(nonce: string, ttlMs: number): Promise<boolean> {
      const result = await redis.set(`webhook_nonce:${nonce}`, '1', 'PX', ttlMs, 'NX');
      return result !== null; // null means key already existed (replay)
    },
  };
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
