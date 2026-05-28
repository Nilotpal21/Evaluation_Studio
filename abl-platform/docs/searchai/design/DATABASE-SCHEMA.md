# Search-AI MongoDB Schema Reference

**Date:** 2026-04-30
**Source:** `packages/database/src/models/`
**Purpose:** Centralized schema documentation for all MongoDB models used by Search-AI

---

## Dual-Database Architecture

Search-AI connects to **two MongoDB databases** on the same instance:

| Database       | Purpose                    | Model Count | Binding                                                          |
| -------------- | -------------------------- | ----------- | ---------------------------------------------------------------- |
| `search_ai`    | Search content (high vol.) | 17 models   | `ModelRegistry.bindModelsForSearchAI(platformConn, contentConn)` |
| `abl_platform` | Platform config (shared)   | 13+ models  | Default Mongoose connection                                      |

**Access:** Always use `getLazyModel<IModel>('ModelName')` in Search-AI workers. Never import models directly from `@agent-platform/database`.

---

## Search Content Models (`search_ai` database)

### SearchChunk

**Collection:** `search_chunks` | **Plugins:** tenantIsolationPlugin

Represents a chunk of a document ready for embedding and vector storage.

| Field               | Type                    | Required | Description                                                   |
| ------------------- | ----------------------- | -------- | ------------------------------------------------------------- |
| `_id`               | string (UUIDv7)         | Yes      | Unique chunk ID                                               |
| `tenantId`          | string                  | Yes      | Tenant scope                                                  |
| `indexId`           | string                  | Yes      | Search index this chunk belongs to                            |
| `documentId`        | string                  | Yes      | Parent document ID                                            |
| `pipelineId`        | string \| null          | No       | Pipeline that produced this chunk (traceability & reindexing) |
| `flowId`            | string \| null          | No       | Flow that produced this chunk (reindexing checkpoint 3)       |
| `content`           | string                  | Yes      | Chunk content text                                            |
| `tokenCount`        | number                  | No       | Token count (default: 0)                                      |
| `chunkIndex`        | number                  | Yes      | Position within document (default: 0)                         |
| `vectorId`          | string \| null          | No       | Vector ID in external vector store                            |
| `metadata`          | Mixed                   | No       | Raw source metadata from document                             |
| `canonicalMetadata` | Record<string, unknown> | No       | Materialized canonical metadata (stub: pass-through)          |
| `classification`    | IChunkClassification    | No       | KG product scope classification                               |
| `status`            | string                  | Yes      | `pending` \| `embedded` \| `indexed` \| `filtered` \| `error` |

**Indexes:**

- `{ indexId: 1, documentId: 1, chunkIndex: 1 }` — Document chunk lookup
- `{ indexId: 1, status: 1 }` — Status filtering
- `{ vectorId: 1 }` sparse — Vector store lookup
- `{ tenantId: 1, indexId: 1 }` — Tenant isolation
- `{ tenantId: 1, pipelineId: 1 }` sparse — Pipeline queries
- `{ tenantId: 1, flowId: 1 }` sparse — Flow queries
- `{ tenantId: 1, indexId: 1, flowId: 1 }` sparse — Reindexing checkpoint 3
- `{ tenantId: 1, indexId: 1, 'metadata.kgState.status': 1 }` sparse — KG enrichment
- `{ tenantId: 1, indexId: 1, 'metadata.kgState.needsReclassification': 1, 'metadata.kgState.taxonomyVersion': 1 }` sparse — KG reclassification
- `{ tenantId: 1, indexId: 1, 'classification.productScope.primaryProduct': 1 }` sparse — Product scope
- `{ tenantId: 1, indexId: 1, 'classification.department': 1, 'classification.category': 1 }` sparse — Classification
- `{ tenantId: 1, indexId: 1, 'metadata.entities.type': 1 }` sparse — Entity queries

---

### SearchDocument

**Collection:** `search_documents` | **Plugins:** tenantIsolationPlugin

Represents a single ingested document. Tracks content hash for deduplication and processing status.

| Field               | Type                             | Required | Description                                                                                            |
| ------------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `_id`               | string (UUIDv7)                  | Yes      | Unique document ID                                                                                     |
| `tenantId`          | string                           | Yes      | Tenant scope                                                                                           |
| `indexId`           | string                           | Yes      | Search index                                                                                           |
| `sourceId`          | string                           | Yes      | Data source this document came from                                                                    |
| `connectorId`       | string \| null                   | No       | Connector that ingested this document (null for direct uploads)                                        |
| `contentHash`       | string                           | Yes      | SHA-256 for deduplication                                                                              |
| `originalReference` | string \| null                   | No       | Original filename or URL                                                                               |
| `contentType`       | string \| null                   | No       | MIME type                                                                                              |
| `contentSizeBytes`  | number                           | No       | File size (default: 0)                                                                                 |
| `sourceUrl`         | string \| null                   | No       | `file://`, `s3://`, `https://`                                                                         |
| `extractedText`     | string \| null                   | No       | Full extracted text                                                                                    |
| `language`          | string \| null                   | No       | Detected language                                                                                      |
| `entities`          | Array<{type, value, confidence}> | No       | Extracted named entities                                                                               |
| `summary`           | string \| null                   | No       | Generated summary                                                                                      |
| `sourceMetadata`    | Mixed                            | No       | Raw connector-specific metadata                                                                        |
| `classification`    | IDocumentClassification          | No       | Document-level product scope                                                                           |
| `entityInstances`   | IEntityInstance[]                | No       | Deduplicated entity instances for Neo4j                                                                |
| `metadata`          | Mixed (incl. kgState)            | No       | KG enrichment state + extensible metadata                                                              |
| `flowId`            | string \| null                   | No       | Flow that processed this document (reindexing checkpoint 2)                                            |
| `status`            | string                           | Yes      | `pending` → `extracting` → `extracted` → `enriching` → `enriched` → `embedding` → `indexed` \| `error` |
| `processingError`   | string \| null                   | No       | Error description if status = error                                                                    |
| `chunkCount`        | number                           | No       | Number of chunks (default: 0)                                                                          |
| `pageCount`         | number                           | No       | Number of pages (Docling documents)                                                                    |
| `isDeleted`         | boolean                          | No       | Soft delete flag (default: false)                                                                      |
| `deletedAt`         | Date \| null                     | No       | Timestamp of soft delete                                                                               |

**Indexes:**

- `{ indexId: 1, sourceId: 1 }` — Source lookup
- `{ indexId: 1, contentHash: 1 }` **unique** — Deduplication
- `{ indexId: 1, status: 1 }` — Status filtering
- `{ tenantId: 1, indexId: 1 }` — Tenant isolation
- `{ connectorId: 1, tenantId: 1 }` — Canonical mapping lookups
- `{ tenantId: 1, indexId: 1, flowId: 1 }` sparse — Reindexing checkpoint 2
- `{ tenantId: 1, indexId: 1, isDeleted: 1 }` — Deleted document filtering
- `{ isDeleted: 1, deletedAt: 1 }` — Cleanup job
- `{ tenantId: 1, indexId: 1, 'metadata.kgState.status': 1 }` sparse — KG enrichment
- `{ tenantId: 1, indexId: 1, 'metadata.kgState.needsReclassification': 1, 'metadata.kgState.taxonomyVersion': 1 }` sparse — KG reclassification
- `{ tenantId: 1, indexId: 1, 'classification.productScope.primaryProduct': 1 }` sparse — Product scope
- `{ tenantId: 1, indexId: 1, 'classification.department': 1, 'classification.category': 1 }` sparse — Classification
- `{ tenantId: 1, indexId: 1, 'entityInstances.entityInstanceId': 1 }` sparse — Entity lookup

---

### DocumentPage

**Collection:** `document_pages` | **Plugins:** tenantIsolationPlugin

Represents a single page extracted by Docling from a document. Stores structured layout, tables, images, and screenshots.

| Field        | Type            | Required | Description                                              |
| ------------ | --------------- | -------- | -------------------------------------------------------- |
| `_id`        | string (UUIDv7) | Yes      | Unique page ID                                           |
| `tenantId`   | string          | Yes      | Tenant scope                                             |
| `indexId`    | string          | Yes      | Search index                                             |
| `documentId` | string          | Yes      | Parent document                                          |
| `pageNumber` | number          | Yes      | Position in document                                     |
| `text`       | string          | Yes      | Extracted text                                           |
| `tokenCount` | number          | No       | Token count (default: 0)                                 |
| `layout`     | PageLayout      | Yes      | `{ headings: [{level, text, bbox?}], structure: Mixed }` |
| `tables`     | TableInfo[]     | No       | `[{ rows, headers, html, markdown, bbox?, isComplete }]` |
| `images`     | ImageInfo[]     | No       | `[{ s3Url, format, bbox?, sizeBytes? }]`                 |
| `screenshot` | string \| null  | No       | S3 URL of page screenshot                                |
| `status`     | string          | Yes      | `pending` \| `processed` \| `failed`                     |

**Indexes:**

- `{ documentId: 1, pageNumber: 1 }` — Primary lookup
- `{ tenantId: 1, indexId: 1 }` — Tenant isolation
- `{ documentId: 1, status: 1 }` — Status queries
- `{ status: 1, createdAt: 1 }` — Pending page processing

---

### ChunkQuestion

**Collection:** `chunk_questions` | **Plugins:** tenantIsolationPlugin

Stores synthesized questions per chunk (Phase 2 LLM feature). Enables question-based retrieval.

| Field           | Type                    | Required | Description                                                          |
| --------------- | ----------------------- | -------- | -------------------------------------------------------------------- |
| `_id`           | string (UUIDv7)         | Yes      | Unique question ID                                                   |
| `tenantId`      | string                  | Yes      | Tenant scope                                                         |
| `indexId`       | string                  | Yes      | Search index                                                         |
| `documentId`    | string                  | Yes      | Parent document                                                      |
| `chunkId`       | string \| null          | No       | null for document-level questions                                    |
| `question`      | string                  | Yes      | Question text                                                        |
| `scope`         | string                  | Yes      | `chunk` \| `document`                                                |
| `questionType`  | string                  | Yes      | `factual` \| `conceptual` \| `procedural` \| `analytical` \| `other` |
| `confidence`    | number                  | No       | 0–1 score (default: 1.0)                                             |
| `vectorId`      | string \| null          | No       | Embedding vector ID                                                  |
| `questionIndex` | number                  | Yes      | Position among questions (default: 0)                                |
| `metadata`      | Record<string, unknown> | No       | Extensible metadata                                                  |
| `status`        | string                  | Yes      | `pending` \| `completed`                                             |

**Indexes:**

- `{ tenantId: 1, indexId: 1 }` — Index-level queries
- `{ tenantId: 1, indexId: 1, chunkId: 1 }` sparse — Chunk-level queries
- `{ documentId: 1 }` — Document-level queries
- `{ tenantId: 1, indexId: 1, scope: 1 }` — Scope filtering
- `{ tenantId: 1, indexId: 1, questionType: 1 }` — Question type filtering
- `{ status: 1 }` — Embedding workflow
- `{ vectorId: 1 }` sparse — Vector lookup

