/**
 * Session-level LRU cache for resolved Auth Profile credentials.
 *
 * Cache-key shape (CK-1):
 *   {tenantId}:{authType}:{profileId}:{profileVersion}:{scopeHash}[:{principalKind}:{principalId}]
 *
 * The leading `auth-token:` prefix from the canonical CK-1 string is implicit
 * here — this cache is per-process and namespaced by class instance, so the
 * stored key is the suffix portion. Redis-backed caches (e.g. the OAuth2
 * client_credentials token cache) prepend the prefix when serializing.
 *
 * `tenantId` is mandatory (defense-in-depth against GAP-7 cross-tenant leaks).
 * `profileVersion` is the new monotonic-int field bumped via the auth_profiles
 * pre-save hook (Phase 0.4); a config/secret rewrite produces a fresh version
 * which naturally invalidates every cached entry that referenced the prior
 * version. `scopeHash` is the SHA-256 of the comma-joined sorted scope list,
 * empty string for non-OAuth credentials. The optional principal segment
 * scopes per-user OAuth tokens; omitted for shared/preconfigured profiles.
 *
 * Pattern: pod-local Map-based LRU with TTL eviction. Max 200 entries. TTL
 * defaults to 5 min (callers may override with `min(token.expires_in - 60s,
 * 3600s)` for OAuth surfaces).
 *
 * Pattern reference: DEKCacheL1 in apps/runtime/src/services/kms/dek-cache.ts.
 */

import { createHash } from 'node:crypto';

export interface CachedCredentials {
  profileId: string;
  authType: string;
  /**
   * Mirrors the `profileVersion` segment of the CK-1 key. Stored on the entry
   * so cache consumers can carry the version forward into downstream caches
   * (e.g. the OAuth2 CC token Redis cache) without re-querying.
   */
  profileVersion: number;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

export interface CacheValidationContext {
  updatedAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * CK-1 cache-key components. Every credential / token / signing-material cache
 * (in-memory or Redis) MUST key by this shape.
 */
export interface CK1KeyParts {
  tenantId: string;
  authType: string;
  profileId: string;
  profileVersion: number;
  /** SHA-256 of `scopes.sort().join(',')` for OAuth profiles; `null`/`''` for non-OAuth. */
  scopeHash?: string | null;
  /** `'user'` for per-user OAuth tokens; `'tenant'` for `__tenant__` shared grants; omitted for preconfigured profiles. */
  principalKind?: string | null;
  /** Caller's `userId` or `'__tenant__'`. Required when `principalKind` is set. */
  principalId?: string | null;
}

interface CacheEntry {
  credentials: CachedCredentials;
  cachedAt: number;
  ttlMs: number;
  updatedAtMs: number | null;
  expiresAtMs: number | null;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Compute the canonical scopeHash from a scope string or array.
 *
 * Empty / undefined input returns the empty string — a non-OAuth profile has
 * no scope, and conflating it with the hash of an empty list would create
 * collisions across profile versions.
 */
export function computeScopeHash(scopes: string | string[] | null | undefined): string {
  if (!scopes) return '';
  const list = Array.isArray(scopes)
    ? scopes
    : scopes
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  if (list.length === 0) return '';
  const canonical = [...list].sort().join(',');
  return createHash('sha256').update(canonical).digest('hex');
}

export class AuthProfileCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  private key(parts: CK1KeyParts): string {
    const scope = parts.scopeHash ?? '';
    const principal =
      parts.principalKind && parts.principalId
        ? `:${parts.principalKind}:${parts.principalId}`
        : '';
    return `${parts.tenantId}:${parts.authType}:${parts.profileId}:${parts.profileVersion}:${scope}${principal}`;
  }

  /** @deprecated Pre-CK-1 name-based key. Retained for the legacy getByName/setByName pair. Do not introduce new callers. */
  private nameKey(tenantId: string, profileName: string, environment: string | null): string {
    return `name:${tenantId}:${profileName}:${environment ?? '_null_'}`;
  }

