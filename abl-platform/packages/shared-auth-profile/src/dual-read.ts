/**
 * Auth Profile Dual-Read Helper
 *
 * Encapsulates the dual-read pattern used by all 14+ consumers during
 * the Auth Profile migration. When an entity has an authProfileId,
 * credentials are resolved via AuthProfileService. Otherwise, the legacy
 * credential resolution path is used.
 *
 * IMPORTANT: When authProfileId IS present, errors from resolve() propagate —
 * we do NOT silently fall back to legacy. Falling back on errors would mask
 * credential issues (expired, revoked, decryption failure) in production.
 */

import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('auth-profile-dual-read');

// ─── Types ────────────────────────────────────────────────────────────

export interface DualReadResult<T> {
  /** Which resolution path was used */
  source: 'auth-profile' | 'legacy';
  /** The resolved credentials */
  credentials: T;
}

export interface DualReadOptions<T> {
  /** The authProfileId from the consumer entity (may be null/undefined) */
  authProfileId: string | null | undefined;
  /** Tenant scope for isolation */
  tenantId: string;
  /** Project scope (optional, some consumers are tenant-level) */
  projectId?: string;
  /** AuthProfileService.resolve() call — errors propagate, no silent fallback */
  resolve: () => Promise<T>;
  /** Legacy credential resolution — used when authProfileId is absent */
  legacyFallback: () => Promise<T>;
  /** Consumer name for trace logging (e.g. 'ModelConfig', 'ChannelConnection') */
  consumer: string;
}

// ─── Core Function ────────────────────────────────────────────────────

/**
 * Resolves credentials using the dual-read pattern:
 *
 * 1. If authProfileId is present:
 *    → Call resolve() (errors propagate — no fallback on failure)
 * 2. Otherwise:
 *    → Call legacyFallback()
 *
 * This ensures that once an entity is migrated to Auth Profile,
 * credential failures surface immediately rather than silently
 * using stale legacy credentials.
 */
export async function dualReadCredentials<T>(opts: DualReadOptions<T>): Promise<DualReadResult<T>> {
  if (opts.authProfileId) {
    log.debug('Resolving credentials via auth profile', {
      consumer: opts.consumer,
      authProfileId: opts.authProfileId,
      tenantId: opts.tenantId,
    });

    // Let errors propagate — do NOT catch and fall back to legacy.
    // If resolve() throws (expired, revoked, decryption failure),
    // the caller must handle the error.
    const credentials = await opts.resolve();

    log.debug('Resolved credentials via auth profile', {
      consumer: opts.consumer,
      authProfileId: opts.authProfileId,
      source: 'auth-profile',
    });

    return { source: 'auth-profile', credentials };
  }

  log.debug('Resolving credentials via legacy path', {
    consumer: opts.consumer,
    authProfileId: opts.authProfileId ?? null,
  });

  const credentials = await opts.legacyFallback();
  return { source: 'legacy', credentials };
}
