# Configurable Embedding Providers - Design Document

**Task:** Enable per-pipeline embedding provider configuration with query-time resolution
**Status:** Design - Ready for Review
**Date:** 2026-03-09

---

## Executive Summary

Enable users to configure different embedding providers (BGE-M3, OpenAI, Cohere, Custom) per pipeline. The embedding configuration is per-pipeline (not per-flow). The query pipeline automatically resolves the correct embedding provider from the active pipeline configuration. Changing embedding providers triggers reindexing.

**Default:** BGE-M3 (self-hosted, 1024-dim, zero API cost, no credentials needed).

---

## Decisions Made

| #   | Decision                                                               | Rationale                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Embedding config lives on **PipelineDefinition**                       | One pipeline per KB (unique index). Pipeline already defines embedding stages. Natural home.                                                                                   |
| D2  | **Single embedding model per pipeline**                                | All flows must use the same embedding provider+model+dimensions. Validation rejects mismatched flows. Different models produce incompatible vector spaces.                     |
| D3  | **BGE-M3 is the default**                                              | Self-hosted at port 8000, 1024-dim, zero API cost, no credentials needed. Already configured as default in `apps/search-ai/src/config/index.ts:65-78`.                         |
| D4  | **Changing embedding config triggers reindexing**                      | No option to change without reindex. Old vectors are incompatible with new model. User gets confirmation dialog before change, notifying that reindexing will be triggered.    |
| D5  | **Reuse existing LLM credential system** for embedding credentials     | OpenAI/Cohere embeddings use the same API key as their chat models. `LLMCredential` model already supports per-tenant encrypted key storage. No new credential concept needed. |
| D6  | **PipelineDefinition is source of truth**, SearchIndex synced on write | Keep `SearchIndex.embeddingModel` + `embeddingDimensions` in sync for backward compatibility during migration.                                                                 |
| D7  | **Add `pipelineId` to SearchChunk schema**                             | Currently missing. Needed for traceability and reindexing.                                                                                                                     |
| D8  | **Queries during reindex** are a separate task                         | Not part of this design. Will be addressed independently.                                                                                                                      |
| D9  | **Preview mode ("try before you buy")** is Phase 2                     | Test a new embedding model on sample documents before committing. Deferred.                                                                                                    |

---

## Current Architecture (What Exists Today)

### Embedding Provider Scope

| Component                                | Scope                | Configuration Source                                         |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------ |
| Ingestion Worker (`embedding-worker.ts`) | **Global singleton** | Environment variables                                        |
| Query Runtime (`server.ts`)              | **Global singleton** | Environment variables                                        |
| SearchIndex model                        | Per-index metadata   | `embeddingModel`, `embeddingDimensions` (not provider-aware) |

**Environment Variables (current):**

```
EMBEDDING_PROVIDER=bge-m3        # openai|cohere|bge-m3|custom
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BASE_URL=http://bge-m3:8000
EMBEDDING_API_KEY=               # only needed for openai/cohere
EMBEDDING_MAX_BATCH_SIZE=32
EMBEDDING_TIMEOUT_MS=60000
```

### LLM Credential Resolution (already exists for LLM features, NOT for embedding)

```
resolveIndexLLMConfig(tenantId, indexId)
  1. TenantLLMPolicy (budgets, rate limits, allowed providers)
  2. LLMCredential.findOne({tenantId, provider, isActive, isDefault})
     -> Auto-decrypted API key via Mongoose encryption plugin
  3. TenantModel fallback (tier-based: fast -> balanced -> powerful)
  4. Environment variable fallback (dev/test only)
```

### Embedding Factory (already exists)

```typescript
// packages/search-ai-internal/src/embedding/factory.ts
createEmbeddingProvider(config): EmbeddingProvider
  -> 'openai'  : OpenAIEmbeddingProvider
  -> 'cohere'  : CohereEmbeddingProvider
  -> 'bge-m3'  : BGEm3EmbeddingProvider  (self-hosted, OpenAI-compatible API)
  -> 'custom'  : CustomEmbeddingProvider  (OpenAI-compatible endpoint)
```

