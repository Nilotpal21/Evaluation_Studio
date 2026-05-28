/**
 * Webhook Signature Utilities
 *
 * HMAC-SHA256 signing for outbound webhook deliveries.
 * Follows the standard webhook signature pattern used by Stripe, GitHub, etc.
 */

import crypto from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

/**
 * Generate a new webhook signing secret.
 * Returns a prefixed hex string: "whsec_<32 random bytes hex>"
 */
export function generateWebhookSecret(): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `${SECRET_PREFIX}${secret}`;
}

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 *
 * @param secret - The webhook signing secret (with or without whsec_ prefix)
 * @param body - The raw request body string
 * @param timestamp - Optional timestamp for replay protection
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function computeWebhookSignature(secret: string, body: string, timestamp?: string): string {
  // Strip prefix if present
  const rawSecret = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (!rawSecret) throw new Error('Webhook secret cannot be empty');

  // Include timestamp in signed content for replay protection
  const signedContent = timestamp ? `${timestamp}.${body}` : body;

  return crypto.createHmac('sha256', rawSecret).update(signedContent, 'utf8').digest('hex');
}

/**
 * Build the standard webhook signature headers.
 */
export function buildSignatureHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeWebhookSignature(secret, body, timestamp);

  return {
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
    'x-webhook-id': crypto.randomUUID(),
  };
}

/**
 * Verify a webhook signature using constant-time comparison.
 * Also validates the timestamp to prevent replay attacks.
 *
 * @param secret - The webhook signing secret
 * @param body - The raw request body string
 * @param signature - The signature to verify (from x-webhook-signature header)
 * @param timestamp - The timestamp string (from x-webhook-timestamp header)
 * @param toleranceSeconds - Max age of the signature in seconds (default 300 = 5 minutes)
 * @returns true if the signature is valid and the timestamp is within tolerance
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
  timestamp: string,
  toleranceSeconds = 300,
): boolean {
  // Check timestamp tolerance for replay protection
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  // Compute expected signature and compare using timing-safe equality
  const expected = computeWebhookSignature(secret, body, timestamp);

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}
