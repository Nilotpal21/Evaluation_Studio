/**
 * KMS Resolver
 *
 * Resolves KMS configuration for a given tenant+project+environment scope.
 *
 * READ PATH (hot, every encrypt/decrypt):
 *   L1 cache → MaterializedKMSConfig.findOne() → TenantKMSConfig fallback → platform default
 *
 * Redis pub/sub cache invalidation is optional — inject via
 * `setInvalidationTransport()` from the app layer (e.g. runtime).
 */

import type {
  ITenantKMSConfig,
  IMaterializedKMSConfig,
  IResolvedProviderRef,
} from '../models/index.js';
import { getCurrentTenantContext } from '../mongo/index.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ResolvedKMSConfig {
  provider: IResolvedProviderRef;
  keyId: string;
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  failurePolicy: string;
  sourceConfigVersion: number;
}

export interface KMSResolverOptions {
  /** L1 cache max entries */
  cacheMaxEntries?: number;
  /** L1 cache TTL in milliseconds */
  cacheTtlMs?: number;
  /** Optional logger (falls back to stderr) */
  logger?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Optional app-layer ALS bridge for tenant-scoped internal reads. */
  tenantContextRunner?: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Transport for cache invalidation pub/sub.
 * Injected by the app layer (e.g. runtime wires Redis here).
 */
export interface InvalidationTransport {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  shutdown(): Promise<void>;
}

// =============================================================================
// L1 CACHE (3-dimensional key: tenantId:projectId:environment)
// =============================================================================

interface CachedConfig {
  config: ResolvedKMSConfig;
  cachedAt: number;
  /** Store tenantId for evictTenant (key is composite) */
  tenantId: string;
}

class KMSConfigCache {
  private cache = new Map<string, CachedConfig>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 500, ttlMs = 60_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  private key(tenantId: string, projectId: string, environment: string): string {
    return `${tenantId}:${projectId}:${environment}`;
  }

  get(tenantId: string, projectId: string, environment: string): ResolvedKMSConfig | null {
    const k = this.key(tenantId, projectId, environment);
    const entry = this.cache.get(k);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(k);
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.config;
  }