### SearchChunk Schema (missing pipelineId)

```typescript
// packages/database/src/models/search-chunk.model.ts
ISearchChunk {
  _id, tenantId, indexId, documentId,
  content, tokenCount, chunkIndex, vectorId,
  metadata, canonicalMetadata, classification,
  status, _v, createdAt, updatedAt
  // NO pipelineId - needs to be added
}
```

---

## Target Architecture

### High-Level Design

```
KnowledgeBase (1:1)
  |
  +-- PipelineDefinition (one active per KB)
        |
        +-- activeEmbeddingConfig  <-- SOURCE OF TRUTH (NEW)
        |     provider: 'bge-m3'
        |     model: 'bge-m3'
        |     dimensions: 1024
        |
        +-- flows[]
        |     Flow "PDF":  stages[extract, chunk, embed(bge-m3)]
        |     Flow "Text": stages[chunk, embed(bge-m3)]
        |     (all flows MUST use same embedding as activeEmbeddingConfig)
        |
        +-- version (auto-incremented on config change)

                    |
    +---------------+---------------+
    |                               |
Ingestion Time                 Query Time
    |                               |
Embedding worker reads         EmbeddingProviderResolver
activeEmbeddingConfig          reads activeEmbeddingConfig
from pipeline per job          -> resolves credentials
-> embeds chunks               -> creates/caches provider
-> stores pipelineId           -> embeds query
   on each chunk               -> search
```

### Credential Resolution for Embedding (NEW)

```
resolveEmbeddingCredentials(tenantId, provider)
  |
  +-- provider == 'bge-m3'?
  |     -> No credentials needed. Use baseUrl from providerConfig.
  |
  +-- provider == 'custom'?
  |     -> Use baseUrl + optional apiKey from providerConfig.
  |
  +-- provider == 'openai' | 'cohere'?
        |
        +-- Try: LLMCredential.findOne({tenantId, provider, isActive})
        |         (same API key used for chat/LLM features)
        |
        +-- Fallback: env var (OPENAI_API_KEY / COHERE_API_KEY)
        |
        +-- No credentials? -> Validation error on config save.
              "Cannot use OpenAI embeddings: no API key configured
               for this tenant. Add credentials in Settings > LLM."
```

---

## Data Model Changes

### 1. PipelineDefinition - Add activeEmbeddingConfig

```typescript
// Extend IPipelineDefinition (01-DATA-MODELS.md)

export interface IActiveEmbeddingConfig {
  /** Embedding provider ID */
  provider: 'openai' | 'cohere' | 'bge-m3' | 'custom';
  /** Model identifier (e.g., 'text-embedding-3-small', 'bge-m3') */
  model: string;
  /** Vector dimensions */
  dimensions: number;
  /** Provider-specific configuration (baseUrl, batchSize, timeout, etc.) */
  providerConfig?: Record<string, unknown>;
}

export interface IPipelineDefinition {
  // ... existing fields ...

  /**
   * Active embedding configuration for the pipeline.
   * - Used at ingestion time (embedding worker reads this)
   * - Used at query time (query pipeline resolves provider from this)
   * - MUST match the embedding stage in all enabled flows
   * - Changing this triggers reindexing of all documents
   */
  activeEmbeddingConfig: IActiveEmbeddingConfig;
}
```

**Mongoose schema addition:**

```typescript
activeEmbeddingConfig: {
  type: new Schema({
    provider: {
      type: String,
      required: true,
      enum: ['openai', 'cohere', 'bge-m3', 'custom'],
      default: 'bge-m3',
    },
    model: {
      type: String,
      required: true,
      default: 'bge-m3',
    },
    dimensions: {
      type: Number,
      required: true,
      default: 1024,
    },
    providerConfig: {
      type: Schema.Types.Mixed,
      required: false,
    },
  }, { _id: false }),
  required: true,
  default: () => ({
    provider: 'bge-m3',
    model: 'bge-m3',
    dimensions: 1024,
  }),
},
```

