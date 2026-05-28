/**
 * HMAC-signed token for attachment downloads.
 *
 * Mirrors apps/search-ai/src/routes/document-download.ts:25-75. Same algorithm
 * (HMAC-SHA256 over a JSON payload), same shape (`<base64url(payload)>.<sigHex>`),
 * same timing-safe verification. The shared secret is JWT_SECRET so we reuse
 * the platform's existing key-management surface.
 *
 * Workflow-engine attachments often outlive a single request — a workflow may
 * `wait` for human approval and then resume — so the token TTL is 24 h by
 * default (configurable via ATTACHMENT_TOKEN_TTL_MS), longer than search-ai's
 * 15 min. Paired with a 25 h file retention on disk so a request opening a URL
 * at the 24 h boundary never races a file deletion.
 */

import crypto from 'crypto';

// 24h default — workflow-engine attachments outlive most single requests because
// workflows can `wait` for human approval or scheduled triggers before consuming
// a URL. Paired with a 25h file retention on disk (see attachment-cleanup.ts)
// so a request opening a URL at the 24h boundary never races a file deletion.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AttachmentTokenPayload {
  /** Storage key path (e.g. `attachments/{tenantId}/{uuid}.pdf`) */
  k: string;
  /** Tenant ID — must match the key prefix on verify */
  t: string;
  /** Expiry, epoch ms */
  exp: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required for attachment token signing');
  }
  return secret;
}

function ttlMs(): number {
  const raw = process.env.ATTACHMENT_TOKEN_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

export function signAttachmentToken(key: string, tenantId: string): string {
  const payload: AttachmentTokenPayload = {
    k: key,
    t: tenantId,
    exp: Date.now() + ttlMs(),
  };
  const data = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', getSecret()).update(data).digest('hex');
  return Buffer.from(data).toString('base64url') + '.' + signature;
}

export function verifyAttachmentToken(token: string): AttachmentTokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [dataB64, signature] = parts;
    const data = Buffer.from(dataB64, 'base64url').toString();
    const expectedSig = crypto.createHmac('sha256', getSecret()).update(data).digest('hex');
    if (signature.length !== expectedSig.length) return null;
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(data) as AttachmentTokenPayload;
    if (typeof payload.k !== 'string' || typeof payload.t !== 'string') return null;
    if (Date.now() > payload.exp) return null;
    // Cross-check the storage key prefix matches the tenant on the token.
    // Today our only signer constructs (key, tenantId) consistently via
    // buildAttachmentKey, so every legitimate token satisfies this check.
    // The assertion exists to fail-closed against a future signer bug or
    // mistakenly forwarded payload where k and t drift apart — would
    // otherwise allow cross-tenant access via a valid HMAC.
    if (!payload.k.startsWith(`attachments/${payload.t}/`)) return null;
    return payload;
  } catch {
    return null;
  }
}
