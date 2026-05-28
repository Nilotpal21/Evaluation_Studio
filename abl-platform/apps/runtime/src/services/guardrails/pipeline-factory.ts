/**
 * Guardrail Pipeline Factory
 *
 * Provides a centralized factory for creating GuardrailPipelineImpl instances
 * with a shared provider registry. Ensures:
 * - Built-in PII provider is auto-registered
 * - Custom providers can be registered at startup
 * - Tier 3 LLM evaluation is wired when a session has an LLM client
 * - Provider registry is a lazy singleton (created once, shared across pods)
 */

import {
  GuardrailPipelineImpl,
  GuardrailProviderRegistry,
  CustomHTTPProvider,
  OpenAIModerationProvider,
} from '@abl/compiler';
import type {
  LLMEvalFunction,
  GuardrailModelProvider,
  GuardrailAction,
  PipelinePolicy,
  Guardrail,
  GuardrailCachePort,
  CostCheckerPort,
  WebhookPort,
  ProviderRuntimeConfig,
} from '@abl/compiler';
import { createLogger, type PIIRecognizerRegistry } from '@abl/compiler/platform';
import { AppError, ErrorCodes } from '@agent-platform/shared';
import { resolveAuthProfileCredentials } from '../auth-profile-resolver.js';
import { GuardrailPolicyResolver } from './policy-resolver.js';
import type { PolicyData, ResolvedGuardrailPolicy, StreamingSettings } from './policy-resolver.js';
import { GuardrailCache } from './cache.js';
import { GuardrailCostTracker } from './cost-tracker.js';
import { CacheAdapter, CostCheckerAdapter, WebhookAdapter } from './port-adapters.js';
import { GuardrailWebhookDelivery } from './webhook.js';
import { getRedisClient } from '../redis/redis-client.js';
import { isDatabaseReady } from '../../db/index.js';

import type { SessionLLMClient } from '../llm/session-llm-client.js';
import type { CostBudget } from './cost-tracker.js';

const log = createLogger('guardrail-pipeline-factory');

// ---------------------------------------------------------------------------
// Lazy singletons for port adapter backing services
// ---------------------------------------------------------------------------

/** Lazy singleton GuardrailCache — created on first use, shared across calls */
let sharedGuardrailCache: GuardrailCache | null = null;

/** Lazy singleton GuardrailCostTracker — created on first use, shared across calls */
let sharedCostTracker: GuardrailCostTracker | null = null;

function getOrCreateGuardrailCache(): GuardrailCache | null {
  if (sharedGuardrailCache) return sharedGuardrailCache;
  const redis = getRedisClient();
  if (!redis) return null;
  // GuardrailCache uses a structural RedisLike interface for test injection;
  // ioredis Redis/Cluster satisfy it at runtime but TS overload variance
  // requires the cast.
  sharedGuardrailCache = new GuardrailCache(
    redis as unknown as ConstructorParameters<typeof GuardrailCache>[0],
  );
  return sharedGuardrailCache;
}

function getOrCreateCostTracker(): GuardrailCostTracker | null {
  if (sharedCostTracker) return sharedCostTracker;
  const redis = getRedisClient();
  if (!redis) return null;
  sharedCostTracker = new GuardrailCostTracker(
    redis as unknown as ConstructorParameters<typeof GuardrailCostTracker>[0],
  );
  return sharedCostTracker;
}

/** Cache of tenant IDs whose providers have been loaded, with timestamps for TTL. */
const tenantProviderLoadCache = new Map<string, number>();

/** In-flight provider load promises for deduplication */
const tenantProviderLoadInFlight = new Map<string, Promise<void>>();

/** TTL for tenant provider cache: 5 minutes */
const TENANT_PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

/** Max entries in the tenant provider cache to prevent unbounded growth */
const TENANT_PROVIDER_CACHE_MAX_SIZE = 500;

/** Timeout for provider load to prevent stuck DB queries from freezing loading */
const PROVIDER_LOAD_TIMEOUT_MS = 10_000;

/** Config fingerprints for detecting provider config changes (keyed by "tenantId:providerName") */
const providerConfigFingerprints = new Map<string, string>();

