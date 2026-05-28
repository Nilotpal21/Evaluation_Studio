# SearchAI Architecture - Quick Reference

> A 10-minute guide to understanding what needs to be built

**Source:** `docs/searchai/rfcs/RFC-FUTURE-ARCHITECTURE.md` (future design proposal)
**Last Updated:** 2026-02-16

> ⚠️ **Note:** This summarizes a future design proposal, not current implementation

---

## Design Proposals Summary

### 1. Two Products, One Platform

**Proposal:** SearchAI and Agent Platform are independent products sharing infrastructure
**Rationale:** Separate development teams, release cycles, and architectures while sharing auth, tenancy, billing, and observability
**Key Decisions:**

- Separate services: Agent Runtime (port 3002) and Search Engine (port 3003)
- Unified Studio UI with separate nav sections
- Single monorepo with path-based CI/CD triggers
- Thin versioned contract via `@agent-platform/search-sdk`
- Independent release trains with joint review for contract changes

### 2. Everything is a Stage

**Proposal:** Universal `StageHandler` interface for all pipeline components
**Rationale:** Makes built-in and custom stages interchangeable, composable, testable
**Key Decisions:**

- All connectors, extractors, enrichers, and retrievers implement `StageHandler`
- Same interface for built-in and custom stages
- Stages can be tested in isolation without full pipeline
- Dynamic hot-reload from database without restart
- Versioning with automatic rollback on failure

### 3. Everything is Testable in Isolation

**Proposal:** Every component runnable standalone with sample input
**Rationale:** Enables rapid iteration, AI-assisted development, no need for full deployment to test
**Key Decisions:**

- `search_test_stage` - test single stage with sample input
- `search_test_connector` - fetch N docs without indexing
- `search_test_pipeline` - run pipeline with per-stage output capture
- `search_query_debug` - run query with score breakdown
- Test mode captures metrics, logs, and intermediate outputs

### 4. Everything is Configurable via Tools

**Proposal:** MCP tools as primary configuration interface
**Rationale:** Claude Code and Studio UI use same tools, enables AI-assisted configuration
**Key Decisions:**

- 40+ MCP tools for all operations
- Studio UI built on same tools (proxy routes)
- Claude Code can do everything UI can do, plus write custom stages
- Programmatic automation and tuning loops
- Same tools for testing, deployment, and monitoring

### 5. Custom Code Execution Sandbox

**Proposal:** User-uploaded TypeScript stages in V8 Isolates
**Rationale:** Extensibility without compromising security in multi-tenant environment
**Key Decisions:**

- Worker threads with V8 Isolates for execution
- Static analysis and optional approval workflow
- Resource limits: timeout (60s default, 300s max), memory (256MB default, 1GB max)
- Blocked imports (fs, net, child_process, eval)
- Tenant-scoped services (LLM, storage, cache, fetch)
- Credentials never exposed to custom code (injected by egress proxy)

### 6. Many-to-Many Connector-KB Relationship

**Proposal:** `ConnectorBinding` entity routes content from connectors to KBs with filters
**Rationale:** One connector can feed multiple KBs, one KB can aggregate multiple connectors
**Key Decisions:**

- Connector: where to fetch (source configuration)
- KnowledgeBase: what to search (agent-facing collection)
- ConnectorBinding: routing logic with filters (labels, spaces, types)
- Same source content can be filtered differently for different KBs
- Agent sees KB alias, never knows which connectors feed it

### 7. Incremental Sync with Change Detection

**Proposal:** Content hash-based change detection, cursor-based incremental sync
**Rationale:** Avoid re-processing unchanged content, support large datasets efficiently
**Key Decisions:**

- SHA-256 hash computed on fetch
- Skip unchanged documents entirely
- Re-extract and re-index only changed documents
- Cursor stored per `ConnectorBinding` for incremental sync
- Webhook support for push updates from sources

### 8. Multi-Index Hybrid Retrieval

**Status:** ⚠️ Partially Implemented (Vector Only)

**Proposal:** Vector, full-text, and graph indexes with configurable fusion
**Rationale:** Different query types need different retrieval strategies

**Implementation Status:**

| Component       | Status             | Notes                                         |
| --------------- | ------------------ | --------------------------------------------- |
| Vector index    | ✅ Implemented     | OpenSearch k-NN (primary), Qdrant (supported) |
| Full-text index | 🚧 Planned Q2 2026 | BM25 via OpenSearch text analyzer             |
| Graph index     | ⚠️ Partial         | Neo4j storage complete, REST API pending      |
| RRF fusion      | 🚧 Planned Q2 2026 | Requires BM25 + graph APIs first              |
| Reranking       | 🚧 Planned Q2 2026 | Cohere cross-encoder stub exists              |

**Current API:**

- `POST /api/search/:indexId/query?queryType=vector` — Works ✅
- `POST /api/search/:indexId/query?queryType=hybrid` — Falls back to vector-only ⚠️

**Note:** The `hybrid` queryType parameter is accepted but currently performs vector-only search. The `hybridAlpha` parameter is ignored. True hybrid search (vector + BM25) will be implemented in Phase 2.