  private isEntryFresh(entry: CacheEntry, validation?: CacheValidationContext): boolean {
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      return false;
    }

    if (!validation) {
      return true;
    }

    const expectedUpdatedAtMs = validation.updatedAt ? validation.updatedAt.getTime() : null;
    if (entry.updatedAtMs !== expectedUpdatedAtMs) {
      return false;
    }

    const expectedExpiresAtMs = validation.expiresAt ? validation.expiresAt.getTime() : null;
    return entry.expiresAtMs === expectedExpiresAtMs;
  }

  get(parts: CK1KeyParts, validation?: CacheValidationContext): CachedCredentials | null {
    const k = this.key(parts);
    const entry = this.cache.get(k);
    if (!entry) return null;

    if (!this.isEntryFresh(entry, validation)) {
      this.cache.delete(k);
      return null;
    }

    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.credentials;
  }

  set(
    parts: CK1KeyParts,
    credentials: CachedCredentials,
    ttlMs: number = DEFAULT_TTL_MS,
    validation?: CacheValidationContext,
  ): void {
    const k = this.key(parts);

    if (this.cache.size >= this.maxEntries && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(k, {
      credentials,
      cachedAt: Date.now(),
      ttlMs,
      updatedAtMs: validation?.updatedAt ? validation.updatedAt.getTime() : null,
      expiresAtMs: validation?.expiresAt ? validation.expiresAt.getTime() : null,
    });
  }

  /** @deprecated Pre-CK-1 lookup. Retained for tests; production callers must use `get(CK1KeyParts)`. */
  getByName(
    tenantId: string,
    profileName: string,
    environment: string | null,
    validation?: CacheValidationContext,
  ): CachedCredentials | null {
    const k = this.nameKey(tenantId, profileName, environment);
    const entry = this.cache.get(k);
    if (!entry) return null;

    if (!this.isEntryFresh(entry, validation)) {
      this.cache.delete(k);
      return null;
    }

    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.credentials;
  }

  /** @deprecated Pre-CK-1 lookup. Retained for tests; production callers must use `set(CK1KeyParts, ...)`. */
  setByName(
    tenantId: string,
    profileName: string,
    environment: string | null,
    credentials: CachedCredentials,
    ttlMs: number = DEFAULT_TTL_MS,
    validation?: CacheValidationContext,
  ): void {
    const k = this.nameKey(tenantId, profileName, environment);

    if (this.cache.size >= this.maxEntries && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(k, {
      credentials,
      cachedAt: Date.now(),
      ttlMs,
      updatedAtMs: validation?.updatedAt ? validation.updatedAt.getTime() : null,
      expiresAtMs: validation?.expiresAt ? validation.expiresAt.getTime() : null,
    });
  }

  /**
   * Invalidate cached credentials for an entire tenant or for one specific
   * profile within a tenant. The CK-1 key shape places `profileId` at the
   * third segment, so the predicate scans for `${tenantId}:`-prefixed keys
   * containing `:${profileId}:` (preceded by an authType segment).
   */
  invalidate(tenantId: string, profileId?: string): void {
    if (profileId) {
      const tenantPrefix = `${tenantId}:`;
      const profileMarker = `:${profileId}:`;
      const legacyNamePrefix = `name:${tenantId}:`;
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(tenantPrefix) && key.includes(profileMarker)) {
          this.cache.delete(key);
        } else if (key.startsWith(legacyNamePrefix)) {
          // Legacy name-based entries cannot be filtered by profileId; do nothing.
          // A targeted invalidateByName must be used for those.
        }
      }
    } else {
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(`${tenantId}:`) || key.startsWith(`name:${tenantId}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /** @deprecated Pre-CK-1. Retained for tests; production callers should rely on `profileVersion`-bump invalidation. */
  invalidateByName(tenantId: string, profileName: string): void {
    const prefix = `name:${tenantId}:${profileName}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
