/**
 * Artifact Hasher & HMAC Verifier Tests
 *
 * Tests for:
 * - SHA-256 artifact hashing
 * - HMAC-SHA256 verification (valid, expired, invalid signature)
 * - CallerContext builder
 */

import { describe, test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  hashArtifact,
  verifyHMAC,
  buildCallerContext,
  HMAC_MAX_AGE_SECONDS,
  DEFAULT_RESUME_WINDOW_SECONDS,
} from '../services/identity/artifact-hasher.js';

// =============================================================================
// hashArtifact
// =============================================================================

describe('hashArtifact', () => {
  test('produces consistent SHA-256 hex output', () => {
    const hash1 = hashArtifact('test-cookie-value');
    const hash2 = hashArtifact('test-cookie-value');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('produces different hashes for different inputs', () => {
    const hash1 = hashArtifact('cookie-a');
    const hash2 = hashArtifact('cookie-b');
    expect(hash1).not.toBe(hash2);
  });

  test('handles empty string', () => {
    const hash = hashArtifact('');
    expect(hash).toHaveLength(64);
  });
});

// =============================================================================
// verifyHMAC
// =============================================================================

describe('verifyHMAC', () => {
  const SECRET_KEY = 'test-secret-key-for-hmac';

  function createValidHMAC(userId: string, timestamp: number): string {
    const message = `${userId}:${timestamp}`;
    return createHmac('sha256', SECRET_KEY).update(message).digest('hex');
  }

  test('accepts valid HMAC with current timestamp', () => {
    const userId = 'user-123';
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createValidHMAC(userId, timestamp);

    const result = verifyHMAC({ userId, hmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('accepts HMAC within max age window', () => {
    const userId = 'user-456';
    // Timestamp 100 seconds in the past (within 300s window)
    const timestamp = Math.floor(Date.now() / 1000) - 100;
    const hmac = createValidHMAC(userId, timestamp);

    const result = verifyHMAC({ userId, hmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(true);
  });

  test('rejects expired timestamp (> HMAC_MAX_AGE_SECONDS)', () => {
    const userId = 'user-789';
    const timestamp = Math.floor(Date.now() / 1000) - (HMAC_MAX_AGE_SECONDS + 10);
    const hmac = createValidHMAC(userId, timestamp);

    const result = verifyHMAC({ userId, hmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_EXPIRED');
  });

  test('rejects wrong signature', () => {
    const userId = 'user-abc';
    const timestamp = Math.floor(Date.now() / 1000);
    const wrongHmac = createHmac('sha256', 'wrong-secret')
      .update(`${userId}:${timestamp}`)
      .digest('hex');

    const result = verifyHMAC({ userId, hmac: wrongHmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_INVALID');
  });

  test('rejects mismatched buffer lengths (truncated signature)', () => {
    const userId = 'user-def';
    const timestamp = Math.floor(Date.now() / 1000);
    const truncatedHmac = createValidHMAC(userId, timestamp).slice(0, 32);

    const result = verifyHMAC({ userId, hmac: truncatedHmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_INVALID');
  });

  test('rejects future timestamps beyond max age', () => {
    const userId = 'user-future';
    const timestamp = Math.floor(Date.now() / 1000) + HMAC_MAX_AGE_SECONDS + 60;
    const hmac = createValidHMAC(userId, timestamp);

    const result = verifyHMAC({ userId, hmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_EXPIRED');
  });

  test('rejects non-hex HMAC format', () => {
    const userId = 'user-badfmt';
    const timestamp = Math.floor(Date.now() / 1000);

    const result = verifyHMAC({ userId, hmac: 'not-a-hex-string!!', timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_INVALID');
    expect(result.error?.message).toContain('hex');
  });

  test('accepts uppercase hex HMAC (case-insensitive)', () => {
    const userId = 'user-upper';
    const timestamp = Math.floor(Date.now() / 1000);
    const hmacLower = createValidHMAC(userId, timestamp);
    const hmacUpper = hmacLower.toUpperCase();

    const result = verifyHMAC({ userId, hmac: hmacUpper, timestamp }, SECRET_KEY);
    expect(result.success).toBe(true);
  });

  test('rejects HMAC with wrong length (not 64 chars)', () => {
    const userId = 'user-short';
    const timestamp = Math.floor(Date.now() / 1000);

    const result = verifyHMAC({ userId, hmac: 'abcdef1234', timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_INVALID');
  });
});

// =============================================================================
// buildCallerContext
// =============================================================================

describe('buildCallerContext', () => {
  test('constructs CallerContext with all required fields', () => {
    const ctx = buildCallerContext({
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      identityTier: 0,
      verificationMethod: 'none',
    });

    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.channel).toBe('sdk_websocket');
    expect(ctx.identityTier).toBe(0);
    expect(ctx.verificationMethod).toBe('none');
    expect(ctx.channelArtifact).toBeUndefined();
  });

  test('hashes raw artifact when provided', () => {
    const ctx = buildCallerContext({
      tenantId: 'tenant-2',
      channel: 'web_chat',
      identityTier: 1,
      verificationMethod: 'cookie',
      rawArtifact: 'raw-cookie-value',
      channelArtifactType: 'cookie',
    });

    expect(ctx.channelArtifact).toBeDefined();
    expect(ctx.channelArtifact).toHaveLength(64); // SHA-256 hex
    expect(ctx.channelArtifact).toBe(hashArtifact('raw-cookie-value'));
    expect(ctx.channelArtifactType).toBe('cookie');
  });

  test('does not hash when no rawArtifact', () => {
    const ctx = buildCallerContext({
      tenantId: 'tenant-3',
      channel: 'api',
      identityTier: 0,
      verificationMethod: 'none',
    });

    expect(ctx.channelArtifact).toBeUndefined();
  });

  test('populates optional identity fields', () => {
    const ctx = buildCallerContext({
      tenantId: 'tenant-4',
      channel: 'sdk_websocket',
      channelId: 'channel-abc',
      contactId: 'contact-123',
      customerId: 'customer-456',
      anonymousId: 'anon-789',
      initiatedById: 'platform-user-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      sourceIp: '192.168.1.1',
      userAgent: 'SDK/1.0',
    });

    expect(ctx.channelId).toBe('channel-abc');
    expect(ctx.contactId).toBe('contact-123');
    expect(ctx.customerId).toBe('customer-456');
    expect(ctx.anonymousId).toBe('anon-789');
    expect(ctx.initiatedById).toBe('platform-user-1');
    expect(ctx.identityTier).toBe(2);
    expect(ctx.verificationMethod).toBe('hmac');
    expect(ctx.sourceIp).toBe('192.168.1.1');
    expect(ctx.userAgent).toBe('SDK/1.0');
  });
});

// =============================================================================
// Constants
// =============================================================================

describe('constants', () => {
  test('HMAC_MAX_AGE_SECONDS is 300', () => {
    expect(HMAC_MAX_AGE_SECONDS).toBe(300);
  });

  test('DEFAULT_RESUME_WINDOW_SECONDS is 86400 (24 hours)', () => {
    expect(DEFAULT_RESUME_WINDOW_SECONDS).toBe(86_400);
  });
});
