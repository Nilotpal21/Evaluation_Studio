# Pipeline Provider Registry Architecture

**Task:** Research #38 - Provider registry architecture patterns
**Status:** Complete
**Date:** 2026-03-07

---

## Executive Summary

This research document designs the provider registry architecture for SearchAI's pluggable pipeline system. It defines the **PipelineStageProvider** interface, **PipelineProviderRegistry** for discovery and lookup, and integration patterns with circuit breakers, cost estimation, and configuration management.

**Key Findings:**

1. **Unified Provider Interface:** All stage providers (extraction, enrichment, embedding, etc.) implement `PipelineStageProvider<TInput, TOutput, TConfig>`
2. **Type-Specific Registries:** Separate registries for each stage type (ExtractionProviderRegistry, EnrichmentProviderRegistry, etc.) with shared base
3. **Circuit Breaker Integration:** Providers wrapped with circuit breakers at registry level (automatic fault isolation)
4. **Provider Discovery:** REST API endpoints for Studio UI to discover available providers and their config schemas
5. **Configuration Validation:** JSON Schema-based validation of provider-specific config
6. **Cost Estimation:** Providers expose `estimateCost()` for UI cost preview
7. **Provider Versioning:** Semver-based versioning with backward compatibility checks

**Related Documents:**

- `docs/searchai/rfcs/ANALYSIS-provider-plugin-registry-patterns.md` - Pre-check analysis of existing registries
- `docs/searchai/rfcs/RESEARCH-circuit-breaker-flow-failures.md` - Circuit breaker integration
- `docs/searchai/rfcs/RFC-004-FLOW-BASED-ARCHITECTURE.md` - Pipeline architecture

---

## Table of Contents