  set(tenantId: string, projectId: string, environment: string, config: ResolvedKMSConfig): void {
    const k = this.key(tenantId, projectId, environment);
    if (this.cache.size >= this.maxEntries && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(k, { config, cachedAt: Date.now(), tenantId });
  }

  evictTenant(tenantId: string): number {
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (entry.tenantId === tenantId) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// PLATFORM DEFAULT (from env vars or hardcoded local fallback)
// =============================================================================

function buildPlatformDefault(): ResolvedKMSConfig {
  const providerType = process.env.KMS_PROVIDER ?? 'local';

  if (providerType === 'azure-keyvault' || providerType === 'azure-managed-hsm') {
    const vaultUrl = process.env.KMS_AZURE_VAULT_URL;
    const keyName = process.env.KMS_AZURE_KEY_NAME;
    if (!vaultUrl || !keyName) {
      throw new Error(
        `KMS_PROVIDER=${providerType} requires KMS_AZURE_VAULT_URL and KMS_AZURE_KEY_NAME`,
      );
    }
    return {
      provider: {
        providerType,
        keyId: keyName,
        region: null,
        vaultUrl,
        externalEndpoint: null,
        authMethod: process.env.KMS_AZURE_CLIENT_ID ? 'service-account' : 'default-credentials',
        authConfigEncrypted: null,
      },
      keyId: keyName,
      dekEpochIntervalHours: 24,
      dekMaxUsageCount: 2 ** 30,
      failurePolicy: 'fail-closed',
      sourceConfigVersion: 0,
    };
  }

  if (providerType === 'aws-kms') {
    const region = process.env.KMS_AWS_REGION;
    const keyId = process.env.KMS_AWS_KEY_ID;
    if (!region || !keyId) {
      throw new Error('KMS_PROVIDER=aws-kms requires KMS_AWS_REGION and KMS_AWS_KEY_ID');
    }
    return {
      provider: {
        providerType: 'aws-kms',
        keyId,
        region,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: process.env.KMS_AWS_ACCESS_KEY_ID ? 'service-account' : 'default-credentials',
        authConfigEncrypted: null,
      },
      keyId,
      dekEpochIntervalHours: 24,
      dekMaxUsageCount: 2 ** 30,
      failurePolicy: 'fail-closed',
      sourceConfigVersion: 0,
    };
  }

  if (providerType === 'gcp-cloud-kms') {
    const projectId = process.env.KMS_GCP_PROJECT_ID;
    const location = process.env.KMS_GCP_LOCATION;
    const keyRing = process.env.KMS_GCP_KEY_RING;
    const keyName = process.env.KMS_GCP_KEY_NAME;
    if (!projectId || !location || !keyRing || !keyName) {
      throw new Error(
        'KMS_PROVIDER=gcp-cloud-kms requires KMS_GCP_PROJECT_ID, KMS_GCP_LOCATION, KMS_GCP_KEY_RING, KMS_GCP_KEY_NAME',
      );
    }
    return {
      provider: {
        providerType: 'gcp-cloud-kms',
        keyId: keyName,
        region: location,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: 'default-credentials',
        authConfigEncrypted: null,
      },
      keyId: keyName,
      dekEpochIntervalHours: 24,
      dekMaxUsageCount: 2 ** 30,
      failurePolicy: 'fail-closed',
      sourceConfigVersion: 0,
    };
  }

  // Default: local provider (ENCRYPTION_MASTER_KEY-derived)
  return {
    provider: {
      providerType: 'local',
      keyId: 'platform-default',
      region: null,
      vaultUrl: null,
      externalEndpoint: null,
      authMethod: null,
      authConfigEncrypted: null,
    },
    keyId: 'platform-default',
    dekEpochIntervalHours: 24,
    dekMaxUsageCount: 2 ** 30,
    failurePolicy: 'fail-closed',
    sourceConfigVersion: 0,
  };
}

let _platformDefault: ResolvedKMSConfig | null = null;

function getPlatformDefault(): ResolvedKMSConfig {
  if (!_platformDefault) {
    _platformDefault = buildPlatformDefault();
  }
  return _platformDefault;
}

// =============================================================================
// KMS RESOLVER
// =============================================================================

const INVALIDATION_CHANNEL = 'kms:config:invalidate';

const defaultLogger = {
  debug(_msg: string, _meta?: Record<string, unknown>) {},
  warn(msg: string, meta?: Record<string, unknown>) {
    process.stderr.write(`[kms-resolver] WARN: ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
  },
  info(_msg: string, _meta?: Record<string, unknown>) {},
};

export class KMSResolver {
  private cache: KMSConfigCache;
  private invalidationTransport: InvalidationTransport | null = null;
  private log: KMSResolverOptions['logger'];
  private tenantContextRunner?: KMSResolverOptions['tenantContextRunner'];

  constructor(options?: KMSResolverOptions) {
    this.cache = new KMSConfigCache(options?.cacheMaxEntries ?? 500, options?.cacheTtlMs ?? 60_000);
    this.log = options?.logger ?? defaultLogger;
    this.tenantContextRunner = options?.tenantContextRunner;
  }

  private runInTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (this.tenantContextRunner) {
      return this.tenantContextRunner(tenantId, fn);
    }
    return fn();
  }

  /**
   * READ PATH: Resolve KMS config for a tenant+project+environment scope.
   *
   * Resolution order:
   *   1. L1 in-process cache
   *   2. MaterializedKMSConfig (pre-resolved by materializer)
   *   3. TenantKMSConfig.defaultProvider (fallback for unmaterialized scopes)
   *   4. Platform default (local provider)
   */
  async resolve(
    tenantId: string,
    projectId = '_tenant',
    environment = '_shared',
  ): Promise<ResolvedKMSConfig> {
    // L1 cache hit
    const cached = this.cache.get(tenantId, projectId, environment);
    if (cached) return cached;

    let materializedLookupError: Error | null = null;
    let tenantConfigLookupError: Error | null = null;
    const ambientTenantContext = getCurrentTenantContext();

    // Try MaterializedKMSConfig first (pre-resolved by materializer)
    try {
      const { MaterializedKMSConfig } = await import('../models/index.js');
      const doc = await this.runInTenantContext(
        tenantId,
        async () =>
          (await MaterializedKMSConfig.findOne({
            tenantId,
            projectId,
            environment,
          }).lean()) as IMaterializedKMSConfig | null,
      );

      if (doc) {
        const resolved: ResolvedKMSConfig = {
          provider: doc.resolvedProvider,
          keyId: doc.resolvedKeyId,
          dekEpochIntervalHours: doc.dekEpochIntervalHours ?? 24,
          dekMaxUsageCount: doc.dekMaxUsageCount ?? 2 ** 30,
          failurePolicy: doc.failurePolicy,
          sourceConfigVersion: doc.sourceConfigVersion,
        };
        this.cache.set(tenantId, projectId, environment, resolved);
        return resolved;
      }
    } catch (err) {
      materializedLookupError = err instanceof Error ? err : new Error(String(err));
      this.log!.warn('MaterializedKMSConfig lookup failed', {
        tenantId,
        projectId,
        environment,
        error: materializedLookupError.message,
        ambientTenantId: ambientTenantContext?.tenantId,
        ambientIsSuperAdmin: ambientTenantContext?.isSuperAdmin ?? false,
      });
    }

    // Fallback: Walk the 5-level TenantKMSConfig hierarchy directly
    // (for scopes without materialized docs — e.g. no active deployments)
    try {
      const { TenantKMSConfig } = await import('../models/index.js');
      const doc = await this.runInTenantContext(
        tenantId,
        async () =>
          (await TenantKMSConfig.findOne({
            tenantId,
          }).lean()) as ITenantKMSConfig | null,
      );

      if (doc) {
        const provider = this.resolveProviderFromConfig(doc, projectId, environment);
        if (provider) {
          const resolved: ResolvedKMSConfig = {
            provider: {
              providerType: provider.providerType,
              keyId: provider.keyId,
              region: provider.region,
              vaultUrl: provider.vaultUrl,
              externalEndpoint: provider.externalEndpoint,
              authMethod: provider.authMethod,
              authConfigEncrypted: provider.authConfigEncrypted,
            },
            keyId: provider.keyId,
            dekEpochIntervalHours: doc.dekEpochIntervalHours ?? 24,
            dekMaxUsageCount: doc.dekMaxUsageCount ?? 2 ** 30,
            failurePolicy: doc.failurePolicy ?? 'fail-closed',
            sourceConfigVersion: doc._v,
          };
          this.cache.set(tenantId, projectId, environment, resolved);
          return resolved;
        }
      }
    } catch (err) {
      tenantConfigLookupError = err instanceof Error ? err : new Error(String(err));
      this.log!.warn('TenantKMSConfig lookup failed', {
        tenantId,
        error: tenantConfigLookupError.message,
        ambientTenantId: ambientTenantContext?.tenantId,
        ambientIsSuperAdmin: ambientTenantContext?.isSuperAdmin ?? false,
      });
    }

    if (materializedLookupError || tenantConfigLookupError) {
      const errorParts: string[] = [];
      if (materializedLookupError) {
        errorParts.push(`MaterializedKMSConfig lookup failed: ${materializedLookupError.message}`);
      }
      if (tenantConfigLookupError) {
        errorParts.push(`TenantKMSConfig lookup failed: ${tenantConfigLookupError.message}`);
      }
      throw new Error(
        `KMS resolution failed for tenant=${tenantId}, project=${projectId}, environment=${environment}. ` +
          `${errorParts.join('; ')}`,
      );
    }

    // Platform default — cache it to avoid repeated env var reads
    const platformDefault = getPlatformDefault();
    this.cache.set(tenantId, projectId, environment, platformDefault);
    return platformDefault;
  }

  /**
   * Evict all cached configs for a tenant.
   * Called after config change or pub/sub notification.
   */
  evictTenant(tenantId: string): void {
    const count = this.cache.evictTenant(tenantId);
    if (count > 0) {
      this.log!.debug('Evicted L1 KMS cache', { tenantId, entriesEvicted: count });
    }
  }

  /** Clear entire L1 cache (for testing or startup) */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Set optional cache invalidation transport (e.g. Redis pub/sub).
   * This decouples the resolver from any specific transport.
   */
  setInvalidationTransport(transport: InvalidationTransport): void {
    this.invalidationTransport = transport;
  }

  /** Publish cache invalidation event via transport */
  async publishInvalidation(tenantId: string): Promise<void> {
    if (!this.invalidationTransport) return;
    try {
      await this.invalidationTransport.publish(INVALIDATION_CHANNEL, tenantId);
    } catch {
      // Transport not available — L1 TTL will expire naturally
    }
  }

  /** Subscribe to cache invalidation events via transport */
  async subscribeInvalidation(): Promise<boolean> {
    if (!this.invalidationTransport) return false;
    try {
      await this.invalidationTransport.subscribe(INVALIDATION_CHANNEL, (tenantId: string) => {
        this.evictTenant(tenantId);
        this.log!.debug('L1 KMS cache evicted via pub/sub', { tenantId });
      });
      return true;
    } catch {
      this.log!.warn('KMS cache invalidation subscription failed');
      return false;
    }
  }

  /** Shutdown the resolver (close transport, clear cache) */
  async shutdown(): Promise<void> {
    if (this.invalidationTransport) {
      try {
        await this.invalidationTransport.shutdown();
      } catch {
        // Best-effort cleanup
      }
      this.invalidationTransport = null;
    }
    this.cache.clear();
  }

  /**
   * Walk the 5-level KMS config inheritance chain within a TenantKMSConfig:
   *   1. projects[projectId].environments[environment]
   *   2. projects[projectId].defaultProvider
   *   3. environments[environment] (tenant-level)
   *   4. defaultProvider (tenant-level)
   *   5. null (caller falls through to platform default)
   */
  private resolveProviderFromConfig(
    config: ITenantKMSConfig,
    projectId: string,
    environment: string,
  ): IResolvedProviderRef | null {
    // Level 1 + 2: Project-specific overrides
    const projectOverride = config.projects?.find((p) => p.projectId === projectId);
    if (projectOverride) {
      // Level 1: Project + environment specific
      const envOverride = projectOverride.environments?.find((e) => e.environment === environment);
      if (envOverride?.provider) {
        return envOverride.provider as IResolvedProviderRef;
      }
      // Level 2: Project default provider
      if (projectOverride.defaultProvider) {
        return projectOverride.defaultProvider as IResolvedProviderRef;
      }
    }

    // Level 3: Tenant environment override
    const tenantEnvOverride = config.environments?.find((e) => e.environment === environment);
    if (tenantEnvOverride?.provider) {
      return tenantEnvOverride.provider as IResolvedProviderRef;
    }

    // Level 4: Tenant default provider
    if (config.defaultProvider) {
      return config.defaultProvider as IResolvedProviderRef;
    }

    // Level 5: null — caller uses platform default
    return null;
  }

  /** Get platform default config (for testing) */
  static getPlatformDefault(): ResolvedKMSConfig {
    return { ...getPlatformDefault() };
  }

  /** Reset cached platform default (for testing) */
  static _resetPlatformDefaultForTesting(): void {
    _platformDefault = null;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}
