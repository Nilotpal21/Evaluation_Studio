/**
 * Pure utility functions for platform API key generation and validation.
 *
 * Extracted as pure functions so they can be unit-tested without any
 * mocks (UT-1 through UT-4 in test spec).
 */

import crypto from 'crypto';
import { PLATFORM_KEY_SCOPE_KEYS, validateRegistryScopes } from '@agent-platform/shared-auth';

/** Predefined scopes for platform keys */
export const AVAILABLE_SCOPES = PLATFORM_KEY_SCOPE_KEYS;
export type PlatformKeyScope = (typeof PLATFORM_KEY_SCOPE_KEYS)[number];

/**
 * Generate a platform API key with `abl_` prefix.
 *
 * - rawKey: `abl_` + 48 hex chars (24 random bytes)
 * - prefix: first 8 chars of rawKey (used for lookup in runtime auth)
 * - keyHash: SHA-256 hex digest of rawKey (stored in DB, never the raw key)
 */
export function generatePlatformKey(): {
  rawKey: string;
  prefix: string;
  keyHash: string;
} {
  const rawKey = `abl_${crypto.randomBytes(24).toString('hex')}`;
  const prefix = rawKey.substring(0, 8);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return { rawKey, prefix, keyHash };
}

/**
 * Generate a `plt-<uuid>` clientId for UI-created platform keys.
 */
export function generateClientId(): string {
  return `plt-${crypto.randomUUID()}`;
}

/**
 * Validate that all provided scopes are in the predefined list.
 */
export function validateScopes(scopes: string[]): scopes is PlatformKeyScope[] {
  return validateRegistryScopes(scopes).valid;
}

/**
 * Compute an expiration date from a preset or custom date string.
 *
 * - 'none' or null → no expiration (returns null)
 * - '30d' → 30 days from now
 * - '90d' → 90 days from now
 * - customDate string → parsed as ISO date
 */
export function computeExpiresAt(
  preset: 'none' | '30d' | '90d' | null,
  customDate?: string,
): Date | null {
  if (customDate) {
    return new Date(customDate);
  }

  switch (preset) {
    case '30d': {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return d;
    }
    case '90d': {
      const d = new Date();
      d.setDate(d.getDate() + 90);
      return d;
    }
    case 'none':
    case null:
    default:
      return null;
  }
}
