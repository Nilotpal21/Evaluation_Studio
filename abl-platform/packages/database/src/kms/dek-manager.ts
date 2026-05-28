/**
 * DEK Manager
 *
 * Manages per-scope Data Encryption Keys (one active DEK per tenant+project+environment).
 *
 * - acquireDEK(): Get (or create) the active DEK for a scope
 * - unwrapDEK(): Unwrap a DEK by its dekId (Decision 3: no scope needed)
 * - batchUnwrapDEKs(): Unwrap multiple DEKs (one KMS call per unique dekId)
 * - forceRotateDEK(): Force-rotate DEKs for a scope
 *
 * Decision 3: dekId is opaque (crypto.randomBytes base64url), globally unique.
 * Decrypt lookup uses dekId only — no scope needed.
 *
 * Decision 4: epoch is for concurrent creation dedup only.
 * Unique index { tenantId, projectId, environment, epoch } prevents duplicates.
 *
 * DEKs are cached in an in-process LRU (100 entries, 5min TTL).
 * Unwrapped key material is zero-filled on eviction.
 */

import { getKMSProviderPool } from './kms-registry.js';
import type { KMSProvider } from './types.js';
import type { IDEKEntry, IResolvedProviderRef } from '../models/index.js';
import { KMSResolver } from './kms-resolver.js';
import type { InvalidationTransport } from './kms-resolver.js';
import { computeFingerprint } from './kms-provider-pool.js';

// =============================================================================
// TYPES (must match DEKManagerLike/DEKScope/AcquiredDEK in shared-encryption's
// tenant-encryption-facade.ts — duck-typed to avoid circular dependency)
// =============================================================================

export interface DEKScope {
  tenantId: string;
  /** Required — Decision 1: greenfield, no default. Use '_tenant' for tenant-scoped models. */
  projectId: string;
  /** Required — Decision 1: greenfield, no default. Use '_tenant' for tenant-scoped, '_shared' for no-env models. */
  environment: string;
}

export interface AcquiredDEK {
  plaintext: Buffer;
  /** Opaque DEK identifier embedded in ciphertext header (Decision 3). */
  dekId: string;
  kekKeyId: string;
  kekKeyVersion: number;
}

// =============================================================================
// LOGGER
// =============================================================================

interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: Logger = {
  debug() {},
  warn(msg, meta) {
    process.stderr.write(`[dek-manager] WARN: ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
  },
  info(msg, meta) {
    process.stderr.write(`[dek-manager] INFO: ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
  },
};

// =============================================================================
// UNWRAPPED DEK CACHE (LRU with TTL + zero-fill on eviction)
// Decision 3: cache keyed by dekId (globally unique)
// =============================================================================

interface CachedDEK {
  plaintext: Buffer;
  cachedAt: number;
  /** tenantId stored for evictByTenant (dekId doesn't encode tenant) */
  tenantId: string;
}

class DEKCache {
  private cache = new Map<string, CachedDEK>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 100, ttlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(dekId: string, tenantId?: string): CachedDEK | null {
    const entry = this.cache.get(dekId);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.evict(dekId);
      return null;
    }

    // Tenant isolation: reject cache hit if tenantId doesn't match
    if (tenantId && entry.tenantId !== tenantId) {
      return null;
    }

    // LRU: move to end
    this.cache.delete(dekId);
    this.cache.set(dekId, entry);
    return {
      plaintext: Buffer.from(entry.plaintext),
      cachedAt: entry.cachedAt,
      tenantId: entry.tenantId,
    };
  }

  set(dekId: string, plaintext: Buffer, tenantId: string): void {
    if (this.cache.size >= this.maxEntries && !this.cache.has(dekId)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }

    this.cache.set(dekId, { plaintext: Buffer.from(plaintext), cachedAt: Date.now(), tenantId });
  }

  private evict(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.plaintext.fill(0); // Zero-fill on eviction
      this.cache.delete(key);
    }
  }

  /** Evict all cached DEKs for a given tenant (zero-fill key material). */
  evictByTenant(tenantId: string): number {
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (entry.tenantId === tenantId) {
        entry.plaintext.fill(0);
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      entry.plaintext.fill(0);
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// DEK MANAGER
// =============================================================================

const MAX_INFLIGHT = 500;
const MAX_ACQUIRE_RETRIES = 3;

/** Exponential backoff with jitter for E11000 duplicate-key retries. */
function retryDelayMs(attempt: number): number {
  const baseMs = 50;
  const exponential = baseMs * Math.pow(2, attempt); // 50, 100, 200
  const jitter = Math.random() * exponential * 0.5; // 0-50% jitter
  return Math.min(exponential + jitter, 2000); // cap at 2s
}

export interface DEKManagerOptions {
  logger?: Logger;
}

export class DEKManager {
  private cache = new DEKCache();
  private resolver: KMSResolver;
  private inflight = new Map<string, Promise<AcquiredDEK>>();
  private log: Logger;
  /** Maps scopeKey → last acquired dekId for sync encrypt paths. LRU-capped at 1000 entries. */
  private _lastAcquiredDekIds = new Map<string, string>();
  private static readonly MAX_ACTIVE_DEK_IDS = 1000;
  private invalidationTransport: InvalidationTransport | null = null;
  private static readonly INVALIDATION_CHANNEL = 'kms:dek:invalidate';

  private scopeKey(scope: DEKScope): string {
    return `${scope.tenantId}:${scope.projectId}:${scope.environment}`;
  }

  /** Set active DEK ID for a scope, evicting oldest if at capacity. */
  private setActiveDekId(scope: DEKScope, dekId: string): void {
    const key = this.scopeKey(scope);
    // LRU: delete first so re-insert moves to end
    this._lastAcquiredDekIds.delete(key);
    if (this._lastAcquiredDekIds.size >= DEKManager.MAX_ACTIVE_DEK_IDS) {
      const oldest = this._lastAcquiredDekIds.keys().next().value;
      if (oldest !== undefined) this._lastAcquiredDekIds.delete(oldest);
    }
    this._lastAcquiredDekIds.set(key, dekId);
  }

  /** Evict all _lastAcquiredDekIds entries for a given tenant. */
  private evictActiveDekIdsByTenant(tenantId: string): number {
    let evicted = 0;
    for (const key of this._lastAcquiredDekIds.keys()) {
      if (key.startsWith(tenantId + ':')) {
        this._lastAcquiredDekIds.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  constructor(resolver?: KMSResolver, options?: DEKManagerOptions) {
    this.resolver = resolver ?? new KMSResolver();
    this.log = options?.logger ?? defaultLogger;
  }

  /** Decision 4: epoch string for dedup. 12h minimum granularity. */
  private calculateEpoch(intervalHours: number): string {
    const intervalMs = Math.max(intervalHours, 12) * 60 * 60 * 1000;
    return new Date(Math.floor(Date.now() / intervalMs) * intervalMs).toISOString().slice(0, 13);
  }

  private async resolveConfig(scope: DEKScope) {
    return this.resolver.resolve(scope.tenantId, scope.projectId, scope.environment);
  }

  private cloneProviderRef(provider: IResolvedProviderRef): IResolvedProviderRef {
    return {
      providerType: provider.providerType,
      keyId: provider.keyId,
      region: provider.region,
      vaultUrl: provider.vaultUrl,
      externalEndpoint: provider.externalEndpoint,
      authMethod: provider.authMethod,
      authConfigEncrypted: null,
    };
  }

  private async getProviderForEntry(entry: IDEKEntry): Promise<KMSProvider> {
    const pool = getKMSProviderPool();
    if (entry.wrappingProvider) {
      return pool.getProvider(entry.wrappingProvider, entry.tenantId);
    }
    return pool.getLocalProvider();
  }

  private providerRefForEntry(entry: IDEKEntry): IResolvedProviderRef {
    return (
      entry.wrappingProvider ?? {
        providerType: 'local',
        keyId: entry.kekKeyId,
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      }
    );
  }

  private hasProviderDrift(entry: IDEKEntry, targetProvider: IResolvedProviderRef): boolean {
    const sourceProvider = this.providerRefForEntry(entry);
    if (sourceProvider.providerType === 'local' && targetProvider.providerType === 'local') {
      return false;
    }
    return (
      computeFingerprint(sourceProvider, entry.tenantId) !==
      computeFingerprint(targetProvider, entry.tenantId)
    );
  }

  /** Sentinel for "no DEK acquired yet" — getActiveDEKId fallback. */
  static readonly ACTIVE_DEK_ID = 'active';

  /**
   * Acquire the active DEK for a scope.
   * Creates a new one if none exists (via generateDataKey).
   * Deduplicates concurrent requests for the same scope.
   */
  async acquireDEK(scope: DEKScope, kekKeyId: string, _retryCount = 0): Promise<AcquiredDEK> {
    // Check _lastAcquiredDekIds for a warm dekId
    const lastDekId = this._lastAcquiredDekIds.get(this.scopeKey(scope));
    if (lastDekId) {
      const cachedDek = this.cache.get(lastDekId);
      if (cachedDek) {
        return { plaintext: cachedDek.plaintext, dekId: lastDekId, kekKeyId, kekKeyVersion: 1 };
      }
    }

    // Check inflight — deduplicate concurrent requests for same scope
    const inflightKey = `acquire:${this.scopeKey(scope)}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    // Guard against unbounded inflight map growth
    if (this.inflight.size >= MAX_INFLIGHT) {
      throw new Error(
        `DEKManager inflight map at capacity (${MAX_INFLIGHT}). Possible KMS backpressure.`,
      );
    }

    // Start acquire and track it
    const promise = this._doAcquireDEK(scope, kekKeyId, _retryCount).finally(() =>
      this.inflight.delete(inflightKey),
    );
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  private async _doAcquireDEK(
    scope: DEKScope,
    kekKeyId: string,
    retryCount: number,
  ): Promise<AcquiredDEK> {
    const { DEKEntry, generateDekId } = await import('../models/index.js');

    // Resolve full KMS config for this scope (includes epoch/usage settings)
    const kmsConfig = await this.resolveConfig(scope);

    // Decision 4: Epoch is for dedup only
    const epochIntervalHours = kmsConfig.dekEpochIntervalHours ?? 24;
    const maxUsageCount = kmsConfig.dekMaxUsageCount ?? 2 ** 30;
    const epoch = this.calculateEpoch(epochIntervalHours);

    // Try to load the ACTIVE DEK for this scope
    const activeEntry = (await DEKEntry.findOne({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      environment: scope.environment,
      status: 'active',
    })
      .sort({ createdAt: -1 })
      .lean()) as IDEKEntry | null;

    if (activeEntry) {
      // Check if this DEK has exceeded its usage ceiling or expired
      const overUsed =
        activeEntry.maxUsageCount > 0 && activeEntry.usageCount >= activeEntry.maxUsageCount;
      const expired = activeEntry.expiresAt && new Date(activeEntry.expiresAt) < new Date();
      const activeProvider = this.providerRefForEntry(activeEntry);
      const activeProviderFingerprint = computeFingerprint(activeProvider, scope.tenantId);
      const resolvedProviderFingerprint = computeFingerprint(kmsConfig.provider, scope.tenantId);
      const providerDrift = this.hasProviderDrift(activeEntry, kmsConfig.provider);

      if (overUsed || expired || providerDrift) {
        // Transition to decrypt_only — new DEK will be created below
        await DEKEntry.updateOne(
          { _id: activeEntry._id },
          { $set: { status: 'decrypt_only', retiredAt: new Date() } },
        );
        this.log.info('DEK auto-rotated — retiring active DEK', {
          dekId: activeEntry.dekId,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          reason: overUsed ? 'usage_ceiling' : expired ? 'expired' : 'provider_drift',
          usageCount: activeEntry.usageCount,
          maxUsageCount: activeEntry.maxUsageCount,
          expiresAt: activeEntry.expiresAt,
          sourceProvider: activeProviderFingerprint,
          targetProvider: resolvedProviderFingerprint,
          sourceProviderType: activeProvider.providerType,
          targetProviderType: kmsConfig.provider.providerType,
        });
        // Fall through to create new DEK
      } else {
        const kms = await this.getProviderForEntry(activeEntry);
        const plaintext = await kms.unwrapKey(
          activeEntry.kekKeyId,
          Buffer.from(activeEntry.wrappedDek, 'base64'),
          activeEntry.kekKeyVersion,
          activeEntry.kekKeyVersionId ?? undefined,
        );
        // Cache under the opaque dekId (Decision 3)
        this.cache.set(activeEntry.dekId, plaintext, scope.tenantId);
        // Track for sync encrypt paths
        this.setActiveDekId(scope, activeEntry.dekId);

        // Decision 6: Fire-and-forget usage count increment (non-blocking)
        DEKEntry.updateOne({ _id: activeEntry._id }, { $inc: { usageCount: 1 } }).catch(
          (err: unknown) => {
            this.log.warn('Failed to update DEK usage count', {
              dekId: activeEntry.dekId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );

        return {
          plaintext,
          dekId: activeEntry.dekId,
          kekKeyId: activeEntry.kekKeyId,
          kekKeyVersion: activeEntry.kekKeyVersion,
        };
      }
    }

    // No active DEK — generate a new one (reuse already-resolved config)
    // Use the resolved config's keyId — not the caller's kekKeyId — so that
    // scoped KMS overrides (project/environment level) take effect.
    const resolvedKeyId = kmsConfig.keyId || kekKeyId;
    const pool = getKMSProviderPool();
    this.log.debug('DEK generation starting', {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      environment: scope.environment,
      resolvedKeyId,
      providerType: kmsConfig.provider.providerType,
      providerFingerprint: computeFingerprint(kmsConfig.provider, scope.tenantId),
    });
    const kms = await pool.getProvider(kmsConfig.provider, scope.tenantId);
    const { plaintext, ciphertext, keyVersion, keyVersionId } =
      await kms.generateDataKey(resolvedKeyId);

    // Decision 3: opaque dekId
    const dekId = generateDekId();

    // Decision 5: Precompute expiresAt as epoch boundary + interval
    const intervalMs = Math.max(epochIntervalHours, 12) * 60 * 60 * 1000;
    const epochNum = Math.floor(Date.now() / intervalMs);
    const expiresAt = new Date((epochNum + 1) * intervalMs);

    try {
      await DEKEntry.create({
        dekId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        environment: scope.environment,
        epoch,
        wrappedDek: ciphertext.toString('base64'),
        kekKeyId: resolvedKeyId,
        kekKeyVersion: keyVersion ?? 1,
        kekKeyVersionId: keyVersionId ?? null,
        wrappingProvider: this.cloneProviderRef(kmsConfig.provider),
        wrappingSourceConfigVersion: kmsConfig.sourceConfigVersion,
        status: 'active',
        usageCount: 0,
        maxUsageCount: maxUsageCount,
        expiresAt,
      });
    } catch (err: any) {
      // Always zero plaintext on any create failure — key material must not leak
      plaintext.fill(0);

      if (err?.code !== 11000) {
        throw err;
      }

      // E11000 duplicate key — determine which index caused it.
      // Require the full composite key pattern for epoch-slot recovery.
      const kp = err.keyPattern;
      const isEpochIndex =
        (kp?.tenantId != null &&
          kp?.projectId != null &&
          kp?.environment != null &&
          kp?.epoch != null) ||
        err.message?.includes('tenantId_1_projectId_1_environment_1_epoch_1');
      const isDekIdIndex = kp?.dekId != null || err.message?.includes('dekId_1');

      if (isDekIdIndex) {
        // Extremely unlikely: dekId collision (nanoid-like). Retry with a fresh dekId.
        this.log.warn('DEK create failed — dekId collision, retrying', {
          dekId,
          tenantId: scope.tenantId,
          retryCount,
        });
        if (retryCount >= MAX_ACQUIRE_RETRIES) {
          throw new Error(
            `DEKManager: exceeded max retries (${MAX_ACQUIRE_RETRIES}) for scope ${this.scopeKey(scope)} after dekId collision`,
          );
        }
        const delay = retryDelayMs(retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._doAcquireDEK(scope, kekKeyId, retryCount + 1);
      }

      if (!isEpochIndex) {
        // Unknown index caused the E11000 — do not run epoch-slot recovery.
        // Log and retry without mutating existing DEKs.
        this.log.warn('DEK create E11000 from unrecognized index — retrying without mutation', {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          epoch,
          retryCount,
          keyPattern: err.keyPattern,
          errMessage: err.message?.slice(0, 200),
        });
        if (retryCount >= MAX_ACQUIRE_RETRIES) {
          throw new Error(
            `DEKManager: exceeded max retries (${MAX_ACQUIRE_RETRIES}) for scope ${this.scopeKey(scope)} after duplicate key errors`,
          );
        }
        const delay = retryDelayMs(retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._doAcquireDEK(scope, kekKeyId, retryCount + 1);
      }

      if (retryCount >= MAX_ACQUIRE_RETRIES) {
        this.log.warn('DEK acquire failed — exceeded max retries on epoch E11000', {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          epoch,
          retryCount,
          resolvedKeyId,
          providerType: kmsConfig.provider.providerType,
        });
        throw new Error(
          `DEKManager: exceeded max retries (${MAX_ACQUIRE_RETRIES}) for scope ${this.scopeKey(scope)} after duplicate key errors`,
        );
      }

      // Epoch index collision confirmed. Check if another pod won the race
      // (active DEK exists) or if a retired DEK occupies the epoch slot.
      // Use read from primary to avoid stale-secondary false negatives.
      const winner = (await DEKEntry.findOne({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        environment: scope.environment,
        status: 'active',
      })
        .sort({ createdAt: -1 })
        .read('primary')
        .lean()) as IDEKEntry | null;

      if (winner) {
        // Another pod won the race — retry to use the winner's DEK
        this.log.info('DEK race: another pod won — retrying to use winner', {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          winnerDekId: winner.dekId,
          retryCount,
        });
        const delay = retryDelayMs(retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._doAcquireDEK(scope, kekKeyId, retryCount + 1);
      }

      // No active winner on primary — epoch slot is occupied by a retired DEK
      // (e.g. provider drift rotation within the same epoch window).
      // Free the epoch slot by suffixing the retired entry's epoch, then retry
      // the full acquire flow (regenerates key material, rechecks for winners).
      const retiredBlocker = await DEKEntry.findOneAndUpdate(
        {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          epoch,
          status: { $ne: 'active' },
        },
        [{ $set: { epoch: { $concat: [epoch, ':retired:', { $toString: '$_id' }] } } }],
      );

      if (retiredBlocker) {
        this.log.info('DEK epoch slot freed from retired entry — retrying acquire', {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          retiredDekId: (retiredBlocker as any)?.dekId ?? (retiredBlocker as any)?._id,
          retiredStatus: (retiredBlocker as any)?.status,
          epoch,
          retryCount,
          targetProviderType: kmsConfig.provider.providerType,
        });
      } else {
        this.log.warn('DEK E11000 but no blocker found — possible replication lag', {
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          environment: scope.environment,
          epoch,
          retryCount,
        });
      }

      const delay = retryDelayMs(retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this._doAcquireDEK(scope, kekKeyId, retryCount + 1);
    }

    // Cache under opaque dekId (Decision 3)
    this.cache.set(dekId, plaintext, scope.tenantId);
    // Track for sync encrypt paths
    this.setActiveDekId(scope, dekId);

    this.log.info('DEK created', {
      dekId,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      environment: scope.environment,
      epoch,
      kekKeyId: resolvedKeyId,
      providerType: kmsConfig.provider.providerType,
      providerFingerprint: computeFingerprint(kmsConfig.provider, scope.tenantId),
      sourceConfigVersion: kmsConfig.sourceConfigVersion,
    });

    return {
      plaintext,
      dekId,
      kekKeyId: resolvedKeyId,
      kekKeyVersion: keyVersion ?? 1,
    };
  }

  /**
   * Unwrap a single DEK by its opaque dekId (for decryption).
   *
   * tenantId is required — enforces tenant isolation at both layers:
   * - DB query: `{ dekId, tenantId, status }` — cross-tenant rows are invisible
   * - Cache: hit rejected if stored tenantId doesn't match
   * This prevents cross-tenant decryption even though dekId is globally unique
   * (96-bit random, but the API contract must not rely solely on unguessability).
   */
  async unwrapDEK(dekId: string, tenantId: string): Promise<Buffer> {
    // Cache hit with tenant isolation check
    const cached = this.cache.get(dekId, tenantId);
    if (cached) return cached.plaintext;

    const { DEKEntry } = await import('../models/index.js');
    const filter: Record<string, unknown> = {
      dekId,
      tenantId,
      status: { $in: ['active', 'decrypt_only'] },
    };
    const entry = (await DEKEntry.findOne(filter).lean()) as IDEKEntry | null;

    if (!entry) {
      throw new Error(`DEK not found for dekId ${dekId}`);
    }

    // Resolve KMS provider from the entry's own scope
    const kms = await this.getProviderForEntry(entry);
    const plaintext = await kms.unwrapKey(
      entry.kekKeyId,
      Buffer.from(entry.wrappedDek, 'base64'),
      entry.kekKeyVersion,
      entry.kekKeyVersionId ?? undefined,
    );

    this.cache.set(dekId, plaintext, entry.tenantId);
    return plaintext;
  }

  /**
   * Batch unwrap DEKs for multiple identifiers (for batch decryption).
   * One KMS call per unique DEK ID.
   * tenantId is required — enforces tenant isolation on each unwrap.
   */
  async batchUnwrapDEKs(dekIds: string[], tenantId: string): Promise<Map<string, Buffer>> {
    const uniqueIds = [...new Set(dekIds)];
    const results = new Map<string, Buffer>();

    await Promise.all(
      uniqueIds.map(async (dekId) => {
        try {
          const plaintext = await this.unwrapDEK(dekId, tenantId);
          results.set(dekId, plaintext);
        } catch (err) {
          this.log.warn('Failed to unwrap DEK', {
            dekId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    return results;
  }

  /**
   * Force-rotate active DEKs for a scope (or all for a tenant).
   * Marks them as decrypt_only and evicts cache.
   */
  async forceRotateDEK(scope: DEKScope): Promise<number> {
    const { DEKEntry } = await import('../models/index.js');

    // Build filter — always includes tenantId, optionally scoped further
    const filter: Record<string, unknown> = {
      tenantId: scope.tenantId,
      status: 'active',
    };
    if (scope.projectId && scope.projectId !== '_tenant') {
      filter.projectId = scope.projectId;
    }
    if (scope.environment && scope.environment !== '_tenant') {
      filter.environment = scope.environment;
    }

    const result = await DEKEntry.updateMany(filter, {
      $set: { status: 'decrypt_only', retiredAt: new Date() },
    });

    // Evict all cached DEKs for this tenant — next encrypt will acquire fresh key
    const evicted = this.cache.evictByTenant(scope.tenantId);
    // Reset cached active DEK IDs — for tenant-wide rotation, evict ALL entries
    // for this tenant (not just the specific scope sentinel).
    const isTenantWide = scope.projectId === '_tenant' || scope.environment === '_tenant';
    if (isTenantWide) {
      this.evictActiveDekIdsByTenant(scope.tenantId);
    } else {
      this._lastAcquiredDekIds.delete(this.scopeKey(scope));
    }

    this.log.info('Force-rotated DEKs', {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      environment: scope.environment,
      deksRotated: result.modifiedCount,
      cacheEvicted: evicted,
    });

    // Publish cross-pod invalidation (fire-and-forget — other pods' L1 TTL
    // provides eventual consistency if transport is unavailable)
    this.publishInvalidation(scope.tenantId).catch((err: unknown) => {
      this.log.warn('Failed to publish DEK invalidation after rotation', {
        tenantId: scope.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return result.modifiedCount;
  }

  /**
   * Sync cache lookup — returns cached DEK plaintext or null on miss.
   * When tenantId is provided, enforces tenant isolation on cache hit.
   */
  getCachedDEK(dekId: string, tenantId?: string): Buffer | null {
    const cached = this.cache.get(dekId, tenantId);
    return cached ? cached.plaintext : null;
  }

  /**
   * Get the actual active DEK identifier (opaque dekId) for sync encrypt paths.
   * Returns the ACTIVE_DEK_ID sentinel if no DEK has been acquired yet.
   */
  getActiveDEKId(scope?: DEKScope): string {
    if (scope) {
      return this._lastAcquiredDekIds.get(this.scopeKey(scope)) ?? DEKManager.ACTIVE_DEK_ID;
    }
    return DEKManager.ACTIVE_DEK_ID;
  }

  /** Clear DEK cache (for shutdown or testing) */
  clearCache(): void {
    this.cache.clear();
    this._lastAcquiredDekIds.clear();
  }

  // ===========================================================================
  // CROSS-POD CACHE INVALIDATION (Redis pub/sub)
  // ===========================================================================

  /**
   * Set optional cache invalidation transport (e.g. Redis pub/sub).
   * Decouples DEKManager from any specific transport — the app layer
   * (e.g. runtime server.ts) injects the concrete implementation.
   */
  setInvalidationTransport(transport: InvalidationTransport): void {
    this.invalidationTransport = transport;
  }

  /**
   * Publish DEK cache invalidation event for a tenant.
   * Called after forceRotateDEK to notify other pods.
   * Degrades gracefully if transport is unavailable — L1 TTL provides eventual consistency.
   */
  async publishInvalidation(tenantId: string): Promise<void> {
    if (!this.invalidationTransport) return;
    try {
      await this.invalidationTransport.publish(DEKManager.INVALIDATION_CHANNEL, tenantId);
    } catch (err) {
      this.log.warn('DEK cache invalidation publish failed (TTL will expire naturally)', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Subscribe to DEK cache invalidation events from other pods.
   * On receiving a message, evicts all cached DEKs and active DEK IDs for the tenant.
   */
  async subscribeInvalidation(): Promise<boolean> {
    if (!this.invalidationTransport) return false;
    try {
      await this.invalidationTransport.subscribe(
        DEKManager.INVALIDATION_CHANNEL,
        (tenantId: string) => {
          const cacheEvicted = this.cache.evictByTenant(tenantId);
          const activeEvicted = this.evictActiveDekIdsByTenant(tenantId);
          this.log.debug('DEK cache evicted via pub/sub', {
            tenantId,
            cacheEvicted,
            activeEvicted,
          });
        },
      );
      return true;
    } catch (err) {
      this.log.warn('DEK cache invalidation subscription failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Shutdown the invalidation transport (for graceful shutdown). */
  async shutdownTransport(): Promise<void> {
    if (this.invalidationTransport) {
      try {
        await this.invalidationTransport.shutdown();
      } catch {
        // Best-effort cleanup — intentional empty catch for shutdown
      }
      this.invalidationTransport = null;
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}