---

### ChunkHierarchy

**Collection:** `chunk_hierarchies` | **Plugins:** tenantIsolationPlugin

Hierarchical tree structure for adaptive chunking (Phase 2). Chunks organized in balanced tree with parent summaries. Max depth: 4, Max children: 10.

| Field              | Type                    | Required | Description                       |
| ------------------ | ----------------------- | -------- | --------------------------------- |
| `_id`              | string (UUIDv7)         | Yes      | Unique node ID                    |
| `tenantId`         | string                  | Yes      | Tenant scope                      |
| `indexId`          | string                  | Yes      | Search index                      |
| `documentId`       | string                  | Yes      | Parent document                   |
| `parentId`         | string \| null          | No       | null for root nodes               |
| `childIds`         | string[]                | No       | Child node IDs                    |
| `depth`            | number                  | Yes      | 0 = root (default: 0)             |
| `nodeType`         | string                  | Yes      | `root` \| `internal` \| `leaf`    |
| `chunkId`          | string \| null          | No       | Only for leaf nodes               |
| `summary`          | string \| null          | No       | For internal/root nodes           |
| `similarityScore`  | number \| null          | No       | Semantic similarity with parent   |
| `tokenCount`       | number                  | No       | Token count (default: 0)          |
| `positionInParent` | number                  | No       | Order among siblings (default: 0) |
| `metadata`         | Record<string, unknown> | No       | Extensible metadata               |

**Indexes:**

- `{ tenantId: 1, indexId: 1, documentId: 1 }` — Document tree queries
- `{ tenantId: 1, indexId: 1, parentId: 1 }` — Parent-child traversal
- `{ chunkId: 1 }` sparse — Leaf node lookup
- `{ tenantId: 1, indexId: 1, nodeType: 1 }` — Node type filtering

---

### SearchSource

**Collection:** `search_sources` | **Plugins:** tenantIsolationPlugin

Represents a data source connected to a search index. Tracks sync status and extraction settings.

| Field              | Type            | Required | Description                                   |
| ------------------ | --------------- | -------- | --------------------------------------------- |
| `_id`              | string (UUIDv7) | Yes      | Unique source ID                              |
| `tenantId`         | string          | Yes      | Tenant scope                                  |
| `indexId`          | string          | Yes      | Search index                                  |
| `name`             | string          | Yes      | Display name                                  |
| `sourceType`       | string          | Yes      | Connector type (sharepoint, web, file)        |
| `sourceConfig`     | Mixed           | No       | Connection/auth config                        |
| `status`           | string          | Yes      | `pending` \| `syncing` \| `active` \| `error` |
| `extractionConfig` | Mixed           | No       | Extraction settings                           |
| `enrichmentConfig` | Mixed           | No       | Enrichment settings                           |
| `syncSchedule`     | string \| null  | No       | Cron expression                               |
| `documentCount`    | number          | No       | Documents in source (default: 0)              |
| `lastSyncAt`       | Date \| null    | No       | Last successful sync                          |
| `syncError`        | string \| null  | No       | Last sync error                               |

**Indexes:**

- `{ tenantId: 1, indexId: 1 }` — Tenant + index lookup
- `{ indexId: 1, status: 1 }` — Status filtering
- `{ sourceType: 1 }` — Source type lookup

---

### ChunkScope

**Collection:** `chunk_scopes` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Stores scope classification for chunks (ATLAS-KG Phase 5). Classifies whether a chunk answers chunk-level, section-level, or document-level queries. Enables scope-aware retrieval strategies.

| Field               | Type                    | Required | Description                                               |
| ------------------- | ----------------------- | -------- | --------------------------------------------------------- |
| `_id`               | string (UUIDv7)         | Yes      | Unique scope ID                                           |
| `tenantId`          | string                  | Yes      | Tenant scope                                              |
| `indexId`           | string                  | Yes      | Search index                                              |
| `documentId`        | string                  | Yes      | Parent document                                           |
| `chunkId`           | string                  | Yes      | Chunk ID (**unique**)                                     |
| `scopeLevel`        | string                  | Yes      | `chunk` \| `section` \| `document` (default: `chunk`)     |
| `confidence`        | number                  | No       | 0-1 score (default: 1.0)                                  |
| `reasoning`         | string \| null          | No       | Reasoning/explanation for classification                  |
| `retrievalStrategy` | string                  | Yes      | `direct` \| `with_context` \| `summary` \| `hierarchical` |
| `metadata`          | Record<string, unknown> | No       | Extensible metadata                                       |

**Indexes:**

- `{ tenantId: 1, indexId: 1 }` — Index-level queries
- `{ documentId: 1 }` — Document-level queries
- `{ tenantId: 1, indexId: 1, scopeLevel: 1 }` — Scope-level filtering for retrieval strategies

---

### KnowledgeGraphDomain

**Collection:** `knowledge_graph_domains` | **Plugins:** tenantIsolationPlugin | **RFC:** RFC-001 Phase 3

Custom domain definitions generated by LLM for industries not covered by built-in domains.

| Field                  | Type                    | Required | Description                             |
| ---------------------- | ----------------------- | -------- | --------------------------------------- |
| `_id`                  | string (UUIDv7)         | Yes      | Unique domain ID                        |
| `tenantId`             | string                  | Yes      | Tenant scope                            |
| `name`                 | string (kebab-case)     | Yes      | Domain name (max 100 chars)             |
| `version`              | string (semver)         | Yes      | Domain version (e.g., "1.0.0")          |
| `industry`             | string                  | Yes      | Industry classification (max 100 chars) |
| `categories`           | IKGCategory[]           | Yes      | Product categories                      |
| `products`             | IKGProduct[]            | Yes      | Products with disambiguation keywords   |
| `attributes`           | IKGAttribute[]          | Yes      | Extractable attributes                  |
| `departmentBoundaries` | IKGDepartmentBoundary[] | Yes      | Product confusion boundaries            |
| `createdBy`            | string                  | Yes      | User ID who created the domain          |
| `createdAt`            | Date                    | Yes      | Creation timestamp                      |
| `updatedAt`            | Date                    | Yes      | Last update timestamp                   |

**Indexes:**

- `{ tenantId: 1, name: 1 }` **unique** — Domain name per tenant
- `{ tenantId: 1, createdAt: -1 }` — Recent domains first

**Notes:**

- Domain names must be unique within a tenant
- Categories can have 5-10 items, products 15-30, attributes 20-50
- Used by `CustomDomainGenerator` service to store LLM-generated taxonomies

---

### OrgProfileMetric

**Collection:** `org_profile_metrics` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent | **RFC:** RFC-001 Phase 2

Telemetry for organization profile generation. Tracks cost, performance, and quality metrics.

| Field                       | Type            | Required | Description                                                                                                             |
| --------------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `_id`                       | string (UUIDv7) | Yes      | Unique metric ID                                                                                                        |
| `tenantId`                  | string          | Yes      | Tenant scope                                                                                                            |
| `indexId`                   | string          | Yes      | Associated search index                                                                                                 |
| `mode`                      | string          | Yes      | `url` \| `name-industry` \| `paragraph`                                                                                 |
| `status`                    | string          | Yes      | `success` \| `validation_failure` \| `ssrf_blocked` \| `circuit_breaker` \| `timeout` \| `llm_error` \| `unknown_error` |
| `durationMs`                | number          | Yes      | Generation time in milliseconds                                                                                         |
| `estimatedCost`             | number          | Yes      | Estimated LLM cost in USD                                                                                               |
| `inputTokens`               | number          | Yes      | Input token count                                                                                                       |
| `outputTokens`              | number          | Yes      | Output token count                                                                                                      |
| `circuitBreakerState`       | string          | Yes      | `CLOSED` \| `OPEN` \| `HALF_OPEN`                                                                                       |
| `inputType`                 | string          | No       | e.g., `url`, `domain`, `custom`                                                                                         |
| `inputLength`               | number          | No       | Character count (paragraph mode)                                                                                        |
| `organizationName`          | string          | No       | Quality: detected org name (success only)                                                                               |
| `industry`                  | string          | No       | Quality: detected industry (success only)                                                                               |
| `keyTermsCount`             | number          | No       | Quality: key terms extracted                                                                                            |
| `acronymsCount`             | number          | No       | Quality: acronyms detected                                                                                              |
| `departmentBoundariesCount` | number          | No       | Quality: department boundaries detected                                                                                 |
| `productSpecificNamesCount` | number          | No       | Quality: product-specific names                                                                                         |
| `errorType`                 | string          | No       | Error: type classification (failure only)                                                                               |
| `errorMessage`              | string          | No       | Error: description (failure only)                                                                                       |
| `suggestedAction`           | string          | No       | Error: suggested remediation (failure only)                                                                             |

**Indexes:**

- `{ tenantId: 1, createdAt: -1 }` — Tenant time-series
- `{ tenantId: 1, indexId: 1, createdAt: -1 }` — Tenant + index metrics
- `{ tenantId: 1, mode: 1 }` — Aggregate by mode
- `{ tenantId: 1, status: 1 }` — Filter by status
- `{ circuitBreakerState: 1, createdAt: -1 }` — Circuit breaker monitoring

**Notes:**

- Used to track cost and performance of LLM-assisted org profile generation
- Queried by `GET /kg-taxonomy/metrics/org-profile-generation` endpoint
- Enables cost analysis and quality monitoring across tenants

---

### CapabilityRegistry

**Collection:** `capability_registry` | **Plugins:** tenantIsolationPlugin

Stores queryable system capabilities (aggregation functions, filter operators, sort operators) that vocabulary terms can resolve to at query time. Data-driven rather than hardcoded.

| Field                 | Type          | Required | Description                                      |
| --------------------- | ------------- | -------- | ------------------------------------------------ |
| `_id`                 | string (UUID) | Yes      | Unique capability ID                             |
| `tenantId`            | string        | Yes      | Tenant scope (default: `'global'`)               |
| `name`                | string        | Yes      | Capability name (max 50 chars)                   |
| `type`                | string        | Yes      | `aggregation` \| `operator` \| `sort`            |
| `description`         | string        | Yes      | Description (max 500 chars)                      |
| `supportedFieldTypes` | string[]      | Yes      | Field types this capability applies to (min 1)   |
| `triggerKeywords`     | string[]      | Yes      | NL keywords that trigger this capability (min 1) |
| `examples`            | string[]      | Yes      | Example queries demonstrating usage (min 1)      |
| `enabled`             | boolean       | No       | Active toggle (default: true)                    |
| `metadata.version`    | number        | No       | Schema version (default: 1)                      |
| `metadata.createdBy`  | string        | No       | `system` \| `admin` (default: `system`)          |

**Indexes:**

- `{ tenantId: 1, type: 1 }` — Filter by type
- `{ tenantId: 1, enabled: 1 }` — Active capabilities
- `{ tenantId: 1, name: 1 }` — Unique name per tenant

---

### KnowledgeGraphTaxonomy

**Collection:** `knowledge_graph_taxonomy` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Versioned domain taxonomy for knowledge graph classification. Contains categories, products, attributes, and department boundaries for a given index.

