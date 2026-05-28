/**
 * Unit tests for platform key utility functions (UT-1 through UT-4).
 *
 * These are pure functions — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  generatePlatformKey,
  generateClientId,
  validateScopes,
  computeExpiresAt,
  AVAILABLE_SCOPES,
} from '../app/api/keys/platform-key-utils';
import crypto from 'crypto';
import { PLATFORM_KEY_SCOPE_KEYS } from '@agent-platform/shared-auth';

describe('platform-key-utils', () => {
  // UT-1: generatePlatformKey
  describe('generatePlatformKey', () => {
    it('returns a raw key with abl_ prefix', () => {
      const { rawKey } = generatePlatformKey();
      expect(rawKey).toMatch(/^abl_[0-9a-f]{48}$/);
    });

    it('returns an 8-char prefix from the raw key', () => {
      const { rawKey, prefix } = generatePlatformKey();
      expect(prefix).toHaveLength(8);
      expect(prefix).toBe(rawKey.substring(0, 8));
    });

    it('returns a 64-char hex SHA-256 hash of the raw key', () => {
      const { rawKey, keyHash } = generatePlatformKey();
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
      const expected = crypto.createHash('sha256').update(rawKey).digest('hex');
      expect(keyHash).toBe(expected);
    });

    it('generates unique keys on each call', () => {
      const key1 = generatePlatformKey();
      const key2 = generatePlatformKey();
      expect(key1.rawKey).not.toBe(key2.rawKey);
      expect(key1.keyHash).not.toBe(key2.keyHash);
    });
  });

  // UT-2: validateScopes
  describe('validateScopes', () => {
    it('accepts valid scopes', () => {
      expect(validateScopes(['workflows.execute'])).toBe(true);
      expect(validateScopes(['workflows.read'])).toBe(true);
      expect(validateScopes(['workflows.execute', 'agents.read'])).toBe(true);
    });

    it('rejects invalid scopes', () => {
      expect(validateScopes(['invalid.scope'])).toBe(false);
      expect(validateScopes(['workflows.execute', 'admin:all'])).toBe(false);
    });

    it('rejects empty scopes array', () => {
      expect(validateScopes([])).toBe(true); // every() on empty array returns true
    });

    it('AVAILABLE_SCOPES contains the registry-derived scope set', () => {
      expect(AVAILABLE_SCOPES).toContain('workflows.execute');
      expect(AVAILABLE_SCOPES).toContain('workflows.read');
      expect(AVAILABLE_SCOPES).toContain('agents.write');
      expect(AVAILABLE_SCOPES).toContain('analytics.read');
      expect(AVAILABLE_SCOPES).toEqual(PLATFORM_KEY_SCOPE_KEYS);
    });
  });

  // UT-3: computeExpiresAt
  describe('computeExpiresAt', () => {
    it('returns null for "none" preset', () => {
      expect(computeExpiresAt('none')).toBeNull();
    });

    it('returns null for null preset', () => {
      expect(computeExpiresAt(null)).toBeNull();
    });

    it('returns a date ~30 days in the future for "30d" preset', () => {
      const result = computeExpiresAt('30d');
      expect(result).toBeInstanceOf(Date);
      const diffMs = result!.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(29.9);
      expect(diffDays).toBeLessThan(30.1);
    });

    it('returns a date ~90 days in the future for "90d" preset', () => {
      const result = computeExpiresAt('90d');
      expect(result).toBeInstanceOf(Date);
      const diffMs = result!.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(89.9);
      expect(diffDays).toBeLessThan(90.1);
    });

    it('returns parsed date for custom date string', () => {
      const customDate = '2030-12-31T23:59:59.000Z';
      const result = computeExpiresAt('none', customDate);
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toBe(customDate);
    });

    it('custom date takes precedence over preset', () => {
      const customDate = '2030-06-15T00:00:00.000Z';
      const result = computeExpiresAt('30d', customDate);
      expect(result!.toISOString()).toBe(customDate);
    });
  });

  // UT-4: generateClientId
  describe('generateClientId', () => {
    it('returns a string with plt- prefix', () => {
      const clientId = generateClientId();
      expect(clientId).toMatch(/^plt-/);
    });

    it('contains a UUID after the prefix', () => {
      const clientId = generateClientId();
      const uuid = clientId.slice(4);
      // Standard UUID format: 8-4-4-4-12 hex chars with dashes
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('generates unique clientIds on each call', () => {
      const id1 = generateClientId();
      const id2 = generateClientId();
      expect(id1).not.toBe(id2);
    });
  });
});
