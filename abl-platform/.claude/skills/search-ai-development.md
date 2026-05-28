---
name: search-ai-development
description: Use when working on apps/search-ai/, apps/search-ai-runtime/, packages/search-ai-internal/, or packages/database/src/models/search-*. Also use when the user mentions workers, ingestion pipeline, embedding, chunking, extraction, BullMQ, knowledge graph, canonical mapping (schema discovery, field mappings, transforms), query pipeline, vector store, OpenSearch, dual-database, or LLM credential resolution. Provides development patterns, anti-patterns, worker creation templates, canonical mapping patterns with M-1/M-2/M-3 security fixes, and MongoDB schema references.
---

# SearchAI Development

## Dual-Database Architecture

SearchAI connects to **two databases** on the same MongoDB instance:

| Database       | Purpose                             | Models                                                                                      |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `abl_platform` | Platform config shared with Runtime | KnowledgeBase, SearchIndex, TenantLLMPolicy, LLMCredential, TenantModel                     |
| `search_ai`    | Search content (high volume)        | SearchChunk, SearchDocument, DocumentPage, ChunkQuestion, IndexRegistry, SharedIndexTracker |

All model access goes through `ModelRegistry` → `bindModelsForSearchAI()` → `getModel()` / `getDualConnection()`. **Never import models directly from `@agent-platform/database`** — they get the default Mongoose connection which is not connected in the dual-DB setup.

## SearchAI vs SearchAI-Runtime

- **SearchAI** (`apps/search-ai/`, port 3005 production, 3113 local dev): **Ingestion-time** — background workers, minutes per document
- **SearchAI-Runtime** (`apps/search-ai-runtime/`, port 3004 production, 3114 local dev): **Query-time** — HTTP request handlers, <500ms per query
- They share the same MongoDB databases but serve different concerns
- **Note:** Port numbers vary by environment. Dockerfiles use 3005/3004 for production, local dev docs reference 3113/3114.

## Ingestion Pipeline (19 Workers)

All workers require Redis (port 6380) via BullMQ. 14 workers always start, 3 are optional (tree-building, question-synthesis, scope-classification), and 2 are IdP-gated (azuread-user-sync, azuread-group-sync).

**For complete Search-AI architecture documentation, see:**

- **Navigation:** `docs/searchai/00-START-HERE.md` — Entry point to all Search-AI docs
- **Architecture Overview:** `docs/searchai/design/SEARCHAI-ARCHITECTURE.md` — Complete SearchAI system architecture (verified against code)
- **Ingestion Pipeline:** `docs/searchai/INGESTION-PIPELINE-ARCHITECTURE.md` — 17 workers, orchestration, error handling
- **Ingestion Pipeline Guide:** `docs/searchai/design/INGESTION-PIPELINE-GUIDE.md` — Scene-by-scene walkthrough with LegalMind use case
- **Ingestion Pipeline Diagrams:** `docs/searchai/design/INGESTION-PIPELINE-DIAGRAMS.md` — ASCII class, sequence, and state diagrams
- **Query Pipeline Design:** `docs/searchai/design/QUERY-PIPELINE-DESIGN.md` — 7-stage pipeline, vocabulary, schema, agent integration, full traces. **Use `search-ai-query-engineer` skill for query pipeline and agent integration work.**
- **Query Pipeline Diagrams:** `docs/searchai/design/QUERY-PIPELINE-DIAGRAMS.md` — Class, sequence, and flow diagrams
- **Services Catalog:** `docs/searchai/design/SERVICES-INVENTORY.md` — Complete catalog of 20 core workers + 6 IdP + services
- **Database Schema:** `docs/searchai/DATABASE-SCHEMA.md` — MongoDB models, collections, indexes, plugins

**Pipeline flow:**

```
upload → ingestion → extraction/docling-extraction → page-processing → canonical-mapper → enrichment
                                                                                            ↓
                                                            ┌───────────────────────────────┤
                                                            ↓               ↓               ↓
                                                      embedding    knowledge-graph    question-synthesis
                                                                                     scope-classification
```