| Field                           | Type              | Required | Description                                                   |
| ------------------------------- | ----------------- | -------- | ------------------------------------------------------------- |
| `_id`                           | string (UUID)     | Yes      | Unique taxonomy ID                                            |
| `tenantId`                      | string            | Yes      | Tenant scope                                                  |
| `indexId`                       | string            | Yes      | Index this taxonomy belongs to                                |
| `taxonomy.domain`               | object            | Yes      | `{ id, name, version }` — domain definition                   |
| `taxonomy.categories`           | Category[]        | Yes      | `[{ id, name, department }]`                                  |
| `taxonomy.products`             | Product[]         | Yes      | `[{ id, name, categoryId, department, subDepartment, ... }]`  |
| `taxonomy.attributes`           | Attribute[]       | Yes      | `[{ id, name, dataType, extraction, ... }]`                   |
| `taxonomy.departmentBoundaries` | Boundary[]        | No       | `[{ product1, product2, reasoning }]`                         |
| `version`                       | string            | Yes      | Taxonomy version string                                       |
| `domains`                       | string[]          | No       | Domain identifiers                                            |
| `customDomainFiles`             | string[]          | No       | Custom domain file paths                                      |
| `organizationProfileFile`       | string            | Yes      | Org profile file path                                         |
| `previousVersions`              | TaxonomyVersion[] | No       | Rollback history with version/refinementAction/rollbackReason |

**Indexes:**

- `{ tenantId: 1, indexId: 1 }` **unique** — One taxonomy per index

---

### TaxonomyHealthCache

**Collection:** `taxonomy_health_cache` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Cached taxonomy health signals for dashboard display. Auto-expires after 1 hour via TTL index.

| Field                            | Type               | Required | Description                               |
| -------------------------------- | ------------------ | -------- | ----------------------------------------- |
| `_id`                            | string (UUID)      | Yes      | Unique cache entry ID                     |
| `tenantId`                       | string             | Yes      | Tenant scope                              |
| `indexId`                        | string             | Yes      | Index this cache is for                   |
| `signals.totalDocuments`         | number             | Yes      | Total documents in index                  |
| `signals.classifiedDocuments`    | number             | Yes      | Documents with classification             |
| `signals.unclassifiedDocuments`  | number             | Yes      | Documents without classification          |
| `signals.lowConfidenceDocuments` | number             | Yes      | Documents with confidence < 0.5           |
| `signals.productDistribution`    | Map<string,number> | No       | Product ID → document count               |
| `signals.avgConfidenceByProduct` | Map<string,number> | No       | Product ID → average confidence           |
| `signals.topUnclassifiedTerms`   | Term[]             | No       | `[{ term, frequency }]` (top 20)          |
| `signals.suspiciousPatterns`     | Pattern[]          | No       | `[{ pattern, count }]` detected anomalies |
| `computedAt`                     | Date               | Yes      | When signals were computed                |

**Indexes:**

- `{ tenantId: 1, indexId: 1 }` **unique** — One cache entry per index
- `{ computedAt: 1 }` **TTL** (1 hour) — Auto-deletes stale cache entries

---

### JobExecution

**Collection:** `job_executions` | **Plugins:** tenantIsolationPlugin

Flat job tracking for the ingestion pipeline. Records one document per worker execution (no parent-child links). See [RFC-005](../rfcs/RFC-005-Job-Tracking-Architecture.md) for design rationale.

| Field             | Type          | Required | Description                                                                                                     |
| ----------------- | ------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `_id`             | string (UUID) | Yes      | Unique execution ID                                                                                             |
| `tenantId`        | string        | Yes      | Tenant scope                                                                                                    |
| `bullJobId`       | string        | Yes      | BullMQ job ID                                                                                                   |
| `workerStage`     | string        | Yes      | `connector-discovery` \| `connector-ingestion` \| `docling-extraction` \| `tree-building` \| `embedding` \| ... |
| `documentId`      | string        | Yes      | Document being processed                                                                                        |
| `sourceId`        | string        | Yes      | Source the document belongs to                                                                                  |
| `indexId`         | string        | Yes      | Index the document belongs to                                                                                   |
| `status`          | string        | Yes      | `pending` \| `running` \| `completed` \| `failed` (default: `pending`)                                          |
| `startedAt`       | Date          | Yes      | Execution start time                                                                                            |
| `completedAt`     | Date          | No       | Execution end time                                                                                              |
| `duration`        | number        | No       | Duration in ms (min: 0)                                                                                         |
| `metrics`         | Mixed         | No       | Worker-specific metrics (e.g., chunk count, token count)                                                        |
| `error.code`      | string        | No       | Error code (if failed)                                                                                          |
| `error.message`   | string        | No       | Error message                                                                                                   |
| `error.stack`     | string        | No       | Error stack trace                                                                                               |
| `traceId`         | string        | No       | Distributed trace ID                                                                                            |
| `pipelineId`      | string        | No       | BullMQ Flows pipeline ID                                                                                        |
| `pipelineVersion` | number        | No       | Pipeline version (min: 1)                                                                                       |
| `flowJobId`       | string        | No       | BullMQ Flows parent job ID                                                                                      |

**Indexes:**

- `{ tenantId: 1, bullJobId: 1 }` **unique** — Prevent duplicate tracking
- `{ tenantId: 1, documentId: 1, createdAt: -1 }` — Document history (O(log n))
- `{ tenantId: 1, sourceId: 1, status: 1 }` — Source-level aggregations
- `{ pipelineId: 1, flowJobId: 1 }` — BullMQ Flows execution lookup
- `{ pipelineId: 1, pipelineVersion: 1, status: 1 }` — Pipeline metrics
- `{ createdAt: 1 }` **TTL** (90 days) — Auto-deletes old records (~180GB cap)

---

### SearchPipelineDefinition

**Collection:** `search_pipeline_definitions` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Pluggable ingestion pipeline configuration for a knowledge base. Contains multiple flows (processing paths) selected at runtime based on document properties. Single-document model with embedded flows, stages, and rule conditions.

**Database Affinity:** The model file does not self-register with `ModelRegistry`. Instead, `apps/search-ai/src/db/index.ts` registers it as `searchaicontent` at init time, placing it in the `search_ai` database. Accessed via `getLazyModel<ISearchPipelineDefinition>('SearchPipelineDefinition')`.

| Field                   | Type                     | Required | Description                                                                  |
| ----------------------- | ------------------------ | -------- | ---------------------------------------------------------------------------- |
| `_id`                   | string (UUIDv7)          | Yes      | Unique pipeline ID                                                           |
| `tenantId`              | string                   | Yes      | Tenant scope                                                                 |
| `knowledgeBaseId`       | string                   | Yes      | Knowledge base this pipeline belongs to                                      |
| `name`                  | string                   | Yes      | Display name (1-200 chars)                                                   |
| `description`           | string                   | No       | Description (max 1000 chars, default: '')                                    |
| `version`               | number                   | Yes      | Auto-incremented on save (default: 1)                                        |
| `status`                | string                   | Yes      | `draft` \| `active` \| `archived` (default: `draft`)                         |
| `flows`                 | ISearchPipelineFlow[]    | Yes      | 1-50 embedded flows (at least one must be `enabled`)                         |
| `activeEmbeddingConfig` | IActiveEmbeddingConfig   | Yes      | Pipeline-level embedding config (all flows share same embedding)             |
| `sharedStages`          | object                   | No       | `{ enrichment?: ISearchPipelineStage[], indexing?: ISearchPipelineStage[] }` |
| `providerDefaults`      | Record<string, object>   | No       | Default config per provider ID                                               |
| `previousVersion`       | Mixed                    | No       | Snapshot of previously active pipeline (for reindex diffing)                 |
| `createdBy`             | string                   | Yes      | User ID                                                                      |
| `lastDeployedAt`        | Date                     | No       | Last deployment timestamp                                                    |
| `validationErrors`      | ISearchValidationError[] | No       | `[{ code, message, severity, path }]`                                        |
| `validationStatus`      | string                   | No       | `valid` \| `invalid` \| `pending`                                            |
| `lastValidatedAt`       | Date                     | No       | Last validation timestamp                                                    |

**IActiveEmbeddingConfig** (embedded sub-document):

| Field            | Type                    | Required | Description                                       |
| ---------------- | ----------------------- | -------- | ------------------------------------------------- |
| `provider`       | string                  | Yes      | `openai` \| `cohere` \| `bge-m3` \| `custom`      |
| `model`          | string                  | Yes      | Model identifier (default: `bge-m3`)              |
| `dimensions`     | number                  | Yes      | Vector dimensions (default: 1024, min: 1)         |
| `providerConfig` | Record<string, unknown> | No       | Provider-specific config (baseUrl, timeout, etc.) |

**ISearchPipelineFlow** (embedded sub-document):

| Field              | Type                   | Required | Description                                       |
| ------------------ | ---------------------- | -------- | ------------------------------------------------- |
| `id`               | string                 | Yes      | Flow identifier                                   |
| `name`             | string                 | Yes      | Display name (1-200 chars)                        |
| `description`      | string                 | No       | Description (max 1000 chars)                      |
| `enabled`          | boolean                | Yes      | Active toggle (default: true)                     |
| `selectionRules`   | ISearchRuleCondition[] | No       | Rules for matching documents to this flow         |
| `priority`         | number                 | Yes      | 0-100 (higher = evaluated first)                  |
| `isDefault`        | boolean                | Yes      | Default/fallback flow (default: false)            |
| `templateVersion`  | string                 | No       | Template version for upgrade tracking             |
| `stages`           | ISearchPipelineStage[] | Yes      | At least 1 stage required                         |
| `customEnrichment` | ISearchPipelineStage[] | No       | Custom enrichment stages                          |
| `customIndexing`   | ISearchPipelineStage[] | No       | Custom indexing stages                            |
| `providerDefaults` | Record<string, object> | No       | Flow-level provider defaults (overrides pipeline) |

**ISearchPipelineStage** (embedded sub-document):

| Field                     | Type                    | Required | Description                                                               |
| ------------------------- | ----------------------- | -------- | ------------------------------------------------------------------------- |
| `id`                      | string                  | Yes      | Stage identifier                                                          |
| `name`                    | string                  | Yes      | Display name (1-200 chars)                                                |
| `type`                    | string                  | Yes      | `extraction` \| `chunking` \| `enrichment` \| `embedding` \| `multimodal` |
| `provider`                | string                  | Yes      | Provider identifier (e.g., `docling`, `bge-m3`)                           |
| `providerConfig`          | Record<string, unknown> | Yes      | Provider-specific config (default: `{}`)                                  |
| `onError`                 | string                  | Yes      | `fail` \| `continue` (default: `fail`)                                    |
| `fallbackProvider`        | string                  | No       | Fallback provider on failure                                              |
| `fallbackConfig`          | Record<string, unknown> | No       | Fallback provider config                                                  |
| `executionCondition`      | string                  | No       | CEL expression for conditional execution                                  |
| `requiredProviderVersion` | string                  | No       | Semver constraint                                                         |
| `description`             | string                  | No       | Description (max 1000 chars)                                              |
| `estimatedDuration`       | number                  | No       | Estimated execution time in ms                                            |
| `estimatedCost`           | number                  | No       | Estimated cost in USD                                                     |

