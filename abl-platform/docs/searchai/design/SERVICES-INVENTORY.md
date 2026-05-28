# Search-AI Services Inventory

**Date:** 2026-04-30
**Application:** `apps/search-ai`
**Purpose:** Comprehensive inventory of all services in the Search-AI platform

---

## Overview

The Search-AI application consists of three main service categories:

1. **Background Workers (BullMQ)** - Asynchronous job processing pipeline
2. **REST API Routes** - HTTP endpoints for client applications
3. **Business Logic Services** - Reusable service modules

**Total Services:** 18 Core Workers + 6 IdP Sync Workers + 7 Connector/Crawler Workers + 28 API Routes + 26 Service Modules = **85 Services**

> **Note:** The 18 core workers (14 always-started + 3 optional + 1 Browse SDK) are managed by the main Search-AI service. The 6 IdP sync workers handle identity provider synchronization. The 7 connector/crawler workers are part of separate services.

---

## 1. Background Workers

### 1.1 Core Pipeline Workers (17 Workers)

All workers use BullMQ for job queue management and Redis for coordination.

### Core Pipeline Workers (14 Always-Started Workers)

Started automatically via `startWorkers()` in `workers/index.ts`:

| #   | Worker Name                   | File                                  | Purpose                                                                  | Concurrency   | Queue Name                  |
| --- | ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | ------------- | --------------------------- |
| 1   | **Ingestion**                 | `ingestion-worker.ts`                 | Scans sources, discovers new documents, enqueues extraction              | 60% base      | `ingestion`                 |
| 2   | **Extraction**                | `extraction-worker.ts`                | Extracts text/metadata from documents (non-Docling path)                 | 100% base     | `extraction`                |
| 3   | **Docling Extraction**        | `docling-extraction-worker.ts`        | Advanced document parsing (PDF layout, tables, images)                   | 100% base     | `docling-extraction`        |
| 4   | **Page Processing**           | `page-processing-worker.ts`           | **Phase 2 LLM**: Progressive summarization + question synthesis per page | 80% base      | `page-processing`           |
| 5   | **Canonical Mapper**          | `canonical-mapper-worker.ts`          | Maps extracted data to normalized schema, enriches metadata              | 100% base     | `canonical-map`             |
| 6   | **Noise Detection**           | `noise-detection-worker.ts`           | Identifies low-quality/duplicate/boilerplate chunks using TF-IDF         | Custom        | `noise-detection`           |
| 7   | **Visual Enrichment**         | `visual-enrichment-worker.ts`         | Processes images, diagrams, charts in documents                          | 60% base      | `visual-enrichment`         |
| 8   | **Enrichment**                | `enrichment-worker.ts`                | Adds semantic metadata, entity extraction, categorization                | 100% base     | `enrichment`                |
| 9   | **KG Enrichment**             | `kg-enrichment-worker.ts`             | Knowledge graph enrichment, entity linking                               | 50% base      | `kg-enrichment`             |
| 10  | **Taxonomy Setup**            | `taxonomy-setup-worker.ts`            | LLM-powered taxonomy generation for knowledge bases                      | 1 (intensive) | `taxonomy-setup`            |
| 11  | **Knowledge Graph**           | `knowledge-graph-worker.ts`           | Builds knowledge graph relationships, co-occurrence analysis             | 50% base      | `knowledge-graph`           |
| 12  | **Multimodal**                | `multimodal-worker.ts`                | Processes multimodal content (text + images combined)                    | 40% base      | `multimodal`                |
| 13  | **Embedding**                 | `embedding-worker.ts`                 | Generates vector embeddings, upserts to vector store                     | 60% base      | `embedding`                 |
| 14  | **Structured Data Ingestion** | `structured-data-ingestion-worker.ts` | CSV/JSON/Excel ingestion to ClickHouse                                   | 1             | `structured-data-ingestion` |

### Optional Workers (3 Workers)

Started conditionally via try/catch in `startWorkers()`:

| #   | Worker Name              | File                             | Purpose                                                 | Queue Name             |
| --- | ------------------------ | -------------------------------- | ------------------------------------------------------- | ---------------------- |
| 15  | **Tree Building**        | `tree-building-worker.ts`        | Builds hierarchical chunk trees for semantic navigation | `tree-building`        |
| 16  | **Question Synthesis**   | `question-synthesis-worker.ts`   | Generates document-level questions for RAG              | `question-synthesis`   |
| 17  | **Scope Classification** | `scope-classification-worker.ts` | Classifies document scope/domain                        | `scope-classification` |

**Note:** These 3 optional workers are gracefully skipped if disabled or missing API keys.

### Browse SDK Workers (1 Worker)

Added in Sprint 5-6 for attribute discovery and lifecycle management:

| #   | Worker Name        | File                       | Purpose                                                      | Concurrency | Queue Name       |
| --- | ------------------ | -------------------------- | ------------------------------------------------------------ | ----------- | ---------------- |
| 18  | **Reconciliation** | `reconciliation-worker.ts` | Embedding-based clustering, attribute dedup, promote/discard | 1           | `reconciliation` |

### Scheduled Jobs (Browse SDK)

Managed by `scheduler/index.ts`, registered as BullMQ repeatable jobs:

| Job Name                   | Schedule   | Purpose                                                                   |
| -------------------------- | ---------- | ------------------------------------------------------------------------- |
| `scheduled-reconciliation` | Daily 4 AM | Cluster novel attributes, merge duplicates, promote/discard               |
| `scheduled-auto-promotion` | Daily 5 AM | Evaluate beta→approved promotions and approved→beta demotions via metrics |

**Note:** Both jobs filter out `discoverySource: 'admin_manual'` attributes to preserve admin tier decisions.

### 1.2 IdP Sync Workers (6 Workers - Phase 2B/5)

IdP (Identity Provider) synchronization workers for document-level permission filtering:

| #   | Worker Name             | File                           | Purpose                                                  | Queue Name           | Provider |
| --- | ----------------------- | ------------------------------ | -------------------------------------------------------- | -------------------- | -------- |
| 18  | **Azure AD User Sync**  | `azuread-user-sync-worker.ts`  | Syncs users from Azure AD to Neo4j (Microsoft Graph API) | `azuread-user-sync`  | Azure AD |
| 19  | **Azure AD Group Sync** | `azuread-group-sync-worker.ts` | Syncs groups + memberships from Azure AD (nested groups) | `azuread-group-sync` | Azure AD |
| 20  | **Okta User Sync**      | `okta-user-sync-worker.ts`     | Syncs users from Okta to Neo4j (Okta API)                | `okta-user-sync`     | Okta     |
| 21  | **Okta Group Sync**     | `okta-group-sync-worker.ts`    | Syncs groups + memberships from Okta (nested groups)     | `okta-group-sync`    | Okta     |
| 22  | **Google User Sync**    | `google-user-sync-worker.ts`   | Syncs users from Google Workspace (Directory API)        | `google-user-sync`   | Google   |
| 23  | **Google Group Sync**   | `google-group-sync-worker.ts`  | Syncs groups + memberships from Google Workspace         | `google-group-sync`  | Google   |

**Features:**

- **Delta Query Support**: Incremental syncs after initial full sync (Azure: native /delta, Okta: filter-based, Google: timestamp comparison)
- **Pagination**: Handles 10k+ users/groups (Azure: @odata.nextLink, Okta: 'after' cursor, Google: pageToken)
- **Nested Groups**: Supports group-within-group relationships (Azure: 20 levels, Okta: 100 levels, Google: unlimited)
- **Batch Operations**: Neo4j upserts in batches (100 users, 50 groups per batch)
- **Cache Invalidation**: Clears Redis group membership cache after sync
- **API Timeouts**: Azure/Okta: 120s, Google: 60s (faster API)

**IdP Authentication Flow:**