1. [Provider Interface Design](#provider-interface-design)
2. [Registry Architecture](#registry-architecture)
3. [Provider Lifecycle](#provider-lifecycle)
4. [Configuration Management](#configuration-management)
5. [Provider Discovery](#provider-discovery)
6. [Circuit Breaker Integration](#circuit-breaker-integration)
7. [Cost Estimation](#cost-estimation)
8. [Provider Versioning](#provider-versioning)
9. [Built-in Providers](#built-in-providers)
10. [Testing Patterns](#testing-patterns)
11. [Implementation Checklist](#implementation-checklist)

---

## Provider Interface Design

### Base Provider Interface

```typescript
/**
 * Base interface for all pipeline stage providers.
 *
 * Providers are stateless, config-driven, and thread-safe.
 * All methods are async to support I/O-bound operations.
 *
 * @template TInput - Input data structure for this stage
 * @template TOutput - Output data structure for this stage
 * @template TConfig - Provider-specific configuration
 */
export interface PipelineStageProvider<TInput, TOutput, TConfig = Record<string, unknown>> {
  /** Unique provider identifier (e.g., 'docling', 'openai', 'bge-m3') */
  readonly id: string;

  /** Human-readable provider name (e.g., 'Docling Extraction', 'OpenAI GPT-4') */
  readonly name: string;

  /** Provider description for Studio UI */
  readonly description: string;

  /** Provider version (semver) */
  readonly version: string;

  /** Stage types this provider supports */
  readonly supportedStageTypes: PipelineStageType[];

  /** JSON Schema for provider configuration validation */
  readonly configSchema: JSONSchema;

  /**
   * Execute stage with given input and configuration.
   *
   * @param input - Stage input data
   * @param config - Provider-specific configuration
   * @param context - Execution context (tenant, document, trace)
   * @returns Stage output data
   * @throws {ProviderExecutionError} If execution fails
   */
  execute(input: TInput, config: TConfig, context: ExecutionContext): Promise<TOutput>;

  /**
   * Validate provider configuration.
   *
   * @param config - Configuration to validate
   * @returns Validation result with errors (if any)
   */
  validateConfig(config: TConfig): Promise<ValidationResult>;

  /**
   * Estimate execution cost for given input and configuration.
   *
   * Used by Studio UI for cost preview.
   *
   * @param input - Stage input data (or metadata)
   * @param config - Provider-specific configuration
   * @returns Estimated cost breakdown
   */
  estimateCost(input: TInput, config: TConfig): Promise<CostEstimate>;

  /**
   * Health check for provider.
   *
   * Used by monitoring system to detect provider issues.
   *
   * @returns Health status (healthy, degraded, unhealthy)
   */
  healthCheck(): Promise<HealthStatus>;
}
```

### Execution Context

```typescript
export interface ExecutionContext {
  /** Tenant ID (for tenant isolation, LLM credential resolution) */
  tenantId: string;

  /** Document ID being processed */
  documentId: string;

  /** Knowledge base ID */
  knowledgeBaseId: string;

  /** Pipeline ID */
  pipelineId: string;

  /** Flow ID */
  flowId: string;

  /** Stage ID */
  stageId: string;

  /** Trace ID (for distributed tracing) */
  traceId: string;

  /** Abort signal (for cancellation) */
  abortSignal?: AbortSignal;
}
```

### Cost Estimate

```typescript
export interface CostEstimate {
  /** Total estimated cost in USD */
  totalCost: number;

  /** Cost breakdown by component */
  breakdown: CostBreakdown[];

  /** Estimated duration in milliseconds */
  estimatedDurationMs: number;

  /** Confidence level (0.0 - 1.0) */
  confidence: number;
}

export interface CostBreakdown {
  /** Component name (e.g., 'LLM API Call', 'Token Processing') */
  component: string;

  /** Component cost in USD */
  cost: number;

  /** Unit (e.g., 'tokens', 'pages', 'API calls') */
  unit: string;

  /** Quantity (e.g., 1000 tokens, 5 pages) */
  quantity: number;
}
```

### Health Status

```typescript
export interface HealthStatus {
  /** Overall status */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** Last check timestamp */
  lastCheckAt: Date;

  /** Error message (if unhealthy) */
  error?: string;

  /** Additional details */
  details?: Record<string, unknown>;
}
```

---

## Registry Architecture

### Type-Specific Registries

Each stage type has its own registry with type-safe provider interfaces:

```typescript
/**
 * Extraction Provider Interface
 */
export interface ExtractionProvider extends PipelineStageProvider<
  ExtractionInput,
  ExtractionOutput,
  ExtractionConfig
> {
  supportedStageTypes: ['extraction'];
}

export interface ExtractionInput {
  documentId: string;
  sourceUrl: string;
  contentType: string;
}

export interface ExtractionOutput {
  extractedText: string;
  metadata: Record<string, unknown>;
  pageCount?: number;
}

export interface ExtractionConfig {
  extractTables?: boolean;
  extractImages?: boolean;
  ocrEnabled?: boolean;
  language?: string;
}
```

```typescript
/**
 * Enrichment Provider Interface
 */
export interface EnrichmentProvider extends PipelineStageProvider<
  EnrichmentInput,
  EnrichmentOutput,
  EnrichmentConfig
> {
  supportedStageTypes: ['enrichment'];
}

export interface EnrichmentInput {
  text: string;
  chunkId: string;
  documentId: string;
}

export interface EnrichmentOutput {
  entities?: Entity[];
  summary?: string;
  keywords?: string[];
  classification?: Classification;
}

export interface EnrichmentConfig {
  useCase: 'entityExtraction' | 'summarization' | 'questionSynthesis' | 'knowledgeGraph';
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
```

```typescript
/**
 * Embedding Provider Interface
 */
export interface EmbeddingProvider extends PipelineStageProvider<
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingConfig
> {
  supportedStageTypes: ['embedding'];
}

export interface EmbeddingInput {
  texts: string[]; // Batch embedding support
  chunkIds: string[];
}

export interface EmbeddingOutput {
  embeddings: number[][]; // Array of embedding vectors
  dimensions: number;
}

export interface EmbeddingConfig {
  model: string;
  dimensions?: number;
  batchSize?: number;
}
```

### Base Registry Implementation

```typescript
import { Redis } from 'ioredis';
import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';
import { createLogger } from '@abl/compiler/platform';

/**
 * Base registry for pipeline stage providers.
 *
 * Provides:
 * - Provider registration and lookup
 * - Circuit breaker integration
 * - Health monitoring
 * - Configuration validation
 */
export class PipelineProviderRegistry<TProvider extends PipelineStageProvider<any, any, any>> {
  private logger = createLogger('pipeline-provider-registry');
  private providers = new Map<string, TProvider>();
  private breakers = new Map<string, RedisCircuitBreaker>();
  private healthCache = new Map<string, { status: HealthStatus; cachedAt: number }>();

  constructor(
    private redis: Redis,
    private stageType: PipelineStageType,
  ) {}

  /**
   * Register a provider.
   *
   * @param provider - Provider instance to register
   * @throws {Error} If provider already registered
   */
  register(provider: TProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }

    // Create circuit breaker for this provider
    const breaker = new RedisCircuitBreaker(this.redis, 'pipeline_provider', {
      failureThreshold: 10,
      resetTimeout: 60_000,
      successThreshold: 2,
      monitorWindow: 30_000,
      halfOpenMaxConcurrent: 1,
      failureRateThreshold: 40,
      minimumRequestCount: 5,
    });

    this.providers.set(provider.id, provider);
    this.breakers.set(provider.id, breaker);

    this.logger.info('Provider registered', {
      providerId: provider.id,
      providerName: provider.name,
      version: provider.version,
      stageType: this.stageType,
    });
  }

  /**
   * Get provider by ID.
   *
   * @param providerId - Provider identifier
   * @returns Provider instance
   * @throws {Error} If provider not found
   */
  get(providerId: string): TProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }
    return provider;
  }

  /**
   * Check if provider exists.
   */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /**
   * List all registered providers.
   */
  list(): TProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Execute provider with circuit breaker protection.
   *
   * @param providerId - Provider identifier
   * @param input - Stage input
   * @param config - Provider configuration
   * @param context - Execution context
   * @returns Stage output
   * @throws {CircuitOpenError} If circuit breaker is open
   * @throws {ProviderExecutionError} If execution fails
   */
  async execute<TInput, TOutput, TConfig>(
    providerId: string,
    input: TInput,
    config: TConfig,
    context: ExecutionContext,
  ): Promise<TOutput> {
    const provider = this.get(providerId);
    const breaker = this.breakers.get(providerId);

    if (!breaker) {
      throw new Error(`Circuit breaker not found for provider: ${providerId}`);
    }

    // Execute with circuit breaker protection
    const breakerKey = `${context.tenantId}:${providerId}`;

    try {
      return await breaker.execute(breakerKey, async () => {
        return await provider.execute(input, config, context);
      });
    } catch (error) {
      this.logger.error('Provider execution failed', {
        providerId,
        tenantId: context.tenantId,
        documentId: context.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get provider health status (cached for 1 minute).
   */
  async getHealth(providerId: string): Promise<HealthStatus> {
    const cached = this.healthCache.get(providerId);
    if (cached && Date.now() - cached.cachedAt < 60_000) {
      return cached.status;
    }

    const provider = this.get(providerId);

    try {
      const status = await provider.healthCheck();
      this.healthCache.set(providerId, { status, cachedAt: Date.now() });
      return status;
    } catch (error) {
      const status: HealthStatus = {
        status: 'unhealthy',
        lastCheckAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.healthCache.set(providerId, { status, cachedAt: Date.now() });
      return status;
    }
  }

  /**
   * Get circuit breaker for provider (for manual control).
   */
  getCircuitBreaker(providerId: string): RedisCircuitBreaker {
    const breaker = this.breakers.get(providerId);
    if (!breaker) {
      throw new Error(`Circuit breaker not found for provider: ${providerId}`);
    }
    return breaker;
  }

  /**
   * Clear all providers (for testing).
   */
  clear(): void {
    this.providers.clear();
    this.breakers.clear();
    this.healthCache.clear();
  }
}
```

### Type-Specific Registry Instances

```typescript
// Extraction provider registry
export class ExtractionProviderRegistry extends PipelineProviderRegistry<ExtractionProvider> {
  constructor(redis: Redis) {
    super(redis, 'extraction');
  }
}

// Enrichment provider registry
export class EnrichmentProviderRegistry extends PipelineProviderRegistry<EnrichmentProvider> {
  constructor(redis: Redis) {
    super(redis, 'enrichment');
  }
}

// Embedding provider registry
export class EmbeddingProviderRegistry extends PipelineProviderRegistry<EmbeddingProvider> {
  constructor(redis: Redis) {
    super(redis, 'embedding');
  }
}

// Chunking provider registry
export class ChunkingProviderRegistry extends PipelineProviderRegistry<ChunkingProvider> {
  constructor(redis: Redis) {
    super(redis, 'chunking');
  }
}

// Knowledge graph provider registry
export class KnowledgeGraphProviderRegistry extends PipelineProviderRegistry<KnowledgeGraphProvider> {
  constructor(redis: Redis) {
    super(redis, 'knowledge-graph');
  }
}

// Multimodal provider registry
export class MultimodalProviderRegistry extends PipelineProviderRegistry<MultimodalProvider> {
  constructor(redis: Redis) {
    super(redis, 'multimodal');
  }
}
```

### Unified Registry Manager

```typescript
/**
 * Manages all pipeline provider registries.
 *
 * Provides unified access to all stage-specific registries.
 */
export class PipelineProviderManager {
  public readonly extraction: ExtractionProviderRegistry;
  public readonly enrichment: EnrichmentProviderRegistry;
  public readonly embedding: EmbeddingProviderRegistry;
  public readonly chunking: ChunkingProviderRegistry;
  public readonly knowledgeGraph: KnowledgeGraphProviderRegistry;
  public readonly multimodal: MultimodalProviderRegistry;

  constructor(redis: Redis) {
    this.extraction = new ExtractionProviderRegistry(redis);
    this.enrichment = new EnrichmentProviderRegistry(redis);
    this.embedding = new EmbeddingProviderRegistry(redis);
    this.chunking = new ChunkingProviderRegistry(redis);
    this.knowledgeGraph = new KnowledgeGraphProviderRegistry(redis);
    this.multimodal = new MultimodalProviderRegistry(redis);
  }

  /**
   * Get registry for stage type.
   */
  getRegistryForStageType(stageType: PipelineStageType): PipelineProviderRegistry<any> {
    const REGISTRY_MAP: Record<PipelineStageType, PipelineProviderRegistry<any>> = {
      extraction: this.extraction,
      enrichment: this.enrichment,
      embedding: this.embedding,
      chunking: this.chunking,
      'knowledge-graph': this.knowledgeGraph,
      multimodal: this.multimodal,
    };

    const registry = REGISTRY_MAP[stageType];
    if (!registry) {
      throw new Error(`No registry found for stage type: ${stageType}`);
    }

    return registry;
  }

  /**
   * Execute provider for given stage type.
   */
  async execute(
    stageType: PipelineStageType,
    providerId: string,
    input: any,
    config: any,
    context: ExecutionContext,
  ): Promise<any> {
    const registry = this.getRegistryForStageType(stageType);
    return await registry.execute(providerId, input, config, context);
  }
}
```

---

## Provider Lifecycle

### Provider Registration (Startup)

```typescript
/**
 * Register all built-in providers on application startup.
 */
export async function registerBuiltinProviders(manager: PipelineProviderManager): Promise<void> {
  // Extraction providers
  manager.extraction.register(new DoclingExtractionProvider());
  manager.extraction.register(new LlamaIndexExtractionProvider());
  manager.extraction.register(new PyPDFExtractionProvider());

  // Enrichment providers
  manager.enrichment.register(new OpenAIEnrichmentProvider());
  manager.enrichment.register(new AnthropicEnrichmentProvider());
  manager.enrichment.register(new GeminiEnrichmentProvider());

  // Embedding providers
  manager.embedding.register(new BGEM3EmbeddingProvider());
  manager.embedding.register(new OpenAIEmbeddingProvider());
  manager.embedding.register(new VoyageEmbeddingProvider());

  // Chunking providers
  manager.chunking.register(new TreeBuilderChunkingProvider());
  manager.chunking.register(new MarkdownChunkingProvider());
  manager.chunking.register(new TokenBasedChunkingProvider());

  // Knowledge graph providers
  manager.knowledgeGraph.register(new Neo4jKnowledgeGraphProvider());

  // Multimodal providers
  manager.multimodal.register(new OpenAIVisionProvider());
  manager.multimodal.register(new GeminiVisionProvider());
}
```

### Provider Health Monitoring

```typescript
/**
 * Background health check for all providers.
 *
 * Runs every 5 minutes, checks health of all providers, emits metrics.
 */
export class ProviderHealthMonitor {
  private logger = createLogger('provider-health-monitor');
  private intervalId?: NodeJS.Timeout;

  constructor(
    private manager: PipelineProviderManager,
    private metrics: MetricsClient,
  ) {}

  start(): void {
    this.intervalId = setInterval(
      async () => {
        await this.checkAllProviders();
      },
      300_000, // 5 minutes
    );

    this.logger.info('Provider health monitor started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.logger.info('Provider health monitor stopped');
  }

  private async checkAllProviders(): Promise<void> {
    const registries = [
      { type: 'extraction', registry: this.manager.extraction },
      { type: 'enrichment', registry: this.manager.enrichment },
      { type: 'embedding', registry: this.manager.embedding },
      { type: 'chunking', registry: this.manager.chunking },
      { type: 'knowledge-graph', registry: this.manager.knowledgeGraph },
      { type: 'multimodal', registry: this.manager.multimodal },
    ];

    for (const { type, registry } of registries) {
      const providers = registry.list();

      for (const provider of providers) {
        try {
          const health = await registry.getHealth(provider.id);

          // Emit metrics
          this.metrics.gauge('pipeline.provider.health', health.status === 'healthy' ? 1 : 0, {
            stage_type: type,
            provider_id: provider.id,
            provider_name: provider.name,
            status: health.status,
          });

          // Log unhealthy providers
          if (health.status !== 'healthy') {
            this.logger.warn('Provider unhealthy', {
              stageType: type,
              providerId: provider.id,
              providerName: provider.name,
              status: health.status,
              error: health.error,
            });
          }
        } catch (error) {
          this.logger.error('Provider health check failed', {
            stageType: type,
            providerId: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
```

---

## Configuration Management

### Configuration Validation

Each provider defines a JSON Schema for its configuration:

```typescript
export class DoclingExtractionProvider implements ExtractionProvider {
  readonly id = 'docling';
  readonly name = 'Docling Extraction';
  readonly description = 'Extract text, tables, and images from PDFs using IBM Docling';
  readonly version = '1.0.0';
  readonly supportedStageTypes = ['extraction'] as const;

  // JSON Schema for configuration validation
  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      extractTables: {
        type: 'boolean',
        default: true,
        description: 'Extract tables from PDF',
      },
      extractImages: {
        type: 'boolean',
        default: false,
        description: 'Extract images from PDF',
      },
      ocrEnabled: {
        type: 'boolean',
        default: false,
        description: 'Enable OCR for scanned PDFs',
      },
      language: {
        type: 'string',
        enum: ['en', 'es', 'fr', 'de', 'zh', 'ja'],
        default: 'en',
        description: 'Document language for OCR',
      },
      timeout: {
        type: 'number',
        minimum: 1000,
        maximum: 600000,
        default: 120000,
        description: 'Extraction timeout in milliseconds',
      },
    },
    required: [],
    additionalProperties: false,
  };

  async validateConfig(config: ExtractionConfig): Promise<ValidationResult> {
    // Use Ajv for JSON Schema validation
    const ajv = new Ajv();
    const validate = ajv.compile(this.configSchema);
    const valid = validate(config);

    if (!valid) {
      return {
        valid: false,
        errors: validate.errors?.map((err) => ({
          field: err.instancePath,
          message: err.message || 'Invalid value',
        })),
      };
    }

    return { valid: true };
  }

  // ... other methods
}
```

### Configuration Resolution

Configuration comes from multiple sources with precedence:

1. **Stage-level config** (highest priority) - User-defined in Studio
2. **Flow-level config** - Flow-wide defaults
3. **Pipeline-level config** - Pipeline-wide defaults
4. **Provider defaults** - From JSON Schema

```typescript
/**
 * Resolve provider configuration with precedence.
 */
export function resolveProviderConfig<TConfig>(
  provider: PipelineStageProvider<any, any, TConfig>,
  stage: PipelineStage,
  flow: PipelineFlow,
  pipeline: PipelineDefinition,
): TConfig {
  // Start with provider defaults (from JSON Schema)
  const defaults = extractDefaults(provider.configSchema);

  // Merge pipeline-level config (if exists)
  const pipelineConfig = pipeline.providerDefaults?.[provider.id] || {};

  // Merge flow-level config (if exists)
  const flowConfig = flow.providerDefaults?.[provider.id] || {};

  // Merge stage-level config (highest priority)
  const stageConfig = stage.providerConfig || {};

  // Merge with precedence: defaults < pipeline < flow < stage
  return {
    ...defaults,
    ...pipelineConfig,
    ...flowConfig,
    ...stageConfig,
  } as TConfig;
}

/**
 * Extract default values from JSON Schema.
 */
function extractDefaults(schema: JSONSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if ('default' in propSchema) {
        defaults[key] = propSchema.default;
      }
    }
  }

  return defaults;
}
```

---

## Provider Discovery

### Discovery API for Studio UI

```typescript
import { Router } from 'express';
import { requireAuth } from '@abl/compiler/platform';

/**
 * Provider discovery API.
 *
 * Used by Studio UI to:
 * - List available providers by stage type
 * - Get provider configuration schema (for dynamic form generation)
 * - Get provider metadata (name, description, version)
 */
export function createProviderDiscoveryRouter(providerManager: PipelineProviderManager): Router {
  const router = Router();

  /**
   * GET /api/pipelines/providers/:stageType
   *
   * List all providers for a stage type.
   */
  router.get('/providers/:stageType', requireAuth, async (req, res) => {
    const { stageType } = req.params;

    if (!isValidStageType(stageType)) {
      return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
    }

    try {
      const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
      const providers = registry.list();

      const result = providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        version: provider.version,
        supportedStageTypes: provider.supportedStageTypes,
      }));

      res.json({ providers: result });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/pipelines/providers/:stageType/:providerId/schema
   *
   * Get provider configuration schema.
   */
  router.get('/providers/:stageType/:providerId/schema', requireAuth, async (req, res) => {
    const { stageType, providerId } = req.params;

    if (!isValidStageType(stageType)) {
      return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
    }

    try {
      const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
      const provider = registry.get(providerId);

      res.json({
        providerId: provider.id,
        configSchema: provider.configSchema,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/pipelines/providers/:stageType/:providerId/health
   *
   * Get provider health status.
   */
  router.get('/providers/:stageType/:providerId/health', requireAuth, async (req, res) => {
    const { stageType, providerId } = req.params;

    if (!isValidStageType(stageType)) {
      return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
    }

    try {
      const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
      const health = await registry.getHealth(providerId);

      res.json({ providerId, health });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/pipelines/providers/:stageType/:providerId/validate-config
   *
   * Validate provider configuration.
   */
  router.post(
    '/providers/:stageType/:providerId/validate-config',
    requireAuth,
    async (req, res) => {
      const { stageType, providerId } = req.params;
      const { config } = req.body;

      if (!isValidStageType(stageType)) {
        return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
      }

      try {
        const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
        const provider = registry.get(providerId);

        const result = await provider.validateConfig(config);

        res.json({ providerId, validation: result });
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          return res.status(404).json({ error: error.message });
        }
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  return router;
}
```

### Studio UI Integration

```typescript
// Studio UI: Fetch available providers for stage type
async function fetchProvidersForStageType(stageType: PipelineStageType): Promise<Provider[]> {
  const response = await fetch(`/api/pipelines/providers/${stageType}`, {
    headers: { Authorization: `Bearer ${getAuthToken()}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch providers: ${response.statusText}`);
  }

  const data = await response.json();
  return data.providers;
}

// Studio UI: Fetch provider config schema (for dynamic form generation)
async function fetchProviderConfigSchema(
  stageType: PipelineStageType,
  providerId: string,
): Promise<JSONSchema> {
  const response = await fetch(`/api/pipelines/providers/${stageType}/${providerId}/schema`, {
    headers: { Authorization: `Bearer ${getAuthToken()}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.statusText}`);
  }

  const data = await response.json();
  return data.configSchema;
}

// Studio UI: Validate config before saving
async function validateProviderConfig(
  stageType: PipelineStageType,
  providerId: string,
  config: Record<string, unknown>,
): Promise<ValidationResult> {
  const response = await fetch(
    `/api/pipelines/providers/${stageType}/${providerId}/validate-config`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ config }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to validate config: ${response.statusText}`);
  }

  const data = await response.json();
  return data.validation;
}
```

---

## Circuit Breaker Integration

Circuit breaker integration happens automatically at the registry level. Providers don't need circuit breaker logic.

### Automatic Circuit Breaker Wrapping

```typescript
// When provider is registered, circuit breaker is created
manager.extraction.register(new DoclingExtractionProvider());

// When executing provider, circuit breaker is automatically used
await manager.extraction.execute('docling', input, config, context);

// Circuit breaker wraps the execute() call
// If circuit is open, throws CircuitOpenError immediately
// If circuit is closed/half-open, executes provider and records result
```

### Circuit Breaker State API

```typescript
/**
 * GET /api/pipelines/providers/:stageType/:providerId/circuit-breaker
 *
 * Get circuit breaker state for provider.
 */
router.get('/providers/:stageType/:providerId/circuit-breaker', requireAuth, async (req, res) => {
  const { stageType, providerId } = req.params;
  const { tenantId } = req.query;

  if (!isValidStageType(stageType)) {
    return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenantId query parameter' });
  }

  try {
    const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
    const breaker = registry.getCircuitBreaker(providerId);

    const breakerKey = `${tenantId}:${providerId}`;
    const checkResult = await breaker.checkState(breakerKey);
    const metrics = await breaker.getMetrics(breakerKey);

    res.json({
      providerId,
      tenantId,
      state: checkResult.state,
      canExecute: checkResult.canExecute,
      retryAfterMs: checkResult.retryAfterMs,
      metrics,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/pipelines/providers/:stageType/:providerId/circuit-breaker/reset
 *
 * Manually reset circuit breaker (admin only).
 */
router.post(
  '/providers/:stageType/:providerId/circuit-breaker/reset',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { stageType, providerId } = req.params;
    const { tenantId } = req.body;

    if (!isValidStageType(stageType)) {
      return res.status(400).json({ error: `Invalid stage type: ${stageType}` });
    }

    try {
      const registry = providerManager.getRegistryForStageType(stageType as PipelineStageType);
      const breaker = registry.getCircuitBreaker(providerId);

      const breakerKey = `${tenantId}:${providerId}`;
      await breaker.reset(breakerKey);

      res.json({ success: true, providerId, tenantId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);
```

---

## Cost Estimation

### Provider Cost Estimation

Each provider implements `estimateCost()` for UI cost preview:

```typescript
export class OpenAIEnrichmentProvider implements EnrichmentProvider {
  // ... other methods

  async estimateCost(input: EnrichmentInput, config: EnrichmentConfig): Promise<CostEstimate> {
    const model = config.model || 'gpt-4';

    // Estimate token count (rough estimate: 1 token ~= 4 characters)
    const inputTokens = Math.ceil(input.text.length / 4);

    // Output tokens depend on use case
    const outputTokens = this.estimateOutputTokens(config.useCase);

    // OpenAI pricing (as of 2026-03-07)
    const PRICING: Record<string, { input: number; output: number }> = {
      'gpt-4': { input: 0.03 / 1000, output: 0.06 / 1000 },
      'gpt-4-turbo': { input: 0.01 / 1000, output: 0.03 / 1000 },
      'gpt-3.5-turbo': { input: 0.0005 / 1000, output: 0.0015 / 1000 },
    };

    const pricing = PRICING[model] || PRICING['gpt-4'];

    const inputCost = inputTokens * pricing.input;
    const outputCost = outputTokens * pricing.output;
    const totalCost = inputCost + outputCost;

    // Estimate duration (based on model and token count)
    const estimatedDurationMs = this.estimateDuration(model, inputTokens + outputTokens);

    return {
      totalCost,
      breakdown: [
        {
          component: 'Input Tokens',
          cost: inputCost,
          unit: 'tokens',
          quantity: inputTokens,
        },
        {
          component: 'Output Tokens',
          cost: outputCost,
          unit: 'tokens',
          quantity: outputTokens,
        },
      ],
      estimatedDurationMs,
      confidence: 0.8, // 80% confidence (estimates can vary)
    };
  }

  private estimateOutputTokens(useCase: string): number {
    const USE_CASE_TOKENS: Record<string, number> = {
      entityExtraction: 500,
      summarization: 200,
      questionSynthesis: 300,
      knowledgeGraph: 1000,
    };

    return USE_CASE_TOKENS[useCase] || 500;
  }

  private estimateDuration(model: string, totalTokens: number): number {
    // GPT-4: ~50 tokens/second, GPT-3.5: ~150 tokens/second
    const TOKENS_PER_SECOND: Record<string, number> = {
      'gpt-4': 50,
      'gpt-4-turbo': 100,
      'gpt-3.5-turbo': 150,
    };

    const tokensPerSecond = TOKENS_PER_SECOND[model] || 50;
    const seconds = totalTokens / tokensPerSecond;

    // Add API overhead (200ms)
    return Math.ceil(seconds * 1000 + 200);
  }
}
```

### Cost Estimation API

```typescript
/**
 * POST /api/pipelines/:pipelineId/estimate-cost
 *
 * Estimate total cost for processing a document through a pipeline.
 */
router.post('/pipelines/:pipelineId/estimate-cost', requireAuth, async (req, res) => {
  const { pipelineId } = req.params;
  const { documentMetadata } = req.body; // { contentType, sizeBytes, pageCount, etc. }

  try {
    const pipeline = await PipelineDefinition.findById(pipelineId);
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    // Select flow based on document metadata
    const selectedFlow = selectFlow(pipeline, documentMetadata);

    // Resolve stages
    const stages = resolveStages(selectedFlow, pipeline);

    // Estimate cost for each stage
    const stageEstimates: Array<{
      stageId: string;
      stageName: string;
      providerId: string;
      estimate: CostEstimate;
    }> = [];

    for (const stage of stages) {
      const registry = providerManager.getRegistryForStageType(stage.type);
      const provider = registry.get(stage.provider);

      // Build mock input for cost estimation
      const input = buildMockInput(stage.type, documentMetadata);

      // Resolve config
      const config = resolveProviderConfig(provider, stage, selectedFlow, pipeline);

      // Estimate cost
      const estimate = await provider.estimateCost(input, config);

      stageEstimates.push({
        stageId: stage.id,
        stageName: stage.name,
        providerId: stage.provider,
        estimate,
      });
    }

    // Aggregate total cost
    const totalCost = stageEstimates.reduce((sum, s) => sum + s.estimate.totalCost, 0);
    const totalDuration = stageEstimates.reduce(
      (sum, s) => sum + s.estimate.estimatedDurationMs,
      0,
    );

    res.json({
      pipelineId,
      flowId: selectedFlow.id,
      totalCost,
      totalDurationMs: totalDuration,
      stages: stageEstimates,
      confidence: Math.min(...stageEstimates.map((s) => s.estimate.confidence)),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
```

---

## Provider Versioning

### Semantic Versioning

Providers use semver for versioning:

```typescript
export class DoclingExtractionProvider implements ExtractionProvider {
  readonly version = '1.2.3'; // major.minor.patch

  // Breaking changes: Increment major version (e.g., 1.x.x → 2.0.0)
  // New features (backward compatible): Increment minor version (e.g., 1.0.x → 1.1.0)
  // Bug fixes: Increment patch version (e.g., 1.0.0 → 1.0.1)
}
```

### Version Compatibility Checks

```typescript
/**
 * Check if pipeline is compatible with current provider versions.
 */
export function checkProviderVersionCompatibility(
  pipeline: PipelineDefinition,
  providerManager: PipelineProviderManager,
): CompatibilityResult {
  const issues: CompatibilityIssue[] = [];

  for (const flow of pipeline.flows) {
    for (const stage of flow.stages) {
      try {
        const registry = providerManager.getRegistryForStageType(stage.type);
        const provider = registry.get(stage.provider);

        // Check if stage specifies a required version
        if (stage.requiredProviderVersion) {
          const required = stage.requiredProviderVersion;
          const actual = provider.version;

          // Use semver library for comparison
          if (!satisfiesVersion(actual, required)) {
            issues.push({
              severity: 'error',
              stageId: stage.id,
              providerId: stage.provider,
              message: `Provider version ${actual} does not satisfy required version ${required}`,
              requiredVersion: required,
              actualVersion: actual,
            });
          }
        }
      } catch (error) {
        issues.push({
          severity: 'error',
          stageId: stage.id,
          providerId: stage.provider,
          message: error instanceof Error ? error.message : 'Provider not found',
        });
      }
    }
  }

  return {
    compatible: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
```

---

## Built-in Providers

### Extraction Providers

**Docling** (IBM Research)

- **Supported formats:** PDF
- **Features:** Table extraction, image extraction, OCR
- **Config:** `extractTables`, `extractImages`, `ocrEnabled`, `language`

**LlamaIndex**

- **Supported formats:** PDF, HTML, Markdown, DOCX
- **Features:** Multi-format support, metadata extraction
- **Config:** `chunkSize`, `chunkOverlap`

**PyPDF**

- **Supported formats:** PDF
- **Features:** Basic text extraction (fast, no external dependencies)
- **Config:** `pages` (page range)

### Enrichment Providers

**OpenAI**

- **Models:** GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
- **Use cases:** Entity extraction, summarization, question synthesis, knowledge graph
- **Config:** `model`, `temperature`, `maxTokens`, `useCase`

**Anthropic**

- **Models:** Claude 3 Opus, Claude 3 Sonnet, Claude 3 Haiku
- **Use cases:** Entity extraction, summarization, question synthesis
- **Config:** `model`, `temperature`, `maxTokens`, `useCase`

**Google Gemini**

- **Models:** Gemini 1.5 Pro, Gemini 1.5 Flash
- **Use cases:** Entity extraction, summarization
- **Config:** `model`, `temperature`, `maxTokens`, `useCase`

### Embedding Providers

**BGE-M3** (self-hosted)

- **Model:** BAAI/bge-m3
- **Dimensions:** 1024
- **Features:** Multi-lingual, fast, no API costs
- **Config:** `batchSize`, `dimensions`

**OpenAI Embeddings**

- **Models:** text-embedding-3-small, text-embedding-3-large
- **Dimensions:** 512, 1536, 3072 (configurable)
- **Config:** `model`, `dimensions`, `batchSize`

**Voyage AI**

- **Models:** voyage-large-2, voyage-code-2
- **Dimensions:** 1024, 1536
- **Config:** `model`, `dimensions`, `batchSize`

### Chunking Providers

**Tree Builder** (semantic chunking)

- **Strategy:** Hierarchical tree-based chunking
- **Features:** Preserves document structure, semantic boundaries
- **Config:** `targetChunkSize`, `minChunkSize`, `maxChunkSize`

**Token-Based**

- **Strategy:** Fixed token count with overlap
- **Features:** Fast, predictable chunk sizes
- **Config:** `chunkSize`, `overlap`

**Markdown-Aware**

- **Strategy:** Chunk at markdown heading boundaries
- **Features:** Preserves markdown structure
- **Config:** `targetChunkSize`, `respectHeadings`

### Knowledge Graph Providers

**Neo4j**

- **Features:** Entity extraction, relationship extraction, graph construction
- **Config:** `connectionUri`, `database`, `extractRelationships`, `relationshipTypes`

### Multimodal Providers

**OpenAI Vision**

- **Models:** gpt-4-vision-preview, gpt-4o
- **Features:** Image analysis, OCR, scene description
- **Config:** `model`, `maxTokens`, `detail`

**Google Gemini Vision**

- **Models:** gemini-1.5-pro, gemini-1.5-flash
- **Features:** Image analysis, OCR
- **Config:** `model`, `maxTokens`

---

## Testing Patterns

### Provider Unit Tests

```typescript
describe('DoclingExtractionProvider', () => {
  let provider: DoclingExtractionProvider;

  beforeEach(() => {
    provider = new DoclingExtractionProvider();
  });

  describe('execute', () => {
    it('should extract text from PDF', async () => {
      const input: ExtractionInput = {
        documentId: 'doc-123',
        sourceUrl: 's3://test-bucket/test.pdf',
        contentType: 'application/pdf',
      };

      const config: ExtractionConfig = {
        extractTables: true,
        extractImages: false,
        ocrEnabled: false,
      };

      const context: ExecutionContext = {
        tenantId: 'tenant-123',
        documentId: 'doc-123',
        knowledgeBaseId: 'kb-456',
        pipelineId: 'pipeline-789',
        flowId: 'flow-001',
        stageId: 'stage-1',
        traceId: 'trace-001',
      };

      const result = await provider.execute(input, config, context);

      expect(result.extractedText).toBeDefined();
      expect(result.extractedText.length).toBeGreaterThan(0);
      expect(result.pageCount).toBeGreaterThan(0);
    });

    it('should handle extraction errors gracefully', async () => {
      const input: ExtractionInput = {
        documentId: 'doc-123',
        sourceUrl: 's3://test-bucket/corrupted.pdf',
        contentType: 'application/pdf',
      };

      await expect(provider.execute(input, {}, mockContext)).rejects.toThrow(
        ProviderExecutionError,
      );
    });
  });

  describe('validateConfig', () => {
    it('should validate valid config', async () => {
      const config: ExtractionConfig = {
        extractTables: true,
        extractImages: false,
        language: 'en',
      };

      const result = await provider.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject invalid config', async () => {
      const config = {
        extractTables: 'invalid', // should be boolean
        language: 'invalid', // not in enum
      };

      const result = await provider.validateConfig(config as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost for PDF extraction', async () => {
      const input: ExtractionInput = {
        documentId: 'doc-123',
        sourceUrl: 's3://test-bucket/test.pdf',
        contentType: 'application/pdf',
      };

      const config: ExtractionConfig = {
        extractTables: true,
      };

      const estimate = await provider.estimateCost(input, config);

      expect(estimate.totalCost).toBeGreaterThan(0);
      expect(estimate.breakdown).toHaveLength(1);
      expect(estimate.estimatedDurationMs).toBeGreaterThan(0);
      expect(estimate.confidence).toBeGreaterThan(0);
      expect(estimate.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status when service is up', async () => {
      const health = await provider.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.lastCheckAt).toBeDefined();
    });

    it('should return unhealthy status when service is down', async () => {
      // Mock service down
      jest
        .spyOn(provider as any, 'checkDoclingService')
        .mockRejectedValue(new Error('Connection refused'));

      const health = await provider.healthCheck();

      expect(health.status).toBe('unhealthy');
      expect(health.error).toBeDefined();
    });
  });
});
```

### Registry Integration Tests

```typescript
describe('ExtractionProviderRegistry', () => {
  let redis: Redis;
  let registry: ExtractionProviderRegistry;

  beforeAll(() => {
    redis = getRedisConnection();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(() => {
    registry = new ExtractionProviderRegistry(redis);
  });

  afterEach(() => {
    registry.clear();
  });

  describe('register', () => {
    it('should register provider', () => {
      const provider = new DoclingExtractionProvider();

      registry.register(provider);

      expect(registry.has('docling')).toBe(true);
      expect(registry.get('docling')).toBe(provider);
    });

    it('should throw on duplicate registration', () => {
      const provider = new DoclingExtractionProvider();

      registry.register(provider);

      expect(() => registry.register(provider)).toThrow('already registered');
    });
  });

  describe('execute with circuit breaker', () => {
    it('should execute provider successfully', async () => {
      const provider = new DoclingExtractionProvider();
      registry.register(provider);

      const input: ExtractionInput = {
        documentId: 'doc-123',
        sourceUrl: 's3://test-bucket/test.pdf',
        contentType: 'application/pdf',
      };

      const result = await registry.execute('docling', input, {}, mockContext);

      expect(result.extractedText).toBeDefined();
    });

    it('should record success with circuit breaker', async () => {
      const provider = new DoclingExtractionProvider();
      registry.register(provider);

      await registry.execute('docling', mockInput, {}, mockContext);

      const breaker = registry.getCircuitBreaker('docling');
      const metrics = await breaker.getMetrics(`${mockContext.tenantId}:docling`);

      expect(metrics.successCount).toBeGreaterThan(0);
    });

    it('should record failure with circuit breaker', async () => {
      const provider = new DoclingExtractionProvider();
      jest.spyOn(provider, 'execute').mockRejectedValue(new Error('Extraction failed'));

      registry.register(provider);

      await expect(registry.execute('docling', mockInput, {}, mockContext)).rejects.toThrow(
        'Extraction failed',
      );

      const breaker = registry.getCircuitBreaker('docling');
      const metrics = await breaker.getMetrics(`${mockContext.tenantId}:docling`);

      expect(metrics.failureCount).toBeGreaterThan(0);
    });

    it('should throw CircuitOpenError when circuit is open', async () => {
      const provider = new DoclingExtractionProvider();
      registry.register(provider);

      // Fail provider 10 times to open circuit
      jest.spyOn(provider, 'execute').mockRejectedValue(new Error('Service unavailable'));

      for (let i = 0; i < 10; i++) {
        try {
          await registry.execute('docling', mockInput, {}, mockContext);
        } catch {
          // Expected
        }
      }

      // Circuit should be open now
      await expect(registry.execute('docling', mockInput, {}, mockContext)).rejects.toThrow(
        CircuitOpenError,
      );
    });
  });
});
```

---

## Implementation Checklist

### Phase 1: Provider Interface & Base Registry (Week 1)

- [ ] Define `PipelineStageProvider` interface
  - [ ] Base interface with type parameters
  - [ ] `execute()`, `validateConfig()`, `estimateCost()`, `healthCheck()` methods
  - [ ] `ExecutionContext`, `CostEstimate`, `HealthStatus` types

- [ ] Define stage-specific provider interfaces
  - [ ] `ExtractionProvider`
  - [ ] `EnrichmentProvider`
  - [ ] `EmbeddingProvider`
  - [ ] `ChunkingProvider`
  - [ ] `KnowledgeGraphProvider`
  - [ ] `MultimodalProvider`

- [ ] Create `PipelineProviderRegistry` base class
  - [ ] Provider registration
  - [ ] Provider lookup
  - [ ] Circuit breaker integration
  - [ ] Health check caching

- [ ] Create type-specific registries
  - [ ] `ExtractionProviderRegistry`
  - [ ] `EnrichmentProviderRegistry`
  - [ ] `EmbeddingProviderRegistry`
  - [ ] `ChunkingProviderRegistry`
  - [ ] `KnowledgeGraphProviderRegistry`
  - [ ] `MultimodalProviderRegistry`

- [ ] Create `PipelineProviderManager`
  - [ ] Unified access to all registries
  - [ ] `getRegistryForStageType()` method
  - [ ] `execute()` wrapper

- [ ] Unit tests
  - [ ] Provider interface compliance
  - [ ] Registry registration/lookup
  - [ ] Circuit breaker integration

### Phase 2: Built-in Providers (Week 2-3)

- [ ] Extraction providers
  - [ ] `DoclingExtractionProvider`
  - [ ] `LlamaIndexExtractionProvider`
  - [ ] `PyPDFExtractionProvider`

- [ ] Enrichment providers
  - [ ] `OpenAIEnrichmentProvider`
  - [ ] `AnthropicEnrichmentProvider`
  - [ ] `GeminiEnrichmentProvider`

- [ ] Embedding providers
  - [ ] `BGEM3EmbeddingProvider`
  - [ ] `OpenAIEmbeddingProvider`
  - [ ] `VoyageEmbeddingProvider`

- [ ] Chunking providers
  - [ ] `TreeBuilderChunkingProvider`
  - [ ] `TokenBasedChunkingProvider`
  - [ ] `MarkdownChunkingProvider`

- [ ] Knowledge graph providers
  - [ ] `Neo4jKnowledgeGraphProvider`

- [ ] Multimodal providers
  - [ ] `OpenAIVisionProvider`
  - [ ] `GeminiVisionProvider`

- [ ] Provider tests
  - [ ] Unit tests for each provider
  - [ ] Integration tests with external services (mocked)

### Phase 3: Configuration & Discovery (Week 4)

- [ ] Configuration management
  - [ ] `resolveProviderConfig()` function (with precedence)
  - [ ] `extractDefaults()` from JSON Schema
  - [ ] JSON Schema validation (Ajv integration)

- [ ] Provider discovery API
  - [ ] `GET /api/pipelines/providers/:stageType` - List providers
  - [ ] `GET /api/pipelines/providers/:stageType/:providerId/schema` - Get config schema
  - [ ] `GET /api/pipelines/providers/:stageType/:providerId/health` - Health status
  - [ ] `POST /api/pipelines/providers/:stageType/:providerId/validate-config` - Validate config

- [ ] Circuit breaker API
  - [ ] `GET /api/pipelines/providers/:stageType/:providerId/circuit-breaker` - Get state
  - [ ] `POST /api/pipelines/providers/:stageType/:providerId/circuit-breaker/reset` - Reset (admin)

- [ ] Cost estimation API
  - [ ] `POST /api/pipelines/:pipelineId/estimate-cost` - Estimate pipeline cost

- [ ] Integration tests
  - [ ] API endpoint tests
  - [ ] Configuration resolution tests

### Phase 4: Health Monitoring & Versioning (Week 5)

- [ ] Provider health monitoring
  - [ ] `ProviderHealthMonitor` class
  - [ ] Background health checks (every 5 minutes)
  - [ ] Metrics emission
  - [ ] Alert on unhealthy providers

- [ ] Provider versioning
  - [ ] Semver validation
  - [ ] `checkProviderVersionCompatibility()` function
  - [ ] Compatibility warnings in Studio UI

- [ ] Monitoring dashboards
  - [ ] Provider health dashboard
  - [ ] Circuit breaker state dashboard
  - [ ] Provider usage metrics

- [ ] Documentation
  - [ ] Provider development guide
  - [ ] Provider API reference
  - [ ] Provider configuration reference

---

## Summary

This research establishes a comprehensive provider registry architecture for SearchAI's pluggable pipeline system:

1. **Unified Provider Interface:** `PipelineStageProvider<TInput, TOutput, TConfig>` for all stage types
2. **Type-Specific Registries:** Separate registries with type-safe interfaces
3. **Automatic Circuit Breaker Integration:** Providers wrapped at registry level (no provider-side logic needed)
4. **Provider Discovery API:** Studio UI can list providers, fetch config schemas, validate configs
5. **Configuration Resolution:** Multi-level precedence (stage > flow > pipeline > defaults)
6. **Cost Estimation:** Providers expose `estimateCost()` for UI cost preview
7. **Health Monitoring:** Background checks with metrics emission
8. **Provider Versioning:** Semver-based with compatibility checks

**Next Steps:** Proceed to design phase (Tasks #39-46) to design the actual implementation.