**ISearchRuleCondition** (embedded, recursive for compound):

| Field           | Type                   | Required                 | Description                                                                       |
| --------------- | ---------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `type`          | string                 | Yes                      | `simple` \| `compound` \| `cel`                                                   |
| `description`   | string                 | No                       | Human-readable description                                                        |
| `field`         | string                 | Yes (if `type=simple`)   | Dot-path field (e.g., `document.extension`)                                       |
| `operator`      | string                 | Yes (if `type=simple`)   | `eq` \| `ne` \| `gt` \| `lt` \| `gte` \| `lte` \| `contains` \| `matches` \| `in` |
| `value`         | Mixed                  | Yes (if `type=simple`)   | Comparison value                                                                  |
| `logic`         | string                 | Yes (if `type=compound`) | `AND` \| `OR`                                                                     |
| `conditions`    | ISearchRuleCondition[] | Yes (if `type=compound`) | Nested conditions                                                                 |
| `celExpression` | string                 | Yes (if `type=cel`)      | CEL expression string                                                             |

**Indexes:**

- `{ tenantId: 1, knowledgeBaseId: 1 }` **unique** — One pipeline per knowledge base per tenant
- `{ tenantId: 1, status: 1 }` — Status filtering
- `{ tenantId: 1, 'flows.id': 1 }` — Flow lookup

**Pre-save Middleware:**

1. **Version auto-increment**: `version += 1` on every non-new save
2. **Enabled flow validation**: At least one flow must have `enabled: true`

**Notes:**

- Pipeline-level embedding: all flows share `activeEmbeddingConfig` (no per-flow embedding)
- Changing `activeEmbeddingConfig` triggers full reindex (checkpoint 4)
- `previousVersion` stores the last active pipeline snapshot for reindex diff computation
- See [`INGESTION-PIPELINE-GUIDE.md`](./INGESTION-PIPELINE-GUIDE.md) for scene-by-scene walkthrough

---

## Platform Models Used by Search-AI (`abl_platform` database)

### SearchIndex

**Collection:** `search_indexes` | **Plugins:** tenantIsolationPlugin

Central configuration for a search index. Highly configurable with per-use-case LLM settings.

| Field                 | Type                 | Required | Description                                                                 |
| --------------------- | -------------------- | -------- | --------------------------------------------------------------------------- |
| `_id`                 | string (UUIDv7)      | Yes      | Unique index ID                                                             |
| `tenantId`            | string               | Yes      | Tenant scope                                                                |
| `projectId`           | string               | Yes      | Project scope                                                               |
| `slug`                | string               | Yes      | URL-safe slug                                                               |
| `name`                | string               | Yes      | Display name                                                                |
| `description`         | string \| null       | No       | Description                                                                 |
| `embeddingModel`      | string               | Yes      | Model name (default: text-embedding-3-small)                                |
| `embeddingDimensions` | number               | Yes      | Vector dimensions (default: 1536)                                           |
| `tokenChunkStrategy`  | object \| null       | No       | `{ method, chunkSize, chunkOverlap }` or null for page-based                |
| `vectorStore`         | object               | Yes      | `{ provider, collectionName, connectionConfig? }`                           |
| `searchDefaults`      | object               | Yes      | `{ topK, similarityThreshold, includeMetadata, includeContent, reranker? }` |
| `llmConfig`           | SearchIndexLLMConfig | No       | Per-use-case LLM overrides (see below)                                      |
| `queryLLMConfig`      | object \| null       | No       | Query pipeline LLM: `{ modelId, autoSelect, preferredTier }`                |
| `status`              | string               | Yes      | `creating` \| `ready` \| `rebuilding` \| `error`                            |
| `documentCount`       | number               | No       | Total documents (default: 0)                                                |
| `chunkCount`          | number               | No       | Total chunks (default: 0)                                                   |
| `sourceCount`         | number               | No       | Total sources (default: 0)                                                  |
| `lastIndexedAt`       | Date \| null         | No       | Last indexing timestamp                                                     |
| `indexError`          | string \| null       | No       | Error description                                                           |

**LLM Config Use Cases** (`llmConfig.useCases`):

| Use Case                   | Key Settings                                               |
| -------------------------- | ---------------------------------------------------------- |
| `progressiveSummarization` | enabled, modelTier, maxTokens, enableDocumentSummary       |
| `questionSynthesis`        | enabled, modelTier, questionsPerChunk, enableEmbedding     |
| `vision`                   | enabled, modelTier, analyzeScreenshots, analyzeImages      |
| `multimodal`               | enabled, enableImageDescription, enableTableSummarization  |
| `knowledgeGraph`           | enabled, modelTier, enableCoOccurrence                     |
| `noiseDetection`           | enabled, modelTier, conceptConfidenceThreshold             |
| `treeBuilder`              | enabled, maxDepth, maxChildrenPerNode, similarityThreshold |
| `scopeClassification`      | enabled, modelTier, maxTokens                              |
| `mapping_suggestion`       | enabled, modelTier, maxTokens                              |
| `vocabularyGeneration`     | enabled, modelTier, maxTokens                              |

**Indexes:**

- `{ tenantId: 1, projectId: 1, slug: 1 }` **unique** — Slug uniqueness within project
- `{ tenantId: 1, projectId: 1 }` — Project lookup
- `{ tenantId: 1, status: 1 }` — Status filtering

---

### KnowledgeBase

**Collection:** `knowledge_bases` | **Plugins:** tenantIsolationPlugin

User-facing entity for RAG. Owns a linked SearchIndex (auto-created) and one or more connectors.

| Field               | Type            | Required | Description                                      |
| ------------------- | --------------- | -------- | ------------------------------------------------ |
| `_id`               | string (UUIDv7) | Yes      | Unique KB ID                                     |
| `tenantId`          | string          | Yes      | Tenant scope                                     |
| `projectId`         | string          | Yes      | Project scope                                    |
| `name`              | string          | Yes      | Display name                                     |
| `description`       | string \| null  | No       | Description                                      |
| `searchIndexId`     | string \| null  | No       | Link to auto-created SearchIndex                 |
| `canonicalSchemaId` | string \| null  | No       | Reference to canonical schema (Layer 2)          |
| `connectorCount`    | number          | No       | Denormalized count (default: 0)                  |
| `status`            | string          | Yes      | `creating` \| `ready` \| `rebuilding` \| `error` |
| `documentCount`     | number          | No       | Total documents (default: 0)                     |
| `lastIndexedAt`     | Date \| null    | No       | Last indexing timestamp                          |
| `indexError`        | string \| null  | No       | Error description                                |
| `isPublic`          | boolean         | No       | Public access (default: false)                   |
| `metadata`          | Mixed           | No       | Extensible metadata                              |

**Indexes:**

- `{ tenantId: 1, projectId: 1, name: 1 }` **unique** — Name uniqueness within project
- `{ tenantId: 1, projectId: 1 }` — Project lookup
- `{ status: 1 }` — Status filtering

---

### LLMCredential

**Collection:** `llm_credentials` | **Plugins:** tenantIsolationPlugin, **encryptionPlugin** (apiKey, endpoint), auditTrailPlugin

Encrypted API keys and endpoint configurations. **Never use `.lean()` on this model.**

| Field               | Type            | Required | Description                              |
| ------------------- | --------------- | -------- | ---------------------------------------- |
| `_id`               | string (UUIDv7) | Yes      | Unique credential ID                     |
| `credentialScope`   | string          | Yes      | `user` \| `tenant`                       |
| `ownerId`           | string          | Yes      | User or tenant ID                        |
| `tenantId`          | string          | Yes      | Tenant scope                             |
| `provider`          | string          | Yes      | `anthropic` \| `openai` \| `gemini` etc. |
| `name`              | string          | Yes      | Display name                             |
| `encryptedApiKey`   | string          | Yes      | **Encrypted** (AES-256-GCM via plugin)   |
| `encryptedEndpoint` | string \| null  | No       | **Encrypted** custom endpoint            |
| `isActive`          | boolean         | No       | Active flag (default: true)              |
| `isDefault`         | boolean         | No       | Default credential (default: false)      |
| `lastUsedAt`        | Date \| null    | No       | Last usage timestamp                     |

**Indexes:**

- `{ tenantId: 1, credentialScope: 1, ownerId: 1, provider: 1, name: 1 }` **unique**
- `{ tenantId: 1, credentialScope: 1, ownerId: 1 }` — Scope lookup

---

### TenantModel

**Collection:** `tenant_models` | **Plugins:** tenantIsolationPlugin, encryptionPlugin

LLM model configured at tenant level. Supports multiple named connections per model.

| Field               | Type                     | Required | Description                         |
| ------------------- | ------------------------ | -------- | ----------------------------------- |
| `_id`               | string (UUIDv7)          | Yes      | Unique model ID                     |
| `tenantId`          | string                   | Yes      | Tenant scope                        |
| `displayName`       | string                   | Yes      | Display name                        |
| `integrationType`   | string                   | Yes      | `easy` \| `api`                     |
| `modelId`           | string \| null           | No       | Provider model ID                   |
| `provider`          | string \| null           | No       | `anthropic` \| `openai` etc.        |
| `temperature`       | number                   | Yes      | Default temperature                 |
| `maxTokens`         | number                   | Yes      | Default max tokens                  |
| `supportsTools`     | boolean                  | Yes      | Tool use support                    |
| `supportsStreaming` | boolean                  | Yes      | Streaming support                   |
| `supportsVision`    | boolean                  | Yes      | Vision support                      |
| `tier`              | string                   | Yes      | `fast` \| `balanced` \| `powerful`  |
| `isDefault`         | boolean                  | No       | Default model (default: false)      |
| `isActive`          | boolean                  | No       | Active flag (default: true)         |
| `connections`       | ITenantModelConnection[] | No       | Named connections with credentialId |

**Indexes:**

- `{ tenantId: 1, displayName: 1 }` **unique**
- `{ tenantId: 1, tier: 1, isActive: 1 }` — Tier-based lookup
- `{ tenantId: 1, provider: 1, isActive: 1 }` — Provider lookup

---

### TenantLLMPolicy

**Collection:** `tenant_llm_policies` | **Plugins:** tenantIsolationPlugin

Tenant-level policies governing LLM usage, rate limits, and budgets.

| Field                  | Type     | Required | Description                                       |
| ---------------------- | -------- | -------- | ------------------------------------------------- |
| `_id`                  | string   | Yes      | Unique policy ID                                  |
| `tenantId`             | string   | Yes      | Tenant scope                                      |
| `allowedProviders`     | string[] | No       | Allowed LLM providers                             |
| `credentialPolicy`     | string   | Yes      | `tenant-only` \| `project-scoped` \| `permissive` |
| `monthlyTokenBudget`   | number   | Yes      | Monthly token limit                               |
| `dailyTokenBudget`     | number   | Yes      | Daily token limit                                 |
| `defaultModel`         | string   | No       | Default TenantModel displayName                   |
| `maxRequestsPerMinute` | number   | Yes      | Rate limit                                        |
| `platformDemoEnabled`  | boolean  | Yes      | Demo mode toggle                                  |