1. User queries with `X-Auth-Mode: user` + `X-End-User-Token` header
2. Runtime validates IdP token (JWKS-based JWT verification)
3. Queries Neo4j for user's group memberships (with 5-min Redis cache)
4. Filters OpenSearch results to documents user has access to

**Status:** ✅ Implemented (Phase 2B: Azure AD, Phase 5: Okta + Google)

### 1.3 Connector & Crawler Workers (7 Workers)

These workers are part of separate services and **NOT** started by the main Search-AI `startWorkers()` function:

| #   | Worker Name                    | File                                   | Purpose                                                                  | Service          | Status  |
| --- | ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------ | ---------------- | ------- |
| 24  | **Connector Sync**             | `connector-sync-worker.ts`             | Syncs data from external connectors (Google Drive, SharePoint, etc.)     | Connector Svc    | ✅ IMPL |
| 25  | **Connector Permission Crawl** | `connector-permission-crawl-worker.ts` | Crawls and syncs permissions from connectors                             | Connector Svc    | ✅ IMPL |
| 26  | **Permission Recrawl**         | `permission-recrawl-worker.ts`         | Re-crawls permissions when changes detected                              | Connector Svc    | ✅ IMPL |
| 27  | **Crawler Ingestion**          | `crawler-ingestion-worker.ts`          | Consumes BatchResult from Go worker, ingests via CrawlerIngestionService | Crawler Svc      | ✅ IMPL |
| 28  | **Intelligence Crawl**         | `intelligence-crawl-worker.ts`         | Multi-page LLM intelligence crawl with handler reuse and quality gating  | Crawler Svc      | ✅ IMPL |
| 29  | **Webhook Notification**       | `webhook-notification-worker.ts`       | Delivers webhook notifications for ingestion events                      | Notification Svc | ✅ IMPL |
| 30  | **Document Visual Enrichment** | `document-visual-enrichment-worker.ts` | Document-level visual analysis (vs chunk-level)                          | On-demand        | ⚠️ TBD  |

**Crawler Worker Details:**

| Worker                 | Queue                | Concurrency    | Lock   | Producer                                  |
| ---------------------- | -------------------- | -------------- | ------ | ----------------------------------------- |
| **Crawler Ingestion**  | `content-processing` | 3              | 2 min  | Go Worker (publishes `BatchResult`)       |
| **Intelligence Crawl** | `intelligence-crawl` | 1 (sequential) | 10 min | `POST /api/crawl/intelligence/crawl-site` |

**Note:** These workers have their own startup mechanisms and are not managed by the Search-AI ingestion pipeline orchestrator.

### Pipeline Flow

```
Ingestion → Extraction/Docling → Page Processing (LLM) → Canonical Map →
  ├─ Noise Detection
  ├─ Visual Enrichment
  ├─ Enrichment → KG Enrichment → Knowledge Graph
  ├─ Multimodal
  └─ Embedding → Vector Store
```

---

## 2. REST API Routes (28 Route Modules)

All routes mounted under `/api` with authentication middleware.

### Core Routes

| #   | Route               | File                 | Base Path              | Purpose                              |
| --- | ------------------- | -------------------- | ---------------------- | ------------------------------------ |
| 1   | **Health**          | `health.ts`          | `/health`              | Health check, database/worker status |
| 2   | **Admin**           | `admin.ts`           | `/api/admin`           | Administrative operations            |
| 3   | **Indexes**         | `indexes.ts`         | `/api/indexes`         | CRUD for search indexes              |
| 4   | **Sources**         | `sources.ts`         | `/api/indexes`         | Manage document sources              |
| 5   | **Documents**       | `documents.ts`       | `/api/indexes`         | Document management                  |
| 6   | **Document Upload** | `document-upload.ts` | `/api/indexes`         | Direct file upload                   |
| 7   | **Chunks**          | `chunks.ts`          | `/api/indexes`         | Chunk operations                     |
| 8   | **Schemas**         | `schemas.ts`         | `/api/schemas`         | Schema management                    |
| 9   | **Mappings**        | `mappings.ts`        | `/api/mappings`        | Field mappings                       |
| 10  | **Jobs**            | `jobs.ts`            | `/api/jobs`            | Job queue management                 |
| 11  | **Knowledge Bases** | `knowledge-bases.ts` | `/api/knowledge-bases` | Knowledge base CRUD                  |
| 12  | **Vocabulary**      | `vocabulary.ts`      | `/api/indexes`         | Custom vocabulary/synonyms           |
| 13  | **Search**          | `search.ts`          | `/api/search`          | Search endpoints (hybrid, semantic)  |
| 14  | **Connectors**      | `connectors.ts`      | `/api/connectors`      | Connector management                 |
| 15  | **Webhooks**        | `webhooks.ts`        | `/api/webhooks`        | Webhook configuration                |

