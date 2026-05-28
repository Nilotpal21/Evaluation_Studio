# RFC: Future SearchAI Architecture

> ⚠️ **THIS IS A FUTURE DESIGN PROPOSAL - NOT CURRENT IMPLEMENTATION**
>
> This document describes a proposed future architecture for SearchAI, not the current system.
> For current architecture, see `docs/searchai/design/SEARCHAI-ARCHITECTURE.md` (if exists) or `docs/searchai/INGESTION-PIPELINE-ARCHITECTURE.md`.

> Enterprise Knowledge Base & RAG Platform integrated with the Agent Platform
> Programmable, AI-configurable, incrementally testable, extensible with custom code

**Status:** Design / RFC (Future Proposal)
**Authors:** Architecture Team
**Last Updated:** 2025-02-12
**Original Location:** `docs/SEARCH_AI_ARCHITECTURE.md`

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Entity Model & Relationships](#3-entity-model--relationships)
4. [Universal Stage Interface](#4-universal-stage-interface)
5. [SearchAI Internals](#5-searchai-internals)
6. [Custom Stage Runtime](#6-custom-stage-runtime)
7. [Custom Connector SDK](#7-custom-connector-sdk)
8. [MCP Tool Surface](#8-mcp-tool-surface)
9. [Incremental Testing Model](#9-incremental-testing-model)
10. [AI-Driven Development Workflows](#10-ai-driven-development-workflows)
11. [Retrieval Tuning & Evaluation](#11-retrieval-tuning--evaluation)
12. [Integration Contract (search-ai-sdk)](#12-integration-contract-search-ai-sdk)
13. [Agent DSL Integration](#13-agent-dsl-integration)
14. [Multi-KB Usage Patterns](#14-multi-kb-usage-patterns)
15. [Hot Configuration & Live Reload](#15-hot-configuration--live-reload)
16. [Security & Sandboxing](#16-security--sandboxing)
17. [Codebase Structure](#17-codebase-structure)
18. [Release Lifecycle](#18-release-lifecycle)
19. [UX & Navigation](#19-ux--navigation)
20. [Data Model (Prisma Schema)](#20-data-model-prisma-schema)
21. [Phased Delivery Plan](#21-phased-delivery-plan)

---

## 1. Overview

Search AI is a **programmable knowledge management and retrieval platform** that provides enterprise-grade RAG (Retrieval-Augmented Generation) capabilities to the Agent Platform. It operates as a separate product surface within the same platform, sharing authentication, tenancy, billing, and observability infrastructure while maintaining independent development and release cycles.

### Core Principles

**Two Products, One Platform.** Search AI and the Agent Platform are independent product surfaces connected by a thin, versioned contract (`@agent-platform/search-ai-sdk`). They share enterprise infrastructure but have separate development teams, release trains, and internal architectures.

**Everything is a stage.** Connectors, extractors, enrichers, retrievers — they all implement the same `StageHandler` interface. Built-in and custom stages are interchangeable. A pipeline is just an ordered list of stage references.

**Everything is testable in isolation.** Every stage can be invoked standalone with sample input and inspected output. No need to run a full pipeline to verify a custom extractor. No need to index 10,000 documents to test a retrieval config change.

**Everything is configurable via tools.** The MCP tool surface is the primary configuration interface — not just for AI agents like Claude Code, but for any programmatic client. The Studio UI is built on the same tools. Claude Code can do anything the UI can do, and more (write custom stages, run A/B experiments, automate tuning loops).

### Key Capabilities

- **Connectors** — Plug-in adapters for content sources (web crawlers, CMS, CRM, file storage), including custom connectors written on the fly
- **Extraction Pipelines** — Parse, chunk, and extract metadata from raw content (including LLM-powered stages)
- **Enrichment Pipelines** — Entity resolution, relationship extraction, classification, embedding generation
- **Multi-Format Indexing** — Vector (pgvector/Qdrant), graph (Neo4j/Postgres), full-text (BM25/Typesense)
- **Retrieval Pipelines** — Query understanding, multi-index fan-out, reranking, citation tracking
- **Agent Integration** — Agents declare knowledge bases in DSL and search them during execution
- **AI-Assisted Configuration** — MCP tools let Claude Code configure, test, tune, and extend everything
- **Custom Stages** — Upload TypeScript code that becomes a live pipeline stage, sandboxed and versioned
- **Incremental Testing** — Test any individual stage, pipeline, or query without full deployment
- **Retrieval Tuning** — Eval sets, A/B config comparison, quality metrics, AI-powered improvement suggestions

---

## 2. System Architecture

```
+---------------------------------------------------------------------+
|                        STUDIO (Next.js Shell)                        |
|  +------------------------+        +------------------------------+  |
|  |   Agent Studio          |        |   Search AI Studio            |  |
|  |   /agents/*             |        |   /search/*                   |  |
|  |   /deployments/*        |        |   /search/connectors          |  |
|  |   /observatory/*        |        |   /search/pipelines           |  |
|  |                         |<------>|   /search/knowledge-bases     |  |
|  |  "Link KB" picker       |  KB    |   /search/indexes             |  |
|  |  in Agent editor        | browse |   /search/retrieval           |  |
|  +------------+------------+        +--------------+----------------+  |
|               |                                    |                   |
|  Shared: Auth, Tenant Switcher, Nav, Settings, Billing                |
+---------------+------------------------------------+-------------------+
                |                                    |
                v                                    v
+------------------------+          +-----------------------------------+
|   Agent Runtime         |          |   SearchAI                        |
|   (Express, port 3002)  |<-------->|   (Express/Fastify, port 3003)    |
|                         | search-  |                                   |
|   - Sessions            | ai-sdk   |   - Stage Registry (built-in +    |
|   - Execution           | (REST)   |     custom, hot-reloadable)       |
|   - Deployments         |          |   - Pipeline Executor             |
|   - Versions            |          |   - Index Manager                 |
|                         |          |   - MCP Server (tool surface)     |
+-----------+-------------+          +----------------+------------------+
            |                                         |
            v                                         v
+-------------------------------------------------------------------+
|                    Shared Infrastructure                            |
|   Prisma (shared schema)  |  Redis   |  Object Storage (S3/MinIO)  |
|   JWT Auth + RBAC         |  BullMQ  |  Vector DB (pgvector)       |
|   Tenant Isolation        |  Cache   |  Graph DB (optional)        |
+-------------------------------------------------------------------+
```

### Service Boundaries

| Service           | Port | Responsibility                                                                |
| ----------------- | ---- | ----------------------------------------------------------------------------- |
| **Studio**        | 3000 | Unified UI shell — agent development + search AI configuration                |
| **Agent Runtime** | 3002 | Agent execution, sessions, deployments, versions                              |
| **SearchAI**      | 3003 | Content ingestion, indexing, retrieval, MCP tool server, custom stage runtime |

### Configuration Interfaces

| Interface          | User                                       | How                                                     |
| ------------------ | ------------------------------------------ | ------------------------------------------------------- |
| **Studio UI**      | Search AI admins, agent developers         | Browser-based, visual pipeline editor, KB management    |
| **MCP Tools**      | Claude Code, AI agents, automation scripts | Programmatic, fine-grained, supports testing and tuning |
| **Admin REST API** | Custom integrations, CI/CD pipelines       | Standard REST, same endpoints Studio calls              |

The Agent Runtime communicates with SearchAI exclusively via the Search API (REST). MCP tools connect to SearchAI directly via stdio or HTTP transport.

---

## 3. Entity Model & Relationships

### Core Entities

```
SearchProject
|
+-- Connector (how to fetch)
|   "Confluence - Product Space"
|   "Salesforce - Knowledge Articles"
|   "Website - docs.acme.com"
|   "Acme Wiki - Custom Connector"       <- custom stage-based connector
|
+-- KnowledgeBase (what to search against)
|   "Product Docs"
|   "Customer Support KB"
|
+-- ConnectorBinding (routes connector -> KB, with filters)
|   "Confluence/Product Space"  -->  "Product Docs"
|   "Confluence/Product Space"  -->  "Customer Support KB"  (filtered: tag=support)
|   "Salesforce/Knowledge"      -->  "Customer Support KB"
|   "Website/docs.acme.com"     -->  "Product Docs"
|
+-- CustomStage (user-authored pipeline components)
    "product-entity-extractor"  (enrichment stage)
    "acme-wiki-connector"       (connector stage)
    "policy-reranker"           (retrieval stage)
```

### Conceptual Separation

| Entity               | Role                                        | Analogy                      |
| -------------------- | ------------------------------------------- | ---------------------------- |
| **Connector**        | "Where do I fetch content from?"            | A database connection string |
| **KnowledgeBase**    | "What can agents search against?"           | A database table             |
| **ConnectorBinding** | "Which content from source X goes to KB Y?" | An ETL mapping               |
| **Document**         | "One tracked item from a source"            | A row in the source table    |
| **Chunk**            | "One searchable unit"                       | A search index entry         |
| **CustomStage**      | "User-defined pipeline component"           | A stored procedure           |

**Connector** knows nothing about indexing. **KnowledgeBase** knows nothing about where content came from. **ConnectorBinding** is the glue — a many-to-many join with config.

### Relationship Diagram

```
+---------------+         +--------------------+         +-------------------+
|  Connector     |-------->| ConnectorBinding   |<--------|  KnowledgeBase    |
|               |   1:N   |                    |   N:1   |                   |
| type          |         | filters (JSON)     |         | name, slug        |
| config        |         | extractionRules    |         | chunkStrategy     |
| schedule      |         | enabled            |         | embeddingModel    |
| credentials   |         | lastSyncCursor     |         | indexConfig       |
| customStageId?|         +--------------------+         +-------------------+
+---------------+                 |
                                  | sync produces
                                  v
                           +--------------+
                           |  Document     |
                           |              |
                           | connectorId  |  <- provenance (where it came from)
                           | knowledgeBaseId| <- destination (where it's indexed)
                           | sourceUrl     |
                           | contentHash   |  <- dedup / change detection
                           | status        |
                           +------+-------+
                                  | 1:N
                                  v
                           +--------------+
                           |  Chunk        |
                           |              |
                           | documentId   |
                           | content      |
                           | embedding    |  <- vector (from KB's embedding model)
                           | metadata     |
                           | position     |
                           +--------------+
```

### Why ConnectorBinding Exists (Many-to-Many with Config)

**Same connector, multiple KBs:**
A Confluence connector pulls from the entire "Engineering" space, but content is routed to different KBs based on filters:

```json
// Binding 1: Confluence -> Product Docs
{ "filters": { "labels": ["product", "feature"], "spaces": ["ENG"] } }

// Binding 2: Confluence -> Ops Runbooks
{ "filters": { "labels": ["runbook", "incident"], "spaces": ["ENG"] } }
```

**Same KB, multiple connectors:**
A "Customer Support KB" aggregates content from three sources:

- Confluence (product docs for context)
- Salesforce (resolved case summaries)
- A static FAQ website

The agent searches one KB — it doesn't care which source the answer came from.

### Agent Platform Link Table

```
Agent Platform                              Search AI
---------------                             ---------
Project "Travel Bot"                        SearchProject "Acme Knowledge"
  |                                           +-- KB: "product-docs"
  +-- ProjectKnowledgeBase ------------------>+-- KB: "policy-docs"
  |     alias: "products"                     +-- KB: "faq-collection"
  |     knowledgeBaseId: kb_product_docs
  |
  +-- ProjectKnowledgeBase ------------------>
  |     alias: "policies"
  |     knowledgeBaseId: kb_policy_docs
  |
  +-- ProjectKnowledgeBase ------------------>
        alias: "faqs"
        knowledgeBaseId: kb_faq_collection
```

`ProjectKnowledgeBase` gives each KB a local **alias** that the agent DSL uses. Agent developers work with aliases like `products` — never raw KB IDs.

---

## 4. Universal Stage Interface

Every pipeline component — built-in and custom — implements the same interface. This is the foundation that makes everything composable, testable, and hot-swappable.

```typescript
// packages/search-ai-sdk/src/stages.ts

export interface StageHandler<TInput = unknown, TOutput = unknown> {
  /** Unique stage identifier */
  readonly name: string;

  /** Semver version for tracking changes */
  readonly version: string;

  /** Stage category for pipeline validation */
  readonly type: 'connector' | 'extraction' | 'enrichment' | 'retrieval' | 'indexing';

  /** JSON Schema for this stage's configuration */
  readonly configSchema?: Record<string, unknown>;

  /**
   * Execute the stage.
   * @param input   - Output from the previous stage (or initial input for first stage)
   * @param context - Tenant, KB, pipeline metadata, LLM client access
   */
  execute(input: TInput, context: StageContext): Promise<TOutput>;

  /**
   * Validate configuration before pipeline is saved.
   * Called at design-time, not execution-time.
   */
  validate?(config: unknown): ValidationResult;
}

export interface StageContext {
  tenantId: string;
  knowledgeBaseId?: string;
  pipelineId: string;
  stageIndex: number;
  config: Record<string, unknown>;

  /** Platform services — stages don't import these directly */
  services: {
    llm: LLMClient; // Call LLM APIs (for LLM-powered stages)
    storage: ObjectStorage; // Read/write large blobs
    cache: CacheClient; // Stage-level caching
    logger: Logger;
    metrics: MetricsRecorder;
  };

  signal: AbortSignal;
}

export interface StageTestResult<TOutput = unknown> {
  output: TOutput;
  metrics: StageMetrics;
  warnings?: string[];
  logs?: string[]; // Captured console output from custom stages
}

export interface StageMetrics {
  durationMs: number;
  inputCount: number;
  outputCount: number;
  tokensUsed?: number; // For LLM stages
  custom?: Record<string, number>;
}
```

### Typed Stage Variants

```typescript
/** Connector: no input, produces raw documents */
export type ConnectorHandler = StageHandler<ConnectorSyncInput, RawDocument[]>;

/** Extraction: raw document -> chunks */
export type ExtractionHandler = StageHandler<RawDocument, Chunk[]>;

/** Enrichment: chunks -> enriched chunks */
export type EnrichmentHandler = StageHandler<Chunk[], Chunk[]>;

/** Retrieval: search query -> scored results */
export type RetrievalHandler = StageHandler<RetrievalQuery, ScoredResult[]>;

/** Reranker: scored results -> re-scored results */
export type RerankerHandler = StageHandler<ScoredResult[], ScoredResult[]>;
```

### Built-in Stages

| Stage                    | Type       | Description                                   |
| ------------------------ | ---------- | --------------------------------------------- |
| `web-crawler`            | connector  | Headless browser, sitemap, robots.txt         |
| `confluence-connector`   | connector  | Confluence REST API with space/label filters  |
| `salesforce-connector`   | connector  | Bulk API + Streaming API                      |
| `servicenow-connector`   | connector  | Table API + attachment download               |
| `s3-connector`           | connector  | Bucket scan, event notifications              |
| `document-parser`        | extraction | PDF/HTML/DOCX/Markdown to plain text          |
| `fixed-chunker`          | extraction | Fixed-size chunks with overlap                |
| `semantic-chunker`       | extraction | Sentence-boundary-aware chunking              |
| `hierarchical-chunker`   | extraction | Heading-aware hierarchical chunks             |
| `metadata-extractor`     | extraction | Dates, authors, categories from source        |
| `llm-summarizer`         | enrichment | Generate chunk summaries via LLM              |
| `llm-question-generator` | enrichment | Generate hypothetical questions per chunk     |
| `entity-resolver`        | enrichment | Dedup entities across documents               |
| `embedding-generator`    | enrichment | Generate vector embeddings                    |
| `classifier`             | enrichment | Auto-tag by topic/domain                      |
| `vector-search`          | retrieval  | Cosine similarity against embeddings          |
| `fulltext-search`        | retrieval  | BM25 scoring                                  |
| `graph-traversal`        | retrieval  | Entity-relationship graph walk                |
| `rrf-merger`             | retrieval  | Reciprocal rank fusion of multiple retrievers |
| `cross-encoder-reranker` | retrieval  | Cross-encoder model reranking                 |
| `llm-reranker`           | retrieval  | LLM-based relevance scoring                   |
| `context-assembler`      | retrieval  | Dedup, order, truncate to token budget        |

All built-in stages implement the same `StageHandler` interface. Custom stages are indistinguishable from built-in ones at the pipeline level.

---

## 5. SearchAI Internals

```
SearchAI Service
|
+-- Stage Registry
|   +-- Built-in stages (ship with platform)
|   +-- Custom stages (user-uploaded, per-tenant, hot-reloadable)
|   +-- Version tracking (each stage has semver, rollback support)
|
+-- Connectors Layer (all implement StageHandler)
|   +-- WebCrawler          (headless browser, sitemap, robots.txt)
|   +-- ConfluenceConnector (REST API, webhook for updates)
|   +-- SalesforceConnector (Bulk API + Streaming API)
|   +-- ServiceNowConnector (Table API + attachment download)
|   +-- S3Connector         (bucket scan, event notifications)
|   +-- Custom connectors   (user-authored via search_register_stage)
|
+-- Extraction Pipeline (BullMQ job queue)
|   +-- DocumentParser      (PDF->text, HTML->markdown, DOCX->text)
|   +-- ChunkingStrategy    (fixed, semantic, hierarchical, sliding window)
|   +-- LLMExtractor        (entity extraction, summarization, Q&A gen)
|   +-- MetadataExtractor   (dates, authors, categories from source)
|   +-- Custom extractors   (user-authored)
|
+-- Enrichment Pipeline (BullMQ, runs after extraction)
|   +-- EntityResolver      (dedup entities across documents)
|   +-- RelationshipBuilder (for graph index — doc<->entity edges)
|   +-- Classifier          (auto-tag by topic/domain)
|   +-- LLMEnricher         (generate hypothetical questions per chunk)
|   +-- Custom enrichers    (user-authored)
|
+-- Index Manager
|   +-- VectorIndex         (pgvector or Qdrant — embeddings)
|   +-- GraphIndex          (entity-relationship graph — Neo4j or in-Postgres)
|   +-- FullTextIndex       (BM25 — Postgres tsvector or Typesense)
|   +-- HybridOrchestrator  (fan-out to multiple indexes, merge results)
|
+-- Retrieval Pipeline
|   +-- QueryUnderstanding  (NLU rewrite, expansion, decomposition)
|   +-- MultiIndexRetriever (parallel fan-out to configured indexes)
|   +-- Reranker            (cross-encoder or LLM-based reranking)
|   +-- ContextAssembler    (dedup, order, truncate to token budget)
|   +-- CitationTracker     (source attribution back to original doc)
|   +-- Custom retrievers   (user-authored)
|
+-- Pipeline Executor
|   +-- Runs stages in sequence, passing output to next input
|   +-- Test mode: captures per-stage output for inspection
|   +-- Metrics: timing, token usage, counts per stage
|
+-- MCP Server
|   +-- 40+ tools for programmatic configuration
|   +-- Claude Code connects via stdio or HTTP
|   +-- Same tools power the Studio UI proxy routes
|
+-- API Layer
    +-- Admin API           (CRUD connectors, pipelines, KBs — Studio calls this)
    +-- Search API          (query endpoint — Agent Runtime calls this)
    +-- Ingest Webhook API  (connectors push content updates)
```

### Document Lifecycle

```
          Connector Sync                    ConnectorBinding
          (scheduled/manual)                (filters + routes)
               |                                  |
               v                                  v
+------------------------+  filter  +----------------------------+
| Raw content fetched     |-------->| Document created in KB      |
| from source             |  match  | status: 'pending'           |
| (Confluence page,       |         | connectorId: source ref     |
|  SF article, webpage)   |         | knowledgeBaseId: target     |
+------------------------+         +-------------+--------------+
                                                  |
                                        Extraction Pipeline
                                        (per-KB config, stages from registry)
                                                  |
                                                  v
                                   +--------------------------+
                                   | Chunks created            |
                                   | - parsed, split           |
                                   | - metadata extracted      |
                                   | status: 'extracted'       |
                                   +-------------+------------+
                                                 |
                                       Enrichment Pipeline
                                       (optional, may include custom stages)
                                                 |
                                                 v
                                   +--------------------------+
                                   | Chunks enriched           |
                                   | - entities resolved       |
                                   | - embeddings generated    |
                                   | - relationships built     |
                                   | status: 'indexed'         |
                                   +--------------------------+
```

**Change detection on re-sync:** Connector fetches content, computes `contentHash`. If hash matches existing document, skip. If changed, re-extract and re-index only that document's chunks. Unchanged documents are untouched.

---

## 6. Custom Stage Runtime

Custom stages are user-authored TypeScript modules that implement `StageHandler`. They are stored in the database, loaded dynamically, and executed in a sandboxed environment.

### How Custom Stages Work

```
Developer writes TypeScript     SearchAI loads and runs it
(or Claude Code generates it)
           |                                |
           v                                v
+----------------------+      +---------------------------+
| export default {     |      | Stage Registry            |
|   name: 'my-stage',  | ---> | stores code + metadata    |
|   version: '1.0.0',  |      | in DB per tenant          |
|   type: 'enrichment',|      +---------------------------+
|   execute(input, ctx) |                |
|     { ... }           |                v
| }                     |      +---------------------------+
+----------------------+      | Worker Thread / Isolate    |
                               | - loads stage code         |
                               | - runs execute()           |
                               | - captures output + logs   |
                               | - enforces time/mem limits |
                               +---------------------------+
```

### Stage Registration (via MCP tool)

```typescript
// What Claude Code sends via search_register_stage
{
  "name": "product-entity-extractor",
  "version": "1.0.0",
  "type": "enrichment",
  "description": "Extracts product names and categories from chunks using LLM",
  "configSchema": {
    "type": "object",
    "properties": {
      "productCategories": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Known product categories to look for"
      },
      "model": {
        "type": "string",
        "default": "claude-haiku-4-5-20251001"
      }
    }
  },
  "code": "... TypeScript source code ..."
}
```

### Custom Enrichment Stage Example

```typescript
import type { StageHandler, Chunk, StageContext } from '@agent-platform/search-ai-sdk';

const handler: StageHandler<Chunk[], Chunk[]> = {
  name: 'product-entity-extractor',
  version: '1.0.0',
  type: 'enrichment',

  async execute(chunks: Chunk[], ctx: StageContext): Promise<Chunk[]> {
    const categories = (ctx.config.productCategories as string[]) || [];

    return Promise.all(
      chunks.map(async (chunk) => {
        // Use LLM client provided by context — no direct API imports needed
        const result = await ctx.services.llm.generate({
          model: (ctx.config.model as string) || 'claude-haiku-4-5-20251001',
          messages: [
            {
              role: 'user',
              content: `Extract product names and categories from this text.
Categories: ${categories.join(', ')}

Text: ${chunk.content}

Return JSON: { "products": [{ "name": "...", "category": "..." }] }`,
            },
          ],
          maxTokens: 200,
        });

        const entities = JSON.parse(result.content);
        return {
          ...chunk,
          metadata: { ...chunk.metadata, products: entities.products },
        };
      }),
    );
  },

  validate(config) {
    if (config.productCategories && !Array.isArray(config.productCategories)) {
      return { valid: false, errors: ['productCategories must be an array'] };
    }
    return { valid: true };
  },
};

export default handler;
```

### Versioning and Rollback

Every custom stage has a version. When you update a stage:

- The old version remains available (pipelines can pin to a version)
- The new version becomes the default for new pipeline runs
- If the new version fails, the pipeline falls back to the previous version
- Explicit rollback: `search_update_stage({ stageId: '...', rollbackToVersion: '1.0.0' })`

---

## 7. Custom Connector SDK

Connectors have additional lifecycle hooks beyond the basic `StageHandler` — incremental sync, webhook handling, and credential management.

```typescript
// packages/search-ai-sdk/src/connector-sdk.ts

export interface ConnectorDefinition extends StageHandler<ConnectorSyncInput, RawDocument[]> {
  capabilities: {
    incrementalSync: boolean; // Supports cursor-based incremental sync
    webhooks: boolean; // Can receive push updates
    preview: boolean; // Can list content without fetching bodies
    authentication: AuthType[]; // Supported auth methods
  };

  /** Incremental sync: return only documents changed since the cursor */
  incrementalSync?(
    cursor: string | null,
    context: StageContext,
  ): Promise<{ documents: RawDocument[]; nextCursor: string; hasMore: boolean }>;

  /** Handle webhook payloads from the content source */
  handleWebhook?(
    payload: unknown,
    headers: Record<string, string>,
    context: StageContext,
  ): Promise<{ documentsUpdated: string[]; documentsDeleted: string[] }>;

  /** Test connectivity and credentials */
  testConnection?(context: StageContext): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }>;

  /** List available content scopes (spaces, objects, buckets) for the UI */
  listScopes?(context: StageContext): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      itemCount?: number;
    }>
  >;
}

export type AuthType = 'api_key' | 'oauth2' | 'basic' | 'token' | 'service_account';
```

### Custom Connector Example

```typescript
import type {
  StageHandler,
  ConnectorSyncInput,
  RawDocument,
  StageContext,
} from '@agent-platform/search-ai-sdk';

const handler: StageHandler<ConnectorSyncInput, RawDocument[]> = {
  name: 'acme-wiki-connector',
  version: '1.0.0',
  type: 'connector',

  async execute(input: ConnectorSyncInput, ctx: StageContext): Promise<RawDocument[]> {
    const { apiUrl, apiToken, contentTypes } = ctx.config as any;

    const response = await fetch(`${apiUrl}/api/v2/pages`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const items = await response.json();

    const filtered = contentTypes
      ? items.filter((item: any) => contentTypes.includes(item.type))
      : items;
    const limited = input.limit ? filtered.slice(0, input.limit) : filtered;

    return limited.map((item: any) => ({
      sourceUrl: `${apiUrl}/pages/${item.id}`,
      title: item.title,
      content: item.body,
      metadata: { author: item.author, updatedAt: item.updatedAt, tags: item.tags },
    }));
  },
};

export default handler;
```

---

## 8. MCP Tool Surface

The MCP tool surface is how Claude Code (and any programmatic client) operates Search AI. This extends the existing `kore-platform-cli mcp` pattern.

### Claude Code Connection

```json
// .claude/mcp_servers.json
{
  "search-ai": {
    "command": "npx",
    "args": ["@agent-platform/search-ai", "mcp"],
    "env": { "SEARCH_AI_URL": "http://localhost:3003" }
  }
}
```

### Tool Categories

#### Discovery & Navigation

| Tool                      | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `search_list_projects`    | List Search AI projects for current tenant            |
| `search_get_project`      | Get project details, stats, health                    |
| `search_list_kbs`         | List knowledge bases with document/chunk counts       |
| `search_get_kb_stats`     | Detailed KB stats: index health, sync status, storage |
| `search_list_stages`      | List all stages: built-in + custom, with type/version |
| `search_get_stage_schema` | Get a stage's config JSON Schema                      |

#### Connector Management

| Tool                      | Description                                      |
| ------------------------- | ------------------------------------------------ |
| `search_create_connector` | Create connector with type + config              |
| `search_update_connector` | Update config, credentials, schedule, filters    |
| `search_test_connector`   | Dry run: fetch N sample documents (no indexing)  |
| `search_test_connection`  | Test credentials/connectivity only               |
| `search_list_scopes`      | List available scopes (spaces, objects, buckets) |
| `search_sync_connector`   | Trigger full or incremental sync                 |
| `search_get_sync_status`  | Check ongoing sync progress                      |

#### Knowledge Base Management

| Tool                     | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `search_create_kb`       | Create KB with index config, chunking, embedding model |
| `search_update_kb`       | Update settings (chunk size, overlap, model, etc.)     |
| `search_create_binding`  | Link connector to KB with optional filters             |
| `search_update_binding`  | Update binding filters or extraction rules             |
| `search_reindex_kb`      | Trigger full re-index (after config changes)           |
| `search_get_index_stats` | Vector count, graph node count, index size             |

#### Pipeline Management

| Tool                     | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `search_create_pipeline` | Create pipeline with ordered stage list            |
| `search_update_pipeline` | Update stages (add, remove, reorder, configure)    |
| `search_get_pipeline`    | Get pipeline definition with all stage configs     |
| `search_test_pipeline`   | Run pipeline on sample input with per-stage output |
| `search_deploy_pipeline` | Activate pipeline for production use               |

#### Custom Stages

| Tool                        | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `search_register_stage`     | Upload custom stage code (TypeScript)                  |
| `search_update_stage`       | Update code (new version), with optional rollback      |
| `search_test_stage`         | Run stage on sample input, get output + metrics + logs |
| `search_get_stage_logs`     | Get execution logs for recent invocations              |
| `search_list_custom_stages` | List custom stages for this project with versions      |

#### Search & Retrieval

| Tool                    | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `search_query`          | Run a search query against a KB                           |
| `search_query_debug`    | Search with full debug: per-stage scores, explain, timing |
| `search_test_retrieval` | Run retrieval pipeline with metrics breakdown             |

#### Tuning & Evaluation

| Tool                          | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `search_tune_retrieval`       | Adjust weights, thresholds, rerank params          |
| `search_create_eval_set`      | Create a set of query + expected result pairs      |
| `search_run_eval`             | Run eval set, compute MRR/NDCG/recall/precision    |
| `search_compare_configs`      | A/B compare two retrieval configs on same eval set |
| `search_get_metrics`          | Retrieval quality metrics over time                |
| `search_suggest_improvements` | AI analysis of quality gaps with recommendations   |

#### Indexing

| Tool                     | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `search_index_document`  | Index a single document (for testing)           |
| `search_index_batch`     | Index a batch of documents                      |
| `search_delete_document` | Remove a document and its chunks from the index |

---

## 9. Incremental Testing Model

Every component is testable in isolation. Testing does NOT require running full pipelines or indexing all content. This is the key enabler for AI-assisted iterative development.

### Test Scope Matrix

```
Test Scope          MCP Tool                 What It Does
-----------         --------                 ------------
Single stage        search_test_stage        Run one stage on sample input
Connector fetch     search_test_connector    Fetch N docs without indexing
Full extraction     search_test_pipeline     Run extraction pipeline on 1 document
Full enrichment     search_test_pipeline     Run enrichment pipeline on sample chunks
Single query        search_query_debug       Run query with score breakdown
Retrieval pipeline  search_test_retrieval    Full retrieval with per-stage metrics
End-to-end          search_index_document    Index 1 doc, then query for it
                    + search_query_debug
A/B comparison      search_compare_configs   Same query, two configs, side-by-side
Eval set            search_run_eval          Run N queries, compute MRR/NDCG/recall
```

### Pipeline Test Mode

When testing a pipeline, each stage's output is captured and returned:

```json
// search_test_pipeline response
{
  "stages": [
    {
      "name": "document-parser",
      "durationMs": 45,
      "inputCount": 1,
      "outputCount": 1,
      "output": { "text": "...", "metadata": {} }
    },
    {
      "name": "semantic-chunker",
      "durationMs": 12,
      "inputCount": 1,
      "outputCount": 7,
      "output": [
        { "content": "...", "position": 0, "tokenCount": 128 },
        { "content": "...", "position": 1, "tokenCount": 156 }
      ]
    },
    {
      "name": "product-entity-extractor",
      "durationMs": 1200,
      "tokensUsed": 450,
      "inputCount": 7,
      "outputCount": 7,
      "output": [{ "content": "...", "entities": ["AirPods Pro", "iPhone 15"] }]
    }
  ],
  "totalDurationMs": 1257,
  "totalTokensUsed": 450
}
```

Claude Code can inspect every intermediate output and decide what to adjust.

### The Development Loop

```
Traditional:  Config -> Deploy -> Wait -> Test -> Repeat (minutes)
AI-assisted:  MCP Tool -> Execute -> See Result -> Adjust -> Repeat (seconds)
```

---

## 10. AI-Driven Development Workflows

### Workflow 1: Setting Up a New Knowledge Base

```
Claude Code:

1. search_create_connector({ type: 'confluence', name: '...', config: { ... } })
2. search_test_connector({ connectorId: 'conn_123', limit: 3 })
   <- 3 sample documents returned, inspect format
3. search_create_kb({ name: 'Product Docs', chunkStrategy: 'semantic', ... })
4. search_create_binding({ connectorId: 'conn_123', knowledgeBaseId: 'kb_456', filters: { ... } })
5. search_test_pipeline({ pipelineType: 'extraction', sampleDocuments: [docs[0]] })
   <- 8 chunks produced, inspect quality
6. search_sync_connector({ connectorId: 'conn_123' })
7. search_query_debug({ knowledgeBaseId: 'kb_456', query: 'how to reset password' })
   <- results with scores, verify relevance
```

### Workflow 2: Writing a Custom Enrichment Stage

```
Claude Code:

1. search_get_kb_stats({ ... })           -- understand current data shape
2. search_query({ ..., topK: 5 })         -- get sample chunks
3. search_register_stage({                 -- write the stage
     name: 'product-entity-extractor',
     type: 'enrichment',
     code: '...'
   })
4. search_test_stage({ stageId: '...', input: sampleChunks })
   <- inspect enriched output
5. search_update_stage({ ..., version: '1.0.1', code: '... improved ...' })
   <- iterate on the code
6. search_test_stage({ ... })              -- re-test
7. search_update_pipeline({ stages: [..., 'product-entity-extractor'] })
8. search_reindex_kb({ ... })              -- apply to all content
```

### Workflow 3: Tuning Retrieval Quality

```
Claude Code:

1. search_query_debug({ query: 'refund policy intl flights', strategy: 'hybrid' })
   <- results with scores: vector 0.82, fulltext 0.45, no reranker
2. search_get_pipeline({ type: 'retrieval' })
   <- no reranker stage, that's the problem
3. search_update_pipeline({
     stages: [..., 'cross-encoder-reranker', 'context-assembler']
   })
4. search_query_debug({ ... same query ... })
   <- correct result now #1, rerank score 0.94
5. search_run_eval({ evalSet: 'policy-eval-v1' })
   <- MRR: 0.78 -> 0.91, NDCG@5: 0.72 -> 0.88
6. search_compare_configs({
     configA: { rrfWeights: { vector: 0.6, fulltext: 0.4 } },
     configB: { rrfWeights: { vector: 0.8, fulltext: 0.2 } }
   })
   <- Config A: MRR 0.91 | Config B: MRR 0.89 — keep current
7. search_deploy_pipeline({ ... })
```

### Workflow 4: Building a Custom Connector On the Fly

```
Claude Code:

1. Explore the target API (via web fetch)
   <- understand the content structure
2. search_register_stage({
     name: 'acme-wiki-connector', type: 'connector', code: '...'
   })
3. search_test_stage({ stageId: '...', input: { limit: 3 } })
   <- 3 documents returned, verify format
4. search_create_connector({ type: 'custom', customStageId: '...', config: { ... } })
5. search_create_binding({ connectorId: '...', knowledgeBaseId: '...' })
6. search_sync_connector({ connectorId: '...' })
   <- content indexed, ready to search
```

---

## 11. Retrieval Tuning & Evaluation

### Evaluation Framework

For systematic retrieval quality improvement, the platform supports evaluation sets — pairs of queries with known relevant results.

```typescript
interface EvalSet {
  id: string;
  name: string;
  queries: Array<{
    query: string;
    expectedChunkIds?: string[];
    expectedDocumentUrls?: string[];
    relevanceGrade?: number; // 0-3 grading
  }>;
}

interface EvalResult {
  mrr: number; // Mean Reciprocal Rank
  ndcg5: number; // Normalized Discounted Cumulative Gain @5
  recall10: number; // Recall @10
  precision5: number; // Precision @5
  perQuery: Array<{
    query: string;
    rank: number | null; // Rank of first relevant result
    relevant: number;
    retrieved: number;
  }>;
}
```

### AI-Powered Suggestions

```
search_suggest_improvements({ knowledgeBaseId: '...', evalSet: '...' })

Response:
{
  suggestions: [
    {
      type: 'add_reranker',
      reason: 'Vector search returns relevant docs but wrong order. Reranker would fix 12/20 queries.',
      confidence: 0.9,
      estimatedMRRImprovement: '+0.15'
    },
    {
      type: 'adjust_chunk_size',
      reason: 'Chunks averaging 800 tokens too large for precise matching. Try 256-512.',
      confidence: 0.7,
      estimatedRecallImprovement: '+0.08'
    },
    {
      type: 'add_query_expansion',
      reason: '5 queries use terminology not in docs. Query expansion would help.',
      confidence: 0.6,
    }
  ]
}
```

### A/B Comparison

```
search_compare_configs({
  evalSet: 'policy-eval-v1',
  configA: { label: 'baseline', ... },
  configB: { label: 'with-reranker', ... }
})

Response:
{
  configA: { label: 'baseline', mrr: 0.72, ndcg5: 0.68 },
  configB: { label: 'with-reranker', mrr: 0.91, ndcg5: 0.88 },
  perQuery: [
    { query: '...', rankA: 4, rankB: 1, improved: true },
    { query: '...', rankA: 1, rankB: 1, unchanged: true },
    { query: '...', rankA: 2, rankB: 3, regressed: true },
  ]
}
```

---

## 12. Integration Contract (search-ai-sdk)

The `@agent-platform/search-ai-sdk` package is the **formal boundary** between the Agent Platform and Search AI teams. Changes to this package require joint review.

### Types

```typescript
// packages/search-ai-sdk/src/types.ts

export interface SearchRequest {
  knowledgeBaseId: string;
  query: string;
  topK?: number; // default 5
  strategy?: 'vector' | 'fulltext' | 'hybrid' | 'graph' | 'auto';
  filters?: Record<string, unknown>; // metadata filters
  rerank?: boolean; // default true
  tokenBudget?: number; // max tokens for assembled context
  includeCitations?: boolean; // default true
}

export interface SearchResult {
  chunkId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  citation?: {
    documentTitle: string;
    sourceUrl: string;
    section?: string;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  query: { original: string; rewritten?: string };
  meta: {
    latencyMs: number;
    strategy: string;
    indexesUsed: string[];
    totalFound: number;
  };
}

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  slug: string;
  documentCount: number;
  chunkCount: number;
  lastSyncAt: string | null;
  indexTypes: string[];
}
```

### Client

```typescript
// packages/search-ai-sdk/src/client.ts

export class SearchAIClient {
  constructor(baseUrl: string, options?: { tenantId: string; apiKey?: string });

  search(req: SearchRequest): Promise<SearchResponse>;
  searchMultiple(req: MultiSearchRequest): Promise<SearchResponse>;
  listKnowledgeBases(): Promise<KnowledgeBaseSummary[]>;
  getKnowledgeBase(id: string): Promise<KnowledgeBaseDetail>;
}
```

The Agent Runtime imports `SearchAIClient` and calls it during agent execution. SearchAI exposes `/api/v1/search`. **This is the only runtime coupling point.**

### SDK Package Contents

```
packages/search-ai-sdk/
  src/
    types.ts              # SearchRequest, SearchResponse, KB types
    client.ts             # SearchAIClient HTTP client
    stages.ts             # StageHandler, StageContext interfaces
    connector-sdk.ts      # ConnectorDefinition extended interface
    eval-types.ts         # EvalSet, EvalResult types
  package.json            # @agent-platform/search-ai-sdk
```

---

## 13. Agent DSL Integration

### KNOWLEDGE Block

Agents declare which knowledge bases they can use:

```
AGENT travel-advisor
  MODEL: claude-sonnet-4-5-20250929

  KNOWLEDGE:
    - kb: products          # alias -> resolves to kb_product_docs
      strategy: hybrid
      top_k: 5
    - kb: policies          # alias -> resolves to kb_policy_docs
      strategy: vector
      top_k: 3
    - kb: faqs
      strategy: vector
      top_k: 3
```

### SEARCH Step

Agents use `SEARCH` in their flow to query knowledge bases:

```
  FLOW:
    1. SEARCH products WITH {{user_message}}
       STORE results AS product_context
    2. SEARCH policies WITH "cancellation policy for {{destination}}"
       STORE results AS policy_context
    3. RESPOND using product_context AND policy_context
```

### Compilation

At compile time:

- The compiler validates KB aliases exist in `ProjectKnowledgeBase`
- The IR includes resolved `knowledgeBaseId` for each alias
- The `SEARCH` step compiles to a `search` action node in the IR

At runtime:

- The executor hits a `search` node
- Calls `SearchAIClient.search()` with the resolved KB ID
- Injects results into the agent's context for the next LLM call

---

## 14. Multi-KB Usage Patterns

### Pattern A: Single KB Per Step (Most Common)

```
FLOW:
  1. SEARCH products WITH {{user_message}}
     STORE results AS product_context
  2. SEARCH policies WITH "cancellation policy for {{destination}}"
     STORE results AS policy_context
  3. RESPOND using product_context AND policy_context
```

Each `SEARCH` hits one KB. The agent orchestrates by combining results across steps.

### Pattern B: Fan-Out Search (Single Step, Multiple KBs)

```
FLOW:
  1. SEARCH [products, policies, faqs] WITH {{user_message}}
     MERGE: interleave BY score
     TOP_K: 8
     STORE results AS context
  2. RESPOND using context
```

The runtime fans out to all three KBs in parallel, merges results by score, deduplicates, and returns the top K.

### Pattern C: Conditional KB Selection

```
FLOW:
  1. CLASSIFY user_message INTO [product_question, policy_question, general]
  2. IF product_question:
       SEARCH products WITH {{user_message}}
     ELIF policy_question:
       SEARCH policies WITH {{user_message}}
     ELSE:
       SEARCH faqs WITH {{user_message}}
     STORE results AS context
  3. RESPOND using context
```

Routes to the right KB based on intent. More efficient — avoids searching irrelevant indexes.

### Runtime Execution Flow

```
Agent Executor hits SEARCH step
         |
         v
SearchService.search({
  aliases: ['products'],             <- from DSL
  projectId: 'proj_123',
  query: 'flights to Tokyo',
  strategy: 'hybrid',
  topK: 5
})
         |
         v
Resolve alias -> ProjectKnowledgeBase lookup
  'products' -> knowledgeBaseId: 'kb_abc123'
         |
         v
HTTP POST -> Search Engine /api/v1/search
{
  knowledgeBaseId: 'kb_abc123',
  query: 'flights to Tokyo',
  strategy: 'hybrid',
  topK: 5,
  tenantId: 'tenant_xyz'            <- tenant isolation
}
         |
         v
Search Engine retrieval pipeline:
  1. Query understanding: expand, rewrite
  2. Vector search: embed query -> cosine similarity
  3. Fulltext search: BM25 against chunk content
  4. Merge: reciprocal rank fusion (RRF)
  5. Rerank: cross-encoder scores top 20 -> return top 5
  6. Assemble: content + citations
         |
         v
SearchResponse returned to Agent Executor
  -> injected into LLM context
  -> LLM generates answer with citations
```

---

## 15. Hot Configuration & Live Reload

### What Changes Without Restart

| Change                                        | Effect                                | When Applied |
| --------------------------------------------- | ------------------------------------- | ------------ |
| Pipeline stage order                          | Next pipeline run uses new order      | Immediately  |
| Stage config (chunk size, model, etc.)        | Next pipeline run uses new config     | Immediately  |
| Custom stage code update                      | New version loaded on next invocation | Immediately  |
| KB settings (embedding model, chunk strategy) | Requires re-index of affected content | On re-index  |
| Connector config (credentials, filters)       | Next sync uses new config             | Next sync    |
| Retrieval pipeline config (weights, reranker) | Next query uses new config            | Immediately  |
| New custom stage registered                   | Available for pipeline inclusion      | Immediately  |

### How It Works

The Stage Registry checks version numbers on each pipeline run. If the DB version is newer than the cached version, it reloads. Custom stages are dynamically imported from DB source. No deployment, no restart, no downtime.

For safety, every custom stage version is preserved. Pipelines can pin to a specific version. If a new version fails at runtime, the pipeline falls back to the previous version automatically.

---

## 16. Security & Sandboxing

This section covers the full enterprise security architecture for Search AI — custom code execution, multi-tenant isolation, credential management, audit, compliance, and network controls.

### 16.1 Threat Model

Running user-uploaded code in a multi-tenant platform creates these attack surfaces:

| Threat                       | Description                                                    | Impact                   |
| ---------------------------- | -------------------------------------------------------------- | ------------------------ |
| **Sandbox escape**           | Custom stage breaks out of isolation, accesses host process    | Full system compromise   |
| **Cross-tenant data access** | Tenant A's stage reads Tenant B's documents/chunks/credentials | Data breach              |
| **Resource exhaustion**      | Infinite loop, memory bomb, or fork bomb starves other tenants | Denial of service        |
| **Data exfiltration**        | Custom stage sends indexed content to external endpoint        | Data breach              |
| **Credential theft**         | Custom stage captures decrypted credentials from StageContext  | Credential compromise    |
| **Supply chain**             | Custom stage imports malicious npm package                     | Arbitrary code execution |
| **Configuration tampering**  | Unauthorized pipeline/connector changes                        | Data integrity loss      |
| **PII leakage**              | Custom stage logs or returns PII in metrics/output             | Compliance violation     |

### 16.2 Defense Layers

```
+-----------------------------------------------------------------------+
|  Layer 1: Code Admission Control                                       |
|  Static analysis, approval workflow, import restrictions               |
+-----------------------------------------------------------------------+
         |
         v
+-----------------------------------------------------------------------+
|  Layer 2: Execution Sandbox                                            |
|  V8 Isolate, blocked APIs, resource limits, timeout enforcement        |
+-----------------------------------------------------------------------+
         |
         v
+-----------------------------------------------------------------------+
|  Layer 3: Tenant-Scoped Services                                       |
|  Every ctx.services call scoped to tenantId, no cross-tenant access    |
+-----------------------------------------------------------------------+
         |
         v
+-----------------------------------------------------------------------+
|  Layer 4: Network Controls                                             |
|  Egress proxy, tenant allowlists, mTLS between services               |
+-----------------------------------------------------------------------+
         |
         v
+-----------------------------------------------------------------------+
|  Layer 5: Credential Lifecycle                                         |
|  KMS encryption, JIT decryption, rotation, redaction                   |
+-----------------------------------------------------------------------+
         |
         v
+-----------------------------------------------------------------------+
|  Layer 6: Audit & Compliance                                           |
|  Every action logged, immutable trail, SOC 2 / ISO 27001 hooks        |
+-----------------------------------------------------------------------+
```

### 16.3 Layer 1: Code Admission Control

Custom stage code goes through a **pipeline of checks** before it can execute in production.

#### Stage Lifecycle

```
Code uploaded (MCP tool or Studio)
         |
         v
+-------------------+
|  Static Analysis   |  Automated, runs instantly
|  - AST parsing     |
|  - Blocked API     |  Rejects: require(), eval(), Function(),
|    detection       |           process.*, child_process, fs, net
|  - Import audit    |  Only @agent-platform/search-ai-sdk allowed
|  - Pattern scan    |  Detects: prototype pollution, global mutation
+-------------------+
         |
         | pass
         v
+-------------------+
|  Status: draft     |  Can test with search_test_stage
|                    |  Cannot be added to production pipelines
+-------------------+
         |
         | (if approval required)
         v
+-------------------+
|  Review Queue      |  Tenant admin reviews code
|  - Diff from prev  |  Sees: code diff, static analysis report,
|    version         |         test results from author
|  - Approval/Reject |
+-------------------+
         |
         | approved (or auto-approve if tenant setting allows)
         v
+-------------------+
|  Status: active    |  Can be used in production pipelines
+-------------------+
```

#### Tenant-Configurable Approval Policy

```typescript
// Part of SearchProject.settings JSON
interface StageApprovalPolicy {
  requireApproval: boolean; // Default: true for production tenants
  autoApproveFor: string[]; // Roles that skip review: ['OWNER', 'ADMIN']
  requireTwoPersonApproval: boolean; // Author cannot approve their own code
  allowedImports: string[]; // Default: ['@agent-platform/search-ai-sdk']
  blockedPatterns: string[]; // Custom regex patterns to reject
  maxCodeSizeBytes: number; // Default: 512KB
}
```

#### Static Analysis Checks

| Check                   | What It Detects                                             | Action |
| ----------------------- | ----------------------------------------------------------- | ------ |
| **Blocked globals**     | `process`, `require`, `__dirname`, `Buffer.allocUnsafe`     | Reject |
| **Dynamic execution**   | `eval()`, `new Function()`, `vm.runInContext`               | Reject |
| **Filesystem access**   | `fs.*`, `path.resolve` with `..`                            | Reject |
| **Network primitives**  | `net.*`, `dgram.*`, `dns.*`, `child_process.*`              | Reject |
| **Prototype pollution** | `__proto__`, `constructor.prototype` assignments            | Reject |
| **Global mutation**     | `globalThis.*` assignments, `Object.defineProperty(global)` | Reject |
| **Unapproved imports**  | Any import not in `allowedImports`                          | Reject |
| **Infinite loop risk**  | `while(true)` without `ctx.signal` check                    | Warn   |
| **PII patterns**        | Regex for SSN, credit card, email in hardcoded strings      | Warn   |
| **Code size**           | Exceeds `maxCodeSizeBytes`                                  | Reject |

### 16.4 Layer 2: Execution Sandbox

Custom stages run in **V8 Isolates** (not just Worker threads), providing memory-level isolation.

```
Search Engine Process (Node.js)
|
+-- Pipeline Executor
    |
    +-- Built-in stages: run in-process (trusted code)
    |
    +-- Custom stages: run in V8 Isolate
        |
        +------------------------------------------------------+
        | V8 Isolate (isolated-vm or similar)                   |
        |                                                       |
        | Memory:                                               |
        |   - Separate V8 heap (not shared with host)           |
        |   - Hard limit: 256MB default, 1GB max                |
        |   - OOM kills the isolate, not the host               |
        |                                                       |
        | CPU:                                                  |
        |   - Wall-clock timeout: 60s default, 5min max         |
        |   - CPU time tracking via V8 inspector                |
        |   - Isolate terminated on timeout (not graceful)      |
        |                                                       |
        | APIs available inside isolate:                        |
        |   - ctx.services.llm     (proxied to host)            |
        |   - ctx.services.storage (proxied to host)            |
        |   - ctx.services.cache   (proxied to host)            |
        |   - ctx.services.logger  (captured, not direct)       |
        |   - ctx.services.fetch   (proxied through egress)     |
        |   - JSON, Math, Date, String, Array, Map, Set         |
        |   - TextEncoder, TextDecoder, URL, URLSearchParams    |
        |                                                       |
        | APIs NOT available:                                   |
        |   - require, import (no module loading)               |
        |   - fs, path, os, child_process, net, dns, tls        |
        |   - process, Buffer (except via polyfill)             |
        |   - eval, Function constructor                        |
        |   - globalThis mutation                               |
        |   - setTimeout, setInterval (use ctx.signal instead)  |
        +------------------------------------------------------+
```

#### Why V8 Isolates, Not Just Worker Threads

| Concern             | Worker Thread                             | V8 Isolate                                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Memory isolation    | Shared V8 heap — OOM can crash host       | Separate heap — OOM kills only isolate                  |
| API access          | Full Node.js APIs unless manually blocked | No Node.js APIs by default — must be explicitly bridged |
| Prototype pollution | Can affect shared objects                 | Completely separate object graph                        |
| Module loading      | Can `require()` any installed package     | No module system — only injected references             |
| Crash containment   | Uncaught exception can leak state         | Isolate disposed cleanly, no state leakage              |

#### Service Proxy Architecture

Custom stages don't call platform services directly. Every service call is **proxied through the host** via a message-passing bridge:

```
Inside V8 Isolate                    Host Process
                                     (Pipeline Executor)
ctx.services.llm.generate({
  model: 'claude-haiku',             -----> validateTenantQuota(tenantId)
  messages: [...]                    -----> llmClient.generate(...)
})                                   <----- return result (or quota error)
                                     -----> recordUsage(tenantId, tokens)

ctx.services.fetch(url, options)
                                     -----> egressProxy.fetch(url, tenantId)
                                            - check tenant allowlist
                                            - strip internal headers
                                            - log request
                                     <----- return response (or blocked error)
```

This ensures:

- Every LLM call is charged to the correct tenant
- Every network call goes through the egress proxy
- The isolate cannot bypass tenant quotas or network rules
- The host can terminate any call if the tenant's limits are exceeded

### 16.5 Layer 3: Multi-Tenant Data Isolation

#### Principle: Every Query is Scoped

No API endpoint, service method, or database query returns data without a `tenantId` filter. This is enforced at multiple levels.

```
Request arrives
    |
    v
Auth middleware extracts tenantId from JWT
    |
    v
Tenant middleware attaches tenantId to request context
    |
    v
Service layer: every query includes WHERE tenantId = ?
    |
    v
Custom stage context: ctx.tenantId is read-only, set by platform
    |
    v
StageContext.services: every service call auto-scopes to tenantId
```

#### Data Isolation by Component

| Component             | Isolation Method                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prisma queries**    | Every model query includes `tenantId` in WHERE clause. Enforced by `scopeToTenant()` helper (from agent platform shared infra).                |
| **Vector index**      | Per-tenant namespace in pgvector (separate schema or `tenant_id` column filter). For Qdrant/Pinecone: per-tenant collection or payload filter. |
| **Graph index**       | Per-tenant subgraph with `tenantId` property on every node and edge. All traversals filtered.                                                  |
| **Full-text index**   | Per-tenant Postgres schema or mandatory `tenantId` filter term in every query.                                                                 |
| **BullMQ jobs**       | `tenantId` in job data. Worker validates before processing. Per-tenant concurrency limits.                                                     |
| **Object storage**    | Tenant-prefixed paths: `s3://bucket/{tenantId}/documents/...`. IAM policies prevent cross-prefix access.                                       |
| **Redis cache**       | Tenant-prefixed keys: `search:{tenantId}:kb:{kbId}:...`. Key pattern isolation.                                                                |
| **Custom stage code** | Stored per `searchProjectId` which is tenant-scoped. Cannot reference another project's stages.                                                |
| **MCP tool calls**    | Every tool receives `tenantId` from auth context. No tool accepts tenant as input parameter.                                                   |

#### Cross-Tenant Prevention (Defense in Depth)

```typescript
// Resource guard pattern (reuses agent platform middleware)

// Level 1: Middleware (request-level)
function tenantMiddleware(req, res, next) {
  req.tenantId = extractFromJWT(req); // Cannot be overridden by client
  next();
}

// Level 2: Service layer (query-level)
class KnowledgeBaseService {
  async getKB(kbId: string, tenantId: string) {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: kbId },
      include: { searchProject: { select: { tenantId: true } } },
    });
    if (!kb || kb.searchProject.tenantId !== tenantId) {
      throw new TenantAccessError('Knowledge base not found');
      // Same error message whether KB doesn't exist or belongs to another tenant
      // (prevents tenant enumeration)
    }
    return kb;
  }
}

// Level 3: StageContext (execution-level)
function buildStageContext(tenantId: string): StageContext {
  return {
    tenantId, // Read-only, frozen
    services: {
      llm: createScopedLLMClient(tenantId), // Quota-aware
      storage: createScopedStorage(tenantId), // Path-prefixed
      cache: createScopedCache(tenantId), // Key-prefixed
      fetch: createScopedFetch(tenantId), // Allowlist-filtered
      logger: createScopedLogger(tenantId), // Tenant-tagged
      metrics: createScopedMetrics(tenantId), // Tenant-tagged
    },
  };
}
// The tenantId on StageContext is Object.freeze()'d — custom stage cannot mutate it
```

### 16.6 Layer 4: Network Controls

#### Egress Proxy

All outbound HTTP from custom stages is routed through a **tenant-aware egress proxy**.

```
Custom Stage (in V8 Isolate)
    |
    | ctx.services.fetch('https://api.example.com/data')
    v
+-------------------------------------------+
|  Egress Proxy                              |
|                                            |
|  1. Check tenant allowlist                 |
|     - Tenant has allowedDomains config     |
|     - Default: block all (explicit allow)  |
|     - OR: allow all except blocklist       |
|                                            |
|  2. Strip sensitive headers                |
|     - Remove internal auth tokens          |
|     - Remove X-Tenant-Id (internal)        |
|                                            |
|  3. Rate limit per tenant                  |
|     - Max requests/min per tenant          |
|     - Max bandwidth/min per tenant         |
|                                            |
|  4. Log request                            |
|     - Destination, status, bytes, latency  |
|     - Tenant attribution                   |
|     - Retained for audit                   |
|                                            |
|  5. Block internal network                 |
|     - 10.0.0.0/8, 172.16.0.0/12 blocked   |
|     - 169.254.169.254 blocked (cloud meta) |
|     - localhost blocked                    |
+-------------------------------------------+
    |
    v
External API
```

#### Tenant Egress Configuration

```typescript
// Part of SearchProject.settings or tenant-level config
interface EgressPolicy {
  mode: 'allowlist' | 'blocklist'; // Default: allowlist (stricter)
  allowedDomains?: string[]; // For allowlist mode
  blockedDomains?: string[]; // For blocklist mode
  maxRequestsPerMinute: number; // Default: 100
  maxBandwidthMBPerMinute: number; // Default: 50
  allowInternalNetwork: boolean; // Default: false (NEVER in production)
  logRequests: boolean; // Default: true
}
```

#### Internal Service Communication

```
Studio (3000)  <--mTLS-->  Search Engine (3003)
Runtime (3002) <--mTLS-->  Search Engine (3003)

- mTLS with service-specific certificates
- No custom stage can call internal service ports
- Internal ports bound to 127.0.0.1 or overlay network only
```

### 16.7 Layer 5: Credential Lifecycle

Credentials for connectors (API keys, OAuth tokens, service account keys) are the highest-value targets in the system.

#### Encryption Architecture

```
User provides credential (Studio or MCP tool)
    |
    v
+-------------------------------------------+
|  Credential Encryption                     |
|                                            |
|  1. Generate per-credential nonce (IV)     |
|                                            |
|  2. Derive encryption key:                 |
|     KMS master key                         |
|       -> tenant-scoped data key (DEK)      |
|         -> HKDF with credential ID salt    |
|                                            |
|  3. Encrypt: AES-256-GCM(DEK, nonce, data) |
|                                            |
|  4. Store: { nonce, ciphertext, tag,       |
|              kmsKeyVersion, tenantId }     |
|                                            |
|  5. DEK is NOT stored — derived on demand  |
+-------------------------------------------+
    |
    v
Connector.config in DB (encrypted blob)
```

#### Key Management

| Concern                       | Approach                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Master key**                | Stored in KMS (AWS KMS, GCP Cloud KMS, or HashiCorp Vault). Never in env vars or code.                                               |
| **Data encryption key (DEK)** | Derived per-tenant from master key via HKDF. Cached in memory for performance, rotated with master key.                              |
| **Key rotation**              | Master key rotated on schedule (90 days). Old versions retained for decryption of existing data. New encryptions use latest version. |
| **Key access audit**          | KMS logs every key usage. Alert on anomalous access patterns.                                                                        |

#### Just-In-Time Decryption

Credentials are decrypted **only during connector sync execution**, and only in the host process (never inside the V8 isolate).

```
Pipeline Executor (host process)
    |
    | About to run connector stage
    v
Decrypt credential from DB using KMS-derived DEK
    |
    v
Pass credential to connector stage via StageContext.config
    |
    | Connector executes, uses credential for API calls
    v
Clear credential from memory (zero-fill the buffer)
    |
    v
If custom connector (V8 isolate):
  - Credential passed as opaque token, not raw value
  - ctx.services.fetch auto-attaches credential to requests
  - Custom code sees: ctx.config.apiUrl but NOT ctx.config.apiKey
  - Credential headers injected by the egress proxy
```

#### Credential Redaction in Custom Stages

For custom connectors, credentials are **never exposed to custom code**:

```typescript
// What the custom connector sees:
ctx.config = {
  apiUrl: 'https://wiki.acme.com', // Visible
  contentTypes: ['article', 'faq'], // Visible
  // apiKey is NOT here — it's handled by the platform
};

// When the custom connector calls:
ctx.services.fetch('https://wiki.acme.com/api/pages');
// The egress proxy auto-injects:
//   Authorization: Bearer <decrypted-api-key>
// The custom code never sees the raw key
```

This eliminates credential theft by custom stages entirely. The custom code can make authenticated requests, but cannot extract the credential value.

#### Credential Rotation

```
Admin rotates credential in Studio or via MCP tool
    |
    v
1. New credential encrypted and stored
2. Old credential marked as 'rotating' (still valid for in-flight syncs)
3. Next sync uses new credential
4. After grace period (configurable, default 1 hour), old credential deleted
5. Audit log records rotation event
```

### 16.8 Layer 6: Audit & Compliance

#### What Gets Logged

Every action in Search AI produces an immutable audit record.

| Action Category            | Events Logged                                                           |
| -------------------------- | ----------------------------------------------------------------------- |
| **Custom stage lifecycle** | register, update, approve, reject, deprecate, delete, rollback          |
| **Custom stage execution** | start, complete, fail, timeout, sandbox violation                       |
| **Pipeline changes**       | create, update stages, deploy, undeploy                                 |
| **Connector changes**      | create, update config, rotate credentials, enable/disable               |
| **KB changes**             | create, update settings, reindex, delete                                |
| **Data operations**        | sync started, sync completed, documents indexed, documents deleted      |
| **Search queries**         | query executed (with latency, result count — NOT query text by default) |
| **Configuration changes**  | approval policy changed, egress policy changed, resource limits changed |
| **Auth events**            | MCP tool authenticated, API key used, permission denied                 |

#### Audit Record Structure

```typescript
interface AuditRecord {
  id: string;
  timestamp: Date;
  tenantId: string;
  userId: string; // Who performed the action
  action: string; // e.g. 'custom_stage.register', 'pipeline.update'
  resourceType: string; // e.g. 'CustomStage', 'Pipeline', 'Connector'
  resourceId: string;
  details: {
    before?: Record<string, unknown>; // Previous state (for updates)
    after?: Record<string, unknown>; // New state
    diff?: string[]; // Changed fields
    reason?: string; // User-provided reason (for approvals/rejections)
  };
  metadata: {
    ip: string;
    userAgent: string;
    source: 'studio' | 'mcp' | 'api' | 'system';
    requestId: string;
  };
}
```

#### Audit Storage

```
Audit records
    |
    +-- Real-time: Written to append-only AuditLog table (Prisma)
    |   - tenantId indexed for fast per-tenant queries
    |   - Immutable: no UPDATE or DELETE operations allowed
    |   - Retained per tenant's retention policy (default: 2 years)
    |
    +-- Stream: Published to Redis Stream / event bus
        - Real-time dashboards in Studio Monitor
        - Alert rules (e.g., "notify on custom stage rejection")
        - SIEM integration (Splunk, Datadog, etc.)
```

#### Compliance Controls

| Standard          | How Addressed                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SOC 2 Type II** | Audit logging, access controls, encryption at rest, change management (approval workflow)                                                          |
| **ISO 27001**     | Asset inventory (KBs, connectors), risk assessment (threat model), access control, incident management                                             |
| **GDPR**          | PII detection in pipeline (opt-in enrichment stage), data subject deletion (cascade delete document + chunks), data processing records (audit log) |
| **HIPAA**         | Encryption at rest (KMS), audit trail, access controls, BAA support for managed deployment                                                         |
| **SOX**           | Change approval workflow, immutable audit log, separation of duties (two-person approval)                                                          |

### 16.9 Resource Quotas & Abuse Prevention

Per-tenant resource limits prevent one tenant from degrading service for others.

#### Quota Configuration

```typescript
// Tenant-level resource quotas (stored in Tenant settings or plan config)
interface SearchAIQuotas {
  // Custom stages
  maxCustomStages: number; // Default: 50
  maxStageCodeSizeBytes: number; // Default: 512KB
  maxConcurrentStageExecutions: number; // Default: 10

  // Pipelines
  maxPipelinesPerProject: number; // Default: 20
  maxStagesPerPipeline: number; // Default: 15

  // Indexing
  maxDocumentsPerKB: number; // Default: 100,000
  maxChunksPerKB: number; // Default: 1,000,000
  maxKBsPerProject: number; // Default: 20
  maxTotalStorageGB: number; // Default: 50

  // Execution
  maxSyncConcurrency: number; // Default: 3
  maxLLMTokensPerMonth: number; // Default: 10,000,000
  maxEgressRequestsPerMinute: number; // Default: 100
  maxQueryRatePerMinute: number; // Default: 600

  // Stage execution limits
  stageTimeoutMs: number; // Default: 60,000
  stageMemoryMB: number; // Default: 256
  stageMaxTimeoutMs: number; // Hard cap: 300,000
  stageMaxMemoryMB: number; // Hard cap: 1024
}
```

#### Enforcement Points

```
Request arrives
    |
    v
Rate limiter (sliding window, per-tenant)
    |
    v
Quota check (tenant quota service)
    |
    v
Pipeline Executor
    |
    +-- Per-stage: isolate time + memory limits
    +-- Per-pipeline: total execution time limit
    +-- Per-sync: document count limit
    |
    v
LLM Client (per-tenant token budget)
    |
    v
Egress Proxy (per-tenant request + bandwidth limits)
```

### 16.10 Security Configuration in Studio

Search AI admins manage security settings via Studio:

```
SEARCH AI > Settings > Security

+-- Approval Policy
|   [x] Require approval for custom stages
|   [x] Two-person approval (author cannot self-approve)
|   Auto-approve for: [OWNER] [ADMIN]
|
+-- Network Controls
|   Egress mode: (o) Allowlist  ( ) Blocklist
|   Allowed domains:
|     + api.openai.com
|     + wiki.acme.com
|     + confluence.acme.atlassian.net
|   [ ] Allow internal network (NOT recommended)
|
+-- Resource Limits
|   Stage timeout: [60] seconds (max 300)
|   Stage memory:  [256] MB (max 1024)
|   Max custom stages: [50]
|   Max documents per KB: [100,000]
|
+-- Audit
|   Retention period: [2] years
|   [x] Log search queries (anonymized)
|   [x] Log stage execution details
|   SIEM webhook: [https://siem.acme.com/webhook]
```

### 16.11 Prisma Models for Security

```prisma
// Added to the data model

model StageApproval {
  id            String   @id @default(cuid())
  stageVersionId String
  status        String   // 'pending' | 'approved' | 'rejected'
  reviewerId    String?  // null until reviewed
  reviewerNote  String?
  staticAnalysis String  // JSON: results of automated code analysis
  requestedBy   String
  requestedAt   DateTime @default(now())
  reviewedAt    DateTime?

  @@index([stageVersionId])
  @@index([status])
}

model SearchAuditLog {
  id           String   @id @default(cuid())
  tenantId     String
  userId       String
  action       String
  resourceType String
  resourceId   String
  details      String   // JSON: { before, after, diff, reason }
  metadata     String   // JSON: { ip, userAgent, source, requestId }
  createdAt    DateTime @default(now())

  // No updatedAt — audit logs are immutable
  // No onDelete cascade — audit logs are retained independently

  @@index([tenantId, createdAt])
  @@index([tenantId, resourceType, resourceId])
  @@index([tenantId, action])
}

model TenantEgressRule {
  id        String   @id @default(cuid())
  tenantId  String
  domain    String
  action    String   // 'allow' | 'block'
  createdBy String
  createdAt DateTime @default(now())

  @@unique([tenantId, domain])
  @@index([tenantId])
}
```

### 16.12 Security Summary

```
+--------+--------------------------------+---------------------------+
| Layer  | What It Protects               | Key Mechanism             |
+--------+--------------------------------+---------------------------+
| L1     | Malicious code from entering   | Static analysis,          |
|        | the system                     | approval workflow,        |
|        |                                | import restrictions       |
+--------+--------------------------------+---------------------------+
| L2     | Host process from custom code  | V8 Isolates,              |
|        |                                | blocked APIs,             |
|        |                                | resource limits           |
+--------+--------------------------------+---------------------------+
| L3     | Tenant data from cross-tenant  | Scoped services,          |
|        | access                         | query-level tenantId,     |
|        |                                | namespace isolation       |
+--------+--------------------------------+---------------------------+
| L4     | Internal network from custom   | Egress proxy,             |
|        | code                           | tenant allowlists,        |
|        |                                | mTLS between services     |
+--------+--------------------------------+---------------------------+
| L5     | Credentials from theft or      | KMS encryption,           |
|        | misuse                         | JIT decryption,           |
|        |                                | proxy-injected auth       |
+--------+--------------------------------+---------------------------+
| L6     | Organization from undetected   | Immutable audit log,      |
|        | changes or breaches            | real-time alerts,         |
|        |                                | SIEM integration          |
+--------+--------------------------------+---------------------------+
```

---

## 17. Codebase Structure

```
agent-platform/                       (monorepo - pnpm workspaces)
|
+-- packages/
|   +-- shared/                       # Shared: auth types, tenant types, API client base
|   +-- compiler/                     # Agent DSL compiler (adds KNOWLEDGE/SEARCH nodes)
|   +-- core/                         # Agent DSL parser/AST
|   +-- search-ai-sdk/                # ** Contract + extensibility SDK **
|   |   +-- src/
|   |   |   +-- types.ts              # SearchRequest, SearchResponse, KB types
|   |   |   +-- client.ts             # SearchAIClient class (HTTP client)
|   |   |   +-- stages.ts             # StageHandler, StageContext interfaces
|   |   |   +-- connector-sdk.ts      # ConnectorDefinition extended interface
|   |   |   +-- eval-types.ts         # EvalSet, EvalResult types
|   |   +-- package.json              # @agent-platform/search-ai-sdk
|   +-- kore-platform-cli/
|
+-- apps/
|   +-- runtime/                      # Agent Runtime (consumes search-ai-sdk)
|   |   +-- src/services/search-ai/   # SearchAI service wrapping SearchAIClient
|   |
|   +-- studio/                       # Unified Studio UI
|   |   +-- src/
|   |       +-- app/
|   |       |   +-- (agents)/         # Agent routes (existing)
|   |       |   +-- (search-ai)/      # ** Search AI routes **
|   |       |       +-- search-ai/connectors/
|   |       |       +-- search-ai/knowledge-bases/
|   |       |       +-- search-ai/pipelines/
|   |       |       +-- search-ai/retrieval/
|   |       +-- components/
|   |       |   +-- agents/           # Agent components (existing)
|   |       |   +-- search-ai/        # ** Search AI components **
|   |       |       +-- ConnectorList.tsx
|   |       |       +-- KnowledgeBaseConfig.tsx
|   |       |       +-- PipelineEditor.tsx
|   |       |       +-- StageCodeEditor.tsx    # Monaco editor for custom stages
|   |       |       +-- KBPickerDialog.tsx     # Used from Agent editor too
|   |       |       +-- RetrievalTuner.tsx     # Visual eval/tuning dashboard
|   |       +-- api/
|   |           +-- search-ai/        # ** Proxy routes to SearchAI **
|   |
|   +-- search-ai/                    # ** Search AI backend **
|   |   +-- src/
|   |   |   +-- mcp/                  # MCP tool surface
|   |   |   |   +-- tools/            # One file per tool
|   |   |   |   |   +-- search-test-connector.ts
|   |   |   |   |   +-- search-test-pipeline.ts
|   |   |   |   |   +-- search-test-stage.ts
|   |   |   |   |   +-- search-query-debug.ts
|   |   |   |   |   +-- search-register-stage.ts
|   |   |   |   |   +-- search-run-eval.ts
|   |   |   |   |   +-- search-compare-configs.ts
|   |   |   |   |   +-- search-tune-retrieval.ts
|   |   |   |   +-- index.ts          # MCP server setup (stdio-based)
|   |   |   |   +-- docs/             # Embedded tool documentation
|   |   |   |
|   |   |   +-- stages/               # Built-in stage implementations
|   |   |   |   +-- connectors/       # web-crawler, confluence, salesforce, etc.
|   |   |   |   +-- extraction/       # document-parser, chunkers, metadata
|   |   |   |   +-- enrichment/       # embeddings, entities, classifiers, LLM stages
|   |   |   |   +-- retrieval/        # vector, fulltext, graph, mergers, rerankers
|   |   |   |
|   |   |   +-- runtime/              # Stage execution engine
|   |   |   |   +-- stage-registry.ts  # Loads built-in + custom stages
|   |   |   |   +-- stage-loader.ts    # Dynamic import for custom stages
|   |   |   |   +-- stage-sandbox.ts   # Worker thread isolation
|   |   |   |   +-- pipeline-executor.ts # Runs stages in sequence
|   |   |   |   +-- pipeline-tester.ts  # Test mode with per-stage output capture
|   |   |   |
|   |   |   +-- eval/                  # Retrieval evaluation framework
|   |   |   |   +-- eval-runner.ts     # Run eval sets against KBs
|   |   |   |   +-- metrics.ts         # MRR, NDCG, precision, recall
|   |   |   |   +-- comparator.ts      # A/B config comparison
|   |   |   |
|   |   |   +-- indexing/              # Vector, graph, fulltext index managers
|   |   |   +-- routes/                # Admin API + Search API
|   |   |   +-- middleware/            # Reuses shared auth/tenant middleware
|   |   |   +-- workers/              # BullMQ workers for async pipeline jobs
|   |   +-- package.json              # @agent-platform/search-ai
|   |
|   +-- data/                         # Shared SQLite/Postgres DB file
|
+-- pnpm-workspace.yaml               # All apps/* and packages/* included
```

### Why Same Monorepo?

| Concern                           | Benefit                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| **Shared Prisma schema**          | Search models live alongside agent models, same migrations                              |
| **Shared auth/tenant middleware** | Import directly from `@agent-platform/shared`, no duplication                           |
| **Atomic cross-cutting changes**  | When `search-ai-sdk` types change, both runtime and search-ai update in the same PR     |
| **Independent work**              | Teams work in separate directories (`apps/search-ai/`, `apps/studio/src/**/search-ai/`) |

---

## 18. Release Lifecycle

```
                    +-------------------+
                    |  Shared Packages   |
                    |  @agent-platform/  |
                    |  shared            |
                    |  search-ai-sdk     |
                    +---------+---------+
                              | semver (breaking = major bump)
                    +---------+---------+
                    |                    |
         +----------v--------+  +-------v-----------+
         |  Agent Train       |  |  Search AI Train   |
         |                    |  |                     |
         |  compiler          |  |  search-ai          |
         |  runtime           |  |  studio/search/*    |
         |  studio/agents/*   |  |  connectors         |
         |  core              |  |  custom stages      |
         +--------------------+  +---------------------+
              independent             independent
              release cadence         release cadence
```

### Rules

| Concern                                                  | Approach                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Contract changes** (`search-ai-sdk` types)             | Both teams review. Semver: additive = minor, breaking = major.                          |
| **SearchAI internals** (connectors, pipelines, indexing) | Search team ships independently. No agent team review needed.                           |
| **Agent Runtime internals** (sessions, execution)        | Agent team ships independently.                                                         |
| **Shared infra** (`shared/`, Prisma schema, middleware)  | Joint review. Migrations coordinated.                                                   |
| **Studio UI**                                            | Route groups owned by respective teams. Shared shell (nav, auth) requires coordination. |
| **CI/CD**                                                | Monorepo CI with path-based triggers: `apps/search-ai/**` only runs search tests.       |
| **Custom stages**                                        | Deployed at runtime (not part of release train). Versioned per-tenant in DB.            |

### Branching Model

```
main
+-- feat/search-confluence-connector    (Search team)
+-- feat/agent-knowledge-dsl-syntax     (Agent team)
+-- feat/search-ai-sdk-v2-filters       (Joint - both teams review)
```

---

## 19. UX & Navigation

### Studio Navigation

```
+----------------------------------------------------------+
|  Studio            [Tenant: Acme Corp v]      [User v]    |
+----------+----------------------------------------------- +
|          |                                                |
| AGENTS   |  (current content area)                        |
|  Agents  |                                                |
|  Deploy  |                                                |
|  Observe |                                                |
|          |                                                |
| SEARCH AI|                                                |
|  Sources |  <- Connector management (built-in + custom)   |
|  KBs     |  <- Knowledge base config + status             |
|  Pipes   |  <- Pipeline editor (drag-and-drop stages)     |
|  Stages  |  <- Custom stage management + code editor      |
|  Tuning  |  <- Eval sets, A/B comparison, quality metrics |
|  Monitor |  <- Sync status, index health, query metrics   |
|          |                                                |
| SETTINGS |                                                |
|  Models  |                                                |
|  Team    |                                                |
|  Billing |                                                |
+----------+------------------------------------------------+
```

### Key UX Flows

**Search AI Admin — Configure a Knowledge Base:**

```
Search AI > Sources > + Add Connector > Confluence
  -> Enter URL, auth, space filter, sync schedule
  -> Test Connection (calls search_test_connection)
  -> Save -> Auto-creates default extraction pipeline

Search AI > KBs > + New Knowledge Base
  -> Name it, select connectors (with filters), choose indexing (vector + fulltext)
  -> Configure chunking strategy, embedding model
  -> Save -> Initial sync starts (progress in Monitor)
```

**Search AI Admin — Create Custom Stage:**

```
Search AI > Stages > + New Stage
  -> Monaco editor opens with StageHandler template
  -> Write code, click "Test" -> runs search_test_stage with sample input
  -> See output + metrics inline
  -> Iterate until satisfied
  -> Click "Register" -> stage available in pipeline editor
```

**Search AI Admin — Tune Retrieval:**

```
Search AI > Tuning > Select KB
  -> Upload or create eval set (query + expected results)
  -> Run baseline eval (search_run_eval)
  -> See MRR, NDCG, per-query breakdown
  -> Add reranker stage -> re-run eval -> compare
  -> See A/B comparison chart
  -> Deploy winning config
```

**Agent Developer — Link a KB to an Agent:**

```
Agent Editor > Knowledge Tab > + Link Knowledge Base
  -> KBPickerDialog opens (shows all KBs from Search AI projects in this tenant)
  -> Select "Product Docs" KB -> Set alias "product-docs"
  -> Choose retrieval strategy (hybrid) -> Save

DSL auto-updates:
  KNOWLEDGE:
    - kb: product-docs
      strategy: hybrid
```

**Dual-Role User:**
Same person navigates between AGENTS and SEARCH AI nav sections. No context switch, no separate login.

**Claude Code User (via MCP):**
Same operations as the UI, but faster and scriptable. Can write custom stages, run eval loops, and tune retrieval — all from the terminal.

---

## 20. Data Model (Prisma Schema)

```prisma
// ═══════════════════════════════════════════════════════════════
// SEARCH AI MODELS (extend shared schema)
// ═══════════════════════════════════════════════════════════════

model SearchProject {
  id          String   @id @default(cuid())
  name        String
  tenantId    String
  description String?
  settings    String?  // JSON: default embedding model, default chunk strategy, etc.
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  connectors  Connector[]
  knowledgeBases KnowledgeBase[]
  extractionPipelines ExtractionPipeline[]
  enrichmentPipelines EnrichmentPipeline[]
  customStages CustomStage[]

  @@index([tenantId])
}

model Connector {
  id              String   @id @default(cuid())
  searchProjectId String
  name            String
  type            String   // 'web_crawler' | 'confluence' | 'salesforce' | 'servicenow' | 's3' | 'custom'
  customStageId   String?  // For type='custom': references the custom connector stage
  config          String   // Encrypted JSON: credentials, URLs, space filters, etc.
  schedule        String?  // Cron expression for periodic sync
  status          String   @default("idle")  // 'idle' | 'syncing' | 'error' | 'disabled'
  lastSyncAt      DateTime?
  lastSyncStatus  String?  // JSON: { documentsFound, documentsNew, documentsUpdated, errors }
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  searchProject   SearchProject @relation(fields: [searchProjectId], references: [id])
  customStage     CustomStage?  @relation(fields: [customStageId], references: [id])
  bindings        ConnectorBinding[]
  documents       Document[]

  @@index([searchProjectId])
}

model KnowledgeBase {
  id              String   @id @default(cuid())
  searchProjectId String
  name            String
  slug            String
  description     String?
  embeddingModel  String   @default("text-embedding-3-small")
  chunkStrategy   String   @default("semantic")  // 'fixed' | 'semantic' | 'hierarchical' | 'sliding_window'
  chunkSize       Int      @default(512)
  chunkOverlap    Int      @default(64)
  indexConfig     String   // JSON: { vector: true, graph: false, fulltext: true }
  status          String   @default("empty")  // 'empty' | 'indexing' | 'ready' | 'error'
  documentCount   Int      @default(0)
  chunkCount      Int      @default(0)
  lastSyncAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  searchProject   SearchProject @relation(fields: [searchProjectId], references: [id])
  bindings        ConnectorBinding[]
  documents       Document[]
  chunks          Chunk[]
  retrievalPipelines RetrievalPipeline[]
  projectLinks    ProjectKnowledgeBase[]

  @@unique([searchProjectId, slug])
  @@index([searchProjectId])
}

model ConnectorBinding {
  id              String   @id @default(cuid())
  connectorId     String
  knowledgeBaseId String
  filters         String?  // JSON: { labels: [...], spaces: [...], contentTypes: [...] }
  extractionRules String?  // JSON: override extraction config for this binding
  enabled         Boolean  @default(true)
  lastSyncCursor  String?  // Connector-specific cursor for incremental sync
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  connector       Connector     @relation(fields: [connectorId], references: [id])
  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id])

  @@unique([connectorId, knowledgeBaseId])
  @@index([connectorId])
  @@index([knowledgeBaseId])
}

model Document {
  id              String   @id @default(cuid())
  connectorId     String
  knowledgeBaseId String
  sourceUrl       String
  title           String?
  contentHash     String   // SHA-256 for change detection / dedup
  rawContent      String?  // Original content (may be in object storage for large docs)
  status          String   @default("pending")  // 'pending' | 'extracted' | 'indexed' | 'error'
  metadata        String?  // JSON: source-specific metadata (author, date, labels, etc.)
  lastIndexedAt   DateTime?
  errorMessage    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  connector       Connector     @relation(fields: [connectorId], references: [id])
  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id])
  chunks          Chunk[]

  @@unique([knowledgeBaseId, sourceUrl])
  @@index([connectorId])
  @@index([knowledgeBaseId])
  @@index([contentHash])
}

model Chunk {
  id              String   @id @default(cuid())
  documentId      String
  knowledgeBaseId String
  content         String
  embedding       Bytes?   // Vector embedding (serialized float array, or use pgvector extension)
  metadata        String?  // JSON: { section, heading, page, entities, ... }
  position        Int      // Order within document
  tokenCount      Int
  createdAt       DateTime @default(now())

  document        Document      @relation(fields: [documentId], references: [id], onDelete: Cascade)
  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id])

  @@index([knowledgeBaseId])
  @@index([documentId])
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM STAGES
// ═══════════════════════════════════════════════════════════════

model CustomStage {
  id              String   @id @default(cuid())
  searchProjectId String
  name            String
  type            String   // 'connector' | 'extraction' | 'enrichment' | 'retrieval'
  description     String?
  configSchema    String?  // JSON Schema for stage configuration
  currentVersion  String   @default("1.0.0")
  status          String   @default("draft")  // 'draft' | 'active' | 'deprecated'
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  searchProject   SearchProject @relation(fields: [searchProjectId], references: [id])
  versions        CustomStageVersion[]
  connectors      Connector[]            // Custom connectors using this stage

  @@unique([searchProjectId, name])
  @@index([searchProjectId])
}

model CustomStageVersion {
  id            String   @id @default(cuid())
  customStageId String
  version       String   // Semver: '1.0.0', '1.0.1', etc.
  code          String   // TypeScript source code
  codeHash      String   // SHA-256 for dedup
  status        String   @default("active")  // 'active' | 'superseded' | 'failed'
  createdBy     String
  changelog     String?
  createdAt     DateTime @default(now())

  customStage   CustomStage @relation(fields: [customStageId], references: [id])

  @@unique([customStageId, version])
  @@index([customStageId])
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE DEFINITIONS
// ═══════════════════════════════════════════════════════════════

model ExtractionPipeline {
  id              String   @id @default(cuid())
  searchProjectId String
  name            String
  stages          String   // JSON array of stage configs (name, version, config)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  searchProject   SearchProject @relation(fields: [searchProjectId], references: [id])

  @@index([searchProjectId])
}

model EnrichmentPipeline {
  id              String   @id @default(cuid())
  searchProjectId String
  name            String
  stages          String   // JSON array of stage configs
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  searchProject   SearchProject @relation(fields: [searchProjectId], references: [id])

  @@index([searchProjectId])
}

model RetrievalPipeline {
  id              String   @id @default(cuid())
  knowledgeBaseId String
  name            String
  stages          String   // JSON array: [queryRewrite, vectorSearch, fulltextSearch, merge, rerank]
  rerankModel     String?  // e.g. 'cross-encoder/ms-marco-MiniLM-L-6-v2'
  topK            Int      @default(5)
  scoreThreshold  Float?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id])

  @@index([knowledgeBaseId])
}

// ═══════════════════════════════════════════════════════════════
// EVALUATION
// ═══════════════════════════════════════════════════════════════

model EvalSet {
  id              String   @id @default(cuid())
  knowledgeBaseId String
  name            String
  queries         String   // JSON array of { query, expectedChunkIds, expectedDocumentUrls, grade }
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([knowledgeBaseId])
}

model EvalRun {
  id                  String   @id @default(cuid())
  evalSetId           String
  knowledgeBaseId     String
  retrievalPipelineId String?
  configSnapshot      String   // JSON: frozen pipeline config at time of run
  results             String   // JSON: { mrr, ndcg5, recall10, precision5, perQuery: [...] }
  createdBy           String
  createdAt           DateTime @default(now())

  @@index([evalSetId])
  @@index([knowledgeBaseId])
}

// ═══════════════════════════════════════════════════════════════
// LINK TABLE: Agent Platform <-> Search AI
// ═══════════════════════════════════════════════════════════════

model ProjectKnowledgeBase {
  id                  String   @id @default(cuid())
  projectId           String   // -> Project (agent platform)
  knowledgeBaseId     String   // -> KnowledgeBase (search AI)
  alias               String   // Name used in agent DSL (e.g. "product-docs")
  retrievalPipelineId String?  // Optional override for retrieval strategy
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  project             Project       @relation(fields: [projectId], references: [id])
  knowledgeBase       KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id])

  @@unique([projectId, alias])
  @@unique([projectId, knowledgeBaseId])
  @@index([projectId])
}
```

---

## 21. Phased Delivery Plan

| Phase                          | Scope                                                                                                | Deliverable                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **P1: Foundation**             | `search-ai` scaffold, Prisma models, Admin CRUD API, `search-ai-sdk` types, `StageHandler` interface | Skeleton service on port 3003 with data model and stage interface |
| **P2: Stage Runtime**          | Stage registry, pipeline executor, stage sandbox (Worker threads), `search_test_stage` MCP tool      | Can register and test custom stages in isolation                  |
| **P3: First Connector**        | Web crawler connector, document parser, basic chunking, pgvector index, `search_test_connector`      | End-to-end: crawl a site -> chunks -> vector search               |
| **P4: MCP Tool Surface**       | Full MCP server with 40+ tools, Claude Code integration                                              | Claude Code can configure everything programmatically             |
| **P5: Studio UI**              | Search AI nav section, connector config, KB management, pipeline editor, sync monitor                | Admins can configure and monitor via Studio                       |
| **P6: Agent Integration**      | `KNOWLEDGE`/`SEARCH` DSL syntax, compiler support, runtime SearchService                             | Agents can declare and search KBs in DSL                          |
| **P7: KB Picker**              | `KBPickerDialog` in agent editor, `ProjectKnowledgeBase` linking                                     | Agent developers can visually link KBs to projects                |
| **P8: Retrieval Quality**      | Hybrid retrieval, reranking, query rewriting, citation tracking                                      | Production-quality search results                                 |
| **P9: Eval & Tuning**          | Eval framework, A/B comparison, quality metrics, `search_suggest_improvements`                       | Systematic retrieval optimization via tools and UI                |
| **P10: Enterprise Connectors** | Confluence, Salesforce, ServiceNow connectors                                                        | Enterprise content sources                                        |
| **P11: Custom Stage IDE**      | Monaco-based stage editor in Studio, inline testing, version history                                 | Visual custom stage development                                   |
| **P12: Advanced Indexing**     | Graph index, enrichment pipelines, LLM extraction stages                                             | Knowledge graph, entity-aware retrieval                           |

Working end-to-end slice (crawl -> index -> agent searches) achieved by **P6**. AI-driven configuration loop complete by **P4**. Full visual + programmatic experience by **P11**.

---

## Appendix: Summary Table

| Entity                   | Role                                                  | Mental Model              |
| ------------------------ | ----------------------------------------------------- | ------------------------- |
| **SearchProject**        | Workspace for search infra (tenant-scoped)            | "A search workspace"      |
| **Connector**            | How to fetch from a source (built-in or custom)       | "A database connection"   |
| **KnowledgeBase**        | What agents search against                            | "A searchable collection" |
| **ConnectorBinding**     | Routes content from connector to KB                   | "An ETL mapping"          |
| **Document**             | One tracked item from a source                        | "A source record"         |
| **Chunk**                | One searchable unit within a document                 | "A search index entry"    |
| **CustomStage**          | User-defined pipeline component                       | "A stored procedure"      |
| **StageHandler**         | Universal interface all stages implement              | "The plugin contract"     |
| **EvalSet**              | Query + expected result pairs for quality measurement | "A test suite"            |
| **ProjectKnowledgeBase** | Maps a KB into an agent project with an alias         | "An import statement"     |

**The mental model: Connectors fetch. Bindings route. Stages process. KBs index. Agents search. Tools tune.**