**Indexes:**

- `{ tenantId: 1 }` **unique** — One policy per tenant

---

### ConnectorConfig

**Collection:** `connector_configs` | **Plugins:** tenantIsolationPlugin

Configuration and state for enterprise data connectors (SharePoint, Jira, etc.).

| Field              | Type   | Required | Description                                              |
| ------------------ | ------ | -------- | -------------------------------------------------------- |
| `_id`              | string | Yes      | Unique config ID                                         |
| `tenantId`         | string | Yes      | Tenant scope                                             |
| `sourceId`         | string | Yes      | References SearchSource.\_id                             |
| `connectorType`    | string | Yes      | `sharepoint` \| `jira` \| `confluence` \| `hubspot` etc. |
| `oauthTokenId`     | string | No       | References EndUserOAuthToken.\_id                        |
| `connectionConfig` | Mixed  | No       | `{ tenantUrl?, clientId?, scopes? }`                     |
| `syncState`        | object | Yes      | `{ lastFullSyncAt, deltaToken, syncInProgress, ... }`    |
| `filterConfig`     | object | Yes      | `{ mode, siteUrls, contentTypes, modifiedSince }`        |
| `permissionConfig` | object | Yes      | `{ mode, crawlSchedule, lastCrawlAt, ... }`              |
| `errorState`       | object | Yes      | `{ consecutiveFailures, isPaused, pauseReason }`         |

**Indexes:**

- `{ tenantId: 1, sourceId: 1 }` **unique** — Connector by source
- `{ tenantId: 1, connectorType: 1 }` — By type
- `{ 'errorState.isPaused': 1, oauthTokenId: 1 }` — Sync candidates

---

### ConnectorSchema

**Collection:** `connector_schemas` | **Plugins:** tenantIsolationPlugin

Discovered field schema from source connector APIs. Auto-populated during sync (Layer 1 of canonical mapping).

| Field              | Type                    | Required | Description                                                          |
| ------------------ | ----------------------- | -------- | -------------------------------------------------------------------- |
| `_id`              | string (UUIDv7)         | Yes      | Unique schema ID                                                     |
| `tenantId`         | string                  | Yes      | Tenant scope                                                         |
| `connectorId`      | string                  | Yes      | References ConnectorConfig.\_id                                      |
| `version`          | number                  | Yes      | Increments on schema changes (default: 1)                            |
| `fields`           | IConnectorSchemaField[] | No       | Recursive: `{ path, label, type, isCustom, enumValues?, children? }` |
| `fieldCount`       | number                  | No       | Total fields (default: 0)                                            |
| `customFieldCount` | number                  | No       | Custom fields (default: 0)                                           |
| `status`           | string                  | Yes      | `draft` \| `active`                                                  |
| `discoveredAt`     | Date                    | Yes      | Schema discovery timestamp                                           |

**Indexes:**

- `{ connectorId: 1, version: 1 }` **unique** — Version uniqueness
- `{ connectorId: 1 }` — By connector

---

### CanonicalSchema

**Collection:** `canonical_schemas` | **Plugins:** tenantIsolationPlugin

Normalized field schema per knowledge base (Layer 2). Each field has two identities: an alias name (business-friendly, used by agents/UI) and a storageField (actual vector store path). See `04-CANONICAL-SCHEMA-ALIAS-DESIGN.md` for full design.

| Field             | Type              | Required | Description                                  |
| ----------------- | ----------------- | -------- | -------------------------------------------- |
| `_id`             | string (UUIDv7)   | Yes      | Unique schema ID                             |
| `tenantId`        | string            | Yes      | Tenant scope                                 |
| `knowledgeBaseId` | string            | Yes      | References SearchIndex.\_id                  |
| `version`         | number            | Yes      | Increments on field changes (default: 1)     |
| `fields`          | ICanonicalField[] | No       | Canonical field definitions with alias layer |
| `status`          | string            | Yes      | `draft` \| `active`                          |

**ICanonicalField sub-document:**

| Field                  | Type                    | Required | Description                                                          |
| ---------------------- | ----------------------- | -------- | -------------------------------------------------------------------- |
| `name`                 | string                  | Yes      | Alias name (business-friendly, e.g., `priority_level`)               |
| `label`                | string                  | Yes      | Display label (e.g., "Priority Level")                               |
| `type`                 | string                  | Yes      | Data type: string, number, float, date, boolean, text, array         |
| `description`          | string                  | No       | LLM context — helps agents understand purpose                        |
| `storageField`         | string                  | Yes      | Actual storage field under `metadata.canonical.*` (e.g., `priority`) |
| `indexed`              | boolean                 | No       | Whether the storage field is indexed (default: false)                |
| `filterable`           | boolean                 | No       | Exposed for filtering (default: false)                               |
| `aggregatable`         | boolean                 | No       | Exposed for grouping (default: false)                                |
| `sortable`             | boolean                 | No       | Exposed for sorting (default: false)                                 |
| `enumValues`           | Record\<string,unknown> | No       | Display→stored value map (e.g., `{ "high": 0.8, "low": 0.2 }`)       |
| `sourceConnectorField` | string                  | No       | Original connector field path for traceability                       |

**Indexes:**

- `{ knowledgeBaseId: 1, version: 1 }` **unique** — Version uniqueness
- `{ knowledgeBaseId: 1 }` — By KB
- `{ tenantId: 1 }` — By tenant

---

### FieldMapping

**Collection:** `field_mappings` | **Plugins:** tenantIsolationPlugin

Maps source connector fields to canonical schema fields (Layer 1→2 bridge). Applied at ingestion time by CanonicalMapperService. `canonicalField` stores the storage field name (not the alias name).

| Field               | Type            | Required | Description                                                     |
| ------------------- | --------------- | -------- | --------------------------------------------------------------- |
| `_id`               | string (UUIDv7) | Yes      | Unique mapping ID                                               |
| `tenantId`          | string          | Yes      | Tenant scope                                                    |
| `canonicalSchemaId` | string          | Yes      | References CanonicalSchema.\_id                                 |
| `canonicalField`    | string          | Yes      | Target storage field name (e.g., `priority`, `custom_string_1`) |
| `connectorId`       | string          | Yes      | Source connector ID                                             |
| `sourcePath`        | string          | Yes      | Dot-notation path in source (e.g., `fields.priority.name`)      |
| `transform`         | IFieldTransform | Yes      | Transform to apply: direct, lowercase, split, value_map, etc.   |
| `confidence`        | number          | No       | LLM suggestion confidence 0.0–1.0                               |
| `status`            | string          | Yes      | `suggested` \| `confirmed` \| `rejected`                        |
| `isActive`          | boolean         | No       | True when confirmed (active for ingestion)                      |
| `suggestedBy`       | string          | No       | `llm` or `user`                                                 |
| `reviewedBy`        | string          | No       | Who confirmed/rejected                                          |
| `reviewedAt`        | Date            | No       | Review timestamp                                                |

**Indexes:**

- `{ canonicalSchemaId: 1, canonicalField: 1, connectorId: 1 }` **unique** — One mapping per field per connector
- `{ status: 1 }` — Filter by review status
- `{ tenantId: 1, canonicalSchemaId: 1 }` — By tenant + schema

---

### DomainVocabulary

**Collection:** `domain_vocabularies` | **Plugins:** tenantIsolationPlugin

Business-level vocabulary that resolves to canonical fields at query time (Layer 3). Scoped to a ProjectKnowledgeBase. `fieldRef` stores alias names (from CanonicalSchema.fields[].name), not storage field names.

| Field                    | Type               | Required | Description                       |
| ------------------------ | ------------------ | -------- | --------------------------------- |
| `_id`                    | string (UUIDv7)    | Yes      | Unique vocabulary ID              |
| `tenantId`               | string             | Yes      | Tenant scope                      |
| `projectKnowledgeBaseId` | string             | Yes      | References SearchIndex.\_id       |
| `version`                | number             | Yes      | Version number (default: 1)       |
| `status`                 | string             | Yes      | `draft` \| `active` \| `inactive` |
| `entries`                | IVocabularyEntry[] | No       | Embedded vocabulary entries       |

**IVocabularyEntry sub-document:**

| Field           | Type     | Required | Description                                          |
| --------------- | -------- | -------- | ---------------------------------------------------- |
| `id`            | string   | Yes      | Entry ID                                             |
| `term`          | string   | Yes      | Primary term (e.g., "priority")                      |
| `aliases`       | string[] | No       | Alternative terms (e.g., ["urgency", "importance"])  |
| `description`   | string   | No       | Term description                                     |
| `fieldRef`      | string   | Yes      | Alias name reference (e.g., `priority_level`)        |
| `capabilities`  | object   | No       | `{ canFilter, canDisplay, canAggregate, canSort }`   |
| `relatedFields` | object   | No       | `{ displayWith: string[], aggregateWith: string[] }` |
| `enabled`       | boolean  | No       | Whether this entry is active (default: true)         |
| `generatedBy`   | string   | No       | `auto` \| `manual`                                   |

**Indexes:**

- `{ projectKnowledgeBaseId: 1, version: 1 }` **unique** — Version uniqueness
- `{ tenantId: 1 }` — By tenant

---

### AttributeRegistry

**Collection:** `attribute_registry` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Product-scoped attribute definitions for the Browse SDK (Sprints 2-7). Each entry represents a single attribute (e.g., "interest_rate") within a specific product scope (e.g., "credit_card") for an index. Attributes progress through tiers: `novel → beta → approved → permanent`. The `discarded` tier is for rejected attributes.

| Field                | Type            | Required | Description                                                     |
| -------------------- | --------------- | -------- | --------------------------------------------------------------- |
| `_id`                | string (UUIDv7) | Yes      | Unique attribute ID                                             |
| `tenantId`           | string          | Yes      | Tenant scope                                                    |
| `indexId`            | string          | Yes      | References SearchIndex.\_id                                     |
| `attributeId`        | string          | Yes      | Snake_case base concept (e.g., "interest_rate")                 |
| `productScope`       | string          | Yes      | Product type (e.g., "credit_card")                              |
| `tier`               | string          | Yes      | `permanent` \| `approved` \| `beta` \| `novel` \| `discarded`   |
| `displayName`        | string          | Yes      | Product-specific display name (e.g., "Interest Rate (APR)")     |
| `dataType`           | string          | Yes      | `percentage` \| `currency` \| `date` \| `string` \| etc.        |
| `aliases`            | string[]        | No       | Alternate names for this attribute                              |
| `extractionPatterns` | string[]        | No       | Regex patterns for extraction (generated by few-shot generator) |
| `typicalRange`       | string          | No       | From org profile, per product (e.g., "15-30%")                  |
| `definition`         | string          | No       | Human-readable definition                                       |
| `discoverySource`    | string          | No       | `domain_definition` \| `llm_extraction` \| `admin_manual`       |
| `confidence`         | number          | No       | 0-1, from LLM extraction                                        |
| `firstSeenAt`        | Date            | No       | When first discovered                                           |
| `lastSeenAt`         | Date            | No       | Most recent document occurrence                                 |
| `lastReconciledAt`   | Date            | No       | Last reconciliation pass (prevents re-clustering)               |
| `documentCount`      | number          | No       | Documents where this attribute appears                          |
| `uniqueUsers`        | number          | No       | Unique users who interacted (Sprint 6 auto-promotion)           |
| `totalInteractions`  | number          | No       | Total interaction count (Sprint 6 auto-promotion)               |