### Crawl Routes (7 Route Modules, all at `/api/crawl` except crawler-ingestion at `/api/crawler`)

| #   | Route                 | File                        | Base Path      | Purpose                                                                              |
| --- | --------------------- | --------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| 16  | **Crawl (Bulk)**      | `crawl.ts`                  | `/api/crawl`   | Batch submission, profiling, clustering, preferences, job management (16 endpoints)  |
| 17  | **Intelligence**      | `intelligence.ts`           | `/api/crawl`   | Single-page LLM analysis, multi-page intelligence crawl, save results (5 endpoints)  |
| 18  | **HTTP Discovery**    | `crawl-discover.ts`         | `/api/crawl`   | Pattern-guided recursive HTTP discovery with SSE progress (5 endpoints)              |
| 19  | **Browser Discovery** | `crawl-browser-discover.ts` | `/api/crawl`   | Playwright exploration via MCP server with SSE proxy and interventions (5 endpoints) |
| 20  | **Drafts**            | `crawl-drafts.ts`           | `/api/crawl`   | Multi-step crawl draft persistence with bucket URL storage (7 endpoints)             |
| 21  | **Preview**           | `crawl-preview.ts`          | `/api/crawl`   | Readability extraction preview with SSRF protection (1 endpoint, rate limited)       |
| 22  | **Crawler Ingestion** | `crawler-ingestion.ts`      | `/api/crawler` | External HTML ingestion endpoint for Go worker results (2 endpoints)                 |

### Knowledge Graph Routes

| #   | Route             | File               | Base Path      | Purpose                                                     |
| --- | ----------------- | ------------------ | -------------- | ----------------------------------------------------------- |
| 23  | **KG Enrichment** | `kg-enrichment.ts` | `/api/indexes` | KG enrichment operations                                    |
| 24  | **KG Taxonomy**   | `kg-taxonomy.ts`   | `/api/indexes` | Taxonomy management, org profile generation, custom domains |

**KG Taxonomy Endpoints:**

- `POST /:indexId/kg-taxonomy/generate-profile` - Generate org profile using LLM
- `POST /:indexId/kg-taxonomy/domains/generate` - Generate custom domain from org profile
- `POST /:indexId/kg-taxonomy/domains` - Save custom domain to database
- `GET /:indexId/kg-taxonomy/domains` - List saved custom domains
- `GET /:indexId/kg-taxonomy/domains/:domainId` - Get custom domain details
- `DELETE /:indexId/kg-taxonomy/domains/:domainId` - Delete custom domain
- `GET /kg-taxonomy/metrics/org-profile-generation` - Org profile generation metrics

### Browse SDK Routes (Search-AI Engine)

| #   | Route          | File            | Base Path      | Purpose                                            |
| --- | -------------- | --------------- | -------------- | -------------------------------------------------- |
| 25  | **Attributes** | `attributes.ts` | `/api/indexes` | Attribute registry CRUD, review queue, bulk, merge |

**Attribute Endpoints:**