**Design Details:**

- Vector: [RETRIEVAL-API.md](./RETRIEVAL-API.md) (implemented)
- Hybrid: [QUERY-PIPELINE-NEXT-STEPS.md](./QUERY-PIPELINE-NEXT-STEPS.md) (item #2: True RRF Fusion)
- Graph: [dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md](./dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md) (planned)
- Reranking: Implemented — see [QUERY-PIPELINE-DESIGN.md](./design/QUERY-PIPELINE-DESIGN.md) (Scene 14)

### 9. Pipeline-Based Architecture

**Proposal:** Extraction, enrichment, and retrieval as configurable pipelines
**Rationale:** Flexible composition of stages, easy to customize and tune
**Key Decisions:**

- Extraction pipeline: parse, chunk, extract metadata
- Enrichment pipeline: embeddings, entities, classification, LLM stages
- Retrieval pipeline: query rewrite, multi-index search, rerank, assemble
- Pipelines defined as ordered lists of stage references
- Per-KB pipeline configuration
- BullMQ for async job processing

### 10. AI-Driven Tuning Loop

**Proposal:** Eval framework with A/B comparison and AI suggestions
**Rationale:** Systematic quality improvement with minimal manual work
**Key Decisions:**

- EvalSet: query + expected results pairs
- Metrics: MRR, NDCG@5, Recall@10, Precision@5
- A/B config comparison with per-query breakdown
- `search_suggest_improvements` - AI analysis of quality gaps
- Claude Code can automate tuning experiments
- Studio UI shows eval dashboards and comparison charts

### 11. Hot Configuration and Live Reload

**Proposal:** Configuration changes apply without restart
**Rationale:** Rapid iteration, no downtime for config changes
**Key Decisions:**

- Pipeline changes: immediate on next run
- Custom stage updates: new version loaded on next invocation
- Retrieval config: immediate on next query
- KB settings requiring re-index: marked for re-index
- Stage Registry checks DB version on each run
- Automatic fallback to previous version on failure

### 12. Layered Security Model

**Proposal:** Six-layer defense-in-depth for custom code execution
**Rationale:** Multiple layers catch different threat vectors
**Key Decisions:**

- L1 Code Admission: Static analysis, approval workflow
- L2 Execution Sandbox: V8 Isolates, blocked APIs, resource limits
- L3 Tenant Isolation: Scoped services, query-level tenantId
- L4 Network Controls: Egress proxy, domain allowlist, mTLS
- L5 Credential Lifecycle: KMS encryption, JIT decryption, proxy injection
- L6 Audit & Compliance: Immutable logs, SIEM integration, retention policies

### 13. Agent DSL Integration

**Proposal:** `KNOWLEDGE` and `SEARCH` constructs in ABL
**Rationale:** Declarative agent-KB linking with compile-time validation
**Key Decisions:**

- `KNOWLEDGE` block declares KBs by alias
- `SEARCH` step queries KBs with query expression
- Compiler validates aliases against `ProjectKnowledgeBase`
- IR includes resolved `knowledgeBaseId`
- Runtime injects search results into LLM context
- Studio KB picker for visual linking

### 14. Same-Monorepo Development

**Proposal:** SearchAI and Agent Platform in same monorepo
**Rationale:** Shared Prisma schema, auth middleware, atomic cross-cutting changes
**Key Decisions:**

- Separate directories: `apps/search-engine/`, `apps/studio/src/app/(search)/`
- Shared packages: `@agent-platform/shared`, `@agent-platform/search-sdk`
- Turborepo with path-based caching
- Joint review for `search-sdk` and Prisma schema changes
- Independent work otherwise

---

## Linear Action Items by Phase

### Phase 1 (P1): Foundation

**Goal:** Establish service skeleton, data model, and stage interface

**Action Items:**

1. [ ] Create `apps/search-engine/` directory structure
2. [ ] Set up Express/Fastify server on port 3003
3. [ ] Create `packages/search-sdk/` package
4. [ ] Define `StageHandler`, `StageContext` interfaces in search-sdk
5. [ ] Define `SearchRequest`, `SearchResponse`, `KnowledgeBaseSummary` types
6. [ ] Add SearchAI Prisma models to `packages/database/prisma/schema.prisma`
   - SearchProject
   - Connector
   - KnowledgeBase
   - ConnectorBinding
   - Document
   - Chunk
   - CustomStage
   - CustomStageVersion
   - ExtractionPipeline
   - EnrichmentPipeline
   - RetrievalPipeline
   - EvalSet
   - EvalRun
   - ProjectKnowledgeBase
7. [ ] Run Prisma migration to create tables
8. [ ] Create Admin CRUD API routes for connectors, KBs, pipelines
9. [ ] Add tenant middleware (reuse from agent platform)
10. [ ] Add health check and status endpoints
11. [ ] Update workspace config to include search-engine
12. [ ] Write basic integration tests for API

**Deliverable:** Skeleton service on port 3003 with data model and stage interface

---

### Phase 2 (P2): Stage Runtime

**Goal:** Enable custom stage registration, loading, and testing

**Action Items:**

1. [ ] Implement `StageRegistry` class
   - Load built-in stages from filesystem
   - Load custom stages from database
   - Version tracking and caching
2. [ ] Implement `StageLoader` for dynamic imports
   - Load TypeScript code from DB
   - Compile and cache in memory
   - Handle import restrictions
3. [ ] Implement `StageSandbox` using Worker threads
   - Create isolated V8 context
   - Inject scoped services (logger, metrics)
   - Enforce timeout and memory limits
   - Capture console output
4. [ ] Implement `PipelineExecutor`
   - Run stages in sequence
   - Pass output to next stage input
   - Collect per-stage metrics
5. [ ] Implement `PipelineTester` (test mode variant)
   - Capture intermediate outputs
   - Return detailed execution trace
6. [ ] Create static analyzer for custom code
   - Detect blocked imports (fs, net, child_process, eval)
   - Check for obvious security issues
   - Return warnings and errors
7. [ ] Implement MCP tool: `search_register_stage`
   - Accept name, version, type, code, configSchema
   - Run static analysis
   - Store in CustomStage + CustomStageVersion
8. [ ] Implement MCP tool: `search_update_stage`
   - Create new version
   - Update currentVersion
   - Support rollback to previous version
9. [ ] Implement MCP tool: `search_test_stage`
   - Load stage from registry
   - Run in sandbox with sample input
   - Return output, metrics, logs, warnings
10. [ ] Write tests for stage lifecycle
11. [ ] Document stage development workflow

**Deliverable:** Can register and test custom stages in isolation

---

### Phase 3 (P3): First Connector

**Goal:** End-to-end content ingestion and search

**Action Items:**

1. [ ] Implement `WebCrawlerConnector` stage
   - Accept URL, depth, filters
   - Use headless browser (Playwright/Puppeteer)
   - Respect robots.txt
   - Parse sitemap.xml
   - Return RawDocument[]
2. [ ] Implement `DocumentParser` extraction stage
   - Detect content type (HTML, PDF, DOCX, Markdown)
   - Convert to plain text
   - Extract basic metadata (title, date, author)
3. [ ] Implement `FixedChunker` extraction stage
   - Split text into fixed-size chunks
   - Support overlap parameter
   - Preserve sentence boundaries
4. [ ] Implement `MetadataExtractor` extraction stage
   - Extract dates, authors, categories from content
   - Store in chunk metadata
5. [ ] Implement `EmbeddingGenerator` enrichment stage
   - Call OpenAI embedding API (text-embedding-3-small)
   - Generate vectors for each chunk
   - Store in Chunk.embedding
6. [ ] Set up pgvector extension in Postgres
   - Create vector column on Chunk table
   - Create HNSW or IVFFlat index
7. [ ] Implement `VectorSearch` retrieval stage
   - Embed query
   - Cosine similarity search
   - Return top K chunks with scores
8. [ ] Implement connector sync workflow
   - Fetch content via connector
   - Apply ConnectorBinding filters
   - Create Document records
   - Queue extraction pipeline jobs (BullMQ)
9. [ ] Implement BullMQ workers for extraction and enrichment
10. [ ] Implement Search API endpoint: `POST /api/v1/search`
    - Accept SearchRequest
    - Run retrieval pipeline
    - Return SearchResponse with results and citations
11. [ ] Implement MCP tool: `search_test_connector`
    - Run connector with limit parameter
    - Return sample documents without indexing
12. [ ] Implement MCP tool: `search_sync_connector`
    - Trigger full or incremental sync
    - Return sync job ID
13. [ ] Write end-to-end test: crawl site -> index -> search
14. [ ] Document connector development

**Deliverable:** End-to-end: crawl a site -> chunks -> vector search

---

### Phase 4 (P4): MCP Tool Surface

**Goal:** Complete programmatic control via Claude Code

**Action Items:**

1. [ ] Create `apps/search-engine/src/mcp/` directory
2. [ ] Implement MCP server setup (stdio transport)
3. [ ] Implement discovery tools:
   - `search_list_projects`
   - `search_get_project`
   - `search_list_kbs`
   - `search_get_kb_stats`
   - `search_list_stages`
   - `search_get_stage_schema`
4. [ ] Implement connector tools:
   - `search_create_connector`
   - `search_update_connector`
   - `search_test_connection`
   - `search_list_scopes`
   - `search_get_sync_status`
5. [ ] Implement KB tools:
   - `search_create_kb`
   - `search_update_kb`
   - `search_create_binding`
   - `search_update_binding`
   - `search_reindex_kb`
   - `search_get_index_stats`
6. [ ] Implement pipeline tools:
   - `search_create_pipeline`
   - `search_update_pipeline`
   - `search_get_pipeline`
   - `search_test_pipeline`
   - `search_deploy_pipeline`
7. [ ] Implement search tools:
   - `search_query`
   - `search_query_debug`
   - `search_test_retrieval`
8. [ ] Implement indexing tools:
   - `search_index_document`
   - `search_index_batch`
   - `search_delete_document`
9. [ ] Implement custom stage tools:
   - `search_get_stage_logs`
   - `search_list_custom_stages`
10. [ ] Write tool documentation (embedded in MCP server)
11. [ ] Add MCP server to `.claude/mcp_servers.json` example
12. [ ] Test Claude Code integration end-to-end
13. [ ] Document MCP workflows for common tasks

**Deliverable:** Claude Code can configure everything programmatically

---

### Phase 5 (P5): Studio UI

**Goal:** Visual configuration and monitoring interface

**Action Items:**

1. [ ] Create `apps/studio/src/app/(search)/` route group
2. [ ] Add "SEARCH AI" nav section with items:
   - Sources (connectors)
   - KBs (knowledge bases)
   - Pipes (pipelines)
   - Stages (custom stages)
   - Tuning (eval/quality)
   - Monitor (sync status, metrics)
3. [ ] Create connector management UI:
   - List connectors with status
   - Create/edit connector form
   - Test connection button
   - Sync trigger and progress monitor
4. [ ] Create KB management UI:
   - List KBs with doc/chunk counts
   - Create/edit KB form (name, chunking, embedding model)
   - Binding configuration (link connectors with filters)
   - Index configuration (vector, fulltext, graph toggles)
   - Re-index trigger
5. [ ] Create pipeline editor UI:
   - Drag-and-drop stage list
   - Stage configuration forms (generated from JSON Schema)
   - Test pipeline button with per-stage output view
   - Deploy pipeline button
6. [ ] Create sync monitor UI:
   - Real-time sync progress (polling or SSE)
   - Job queue status
   - Error logs and retry buttons
7. [ ] Create search test UI:
   - Query input
   - KB selector
   - Strategy selector (vector, fulltext, hybrid, auto)
   - Results with scores and citations
   - Debug mode with score breakdown
8. [ ] Implement proxy API routes in Studio:
   - `/api/search/*` routes proxy to Search Engine
   - Add auth context (tenantId from JWT)
9. [ ] Add shared components:
   - StageCard (displays stage with config)
   - PipelineVisualization (flowchart)
   - MetricsChart (sync/query metrics over time)
10. [ ] Write Studio UI tests (E2E with Playwright)
11. [ ] Document Studio workflows

**Deliverable:** Admins can configure and monitor via Studio

---

### Phase 6 (P6): Agent Integration

**Goal:** Agents can declare and search KBs in DSL

**Action Items:**

1. [ ] Add `KNOWLEDGE` syntax to ABL parser (`packages/core/`)
   - Parse KB declarations with alias, strategy, top_k
   - Add to Agent AST
2. [ ] Add `SEARCH` syntax to ABL parser
   - Parse SEARCH step with KB alias and query expression
   - Support single KB or array of KBs
   - Support STORE clause for result variable
3. [ ] Update compiler to handle KNOWLEDGE block
   - Validate KB aliases exist in ProjectKnowledgeBase
   - Resolve aliases to knowledgeBaseId
   - Add resolved IDs to AgentIR
4. [ ] Update compiler to handle SEARCH step
   - Compile to `search` action node in IR
   - Include resolved KB IDs, strategy, top_k
   - Include query expression and result variable
5. [ ] Implement `SearchService` in Agent Runtime
   - Wrap `SearchClient` from search-sdk
   - Handle alias resolution (ProjectKnowledgeBase lookup)
   - Support single and multi-KB searches
   - Merge and deduplicate results
6. [ ] Update `ConstructExecutor` to handle `search` action
   - Call SearchService.search()
   - Inject results into agent context
   - Format citations for LLM
7. [ ] Update `ProjectKnowledgeBase` CRUD in runtime
   - Create link (projectId, knowledgeBaseId, alias)
   - List links for project
   - Delete link
8. [ ] Add agent integration tests
   - Mock SearchClient
   - Test KNOWLEDGE parsing and compilation
   - Test SEARCH execution with result injection
9. [ ] Update ABL_SPEC.md with KNOWLEDGE/SEARCH documentation
10. [ ] Create example agents using KNOWLEDGE/SEARCH

**Deliverable:** Agents can declare and search KBs in DSL

---

### Phase 7 (P7): KB Picker

**Goal:** Visual KB linking in agent editor

**Action Items:**

1. [ ] Create `KBPickerDialog` component in Studio
   - List all KBs from SearchProject for current tenant
   - Show KB name, description, doc count, index types
   - Search/filter KBs
   - Select KB and set alias
   - Configure retrieval strategy and top_k
2. [ ] Add "Knowledge" tab to Agent editor
   - Show linked KBs as list
   - "Link Knowledge Base" button opens KBPickerDialog
   - Edit/remove KB links
3. [ ] Update agent editor to sync KB links with DSL
   - When KB link added, update KNOWLEDGE block in DSL
   - When DSL KNOWLEDGE block edited, update links in DB
   - Bidirectional sync
4. [ ] Add API routes for KB picker:
   - GET /api/search/knowledge-bases (list all KBs for tenant)
   - GET /api/agents/:agentId/knowledge-bases (list linked KBs)
   - POST /api/agents/:agentId/knowledge-bases (link KB)
   - DELETE /api/agents/:agentId/knowledge-bases/:linkId (unlink)
5. [ ] Write UI tests for KB picker
6. [ ] Document KB linking workflow

**Deliverable:** Agent developers can visually link KBs to projects

---

### Phase 8 (P8): Retrieval Quality

**Goal:** Production-quality search results

**Action Items:**

1. [ ] Implement `FullTextSearch` retrieval stage
   - BM25 scoring using Postgres tsvector
   - OR: integrate Typesense for better full-text
   - Return top K chunks with scores
2. [ ] Implement `RRFMerger` retrieval stage
   - Reciprocal Rank Fusion of vector + fulltext results
   - Configurable weights
   - Deduplicate by chunk ID
3. [ ] Implement `CrossEncoderReranker` retrieval stage
   - Load cross-encoder model (e.g., ms-marco-MiniLM-L-6-v2)
   - Re-score top N candidates (e.g., top 20)
   - Return re-ranked top K
4. [ ] Implement `LLMReranker` retrieval stage (alternative to cross-encoder)
   - Call LLM to score relevance of each chunk
   - Re-rank by LLM scores
   - More expensive but more accurate
5. [ ] Implement `QueryRewriter` retrieval stage
   - Expand acronyms
   - Add synonyms
   - Simplify complex queries
   - Use LLM for rewrite
6. [ ] Implement `ContextAssembler` retrieval stage
   - Deduplicate chunks
   - Order by score
   - Truncate to token budget
   - Attach citations (document title, URL, section)
7. [ ] Create default retrieval pipeline configs
   - Simple: vector only
   - Hybrid: vector + fulltext + RRF
   - Advanced: hybrid + query rewrite + reranker
8. [ ] Implement citation tracking
   - Preserve source document info in chunks
   - Include in SearchResponse
   - Format for LLM context
9. [ ] Add retrieval metrics tracking
   - Latency per stage
   - Token counts
   - Index usage
10. [ ] Write retrieval quality tests
11. [ ] Document retrieval strategies and tuning

**Deliverable:** Production-quality search results

---

### Phase 9 (P9): Eval & Tuning

**Goal:** Systematic retrieval optimization

**Action Items:**

1. [ ] Implement eval framework:
   - EvalSet model (queries + expected results)
   - EvalRun model (results snapshot)
   - Metrics calculator (MRR, NDCG@5, Recall@10, Precision@5)
2. [ ] Implement `EvalRunner` service
   - Run queries against KB
   - Compare results to expected
   - Compute metrics
   - Store EvalRun with config snapshot
3. [ ] Implement `ConfigComparator` service
   - Run same eval set on two configs (A/B)
   - Compare metrics side-by-side
   - Show per-query improvements/regressions
4. [ ] Implement MCP tools:
   - `search_create_eval_set`
   - `search_run_eval`
   - `search_compare_configs`
   - `search_get_metrics`
   - `search_tune_retrieval` (adjust weights, thresholds)
   - `search_suggest_improvements` (AI analysis)
5. [ ] Implement AI suggestion engine
   - Analyze eval results
   - Identify common failure patterns
   - Suggest config changes (add reranker, adjust chunk size, etc.)
   - Estimate impact on metrics
6. [ ] Create tuning UI in Studio:
   - Upload or create eval sets
   - Run baseline eval
   - Show metrics dashboard (MRR, NDCG, etc.)
   - A/B comparison charts
   - Suggestion panel
   - Deploy winning config
7. [ ] Add retrieval tuning workflow documentation
8. [ ] Create example eval sets for common domains

**Deliverable:** Systematic retrieval optimization via tools and UI

---

### Phase 10 (P10): Enterprise Connectors

**Goal:** Support major enterprise content sources

**Action Items:**

1. [ ] Implement `ConfluenceConnector` stage
   - Confluence REST API integration
   - OAuth2 authentication
   - Space and label filters
   - Incremental sync via change log
   - Webhook support for push updates
   - Attachment download (PDF, DOCX)
2. [ ] Implement `SalesforceConnector` stage
   - Salesforce Bulk API and Streaming API
   - OAuth2 authentication
   - Knowledge Article object support
   - Custom object support (configurable)
   - Incremental sync via date filters
3. [ ] Implement `ServiceNowConnector` stage
   - ServiceNow Table API
   - OAuth2 or basic auth
   - Knowledge base article fetching
   - Attachment download
   - Incremental sync via sys_updated_on
4. [ ] Implement `S3Connector` stage
   - AWS S3 bucket scanning
   - IAM role or access key auth
   - Prefix filters
   - S3 event notifications for incremental updates
   - Support for common file types (PDF, DOCX, TXT, CSV, JSON)
5. [ ] Implement `GoogleDriveConnector` stage
   - Google Drive API integration
   - OAuth2 authentication
   - Folder filters
   - Incremental sync via change log
   - Support for Docs, Sheets, Slides export
6. [ ] Add credential management:
   - Encrypted storage (KMS, AES-256-GCM)
   - Per-connector credential types
   - OAuth2 flow in Studio
   - Credential rotation support
7. [ ] Create connector configuration wizards in Studio
   - Guided setup for each connector type
   - Test connection step
   - Scope selection (spaces, folders, buckets)
   - Schedule configuration
8. [ ] Write connector integration tests (with mocks)
9. [ ] Document each connector's capabilities and config

**Deliverable:** Enterprise content sources supported

---

### Phase 11 (P11): Custom Stage IDE

**Goal:** Visual custom stage development in Studio

**Action Items:**

1. [ ] Integrate Monaco editor into Studio
   - TypeScript syntax highlighting
   - IntelliSense for search-sdk types
   - Import `@agent-platform/search-sdk` types
2. [ ] Create `StageCodeEditor` component
   - Monaco editor with TypeScript
   - Template selection (connector, extraction, enrichment, retrieval)
   - Config schema editor (JSON Schema)
   - Test button (calls search_test_stage)
   - Output/metrics/logs panel
   - Save and register button
3. [ ] Create custom stage management UI:
   - List custom stages with versions
   - Create new stage button
   - Edit stage (opens StageCodeEditor)
   - Test inline with sample data
   - Version history and rollback
   - Approval workflow UI (if enabled)
4. [ ] Add stage templates:
   - Basic connector template
   - Basic extraction template
   - LLM-powered enrichment template
   - Reranker template
5. [ ] Implement inline testing:
   - Sample input selection (from recent documents/chunks)
   - One-click test execution
   - Real-time output display
   - Iteration without leaving editor
6. [ ] Add stage approval workflow UI (if security policy enabled):
   - Pending approvals list
   - Code diff view
   - Static analysis results display
   - Approve/reject buttons with notes
7. [ ] Write custom stage IDE tests
8. [ ] Document custom stage development in Studio

**Deliverable:** Visual custom stage development

---

### Phase 12 (P12): Advanced Indexing

**Goal:** Knowledge graph and entity-aware retrieval

**Action Items:**

1. [ ] Implement graph index support:
   - Choose graph DB (Neo4j or Postgres with graph extension)
   - Define graph schema (Document -> Entity, Entity -> Entity)
   - Create graph sync pipeline
2. [ ] Implement `EntityResolver` enrichment stage
   - Extract entities from chunks (LLM or NER model)
   - Deduplicate entities across documents
   - Create Entity nodes in graph
   - Link chunks to entities
3. [ ] Implement `RelationshipBuilder` enrichment stage
   - Extract relationships between entities (LLM)
   - Create edges in graph
   - Store relationship metadata
4. [ ] Implement `LLMExtractor` extraction stage (generic)
   - Configurable extraction schema
   - Call LLM to extract structured data from content
   - Store in chunk metadata
5. [ ] Implement `LLMSummarizer` enrichment stage
   - Generate chunk summaries via LLM
   - Store in chunk metadata
   - Use for retrieval (query against summaries)
6. [ ] Implement `LLMQuestionGenerator` enrichment stage
   - Generate hypothetical questions per chunk
   - Store in chunk metadata
   - Improve retrieval recall
7. [ ] Implement `GraphTraversal` retrieval stage
   - Start from top vector/fulltext results
   - Traverse graph to find related entities
   - Return expanded result set
   - Useful for "tell me about X and related products"
8. [ ] Implement `Classifier` enrichment stage
   - Auto-tag chunks by topic/domain
   - Train classifier or use zero-shot
   - Store tags in chunk metadata
9. [ ] Update retrieval pipeline to support graph
   - Add graph traversal as optional stage
   - Merge graph results with vector/fulltext
10. [ ] Create advanced pipeline templates:
    - Full enrichment (entities, relationships, summaries, questions)
    - Graph-augmented retrieval
    - Multi-modal indexing (text + images via CLIP)
11. [ ] Write advanced indexing tests
12. [ ] Document graph indexing and entity-aware retrieval

**Deliverable:** Knowledge graph, entity-aware retrieval

---

## Critical Design Elements

### Core Entities

| Entity                   | Purpose                                                    | Analogy                 |
| ------------------------ | ---------------------------------------------------------- | ----------------------- |
| **SearchProject**        | Tenant-scoped workspace for search infrastructure          | "A search workspace"    |
| **Connector**            | Fetches content from a source (built-in or custom)         | "A database connection" |
| **KnowledgeBase**        | Searchable collection that agents query                    | "A database table"      |
| **ConnectorBinding**     | Routes content from connector to KB with filters           | "An ETL mapping"        |
| **Document**             | One tracked item from a source                             | "A source record"       |
| **Chunk**                | One searchable unit within a document                      | "A search index entry"  |
| **CustomStage**          | User-defined pipeline component                            | "A stored procedure"    |
| **StageHandler**         | Universal interface all stages implement                   | "The plugin contract"   |
| **Pipeline**             | Ordered list of stages for extraction/enrichment/retrieval | "A data pipeline"       |
| **EvalSet**              | Query + expected result pairs for quality measurement      | "A test suite"          |
| **ProjectKnowledgeBase** | Links KB to agent project with alias                       | "An import statement"   |

**Mental Model:** Connectors fetch. Bindings route. Stages process. KBs index. Agents search. Tools tune.

---

### Technology Stack

**Backend:**

- Express/Fastify (Search Engine service)
- Prisma (ORM, shared schema)
- BullMQ (async job queue)
- Worker threads + V8 Isolates (custom stage execution)

**Indexing:**

- pgvector (vector search, embeddings)
- Postgres tsvector or Typesense (full-text search, BM25)
- Neo4j or Postgres graph extension (entity-relationship graph)

**LLM & Embeddings:**

- OpenAI API (text-embedding-3-small, text-embedding-3-large)
- Anthropic API (Claude for LLM stages, reranking, suggestions)

**Storage:**

- Postgres (metadata, documents, chunks)
- S3/MinIO (object storage for large documents)
- Redis (cache, rate limiting)

**Security:**

- KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault) for credential encryption
- V8 Isolates for sandboxing
- mTLS for inter-service communication