### 2. SearchChunk - Add pipelineId

```typescript
// Extend ISearchChunk

export interface ISearchChunk {
  // ... existing fields ...

  /** Pipeline that produced this chunk (for traceability and reindexing) */
  pipelineId: string | null;
}
```

**Mongoose schema addition:**

```typescript
pipelineId: { type: String, default: null },
```

**Index addition:**

```typescript
SearchChunkSchema.index({ tenantId: 1, pipelineId: 1 }, { sparse: true });
```

### 3. SearchIndex - Sync on write (backward compat)

No schema changes to SearchIndex. When `activeEmbeddingConfig` is updated on PipelineDefinition, the service layer syncs `embeddingModel` and `embeddingDimensions` to SearchIndex.

---

## Validation Rules

### Pipeline Validation (enforce single embedding model)

```
Rule: EMBEDDING_CONSISTENCY
  For each enabled flow in the pipeline:
    If flow has an embedding stage:
      stage.provider MUST == activeEmbeddingConfig.provider
      stage.providerConfig.model MUST == activeEmbeddingConfig.model
      stage.providerConfig.dimensions MUST == activeEmbeddingConfig.dimensions
  Severity: error
  Message: "Flow '{flowName}' embedding stage uses {stageProvider}/{stageModel}
            but pipeline active embedding is {activeProvider}/{activeModel}.
            All flows must use the same embedding configuration."
```

### Credential Validation (on config save)

```
Rule: EMBEDDING_CREDENTIALS_AVAILABLE
  If activeEmbeddingConfig.provider in ['openai', 'cohere']:
    LLMCredential must exist for (tenantId, provider, isActive=true)
    OR environment variable fallback must be set
  Severity: error
  Message: "Cannot configure {provider} embeddings: no API key found.
            Add credentials in Settings > LLM Providers."
```

### Dimension Compatibility (on config change)

```
Rule: EMBEDDING_DIMENSIONS_CHANGE
  If activeEmbeddingConfig.dimensions changes:
    Vector store index must be rebuilt (dimensions are fixed at index creation)
  Severity: error (blocking)
  Message: "Changing dimensions from {old} to {new} requires recreating
            the vector store index. All documents will be reindexed."
```

---

## UX Flow: Changing Embedding Provider

```
User opens Pipeline Configuration
  |
  +-- Sees "Embedding Model" section
  |     Current: BGE-M3 (1024 dimensions) - Self-hosted
  |     [Change Embedding Model]
  |
  +-- User clicks "Change Embedding Model"
  |     -> Dropdown shows available providers:
  |        * BGE-M3 (default, self-hosted, free)
  |        * OpenAI text-embedding-3-small (1536-dim, $0.02/1M tokens)
  |        * OpenAI text-embedding-3-large (3072-dim, $0.13/1M tokens)
  |        * Cohere embed-v3 (1024-dim, $0.10/1M tokens)
  |        * Custom endpoint
  |     -> Grayed out if no credentials configured (with link to Settings)
  |
  +-- User selects "OpenAI text-embedding-3-small"
  |
  +-- Confirmation Dialog:
  |     "Changing embedding model requires reindexing all documents.
  |
  |      Current: BGE-M3 (1024 dimensions)
  |      New: OpenAI text-embedding-3-small (1536 dimensions)
  |
  |      Documents to reindex: 10,000
  |      Estimated cost: ~$4.00 (OpenAI API)
  |      Estimated time: ~2 hours
  |
  |      [Cancel]  [Change and Reindex]"
  |
  +-- User confirms
        |
        +-- Pipeline config updated (activeEmbeddingConfig changed)
        +-- All flow embedding stages updated to match
        +-- SearchIndex synced (embeddingModel, embeddingDimensions)
        +-- Reindexing triggered automatically
        +-- KB status -> 'rebuilding'
```