- `GET /:indexId/attributes` — List attributes (paginated, filterable by tier/search/productScope)
- `GET /:indexId/attributes/review-queue` — Novel/beta attributes needing review (uses reconciliation config thresholds)
- `GET /:indexId/attributes/stats` — Tier distribution counts
- `GET /:indexId/attributes/:attributeId` — Single attribute detail
- `PATCH /:indexId/attributes/:attributeId` — Update tier, displayName, aliases, extractionPatterns (sets `discoverySource: 'admin_manual'`)
- `POST /:indexId/attributes/bulk` — Bulk tier change for multiple attributes
- `POST /:indexId/attributes/merge` — Merge source attributes into target (ClickHouse entity_instances mutation)

### Browse SDK Routes (Search-AI Runtime)

| #   | Route      | File        | Base Path                     | Purpose                                 |
| --- | ---------- | ----------- | ----------------------------- | --------------------------------------- |
| 26  | **Browse** | `browse.ts` | `/api/search/:indexId/browse` | Taxonomy browsing, facets, interactions |

**Browse Endpoints:**

- `GET /taxonomy` — Full taxonomy tree (Redis cache → MongoDB fallback → AttributeRegistry merge)
- `GET /facets` — Facet values for a taxonomy node (ClickHouse parameterized queries)
- `POST /facet-counts` — Post-search facet counts within result set
- `GET /facets/:attributeType/documents` — Documents matching a specific facet value
- `POST /interactions` — Track impression/click interactions (buffered ClickHouse writes)

### Structured Data Routes

| #   | Route                      | File                        | Base Path      | Purpose                |
| --- | -------------------------- | --------------------------- | -------------- | ---------------------- |
| 27  | **Structured Data Ingest** | `structured-data-ingest.ts` | `/api/indexes` | JSON/CSV/SQL ingestion |

### IdP Sync Routes (Search-AI Runtime)

| #   | Route        | File          | Base Path       | Purpose                                |
| --- | ------------ | ------------- | --------------- | -------------------------------------- |
| 28  | **IdP Sync** | `idp-sync.ts` | `/api/idp/sync` | Identity provider synchronization mgmt |

**IdP Sync Endpoints:**

- `POST /api/idp/sync/trigger` - Manually trigger IdP sync (Azure AD, Okta, or Google)
  - Body: `{ provider: 'azuread' | 'okta' | 'google', syncMode: 'full' | 'delta', credentialId: string }`
  - Returns: `{ jobs: { userSync: { id, queue }, groupSync: { id, queue } } }`
- `GET /api/idp/sync/status?provider=<provider>` - Check sync status for tenant
  - Returns: Job states (active, waiting, completed, failed) for user and group sync
- `POST /api/idp/sync/invalidate-cache` - Clear group membership cache
  - Forces refresh on next query
  - Returns: Number of cache keys deleted

**Automatic Sync Schedule:**

- Daily at 2:00 AM UTC (user sync)
- Daily at 2:30 AM UTC (group sync)
- Managed by `idp-sync-scheduler.ts`

---

## 3. Business Logic Services (15+ Service Modules)

Reusable service modules organized by domain.

### LLM Services

| Service                       | Location                                      | Purpose                                      |
| ----------------------------- | --------------------------------------------- | -------------------------------------------- |
| **LLM Config Resolver**       | `services/llm-config/resolver.ts`             | Resolves tenant LLM config, API keys, models |
| **Tenant Model Adapter**      | `services/llm-config/tenant-model-adapter.ts` | Maps tenant preferences to available models  |
| **Progressive Summarization** | `services/progressive-summarization/`         | Generates progressive summaries with context |
| **Question Synthesis**        | `services/question-synthesis/`                | Generates questions from chunks              |
| **Vision Service**            | `services/vision/`                            | Image analysis with LLMs                     |
| **Multimodal Service**        | `services/multimodal/`                        | Combined text+image processing               |

### Document Processing Services

| Service                | Location                     | Purpose                         |
| ---------------------- | ---------------------------- | ------------------------------- |
| **Extraction Service** | `services/extraction/`       | Text extraction orchestration   |
| **Chunking Service**   | `services/chunking/`         | Semantic chunking strategies    |
| **Tree Builder**       | `services/tree-builder/`     | Hierarchical chunk organization |
| **Enrichment Service** | `services/enrichment/`       | Semantic enrichment pipeline    |
| **Noise Detection**    | `services/noise-detection/`  | TF-IDF based quality scoring    |
| **Canonical Mapper**   | `services/canonical-mapper/` | Schema normalization            |

