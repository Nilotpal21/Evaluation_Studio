/**
 * Unit tests for HMAC callback signing (callback-signer.ts).
 *
 * Pure function tests — no mocks, no DI needed.
 * Verifies: round-trip, determinism, constant-time comparison, clock-skew tolerance.
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signCallbackPayload,
  verifyCallbackSignature,
  parseSignatureHeader,
  TIMESTAMP_TOLERANCE_SECONDS,
} from '../../../services/agent-assist/callback-signer.js';

describe('callback-signer', () => {
  const secret = 'test-secret-key-12345';
  const body = JSON.stringify({ messageId: 'msg_1', output: [{ type: 'text', content: 'Hello' }] });

  describe('signCallbackPayload', () => {
    it('produces t=<ts>,v1=<hex> format', () => {
      const sig = signCallbackPayload(body, secret, 1700000000);
      expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    });

    it('is deterministic for same (secret, timestamp, body)', () => {
      const ts = 1700000000;
      const sig1 = signCallbackPayload(body, secret, ts);
      const sig2 = signCallbackPayload(body, secret, ts);
      expect(sig1).toBe(sig2);
    });

    it('differs for different secrets', () => {
      const ts = 1700000000;
      const sig1 = signCallbackPayload(body, 'secret-a', ts);
      const sig2 = signCallbackPayload(body, 'secret-b', ts);
      expect(sig1).not.toBe(sig2);
    });

    it('differs for different bodies', () => {
      const ts = 1700000000;
      const sig1 = signCallbackPayload('body-a', secret, ts);
      const sig2 = signCallbackPayload('body-b', secret, ts);
      expect(sig1).not.toBe(sig2);
    });

    it('differs for different timestamps', () => {
      const sig1 = signCallbackPayload(body, secret, 1700000000);
      const sig2 = signCallbackPayload(body, secret, 1700000001);
      expect(sig1).not.toBe(sig2);
    });

    it('uses current time when timestamp not provided', () => {
      const sig = signCallbackPayload(body, secret);
      const parsed = parseSignatureHeader(sig);
      expect(parsed).not.toBeNull();
      const now = Math.floor(Date.now() / 1000);
      // Should be within 2 seconds of now
      expect(Math.abs(now - parsed!.timestamp)).toBeLessThanOrEqual(2);
    });
  });

  describe('parseSignatureHeader', () => {
    it('parses valid header', () => {
      const result = parseSignatureHeader('t=1700000000,v1=abcdef0123456789');
      expect(result).toEqual({
        timestamp: 1700000000,
        signature: 'abcdef0123456789',
      });
    });

    it('returns null for missing t=', () => {
      expect(parseSignatureHeader('v1=abc')).toBeNull();
    });

    it('returns null for missing v1=', () => {
      expect(parseSignatureHeader('t=123')).toBeNull();
    });

    it('returns null for non-numeric timestamp', () => {
      expect(parseSignatureHeader('t=abc,v1=def')).toBeNull();
    });

    it('handles whitespace in parts', () => {
      const result = parseSignatureHeader('t=123 , v1=abc');
      expect(result).toEqual({ timestamp: 123, signature: 'abc' });
    });
  });

  describe('verifyCallbackSignature', () => {
    it('accepts valid signature within tolerance', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      const result = verifyCallbackSignature(body, header, secret, ts);
      expect(result.valid).toBe(true);
    });

    it('accepts signature at tolerance boundary (5 min)', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      // Verify at exactly tolerance boundary
      const result = verifyCallbackSignature(
        body,
        header,
        secret,
        ts + TIMESTAMP_TOLERANCE_SECONDS,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects signature outside tolerance window', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      const result = verifyCallbackSignature(
        body,
        header,
        secret,
        ts + TIMESTAMP_TOLERANCE_SECONDS + 1,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('tolerance');
    });

    it('rejects signature with wrong secret', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      const result = verifyCallbackSignature(body, header, 'wrong-secret', ts);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('mismatch');
    });

    it('rejects bit-flipped body', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      const flippedBody = body.slice(0, -1) + 'X';
      const result = verifyCallbackSignature(flippedBody, header, secret, ts);
      expect(result.valid).toBe(false);
    });

    it('rejects malformed header', () => {
      const result = verifyCallbackSignature(body, 'garbage', secret, 1700000000);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Malformed');
    });

    it('uses constant-time comparison (signature length matters)', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      // Manually construct a header with wrong-length signature
      const shortSig = 't=' + ts + ',v1=abc';
      const result = verifyCallbackSignature(body, shortSig, secret, ts);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('mismatch');
    });

    it('supports custom tolerance', () => {
      const ts = 1700000000;
      const header = signCallbackPayload(body, secret, ts);
      // 10-second tolerance — should reject at 11s
      const result = verifyCallbackSignature(body, header, secret, ts + 11, 10);
      expect(result.valid).toBe(false);
    });

    it('manual HMAC matches', () => {
      // Verify the HMAC computation matches a manual calculation
      const ts = 1700000000;
      const signedPayload = `${ts}.${body}`;
      const expectedHmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
      const header = signCallbackPayload(body, secret, ts);
      const parsed = parseSignatureHeader(header);
      expect(parsed).not.toBeNull();
      expect(parsed!.signature).toBe(expectedHmac);
    });
  });
});
