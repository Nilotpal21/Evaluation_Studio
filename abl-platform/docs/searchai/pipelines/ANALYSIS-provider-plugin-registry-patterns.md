# Provider/Plugin/Registry Patterns Analysis

**Task:** Pre-Check #63 - Explore existing provider/plugin/registry patterns
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

The ABL Platform uses **registry**, **provider**, and **plugin** patterns extensively for extensibility and modularity. Pipeline stage providers should follow the **provider interface pattern** with a **registry for discovery** and **circuit breaker integration** for fault tolerance. The platform has 8+ production registries showing consistent patterns for registration, lookup, and lifecycle management.

---

## 1. Architecture Overview

### Three Core Patterns

```
┌─────────────────────────────────────────────────────────────┐
│ Registry Pattern                                            │
│ - In-memory or cached lookup                                │
│ - Register/unregister operations                            │
│ - Lifecycle management (TTL, LRU eviction)                  │
└─────────────────────────────────────────────────────────────┘
                          ↑
┌─────────────────────────────────────────────────────────────┐
│ Provider Pattern                                            │
│ - Interface-based implementation                            │
│ - Stateless execution                                       │
│ - Config-driven instantiation                               │
└─────────────────────────────────────────────────────────────┘
                          ↑
┌─────────────────────────────────────────────────────────────┐
│ Plugin Pattern                                              │
│ - Pre/post hooks                                            │
│ - Pipeline execution                                        │
│ - Non-breaking failures                                     │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight:** Registries manage providers, providers implement interfaces, plugins extend behavior.

---

## 2. Registry Pattern

### Simple In-Memory Registry

**Location:** `packages/connectors/src/registry.ts`

```typescript
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector already registered: ${connector.name}`);
    }
    this.connectors.set(connector.name, connector);
  }

  get(name: string): Connector {
    const connector = this.connectors.get(name);
    if (!connector) {
      throw new Error(`Unknown connector: ${name}`);
    }
    return connector;
  }

  has(name: string): boolean {
    return this.connectors.has(name);
  }

  getAction(connectorName: string, actionName: string): ConnectorAction | undefined {
    const connector = this.get(connectorName);
    return connector.actions.find((a) => a.name === actionName);
  }

  getTrigger(connectorName: string, triggerName: string): ConnectorTrigger | undefined {
    const connector = this.get(connectorName);
    return connector.triggers.find((t) => t.name === triggerName);
  }

  listConnectors(): Connector[] {
    return Array.from(this.connectors.values());
  }

  /** Clear all registered connectors (for testing) */
  clear(): void {
    this.connectors.clear();
  }
}
```

**Key Features:**

- **Map-based storage** (`Map<name, T>`)
- **Duplicate check** on register (throws error)
- **get vs has** (throw vs return undefined)
- **List operation** (return all values)
- **Clear for testing** (reset state)

---

### Singleton Registry with Auto-Registration

**Location:** `apps/runtime/src/channels/registry.ts`

```typescript
export class ChannelRegistry {
  private adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    log.info('Channel adapter registered', { channelType: adapter.channelType });
  }

  get(channelType: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  has(channelType: ChannelType): boolean {
    return this.adapters.has(channelType);
  }

  getRegisteredTypes(): ChannelType[] {
    return Array.from(this.adapters.keys());
  }
}

// Singleton
let registryInstance: ChannelRegistry | null = null;

export function getChannelRegistry(): ChannelRegistry {
  if (!registryInstance) {
    registryInstance = new ChannelRegistry();
    registryInstance.register(new HttpAsyncAdapter());
    registryInstance.register(new SlackAdapter());
    registryInstance.register(new EmailAdapter());
    registryInstance.register(new MSTeamsAdapter());
    registryInstance.register(new VxmlAdapter());
    registryInstance.register(new KorevgAdapter());
    registerWhatsAppProvider(new MetaCloudProvider());
    registerWhatsAppProvider(new InfobipProvider());
    registryInstance.register(new WhatsAppAdapter());
    registryInstance.register(new MessengerAdapter());
    registryInstance.register(new TwilioSmsAdapter());
    registryInstance.register(new AgUiAdapter());
    registryInstance.register(new AudioCodesAdapter());
    registryInstance.register(new ZendeskAdapter());
    registryInstance.register(new TelegramAdapter());
  }
  return registryInstance;
}
```

**Key Features:**

- **Singleton pattern** (global shared instance)
- **Auto-registration** on first access
- **Logging** on register (audit trail)
- **Known set of adapters** (compiled into binary)

---

### Registry with Hierarchical Organization

**Location:** `packages/circuit-breaker/src/registry.ts`