**Frontend:**

- Next.js (Studio UI)
- Monaco (code editor for custom stages)
- React (components)

**Extensibility:**

- MCP (Model Context Protocol) for tool surface
- TypeScript SDK for custom stages (`@agent-platform/search-sdk`)

---

### Integration Points

**Agent Platform ↔ SearchAI:**

1. **Runtime Query** (Agent → SearchAI)
   - Agent Runtime calls SearchClient.search()
   - REST API: `POST /api/v1/search`
   - Contract: `@agent-platform/search-sdk` types
   - Tenant isolation via JWT tenantId

2. **Configuration** (Studio → SearchAI)
   - Studio UI proxies to Search Engine Admin API
   - MCP tools for programmatic access
   - Same auth context (tenant, user)

3. **KB Linking** (Agent ↔ SearchAI)
   - ProjectKnowledgeBase link table
   - Agent DSL references KB by alias
   - Compiler resolves alias to knowledgeBaseId
   - Studio KB picker for visual linking

4. **Shared Infrastructure:**
   - Prisma schema (same DB, separate models)
   - Auth middleware (tenant extraction from JWT)
   - Billing (usage tracking for embeddings, LLM calls)
   - Observability (shared logging, metrics, tracing)

**Claude Code ↔ SearchAI:**

- MCP tool surface (40+ tools)
- Stdio or HTTP transport
- Same operations as Studio UI
- Can write custom stages, run experiments, automate tuning