### Knowledge Graph Services

| Service                     | Location                                             | Purpose                                  |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| **Entity Extractor**        | `services/entity-extractor.service.ts`               | Named entity recognition                 |
| **KG Entity Extractor**     | `services/knowledge-graph/entity-extractor.ts`       | KG-specific entity extraction            |
| **Reference Extractor**     | `services/knowledge-graph/reference-extractor.ts`    | Cross-reference detection                |
| **Co-occurrence Analyzer**  | `services/knowledge-graph/co-occurrence-analyzer.ts` | Entity relationship analysis             |
| **Taxonomy Graph**          | `services/knowledge-graph/taxonomy-graph.service.ts` | Taxonomy management                      |
| **Neo4j Client**            | `services/knowledge-graph/neo4j-client.ts`           | Graph database interface                 |
| **Org Profile Generator**   | `services/org-profile-generator.service.ts`          | LLM-powered org profile generation       |
| **Custom Domain Generator** | `services/custom-domain-generator.service.ts`        | LLM-powered custom domain generation     |
| **Taxonomy Loader**         | `services/taxonomy-loader.service.ts`                | Loads and caches taxonomies from storage |

### Browse SDK — Reconciliation Services

| Service                    | Location                                            | Purpose                                                    |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| **Reconciliation Service** | `services/reconciliation/reconciliation.service.ts` | Embedding match, clustering, promote/discard orchestration |
| **Clustering Service**     | `services/reconciliation/clustering.service.ts`     | Agglomerative clustering via ml-hclust (cosine, avg link)  |
| **Auto-Promoter**          | `services/reconciliation/auto-promoter.ts`          | Tier promotion/demotion rules (doc-count + interaction)    |
| **Interaction Aggregator** | `services/reconciliation/interaction-aggregator.ts` | ClickHouse rolling window aggregation (14-day)             |
| **Few-Shot Generator**     | `services/reconciliation/few-shot-generator.ts`     | Extraction pattern generation for promoted attributes      |

### Browse SDK — Runtime Services (search-ai-runtime)

| Service                   | Location                                         | Purpose                                            |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **Facet Query Service**   | `services/browse/facet-query.service.ts`         | ClickHouse parameterized facet queries with FINAL  |
| **Facet Display Rules**   | `services/browse/facet-display-rules.service.ts` | Max 8 facets, 3 beta budget, min 2 distinct values |
| **Interaction Writer**    | `services/browse/interaction-writer.ts`          | Buffered ClickHouse writes for facet interactions  |
| **Taxonomy Cache Reader** | `services/browse/taxonomy-cache-reader.ts`       | Redis → MongoDB fallback → AttributeRegistry merge |

### Classification & Analysis Services

| Service                 | Location                                  | Purpose                      |
| ----------------------- | ----------------------------------------- | ---------------------------- |
| **Document Classifier** | `services/document-classifier.service.ts` | Document type classification |
| **Scope Classifier**    | `services/scope-classifier/`              | Scope/domain classification  |
| **Permission Filter**   | `services/permission-filter.service.ts`   | Permission-based filtering   |

### Structured Data Services

| Service                  | Location                                             | Purpose                              |
| ------------------------ | ---------------------------------------------------- | ------------------------------------ |
| **ClickHouse Client**    | `services/structured-data/clickhouse-client.ts`      | ClickHouse operations                |
| **Schema Analyzer**      | `services/structured-data/schema-analyzer.ts`        | Auto-detect schemas                  |
| **Table Discovery**      | `services/structured-data/table-discovery.ts`        | Find tables in data                  |
| **Foreign Key Detector** | `services/structured-data/foreign-key-detector.ts`   | Detect relationships                 |
| **Text-to-SQL**          | `services/structured-data/text-to-sql.ts`            | Natural language SQL                 |
| **Query Router**         | `services/structured-data/query-router.ts`           | Route queries to appropriate backend |
| **Chunking Strategy**    | `services/structured-data/chunking-strategy.ts`      | Structured data chunking             |
| **JSON Chunking**        | `services/structured-data/json-chunking-strategy.ts` | JSON-specific chunking               |
| **Path Extractor**       | `services/structured-data/path-extractor.ts`         | Extract JSON paths                   |

