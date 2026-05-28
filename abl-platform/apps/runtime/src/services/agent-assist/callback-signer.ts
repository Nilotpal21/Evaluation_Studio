/**
 * HMAC callback signing for the Agent Assist V1 async-push flow.
 *
 * Stripe-style signature: `X-ABL-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>`
 * Payload signed: `<t>.<raw_body_json>`
 *
 * Secret resolution order:
 *   1. Binding-level override (binding.runtime.callbackSigningSecret)
 *   2. Env var AGENT_ASSIST_CALLBACK_SIGNING_SECRET
 *
 * Timestamp tolerance for verification: 5 minutes (300 seconds).
 */

import crypto from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────

export const SIGNATURE_HEADER = 'X-ABL-Signature';
export const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// ─── Signing ────────────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 signature for a callback payload.
 * Returns the full header value: `t=<unix_seconds>,v1=<hex>`.
 */
export function signCallbackPayload(
  body: string,
  secret: string,
  timestampSeconds?: number,
): string {
  const t = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${t},v1=${hmac}`;
}

// ─── Verification ───────────────────────────────────────────────────────

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Parse the `X-ABL-Signature` header into its component parts.
 * Returns null if the header is malformed.
 */
export function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | null {
  const parts = header.split(',');
  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('t=')) {
      const val = parseInt(trimmed.slice(2), 10);
      if (!Number.isFinite(val)) return null;
      timestamp = val;
    } else if (trimmed.startsWith('v1=')) {
      signature = trimmed.slice(3);
    }
  }

  if (timestamp === undefined || !signature) return null;
  return { timestamp, signature };
}

/**
 * Verify a callback signature. Uses constant-time comparison to prevent
 * timing attacks.
 *
 * @param body - The raw JSON body string
 * @param header - The X-ABL-Signature header value
 * @param secret - The HMAC secret
 * @param nowSeconds - Current time in unix seconds (for testability)
 * @param toleranceSeconds - Max allowed clock skew (default 300s = 5 min)
 */
export function verifyCallbackSignature(
  body: string,
  header: string,
  secret: string,
  nowSeconds?: number,
  toleranceSeconds: number = TIMESTAMP_TOLERANCE_SECONDS,
): SignatureVerificationResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return { valid: false, reason: 'Malformed signature header' };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - parsed.timestamp);
  if (drift > toleranceSeconds) {
    return { valid: false, reason: 'Timestamp outside tolerance window' };
  }

  const signedPayload = `${parsed.timestamp}.${body}`;
  const expectedHmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time comparison — both strings must be same length for timingSafeEqual
  const sigBuf = Buffer.from(parsed.signature, 'utf8');
  const expectedBuf = Buffer.from(expectedHmac, 'utf8');

  if (sigBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  const match = crypto.timingSafeEqual(sigBuf, expectedBuf);
  if (!match) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

// ─── Secret Resolution ──────────────────────────────────────────────────

const CALLBACK_SIGNING_SECRET_ENV = 'AGENT_ASSIST_CALLBACK_SIGNING_SECRET';

/**
 * Resolve the HMAC signing secret from binding-level override or env var.
 * Returns null if no secret is configured (signing will be skipped).
 */
export function resolveSigningSecret(bindingSecret?: string | null): string | null {
  if (bindingSecret && bindingSecret.length > 0) return bindingSecret;
  const envSecret = process.env[CALLBACK_SIGNING_SECRET_ENV];
  if (envSecret && envSecret.length > 0) return envSecret;
  return null;
}
