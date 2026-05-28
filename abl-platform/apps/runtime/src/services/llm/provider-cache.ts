/**
 * Provider Cache — process-level singleton with TTL, max-size, and tenant-scoped eviction.
 *
 * Extracted from session-llm-client.ts so the cache logic can be tested
 * without pulling in the heavy transitive dependency chain (model-resolution,
 * database, encryption). The cache stores Vercel AI SDK LanguageModel instances
 * keyed by provider+credential hash.
 *
 * Kept dependency-free: no imports from config, database, or compiler packages.
 * Runtime wires in config overrides via `configureProviderCache()`.
 */

import { createHash } from 'node:crypto';
import type { LanguageModel } from 'ai';

// ─── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_PROVIDER_CACHE_MAX = 500;
const DEFAULT_PROVIDER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_KEY_DIGEST_LENGTH = 16;
const CACHE_BLOCKED_CUSTOM_HEADER_NAMES = new Set(['authorization', 'x-api-key']);

let _providerCacheMax = DEFAULT_PROVIDER_CACHE_MAX;
let _providerCacheTtlMs = DEFAULT_PROVIDER_CACHE_TTL_MS;

/** Override cache limits at runtime (called from session-llm-client after config loads). */
export function configureProviderCache(max: number, ttlMs: number): void {
  _providerCacheMax = max;
  _providerCacheTtlMs = ttlMs;
}

// ─── Cache Storage ─────────────────────────────────────────────────────

/**
 * Module-level provider cache shared across all SessionLLMClient instances.
 * Keyed by `${providerType}:${apiKeyHash}:${baseUrl}` — so sessions using
 * the same credentials reuse the same provider instance, avoiding thousands
 * of duplicates at scale.
 *
 * Pod-safe: each pod maintains its own cache. Providers are stateless HTTP
 * client wrappers — no cross-pod coordination needed.
 */
const sharedProviderCache: Map<string, { provider: LanguageModel; createdAt: number }> = new Map();

/**
 * Reverse index: tenantId → Set of cache keys belonging to that tenant.
 * Enables tenant-scoped cache eviction without scanning the entire map.
 * A cache key may appear in multiple tenant sets if two tenants share the
 * same API key/provider — eviction for one tenant removes it for both,
 * which is the safe (over-evict) approach.
 */
const tenantCacheKeys = new Map<string, Set<string>>();

// ─── Public API ────────────────────────────────────────────────────────

export function getCachedProvider(key: string): LanguageModel | undefined {
  const entry = sharedProviderCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > _providerCacheTtlMs) {
    sharedProviderCache.delete(key);
    return undefined;
  }
  return entry.provider;
}

/** @internal Exported for testing only — do not use outside of tests. */
export function setCachedProvider(key: string, provider: LanguageModel, tenantId?: string): void {
  // Evict oldest if at capacity
  if (sharedProviderCache.size >= _providerCacheMax) {
    const oldest = sharedProviderCache.keys().next().value;
    if (oldest) sharedProviderCache.delete(oldest);
  }
  sharedProviderCache.set(key, { provider, createdAt: Date.now() });

  // Track which tenant owns this cache key for scoped invalidation
  if (tenantId) {
    let keys = tenantCacheKeys.get(tenantId);
    if (!keys) {
      keys = new Set();
      tenantCacheKeys.set(tenantId, keys);
    }
    keys.add(key);
  }
}

/**
 * Clear cached LLM providers. When tenantId is provided, only evicts
 * cache entries belonging to that tenant. Falls back to full clear
 * when no tenantId is specified (e.g., credential rotation).
 */
export function clearProviderCache(tenantId?: string): void {
  if (tenantId) {
    const keys = tenantCacheKeys.get(tenantId);
    if (keys) {
      for (const key of keys) {
        sharedProviderCache.delete(key);
      }
      tenantCacheKeys.delete(tenantId);
    }
    return;
  }
  sharedProviderCache.clear();
  tenantCacheKeys.clear();
}

function digestCacheValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return createHash('sha256').update(value).digest('hex').slice(0, CACHE_KEY_DIGEST_LENGTH);
}

function digestCustomHeaders(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const normalizedEntries = Object.entries(value)
    .filter(([key, rawValue]) => {
      const normalizedKey = key.toLowerCase();
      return typeof rawValue === 'string' && !CACHE_BLOCKED_CUSTOM_HEADER_NAMES.has(normalizedKey);
    })
    .sort(([left], [right]) => left.localeCompare(right));

  if (normalizedEntries.length === 0) {
    return '';
  }

  return createHash('sha256')
    .update(JSON.stringify(normalizedEntries))
    .digest('hex')
    .slice(0, CACHE_KEY_DIGEST_LENGTH);
}

/**
 * Build a deterministic cache key for a provider instance.
 * Pure function — no side effects, no I/O.
 *
 * @param apiKeyHash - SHA-256 hash prefix of the API key (caller's responsibility to hash)
 *
 * KEY FORMAT (must remain stable across deploys — process-local cache):
 *   `${providerType}:${apiKeyHash}:${effectiveUrl}:${modelId}:ac=${rn}:${av}[:${region}:${amb}]`
 *   - Azure fields (resourceName, apiVersion) always present when authConfig exists
 *   - Bedrock fields include every provider-routing option that changes the SDK instance
 *   - Anthropic Messages fields are appended only for explicit Anthropic Messages providers
 *   - This ensures exact key identity for existing Azure entries after deployment
 */
export function buildProviderCacheKey(
  providerType: string,
  apiKeyHash: string,
  effectiveUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): string {
  if (!authConfig) {
    return `${providerType}:${apiKeyHash}:${effectiveUrl || ''}:${modelId}`;
  }
  const rn = String(authConfig.resourceName || '');
  const av = String(authConfig.apiVersion || '');
  const region = String(authConfig.region || '');
  const amb = authConfig.useAmbientCredentials ? 'true' : '';
  const apiFormat = String(authConfig.apiFormat || '');
  const authType = String(authConfig.authType || '');
  const anthropicVersion = String(authConfig.anthropicVersion || '');
  // Base authSuffix — identical to the pre-existing inline formula for Azure
  let authSuffix = `:ac=${rn}:${av}`;
  const roleArn = String(authConfig.roleArn || '');
  const stsEp = String(authConfig.stsEndpoint || '');
  const bkEp = String(authConfig.bedrockEndpoint || '');
  const resourceArn = String(authConfig.resourceArn || '');
  const headerDigest = digestCustomHeaders(authConfig.customHeaders);
  const hasBedrockRouting =
    region || amb || roleArn || stsEp || bkEp || resourceArn || headerDigest;

  // Append Bedrock-specific fields only when at least one is non-empty.
  // This preserves exact key identity for existing Azure cache entries.
  if (hasBedrockRouting) {
    authSuffix += `:${region}:${amb}`;
    if (roleArn || stsEp || bkEp || resourceArn || headerDigest) {
      authSuffix += `:br=${digestCacheValue(roleArn)}:${digestCacheValue(stsEp)}:${digestCacheValue(bkEp)}:${digestCacheValue(resourceArn)}:${headerDigest}`;
    }
  }
  if (providerType === 'microsoft_foundry_anthropic' || apiFormat === 'anthropic_messages') {
    authSuffix += `:am=${apiFormat}:${authType}:${anthropicVersion}`;
  }
  return `${providerType}:${apiKeyHash}:${effectiveUrl || ''}:${modelId}${authSuffix}`;
}