### Storage & Infrastructure Services

| Service                        | Location                                        | Purpose                  |
| ------------------------------ | ----------------------------------------------- | ------------------------ |
| **ClickHouse Ingestion Store** | `services/stores/clickhouse-ingestion-store.ts` | Ingestion event tracking |
| **Audit Helpers**              | `services/audit-helpers.ts`                     | Audit log utilities      |

---

## 4. Database Connections

### MongoDB (Dual Connection)

**Platform DB** (`abl_platform`):

- `KnowledgeBase`
- `SearchIndex`
- `TenantLLMPolicy`
- `LLMCredential`
- `TenantModel`

**Content DB** (`abl_content`):

- `SearchDocument`
- `DocumentPage`
- `SearchChunk`
- `ChunkQuestion`
- `ChunkHierarchy`
- `SearchSource`
- `KnowledgeGraphTaxonomy`
- `KnowledgeGraphDomain` - Custom domain definitions (RFC-001 Phase 3)
- `OrgProfileMetric` - Org profile generation telemetry (RFC-001 Phase 2)
- `IndexRegistry`
- `SharedIndexTracker`
- `ChunkScope`

### Vector Store

- **OpenSearch** (primary) - k-NN plugin for semantic search
- **Qdrant** (alternate)
- **Pinecone** (alternate)
- **Weaviate** (alternate)

### Graph Database

- **Neo4j** - Knowledge graph storage

### Analytics Database

- **ClickHouse** - Structured data, ingestion events, audit logs

### Cache & Queue

- **Redis** - BullMQ job queues, caching, distributed locks

---

## 5. External Service Integrations

### LLM Providers (15 providers)

Via Vercel AI SDK + Model Registry (178 models):

- OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock
- Cohere, Vertex AI, Groq, Mistral, Fireworks, Together AI
- Perplexity, DeepSeek, xAI, Ultravox

### Embedding Providers

- OpenAI (`text-embedding-3-small`, `text-embedding-3-large`)
- Cohere (`embed-english-v3.0`, `embed-multilingual-v3.0`)
- Custom embedding models

### Connectors (External Data Sources)

- Google Drive
- SharePoint
- Confluence
- Jira
- Slack
- GitHub
- Custom HTTP/REST connectors

---

## 6. Service Architecture Patterns

### Worker Pattern (BullMQ)

```typescript
// All workers follow this pattern:
import { Worker } from 'bullmq';
import { createWorkerOptions } from './shared.js';

export default function createMyWorker(concurrency = 5): Worker {
  const worker = new Worker(
    'queue-name',
    async (job) => {
      // Job processing logic
    },
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`Job ${job.id} failed:`, err));

  return worker;
}
```

### Prompt Templates (PromptLoaderService)

Seven LLM-using services have been migrated from inline prompt strings to versioned YAML templates loaded via `PromptLoaderService`. Templates are located in `apps/search-ai/src/prompts/v1/`:

| Template File                             | Service / Worker               |
| ----------------------------------------- | ------------------------------ |
| `concept-extractor.yaml`                  | Enrichment worker              |
| `scope-classifier.yaml`                   | Scope classification worker    |
| `question-synthesis.yaml`                 | Question synthesis worker      |
| `progressive-summarization-chunk.yaml`    | Page processing worker (chunk) |
| `progressive-summarization-document.yaml` | Page processing worker (doc)   |
| `document-classifier.yaml`                | Document classifier service    |
| `mapping-suggestion.yaml`                 | Mapping suggestion service     |
| `vocabulary-enrichment.yaml`              | Vocabulary generation worker   |