/** Max entries in the fingerprint cache to prevent unbounded growth */
const MAX_FINGERPRINT_ENTRIES = 2000;

/** Per-tenant registries to ensure tenant isolation (Core Invariant #1) */
const tenantRegistries = new Map<string, GuardrailProviderRegistry>();

/** Max number of tenant registries to prevent unbounded growth */
const MAX_TENANT_REGISTRIES = 200;

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getFailModeValue(value: unknown): 'open' | 'closed' | undefined {
  return value === 'open' || value === 'closed' ? value : undefined;
}

function getRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function runtimeConfigFromProviderConfig(cfg: Record<string, unknown>): ProviderRuntimeConfig {
  const circuitBreaker = cfg.circuitBreaker as Record<string, unknown> | undefined;
  const retry = cfg.retry as Record<string, unknown> | undefined;

  const runtimeConfig: ProviderRuntimeConfig = {
    defaultCategory: getStringValue(cfg.defaultCategory),
    defaultThreshold: getFiniteNumber(cfg.defaultThreshold),
    costPerEvalUsd: getFiniteNumber(cfg.costPerEvalUsd),
  };

  const failureThreshold = getFiniteNumber(circuitBreaker?.failureThreshold);
  const resetTimeoutMs = getFiniteNumber(circuitBreaker?.resetTimeoutMs);
  const failMode = getFailModeValue(circuitBreaker?.failMode);
  if (failureThreshold !== undefined || resetTimeoutMs !== undefined || failMode !== undefined) {
    runtimeConfig.circuitBreaker = {
      failureThreshold,
      resetTimeoutMs,
      failMode,
    };
  }

  const maxRetries = getFiniteNumber(retry?.maxRetries);
  const backoffBaseMs = getFiniteNumber(retry?.backoffBaseMs);
  if (maxRetries !== undefined || backoffBaseMs !== undefined) {
    runtimeConfig.retry = {
      maxRetries,
      backoffBaseMs,
    };
  }

  return runtimeConfig;
}

function providerFingerprint(cfg: Record<string, unknown>): string {
  return JSON.stringify({
    endpoint: cfg.endpoint,
    adapterType: cfg.adapterType,
    authProfileId: cfg.authProfileId,
    apiKeyCredentialId: cfg.apiKeyCredentialId,
    model: cfg.model,
    customMapping: cfg.customMapping,
    updatedAt: cfg.updatedAt,
    runtimeConfig: runtimeConfigFromProviderConfig(cfg),
  });
}

function requiresCredentialRevalidation(cfg: Record<string, unknown>): boolean {
  return Boolean(getStringValue(cfg.authProfileId));
}