**External Sources ↔ SearchAI:**

- Connectors (built-in and custom)
- Pull: scheduled sync, incremental cursor
- Push: webhooks for real-time updates
- Credentials stored encrypted (KMS)

---

## Key Workflows

### 1. Configure a Knowledge Base (Search Admin)

```
1. Create Connector (Confluence, web crawler, S3, custom)
2. Test Connection (verify credentials and access)
3. Create Knowledge Base (name, chunking strategy, embedding model)
4. Create Binding (link connector to KB with filters)
5. Trigger Initial Sync (starts extraction pipeline)
6. Monitor Sync Progress (Studio Monitor or search_get_sync_status)
7. Test Search (search_query_debug with sample query)
```

### 2. Write a Custom Stage (Developer or Claude Code)

```
1. Choose stage type (connector, extraction, enrichment, retrieval)
2. Write TypeScript implementing StageHandler interface
3. Test stage with sample input (search_test_stage)
4. Iterate on code until output is correct
5. Register stage (search_register_stage or Studio IDE)
6. Add stage to pipeline (search_update_pipeline)
7. Re-index content if needed (search_reindex_kb)
8. Verify in production (search_query_debug)
```

### 3. Tune Retrieval Quality (AI-Assisted)

```
1. Create eval set (query + expected results)
2. Run baseline eval (search_run_eval)
3. See metrics (MRR, NDCG) and identify gaps
4. Get AI suggestions (search_suggest_improvements)
5. Try recommended changes (add reranker, adjust weights)
6. Run A/B comparison (search_compare_configs)
7. Deploy winning config (search_update_pipeline + search_deploy_pipeline)
8. Monitor query metrics over time (search_get_metrics)
```