---

## Embedding Provider Registry (for UI dropdowns)

```typescript
// Available embedding providers with metadata for UI

export interface EmbeddingProviderMetadata {
  id: string; // 'openai', 'cohere', 'bge-m3', 'custom'
  name: string; // 'OpenAI Embeddings'
  description: string;
  selfHosted: boolean; // true for bge-m3
  requiresCredentials: boolean; // false for bge-m3
  models: Array<{
    id: string; // 'text-embedding-3-small'
    name: string; // 'Text Embedding 3 Small'
    dimensions: number[]; // [512, 1536] (supported dimensions)
    defaultDimensions: number; // 1536
    costPer1MTokens: number; // 0.02 (USD, 0 for self-hosted)
    maxBatchSize: number; // 100
    maxInputTokens: number; // 8191
  }>;
}

// Registry entries
const EMBEDDING_PROVIDERS = {
  'bge-m3': {
    id: 'bge-m3',
    name: 'BGE-M3',
    description: 'Self-hosted multilingual embedding model (default)',
    selfHosted: true,
    requiresCredentials: false,
    models: [
      {
        id: 'bge-m3',
        name: 'BGE-M3 v1',
        dimensions: [1024],
        defaultDimensions: 1024,
        costPer1MTokens: 0,
        maxBatchSize: 32,
        maxInputTokens: 8192,
      },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Embeddings',
    description: 'OpenAI cloud embedding models',
    selfHosted: false,
    requiresCredentials: true,
    models: [
      {
        id: 'text-embedding-3-small',
        name: 'Text Embedding 3 Small',
        dimensions: [512, 1536],
        defaultDimensions: 1536,
        costPer1MTokens: 0.02,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
      {
        id: 'text-embedding-3-large',
        name: 'Text Embedding 3 Large',
        dimensions: [256, 1024, 3072],
        defaultDimensions: 3072,
        costPer1MTokens: 0.13,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
    ],
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere Embeddings',
    description: 'Cohere cloud embedding models',
    selfHosted: false,
    requiresCredentials: true,
    models: [
      {
        id: 'embed-english-v3.0',
        name: 'Embed English v3',
        dimensions: [1024],
        defaultDimensions: 1024,
        costPer1MTokens: 0.1,
        maxBatchSize: 96,
        maxInputTokens: 512,
      },
    ],
  },
  custom: {
    id: 'custom',
    name: 'Custom Endpoint',
    description: 'OpenAI-compatible custom embedding endpoint',
    selfHosted: true,
    requiresCredentials: false, // optional
    models: [], // user-defined
  },
};
```

---

## API Endpoints

### GET /api/projects/:projectId/pipelines/providers/embedding

Returns available embedding providers with credential availability.

**Permission:** `project:read`

**Response:**

```json
{
  "success": true,
  "data": {
    "providers": [
      {
        "id": "bge-m3",
        "name": "BGE-M3",
        "description": "Self-hosted multilingual embedding model (default)",
        "selfHosted": true,
        "requiresCredentials": false,
        "hasCredentials": true,
        "models": [
          {
            "id": "bge-m3",
            "name": "BGE-M3 v1",
            "dimensions": [1024],
            "defaultDimensions": 1024,
            "costPer1MTokens": 0
          }
        ]
      },
      {
        "id": "openai",
        "name": "OpenAI Embeddings",
        "requiresCredentials": true,
        "hasCredentials": true,
        "models": [...]
      },
      {
        "id": "cohere",
        "name": "Cohere Embeddings",
        "requiresCredentials": true,
        "hasCredentials": false
      }
    ]
  }
}
```

### PATCH /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/embedding-config

Update embedding configuration. Triggers reindexing.

**Permission:** `knowledge-base:update`

