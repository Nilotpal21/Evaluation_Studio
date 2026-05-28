/**
 * Webhook Verification Addon — HMAC signature verification for inbound webhooks.
 */
import crypto from 'node:crypto';

export function verifyWebhook(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string,
  method: 'hmac-sha256' | 'hmac-sha1' | 'svix' | 'rsa-sha256',
  timestamp?: string,
  toleranceSeconds?: number,
): boolean {
  if (timestamp && toleranceSeconds) {
    const ts = new Date(timestamp).getTime();
    if (Math.abs(Date.now() - ts) > toleranceSeconds * 1000) {
      return false; // Replay attack
    }
  }
  const algoMap: Record<string, string> = { 'hmac-sha256': 'sha256', 'hmac-sha1': 'sha1' };
  const algo = algoMap[method];
  if (!algo) return false; // svix and rsa-sha256 require specialized verification
  const expected = crypto.createHmac(algo, webhookSecret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch — guard against it
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
