/**
 * Citation JWT Sign/Verify Tests
 *
 * Tests for signCitationToken and verifyCitationToken in purpose-jwt.ts.
 * These functions create and validate self-authenticating citation download tokens.
 *
 * Business logic covered:
 * - Token signing with correct claims (purpose, audience, jti)
 * - Token verification and payload extraction
 * - Link mode validation (direct, time_limited, click_limited)
 * - Required claim enforcement
 * - Expiry behavior
 * - Round-trip correctness
 */

import { describe, test, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signCitationToken,
  verifyCitationToken,
  CITATION_TOKEN_AUDIENCE,
  CITATION_TOKEN_PURPOSE,
  PLATFORM_JWT_ISSUER,
  AuthError,
} from '../purpose-jwt.js';
import type { CitationTokenPayload } from '../purpose-jwt.js';

const TEST_SECRET = 'test-citation-secret-key-32chars!!';

const validPayload: CitationTokenPayload = {
  tenantId: 'tenant-001',
  indexId: 'index-abc',
  documentId: 'doc-xyz',
  sourceKey: 'documents/tenant-001/index-abc/report.pdf',
  linkMode: 'direct',
};

describe('signCitationToken', () => {
  test('returns a valid JWT string', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature
  });

  test('includes purpose claim', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.purpose).toBe(CITATION_TOKEN_PURPOSE);
  });

  test('includes jti (UUID)', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.jti).toBeDefined();
    expect(typeof decoded.jti).toBe('string');
    // UUID v4 format
    expect(decoded.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('generates unique jti for each token', () => {
    const token1 = signCitationToken(validPayload, TEST_SECRET);
    const token2 = signCitationToken(validPayload, TEST_SECRET);
    const decoded1 = jwt.decode(token1) as Record<string, unknown>;
    const decoded2 = jwt.decode(token2) as Record<string, unknown>;
    expect(decoded1.jti).not.toBe(decoded2.jti);
  });

  test('includes all payload fields', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.tenantId).toBe('tenant-001');
    expect(decoded.indexId).toBe('index-abc');
    expect(decoded.documentId).toBe('doc-xyz');
    expect(decoded.sourceKey).toBe('documents/tenant-001/index-abc/report.pdf');
    expect(decoded.linkMode).toBe('direct');
  });

  test('includes maxClicks when provided', () => {
    const payload: CitationTokenPayload = {
      ...validPayload,
      linkMode: 'click_limited',
      maxClicks: 5,
    };
    const token = signCitationToken(payload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.maxClicks).toBe(5);
  });

  test('respects expiresIn option', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '10s' });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.exp).toBeDefined();
    // exp should be ~10 seconds from now
    const expectedExp = Math.floor(Date.now() / 1000) + 10;
    expect(Math.abs((decoded.exp as number) - expectedExp)).toBeLessThanOrEqual(2);
  });

  test('sets correct issuer', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.iss).toBe(PLATFORM_JWT_ISSUER);
  });

  test('sets correct audience', () => {
    const token = signCitationToken(validPayload, TEST_SECRET);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.aud).toBe(CITATION_TOKEN_AUDIENCE);
  });
});