### 4. Link KB to Agent (Agent Developer)

```
1. Open Agent Editor in Studio
2. Go to Knowledge tab
3. Click "Link Knowledge Base"
4. Select KB from picker (shows all tenant KBs)
5. Set alias (e.g., "product-docs")
6. Choose strategy (vector, fulltext, hybrid, auto)
7. Save (updates ProjectKnowledgeBase + KNOWLEDGE block in DSL)
8. Use in SEARCH step: SEARCH product-docs WITH {{query}}
```

### 5. Agent Searches KB (Runtime)

```
1. Agent execution hits SEARCH step
2. Executor calls SearchService.search()
3. Resolve alias to knowledgeBaseId (ProjectKnowledgeBase lookup)
4. HTTP POST to Search Engine /api/v1/search
5. Search Engine runs retrieval pipeline:
   - Query rewrite
   - Vector search (embed query, cosine similarity)
   - Full-text search (BM25)
   - Merge (RRF)
   - Rerank (cross-encoder)
   - Assemble (context + citations)
6. Return SearchResponse to agent
7. Inject results into LLM context
8. LLM generates answer with citations
```

---

## Security Architecture Summary

| Layer                        | What It Protects                     | Mechanism                                                    |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| **L1: Code Admission**       | Prevent malicious code from entering | Static analysis, approval workflow, import restrictions      |
| **L2: Execution Sandbox**    | Isolate custom code from host        | V8 Isolates, blocked APIs, resource limits (timeout, memory) |
| **L3: Tenant Isolation**     | Prevent cross-tenant data access     | Scoped services, query-level tenantId, namespace isolation   |
| **L4: Network Controls**     | Block internal network access        | Egress proxy, domain allowlist, mTLS between services        |
| **L5: Credential Lifecycle** | Protect credentials from theft       | KMS encryption, JIT decryption, proxy-injected auth          |
| **L6: Audit & Compliance**   | Detect and respond to incidents      | Immutable audit logs, real-time alerts, SIEM integration     |