| #   | Worker                    | Queue                       | Concurrency | Purpose                                                                               | Gating                                  |
| --- | ------------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | ingestion                 | `ingestion`                 | 3           | Receives upload, creates document record, enqueues extraction                         | Always                                  |
| 2   | extraction                | `extraction`                | 5           | Legacy text extraction (TXT, MD) — reads file, creates pages                          | File type                               |
| 3   | docling-extraction        | `docling-extraction`        | 5           | Docling extraction (PDF, DOCX, PPTX, HTML, images) via Docling service on port 8080   | File type                               |
| 4   | page-processing           | `page-processing`           | 4           | Chunks pages into SearchChunks, structure-aware for markdown                          | Always                                  |
| 5   | canonical-mapper          | `canonical-mapping`         | 5           | Applies canonical metadata schema to chunks                                           | Always                                  |
| 6   | noise-detection           | `noise-detection`           | 1           | Filters low-quality/noisy chunks                                                      | Config-gated                            |
| 7   | visual-enrichment         | `visual-enrichment`         | 3           | Extracts info from images/screenshots in documents                                    | Config-gated                            |
| 8   | enrichment                | `enrichment`                | 5           | Entity extraction, language detection, summarization stubs. Enqueues downstream jobs. | Always                                  |
| 9   | kg-enrichment             | `kg-enrichment`             | 2           | Knowledge graph entity extraction with taxonomy                                       | Config-gated                            |
| 10  | taxonomy-setup            | `taxonomy-setup`            | 1           | Sets up KG taxonomy for an index (LLM-intensive)                                      | Config-gated                            |
| 11  | knowledge-graph           | `knowledge-graph`           | 2           | Builds Neo4j graph from entities/references                                           | Config-gated (`knowledgeGraph.enabled`) |
| 12  | multimodal                | `multimodal`                | 2           | Multi-modal processing (images, tables)                                               | Config-gated (`multiModal.enabled`)     |
| 13  | embedding                 | `embedding`                 | 3           | Generates BGE-M3 embeddings, upserts to OpenSearch                                    | Always                                  |
| 14  | structured-data-ingestion | `structured-data-ingestion` | 1           | CSV/JSON/Excel ingestion to ClickHouse                                                | On-demand                               |
| 15  | tree-building             | `tree-building`             | 1           | Hierarchical chunk tree construction                                                  | Config-gated (`treeBuilder.enabled`)    |
| 16  | question-synthesis        | `question-synthesis`        | 1           | Generates questions per chunk via LLM                                                 | LLM-gated                               |
| 17  | scope-classification      | `scope-classification`      | 1           | Classifies chunk scope via LLM                                                        | LLM-gated                               |
| 18  | azuread-user-sync         | `azuread-user-sync`         | 1           | Syncs users from Azure AD to Neo4j (Microsoft Graph API, delta queries)               | IdP-gated                               |
| 19  | azuread-group-sync        | `azuread-group-sync`        | 1           | Syncs groups + memberships from Azure AD to Neo4j (nested groups, MEMBER_OF)          | IdP-gated                               |

## Gating Types

- **Always**: Runs for every document
- **Config-gated**: Enabled/disabled via `getConfig()` (app-level config from env vars)
- **LLM-gated**: Requires tenant to have LLM credentials configured (TenantModel with API key or LLMCredential record)
- **File type**: Routes to extraction or docling-extraction based on MIME type
- **On-demand**: Only for structured data uploads (CSV/JSON/Excel)
- **IdP-gated**: Requires LLMCredential with IdP access token (Microsoft Graph API, Okta API, Google Directory API)

## LLM Credential Resolution Chain

Used by LLM-gated workers:

1. `LLMCredential` collection (standalone credential, `isActive` + `isDefault`)
2. `TenantModel` → connection `credentialId` → `LLMCredential` lookup (model-linked credential)
3. Environment variable fallback (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`)
4. Empty → all LLM use cases disabled gracefully (non-LLM features continue)

## Encryption

**SearchAI requires `ENCRYPTION_MASTER_KEY`.**

`LLMCredential.encryptedApiKey` is encrypted at rest by the mongoose encryption plugin (`packages/database/src/mongo/plugins/encryption.plugin.ts`). The plugin decrypts in `post-find` hooks using a master key set via `setMasterKey()`. SearchAI calls `setMasterKey()` at startup in `server.ts`.

**Never use `.lean()` on queries that return encrypted fields.** `.lean()` returns plain objects and skips mongoose hooks, bypassing decryption. Use full Mongoose documents for `LLMCredential` queries.

## BullMQ Flows (Pipeline Orchestration)

BullMQ Flows enable hierarchical job dependencies for pluggable pipelines. Each document gets its own flow instance, but all flows share the **same queues** — workers are flow-unaware.

**Architecture:** `FlowProducer.add(flow)` → creates parent job (Redis) + child jobs in shared queues → parent tracks completion via `parentKey` metadata → workers process jobs normally.

### Safety Rules (non-negotiable — BullMQ bugs/behaviors that cannot be designed around)

1. **Always set `failParentOnFailure: true`** on every child job — without this, the parent waits **forever** when a child fails (BullMQ default behavior)
2. **Set `removeOnComplete`/`removeOnFail` on every child** — parent settings do NOT cascade. Without this, flow tracking keys accumulate in Redis unboundedly
3. **Validate `FlowProducer.add()` result** — it can fail silently during Redis READONLY mode (Issue #3851, OPEN). Verify the parent job exists after creation
4. **Never use `useWorkerThreads: true`** — confirmed memory leak (Issue #2610, OPEN 21 months). Use function references or child processes
5. **Redis `maxmemory-policy` must be `noeviction`** — any eviction silently corrupts BullMQ queue data

### Design Principles (how you implement is flexible)

1. **Separate pipeline definition from flow construction** — don't hardcode flow trees in API routes. Define pipelines declaratively and generate flows from definitions. Approaches: MongoDB model + builder, code-defined registry, or config-driven. RFCs propose `PipelineDefinition` model — see RFC-006
2. **Degrade gracefully when flows fail** — use a circuit breaker or fallback to legacy direct enqueue. Use the platform circuit breaker pattern (`packages/circuit-breaker/`) rather than building standalone
3. **Prevent unbounded queue growth** — BullMQ has NO built-in queue depth limit. Check `queue.getWaitingCount()` before adding flows. Configure threshold based on Redis memory and worker drain rate
4. **Tune `lockDuration` per worker type** — default 30s causes stalled jobs for long-running workers. Set to 2× your P95 job duration. Measure via `JobExecution.metrics.durationMs` once tracking is live
5. **Prevent duplicate flows** — use MongoDB `contentHash`, BullMQ `jobId`, Redis `SET NX`, or another mechanism appropriate to your flow

### Flow Child Job Defaults

```typescript
const FLOW_CHILD_DEFAULTS = {
  failParentOnFailure: true,
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400, count: 1000 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};
```

**Known open issues:** #3851 (silent add failure), #2610 (worker thread memory leak), #632 (no abort signal — build own graceful shutdown), #1099 (duplicate flow race condition).

**Full production guide:** `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md` — known issues, scaling, Redis sizing, troubleshooting runbook. Use `bullmq-flows-guide` skill for deep dives.

## Chunking Strategies

Search-AI implements **three independent chunking strategies** based on document type and index configuration:

1. **Token-Based** (`ChunkingService`): Fixed, semantic, or sliding-window chunking for precise token control
2. **Markdown-Aware** (`MarkdownChunker`): Structure-preserving with AST parsing, maintains heading hierarchy
3. **Page-Based** (Docling default): One chunk per page, preserves layout for PDF/DOCX/PPTX

**Detailed algorithms:** See `docs/searchai/chunking/` directory for chunking research and strategies

## Phase 2 LLM Features

**Progressive Summarization** (`page-processing-worker.ts`):

- Context-aware summaries across pages (Claude Haiku)
- Cost: ~$0.06 per 100-page document
- 6-level configuration hierarchy with graceful degradation

**Question Synthesis** (`page-processing-worker.ts`):

- Generates 3-5 questions per chunk (Gemini Flash)
- Cost: ~$0.006 per 100-page document
- Improves query matching by 30-40%

**Configuration Resolution:** See `services/llm-config/resolver.ts` for the 6-level hierarchy (Index → KB → TenantPolicy → LLMCredential → Env Vars → Disabled)

## LLM Config Known Bugs (verified 2026-03-17)

| Bug                                                                     | File                                                          | Severity | Detail                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treeBuilder` missing from defaults.ts and metadata.ts                  | `llm-config/defaults.ts`, `llm-config/metadata.ts`            | MEDIUM   | Will throw if `getUseCaseDefaults('treeBuilder')` is called. 10th use case but not in defaults or metadata.                                              |
| `mapping_suggestion`/`vocabularyGeneration` missing from Zod validation | `index-schemas.ts:225-239`                                    | MEDIUM   | PATCH to update these use cases will have the values silently stripped by Zod.                                                                           |
| Express route ordering: LLM config                                      | `indexes.ts:567,602 after :246`                               | HIGH     | `/llm-config/use-cases` and `/llm-config/tiers` registered AFTER `/:indexId/llm-config`. Static routes captured by parameterized route.                  |
| Embedding model mismatch on KB creation                                 | `knowledge-bases.ts:101` vs `default-pipeline-template.ts:38` | HIGH     | SearchIndex created with `text-embedding-3-small`/1536d, but pipeline template seeds with `bge-m3`/1024d.                                                |
| Role case mismatch → empty permissions                                  | `auth.ts:37-91`                                               | CRITICAL | DB stores roles as UPPER_CASE (`OWNER`), `ROLE_PERMISSIONS` uses lowercase keys (`owner`). Lookup returns `undefined` → all users get empty permissions. |
| `ClickHouseSearchQueryStore` never instantiated                         | `clickhouse-search-query-store.ts`                            | MEDIUM   | Fully built store class but never imported or instantiated. Write path to `search_queries` table is NOT wired. Table will be empty.                      |

## Query Pipeline (Search-AI Runtime)

> **Use the `search-ai-query-engineer` skill** for query pipeline work. It covers: unified pipeline stages, KB-as-tool integration, discovery API, vocabulary resolution, HybridSearchBuilder, agent integration, and debugging.
>
> **Key reference:** `docs/searchai/design/QUERY-PIPELINE-DESIGN.md`

## IdP Authentication & Permission Filtering

**Two-Layer Authentication Model:**

**Layer 1 — Platform Authentication** (existing):

- Validates **calling application** has tenant/index access
- Uses API keys (`Authorization: Bearer abl_sk_*`) or User JWTs
- Enforces tenant isolation

**Layer 2 — End-User Identity** (new, opt-in):

- Validates **which end user** is making the request
- Uses IdP tokens from Azure AD, Okta, or Google (`X-End-User-Token` header)
- Resolves user's group memberships from Neo4j
- Filters OpenSearch results to documents user has access to

**Authentication Modes:**

| Mode                 | Header Required                          | Behavior                                       |
| -------------------- | ---------------------------------------- | ---------------------------------------------- |
| **public** (default) | None                                     | Returns only `publicEverywhere` documents      |
| **user**             | `X-End-User-Token` + `X-Auth-Mode: user` | Returns documents user has access to via Neo4j |

**Permission Filtering Flow:**

1. Middleware extracts X-Auth-Mode and X-End-User-Token headers
2. If mode=public → inject `publicEverywhere` filter
3. If mode=user → validate IdP token → extract email → query Neo4j for groups
4. Build OpenSearch filter: `publicEverywhere OR allowedUsers:[email] OR allowedGroups:[user's groups]`
5. Group memberships cached in Redis (5-min TTL, tenant-scoped keys)

**IdP Sync Workers:**

- **azuread-user-sync-worker** — Syncs users from Microsoft Graph API to Neo4j User nodes
- **azuread-group-sync-worker** — Syncs groups + memberships from Microsoft Graph to Neo4j Group nodes
- **Okta/Google workers** — Same pattern (pending implementation)

**Key Performance Targets:**

- Query latency target: <500ms P95 (permission filtering adds <100ms)
- Group cache hit rate: >95%
- JWKS cache TTL: 1 hour
- Neo4j query timeout: 10s

## Optimization Systems

- **QueryCache**: Dual-tier (Redis + in-memory), 5-minute TTL, tenant-scoped
- **RequestCache**: Deduplication with SHA256 hashing, 5-second TTL
- **BatchedReranker**: 85% API call reduction, circuit breaker, tenant isolation
- **Cost Calculator**: Real-time pricing with optimization warnings

## Key Files

| File                                                                               | Purpose                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/search-ai/src/workers/index.ts`                                              | Registers all core workers                                              |
| `apps/search-ai/src/workers/shared.ts`                                             | BullMQ config, Redis connection                                         |
| `apps/search-ai/src/workers/page-processing-worker.ts`                             | Chunking + Phase 2 LLM (summarization, questions)                       |
| `apps/search-ai/src/services/llm-config/resolver.ts`                               | LLM credential resolution (6-level hierarchy)                           |
| `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`                   | Tenant model adapter                                                    |
| `apps/search-ai/src/services/progressive-summarization/`                           | Context-aware chunk summarization                                       |
| `apps/search-ai/src/services/question-synthesis/`                                  | Question generation per chunk                                           |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`                         | Field-level encryption                                                  |
| `packages/search-ai-internal/src/embedding/bge-m3.ts`                              | Embedding provider (batch size 8 for CPU, 120s timeout)                 |
| `packages/search-ai-internal/src/chunking/markdown-chunker.ts`                     | Structure-preserving markdown chunking                                  |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts`                      | 6-stage query pipeline orchestrator                                     |
| `apps/search-ai-runtime/src/services/rerank/`                                      | Batched reranker with circuit breaker                                   |
| `docs/searchai/00-START-HERE.md`                                                   | Navigation guide to all Search-AI documentation                         |
| `docs/searchai/design/SEARCHAI-ARCHITECTURE.md`                                    | Complete SearchAI system architecture (code-verified)                   |
| `docs/searchai/design/QUERY-PIPELINE-DESIGN.md`                                    | 7-stage query pipeline design (narrative + traces)                      |
| `docs/searchai/INGESTION-PIPELINE-ARCHITECTURE.md`                                 | 17-worker ingestion pipeline deep-dive                                  |
| `docs/searchai/design/QUERY-PIPELINE-DIAGRAMS.md`                                  | Query pipeline class/sequence diagrams                                  |
| `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`                   | JWKS-based JWT validation (Azure AD, Okta, Google)                      |
| `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts`            | X-Auth-Mode routing (public vs user mode)                               |
| `apps/search-ai-runtime/src/services/query/permission-filter-service.ts`           | Builds OpenSearch permission filter from Neo4j groups                   |
| `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts`              | Redis-backed group cache (5-min TTL, tenant-scoped)                     |
| `apps/search-ai-runtime/src/routes/idp-sync.ts`                                    | IdP sync API (trigger, status, invalidate-cache)                        |
| `apps/search-ai/src/workers/azuread-user-sync-worker.ts`                           | Azure AD user sync with delta queries                                   |
| `apps/search-ai/src/workers/azuread-group-sync-worker.ts`                          | Azure AD group sync with nested groups                                  |
| `apps/search-ai/src/services/document-permissions/document-permission-resolver.ts` | Document-level permission caching for embedding worker                  |
| `apps/search-ai/src/workers/schema-sync-worker.ts`                                 | Automated schema synchronization with M-3 fix                           |
| `apps/search-ai/src/services/schema-discovery/base-discovery.service.ts`           | Base patterns for connector schema discovery                            |
| `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts`     | LLM-powered mapping suggestions with connector templates + alias naming |
| `apps/search-ai/src/services/canonical-mapping/canonical-mapper.service.ts`        | Runtime transformation engine with transforms                           |
| `apps/search-ai/src/services/canonical-mapping/canonical-field-info.service.ts`    | Internal field mapping queries, slot allocation, alias lookups          |
| `apps/search-ai/src/routes/schemas.ts`                                             | Schema CRUD + GET unmapped fields endpoint                              |
| `apps/search-ai/src/routes/mappings.ts`                                            | Field mapping operations with alias enrichment                          |
| `packages/database/src/models/canonical-schema.model.ts`                           | Alias layer: name (alias) + storageField + enumValues Record            |
| `packages/database/src/models/connector-schema.model.ts`                           | Connector-specific discovered schemas                                   |
| `packages/database/src/models/field-mapping.model.ts`                              | Field mappings with confidence + transforms                             |
| `packages/search-ai-internal/src/canonical/connector-type-templates.ts`            | 8 connector category templates (65+ connectors)                         |
| `docs/searchai/rfcs/canonical-mapping/04-CANONICAL-SCHEMA-ALIAS-DESIGN.md`         | 75-field schema, alias layer, UI Fields tab design                      |

## Connector & Crawler Workers (6 Additional)

> **Use the `search-ai-connectors` skill** for connector development. It covers: IConnector interface, sync coordinators, delta sync, OAuth, permissions, filter engines, discovery, and building new connectors.
>
> **Key references:**
>
> - `docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md` — Narrative walkthrough (11 scenes)
> - `docs/searchai/design/SHAREPOINT-CONNECTOR-DIAGRAMS.md` — Class & sequence diagrams (17 diagrams)

These workers are **NOT** started by `startWorkers()` in `workers/index.ts`. They belong to separate services:

| Worker                     | File                                   | Purpose                                       |
| -------------------------- | -------------------------------------- | --------------------------------------------- |
| connector-sync             | `connector-sync-worker.ts`             | Syncs data from Google Drive, SharePoint etc. |
| connector-permission-crawl | `connector-permission-crawl-worker.ts` | Crawls and syncs permissions from connectors  |
| permission-recrawl         | `permission-recrawl-worker.ts`         | Re-crawls permissions on change detection     |
| crawler-ingestion          | `crawler-ingestion-worker.ts`          | Agent-driven web crawler ingestion            |
| webhook-notification       | `webhook-notification-worker.ts`       | Sends webhooks on document status changes     |
| document-visual-enrichment | `document-visual-enrichment-worker.ts` | Document-level visual analysis                |

## MongoDB Data Model

**Full schema reference:** `docs/searchai/DATABASE-SCHEMA.md` — all models, fields, indexes, plugins.
**Source of truth:** TypeScript interfaces in `packages/database/src/models/`.

### Search-AI Content Models (`search_ai` database, 7 models)

| Model          | Collection          | Key Fields                                                                |
| -------------- | ------------------- | ------------------------------------------------------------------------- |
| SearchChunk    | `search_chunks`     | tenantId, indexId, documentId, content, tokenCount, vectorId, status      |
| SearchDocument | `search_documents`  | tenantId, indexId, sourceId, contentHash, extractedText, entities, status |
| SearchIndex    | `search_indexes`    | tenantId, projectId, slug, embeddingModel, vectorStore, llmConfig         |
| SearchSource   | `search_sources`    | tenantId, indexId, sourceType, sourceConfig, syncSchedule, status         |
| DocumentPage   | `document_pages`    | tenantId, indexId, documentId, pageNumber, text, tables, images, layout   |
| ChunkQuestion  | `chunk_questions`   | tenantId, indexId, chunkId, question, questionType, confidence, vectorId  |
| ChunkHierarchy | `chunk_hierarchies` | Hierarchical relationships between chunks (tree structure)                |

### Platform Models Used by Search-AI (`abl_platform` database)

| Model           | Collection            | Purpose                                                                    |
| --------------- | --------------------- | -------------------------------------------------------------------------- |
| KnowledgeBase   | `knowledge_bases`     | Groups search indexes under a knowledge base                               |
| SearchIndex     | `search_indexes`      | Index configuration (shared with content DB)                               |
| TenantLLMPolicy | `tenant_llm_policies` | Per-tenant LLM rate limits and policies                                    |
| LLMCredential   | `llm_credentials`     | Encrypted API keys (field-level encryption)                                |
| TenantModel     | `tenant_models`       | Provider model configurations per tenant                                   |
| ConnectorConfig | `connector_configs`   | Connector settings (Google Drive, SharePoint etc.)                         |
| ConnectorSchema | `connector_schemas`   | Discovered source field schemas (Phase 1)                                  |
| CanonicalSchema | `canonical_schemas`   | Alias layer: name (alias) + storageField + sortable + enumValues Record    |
| FieldMapping    | `field_mappings`      | Source→canonical mappings (canonicalField = storage field name, not alias) |
| SchemaChangeLog | `schema_change_logs`  | Audit trail for schema changes (Phase 1)                                   |

**Model access:** Always use `getLazyModel<IModel>('ModelName')` in Search-AI workers. See "Dual-Database Architecture" above.

## Document Status State Machine

```
PENDING → EXTRACTING → EXTRACTED → ENRICHING → ENRICHED → EMBEDDING → INDEXED
                   Any stage can transition to → ERROR (retry or fail)
```

| Status       | Set By             | Meaning                               |
| ------------ | ------------------ | ------------------------------------- |
| `PENDING`    | ingestion-worker   | Document created, awaiting extraction |
| `EXTRACTING` | extraction workers | Text extraction in progress           |
| `EXTRACTED`  | extraction workers | Text extracted, awaiting enrichment   |
| `ENRICHING`  | enrichment-worker  | Enrichment in progress                |
| `ENRICHED`   | canonical-mapper   | Enriched, awaiting embedding          |
| `EMBEDDING`  | embedding-worker   | Embedding in progress                 |
| `INDEXED`    | embedding-worker   | Successfully indexed in vector store  |
| `ERROR`      | any worker         | Failed (see `processingError` field)  |

Chunk statuses: `PENDING` → `EMBEDDED` → `INDEXED` | `FILTERED` | `ERROR`

## Worker Creation Pattern

When adding a new worker, follow this structure:

```typescript
// 1. Imports — SDK constants + shared utilities
import { Worker } from 'bullmq';
import { QUEUE_MY_STAGE, DocumentStatus } from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';

// 2. Models — ALWAYS getLazyModel, NEVER direct imports
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

// 3. Processor — wrap in withTenantContext, update status on error
export async function processMyJob(job: Job<MyJobData>): Promise<void> {
  const { indexId, documentId, tenantId } = job.data;
  await withTenantContext({ tenantId }, async () => {
    const doc = await SearchDocument.findOne({ _id: documentId, tenantId });
    if (!doc) throw new Error(`Document ${documentId} not found`);
    try {
      // ... processing ...
      // Enqueue next stage with jobId for deduplication
      const q = createQueue(QUEUE_NEXT);
      try {
        await q.add(
          `next:${documentId}`,
          { indexId, documentId, tenantId },
          {
            jobId: `next:${indexId}:${documentId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
          },
        );
      } finally {
        await q.close();
      }
    } catch (error) {
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.ERROR,
          processingError: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      );
      throw error;
    }
  });
}

// 4. Factory — export default
export default function createMyWorker(concurrency = 5): Worker<MyJobData> {
  const worker = new Worker(QUEUE_MY_STAGE, processMyJob, createWorkerOptions(concurrency));
  worker.on('failed', (job, err) => workerError('my-worker', `Job ${job?.id} failed`, err));
  return worker;
}
```

**New worker checklist:**

1. Add `QUEUE_MY_STAGE` constant to `@agent-platform/search-ai-sdk`
2. Add `MyJobData` type to `workers/shared.ts`
3. Register in `workers/index.ts` `startWorkers()` (core) or as optional (try/catch)
4. Add tests in `workers/__tests__/my-worker.test.ts`
5. Update `docs/searchai/SERVICES-INVENTORY.md`

## Anti-Patterns (Search-AI Specific)

| Don't                                                    | Do                                                                 | Why                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `import { SearchChunk } from '@agent-platform/database'` | `getLazyModel<ISearchChunk>('SearchChunk')`                        | Direct imports use wrong DB           |
| `SearchDocument.findById(id)`                            | `SearchDocument.findOne({ _id: id, tenantId })`                    | Tenant isolation violation            |
| `LLMCredential.findOne({}).lean()`                       | `LLMCredential.findOne({})` (no `.lean()`)                         | `.lean()` skips decryption hooks      |
| Hardcode API keys                                        | `resolveIndexLLMConfig(index, feature)`                            | Use credential resolution chain       |
| Enqueue without `jobId`                                  | `{ jobId: \`stage:${indexId}:${documentId}\` }`                    | Prevents duplicate processing         |
| `catch {}` or `catch(() => {})`                          | `catch (error) { workerError('name', 'msg', error); throw error }` | Silent failures hide bugs             |
| Set `ERROR` without message                              | `{ status: ERROR, processingError: \`Stage: ${errMsg}\` }`         | Undiagnosable failures                |
| Skip `withTenantContext`                                 | Always wrap DB operations in `withTenantContext`                   | Required for tenant isolation         |
| Credentials in Redis job data                            | Pass `connectorConfigId` reference                                 | M-3: Credentials never in job payload |
| Unsanitized fields to LLM                                | `sanitizeString(field, maxLength)`                                 | M-1: Prevent prompt injection         |
| No rate limiting on LLM endpoints                        | `searchAiRateLimit` middleware                                     | M-2: Prevent cost abuse               |

## Configuration Patterns

**Config-gated** (app-level toggle):

```typescript
const config = getConfig();
if (config.noiseDetection.enabled) {
  /* enqueue */
} else {
  /* skip */
}
```

**LLM-gated** (tenant credentials required):

```typescript
const llmConfig = await resolveIndexLLMConfig(index, 'progressive_summarization');
if (llmConfig.enabled && llmConfig.apiKey) {
  /* use LLM */
} else {
  /* skip gracefully */
}
```

**6-Level hierarchy:** Index → KnowledgeBase → TenantPolicy → LLMCredential (isDefault) → Env Vars → Disabled

## Canonical Mapping Development Patterns

### Schema Discovery Service Pattern

**Extend `BaseSchemaDiscoveryService`** for connector-specific discovery:

```typescript
export class SharePointSchemaDiscoveryService extends BaseSchemaDiscoveryService {
  async discoverSchema(connectorConfig: IConnectorConfig): Promise<DiscoveryResult> {
    // 1. Fetch sample documents from connector (limit: 100)
    // 2. Extract unique field names + data types
    // 3. Infer field metadata (required, multivalued, enumValues)
    // 4. Return { fields, metadata } with 30s timeout
  }
}
```

**Key patterns:**

- Timeout all API calls (30s for external APIs)
- Sample-based discovery (100 documents max)
- Type inference from actual values (not just schema metadata)
- Graceful degradation on connector errors

### Mapping Suggestion Service Pattern

**LLM-powered suggestions with security hardening:**

````typescript
export class MappingSuggestionService {
  async suggestMappings(
    sourceSchema: IConnectorSchema,
    canonicalSchema: ICanonicalSchema,
  ): Promise<MappingSuggestion[]> {
    // M-1: Sanitize inputs BEFORE LLM call
    const sanitizedFields = this.sanitizeFields(sourceSchema.fields);
    if (sanitizedFields.length > 200) {
      throw new Error('Source schema too large (max 200 fields)');
    }

    // M-2: Rate limit check (handled by middleware, not service)
    // Call LLM with sanitized inputs
    const prompt = this.buildMappingPrompt(sanitizedFields, canonicalSchema);
    const response = await this.llmProvider.complete(prompt);

    // Parse response, assign confidence scores
    return this.parseMappingSuggestions(response);
  }

  private sanitizeFields(fields: SchemaField[]): SchemaField[] {
    return fields.map((f) => ({
      ...f,
      name: this.sanitizeString(f.name, 100), // M-1: max 100 chars
      description: this.sanitizeString(f.description || '', 500), // M-1: max 500 chars
    }));
  }

  private sanitizeString(str: string, maxLength: number): string {
    return str
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars
      .replace(/```/g, '') // Remove code fences
      .replace(/\n\n+/g, '\n') // Collapse newlines
      .trim()
      .slice(0, maxLength);
  }
}
````

**Security checklist:**

- [ ] M-1: Sanitize all user-controlled strings before LLM
- [ ] M-1: Enforce max field limits (200 source, 75 canonical)
- [ ] M-2: Apply rate limiting middleware on route (10 req/min)
- [ ] Confidence scores: high (>0.8), medium (0.5-0.8), low (<0.5)
- [ ] Validate transform types against whitelist

### Schema Sync Worker Pattern

**Automated schema synchronization with M-3 fix:**

```typescript
export async function processSchemaSyncJob(job: Job<SchemaSyncJobData>): Promise<void> {
  const { connectorConfigId, tenantId } = job.data;

  await withTenantContext({ tenantId }, async () => {
    // M-3: Fetch connector config by ID (not raw credentials in job data)
    const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
    const config = await ConnectorConfig.findOne({ _id: connectorConfigId, tenantId });
    if (!config) throw new Error(`Connector ${connectorConfigId} not found`);

    // Discover schema via connector API
    const discoveryService = getDiscoveryService(config.connectorType);
    const schema = await discoveryService.discoverSchema(config);

    // Upsert ConnectorSchema
    const ConnectorSchema = getLazyModel<IConnectorSchema>('ConnectorSchema');
    await ConnectorSchema.findOneAndUpdate(
      { connectorId: connectorConfigId, tenantId },
      { fields: schema.fields, lastDiscoveredAt: new Date() },
      { upsert: true },
    );

    // Log change to SchemaChangeLog
    const SchemaChangeLog = getLazyModel<ISchemaChangeLog>('SchemaChangeLog');
    await SchemaChangeLog.create({
      tenantId,
      connectorId: connectorConfigId,
      changeType: 'field_added',
      changedFields: schema.fields.map((f) => f.name),
    });
  });
}
```

**Key patterns:**

- [ ] M-3: Pass `connectorConfigId` (not raw credentials) in job data
- [ ] Wrap in `withTenantContext({ tenantId }, ...)`
- [ ] Use `getLazyModel()` for all model access
- [ ] Log all changes to `SchemaChangeLog` for audit trail
- [ ] Idempotent operations (re-runnable without duplicates)

### Schema Versioning Pattern

**Lifecycle:** `draft` → `active` → `deprecated`

```typescript
// Creating a new schema version
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');

// Step 1: Create draft
const draftSchema = await CanonicalSchema.create({
  tenantId,
  name: 'canonical-v2',
  version: 2,
  status: SchemaStatus.DRAFT,
  fields: [...newFieldDefinitions],
});

// Step 2: Validate + test against sample data
await validateSchemaAgainstSamples(draftSchema);

// Step 3: Activate (deprecate old active schema)
await CanonicalSchema.findOneAndUpdate(
  { tenantId, status: SchemaStatus.ACTIVE },
  { status: SchemaStatus.DEPRECATED, deprecatedAt: new Date() },
);

await CanonicalSchema.findOneAndUpdate(
  { _id: draftSchema._id, tenantId },
  { status: SchemaStatus.ACTIVE, activatedAt: new Date() },
);
```

**Rules:**

- Only **one** active schema per tenant at a time
- Draft schemas are **NOT** applied to ingestion (testing only)
- Deprecated schemas remain for historical queries (read-only)
- Schema changes trigger re-mapping suggestions

### Transform Functions

**Implemented in Phase 1:**

| Transform   | Input  | Output   | Example                        | Status         |
| ----------- | ------ | -------- | ------------------------------ | -------------- |
| `direct`    | any    | any      | Copy as-is                     | ✅ Implemented |
| `lowercase` | string | string   | "Title" → "title"              | ✅ Implemented |
| `split`     | string | string[] | "tag1,tag2" → ["tag1", "tag2"] | ✅ Implemented |

**Planned for Phase 2:**

| Transform      | Purpose                         | Status     |
| -------------- | ------------------------------- | ---------- |
| `date_format`  | Parse dates with format         | 🚧 Phase 2 |
| `rename_value` | Value mapping (lookup table)    | 🚧 Phase 2 |
| `extract`      | Regex extraction                | 🚧 Phase 2 |
| `coalesce`     | Fallback chain (first non-null) | 🚧 Phase 2 |
| `compute`      | Computed fields (expressions)   | 🚧 Phase 2 |

**Note:** Unrecognized transform types fall back to `direct` with a warning log.

**Usage in FieldMapping:**

```typescript
// Example 1: Lowercase transform
const mapping1: IFieldMapping = {
  tenantId,
  canonicalSchemaId,
  sourceField: 'Status',
  canonicalField: 'status',
  transform: { type: 'lowercase' }, // "In Progress" → "in progress"
  confidence: 0.95,
  status: MappingStatus.CONFIRMED,
};

// Example 2: Split transform
const mapping2: IFieldMapping = {
  tenantId,
  canonicalSchemaId,
  sourceField: 'Tags',
  canonicalField: 'tags',
  transform: { type: 'split', delimiter: ',' }, // "tag1,tag2" → ["tag1", "tag2"]
  confidence: 0.9,
  status: MappingStatus.CONFIRMED,
};
```

### Batch Review Operations

**Approve/reject multiple mappings:**

```typescript
// Route: POST /api/mappings/batch-review
export async function batchReviewMappings(req: Request, res: Response) {
  const { tenantId } = req;
  const { mappingIds, action } = req.body; // action: 'approve' | 'reject'

  const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');

  const result = await FieldMapping.updateMany(
    { _id: { $in: mappingIds }, tenantId },
    {
      status: action === 'approve' ? MappingStatus.CONFIRMED : MappingStatus.REJECTED,
      reviewedAt: new Date(),
      reviewedBy: req.user.email,
    },
  );

  res.json({ success: true, updated: result.modifiedCount });
}
```

**Key patterns:**

- Tenant-scoped batch operations (`{ _id: { $in: [...] }, tenantId }`)
- Audit fields: `reviewedAt`, `reviewedBy`
- Confidence thresholds for auto-approval (e.g., high confidence → auto-confirm)

## Canonical Mapping (Phase 1 - Implemented)

✅ **ACTIVE** — Phase 1 implementation complete with 4 models, 3 service types, schema sync worker, and LLM-powered mapping suggestions.

**Models** (`packages/database/src/models/`):

- `CanonicalSchema` — Unified schema definition with versioning (draft/active/deprecated lifecycle)
- `ConnectorSchema` — Connector-specific discovered schemas (source system field metadata)
- `FieldMapping` — Field-level mappings with confidence scores + transform functions
- `SchemaChangeLog` — Audit trail for schema changes with rollback support

**Services** (`apps/search-ai/src/services/`):

- **Schema Discovery** — `BaseSchemaDiscoveryService` + connector-specific implementations (SharePoint, Google Drive, Jira, Confluence)
- **Mapping Suggestion** — LLM-powered suggestions via Claude with confidence scoring (high/medium/low)
- **Canonical Mapper** — Runtime transformation engine applying field mappings with transforms

**Workers:**

- `schema-sync-worker` — Automated schema synchronization with connectors (M-3: credentials by reference)

**Routes** (`apps/search-ai/src/routes/`):

- `GET/POST /schemas` — Schema CRUD operations (create, list, activate, deprecate)
- `GET/POST /mappings` — Field mapping operations (create, list, batch review)
- `POST /mappings/suggest` — LLM-powered mapping suggestions (M-2: rate-limited 10 req/min)

**Security Fixes Applied:**

- **M-1**: LLM prompt injection prevention (field sanitization, max 200 source fields, 75 canonical fields)
- **M-2**: Rate limiting on /mappings/suggest (10 req/min per tenant)
- **M-3**: Credentials by reference (connectorConfigId, never raw credentials in Redis/job data)

**Transform Types (Phase 1):**

- Implemented: `direct`, `lowercase`, `split`
- Planned (Phase 2): `date_format`, `rename_value`, `extract`, `coalesce`, `compute`

**Schema Versioning:**

- `draft` → Initial state, not applied to ingestion
- `active` → Applied to new documents
- `deprecated` → Historical only, read-only

**References:**

- Architecture Review: `docs/searchai/plans/PHASE1-ARCHITECTURE-REVIEW.md`
- Security Fixes: `docs/searchai/plans/PHASE1-SECURITY-FIXES.md`
- Database Schema: `docs/searchai/DATABASE-SCHEMA.md` (lines 265-334, 470-515)

## Testing

```bash
pnpm --filter @agent-platform/search-ai test                    # All tests
pnpm --filter @agent-platform/search-ai test -- workers/__tests__/embedding-worker  # Specific
```

**Test requirements for new workers:** happy path (status updated, next stage enqueued), error path (`DocumentStatus.ERROR` set), missing document (throws), tenant isolation (`tenantId` in queries), config/LLM gating (skipped when disabled).