describe('verifyCitationToken', () => {
  test('verifies and returns payload for valid token', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);

    expect(result.tenantId).toBe('tenant-001');
    expect(result.indexId).toBe('index-abc');
    expect(result.documentId).toBe('doc-xyz');
    expect(result.sourceKey).toBe('documents/tenant-001/index-abc/report.pdf');
    expect(result.linkMode).toBe('direct');
    expect(result.jti).toBeDefined();
  });

  test('throws EXPIRED_TOKEN for expired JWT', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '0s' });

    // Wait a tick for expiry
    expect(() => verifyCitationToken(token, TEST_SECRET)).toThrow(AuthError);
    try {
      verifyCitationToken(token, TEST_SECRET);
    } catch (e) {
      expect((e as AuthError).code).toBe('EXPIRED_TOKEN');
    }
  });

  test('throws for wrong secret', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '1h' });
    expect(() => verifyCitationToken(token, 'wrong-secret')).toThrow(AuthError);
  });

  test('throws WRONG_PURPOSE for wrong purpose', () => {
    // Manually craft a token with wrong purpose
    const token = jwt.sign(
      { ...validPayload, purpose: 'wrong_purpose', jti: 'test-jti' },
      TEST_SECRET,
      { issuer: PLATFORM_JWT_ISSUER, audience: CITATION_TOKEN_AUDIENCE, expiresIn: '1h' },
    );

    expect(() => verifyCitationToken(token, TEST_SECRET)).toThrow(AuthError);
    try {
      verifyCitationToken(token, TEST_SECRET);
    } catch (e) {
      expect((e as AuthError).code).toBe('WRONG_PURPOSE');
    }
  });

  test('throws for wrong audience', () => {
    const token = jwt.sign(
      { ...validPayload, purpose: CITATION_TOKEN_PURPOSE, jti: 'test-jti' },
      TEST_SECRET,
      { issuer: PLATFORM_JWT_ISSUER, audience: 'wrong-audience', expiresIn: '1h' },
    );

    expect(() => verifyCitationToken(token, TEST_SECRET)).toThrow(AuthError);
  });

  test('throws INVALID_PAYLOAD for invalid linkMode', () => {
    const token = jwt.sign(
      { ...validPayload, linkMode: 'invalid_mode', purpose: CITATION_TOKEN_PURPOSE, jti: 'test' },
      TEST_SECRET,
      { issuer: PLATFORM_JWT_ISSUER, audience: CITATION_TOKEN_AUDIENCE, expiresIn: '1h' },
    );

    expect(() => verifyCitationToken(token, TEST_SECRET)).toThrow(AuthError);
    try {
      verifyCitationToken(token, TEST_SECRET);
    } catch (e) {
      expect((e as AuthError).code).toBe('INVALID_PAYLOAD');
    }
  });

  test('throws INVALID_PAYLOAD for missing required claims', () => {
    const incomplete = { purpose: CITATION_TOKEN_PURPOSE, jti: 'test', linkMode: 'direct' };
    const token = jwt.sign(incomplete, TEST_SECRET, {
      issuer: PLATFORM_JWT_ISSUER,
      audience: CITATION_TOKEN_AUDIENCE,
      expiresIn: '1h',
    });

    expect(() => verifyCitationToken(token, TEST_SECRET)).toThrow(AuthError);
    try {
      verifyCitationToken(token, TEST_SECRET);
    } catch (e) {
      expect((e as AuthError).code).toBe('INVALID_PAYLOAD');
    }
  });

  test('returns maxClicks when present (number)', () => {
    const payload: CitationTokenPayload = {
      ...validPayload,
      linkMode: 'click_limited',
      maxClicks: 3,
    };
    const token = signCitationToken(payload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);
    expect(result.maxClicks).toBe(3);
  });

  test('returns undefined maxClicks when not present', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);
    expect(result.maxClicks).toBeUndefined();
  });

  test('returns exp claim when present', () => {
    const token = signCitationToken(validPayload, TEST_SECRET, { expiresIn: '3600s' });
    const result = verifyCitationToken(token, TEST_SECRET);
    expect(result.exp).toBeDefined();
    expect(typeof result.exp).toBe('number');
  });
});

describe('Citation JWT Round-trip', () => {
  test('sign → verify returns original payload for direct mode', () => {
    const payload: CitationTokenPayload = { ...validPayload, linkMode: 'direct' };
    const token = signCitationToken(payload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);

    expect(result.tenantId).toBe(payload.tenantId);
    expect(result.indexId).toBe(payload.indexId);
    expect(result.documentId).toBe(payload.documentId);
    expect(result.sourceKey).toBe(payload.sourceKey);
    expect(result.linkMode).toBe('direct');
  });

  test('sign → verify returns original payload for time_limited mode', () => {
    const payload: CitationTokenPayload = { ...validPayload, linkMode: 'time_limited' };
    const token = signCitationToken(payload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);
    expect(result.linkMode).toBe('time_limited');
  });

  test('sign → verify returns original payload for click_limited mode', () => {
    const payload: CitationTokenPayload = {
      ...validPayload,
      linkMode: 'click_limited',
      maxClicks: 10,
    };
    const token = signCitationToken(payload, TEST_SECRET, { expiresIn: '1h' });
    const result = verifyCitationToken(token, TEST_SECRET);
    expect(result.linkMode).toBe('click_limited');
    expect(result.maxClicks).toBe(10);
  });
});