**Indexes:**

- `{ tenantId, indexId, attributeId, productScope }` **unique** — Compound identity: one attribute per product scope per index
- `{ tenantId, indexId, tier }` — Tier-based queries for an index
- `{ tenantId, indexId, tier, lastReconciledAt }` — Find unreconciled novel attributes

**Key Behaviors:**

- `discoverySource: 'admin_manual'` — set on any admin PATCH/bulk operation; auto-promoter and scheduler skip these attributes
- Compound key `{tenantId, indexId, attributeId, productScope}` means the same `attributeId` can exist across different product scopes with different tiers/configs

---

### AttributeMergeEvent

**Collection:** `attribute_merge_events` | **Plugins:** tenantIsolationPlugin | **DB:** searchaicontent

Records merge operations when duplicate/similar attributes are reconciled. Supports both automatic reconciliation (Sprint 5 clustering) and admin-initiated merges (Sprint 7 UI), with reversibility tracking.

| Field                | Type            | Required | Description                                     |
| -------------------- | --------------- | -------- | ----------------------------------------------- |
| `_id`                | string (UUIDv7) | Yes      | Unique merge event ID                           |
| `tenantId`           | string          | Yes      | Tenant scope                                    |
| `indexId`            | string          | Yes      | References SearchIndex.\_id                     |
| `productScope`       | string          | Yes      | Product type                                    |
| `timestamp`          | Date            | Yes      | When merge occurred                             |
| `sourceAttributeIds` | string[]        | No       | Attributes that were merged into target         |
| `targetAttributeId`  | string          | Yes      | Surviving attribute after merge                 |
| `mergeScore`         | number          | Yes      | Similarity score (0-1) that triggered the merge |
| `mergeMethod`        | string          | Yes      | `auto_reconciliation` \| `admin_manual`         |
| `reversible`         | boolean         | No       | Whether merge can be undone (default: true)     |
| `reversedAt`         | Date            | No       | When merge was reversed (null if still merged)  |
| `metadata`           | object          | No       | `{ clusterSize?, promotionTier?, reason? }`     |

**Indexes:**

- `{ tenantId, indexId, timestamp: -1 }` — Timeline queries: merge events for an index ordered by time
- `{ tenantId, targetAttributeId }` — Lookup: all merges targeting a specific attribute

---

### AuditLog

**Collection:** `audit_logs` | **Plugins:** None | **DB:** platform

General-purpose audit trail for write operations. Populated by the `auditTrailPlugin` on LLMCredential and other sensitive models. Note: `tenantId` is nullable to support cross-tenant admin queries.

| Field       | Type          | Required | Description                        |
| ----------- | ------------- | -------- | ---------------------------------- |
| `_id`       | string (UUID) | Yes      | Unique audit log ID                |
| `userId`    | string        | No       | User who performed the action      |
| `tenantId`  | string        | No       | Tenant scope (nullable for admins) |
| `action`    | string        | Yes      | Action performed                   |
| `ip`        | string        | No       | Client IP address                  |
| `userAgent` | string        | No       | Client user-agent                  |
| `metadata`  | Mixed         | No       | Action-specific context            |

**Indexes:**

- `{ tenantId: 1, createdAt: -1 }` — Tenant audit trail
- `{ userId: 1 }` — User activity
- `{ action: 1 }` — Filter by action type
- `{ createdAt: -1 }` — Global timeline
- `{ tenantId: 1, action: 1, createdAt: -1 }` — Filtered audit trail
- `{ tenantId: 1, 'metadata.resourceType': 1, 'metadata.resourceId': 1 }` **sparse** — Resource-specific lookups

---

### ConnectorDiscovery

**Collection:** `connector_discoveries` | **Plugins:** tenantIsolationPlugin | **DB:** platform

Records the results of connector resource discovery (sites, libraries, drives). Auto-expires after 7 days via TTL index.

| Field            | Type                 | Required | Description                                                                   |
| ---------------- | -------------------- | -------- | ----------------------------------------------------------------------------- |
| `_id`            | string (UUID)        | Yes      | Unique discovery ID                                                           |
| `tenantId`       | string               | Yes      | Tenant scope                                                                  |
| `connectorId`    | string               | Yes      | Connector being discovered                                                    |
| `status`         | string               | Yes      | `pending` \| `discovering` \| `profiling` \| `completed` \| `failed`          |
| `resources`      | DiscoveredResource[] | No       | `[{ id, name, displayName, url, resourceType, parentId, metadata }]`          |
| `profiles`       | ContentProfile[]     | No       | `[{ resourceId, totalDocuments, totalSizeBytes, fileTypeDistribution, ... }]` |
| `totalResources` | number               | No       | Count of discovered resources (default: 0)                                    |
| `discoveredAt`   | Date                 | No       | Discovery completion time                                                     |
| `durationMs`     | number               | No       | Discovery duration in ms                                                      |
| `error`          | string               | No       | Error message (if failed)                                                     |
| `jobId`          | string               | No       | BullMQ job ID                                                                 |
| `expiresAt`      | Date                 | Yes      | Auto-computed (now + 7 days)                                                  |

**Indexes:**

- `{ tenantId: 1, connectorId: 1 }` — Latest discovery per connector
- `{ expiresAt: 1 }` **TTL** (0s) — Auto-deletes expired records

---

### ConnectorRecommendation

**Collection:** `connector_recommendations` | **Plugins:** tenantIsolationPlugin | **DB:** platform

AI-generated connector setup recommendations (resource scores, sync strategy, permission mode, filter config, cost estimates). Auto-expires after 7 days.

| Field               | Type            | Required | Description                                                                                             |
| ------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `_id`               | string (UUID)   | Yes      | Unique recommendation ID                                                                                |
| `tenantId`          | string          | Yes      | Tenant scope                                                                                            |
| `connectorId`       | string          | Yes      | Connector this recommendation is for                                                                    |
| `discoveryId`       | string          | Yes      | Discovery that generated this recommendation                                                            |
| `status`            | string          | Yes      | `pending` \| `generated` \| `accepted` \| `rejected` \| `expired`                                       |
| `resourceScores`    | ResourceScore[] | No       | `[{ resourceId, resourceName, overallScore, recommended, factors, reasoning }]`                         |
| `syncStrategy`      | object          | Yes      | `{ syncMode, fullSyncSchedule, deltaSyncSchedule, enableWebhooks, reasoning, confidence }`              |
| `permissionMode`    | object          | Yes      | `{ mode: 'full'\|'simplified'\|'disabled', reasoning, confidence }`                                     |
| `filterConfig`      | object          | Yes      | `{ mode: 'include'\|'exclude', resourceIds, contentTypes, modifiedSince, reasoning }`                   |
| `costEstimate`      | object          | Yes      | `{ estimatedDocuments, estimatedStorageBytes, estimatedSyncDurationSeconds, estimatedMonthlyApiCalls }` |
| `overallConfidence` | number          | No       | Overall recommendation confidence (default: 0)                                                          |
| `userDecision`      | object          | No       | `{ action: 'accepted'\|'rejected'\|'modified', overrides, decidedAt }`                                  |
| `expiresAt`         | Date            | Yes      | Auto-computed (now + 7 days)                                                                            |

**Indexes:**

- `{ tenantId: 1, connectorId: 1 }` — Latest recommendation per connector
- `{ tenantId: 1, discoveryId: 1 }` — Lookup by discovery
- `{ expiresAt: 1 }` **TTL** (0s) — Auto-deletes expired records

---

### EndUserOAuthToken

**Collection:** `end_user_oauth_tokens` | **Plugins:** tenantIsolationPlugin, encryptionPlugin | **DB:** platform

Stores end-user OAuth tokens for connector access (e.g., SharePoint user-delegated auth). Access and refresh tokens are encrypted at rest via `encryptionPlugin`.

| Field                   | Type          | Required | Description                        |
| ----------------------- | ------------- | -------- | ---------------------------------- |
| `_id`                   | string (UUID) | Yes      | Unique token ID                    |
| `tenantId`              | string        | Yes      | Tenant scope                       |
| `userId`                | string        | Yes      | Platform user ID                   |
| `provider`              | string        | Yes      | OAuth provider (e.g., `microsoft`) |
| `providerUserId`        | string        | Yes      | User ID from the provider          |
| `encryptedAccessToken`  | string        | Yes      | **Encrypted** access token         |
| `encryptedRefreshToken` | string        | No       | **Encrypted** refresh token        |
| `scope`                 | string        | Yes      | OAuth scope granted                |
| `expiresAt`             | Date          | No       | Token expiry                       |
| `refreshedAt`           | Date          | No       | Last refresh timestamp             |
| `consentedAt`           | Date          | Yes      | When user granted consent          |
| `revokedAt`             | Date          | No       | Revocation timestamp (if revoked)  |
| `lastUsedAt`            | Date          | No       | Last API call using this token     |

**Indexes:**

- `{ tenantId: 1, userId: 1, provider: 1 }` **unique** — One token per user per provider
- `{ tenantId: 1 }` — By tenant

**Notes:** Never use `.lean()` — bypasses decryption hooks for `encryptedAccessToken`/`encryptedRefreshToken`.

---

## Connector & Crawl Models

### CrawlJob

**Collection:** `crawl_jobs` | **Plugins:** tenantIsolationPlugin

Web crawl execution record. Tracks full lifecycle from queued through completed/failed, with URL tracking, configuration, results, and quality metrics.

| Field                      | Type          | Required | Description                                                                                   |
| -------------------------- | ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `_id`                      | string (UUID) | Yes      | Unique crawl job ID                                                                           |
| `tenantId`                 | string        | Yes      | Tenant scope                                                                                  |
| `userId`                   | string        | No       | User who initiated the crawl                                                                  |
| `status`                   | string        | Yes      | `queued` \| `crawling` \| `ingesting` \| `indexing` \| `completed` \| `failed` \| `cancelled` |
| `strategy`                 | string        | Yes      | `browser` \| `bulk` \| `hybrid` \| `intelligence` \| `single-page` \| `sitemap` \| `smart`    |
| `urls.original`            | string[]      | No       | User-provided seed URLs                                                                       |
| `urls.expanded`            | string[]      | No       | Discovered URLs                                                                               |
| `urls.crawled`             | number        | No       | Successfully crawled count                                                                    |
| `urls.failed`              | number        | No       | Failed URL count                                                                              |
| `configuration`            | object        | No       | `{ strategy, limits, discovery, filters }` — crawl config                                     |
| `timeline.submittedAt`     | Date          | Yes      | Submission time                                                                               |
| `timeline.startedAt`       | Date          | No       | Start time                                                                                    |
| `timeline.completedAt`     | Date          | No       | Completion time                                                                               |
| `results.documentsCreated` | number        | No       | Documents created (default: 0)                                                                |
| `results.documentsIndexed` | number        | No       | Documents indexed                                                                             |
| `results.documentsFailed`  | number        | No       | Documents failed                                                                              |
| `results.chunksCreated`    | number        | No       | Chunks created                                                                                |
| `results.qualityMetrics`   | object        | No       | `{ avgQualityScore, avgContentPreservation, avgChunksPerDoc, successRate }`                   |
| `comparison`               | object        | No       | Delta comparison with previous crawl                                                          |
| `indexId`                  | string        | No       | Target search index                                                                           |
| `sourceId`                 | string        | No       | Target search source                                                                          |