```typescript
export class CircuitBreakerRegistry {
  private readonly redis: Redis;
  private readonly breakers: Map<BreakerLevel, RedisCircuitBreaker> = new Map();
  private readonly tenantBreakers: Map<string, RedisCircuitBreaker> = new Map();
  private readonly globalListeners: BreakerEventListener[] = [];
  private readonly overrides: Map<string, Partial<CircuitBreakerConfig>> = new Map();

  constructor(
    redis: Redis,
    options?: {
      defaults?: Partial<Record<BreakerLevel, Partial<CircuitBreakerConfig>>>;
      tenantOverrides?: TenantBreakerOverride[];
    },
  ) {
    this.redis = redis;

    // Create default breakers for each level
    const levels: BreakerLevel[] = ['tenant', 'app', 'llm_provider', 'tool_service'];
    for (const level of levels) {
      const config = options?.defaults?.[level];
      const breaker = new RedisCircuitBreaker(redis, level, config);
      this.breakers.set(level, breaker);
    }

    // Store per-tenant overrides
    if (options?.tenantOverrides) {
      for (const override of options.tenantOverrides) {
        const overrideKey = `${override.level}:${override.tenantId}`;
        this.overrides.set(overrideKey, override.config);
      }
    }
  }

  /**
   * Get or create a tenant-level circuit breaker.
   */
  tenant(tenantId: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('tenant', tenantId);
    return new BreakerHandle(breaker, tenantId);
  }

  /**
   * Get or create an app-level circuit breaker.
   */
  app(tenantId: string, appId: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('app', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${appId}`);
  }

  /**
   * Get or create an LLM provider circuit breaker.
   */
  llmProvider(tenantId: string, provider: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('llm_provider', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${provider}`);
  }

  /**
   * Get or create a tool/service circuit breaker.
   */
  toolService(tenantId: string, serviceName: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('tool_service', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${serviceName}`);
  }

  private getBreakerForTenant(level: BreakerLevel, tenantId: string): RedisCircuitBreaker {
    const overrideKey = `${level}:${tenantId}`;

    // Check if tenant has a custom override
    const override = this.overrides.get(overrideKey);
    if (override) {
      // Return or create a tenant-specific breaker
      let breaker = this.tenantBreakers.get(overrideKey);
      if (!breaker) {
        breaker = new RedisCircuitBreaker(this.redis, level, override);
        // Subscribe global listeners
        for (const listener of this.globalListeners) {
          breaker.onEvent(listener);
        }
        this.tenantBreakers.set(overrideKey, breaker);
      }
      return breaker;
    }

    // Return the default breaker for this level
    return this.breakers.get(level)!;
  }

  /**
   * Get the health of all breakers for a tenant.
   */
  async getTenantHealth(tenantId: string): Promise<TenantHealth> {
    const tenantBreaker = this.getBreakerForTenant('tenant', tenantId);
    const tenantMetrics = await tenantBreaker.getMetrics(tenantId);

    // Scan for all app-level breakers for this tenant
    const appKeys = await this.scanBreakerKeys('app', tenantId);
    const appMetrics = await Promise.all(
      appKeys.map(async (appKey) => ({
        key: appKey,
        metrics: await this.getBreakerForTenant('app', tenantId).getMetrics(appKey),
      })),
    );

    // ... scan LLM and tool service breakers

    return {
      tenantId,
      tenant: tenantMetrics,
      apps: appMetrics,
      llmProviders: llmMetrics,
      toolServices: toolMetrics,
      hasOpenCircuits: /* ... */,
    };
  }

  /**
   * Subscribe to events from ALL breakers in the registry.
   */
  onEvent(listener: BreakerEventListener): () => void {
    this.globalListeners.push(listener);

    // Subscribe to all existing breakers
    const unsubscribers: (() => void)[] = [];
    for (const breaker of this.breakers.values()) {
      unsubscribers.push(breaker.onEvent(listener));
    }
    for (const breaker of this.tenantBreakers.values()) {
      unsubscribers.push(breaker.onEvent(listener));
    }

    return () => {
      const idx = this.globalListeners.indexOf(listener);
      if (idx !== -1) this.globalListeners.splice(idx, 1);
      for (const unsub of unsubscribers) unsub();
    };
  }

  /**
   * Set a per-tenant config override at runtime.
   */
  setTenantOverride(
    tenantId: string,
    level: BreakerLevel,
    config: Partial<CircuitBreakerConfig>,
  ): void {
    const overrideKey = `${level}:${tenantId}`;
    this.overrides.set(overrideKey, config);
    // Invalidate cached breaker so it's recreated with new config
    this.tenantBreakers.delete(overrideKey);
  }
}

/**
 * BreakerHandle - Convenience wrapper that binds a breaker to a specific key.
 */
export class BreakerHandle {
  constructor(
    private readonly breaker: RedisCircuitBreaker,
    private readonly key: string,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.execute(this.key, fn);
  }

  async checkState() {
    return this.breaker.checkState(this.key);
  }

  async getMetrics() {
    return this.breaker.getMetrics(this.key);
  }
}
```

**Key Features:**

- **Multi-level hierarchy** (tenant → app → llm_provider → tool_service)
- **Per-tenant overrides** (custom config per tenant)
- **Handle pattern** (bind breaker to key for convenience)
- **Bulk operations** (getTenantHealth, forceResetTenant)
- **Event subscription** (global listeners across all breakers)
- **Lazy instantiation** (create on first access)

---

### Registry with TTL and LRU Eviction

**Location:** `packages/compiler/src/platform/guardrails/provider-registry.ts`

```typescript
const MAX_REGISTRY_SIZE = 100;
const REGISTRY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ProviderEntry {
  provider: GuardrailModelProvider;
  registeredAt: number;
  permanent?: boolean;
}