**Resource Quotas:**

- Max custom stages per tenant: 50 (default)
- Stage timeout: 60s (default), 300s (max)
- Stage memory: 256MB (default), 1GB (max)
- Max documents per KB: 100,000 (default)
- Max LLM tokens per month: 10M (default)
- Query rate limit: 600/min (default)

---

## Release Strategy

**Independent Release Trains:**

- Agent Platform team ships compiler, runtime, agent DSL independently
- SearchAI team ships search-engine, connectors, pipelines independently

**Joint Review Required:**

- `@agent-platform/search-sdk` type changes (semver: additive = minor, breaking = major)
- Prisma schema changes (migrations coordinated)
- Shared middleware and infrastructure

**Custom Stages:**

- Deployed at runtime (not part of release train)
- Versioned per-tenant in database
- Hot-reloadable without restart

**CI/CD:**

- Monorepo CI with path-based triggers
- `apps/search-engine/**` only runs search tests
- Both teams merge to main, coordinate releases

---

## Success Metrics

**P6 (Agent Integration):**

- End-to-end working: web crawler → extraction → indexing → agent searches
- Agent can declare KB in DSL and get search results

**P4 (MCP Tools):**

- Claude Code can configure KB, test stages, and run queries programmatically
- AI-driven configuration loop complete