**Indexes:**

- `{ tenantId: 1, createdAt: -1 }` — Tenant crawl history
- `{ tenantId: 1, status: 1 }` — Active crawls
- `{ userId: 1, createdAt: -1 }` — User crawl history
- `{ indexId: 1, createdAt: -1 }` — Crawls per index
- `{ tenantId: 1, indexId: 1, _id: -1 }` — Cursor-based pagination

---

### CrawlHistory

**Collection:** `crawl_history` | **Plugins:** tenantIsolationPlugin

Timeline of status transitions, document processing events, and performance metrics for a crawl job.

| Field                   | Type                   | Required | Description                                                                                               |
| ----------------------- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `_id`                   | string (UUID)          | Yes      | Unique history ID                                                                                         |
| `tenantId`              | string                 | Yes      | Tenant scope                                                                                              |
| `crawlJobId`            | string                 | Yes      | Associated crawl job                                                                                      |
| `statuses`              | StatusUpdate[]         | No       | `[{ timestamp, status, phase, reason, metrics }]`                                                         |
| `documentStatusChanges` | DocumentStatusChange[] | No       | `[{ documentId, fromStatus, toStatus, timestamp, worker, durationMs }]`                                   |
| `performance`           | PerformanceMetric[]    | No       | `[{ timestamp, phase, documentsProcessed, chunksCreated, avgProcessingTimeMs, queueDepth, workerCount }]` |

**Indexes:**

- `{ crawlJobId: 1 }` — Lookup by crawl job
- `{ tenantId: 1, createdAt: -1 }` — Tenant timeline

---

### CrawlAuditEvent

**Collection:** `crawl_audit_events` | **Plugins:** tenantIsolationPlugin

Crawl-specific audit events for compliance tracking (strategy changes, retries, user overrides).

| Field            | Type          | Required | Description                                                                          |
| ---------------- | ------------- | -------- | ------------------------------------------------------------------------------------ |
| `_id`            | string (UUID) | Yes      | Unique event ID                                                                      |
| `tenantId`       | string        | Yes      | Tenant scope                                                                         |
| `crawlJobId`     | string        | Yes      | Associated crawl job                                                                 |
| `userId`         | string        | No       | User who triggered the event                                                         |
| `eventType`      | string        | Yes      | `crawl.started` \| `crawl.paused` \| `crawl.completed` \| `strategy.selected` \| ... |
| `description`    | string        | Yes      | Human-readable description                                                           |
| `changes.before` | Mixed         | No       | Previous state                                                                       |
| `changes.after`  | Mixed         | No       | New state                                                                            |
| `context`        | object        | Yes      | `{ strategy, urls, estimatedDocuments, userAgent, ipAddress }`                       |
| `severity`       | string        | Yes      | `info` \| `warning` \| `error` (default: `info`)                                     |

**Indexes:**

- `{ tenantId: 1, createdAt: -1 }` — Tenant timeline
- `{ crawlJobId: 1 }` — Events per crawl
- `{ eventType: 1, createdAt: -1 }` — Filter by event type
- `{ userId: 1, createdAt: -1 }` — User activity

---

### CrawlDraft

**Collection:** `crawl_drafts` | **Plugins:** tenantIsolationPlugin

Persists the multi-step crawl configuration flow (CrawlFlowV5). Stores site profile, discovered sections, user config choices, and discovery panel state. Auto-expires via TTL.

| Field            | Type          | Required | Description                                                                 |
| ---------------- | ------------- | -------- | --------------------------------------------------------------------------- |
| `_id`            | string (UUID) | Yes      | Unique draft ID (UUIDv7)                                                    |
| `_v`             | number        | No       | Schema version (default: 1)                                                 |
| `tenantId`       | string        | Yes      | Tenant scope                                                                |
| `projectId`      | string        | Yes      | Project scope                                                               |
| `createdBy`      | string        | Yes      | User who created the draft                                                  |
| `flowState`      | string        | Yes      | `profiling` \| `sections_ready` \| `configured` \| `submitted`              |
| `url`            | string        | Yes      | Target URL                                                                  |
| `profile`        | object        | No       | Site profile: `{ domain, siteType, hasSitemap, jsRequired, estimatedSize }` |
| `sections`       | object[]      | No       | Section summaries: `[{ sectionId, pattern, name, source, pageCount }]`      |
| `config`         | object        | No       | `{ scope, rendering, maxPages, maxDepth, respectRobotsTxt, paths }`         |
| `sourceId`       | string        | No       | Reference to SearchSource                                                   |
| `crawlJobId`     | string        | No       | Set when crawl is submitted                                                 |
| `indexId`        | string        | No       | Target search index                                                         |
| `discoveryState` | Mixed         | No       | Persisted discovery panel UI state                                          |
| `strategy`       | string        | No       | User's chosen discovery strategy                                            |
| `version`        | number        | No       | Optimistic concurrency version (default: 1)                                 |
| `expiresAt`      | Date          | Yes      | TTL expiration timestamp                                                    |

**Indexes:**

- `{ tenantId: 1, projectId: 1, createdBy: 1, updatedAt: -1 }` — List user's drafts
- `{ tenantId: 1, projectId: 1, _id: 1 }` — Shard-safe lookup
- `{ tenantId: 1, flowState: 1 }` — Find by state
- `{ expiresAt: 1 }` **TTL** — Auto-delete expired drafts

---

### CrawlDraftUrlBucket

**Collection:** `crawl_draft_url_buckets` | **Plugins:** tenantIsolationPlugin

Stores discovered URLs in fixed-size buckets (500 URLs per bucket) for efficient pagination. Child of CrawlDraft; cascade-deleted at application level.

| Field         | Type          | Required | Description                                  |
| ------------- | ------------- | -------- | -------------------------------------------- |
| `_id`         | string (UUID) | Yes      | Unique bucket ID (UUIDv7)                    |
| `tenantId`    | string        | Yes      | Tenant scope                                 |
| `draftId`     | string        | Yes      | Parent CrawlDraft reference                  |
| `sectionId`   | string        | Yes      | Section within the draft                     |
| `bucketIndex` | number        | Yes      | Bucket sequence number (0-based)             |
| `urls`        | object[]      | No       | `[{ url, title?, score?, depth }]` — max 500 |
| `urlCount`    | number        | No       | Denormalized count                           |

**Indexes:**

- `{ tenantId: 1, draftId: 1, sectionId: 1, bucketIndex: 1 }` **unique** — Primary lookup + pagination
- `{ draftId: 1 }` — Cascade delete

---

### CrawlPattern

**Collection:** `crawl_patterns` | **Plugins:** tenantIsolationPlugin

Cached site profile data. Stores domain-level profiling results to avoid re-profiling. Auto-expires 90 days after last access.

| Field                  | Type          | Required | Description                                                |
| ---------------------- | ------------- | -------- | ---------------------------------------------------------- |
| `_id`                  | string (UUID) | Yes      | Unique pattern ID (UUIDv7)                                 |
| `domain`               | string        | Yes      | Normalized domain (e.g. "example.com")                     |
| `tenantId`             | string        | Yes      | Tenant scope                                               |
| `siteType`             | string        | Yes      | `static` \| `spa` \| `hybrid` \| `unknown`                 |
| `framework`            | string        | No       | Detected framework (e.g. "next", "react")                  |
| `jsRequired`           | boolean       | Yes      | Whether JS rendering is needed                             |
| `linkDensity`          | number        | Yes      | Links per page ratio                                       |
| `estimatedSize`        | number        | Yes      | Estimated total pages                                      |
| `avgResponseTime`      | number        | Yes      | Average response time (ms)                                 |
| `rateLimitDetected`    | boolean       | Yes      | Whether rate limiting was detected                         |
| `maxConcurrency`       | number        | Yes      | Recommended concurrency                                    |
| `confidence`           | number        | Yes      | Profile confidence score (0–100)                           |
| `metadata`             | Mixed         | No       | Extensible: `hasRobotsTxt`, `hasSitemap`, `scriptTagCount` |
| `totalCrawlsCompleted` | number        | No       | Count of completed crawls on this domain                   |
| `profiledAt`           | Date          | Yes      | When site was last profiled                                |
| `lastAccessedAt`       | Date          | Yes      | Last time pattern was read                                 |

**Indexes:**

- `{ tenantId: 1, domain: 1 }` **unique** — One pattern per domain per tenant
- `{ lastAccessedAt: 1 }` **TTL: 90 days** — Auto-delete stale patterns
- `{ tenantId: 1, lastAccessedAt: -1 }` — Most recently accessed
- `{ tenantId: 1, siteType: 1 }` — Analytics by site type
- `{ tenantId: 1, framework: 1 }` — Analytics by framework

---

### TenantCrawlPolicy

**Collection:** `tenant_crawl_policies` | **Plugins:** tenantIsolationPlugin

Admin-defined crawl policies per domain pattern. Governs allowed strategies, resource limits, and compliance settings. Uses ObjectId `_id` (not UUIDv7).

| Field                             | Type     | Required | Description                             |
| --------------------------------- | -------- | -------- | --------------------------------------- |
| `_id`                             | ObjectId | Yes      | Auto-generated                          |
| `tenantId`                        | string   | Yes      | Tenant scope                            |
| `domainPattern`                   | string   | Yes      | Exact or wildcard domain pattern        |
| `allowedStrategies`               | string[] | Yes      | `browser` \| `bulk` \| `hybrid` (min 1) |
| `limits.maxBatchSize`             | number   | Yes      | Max URLs per batch                      |
| `limits.maxConcurrency`           | number   | Yes      | Max concurrent requests                 |
| `limits.maxMemoryMB`              | number   | Yes      | Memory budget                           |
| `limits.maxDurationMinutes`       | number   | Yes      | Time budget                             |
| `compliance.respectRobotsTxt`     | boolean  | No       | Robots.txt compliance                   |
| `compliance.maxRequestsPerSecond` | number   | No       | Rate limit                              |
| `compliance.userAgent`            | string   | No       | Custom user agent                       |
| `createdBy`                       | string   | Yes      | Admin who created                       |

**Indexes:**

- `{ tenantId: 1, domainPattern: 1 }` **unique** — One policy per tenant + domain