export class GuardrailProviderRegistry {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly circuitBreakerConfig: Partial<CircuitBreakerConfig> | undefined;

  constructor(circuitBreakerConfig?: Partial<CircuitBreakerConfig>) {
    this.circuitBreakerConfig = circuitBreakerConfig;
    // Auto-register built-in PII provider as permanent
    const piiProvider = new BuiltinPIIProvider();
    this.register(piiProvider);
    const piiEntry = this.providers.get(piiProvider.name);
    if (piiEntry) {
      piiEntry.permanent = true;
    }
  }

  /** Register a provider. Creates a circuit breaker if one does not exist for this name. */
  register(provider: GuardrailModelProvider): void {
    // Evict oldest entry if at capacity (skip if updating existing)
    if (!this.providers.has(provider.name) && this.providers.size >= MAX_REGISTRY_SIZE) {
      const oldest = this.findOldestEntry();
      if (oldest) {
        this.unregister(oldest);
      }
    }
    this.providers.set(provider.name, { provider, registeredAt: Date.now() });
    if (!this.breakers.has(provider.name)) {
      this.breakers.set(provider.name, new CircuitBreaker(this.circuitBreakerConfig));
    }
  }

  private findOldestEntry(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.providers) {
      if (!entry.permanent && entry.registeredAt < oldestTime) {
        oldestTime = entry.registeredAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /** Retrieve a provider by name. Returns undefined if not found or expired. */
  get(name: string): GuardrailModelProvider | undefined {
    const entry = this.providers.get(name);
    if (!entry) return undefined;
    if (!entry.permanent && Date.now() - entry.registeredAt > REGISTRY_TTL_MS) {
      this.unregister(name);
      return undefined;
    }
    return entry.provider;
  }

  /** List all registered provider names (excluding expired). */
  listProviders(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    const active: string[] = [];
    for (const [key, entry] of this.providers) {
      if (!entry.permanent && now - entry.registeredAt > REGISTRY_TTL_MS) {
        expired.push(key);
      } else {
        active.push(key);
      }
    }
    for (const key of expired) this.unregister(key);
    return active;
  }

  /**
   * Evaluate a request through a named provider with circuit breaker protection.
   */
  async evaluate(
    providerName: string,
    request: GuardrailEvalRequest,
    options?: {
      failMode?: 'open' | 'closed';
      providerOverride?: {
        circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number };
      };
    },
  ): Promise<GuardrailEvalResult | undefined> {
    const provider = this.get(providerName);
    if (!provider) return undefined;

    const breaker = this.breakers.get(providerName);
    if (!breaker) return undefined;

    // Apply circuit breaker overrides
    if (options?.providerOverride?.circuitBreaker) {
      const cbOverride = options.providerOverride.circuitBreaker;
      const needsUpdate =
        (cbOverride.failureThreshold !== undefined &&
          cbOverride.failureThreshold !== breaker.currentConfig.failureThreshold) ||
        (cbOverride.resetTimeoutMs !== undefined &&
          cbOverride.resetTimeoutMs !== breaker.currentConfig.resetTimeoutMs);
      if (needsUpdate) {
        const newBreaker = new CircuitBreaker({
          ...this.circuitBreakerConfig,
          ...cbOverride,
        });
        this.breakers.set(providerName, newBreaker);
      }
    }

    const activeBreaker = this.breakers.get(providerName)!;
    if (!activeBreaker.canExecute()) {
      log.warn('Circuit breaker open for provider, skipping evaluation', {
        provider: providerName,
        state: activeBreaker.state,
      });
      return {
        score: options?.failMode === 'closed' ? 1.0 : 0.0,
        severity: options?.failMode === 'closed' ? 'critical' : 'safe',
        category: request.category,
        latencyMs: 0,
      };
    }

    try {
      const result = await provider.evaluate(request);
      activeBreaker.recordSuccess();
      return result;
    } catch (err: unknown) {
      activeBreaker.recordFailure();
      log.warn('Provider evaluation failed, circuit breaker updated', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        score: options?.failMode === 'closed' ? 1.0 : 0.0,
        severity: options?.failMode === 'closed' ? 'critical' : 'safe',
        category: request.category,
        latencyMs: 0,
      };
    }
  }
}
```

**Key Features:**

- **TTL expiration** (auto-expire after 5 minutes)
- **LRU eviction** (max 100 entries, evict oldest)
- **Permanent entries** (immune to TTL/eviction)
- **Circuit breaker per provider** (fault isolation)
- **Execute through registry** (registry wraps provider calls)
- **Runtime config override** (per-request circuit breaker config)

---

### Registry with Database and Caching

**Location:** `packages/shared/src/services/mcp-server-registry.ts`

```typescript
const CACHE_TTL_MS = 60_000; // 1 minute
const MAX_CACHE_SIZE = 500;

interface CacheEntry {
  configs: MCPServerConfigOutput[];
  loadedAt: number;
}

export class MCPServerRegistryService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private decryptor: MCPDecryptor,
    private verifyProject?: ProjectVerifier,
    private urlValidator?: UrlValidator,
  ) {}

  /**
   * Load MCP server configs for a project from the database.
   * Results are cached for CACHE_TTL_MS per (tenantId, projectId).
   */
  async getServerConfigs(tenantId: string, projectId: string): Promise<MCPServerConfigOutput[]> {
    const cacheKey = `${tenantId}:${projectId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.configs;
    }

    try {
      // Verify project ownership if verifier provided
      if (this.verifyProject) {
        const owned = await this.verifyProject(projectId, tenantId);
        if (!owned) return [];
      }

      const { findMcpServerConfigsByProject } = await import('../repos/mcp-server-config-repo.js');
      const rows = await findMcpServerConfigsByProject(tenantId, projectId);

      const configs: MCPServerConfigOutput[] = [];
      for (const row of rows) {
        const cfg = await this.toServerConfig(row, tenantId);
        if (cfg) configs.push(cfg);
      }

      // Bounded cache: evict oldest if at capacity
      if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(cacheKey)) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, { configs, loadedAt: Date.now() });

      return configs;
    } catch (error) {
      console.error('[mcp-server-registry] Failed to load MCP server configs', {
        tenantId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  invalidate(tenantId: string, projectId: string): void {
    this.cache.delete(`${tenantId}:${projectId}`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async toServerConfig(
    row: NormalizedMCPServerConfig,
    tenantId: string,
  ): Promise<MCPServerConfigOutput | null> {
    let env: Record<string, string> | undefined;
    if (row.encryptedEnv) {
      try {
        const decrypted = await this.decryptor.decryptForTenant(row.encryptedEnv, tenantId);
        env = JSON.parse(decrypted) as Record<string, string>;
      } catch (error) {
        console.error('[mcp-server-registry] Skipping MCP server — env decryption failed', {
          tenantId,
          server: row.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    // Validate URL for SSRF safety
    const serverUrl = row.url ?? undefined;
    if (serverUrl && this.urlValidator) {
      const result = this.urlValidator(serverUrl);
      if (!result.safe) {
        console.error('[mcp-server-registry] Skipping MCP server — URL blocked by SSRF validator', {
          tenantId,
          server: row.name,
          url: serverUrl,
          reason: result.reason,
        });
        return null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      env,
      url: serverUrl,
      // ...
    };
  }
}
```

**Key Features:**

- **Database-backed** (not just in-memory)
- **TTL cache** (1-minute cache per tenant/project)
- **LRU eviction** (max 500 entries)
- **Async validation** (decryption, SSRF checks)
- **Dependency injection** (decryptor, verifier, validator)
- **Error handling** (skip invalid entries, log errors)

---

## 3. Provider Pattern

### Interface-Based Provider

**Location:** `packages/compiler/src/platform/guardrails/provider.ts`

```typescript
/**
 * GuardrailModelProvider Interface
 *
 * A provider wraps access to a guardrail model (PII detection, content moderation, etc.).
 * Providers are registered in GuardrailProviderRegistry.
 */
export interface GuardrailModelProvider {
  /** Unique provider name */
  readonly name: string;

  /**
   * Evaluate a guardrail check request.
   * Returns a score (0-1), severity, and category.
   */
  evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult>;
}

export interface GuardrailEvalRequest {
  text: string;
  category: string;
  metadata?: Record<string, unknown>;
}

export interface GuardrailEvalResult {
  score: number; // 0-1, higher = more problematic
  severity: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}
```

### Provider Implementation Example

**Location:** `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`

```typescript
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../provider.js';

/**
 * Built-in PII Detection Provider
 *
 * Regex-based PII detection (no external API calls).
 * Always available, no credentials required.
 */
export class BuiltinPIIProvider implements GuardrailModelProvider {
  readonly name = 'builtin-pii';

  private readonly patterns = [
    { category: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
    { category: 'phone', regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g },
    { category: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    { category: 'credit_card', regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g },
  ];

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const startTime = Date.now();
    const text = request.text;
    const matches: { category: string; count: number }[] = [];

    for (const pattern of this.patterns) {
      const found = text.match(pattern.regex);
      if (found) {
        matches.push({ category: pattern.category, count: found.length });
      }
    }

    const totalMatches = matches.reduce((sum, m) => sum + m.count, 0);
    const score = Math.min(1.0, totalMatches * 0.2); // 0.2 per match, cap at 1.0
    const severity =
      score >= 0.8
        ? 'critical'
        : score >= 0.6
          ? 'high'
          : score >= 0.4
            ? 'medium'
            : score > 0
              ? 'low'
              : 'safe';

    return {
      score,
      severity,
      category: request.category,
      latencyMs: Date.now() - startTime,
      details: { matches },
    };
  }
}
```

**Key Features:**

- **Interface implementation** (adheres to GuardrailModelProvider)
- **Stateless execution** (no instance state)
- **Self-contained** (no external dependencies)
- **Async by default** (even if synchronous internally)
- **Consistent return type** (GuardrailEvalResult)

---

### Provider with Configuration

**Location:** `packages/compiler/src/platform/guardrails/providers/openai-moderation.ts`

```typescript
export interface OpenAIModerationConfig {
  apiKey: string;
  model?: string; // 'text-moderation-latest' | 'text-moderation-stable'
  endpoint?: string;
}

export class OpenAIModerationProvider implements GuardrailModelProvider {
  readonly name = 'openai-moderation';
  private readonly config: Required<OpenAIModerationConfig>;

  constructor(config: OpenAIModerationConfig) {
    this.config = {
      model: 'text-moderation-latest',
      endpoint: 'https://api.openai.com/v1/moderations',
      ...config,
    };
  }

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          input: request.text,
          model: this.config.model,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI Moderation API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const result = data.results[0];

      // OpenAI moderation returns category scores
      const maxScore = Math.max(...Object.values(result.category_scores));
      const flagged = result.flagged;

      return {
        score: maxScore,
        severity: flagged ? 'high' : maxScore > 0.5 ? 'medium' : 'safe',
        category: request.category,
        latencyMs: Date.now() - startTime,
        details: {
          categories: result.categories,
          category_scores: result.category_scores,
          flagged,
        },
      };
    } catch (error) {
      return {
        score: 0.0,
        severity: 'safe',
        category: request.category,
        latencyMs: Date.now() - startTime,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
```

**Key Features:**

- **Constructor configuration** (API key, model, endpoint)
- **Config defaults** (spread operator for overrides)
- **External API integration** (fetch)
- **Error handling** (return safe result on error)
- **Detailed results** (include API response in details)

---

## 4. Plugin Pattern

### Mongoose Plugin (Pre/Post Hooks)

**Location:** `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`

```typescript
/**
 * Tenant Isolation Plugin
 *
 * Automatically injects tenantId filter on all read/write operations
 * for tenant-scoped models. Uses AsyncLocalStorage for request context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema, Query } from 'mongoose';

export interface TenantContext {
  tenantId: string;
  isSuperAdmin?: boolean;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function withTenantContext<T>(context: TenantContext, fn: () => T): T {
  return tenantStorage.run(context, fn);
}

export function getCurrentTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Mongoose plugin that enforces tenant isolation.
 */
export function tenantIsolationPlugin(schema: Schema): void {
  // Read operations
  const readOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'countDocuments',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
  ] as const;

  for (const op of readOps) {
    schema.pre(op, function (this: Query<any, any>) {
      injectTenantFilter(this);
    });
  }

  // Aggregation
  schema.pre('aggregate', function () {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) return;

    // Prepend $match { tenantId } as first pipeline stage
    const pipeline = this.pipeline();
    const hasMatch = pipeline.length > 0 && '$match' in pipeline[0] && pipeline[0].$match?.tenantId;

    if (!hasMatch) {
      pipeline.unshift({ $match: { tenantId: ctx.tenantId } });
    }
  });

  // Save (insert) — set tenantId before validation
  schema.pre('validate', function () {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) return;

    if (this.isNew && !this.get('tenantId')) {
      this.set('tenantId', ctx.tenantId);
    }
  });

  // insertMany
  schema.pre('insertMany', function (next, docs: any[]) {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) {
      next();
      return;
    }

    for (const doc of docs) {
      if (!doc.tenantId) {
        doc.tenantId = ctx.tenantId;
      }
    }
    next();
  });
}

function injectTenantFilter(query: Query<any, any>): void {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;

  const filter = query.getFilter();
  if (!filter.tenantId) {
    query.where('tenantId').equals(ctx.tenantId);
  }
}
```

**Key Features:**

- **Pre/post hooks** (intercept operations)
- **AsyncLocalStorage** (context propagation)
- **Non-intrusive** (no code changes in models)
- **Schema-level** (applied via `schema.plugin(...)`)
- **Context-aware** (read from AsyncLocalStorage)

---

### NLU Plugin Pipeline

**Location:** `packages/compiler/src/platform/nlu/plugins.ts`

```typescript
export interface NLUPlugin {
  name: string;
  /**
   * Run before LLM processing. If returns a result, short-circuit the pipeline.
   */
  preProcess?(ctx: NLUContext, task: NLUTask): Promise<NLUPluginResult | null>;
  /**
   * Run after LLM processing. Can modify the result.
   */
  postProcess?(ctx: NLUContext, task: NLUTask, result: unknown): Promise<unknown>;
}

export class NLUPluginPipeline {
  private readonly log = createLogger('nlu-plugins');
  private plugins: NLUPlugin[];

  constructor(plugins: NLUPlugin[] = []) {
    this.plugins = plugins;
  }

  /**
   * Run pre-process plugins. Returns short-circuit result if any plugin is confident.
   */
  async preProcess(ctx: NLUContext, task: NLUTask): Promise<NLUPluginResult | null> {
    for (const plugin of this.plugins) {
      if (plugin.preProcess) {
        try {
          const result = await plugin.preProcess(ctx, task);
          if (result) {
            return result;
          }
        } catch (error) {
          // Plugin errors should not break the pipeline
          this.log.warn('NLU plugin preProcess error', {
            plugin: plugin.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return null;
  }

  /**
   * Run post-process plugins. Each plugin can modify the result.
   */
  async postProcess(ctx: NLUContext, task: NLUTask, result: unknown): Promise<unknown> {
    let current = result;

    for (const plugin of this.plugins) {
      if (plugin.postProcess) {
        try {
          current = await plugin.postProcess(ctx, task, current);
        } catch (error) {
          this.log.warn('NLU plugin postProcess error', {
            plugin: plugin.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return current;
  }

  register(plugin: NLUPlugin): void {
    this.plugins.push(plugin);
  }

  unregister(name: string): void {
    this.plugins = this.plugins.filter((p) => p.name !== name);
  }

  getPlugins(): NLUPlugin[] {
    return [...this.plugins];
  }
}
```

**Key Features:**

- **Pre/post processing** (before and after main logic)
- **Short-circuit capability** (preProcess can skip main logic)
- **Transform capability** (postProcess modifies result)
- **Error isolation** (plugin errors don't break pipeline)
- **Optional hooks** (plugins can implement only what they need)

---

## 5. Registry Patterns Comparison

| Registry                      | Storage           | Lifecycle                                           | Circuit Breaker    | Use Case                                 |
| ----------------------------- | ----------------- | --------------------------------------------------- | ------------------ | ---------------------------------------- |
| **ConnectorRegistry**         | In-memory Map     | Manual register/unregister                          | No                 | Static connectors (compiled into binary) |
| **ChannelRegistry**           | In-memory Map     | Auto-register on first access                       | No                 | Static channels (compiled into binary)   |
| **CircuitBreakerRegistry**    | In-memory + Redis | Lazy instantiation, per-tenant overrides            | Yes (Redis-backed) | Dynamic circuit breakers with hierarchy  |
| **GuardrailProviderRegistry** | In-memory Map     | TTL expiration (5min), LRU eviction (max 100)       | Yes (in-memory)    | Dynamic providers with fault tolerance   |
| **MCPServerRegistryService**  | Database + Cache  | TTL cache (1min), DB-backed, LRU eviction (max 500) | No                 | Database-backed configs with decryption  |
| **ModelRegistry**             | In-memory Map     | Manual register, capabilities/pricing metadata      | No                 | LLM model catalog with routing           |

---

## 6. Provider Interface Templates

### Minimal Provider Interface

```typescript
export interface Provider {
  readonly name: string;
  execute(input: Input): Promise<Output>;
}
```

### Provider with Configuration

```typescript
export interface ProviderConfig {
  // Common config fields
  timeout?: number;
  retries?: number;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface Provider {
  readonly name: string;
  readonly config: Required<ProviderConfig>;
  execute(input: Input): Promise<Output>;
}

export abstract class BaseProvider implements Provider {
  abstract readonly name: string;
  readonly config: Required<ProviderConfig>;

  constructor(config: ProviderConfig) {
    this.config = {
      timeout: 30000,
      retries: 3,
      ...config,
    };
  }

  abstract execute(input: Input): Promise<Output>;
}
```

### Provider with Lifecycle Hooks

```typescript
export interface Provider {
  readonly name: string;

  /**
   * Initialize provider (load models, connect to API, etc.)
   * Called once when provider is registered.
   */
  initialize?(): Promise<void>;

  /**
   * Execute provider logic.
   */
  execute(input: Input): Promise<Output>;

  /**
   * Cleanup provider (close connections, release resources, etc.)
   * Called when provider is unregistered or shutdown.
   */
  dispose?(): Promise<void>;
}
```

---

## 7. Plugin Patterns Comparison

| Plugin Pattern      | Hook Points                                           | Error Handling                   | Use Case                                                               |
| ------------------- | ----------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| **Mongoose Plugin** | Pre/post hooks on CRUD operations                     | Propagate errors                 | Cross-cutting concerns (tenant isolation, slow queries, audit logging) |
| **NLU Plugin**      | Pre-process (short-circuit), post-process (transform) | Catch and log, continue pipeline | Extensible NLU with custom processors                                  |
| **Tool Middleware** | Wrap execution with before/after logic                | Configurable (throw or log)      | Runtime validation, observability                                      |

---

## 8. Recommendations for Pipeline Stage Providers

### Provider Interface

```typescript
/**
 * PipelineStageProvider Interface
 *
 * A provider implements a specific stage type (e.g., docling-extraction, embedding, etc.).
 * Providers are registered in StageProviderRegistry and invoked by the pipeline engine.
 */
export interface PipelineStageProvider {
  /** Unique provider name (e.g., 'docling-extraction', 'openai-embedding') */
  readonly name: string;

  /** Stage type this provider implements (e.g., 'extraction', 'embedding') */
  readonly stageType: string;

  /** Provider version (for compatibility checks) */
  readonly version: string;

  /** Provider capabilities */
  readonly capabilities: StageProviderCapabilities;

  /**
   * Execute the stage with the given input.
   * Returns stage output or throws on error.
   */
  execute(input: StageInput): Promise<StageOutput>;

  /**
   * Validate stage configuration (called when pipeline is saved).
   * Returns validation errors or empty array if valid.
   */
  validate?(config: StageConfig): ValidationError[];

  /**
   * Estimate cost for this stage (called when pipeline is saved).
   * Returns estimated cost per document in USD.
   */
  estimateCost?(config: StageConfig): Promise<CostEstimate>;
}

export interface StageProviderCapabilities {
  /** Supported MIME types (for extraction providers) */
  supportedMimeTypes?: string[];
  /** Maximum file size in bytes */
  maxFileSizeBytes?: number;
  /** Supports batching */
  supportsBatching?: boolean;
  /** Batch size limit */
  maxBatchSize?: number;
  /** Supports streaming */
  supportsStreaming?: boolean;
}

export interface StageInput {
  documentId: string;
  sourceId: string;
  indexId: string;
  tenantId: string;
  config: StageConfig;
  context: Record<string, unknown>;
  data: unknown; // Output from previous stage
}

export interface StageOutput {
  data: unknown; // Output for next stage
  metadata?: Record<string, unknown>;
  metrics?: StageMetrics;
}

export interface StageMetrics {
  durationMs: number;
  tokensUsed?: number;
  costUsd?: number;
  modelUsed?: string;
}
```

### Provider Registry

```typescript
export class StageProviderRegistry {
  private providers = new Map<string, PipelineStageProvider>();
  private breakers = new Map<string, RedisCircuitBreaker>();

  constructor(private redis: Redis) {}

  /**
   * Register a provider.
   * Creates a circuit breaker for fault isolation.
   */
  register(provider: PipelineStageProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider already registered: ${provider.name}`);
    }

    this.providers.set(provider.name, provider);

    // Create circuit breaker for this provider
    const breaker = new RedisCircuitBreaker(this.redis, 'stage_provider', {
      failureThreshold: 10,
      resetTimeout: 60000,
      monitorWindow: 30000,
    });
    this.breakers.set(provider.name, breaker);

    log.info('Stage provider registered', {
      name: provider.name,
      stageType: provider.stageType,
      version: provider.version,
    });
  }

  /**
   * Get provider by name.
   */
  get(name: string): PipelineStageProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `Unknown provider: ${name}. Available: ${this.listProviderNames().join(', ')}`,
      );
    }
    return provider;
  }

  /**
   * Get providers by stage type.
   */
  getByStageType(stageType: string): PipelineStageProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.stageType === stageType);
  }

  /**
   * Execute a provider through its circuit breaker.
   */
  async execute(providerName: string, input: StageInput): Promise<StageOutput> {
    const provider = this.get(providerName);
    const breaker = this.breakers.get(providerName)!;

    const key = `${input.tenantId}:${providerName}`;

    return breaker.execute(key, async () => {
      return provider.execute(input);
    });
  }

  /**
   * List all registered provider names.
   */
  listProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * List providers grouped by stage type.
   */
  listProvidersByType(): Map<string, string[]> {
    const byType = new Map<string, string[]>();
    for (const provider of this.providers.values()) {
      if (!byType.has(provider.stageType)) {
        byType.set(provider.stageType, []);
      }
      byType.get(provider.stageType)!.push(provider.name);
    }
    return byType;
  }

  /**
   * Validate all stages in a pipeline configuration.
   */
  async validatePipeline(flows: PipelineFlow[]): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    for (const flow of flows) {
      for (const stage of flow.stages) {
        const provider = this.providers.get(stage.provider);
        if (!provider) {
          errors.push({
            code: 'UNKNOWN_PROVIDER',
            message: `Unknown provider: ${stage.provider}`,
            path: `flows[${flow.id}].stages[${stage.id}].provider`,
          });
          continue;
        }

        if (provider.validate) {
          const stageErrors = provider.validate(stage.config);
          errors.push(...stageErrors);
        }
      }
    }

    return errors;
  }

  /**
   * Estimate cost for all stages in a pipeline.
   */
  async estimatePipelineCost(flows: PipelineFlow[]): Promise<CostEstimate> {
    let totalCostUsd = 0;

    for (const flow of flows) {
      for (const stage of flow.stages) {
        const provider = this.providers.get(stage.provider);
        if (provider?.estimateCost) {
          const estimate = await provider.estimateCost(stage.config);
          totalCostUsd += estimate.costPerDocumentUsd;
        }
      }
    }

    return {
      costPerDocumentUsd: totalCostUsd,
      costPer1000DocumentsUsd: totalCostUsd * 1000,
    };
  }
}
```

---

## 9. Provider Implementation Example

### Docling Extraction Provider

```typescript
export class DoclingExtractionProvider implements PipelineStageProvider {
  readonly name = 'docling-extraction';
  readonly stageType = 'extraction';
  readonly version = '1.0.0';

