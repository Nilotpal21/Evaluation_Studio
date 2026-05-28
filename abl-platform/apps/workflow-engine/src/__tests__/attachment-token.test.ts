/**
 * Boundary tests for the HMAC-signed attachment token.
 *
 * Covers the security-critical paths: signature tampering, expiry, payload
 * cross-checks. The download endpoint trusts the token as a bearer credential,
 * so a single regression here silently opens cross-tenant access. These tests
 * exist to fail loudly if any of the verify-side checks are weakened.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { signAttachmentToken, verifyAttachmentToken } from '../lib/attachment-token.js';

const TENANT = 'tenant-abc';
const KEY = `attachments/${TENANT}/01234567-89ab-cdef-0123-456789abcdef.pdf`;

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-not-for-prod';
});

beforeEach(() => {
  delete process.env.ATTACHMENT_TOKEN_TTL_MS;
});

describe('attachment token sign + verify round-trip', () => {
  it('a freshly signed token verifies and returns the original key + tenant', () => {
    const token = signAttachmentToken(KEY, TENANT);
    const payload = verifyAttachmentToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.k).toBe(KEY);
    expect(payload!.t).toBe(TENANT);
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  it('default TTL is 24 hours', () => {
    const before = Date.now();
    const token = signAttachmentToken(KEY, TENANT);
    const payload = verifyAttachmentToken(token);
    const ttl = payload!.exp - before;
    // Allow a small window for setup time. 24h = 86_400_000 ms.
    expect(ttl).toBeGreaterThanOrEqual(86_400_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(86_400_000 + 1000);
  });

  it('respects ATTACHMENT_TOKEN_TTL_MS override', () => {
    process.env.ATTACHMENT_TOKEN_TTL_MS = String(60_000); // 1 min
    const before = Date.now();
    const token = signAttachmentToken(KEY, TENANT);
    const payload = verifyAttachmentToken(token);
    const ttl = payload!.exp - before;
    expect(ttl).toBeGreaterThanOrEqual(59_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });
});

describe('attachment token rejects tampering', () => {
  it('returns null when the signature is altered', () => {
    const token = signAttachmentToken(KEY, TENANT);
    const [data, sig] = token.split('.');
    // Flip the last hex char of the signature.
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
    expect(verifyAttachmentToken(`${data}.${flipped}`)).toBeNull();
  });

  it('returns null when the payload is altered (signature no longer matches)', () => {
    const token = signAttachmentToken(KEY, TENANT);
    const [_data, sig] = token.split('.');
    // Forge a new payload but keep the original signature.
    const forged = Buffer.from(
      JSON.stringify({
        k: 'attachments/other-tenant/x.pdf',
        t: 'other-tenant',
        exp: Date.now() + 60_000,
      }),
    ).toString('base64url');
    expect(verifyAttachmentToken(`${forged}.${sig}`)).toBeNull();
  });

  it('returns null when the token has no separator', () => {
    expect(verifyAttachmentToken('not-a-token')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifyAttachmentToken('')).toBeNull();
  });
});

describe('attachment token rejects expiry', () => {
  it('returns null when the token has expired', () => {
    process.env.ATTACHMENT_TOKEN_TTL_MS = '1'; // 1 ms
    const token = signAttachmentToken(KEY, TENANT);
    // Wait past the expiry. 50ms is generous.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(verifyAttachmentToken(token)).toBeNull();
        resolve();
      }, 50);
    });
  });
});

describe('attachment token rejects cross-tenant key/tenant mismatch', () => {
  it("returns null when payload.k does not start with 'attachments/<payload.t>/'", async () => {
    // Hand-craft a payload where k belongs to tenant-X but t says tenant-Y.
    // This simulates a future signer bug where the caller passes inconsistent
    // (key, tenantId). Without the prefix check in verify, the HMAC would be
    // valid and the GET handler would serve tenant-X's file to a tenant-Y URL.
    process.env.JWT_SECRET = 'test-secret-not-for-prod';
    const crypto = await import('crypto');
    const payload = {
      k: 'attachments/tenant-X/aaa.pdf',
      t: 'tenant-Y',
      exp: Date.now() + 60_000,
    };
    const data = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', 'test-secret-not-for-prod').update(data).digest('hex');
    const token = `${Buffer.from(data).toString('base64url')}.${sig}`;
    expect(verifyAttachmentToken(token)).toBeNull();
  });

  it('returns null when payload.k has no tenant prefix at all', async () => {
    const crypto = await import('crypto');
    const payload = { k: '/etc/passwd', t: 'tenant-X', exp: Date.now() + 60_000 };
    const data = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', 'test-secret-not-for-prod').update(data).digest('hex');
    const token = `${Buffer.from(data).toString('base64url')}.${sig}`;
    expect(verifyAttachmentToken(token)).toBeNull();
  });
});

describe('attachment token requires JWT_SECRET', () => {
  it('throws when JWT_SECRET is missing at sign time', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => signAttachmentToken(KEY, TENANT)).toThrowError(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});