export async function createGuardrailProviderFromConfig(
  cfg: Record<string, unknown>,
  tenantId: string,
): Promise<GuardrailModelProvider | null> {
  const name = getStringValue(cfg.name);
  const adapterType = getStringValue(cfg.adapterType);
  const endpoint = getStringValue(cfg.endpoint);
  const authProfileId = getStringValue(cfg.authProfileId);
  const apiKeyCredentialId = getStringValue(cfg.apiKeyCredentialId);
  const circuitBreaker = getRecordValue(cfg.circuitBreaker);

  if (!name || !adapterType) {
    log.warn('Skipping provider with missing identity fields', {
      tenantId,
      provider: name,
      adapterType,
    });
    return null;
  }

  let resolvedApiKey: string | undefined;
  if (authProfileId) {
    const profile = await resolveAuthProfileCredentials(authProfileId, tenantId);
    if (!profile) {
      throw new AppError(
        `Auth profile ${authProfileId} not found or expired — cannot configure guardrail provider '${name}'`,
        { ...ErrorCodes.NOT_FOUND },
      );
    }
    const secrets = profile.secrets as Record<string, unknown>;
    resolvedApiKey = getStringValue(secrets.apiKey) ?? getStringValue(secrets.accessToken);
  }

  // Preserve the legacy skip behavior for providers that reference credentials
  // the runtime cannot resolve yet.
  if (apiKeyCredentialId && !endpoint && !resolvedApiKey) {
    log.warn('Skipping provider with unresolved apiKeyCredentialId', {
      tenantId,
      provider: name,
      adapterType,
    });
    return null;
  }

  if (!endpoint) {
    log.warn('Skipping provider with missing endpoint', {
      tenantId,
      provider: name,
      adapterType,
    });
    return null;
  }

  switch (adapterType) {
    case 'custom_webhook':
    case 'custom_llm':
    case 'custom_http': {
      const customMapping = getRecordValue(cfg.customMapping);
      return new CustomHTTPProvider({
        name,
        url: endpoint,
        bodyTemplate: getStringValue(customMapping?.requestTemplate) ?? '{"text": "{{content}}"}',
        scorePath: getStringValue(customMapping?.responseScorePath) ?? 'score',
        labelPath: getStringValue(customMapping?.responseLabelPath),
        explanationPath: getStringValue(customMapping?.responseExplanationPath),
        costPerEvalUsd: getFiniteNumber(cfg.costPerEvalUsd) ?? 0,
        failMode: getFailModeValue(circuitBreaker?.failMode),
      });
    }
    case 'openai_moderation': {
      if (resolvedApiKey) {
        return new OpenAIModerationProvider({
          name,
          apiKey: resolvedApiKey,
          endpoint,
          model: getStringValue(cfg.model),
          failMode: getFailModeValue(circuitBreaker?.failMode),
        });
      }
      if (!apiKeyCredentialId) {
        log.warn('Skipping openai_moderation provider without API key', {
          tenantId,
          provider: name,
        });
        return null;
      }
      log.info('Skipping openai_moderation provider (credential resolution pending)', {
        tenantId,
        provider: name,
      });
      return null;
    }
    default:
      log.warn('Unknown guardrail adapter type, skipping', {
        tenantId,
        provider: name,
        adapterType,
      });
      return null;
  }
}

/**
 * Get or create a tenant-scoped provider registry.
 * Each tenant gets its own registry to prevent cross-tenant provider leakage.
 */
function getOrCreateTenantRegistry(tenantId: string): GuardrailProviderRegistry {
  let registry = tenantRegistries.get(tenantId);
  if (registry) {
    // Refresh insertion order for LRU
    tenantRegistries.delete(tenantId);
    tenantRegistries.set(tenantId, registry);
    return registry;
  }
  if (!registry) {
    // Evict oldest if at capacity
    if (tenantRegistries.size >= MAX_TENANT_REGISTRIES) {
      const oldest = tenantRegistries.keys().next().value;
      if (oldest !== undefined) {
        tenantRegistries.delete(oldest);
        tenantProviderLoadCache.delete(oldest); // keep caches in sync
      }
    }
    registry = new GuardrailProviderRegistry();
    tenantRegistries.set(tenantId, registry);
    log.info('Guardrail provider registry initialized for tenant', {
      tenantId,
      providers: registry.listProviders(),
    });
  }
  return registry;
}

/**
 * Get or create the default (non-tenant) provider registry.
 * Used when no tenantId is available.
 */
function getOrCreateDefaultRegistry(): GuardrailProviderRegistry {
  let registry = tenantRegistries.get('__default__');
  if (!registry) {
    registry = new GuardrailProviderRegistry();
    tenantRegistries.set('__default__', registry);
    log.info('Default guardrail provider registry initialized', {
      providers: registry.listProviders(),
    });
  }
  return registry;
}

/**
 * Load active guardrail provider configs from DB for a tenant and register
 * them in the shared provider registry. Uses a 5-minute TTL cache to avoid
 * re-querying on every request.
 *
 * Providers with unresolved `apiKeyCredentialId` are skipped (credential
 * resolution is a follow-up). Unknown adapter types are logged and skipped.
 */