**Request:**

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "confirm": true
}
```

**Validation:**

1. Provider must exist in registry
2. Model must be supported by provider
3. Dimensions must be supported by model
4. If provider requires credentials, tenant must have them
5. `confirm: true` is required (prevents accidental changes)

**Response (success):**

```json
{
  "success": true,
  "data": {
    "message": "Embedding configuration updated. Reindexing started.",
    "previousConfig": {
      "provider": "bge-m3",
      "model": "bge-m3",
      "dimensions": 1024
    },
    "newConfig": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "reindexing": {
      "triggered": true,
      "documentCount": 10000,
      "estimatedDurationMinutes": 120
    }
  }
}
```

**Response (missing confirmation):**

```json
{
  "success": false,
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Changing embedding config requires reindexing 10,000 documents. Set confirm: true to proceed.",
    "details": {
      "documentCount": 10000,
      "estimatedCost": 4.0,
      "estimatedDurationMinutes": 120
    }
  }
}
```

---

## Migration Strategy

### Phase 1: Add activeEmbeddingConfig to existing pipelines

```typescript
async function migrateEmbeddingConfigs() {
  // For pipelines that don't have activeEmbeddingConfig yet
  const pipelines = await PipelineDefinition.find({
    activeEmbeddingConfig: { $exists: false },
  });

  for (const pipeline of pipelines) {
    // Read current config from SearchIndex (backward compat)
    const kb = await KnowledgeBase.findOne({
      _id: pipeline.knowledgeBaseId,
      tenantId: pipeline.tenantId,
    });

    if (!kb?.searchIndexId) continue;

    const searchIndex = await SearchIndex.findOne({
      _id: kb.searchIndexId,
      tenantId: pipeline.tenantId,
    });

    if (!searchIndex) continue;

    // Map SearchIndex embeddingModel to provider
    const provider = inferProviderFromModel(searchIndex.embeddingModel);

    pipeline.activeEmbeddingConfig = {
      provider,
      model: searchIndex.embeddingModel,
      dimensions: searchIndex.embeddingDimensions,
    };

    await pipeline.save();
  }
}

function inferProviderFromModel(model: string): string {
  if (model.startsWith('text-embedding')) return 'openai';
  if (model.startsWith('embed-')) return 'cohere';
  if (model === 'bge-m3') return 'bge-m3';
  return 'custom';
}
```

### Phase 2: Add pipelineId to existing chunks

```typescript
async function backfillChunkPipelineIds() {
  // For each KB, find its pipeline and stamp all chunks
  const pipelines = await PipelineDefinition.find({ status: 'active' });

  for (const pipeline of pipelines) {
    await SearchChunk.updateMany(
      {
        tenantId: pipeline.tenantId,
        indexId: { $in: /* resolve index IDs for KB */ },
        pipelineId: null,
      },
      { $set: { pipelineId: pipeline._id.toString() } },
    );
  }
}
```

---

## Components to Create/Modify

### New Files

| File                                                                   | Purpose                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/search-ai-internal/src/embedding/resolver.ts`                | EmbeddingProviderResolver: resolve + cache providers per KB |
| `apps/search-ai/src/services/provider-registry/embedding-providers.ts` | Embedding provider registry metadata                        |
| `apps/search-ai/src/routes/embedding-config.ts`                        | API endpoint for embedding config CRUD                      |

### Files to Modify

| File                                                                    | Change                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/database/src/models/search-chunk.model.ts`                    | Add `pipelineId` field + index                                   |
| `packages/database/src/models/pipeline-definition.model.ts`             | Add `activeEmbeddingConfig` field                                |
| `apps/search-ai/src/workers/embedding-worker.ts`                        | Read `activeEmbeddingConfig` per job instead of global singleton |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts`           | Integrate EmbeddingProviderResolver for per-KB resolution        |
| `apps/search-ai/src/services/pipeline-validation/validation.service.ts` | Add embedding consistency + credential validation rules          |
| `apps/search-ai/src/config/index.ts`                                    | Keep env vars as fallback defaults for migration                 |

### Existing Patterns to Reuse