---

### UserCrawlPreference

**Collection:** `user_crawl_preferences` | **Plugins:** tenantIsolationPlugin

Per-user crawl preferences. Learned from user choices (domain + strategy pairs) and replayed to auto-decide without prompting. Uses ObjectId `_id` (not UUIDv7).

| Field           | Type     | Required | Description                                   |
| --------------- | -------- | -------- | --------------------------------------------- |
| `_id`           | ObjectId | Yes      | Auto-generated                                |
| `userId`        | string   | Yes      | User who owns the preference                  |
| `tenantId`      | string   | Yes      | Tenant scope                                  |
| `domainPattern` | string   | Yes      | Exact or wildcard domain                      |
| `strategy`      | string   | Yes      | `browser` \| `bulk` \| `hybrid`               |
| `batchSize`     | number   | No       | Preferred batch size                          |
| `concurrency`   | number   | No       | Preferred concurrency                         |
| `autoDecide`    | boolean  | Yes      | Auto-apply without prompting (default: false) |
| `useCount`      | number   | Yes      | Times applied (default: 0)                    |
| `lastUsed`      | Date     | Yes      | Last time applied                             |

**Indexes:**

- `{ userId: 1, tenantId: 1, domainPattern: 1 }` **unique** — One preference per user + tenant + domain

---

### HandlerTemplate

**Collection:** `handler_templates` | **Plugins:** tenantIsolationPlugin

Reusable extraction handlers generated by the LLM intelligence loop. Template fingerprinting allows reuse across structurally similar pages, reducing LLM calls. Auto-expires 90 days after last use.

| Field                         | Type          | Required | Description                                                      |
| ----------------------------- | ------------- | -------- | ---------------------------------------------------------------- |
| `_id`                         | string (UUID) | Yes      | Unique template ID (UUIDv7)                                      |
| `tenantId`                    | string        | Yes      | Tenant scope                                                     |
| `domain`                      | string        | Yes      | Target domain                                                    |
| `urlPattern`                  | string        | Yes      | URL pattern this handler matches                                 |
| `fingerprint`                 | string        | Yes      | Structural fingerprint (hex, from TemplateFingerprinter)         |
| `handler.urlPattern`          | string        | Yes      | Handler's URL pattern                                            |
| `handler.description`         | string        | Yes      | Human-readable description                                       |
| `handler.steps`               | object[]      | Yes      | Playwright steps: `[{ action, selector?, value?, description }]` |
| `handler.extractionSelectors` | object        | Yes      | `{ title?, content, metadata? }` — CSS selectors for extraction  |
| `trainedOn`                   | string[]      | No       | URLs this handler was trained on                                 |
| `successCount`                | number        | No       | Reuse success count (default: 0)                                 |
| `failureCount`                | number        | No       | Reuse failure count (default: 0)                                 |
| `confidence`                  | number        | No       | Derived from success/failure ratio (0–1)                         |
| `lastUsedAt`                  | Date          | Yes      | Last usage timestamp                                             |

**Indexes:**

- `{ tenantId: 1, domain: 1, fingerprint: 1 }` **unique** — One template per fingerprint per domain per tenant
- `{ tenantId: 1, domain: 1 }` — Find templates by domain
- `{ lastUsedAt: 1 }` **TTL: 90 days** — Auto-delete unused templates

---

### DriveDeltaToken

**Collection:** `drive_delta_tokens` | **Plugins:** None

Stores Microsoft Graph delta sync tokens for SharePoint/OneDrive incremental sync. Uses ObjectId `_id` (not UUIDv7).

| Field                      | Type     | Required | Description                                   |
| -------------------------- | -------- | -------- | --------------------------------------------- |
| `_id`                      | ObjectId | Yes      | Auto-generated (not UUIDv7)                   |
| `tenantId`                 | string   | Yes      | Tenant scope                                  |
| `connectorId`              | string   | Yes      | Connector for this drive                      |
| `driveId`                  | string   | Yes      | Microsoft Graph drive ID                      |
| `deltaLink`                | string   | Yes      | Delta link URL for incremental sync           |
| `lastSyncAt`               | Date     | Yes      | Last successful sync                          |
| `itemsProcessedSinceToken` | number   | No       | Items processed since this token (default: 0) |

**Indexes:**

- `{ tenantId: 1, connectorId: 1, driveId: 1 }` **unique** — One token per drive
- `{ lastSyncAt: 1 }` — Find stale tokens
- `{ tenantId: 1, connectorId: 1 }` — All tokens for a connector

---

### SyncCheckpoint

**Collection:** `sync_checkpoints` | **Plugins:** tenantIsolationPlugin

Stores connector sync progress for pause/resume support. Tracks current position, processed count, and ETA.

| Field                         | Type          | Required | Description                      |
| ----------------------------- | ------------- | -------- | -------------------------------- |
| `_id`                         | string (UUID) | Yes      | Unique checkpoint ID             |
| `tenantId`                    | string        | Yes      | Tenant scope                     |
| `connectorId`                 | string        | Yes      | Connector being synced           |
| `syncType`                    | string        | Yes      | `full` \| `delta`                |
| `startedAt`                   | Date          | Yes      | Sync start time                  |
| `checkpointedAt`              | Date          | Yes      | Last checkpoint time             |
| `state.currentSiteUrl`        | string        | No       | Current site being processed     |
| `state.currentLibraryId`      | string        | No       | Current library being processed  |
| `state.nextLink`              | string        | No       | API pagination cursor            |
| `state.processedCount`        | number        | No       | Documents processed (default: 0) |
| `state.remainingCount`        | number        | No       | Estimated remaining documents    |
| `progress.percentage`         | number        | No       | Completion percentage (0–100)    |
| `progress.eta`                | Date          | No       | Estimated completion time        |
| `progress.documentsPerSecond` | number        | No       | Processing throughput            |

**Indexes:**

- `{ tenantId: 1, connectorId: 1, checkpointedAt: -1 }` — Latest checkpoint
- `{ connectorId: 1, syncType: 1, startedAt: -1 }` — Active syncs
- `{ checkpointedAt: 1 }` — Cleanup old checkpoints

---

## Vector Store Tracking Models

### IndexRegistry

**Collection:** `index_registry` | **Plugins:** None

Maps tenant + app + connector to vector store index names. Supports three strategies: shared (multiple apps → one index), per-app (one app → one index), per-connector (one connector → one index). Default entry uses `connectorId=null`; overrides use specific connectorId.

| Field         | Type           | Required | Description                                   |
| ------------- | -------------- | -------- | --------------------------------------------- |
| `tenantId`    | string         | Yes      | Tenant scope                                  |
| `appId`       | string         | Yes      | Application/index ID                          |
| `connectorId` | string \| null | No       | null = app default, set = connector override  |
| `indexName`   | string         | Yes      | Vector store index name (NOT unique — shared) |
| `strategy`    | string         | Yes      | `shared` \| `per-app` \| `per-connector`      |
| `status`      | string         | Yes      | `active` \| `migrating` \| `deleting`         |
| `vectorCount` | number         | No       | Vectors in this mapping (default: 0)          |
| `createdAt`   | Date           | Yes      | Auto-generated                                |
| `updatedAt`   | Date           | Yes      | Auto-generated                                |

**Indexes:**

- `{ tenantId: 1, appId: 1, connectorId: 1, status: 1 }` **unique** — One active entry per tenant+app+connector
- `{ tenantId: 1, appId: 1, status: 1 }` — Find all indices for an app
- `{ indexName: 1, status: 1 }` — Find all apps on a shared index

### SharedIndexTracker

**Collection:** `shared_index_tracker` | **Plugins:** None | **Timestamps:** false (custom fields)

Tracks shared vector store indices and capacity. Lifecycle: create v1 (active) → reaches 70% capacity → mark v1 as `full`, create v2 (active) → new apps use v2, old apps stay on v1 → eventually archive v1.

| Field             | Type   | Required | Description                                     |
| ----------------- | ------ | -------- | ----------------------------------------------- |
| `indexName`       | string | Yes      | **unique** — e.g., `search-vectors-v1`          |
| `version`         | number | Yes      | Index version (1, 2, 3...)                      |
| `status`          | string | Yes      | `active` \| `full` \| `migrating` \| `archived` |
| `vectorCount`     | number | No       | Current vector count (default: 0)               |
| `estimatedSizeGB` | number | No       | Estimated storage size in GB (default: 0)       |
| `capacityPercent` | number | No       | vectorCount / maxVectors (default: 0)           |
| `maxVectors`      | number | Yes      | Configured vector limit                         |
| `maxSizeGB`       | number | Yes      | Configured size limit in GB                     |
| `appCount`        | number | No       | Apps using this index (default: 0)              |
| `createdAt`       | Date   | No       | Custom field (not auto-generated, default: now) |
| `lastSyncedAt`    | Date   | No       | Last sync from vector store (default: now)      |

**Indexes:**

- `{ status: 1, version: -1 }` — Find active shared index for new assignments

---

## Mongoose Plugins

| Plugin                  | Applied To                                    | Behavior                                                                      |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `tenantIsolationPlugin` | All Search-AI models                          | Auto-injects `tenantId` filter via AsyncLocalStorage in `withTenantContext()` |
| `encryptionPlugin`      | LLMCredential, TenantModel, EndUserOAuthToken | AES-256-GCM field-level encryption. Requires `setMasterKey()` at startup      |
| `auditTrailPlugin`      | LLMCredential                                 | Records write operations to `audit_logs` collection                           |

**Critical rules:**

- Never use `.lean()` on LLMCredential or EndUserOAuthToken — bypasses decryption hooks
- Always call `setMasterKey(ENCRYPTION_MASTER_KEY)` at server startup
- Use `withTenantContext({ tenantId }, ...)` for all Search-AI database operations
- Use `withSuperAdminContext()` only for admin operations bypassing tenant filter

---

## Naming Conventions

| Convention      | Pattern                         | Example                  |
| --------------- | ------------------------------- | ------------------------ |
| Model file      | `kebab-case.model.ts`           | `search-chunk.model.ts`  |
| Collection name | `snake_case`                    | `search_chunks`          |
| MongoDB IDs     | UUIDv7 (default for all models) | `01935abc-...`           |
| Timestamps      | Auto via `{ timestamps: true }` | `createdAt`, `updatedAt` |
| Schema version  | `_v` field                      | `_v: 1`                  |

---

## Key Files

| File                                        | Purpose                           |
| ------------------------------------------- | --------------------------------- |
| `packages/database/src/models/`             | All model definitions (134 files) |
| `packages/database/src/model-registry.ts`   | Dual-DB binding and affinity      |
| `packages/database/src/mongo/connection.ts` | Connection management             |
| `packages/database/src/mongo/plugins/`      | Mongoose plugins                  |
| `apps/search-ai/src/db/index.ts`            | SearchAI model binding            |
| `apps/search-ai-runtime/src/db/index.ts`    | SearchAI Runtime model binding    |

---

**Last Updated:** 2026-03-11
**Source of Truth:** TypeScript interfaces in `packages/database/src/models/`