export async function ensureTenantProvidersLoaded(tenantId: string): Promise<void> {
  const now = Date.now();
  const lastLoaded = tenantProviderLoadCache.get(tenantId);
  if (lastLoaded && now - lastLoaded < TENANT_PROVIDER_CACHE_TTL_MS) {
    return; // still fresh
  }

  // Deduplicate concurrent loads for the same tenant
  const inFlight = tenantProviderLoadInFlight.get(tenantId);
  if (inFlight) {
    return inFlight;
  }

  const promise = Promise.race([
    doLoadTenantProviders(tenantId),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('provider load timeout')), PROVIDER_LOAD_TIMEOUT_MS),
    ),
  ])
    .catch((err) => {
      log.warn('Tenant provider load failed or timed out', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Backoff on error
      const backoffUntil = Date.now() - TENANT_PROVIDER_CACHE_TTL_MS + 30_000;
      tenantProviderLoadCache.delete(tenantId);
      tenantProviderLoadCache.set(tenantId, backoffUntil);
    })
    .finally(() => {
      tenantProviderLoadInFlight.delete(tenantId);
    });
  tenantProviderLoadInFlight.set(tenantId, promise);
  return promise;
}

async function doLoadTenantProviders(tenantId: string): Promise<void> {
  const now = Date.now();

  try {
    const { TenantGuardrailProviderConfig } = await import('@agent-platform/database/models');
    const configs = await TenantGuardrailProviderConfig.find({
      tenantId,
      isActive: true,
    }).lean();

    const registry = getOrCreateTenantRegistry(tenantId);
    const existingProviders = new Set(registry.listProviders());

    for (const cfg of configs) {
      // Compute a config fingerprint to detect endpoint and runtime-default changes.
      const fingerprint = providerFingerprint(cfg as Record<string, unknown>);
      const existingFingerprint = providerConfigFingerprints.get(`${tenantId}:${cfg.name}`);
      const mustRevalidateCredentials = requiresCredentialRevalidation(
        cfg as Record<string, unknown>,
      );

      if (existingProviders.has(cfg.name)) {
        if (existingFingerprint === fingerprint && !mustRevalidateCredentials) {
          // Config unchanged — skip re-registration
          continue;
        }
        // Config changed or credential-backed provider needs TTL revalidation.
        // Unregister before re-instantiation so revoked/expired credentials fail closed.
        registry.unregister(cfg.name);
        existingProviders.delete(cfg.name);
        log.info('Provider config changed, re-registering', {
          tenantId,
          provider: cfg.name,
          adapterType: cfg.adapterType,
        });
      }

      try {
        const provider = await createGuardrailProviderFromConfig(
          cfg as Record<string, unknown>,
          tenantId,
        );

        if (provider) {
          registry.register(provider, {
            permanent: true,
            runtimeConfig: runtimeConfigFromProviderConfig(cfg as Record<string, unknown>),
          });
          existingProviders.add(cfg.name);

          // Store fingerprint for change detection on next reload
          if (providerConfigFingerprints.size >= MAX_FINGERPRINT_ENTRIES) {
            const oldest = providerConfigFingerprints.keys().next().value;
            if (oldest !== undefined) providerConfigFingerprints.delete(oldest);
          }
          providerConfigFingerprints.set(`${tenantId}:${cfg.name}`, fingerprint);

          log.info('Registered tenant guardrail provider from DB', {
            tenantId,
            provider: cfg.name,
            adapterType: cfg.adapterType,
          });
        }
      } catch (provErr) {
        log.warn('Failed to instantiate guardrail provider from DB config', {
          tenantId,
          provider: cfg.name,
          adapterType: cfg.adapterType,
          error: provErr instanceof Error ? provErr.message : String(provErr),
        });
      }
    }

    // Evict oldest entry if cache is at capacity.
    // Map iterates in insertion order, so first key is oldest. O(1).
    if (tenantProviderLoadCache.size >= TENANT_PROVIDER_CACHE_MAX_SIZE) {
      const oldest = tenantProviderLoadCache.keys().next().value;
      if (oldest !== undefined) tenantProviderLoadCache.delete(oldest);
    }

    // Delete-then-set to keep insertion order fresh (moves to end)
    tenantProviderLoadCache.delete(tenantId);
    tenantProviderLoadCache.set(tenantId, now);
  } catch (err) {
    log.warn('Failed to load tenant guardrail providers from DB', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Set a 30-second backoff to avoid retry storm during DB outage
    const backoffUntil = Date.now() - TENANT_PROVIDER_CACHE_TTL_MS + 30_000;
    tenantProviderLoadCache.delete(tenantId);
    tenantProviderLoadCache.set(tenantId, backoffUntil);
  }
}

/**
 * Create a GuardrailPipelineImpl with the shared provider registry.
 *
 * @param llmEval - Optional LLM evaluation function for Tier 3 guardrails
 * @returns A pipeline instance with all registered providers available
 */
export function createGuardrailPipeline(
  llmEval?: LLMEvalFunction,
  tenantId?: string,
  projectId?: string,
  options?: {
    cache?: GuardrailCachePort;
    costChecker?: CostCheckerPort;
    webhook?: WebhookPort;
    webhookUrl?: string;
    webhookSecret?: string;
    policy?: PipelinePolicy;
    piiRecognizerRegistry?: PIIRecognizerRegistry;
    cacheScopeKey?: string;
  },
): GuardrailPipelineImpl {
  const registry = tenantId ? getOrCreateTenantRegistry(tenantId) : getOrCreateDefaultRegistry();
  const policy = options?.policy;
  const effectiveProjectId = projectId ?? 'default';
  const policyCaching = policy?.caching;
  const exactMatchCachingEnabled =
    policyCaching?.enabled !== false && policyCaching?.exactMatch !== false;

  const portOptions: {
    cache?: GuardrailCachePort;
    costChecker?: CostCheckerPort;
    webhook?: WebhookPort;
  } = {
    cache: options?.cache,
    costChecker: options?.costChecker,
    webhook: options?.webhook,
  };

  if (tenantId) {
    if (portOptions.cache === undefined && exactMatchCachingEnabled) {
      const cache = getOrCreateGuardrailCache();
      if (cache) {
        portOptions.cache = new CacheAdapter(cache, tenantId, effectiveProjectId, {
          defaultTtlSeconds: policyCaching?.defaultTtlSeconds,
          scopeKey: options?.cacheScopeKey,
        });
      }
    }

    if (portOptions.costChecker === undefined) {
      const costTracker = getOrCreateCostTracker();
      if (costTracker) {
        const budget: CostBudget | undefined = policy?.budget
          ? {
              monthlyBudgetUsd: policy.budget.monthlyLimitUsd,
              onExceed:
                policy.budget.overspendAction === 'alert_only'
                  ? 'allow'
                  : policy.budget.overspendAction,
            }
          : undefined;
        portOptions.costChecker = new CostCheckerAdapter(
          costTracker,
          tenantId,
          effectiveProjectId,
          budget,
        );
      }
    }
  }

  if (portOptions.webhook === undefined) {
    const webhookUrl = options?.webhookUrl ?? policy?.webhook?.url;
    const webhookSecret = options?.webhookSecret ?? policy?.webhook?.secret;
    if (webhookUrl && webhookSecret) {
      try {
        const delivery = new GuardrailWebhookDelivery({
          url: webhookUrl,
          secret: webhookSecret,
        });
        portOptions.webhook = new WebhookAdapter(delivery);
      } catch (err) {
        log.warn('Failed to create webhook adapter, proceeding without webhook', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return new GuardrailPipelineImpl(registry, llmEval, {
    ...portOptions,
    piiRecognizerRegistry: options?.piiRecognizerRegistry,
  });
}

/**
 * Register a custom guardrail provider in the shared registry.
 * Providers persist for the lifetime of the process.
 */
export function registerGuardrailProvider(
  provider: GuardrailModelProvider,
  tenantId?: string,
  options?: { runtimeConfig?: ProviderRuntimeConfig },
): void {
  const registry = tenantId ? getOrCreateTenantRegistry(tenantId) : getOrCreateDefaultRegistry();
  registry.register(provider, { permanent: true, runtimeConfig: options?.runtimeConfig });
  log.info('Registered custom guardrail provider', { name: provider.name, tenantId });
}

/**
 * Get the registry for a tenant (or default) for testing or introspection.
 */
export function getSharedRegistry(tenantId?: string): GuardrailProviderRegistry {
  return tenantId ? getOrCreateTenantRegistry(tenantId) : getOrCreateDefaultRegistry();
}

/**
 * Reset all registries and caches (for testing only).
 */
export function resetSharedRegistry(): void {
  tenantRegistries.clear();
  tenantProviderLoadCache.clear();
  tenantProviderLoadInFlight.clear();
  providerConfigFingerprints.clear();
  sharedGuardrailCache = null;
  sharedCostTracker = null;
}

/**
 * Invalidate the provider cache and registry for a specific tenant.
 * Call this when provider configs are created, updated, or deleted
 * so the next guardrail evaluation reloads from DB.
 */
export function invalidateTenantProviderCache(tenantId: string): void {
  tenantProviderLoadCache.delete(tenantId);
  tenantRegistries.delete(tenantId);

  // Clear fingerprints for this tenant so re-registration starts fresh
  const prefix = `${tenantId}:`;
  for (const key of providerConfigFingerprints.keys()) {
    if (key.startsWith(prefix)) {
      providerConfigFingerprints.delete(key);
    }
  }

  log.info('Invalidated tenant provider cache', { tenantId });
}

/**
 * Invalidate the guardrail evaluation cache for a specific tenant.
 * Call this when guardrail policies are created, updated, or deleted
 * so stale thresholds/actions don't persist in cached eval results.
 *
 * Fire-and-forget: errors are logged but never propagated.
 */
export function invalidateGuardrailEvalCache(tenantId: string): void {
  const cache = getOrCreateGuardrailCache();
  if (!cache) return;

  cache.invalidateByTenant(tenantId).catch((err) => {
    log.warn('Failed to invalidate guardrail eval cache', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// =============================================================================
// TIER 3 LLM EVALUATION ADAPTER
// =============================================================================

/**
 * Create an LLMEvalFunction adapter from a SessionLLMClient.
 * Used for Tier 3 guardrail evaluation (LLM-based content assessment).
 *
 * Tries the 'validation' operation type first (fast tier), then falls back
 * to 'response_gen' (balanced tier) if the validation tier has no credential.
 * This ensures Tier 3 evals work as long as the agent has any working LLM.
 */
export function createLLMEvalFromClient(client: SessionLLMClient): LLMEvalFunction {
  return async (prompt: string): Promise<string> => {
    try {
      const result = await client.chatWithToolUse(
        '', // empty system prompt — the guardrail prompt is self-contained
        [{ role: 'user', content: prompt }],
        [], // no tools
        'validation',
      );
      return result.text ?? '';
    } catch (err) {
      // If validation tier fails (e.g. no credential for fast-tier provider),
      // fall back to the agent's default model (response_gen / balanced tier).
      log.warn('Tier 3 eval failed with validation tier, falling back to response_gen', {
        error: err instanceof Error ? err.message : String(err),
      });
      const result = await client.chatWithToolUse(
        '',
        [{ role: 'user', content: prompt }],
        [],
        'response_gen',
      );
      return result.text ?? '';
    }
  };
}

// =============================================================================
// POLICY RESOLUTION
// =============================================================================

const policyResolver = new GuardrailPolicyResolver();

/**
 * Resolve guardrail policy from DB for a given tenant/project/agent scope.
 * Returns a PipelinePolicy compatible with pipeline.execute(), or undefined
 * if no policies are configured.
 *
 * Fails gracefully — if DB is unavailable, returns undefined (no policy).
 *
 * @param tenantId - Tenant ID
 * @param projectId - Project ID
 * @param agentDefId - Agent definition ID
 * @param agentGuardrails - Guardrails from the agent IR
 * @param loadPolicies - Optional function to load policies from DB (for testing)
 */
export interface ResolvedPolicyResult {
  policy: PipelinePolicy;
  streamingConfig?: StreamingSettings;
}

export async function resolveGuardrailPolicy(
  tenantId: string,
  projectId: string,
  agentDefId: string,
  agentGuardrails: Guardrail[],
  loadPolicies?: (
    tenantId: string,
    projectId: string,
    agentDefId: string,
  ) => Promise<{
    tenantPolicies: PolicyData[];
    projectPolicies: PolicyData[];
  }>,
): Promise<ResolvedPolicyResult | undefined> {
  try {
    const loader = loadPolicies ?? loadPoliciesFromDB;
    const { tenantPolicies, projectPolicies } = await loader(tenantId, projectId, agentDefId);

    if (tenantPolicies.length === 0 && projectPolicies.length === 0) {
      return undefined;
    }

    const resolved = policyResolver.resolve({
      tenantId,
      projectId,
      agentDefId,
      agentGuardrails,
      tenantPolicies,
      projectPolicies,
    });

    const dslNames = new Set(agentGuardrails.map((g) => g.name));
    const policy = toPipelinePolicy(resolved, dslNames);

    return {
      policy,
      streamingConfig: resolved.settings.streaming,
    };
  } catch (err) {
    log.warn('Failed to resolve guardrail policy, proceeding without policy', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Load policies from the database for a tenant, project, and agent.
 *
 * Scope resolution order (narrowest wins during policy merge):
 *   1. tenant-scoped  → tenantPolicies
 *   2. project-scoped → projectPolicies
 *   3. agent-scoped   → projectPolicies (treated as project-level for merge,
 *                        since agent scope is a further narrowing of project)
 */
async function loadPoliciesFromDB(
  tenantId: string,
  projectId: string,
  agentDefId: string,
): Promise<{ tenantPolicies: PolicyData[]; projectPolicies: PolicyData[] }> {
  if (!isDatabaseReady()) {
    log.debug('Database not ready, skipping guardrail policy lookup', {
      tenantId,
      projectId,
      agentDefId,
    });
    return { tenantPolicies: [], projectPolicies: [] };
  }

  // Dynamic import to avoid circular dependency at module load time.
  // The model is only needed when actually resolving policies.
  const { GuardrailPolicy, ProjectAgent } = await import('@agent-platform/database/models');
  const agentScopeIds = [agentDefId];

  const agent = await ProjectAgent.findOne({
    tenantId,
    projectId,
    name: agentDefId,
  })
    .select({ _id: 1 })
    .lean();
  if (agent?._id !== undefined) {
    const agentId = String(agent._id);
    if (!agentScopeIds.includes(agentId)) {
      agentScopeIds.push(agentId);
    }
  }

  const policies = await GuardrailPolicy.find({
    tenantId,
    isActive: true,
    status: 'active',
    $or: [
      { 'scope.type': 'tenant' },
      { 'scope.type': 'project', 'scope.projectId': projectId },
      {
        'scope.type': 'agent',
        'scope.agentDefId': { $in: agentScopeIds },
        'scope.projectId': projectId,
      },
    ],
  })
    .limit(50)
    .lean();

  const scopePriority = (scopeType: unknown): number => {
    if (scopeType === 'tenant') return 0;
    if (scopeType === 'project') return 1;
    if (scopeType === 'agent') return 2;
    return 99;
  };

  const sortedPolicies = [...policies].sort((left, right) => {
    const priorityDiff = scopePriority(left.scope?.type) - scopePriority(right.scope?.type);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
    const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
    return leftTime - rightTime;
  });

  const tenantPolicies: PolicyData[] = [];
  const projectPolicies: PolicyData[] = [];

  for (const p of sortedPolicies) {
    const isProjectScopedPolicy = p.scope?.type === 'project' && p.scope.projectId === projectId;
    const rawSettings = ((p.settings ?? {}) as PolicyData['settings']) ?? {};
    const settings = isProjectScopedPolicy
      ? rawSettings
      : (() => {
          const { webhookUrl: _webhookUrl, webhookSecret: _webhookSecret, ...rest } = rawSettings;
          return rest as PolicyData['settings'];
        })();
    const data: PolicyData = {
      name: p.name,
      rules: (p.rules ?? []) as PolicyData['rules'],
      settings,
      caching: isProjectScopedPolicy ? (p.caching as PolicyData['caching']) : undefined,
      budget: isProjectScopedPolicy ? (p.budget as PolicyData['budget']) : undefined,
      providerOverrides: ((p.providerOverrides ?? []) as Array<Record<string, unknown>>).map(
        (o) => ({
          providerName: o.providerName as string,
          endpoint: o.endpoint as string | undefined,
          apiKeyCredentialId: o.apiKeyCredentialId as string | undefined,
          defaultCategory: o.defaultCategory as string | undefined,
          defaultThreshold: o.defaultThreshold as number | undefined,
          costPerEvalUsd: o.costPerEvalUsd as number | undefined,
          isActive: o.isActive as boolean | undefined,
          circuitBreaker: o.circuitBreaker as
            | { failureThreshold?: number; resetTimeoutMs?: number; failMode?: 'open' | 'closed' }
            | undefined,
          retry: o.retry as { maxRetries?: number; backoffBaseMs?: number } | undefined,
        }),
      ),
      constitution: ((p.constitution ?? []) as Array<Record<string, unknown>>).map((c) => ({
        principle: c.principle as string,
        weight: (c.weight as number) ?? 1,
        examples: c.examples as string[] | undefined,
      })),
    };

    if (p.scope?.type === 'project' && p.scope.projectId === projectId) {
      projectPolicies.push(data);
    } else if (
      p.scope?.type === 'agent' &&
      typeof p.scope.agentDefId === 'string' &&
      agentScopeIds.includes(p.scope.agentDefId)
    ) {
      // Agent-scoped policies are the narrowest scope — treat as project-level
      // for merge purposes since they refine the project policy for this agent.
      projectPolicies.push(data);
    } else if (p.scope?.type === 'tenant') {
      tenantPolicies.push(data);
    }
  }

  return { tenantPolicies, projectPolicies };
}

/**
 * Convert resolved policy to PipelinePolicy format consumed by pipeline.execute().
 *
 * Intentionally omitted fields from the DB GuardrailPolicy model:
 *   - streaming (streamingMode, chunkEvalInterval): pipeline evaluators handle
 *     streaming config internally via StreamingGuardrailEvaluator constructor
 *   - semanticMatch caching: reserved until a semantic cache implementation exists
 */
function toPipelinePolicy(
  resolved: ResolvedGuardrailPolicy,
  dslGuardrailNames: Set<string>,
): PipelinePolicy {
  // Separate policy-defined guardrails (not in DSL) from DSL guardrails
  const additionalGuardrails = resolved.guardrails.filter((g) => !dslGuardrailNames.has(g.name));

  return {
    disabledGuardrails: resolved.disabledGuardrails,
    ruleOverrides: resolved.ruleOverrides
      .filter(
        (r): r is typeof r & { override: 'threshold' | 'action' | 'severity_actions' } =>
          r.override !== 'disable',
      )
      .map((r) => ({
        guardrailName: r.guardrailName,
        override: r.override,
        threshold: r.threshold,
        action: r.action as GuardrailAction | undefined,
        severityActions: r.severityActions as Record<string, GuardrailAction> | undefined,
      })),
    providerOverrides: resolved.providerOverrides.map((o) => ({
      providerName: o.providerName,
      endpoint: o.endpoint,
      defaultCategory: o.defaultCategory,
      defaultThreshold: o.defaultThreshold,
      costPerEvalUsd: o.costPerEvalUsd,
      isActive: o.isActive,
      circuitBreaker: o.circuitBreaker,
      retry: o.retry,
    })),
    settings: {
      failMode: resolved.settings.failMode,
      timeouts: resolved.settings.timeouts,
    },
    caching: resolved.caching
      ? {
          enabled: resolved.caching.enabled,
          exactMatch: resolved.caching.exactMatch,
          defaultTtlSeconds: resolved.caching.defaultTtlSeconds,
        }
      : undefined,
    budget: resolved.budget
      ? {
          monthlyLimitUsd: resolved.budget.monthlyLimitUsd,
          overspendAction: resolved.budget.overspendAction,
        }
      : undefined,
    webhook:
      resolved.settings.webhookUrl && resolved.settings.webhookSecret
        ? {
            url: resolved.settings.webhookUrl,
            secret: resolved.settings.webhookSecret,
          }
        : undefined,
    additionalGuardrails: additionalGuardrails.length > 0 ? additionalGuardrails : undefined,
    constitution:
      resolved.constitution.length > 0
        ? resolved.constitution.map((c) => ({
            principle: c.principle,
            weight: c.weight,
            examples: c.examples,
          }))
        : undefined,
  };
}