| Pattern                         | Source                                                           | Reuse For                                            |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| LLMCredential encrypted storage | `packages/database/src/models/llm-credential.model.ts`           | Resolve API keys for OpenAI/Cohere embedding         |
| createEmbeddingProvider factory | `packages/search-ai-internal/src/embedding/factory.ts`           | Create provider instances from config                |
| EmbeddingProvider interface     | `packages/search-ai-internal/src/embedding/interface.ts`         | Provider contract (already supports all 4 providers) |
| Tenant isolation plugin         | `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts` | All queries scoped to tenantId                       |
| Pipeline validation service     | `apps/search-ai/src/services/pipeline-validation/`               | Add embedding validation rules                       |

---

## Implementation Phases

### Phase 1: Data Model + Resolver (Core)

- [ ] Add `activeEmbeddingConfig` to PipelineDefinition schema
- [ ] Add `pipelineId` to SearchChunk schema + index
- [ ] Implement `EmbeddingProviderResolver` with LRU caching
- [ ] Implement embedding credential resolution (reuse LLMCredential)
- [ ] Add embedding consistency validation rule
- [ ] Add credential availability validation rule
- [ ] Migration script: backfill existing pipelines + chunks
- [ ] Unit tests

### Phase 2: API + Ingestion Integration

- [ ] Create embedding provider registry metadata
- [ ] Implement `GET /providers/embedding` endpoint
- [ ] Implement `PATCH /embedding-config` endpoint with confirmation
- [ ] Update embedding worker to read `activeEmbeddingConfig` per job
- [ ] Sync SearchIndex on config write (backward compat)
- [ ] Integration tests

### Phase 3: Query Pipeline Integration

- [ ] Integrate EmbeddingProviderResolver into QueryPipeline
- [ ] Replace global singleton with per-KB resolution
- [ ] Keep env var fallback for pipelines without config (migration period)
- [ ] E2E tests

### Phase 4: UI

- [ ] Embedding configuration section in pipeline config UI
- [ ] Provider dropdown with credential status
- [ ] Confirmation dialog with cost/time estimate
- [ ] Provider comparison info (dimensions, cost, quality)

### Future (Phase 2 of Feature)

- [ ] Preview mode: test new model on sample documents before committing
- [ ] Queries during reindex (separate task)
- [ ] Embedding cost tracking per tenant (reuse TenantLLMPolicy pattern)

---

## Key File References

| Reference                                | Path                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| Pipeline data models design              | `docs/searchai/pipelines/design/backend/01-DATA-MODELS.md`    |
| SearchChunk model (no pipelineId)        | `packages/database/src/models/search-chunk.model.ts`          |
| SearchIndex model (embeddingModel field) | `packages/database/src/models/search-index.model.ts`          |
| KnowledgeBase model                      | `packages/database/src/models/knowledge-base.model.ts`        |
| Embedding provider interface             | `packages/search-ai-internal/src/embedding/interface.ts`      |
| Embedding factory                        | `packages/search-ai-internal/src/embedding/factory.ts`        |
| BGE-M3 provider                          | `packages/search-ai-internal/src/embedding/bge-m3.ts`         |
| Embedding worker (global singleton)      | `apps/search-ai/src/workers/embedding-worker.ts`              |
| Query pipeline                           | `apps/search-ai-runtime/src/services/query/query-pipeline.ts` |
| Runtime server (singleton init)          | `apps/search-ai-runtime/src/server.ts`                        |
| SearchAI config (env vars)               | `apps/search-ai/src/config/index.ts`                          |
| LLM config resolver                      | `apps/search-ai/src/services/llm-config/resolver.ts`          |
| LLMCredential model                      | `packages/database/src/models/llm-credential.model.ts`        |
| TenantModel model                        | `packages/database/src/models/tenant-model.model.ts`          |
| Pipeline validation service              | `apps/search-ai/src/services/pipeline-validation/`            |
| Provider registry types                  | `apps/search-ai/src/services/provider-registry/types.ts`      |