  readonly capabilities: StageProviderCapabilities = {
    supportedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/html',
      'text/markdown',
    ],
    maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
    supportsBatching: false,
    supportsStreaming: false,
  };

  constructor(private doclingClient: DoclingClient) {}

  async execute(input: StageInput): Promise<StageOutput> {
    const startTime = Date.now();

    // Get document from previous stage
    const document = input.data as { documentId: string; mimeType: string; content: Buffer };

    // Validate MIME type
    if (!this.capabilities.supportedMimeTypes?.includes(document.mimeType)) {
      throw new Error(
        `Unsupported MIME type: ${document.mimeType}. Supported: ${this.capabilities.supportedMimeTypes.join(', ')}`,
      );
    }

    // Call Docling API
    const result = await this.doclingClient.extract({
      content: document.content,
      mimeType: document.mimeType,
      options: {
        extractTables: input.config.extractTables ?? true,
        extractImages: input.config.extractImages ?? true,
        ocrFallback: input.config.ocrFallback ?? false,
      },
    });

    return {
      data: {
        text: result.text,
        markdown: result.markdown,
        tables: result.tables,
        images: result.images,
        metadata: result.metadata,
      },
      metrics: {
        durationMs: Date.now() - startTime,
        tokensUsed: 0, // Docling doesn't use tokens
        costUsd: 0, // Docling is free (self-hosted)
      },
    };
  }

  validate(config: StageConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    if (config.extractTables !== undefined && typeof config.extractTables !== 'boolean') {
      errors.push({
        code: 'INVALID_CONFIG',
        message: 'extractTables must be a boolean',
        field: 'extractTables',
      });
    }

    if (config.extractImages !== undefined && typeof config.extractImages !== 'boolean') {
      errors.push({
        code: 'INVALID_CONFIG',
        message: 'extractImages must be a boolean',
        field: 'extractImages',
      });
    }

    return errors;
  }

  async estimateCost(config: StageConfig): Promise<CostEstimate> {
    return {
      costPerDocumentUsd: 0, // Docling is free (self-hosted)
      costPer1000DocumentsUsd: 0,
    };
  }
}
```

---

## 10. Best Practices

### Registry Best Practices

1. **Use Map<string, T>** for storage (not array with find)
2. **Check duplicates** on register (throw or log)
3. **Return undefined vs throw** on get (use both patterns: `get()` throws, `has()` returns boolean)
4. **Provide list operations** (return all keys or values)
5. **Implement clear for testing** (reset state)
6. **Add logging** on register/unregister (audit trail)
7. **Consider TTL expiration** for dynamic registries
8. **Implement LRU eviction** if unbounded growth
9. **Use singleton pattern** for global registries
10. **Lazy instantiation** for expensive resources

### Provider Best Practices

1. **Interface-based design** (define interface first)
2. **Stateless execution** (no instance state between calls)
3. **Config in constructor** (inject dependencies)
4. **Async by default** (even if synchronous internally)
5. **Consistent error handling** (return safe fallback or throw)
6. **Detailed results** (include metadata, metrics)
7. **Version field** (for compatibility checks)
8. **Capabilities metadata** (describe what provider can do)
9. **Validation hooks** (validate config before execution)
10. **Cost estimation** (for LLM providers)

### Plugin Best Practices

1. **Pre/post hook pattern** (intercept before/after)
2. **Error isolation** (catch plugin errors, continue pipeline)
3. **Optional hooks** (plugins implement what they need)
4. **Context propagation** (use AsyncLocalStorage)
5. **Non-intrusive** (no changes to core code)
6. **Short-circuit capability** (preProcess can skip main logic)
7. **Transform capability** (postProcess can modify result)
8. **Register/unregister** (dynamic plugin management)
9. **Plugin ordering** (execute in registration order)
10. **Named plugins** (unique name per plugin)

---

## 11. Integration with Circuit Breakers

### Circuit Breaker per Provider

```typescript
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private breakers = new Map<string, RedisCircuitBreaker>();

  constructor(private redis: Redis) {}

  register(provider: Provider, breakerConfig?: Partial<CircuitBreakerConfig>): void {
    this.providers.set(provider.name, provider);

    // Create circuit breaker for this provider
    const breaker = new RedisCircuitBreaker(this.redis, 'provider', breakerConfig);
    this.breakers.set(provider.name, breaker);
  }

  async execute(providerName: string, input: Input): Promise<Output> {
    const provider = this.get(providerName);
    const breaker = this.breakers.get(providerName)!;

    return breaker.execute(providerName, async () => {
      return provider.execute(input);
    });
  }
}
```

**Benefits:**

- **Fault isolation** (one provider failure doesn't affect others)
- **Automatic fallback** (circuit breaker returns fast failure)
- **Metrics collection** (success/failure rates per provider)
- **Runtime config** (adjust thresholds per provider)

---

## Conclusion

**Key Decisions:**

1. ✅ Use **provider interface pattern** for pipeline stages
2. ✅ Implement **StageProviderRegistry** with circuit breakers
3. ✅ Use **Map<string, Provider>** for in-memory storage
4. ✅ Add **TTL and LRU eviction** for dynamic providers
5. ✅ Integrate **circuit breakers** per provider for fault tolerance
6. ✅ Support **config validation** and **cost estimation** hooks
7. ✅ Use **capabilities metadata** for stage compatibility checks
8. ✅ Follow **existing registry patterns** (ConnectorRegistry, GuardrailProviderRegistry)

**Next:** Proceed to Task #41 (Backend Design: Provider registry implementation) with this architecture.

---

**Analysis complete.** Ready for provider registry design.