All workers now resolve LLM credentials per-use-case via `resolveIndexLLMConfig(tenantId, indexId)` using the use case key from `USE_CASE_DEFAULTS` in `defaults.ts`. No hardcoded model names remain in any worker or service.

### Service Pattern

```typescript
// Stateless service classes with dependency injection
export class MyService {
  constructor(
    private llmClient: LLMClient,
    private config: ServiceConfig,
  ) {}

  async process(input: Input): Promise<Output> {
    // Business logic
  }
}
```

### Route Pattern

```typescript
// Express routers with middleware
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/:indexId/resource', requireAuth, async (req, res) => {
  const { tenantId } = req.context;
  // Route logic
});

export default router;
```

---

## 7. Key Features by Service

### Phase 2 LLM Integration (Your Recent Work!)

**Worker:** `page-processing-worker.ts`

- Progressive summarization across pages
- Question synthesis per chunk
- Token usage tracking
- Cost calculation

**Services Used:**

- `services/progressive-summarization/`
- `services/question-synthesis/`
- `services/llm-config/resolver.ts`

**Status:** ✅ Fixed timeout issue with `skipQueueOperations` parameter

### Search Capabilities

- **Hybrid Search** - Combines keyword + semantic search
- **Semantic Search** - Vector similarity with embeddings
- **Structured Data Search** - Text-to-SQL on ClickHouse
- **Knowledge Graph Search** - Relationship-based queries

### Intelligent Processing

- **Noise Detection** - TF-IDF scoring for quality
- **Entity Extraction** - NER + relationship mapping
- **Scope Classification** - Domain categorization
- **Visual Enrichment** - Image/diagram analysis

---

## 8. Service Scalability

### Horizontal Scaling

- **Workers:** Each worker can run multiple instances
- **Concurrency:** Configurable per worker type
- **Redis Cluster:** Queue coordination across pods
- **MongoDB Replica Set:** Database high availability

### Vertical Optimization

- **LLM Workers:** Lower concurrency (expensive/rate-limited)
- **Extraction Workers:** Higher concurrency (CPU-bound)
- **Embedding Workers:** Batch processing (API limits)

---

## 9. Monitoring & Observability

### Health Endpoints

- `/health` - Overall service health
- `/health/workers` - Worker status
- `/health/db` - Database connectivity

### Metrics Tracked

- Job queue depths
- Worker processing rates
- LLM token usage & costs
- Database query performance
- Vector store latency

---

## 10. Summary Statistics

| Category                 | Count                                                     |
| ------------------------ | --------------------------------------------------------- |
| **Background Workers**   | 18 core pipeline + 6 IdP + 7 connector/crawler = 31 total |
| **Scheduled Jobs**       | 2 Browse SDK cron jobs (reconciliation, promotion)        |
| **REST API Routes**      | 28 route modules (26 engine + 2 runtime)                  |
| **Service Modules**      | 39+ reusable services                                     |
| **Database Connections** | 5 types (MongoDB, Redis, Neo4j, ClickHouse, Vector)       |
| **LLM Providers**        | 15 supported                                              |
| **Total Services**       | **85+ distinct services**                                 |

**Worker Breakdown:**

- 14 always-started workers (core pipeline)
- 3 optional workers (try/catch, gracefully skipped if disabled)
- 1 Browse SDK worker (reconciliation)
- 6 IdP sync workers (identity provider synchronization)
- 7 connector/crawler workers (started separately, not in main pipeline)

---

## 11. Service Dependencies

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     REST API Layer (28 routes)               │
│                  Authentication + Rate Limiting              │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│              Business Logic Services (30+)                   │
│  LLM • Knowledge Graph • Chunking • Classification • etc.   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│           Background Workers (31 BullMQ Workers)             │
│  Ingestion Pipeline • Enrichment • Embedding • KG Building  │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                   Infrastructure Layer                       │
│  MongoDB • Redis • ClickHouse • Neo4j • Vector Store         │
└─────────────────────────────────────────────────────────────┘
```

---

**End of Inventory**