**P11 (Custom Stage IDE):**

- Visual custom stage development in Studio
- Inline testing with real data
- Full visual + programmatic experience

**Production Readiness (P12):**

- Enterprise connectors (Confluence, Salesforce, ServiceNow)
- Production-quality retrieval (hybrid, reranking, citations)
- Eval framework for systematic tuning
- Security layers in place (sandbox, audit, encryption)
- Multi-tenant isolation verified
- Graph indexing and entity-aware retrieval

---

## FAQ

**Q: Why separate SearchAI from Agent Platform?**
A: Different development pace, different concerns (ingestion vs. execution), independent release cycles. But share infrastructure for efficiency.

**Q: Why custom stages instead of just configuring built-in ones?**
A: Real-world content sources are wildly diverse. Custom stages enable adaptation to unique formats, APIs, and extraction logic without waiting for platform updates.

**Q: Why MCP tools as primary interface?**
A: AI-assisted configuration is the future. MCP makes Claude Code a first-class developer. Studio UI is built on the same tools.

**Q: Why V8 Isolates instead of Docker containers?**
A: Lower overhead, faster startup, better multi-tenancy. Container-per-stage is too expensive. Isolates provide sufficient isolation for TypeScript code.

**Q: Why not Lambda/Cloud Functions for custom stages?**
A: Cold start latency, cost at scale, complexity. Worker threads + isolates give sub-second execution with full control.

**Q: How does this handle billions of documents?**
A: Vector indexes (HNSW, IVFFlat) scale to millions per KB. Multiple KBs for sharding. Graph indexes optional. Full-text uses Postgres/Typesense which handle large datasets.

**Q: What if a custom stage breaks?**
A: Automatic fallback to previous version. Pipeline continues with last known good stage. Audit log records failure for investigation.

**Q: How do agents handle multiple KBs?**
A: Agent can search one KB per SEARCH step, or fan-out to multiple KBs and merge results. Conditional routing based on intent classification.

---

**Next Steps:**

1. Review this document with team
2. Prioritize phases based on business needs
3. Start with P1 (Foundation) - scaffold and data model
4. Build incrementally, testing each phase before moving to next
5. Engage Claude Code for AI-assisted development starting at P2

**Estimated Timeline:**

- P1-P3: 4-6 weeks (foundation, stage runtime, first connector)
- P4-P6: 4-6 weeks (MCP tools, Studio UI, agent integration)
- P7-P9: 3-4 weeks (KB picker, retrieval quality, eval/tuning)
- P10-P12: 4-6 weeks (enterprise connectors, custom stage IDE, advanced indexing)

**Total:** 15-22 weeks for full system (can ship incrementally after P6)
