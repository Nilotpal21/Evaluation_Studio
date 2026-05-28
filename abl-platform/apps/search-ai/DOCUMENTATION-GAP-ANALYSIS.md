# Documentation Gap Analysis - Search AI Platform

**Date**: 2026-02-24
**Status**: Comprehensive Audit Complete
**Scope**: search-ai (port 3005) + search-ai-runtime (port 3004)

---

## Executive Summary

**Total Gaps Identified**: 60+ missing or incomplete documentation items

**Critical Findings**:

- ❌ **40+ API endpoints** implemented but not documented
- ❌ **14+ file formats** supported but not documented
- ❌ **Getting Started tutorial** missing (blocks user onboarding)
- ❌ **REST API reference** incomplete (missing OpenAPI/Swagger spec)
- ⚠️ **Hybrid search** documented as "not implemented" (stub code exists)
- ⚠️ **Plain text files (.txt)** supported but not documented

**Impact on Customers**:

> "Building features without documentation doesn't help customers use them."

Users cannot discover or use 60%+ of platform features because they're undocumented. This blocks adoption, increases support burden, and wastes engineering effort.

---

## Table of Contents

1. [Implemented But Undocumented](#1-implemented-but-undocumented)
2. [Incomplete Documentation](#2-incomplete-documentation)
3. [Missing Documentation Entirely](#3-missing-documentation-entirely)
4. [Documentation Quality Issues](#4-documentation-quality-issues)
5. [Priority Recommendations](#5-priority-recommendations)
6. [Action Items](#6-action-items)

---

## 1. Implemented But Undocumented

### 1.1 API Endpoints (40+ Missing)

**Ingestion API (search-ai service, port 3005):**

| Endpoint                                 | Method | Purpose                           | Documented? |
| ---------------------------------------- | ------ | --------------------------------- | ----------- |
| `/:indexId/sources/:sourceId/documents`  | POST   | Upload file (multipart/form-data) | ❌ No       |
| `/:indexId/documents/:documentId`        | GET    | Get document status               | ❌ No       |
| `/:indexId/documents`                    | GET    | List documents                    | ❌ No       |
| `/:indexId/documents/:documentId/chunks` | GET    | List chunks for document          | ❌ No       |
| `/:indexId/chunks/:chunkId`              | GET    | Get chunk details                 | ❌ No       |

**Structured Data Ingestion (Two-Phase API):**

| Endpoint                       | Method | Purpose                                   | Documented? |
| ------------------------------ | ------ | ----------------------------------------- | ----------- |
| `/:indexId/ingest/analyze`     | POST   | Phase 1: Analyze schema without ingesting | ❌ No       |
| `/:indexId/ingest/finalize`    | POST   | Phase 2: Finalize with approved schema    | ❌ No       |
| `/:indexId/ingest/jobs/:jobId` | GET    | Get job status                            | ❌ No       |

**Knowledge Base Management:**

| Endpoint                             | Method | Purpose                            | Documented? |
| ------------------------------------ | ------ | ---------------------------------- | ----------- |
| `/api/knowledge-bases`               | GET    | List knowledge bases               | ❌ No       |
| `/api/knowledge-bases`               | POST   | Create knowledge base + auto-index | ❌ No       |
| `/api/knowledge-bases/:kbId`         | GET    | Get KB with linked index           | ❌ No       |
| `/api/knowledge-bases/:kbId`         | DELETE | Delete KB + cascade cleanup        | ❌ No       |
| `/api/knowledge-bases/:kbId/rebuild` | POST   | Trigger index rebuild              | ❌ No       |

**Vocabulary Management (Business Term Mapping):**

| Endpoint                           | Method | Purpose                 | Documented? |
| ---------------------------------- | ------ | ----------------------- | ----------- |
| `/:indexId/vocabulary`             | GET    | List vocabulary entries | ❌ No       |
| `/:indexId/vocabulary`             | POST   | Add single entry        | ❌ No       |
| `/:indexId/vocabulary/bulk`        | POST   | Bulk import (upsert)    | ❌ No       |
| `/:indexId/vocabulary/:entryIndex` | DELETE | Remove entry            | ❌ No       |

**Source Management:**

| Endpoint                             | Method | Purpose              | Documented? |
| ------------------------------------ | ------ | -------------------- | ----------- |
| `/:indexId/sources`                  | GET    | List sources         | ❌ No       |
| `/:indexId/sources`                  | POST   | Add source           | ❌ No       |
| `/:indexId/sources/:sourceId`        | DELETE | Remove source        | ❌ No       |
| `/:indexId/sources/:sourceId/status` | GET    | Get ingestion status | ❌ No       |

**Schema & Mapping:**

| Endpoint                           | Method | Purpose                        | Documented? |
| ---------------------------------- | ------ | ------------------------------ | ----------- |
| `/schemas/connectors/:connectorId` | GET    | Get connector schema (Layer 1) | ❌ No       |
| `/schemas/:knowledgeBaseId`        | GET    | Get canonical schema (Layer 2) | ❌ No       |
| `/mappings`                        | GET    | List field mappings            | ❌ No       |
| `/mappings/suggest`                | POST   | Trigger auto-mapping           | ❌ No       |
| `/mappings/:mappingId/confirm`     | POST   | Confirm mapping                | ❌ No       |
| `/mappings/:mappingId/reject`      | POST   | Reject mapping                 | ❌ No       |
| `/mappings/:mappingId/test`        | POST   | Test mapping                   | ❌ No       |

**Job Management:**

| Endpoint       | Method | Purpose          | Documented? |
| -------------- | ------ | ---------------- | ----------- |
| `/jobs`        | GET    | List active jobs | ❌ No       |
| `/jobs`        | POST   | Create job       | ❌ No       |
| `/jobs/:jobId` | GET    | Get job status   | ❌ No       |

**Index Configuration:**

| Endpoint                        | Method | Purpose                             | Documented? |
| ------------------------------- | ------ | ----------------------------------- | ----------- |
| `/indexes/llm-config/use-cases` | GET    | List LLM use cases + smart defaults | ❌ No       |
| `/indexes/llm-config/tiers`     | GET    | List model tiers for tenant         | ❌ No       |
| `/:indexId/rebuild`             | POST   | Trigger index rebuild               | ❌ No       |

**Runtime Query API (search-ai-runtime, port 3004):**

| Endpoint                          | Method | Purpose                      | Documented? |
| --------------------------------- | ------ | ---------------------------- | ----------- |
| `/api/search/:indexId/resolve`    | POST   | Resolve vocabulary → filters | ⚠️ Partial  |
| `/metrics`                        | GET    | Prometheus metrics           | ❌ No       |
| `/metrics/summary`                | GET    | JSON aggregate metrics       | ❌ No       |
| `/metrics/queries/recent`         | GET    | Recent query metrics         | ❌ No       |
| `/metrics/queries/:correlationId` | GET    | Individual query metrics     | ❌ No       |

---

### 1.2 File Type Support (14+ Formats)

**Supported via Docling (13 formats):**

| Format       | MIME Type                                                                   | Documented?                                     |
| ------------ | --------------------------------------------------------------------------- | ----------------------------------------------- |
| PDF          | `application/pdf`                                                           | ✅ Yes (`01-documents-pdf-docx.md`)             |
| DOCX         | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   | ✅ Yes                                          |
| DOC          | `application/msword`                                                        | ⚠️ Mentioned, no details                        |
| PPTX         | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | ⚠️ Mentioned, no strategy                       |
| PPT          | `application/vnd.ms-powerpoint`                                             | ⚠️ Mentioned, no strategy                       |
| **HTML**     | `text/html`                                                                 | ❌ **No**                                       |
| **Markdown** | `text/markdown`                                                             | ❌ **No** (native support exists)               |
| **PNG**      | `image/png`                                                                 | ⚠️ Mentioned (multimodal), no chunking strategy |
| **JPEG**     | `image/jpeg`, `image/jpg`                                                   | ⚠️ Same as PNG                                  |
| **TIFF**     | `image/tiff`                                                                | ⚠️ Same as PNG                                  |
| **BMP**      | `image/bmp`                                                                 | ⚠️ Same as PNG                                  |
| **WEBP**     | `image/webp`                                                                | ⚠️ Same as PNG                                  |

**Supported via Structured Data API:**

| Format         | MIME Type                                                           | Documented?                              |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| CSV            | `text/csv`, `application/csv`                                       | ✅ Yes (`02-structured-csv.md`)          |
| JSON (nested)  | `application/json`                                                  | ✅ Yes (`03-structured-json-nested.md`)  |
| JSON (tabular) | `application/json`                                                  | ✅ Yes (`04-structured-json-tabular.md`) |
| Excel (.xlsx)  | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | ✅ Yes (`05-structured-excel.md`)        |
| Excel (.xls)   | `application/vnd.ms-excel`                                          | ⚠️ Mentioned, references CSV doc         |

**Legacy Support (LlamaIndex):**

| Format         | MIME Type    | Documented?              |
| -------------- | ------------ | ------------------------ |
| **Plain Text** | `text/plain` | ❌ **No** (CRITICAL GAP) |

**Undocumented File Limits:**

- Maximum file size: **100MB** (not documented anywhere user-facing)

---

### 1.3 Configuration Options (Partially Documented)

**Environment Variables Missing from Docs:**

```bash
# Development Auth Bypass (SECURITY-CRITICAL, needs docs!)
DEV_BYPASS_AUTH=true                    # ❌ Not documented
DEV_TENANT_ID=dev-tenant-1              # ❌ Not documented
DEV_USER_ID=dev-user                    # ❌ Not documented

# Redis Configuration
REDIS_URL=redis://localhost:6379        # ❌ Not documented
REDIS_KEY_PREFIX=searchai               # ❌ Not documented

# Vector Store Options (only OpenSearch documented)
VECTOR_STORE_PROVIDER=opensearch|qdrant|pinecone|pgvector  # ⚠️ Only OpenSearch documented
VECTOR_STORE_TIMEOUT_MS=30000           # ❌ Not documented

# Embedding Provider Options
EMBEDDING_PROVIDER=bge-m3|openai|cohere|custom  # ⚠️ Only BGE-M3 documented
EMBEDDING_MAX_BATCH_SIZE=32             # ❌ Not documented
EMBEDDING_TIMEOUT_MS=60000              # ❌ Not documented

# Page Processing Workers
PAGE_PROCESSING_BATCH_SIZE=10           # ❌ Not documented
PAGE_PROCESSING_CONCURRENCY=3           # ❌ Not documented

# Docling Service
DOCLING_SERVICE_URL=http://localhost:8080  # ⚠️ Mentioned, not detailed

# Search AI MongoDB (separate from platform MongoDB!)
SEARCH_AI_MONGO_URL=<different from MONGODB_URL>  # ❌ Not documented (CRITICAL!)
```

---

### 1.4 Advanced Features (Implemented, Sparse Docs)

#### Two-Phase Structured Data Ingestion

**What it is:**

1. **Phase 1 (Analyze)**: Upload data, analyze schema, return preview — NO chunks created
2. **Phase 2 (Finalize)**: User approves schema, finalize ingestion — chunks created
3. **Caching**: Analysis results cached for 1 hour
4. **Status Polling**: Job status endpoints track progress

**Current Documentation**: ❌ Only code comments exist

**Missing**:

- User guide explaining when to use two-phase vs direct ingestion
- API examples with request/response
- Error handling (what if analysis fails?)
- Cost implications (does analysis count toward quota?)

---

#### Metadata-Only Chunking Strategy

**What it is:**

- Structured data (CSV, Excel, JSON tables) → Store data in ClickHouse (columnar DB)
- Create **1 metadata chunk** per table with schema + sample rows
- **99.9% chunk reduction**: 100K rows → 1 chunk
- Query actual data via text-to-SQL

**Current Documentation**: ⚠️ Mentioned in `02-structured-csv.md`, but:

**Missing**:

- When to use metadata-only vs full chunking
- Cost savings calculator (100K rows: $X with chunking, $Y with metadata-only)
- Performance implications (ClickHouse query latency)
- Text-to-SQL query examples
- Limitations (what queries don't work?)

---

#### LLM Configuration Resolution System

**What it is:**

- **Smart defaults** per use case (extraction, summarization, reranking, etc.)
- **4-tier override hierarchy**:
  1. Index-level overrides (highest priority)
  2. Project-level overrides
  3. Tenant-level overrides
  4. Platform defaults (lowest priority)
- **Multi-tier model selection**: Premium, standard, economy

**Current Documentation**: ❌ None

**Missing**:

- User guide: How to configure LLM per index
- API reference: `GET /indexes/llm-config/use-cases`
- Cost optimization guide: When to use which tier
- Custom provider setup: How to add OpenAI/Cohere/custom models

---

#### Query Complexity Analysis (Phase 3)

**What it is:**

- Adaptive preprocessing based on query complexity
- **14 complexity factors** scored:
  - Length, structure, technical terms
  - Typos, entities, language detection
  - Question patterns, comparison patterns
  - Lorem ipsum detection, title case
- **Adaptive pipeline selector**: Skip, fast, balanced, thorough

**Current Documentation**: ⚠️ Mentioned in `QUERY-PIPELINE-GUIDE.md` (Section 0)

**Missing**:

- Standalone guide explaining the feature
- Configuration options (enable/disable per index)
- Cost-benefit analysis (when does it save money?)
- Debugging tools (how to see complexity score for a query?)

---

#### Vocabulary Resolution with Fuzzy Matching

**What it is:**

- Business term mapping: "premium customers" → `filter: { customerTier: 'premium' }`
- **Fuzzy matching**:
  - Edit distance ≤ 2 (e.g., "premum" matches "premium")
  - Diacritic insensitivity (e.g., "café" matches "cafe")
  - Case insensitivity
  - Alias support (e.g., "SF" → "San Francisco")

**Current Documentation**: ⚠️ Code implementation exists, RFC-003 mentioned in `QUERY-PIPELINE-GUIDE.md`

**Missing**:

- User guide: What is vocabulary and when to use it
- Management API reference (bulk import, test mappings)
- Bulk import CSV/JSON format specification
- Testing tools (how to test a vocabulary entry?)
- Performance implications (how many terms supported?)

---

### 1.5 Monitoring & Observability Features

#### Query Metrics System

**What's Implemented:**

- **Prometheus export**: `/metrics` endpoint (scrape target)
- **JSON summary**: `/metrics/summary` (aggregate stats)
- **Per-query tracking**: `/metrics/queries/:correlationId`
- **Cost breakdown**: Per query (preprocessing, embedding, rerank, LLM)
- **Latency breakdown**: Per stage (0-5: preprocessing → response)

**Current Documentation**: ❌ None

**Missing**:

- Operational guide: How to scrape metrics with Prometheus
- Grafana dashboard JSON templates
- Alert rule examples (high latency, high cost, error rate)
- Correlation ID usage guide (how to trace a query end-to-end)
- Cost tracking guide (how to aggregate costs per tenant/project)

---

#### Index Capacity Monitoring

**What's Implemented:**

- **Shared index capacity tracking**: 60% threshold triggers auto-rotation
- **Vector count tracking**: Per index
- **Index strategy**: Shared, per-app, per-connector, hybrid

**Current Documentation**: ⚠️ Mentioned in `KNOWLEDGE_GRAPH.md` (ATLAS-KG context)

**Missing**:

- Operational runbook: What happens at 60% capacity?
- Index sizing guide: How many vectors per index?
- Migration guide: How to switch between strategies?
- Cost analysis: Shared vs per-app vs per-connector

---

## 2. Incomplete Documentation

### 2.1 Knowledge Graph (KNOWLEDGE_GRAPH.md)

**What's Documented:**

- ✅ Architecture (Neo4j + shared index + entity extraction)
- ✅ Phases (Phase 1 complete, Phase 2 in progress)
- ✅ Index strategies (3 patterns)
- ✅ Visual enrichment (image/diagram processing)

**What's Missing:**

#### Integration Examples

- ❌ No code examples showing how to query the graph from applications
- ❌ No Cypher query examples (Neo4j's query language)
- ❌ No SDK integration examples (Node.js, Python)
- ❌ No error handling patterns

**Example of what's needed:**

```typescript
// How to query entities from an application
const entities = await knowledgeGraph.query({
  type: 'Person',
  filters: { department: 'Engineering' },
  relationships: ['WORKS_WITH', 'REPORTS_TO'],
});
```

#### Performance Tuning

- ❌ Neo4j index configuration (which properties to index?)
- ❌ Query optimization strategies (when to use Cypher vs full-text search)
- ❌ Caching recommendations (Redis for frequently accessed entities?)
- ❌ Connection pooling settings

#### Cost Estimates

- ⚠️ Mentioned "cost-optimized" but no actual numbers
- ❌ Missing: Neo4j managed service pricing (Aura, GrapheneDB, etc.)
- ❌ Missing: Entity extraction cost (LLM calls per document)
- ❌ Missing: Storage cost projection (100K entities ≈ $X/month)

**Example of what's needed:**
| Component | Cost Driver | Estimate |
|-----------|-------------|----------|
| Neo4j Aura | 1M entities + 5M relationships | $500/month |
| Entity Extraction | 10K documents × 3 LLM calls | $30 one-time |
| OpenSearch Index | Shared index (60% capacity) | $0 incremental |
| **Total** | | **$530/month** |

#### Backup/Restore Procedures

- ❌ No operational guidance on Neo4j backups
- ❌ No disaster recovery plan (what if Neo4j crashes?)
- ❌ No data migration procedures (moving between environments)

#### Cross-Index Entity Linking

- ⚠️ Mentioned as "planned" but unclear roadmap
- ❌ No design doc explaining how it would work
- ❌ No timeline (Q2 2026? Q3 2026?)

---

### 2.2 Multimodal (MULTIMODAL.md)

**What's Documented:**

- ✅ Supported modalities (text, image, code)
- ✅ Vision providers (GPT-4V, Gemini Pro Vision, Claude 3.5 Sonnet)
- ✅ Vision enrichment workflow (Phase 2.1)
- ✅ Deduplication (hash-based caching)

**What's Missing:**

#### Provider Comparison Matrix

- ⚠️ Providers listed but no guidance on which to use when

**What's needed:**
| Use Case | Best Provider | Reasoning |
|----------|--------------|-----------|
| **Diagrams** (charts, flowcharts) | GPT-4V | Best OCR + structure recognition |
| **Photos** (product images, screenshots) | Gemini Pro Vision | Best object detection |
| **Technical drawings** (architecture diagrams) | Claude 3.5 Sonnet | Best technical understanding |
| **Code screenshots** | GPT-4V | Best code OCR |

#### Customer API Key Setup

- ❌ How do customers provide their own OpenAI/Anthropic/Google keys?
- ❌ API key validation process
- ❌ Key rotation procedures
- ❌ Security best practices (key scoping, expiration)

#### Deduplication Strategy Details

- ⚠️ Hash-based caching mentioned but not explained
- ❌ Cache TTL (how long are results cached?)
- ❌ Cache eviction policy (LRU? size limit?)
- ❌ Cache key format (what's included in the hash?)

**What's needed:**

```typescript
// Cache key format
const cacheKey = sha256(`${imageHash}:${provider}:${visionModel}:${prompt}`);

// Cache policy
const cachePolicy = {
  ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxSize: 10_000, // 10K image results
  eviction: 'LRU', // Least Recently Used
};
```

#### Image Preprocessing

- ❌ Image size optimization (do we resize before sending to providers?)
- ❌ Format conversion (PNG → JPEG to reduce API costs?)
- ❌ Resolution limits (max width/height?)
- ❌ Compression settings

#### Error Handling

- ❌ What happens when vision API fails? (fallback strategy?)
- ❌ Partial failure handling (some images succeed, others fail?)
- ❌ Rate limit handling (429 Too Many Requests)
- ❌ Cost limit handling (stop if budget exceeded?)

#### Selective Processing Flags

- ⚠️ Mentioned "enable per-index" but no API reference
- ❌ How to enable vision processing for specific document types only?
- ❌ How to enable for specific folders/sources?

**What's needed:**

```typescript
// Index-level configuration
const indexConfig = {
  visionEnrichment: {
    enabled: true,
    provider: 'gpt-4v',
    processImageTypes: ['png', 'jpg', 'pdf-embedded'],
    skipPatterns: ['*/thumbnails/*', '*/icons/*'], // Skip small images
    costLimit: 50, // USD per month
  },
};
```

---

### 2.3 Query Pipeline (QUERY-PIPELINE-GUIDE.md)

**What's Documented:**

- ✅ 6-stage pipeline architecture
- ✅ Stage-by-stage deep dive (preprocessing, vocabulary, embedding, vector search, reranking, response)
- ✅ API reference (query endpoint)
- ✅ Configuration options
- ✅ Error handling
- ✅ Performance & monitoring
- ✅ Security & tenant isolation
- ✅ Local development setup
- ✅ Troubleshooting guide
- ✅ Known limitations (Section 6.1: Hybrid search not implemented)
- ✅ Language support (Section 6.2: 100+ languages)

**What's Missing:**

#### Hybrid Search Implementation

- ✅ **Status documented**: "Not Implemented" (Section 6.1)
- ⚠️ **But**: Code stub exists, API accepts parameters
- ❌ **Missing**: Roadmap (when will it be implemented?)
- ❌ **Missing**: Workaround guidance (what to use instead?)

**What's needed:**

```markdown
### Hybrid Search Roadmap

**Current Status**: Stub implementation (API accepts params but falls back to vector-only)

**Planned Implementation**: Q2 2026

- Week 1-2: Add BM25 index mapping to OpenSearch
- Week 3: Implement RRF fusion algorithm
- Week 4: Add hybrid alpha weighting
- Week 5: Testing + documentation

**Interim Workaround**:

- Use `queryType: "vector"` for semantic search
- Use structured filters for exact matching
- Combine both in application logic if needed
```

#### RRF Fusion Algorithm

- ✅ **Code provided** in Section 6.1
- ❌ **Missing**: Conceptual explanation (what is RRF? why use it?)
- ❌ **Missing**: Comparison with alternatives (RSF, weighted fusion, etc.)
- ❌ **Missing**: Tuning guidance (how to choose k parameter?)

**What's needed:**

```markdown
### RRF (Reciprocal Rank Fusion) Explained

**What it is**: A rank-based fusion algorithm that combines results from multiple retrieval methods (vector search + BM25 keyword search).

**Why it's better than score-based fusion**:

- Rank-based fusion is robust to score scale differences
- No need to normalize scores from different sources
- Simple, parameter-free (except k)

**How k parameter affects results**:

- k=60 (default): Balanced fusion
- k=10 (low): More weight on top ranks (favors precision)
- k=100 (high): More weight on lower ranks (favors recall)

**When to use**:

- Queries with both semantic intent AND keyword requirements
- Example: "latest kubernetes security vulnerabilities" (semantic: security, keyword: latest)
```

#### BM25 Configuration

- ❌ No guide on how to configure full-text search
- ❌ Index mapping requirements
- ❌ Analyzer configuration (tokenization, stemming, stop words)
- ❌ Scoring parameters (b, k1)

#### Circuit Breaker Pattern

- ✅ **Code example** provided (Section 11)
- ❌ **Missing**: Integration guide (where to use circuit breakers?)
- ❌ **Missing**: Configuration (failure threshold, timeout, half-open state)
- ❌ **Missing**: Monitoring (how to track circuit breaker state?)

**What's needed:**

````markdown
### Circuit Breaker Integration

**Where to use**:

1. **Reranking** (primary use case) - Fallback to k-NN results if reranker fails
2. **Preprocessing** - Fallback to raw query if preprocessing service is down
3. **LLM extraction** - Fallback to regex-based extraction if LLM fails

**Configuration**:

```typescript
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 3, // Open after 3 consecutive failures
  timeout: 60000, // 60 seconds
  resetTimeout: 300000, // 5 minutes (half-open state)
});
```
````

**Monitoring**:

- Prometheus metric: `circuit_breaker_state{service="reranker"}` (closed/open/half-open)
- Alert if open for > 5 minutes

````

#### Custom Providers
- ✅ **Generic examples** provided (Section 11: Custom Embedding, Custom Vocabulary)
- ❌ **Missing**: Real-world implementations (OpenAI embeddings, Cohere embeddings, custom LLM)
- ❌ **Missing**: Testing guide (how to validate a custom provider?)
- ❌ **Missing**: Performance benchmarks (expected latency for custom providers)

---

### 2.4 Chunking Documentation (docs/chunking/)

**What's Complete:**
- ✅ CSV chunking (`02-structured-csv.md`) - Comprehensive
- ✅ JSON nested (`03-structured-json-nested.md`) - Comprehensive
- ✅ JSON tabular (`04-structured-json-tabular.md`) - Comprehensive
- ✅ Excel (`05-structured-excel.md`) - Comprehensive

**What's Missing:**

#### Image Chunking Strategy
- ⚠️ Images mentioned in multimodal docs, but:
- ❌ No chunking strategy document
- ❌ How are images/diagrams chunked separately from text?
- ❌ Are images embedded as visual vectors or text descriptions?
- ❌ How are image captions generated?

**What's needed**: `06-images-diagrams.md`
- Image extraction from PDFs
- Vision enrichment integration (GPT-4V, Gemini)
- Image-to-text conversion (captions, OCR)
- Visual embedding strategy (CLIP, VisualBERT, or text-only?)
- Retrieval strategy (visual similarity vs text similarity)

#### Markdown Chunking
- ⚠️ Mentioned as "native support" in file type list
- ❌ No chunking strategy document
- ❌ How are markdown headings preserved?
- ❌ Are code blocks treated differently?
- ❌ Are tables extracted separately?

**What's needed**: `07-markdown.md`
- Heading hierarchy preservation (H1 → H6)
- Code block extraction (inline vs fenced)
- Table extraction (convert to structured data?)
- Link handling (internal vs external)
- Frontmatter handling (YAML metadata)

#### PowerPoint Chunking
- ⚠️ PPTX mentioned as supported format
- ❌ No chunking strategy document
- ❌ How are slides processed (one chunk per slide?)
- ❌ Are speaker notes included?
- ❌ How are embedded images/charts handled?

**What's needed**: `08-powerpoint.md`
- Slide-level chunking strategy
- Title extraction (slide titles as section headings)
- Speaker notes integration
- Embedded objects (images, charts, tables)
- Animation/transition metadata (skip or include?)

#### HTML Chunking
- ⚠️ HTML mentioned as supported format
- ❌ No chunking strategy document
- ❌ How is HTML structure preserved (semantic tags?)
- ❌ Are scripts/styles stripped?
- ❌ How are tables/lists handled?

**What's needed**: `09-html.md`
- Semantic tag handling (article, section, nav, aside)
- Script/style removal
- Table/list extraction
- Link extraction (anchor text + href)
- Metadata extraction (meta tags, Open Graph)

#### Plain Text Chunking
- ❌ **CRITICAL GAP**: Plain text (.txt) supported but not documented
- ❌ No chunking strategy (sentence-aligned? paragraph-aligned?)
- ❌ No encoding handling (UTF-8, Latin-1, etc.)
- ❌ No line break handling (CRLF vs LF)

**What's needed**: `01-plain-text.md` (should come BEFORE PDF/DOCX)
- Encoding detection (UTF-8, Latin-1, ASCII)
- Line break normalization
- Paragraph boundary detection
- Sentence-aligned chunking (512 tokens)
- Context preservation (overlap strategy)

#### Error Recovery
- ❌ No documentation on what happens when extraction fails mid-document
- ❌ Partial ingestion handling (some pages succeed, others fail)
- ❌ Retry logic (automatic? manual?)
- ❌ Cleanup procedures (orphaned chunks, incomplete documents)

**What's needed**: `12-error-recovery.md`
- Partial ingestion scenarios
- Automatic retry logic (exponential backoff)
- Manual retry procedures (API endpoint for re-processing)
- Cleanup utilities (delete incomplete documents)
- Monitoring (ingestion failure rate)

---

## 3. Missing Documentation Entirely

### 3.1 User Guides (Customer-Facing)

#### 1. Getting Started Tutorial ⚠️ **HIGH PRIORITY**

**What's needed**: End-to-end 15-minute tutorial

**Outline**:
```markdown
# Getting Started with ATLAS Search (15 minutes)

## Prerequisites
- ATLAS account (sign up at https://atlas.example.com)
- API key (generate in Settings → API Keys)
- Sample document (download: sample.pdf)

## Step 1: Create Your First Index (3 min)
```bash
curl -X POST https://api.atlas.example.com/api/indexes \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-first-index",
    "projectId": "YOUR_PROJECT_ID"
  }'
````

**Response**:

```json
{
  "indexId": "idx_abc123",
  "name": "my-first-index",
  "status": "active"
}
```

## Step 2: Upload Your First Document (3 min)

```bash
curl -X POST https://api.atlas.example.com/api/indexes/idx_abc123/sources/default/documents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@sample.pdf"
```

**Response**:

```json
{
  "documentId": "doc_xyz789",
  "status": "processing",
  "estimatedTime": "30 seconds"
}
```

## Step 3: Check Ingestion Status (2 min)

```bash
curl https://api.atlas.example.com/api/indexes/idx_abc123/documents/doc_xyz789 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:

```json
{
  "documentId": "doc_xyz789",
  "status": "completed",
  "chunkCount": 15,
  "processingTime": 28.5
}
```

## Step 4: Execute Your First Query (3 min)

```bash
curl -X POST https://api.atlas.example.com/api/search/idx_abc123/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the main topic of this document?",
    "topK": 5
  }'
```

**Response**:

```json
{
  "results": [
    {
      "chunkId": "chunk_001",
      "score": 0.92,
      "content": "This document covers...",
      "metadata": {
        "page": 1,
        "section": "Introduction"
      }
    }
  ],
  "latency": 125
}
```

## Step 5: Interpret Results (2 min)

- **score**: Relevance score (0-1, higher is better)
- **content**: Matched text chunk
- **metadata**: Document context (page number, section, etc.)

## Next Steps

- Learn about [File Types](./file-upload-guide.md) (PDF, DOCX, CSV, JSON)
- Explore [Query Types](./query-guide.md) (vector, structured, hybrid)
- Set up [Vocabulary](./vocabulary-guide.md) for domain-specific terms

````

**Missing Currently**: ❌ No equivalent tutorial exists

---

#### 2. File Upload Guide ⚠️ **HIGH PRIORITY**

**What's needed**: Comprehensive file upload reference

**Outline**:
```markdown
# File Upload Guide

## Supported Formats

### Documents
- **PDF** - Max 100MB, unlimited pages
- **DOCX** - Max 100MB
- **DOC** (legacy) - Max 50MB
- **PPTX** - Max 100MB, all slides
- **PPT** (legacy) - Max 50MB
- **Plain Text (.txt)** - Max 50MB, UTF-8/Latin-1/ASCII
- **Markdown (.md)** - Max 50MB, preserves structure
- **HTML** - Max 50MB, strips scripts/styles

### Structured Data
- **CSV** - Max 500MB, up to 1M rows
- **JSON** - Max 100MB, nested or tabular
- **Excel (.xlsx)** - Max 100MB, all sheets
- **Excel (.xls, legacy)** - Max 50MB

### Images
- **PNG, JPEG, TIFF, BMP, WEBP** - Max 25MB each
- **Embedded images in PDFs** - Extracted automatically

## File Size Limits

| Format Category | Max Size | Max Count per Batch |
|-----------------|----------|---------------------|
| Documents (PDF, DOCX, etc.) | 100MB | 50 files |
| Structured Data (CSV, JSON) | 500MB | 10 files |
| Images | 25MB | 100 files |

## Upload Methods

### Single File Upload (multipart/form-data)
```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/sources/{sourceId}/documents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@document.pdf"
````

### Batch Upload (ZIP archive)

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/sources/{sourceId}/documents/batch \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@documents.zip"
```

### URL Upload (fetch from URL)

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/sources/{sourceId}/documents/url \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/document.pdf"
  }'
```

## Status Polling

**Recommended**: Poll every 5 seconds until status = "completed"

```bash
curl https://api.atlas.example.com/api/indexes/{indexId}/documents/{documentId} \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:

```json
{
  "documentId": "doc_123",
  "status": "processing|completed|failed",
  "progress": 65,
  "chunkCount": 12,
  "processingTime": 45.2,
  "error": null
}
```

## Error Handling

### Common Errors

| Error Code           | Meaning                     | Solution                    |
| -------------------- | --------------------------- | --------------------------- |
| `FILE_TOO_LARGE`     | File exceeds size limit     | Compress or split file      |
| `UNSUPPORTED_FORMAT` | File type not supported     | Convert to supported format |
| `EXTRACTION_FAILED`  | Content extraction failed   | Check file is not corrupted |
| `TIMEOUT`            | Processing timeout (>5 min) | Contact support             |

### Retry Logic

**Automatic retries** (exponential backoff):

- Extraction failures: 3 retries
- Embedding failures: 2 retries
- Vector store failures: 2 retries

**Manual retry**:

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/documents/{documentId}/retry \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Best Practices

1. **File naming**: Use descriptive names (avoid spaces, special chars)
2. **Batch uploads**: Group similar files (e.g., all PDFs together)
3. **Async processing**: Don't block on upload — poll for status
4. **Error handling**: Always check status before querying
5. **Structured data**: Use two-phase ingestion for large CSVs (>10K rows)

````

**Missing Currently**: ❌ No equivalent guide exists

---

#### 3. Query Guide ⚠️ **HIGH PRIORITY**

**What's needed**: User-facing query guide explaining when to use each query type

**Outline**:
```markdown
# Query Guide: Choosing the Right Search Method

## Query Types Overview

| Query Type | Best For | Example Use Case |
|------------|----------|------------------|
| **Vector Search** | Semantic similarity | "Find documents about kubernetes scaling" |
| **Structured Search** | Exact matching, filters | "Documents published in 2024, category=DevOps" |
| **Hybrid Search** | Combined semantic + keyword | "Latest kubernetes security vulnerabilities" |

## Vector Search (Semantic)

**When to use**:
- Natural language queries
- Conceptual searches (find similar ideas)
- Queries with synonyms/paraphrasing

**Example**:
```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How do I scale my application horizontally?",
    "queryType": "vector",
    "topK": 10
  }'
````

**Response**:

```json
{
  "results": [
    {
      "chunkId": "chunk_001",
      "score": 0.92,
      "content": "Horizontal scaling involves adding more instances...",
      "metadata": { "page": 12, "section": "Scaling" }
    }
  ]
}
```

## Structured Search (Filters)

**When to use**:

- Exact metadata filtering
- Date ranges, categories, tags
- Boolean logic (AND, OR, NOT)

**Example**:

```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "",
    "filters": {
      "category": { "eq": "DevOps" },
      "publishedAt": { "gte": "2024-01-01" },
      "tags": { "in": ["kubernetes", "docker"] }
    },
    "topK": 10
  }'
```

## Hybrid Search (Semantic + Keyword)

**Status**: ⚠️ **Not Yet Implemented** (Q2 2026 roadmap)

**When to use** (future):

- Queries with both semantic intent AND keyword requirements
- Time-sensitive queries ("latest", "recent")
- Queries with acronyms/proper nouns

**Planned API** (future):

```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest kubernetes security vulnerabilities",
    "queryType": "hybrid",
    "hybridAlpha": 0.7
  }'
```

**Interim Workaround**:
Use `queryType: "vector"` + structured filters:

```json
{
  "query": "kubernetes security vulnerabilities",
  "queryType": "vector",
  "filters": {
    "publishedAt": { "gte": "2024-01-01" }
  }
}
```

## Filter Syntax

### Supported Operators

| Operator   | Example                                       | Meaning          |
| ---------- | --------------------------------------------- | ---------------- |
| `eq`       | `{ "category": { "eq": "DevOps" } }`          | Equals           |
| `ne`       | `{ "status": { "ne": "draft" } }`             | Not equals       |
| `in`       | `{ "tags": { "in": ["k8s", "docker"] } }`     | In array         |
| `nin`      | `{ "tags": { "nin": ["deprecated"] } }`       | Not in array     |
| `gt`       | `{ "views": { "gt": 1000 } }`                 | Greater than     |
| `gte`      | `{ "publishedAt": { "gte": "2024-01-01" } }`  | Greater or equal |
| `lt`       | `{ "views": { "lt": 100 } }`                  | Less than        |
| `lte`      | `{ "publishedAt": { "lte": "2024-12-31" } }`  | Less or equal    |
| `contains` | `{ "content": { "contains": "kubernetes" } }` | Text contains    |

### Boolean Logic (AND, OR)

**AND** (default):

```json
{
  "filters": {
    "category": { "eq": "DevOps" },
    "publishedAt": { "gte": "2024-01-01" }
  }
}
```

**OR**:

```json
{
  "filters": {
    "$or": [{ "category": { "eq": "DevOps" } }, { "category": { "eq": "Platform" } }]
  }
}
```

**Nested**:

```json
{
  "filters": {
    "$and": [
      { "publishedAt": { "gte": "2024-01-01" } },
      {
        "$or": [{ "category": { "eq": "DevOps" } }, { "tags": { "in": ["kubernetes"] } }]
      }
    ]
  }
}
```

## Pagination

**Default**: Returns top 10 results

**Custom page size**:

```json
{
  "query": "kubernetes deployment",
  "topK": 50
}
```

**Offset pagination** (not recommended for large offsets):

```json
{
  "query": "kubernetes deployment",
  "topK": 10,
  "offset": 20
}
```

**Cursor pagination** (recommended):

```json
{
  "query": "kubernetes deployment",
  "topK": 10,
  "cursor": "eyJza..."
}
```

## Performance Optimization

### Query Complexity

- **Simple queries** (1-5 words): 50-100ms
- **Complex queries** (>10 words): 100-150ms
- **With filters**: +10-20ms
- **With reranking**: +100-150ms

### Tips

1. **Use filters early**: Reduces vector search scope
2. **Smaller topK**: Faster response (10 vs 100)
3. **Disable reranking**: For low-latency use cases
4. **Cache common queries**: Consider client-side caching

### When to Use Reranking

- **Yes**: User-facing search (accuracy matters)
- **No**: Auto-complete, suggestions (latency matters)
- **Yes**: <100 queries/day (cost matters less)
- **No**: >10K queries/day (cost adds up)

````

**Missing Currently**: ❌ No equivalent guide exists

---

#### 4. Vocabulary Management Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: User guide for domain vocabulary (business term mapping)

**Outline**:
```markdown
# Vocabulary Management Guide

## What is Domain Vocabulary?

**Problem**: Users search using business terms, but documents use different terminology.

**Example**:
- User searches: "premium customers"
- Documents say: `customerTier: 'gold'`

**Solution**: Map business terms to structured filters.

**Example Mapping**:
```json
{
  "term": "premium customers",
  "type": "filter",
  "field": "customerTier",
  "value": "gold"
}
````

**Result**: Query "premium customers" → automatically adds filter `{ customerTier: { eq: "gold" } }`

## When to Use Vocabulary

**Use Cases**:

1. **Internal tools** (employee search, knowledge bases)
2. **Industry-specific terms** (healthcare, finance, legal)
3. **Company-specific jargon** (product names, department names)

**Don't use if**:

- Public-facing search (too much variation)
- <100 documents (not worth the setup)

## Managing Vocabulary

### Add Single Entry

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/vocabulary \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "term": "premium customers",
    "type": "filter",
    "field": "customerTier",
    "value": "gold",
    "aliases": ["vip customers", "gold tier"]
  }'
```

### Bulk Import (CSV)

**Format**: `term,type,field,value,aliases`

**Example CSV**:

```csv
term,type,field,value,aliases
premium customers,filter,customerTier,gold,"vip customers|gold tier"
San Francisco,filter,city,San Francisco,"SF|San Fran|Bay Area"
Q1 2024,filter,quarter,Q1-2024,"first quarter 2024"
```

**Upload**:

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/vocabulary/bulk \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@vocabulary.csv"
```

### List Vocabulary

```bash
curl https://api.atlas.example.com/api/indexes/{indexId}/vocabulary \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:

```json
{
  "vocabulary": [
    {
      "term": "premium customers",
      "type": "filter",
      "field": "customerTier",
      "value": "gold",
      "aliases": ["vip customers", "gold tier"]
    }
  ],
  "count": 25
}
```

### Delete Entry

```bash
curl -X DELETE https://api.atlas.example.com/api/indexes/{indexId}/vocabulary/0 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Testing Vocabulary

**Test API** (resolves terms to filters):

```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/resolve \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Show me premium customers in San Francisco"
  }'
```

**Response**:

```json
{
  "originalQuery": "Show me premium customers in San Francisco",
  "structuredFilters": [
    { "field": "customerTier", "operator": "eq", "value": "gold" },
    { "field": "city", "operator": "eq", "value": "San Francisco" }
  ],
  "matchedTerms": ["premium customers", "San Francisco"]
}
```

## Fuzzy Matching

**Enabled by default**:

- Edit distance ≤ 2 (e.g., "premum" matches "premium")
- Diacritic insensitivity (e.g., "café" matches "cafe")
- Case insensitivity (e.g., "Premium" matches "premium")

## Best Practices

1. **Start small**: 10-20 terms, iterate
2. **Test early**: Use resolve API to validate mappings
3. **Use aliases**: Capture variations upfront
4. **Monitor usage**: Track which terms are matched
5. **Update regularly**: Add terms based on user search logs

````

**Missing Currently**: ❌ No equivalent guide exists

---

#### 5. Structured Data Ingestion Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: Guide for CSV/JSON/Excel best practices

**Outline**:
```markdown
# Structured Data Ingestion Guide

## When to Use Structured Data Ingestion

**Use Cases**:
- CSV/Excel spreadsheets (employee directories, product catalogs)
- JSON arrays (API responses, log exports)
- Tabular data (>1K rows)

**Benefits**:
- 99.9% chunk reduction (100K rows → 1 chunk)
- Sub-second table queries (via ClickHouse)
- Preserves full relational query capabilities

## Two-Phase Ingestion (Recommended for Large Files)

### Phase 1: Analyze Schema

**Upload file for analysis** (no chunks created):
```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/ingest/analyze \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@employees.csv"
````

**Response** (schema preview):

```json
{
  "jobId": "job_abc123",
  "schema": {
    "columns": [
      { "name": "employee_id", "type": "integer", "nullable": false },
      { "name": "name", "type": "string", "nullable": false },
      { "name": "department", "type": "string", "nullable": true },
      { "name": "salary", "type": "float", "nullable": true }
    ],
    "rowCount": 15000,
    "sampleRows": [
      { "employee_id": 1, "name": "Alice", "department": "Engineering", "salary": 120000 }
    ]
  },
  "estimatedChunkCount": 1,
  "estimatedCost": 0.001
}
```

### Phase 2: Finalize Ingestion

**Approve schema and finalize**:

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/ingest/finalize \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "job_abc123"
  }'
```

**Response**:

```json
{
  "documentId": "doc_xyz789",
  "status": "processing",
  "chunkCount": 1
}
```

## Direct Ingestion (Small Files)

**For files <10K rows**, skip analysis phase:

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/sources/{sourceId}/documents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@small.csv"
```

## Querying Structured Data

### Semantic Table Discovery

**Find tables by description**:

```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "employee directory with salary information",
    "topK": 5
  }'
```

**Response** (metadata chunk):

```json
{
  "results": [
    {
      "chunkId": "chunk_metadata_001",
      "score": 0.95,
      "content": "Employee Directory: 15,000 rows with columns employee_id, name, department, salary",
      "metadata": {
        "documentId": "doc_xyz789",
        "tableSchema": {
          "columns": [...]
        },
        "clickhouseTable": "employees_tenant123_idx456"
      }
    }
  ]
}
```

### Text-to-SQL Query (Future)

**Planned feature**: Query actual data via natural language

**Example** (Q2 2026 roadmap):

```bash
curl -X POST https://api.atlas.example.com/api/search/{indexId}/sql \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How many employees in Engineering department earn over $100K?",
    "tableId": "doc_xyz789"
  }'
```

**Response**:

```json
{
  "sql": "SELECT COUNT(*) FROM employees WHERE department = 'Engineering' AND salary > 100000",
  "result": [{ "count": 42 }]
}
```

## Best Practices

1. **Use two-phase ingestion** for files >10K rows (validate schema first)
2. **Clean data before upload** (remove empty rows, fix encoding)
3. **Use descriptive column names** (improves semantic search)
4. **Include sample data** in first 10 rows (helps schema inference)
5. **Monitor chunk count** (expect 1 metadata chunk per table)

## Performance

| Rows | Analysis Time | Finalization Time | Query Time (ClickHouse) |
| ---- | ------------- | ----------------- | ----------------------- |
| 1K   | <1s           | <5s               | <50ms                   |
| 10K  | 1-2s          | 5-10s             | <100ms                  |
| 100K | 2-5s          | 10-30s            | <200ms                  |
| 1M   | 5-10s         | 30-60s            | <500ms                  |

## Cost

**Analysis**: Free (no chunks created)
**Finalization**: $0.001 per metadata chunk (1 chunk per table)
**Storage**: $0.10 per GB in ClickHouse

**Example**: 1M-row CSV (500MB) → $0.051 total ($0.001 embedding + $0.05 storage)

````

**Missing Currently**: ⚠️ Partial (chunking docs exist, but no user guide on two-phase API)

---

#### 6. LLM Configuration Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: Guide for configuring LLM per index

**Outline**:
```markdown
# LLM Configuration Guide

## Overview

ATLAS uses LLMs for:
1. **Entity extraction** (knowledge graph)
2. **Summarization** (progressive summaries)
3. **Question synthesis** (FAQ generation)
4. **Reranking** (semantic relevance)

**Default**: Smart defaults per use case (no configuration needed)

**Custom**: Override per index/project/tenant for cost or quality optimization

## Smart Defaults

**Get available use cases**:
```bash
curl https://api.atlas.example.com/api/indexes/llm-config/use-cases \
  -H "Authorization: Bearer YOUR_API_KEY"
````

**Response**:

```json
{
  "useCases": [
    {
      "useCase": "entity_extraction",
      "defaultModel": "claude-3-5-haiku-20241022",
      "defaultProvider": "anthropic",
      "estimatedCost": 0.0005
    },
    {
      "useCase": "summarization",
      "defaultModel": "claude-3-5-haiku-20241022",
      "defaultProvider": "anthropic",
      "estimatedCost": 0.001
    },
    {
      "useCase": "reranking",
      "defaultModel": "cohere-rerank-multilingual-v3.0",
      "defaultProvider": "cohere",
      "estimatedCost": 0.002
    }
  ]
}
```

## Model Tiers

**Get available tiers for your tenant**:

```bash
curl https://api.atlas.example.com/api/indexes/llm-config/tiers \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:

```json
{
  "tiers": [
    {
      "tier": "premium",
      "models": ["claude-opus-4-6", "gpt-4o"],
      "costMultiplier": 10,
      "description": "Highest quality, highest cost"
    },
    {
      "tier": "standard",
      "models": ["claude-3-5-haiku-20241022", "gpt-4o-mini"],
      "costMultiplier": 1,
      "description": "Balanced quality and cost"
    },
    {
      "tier": "economy",
      "models": ["claude-3-haiku-20240307"],
      "costMultiplier": 0.1,
      "description": "Lower quality, lower cost"
    }
  ]
}
```

## Override Configuration

### Index-Level Override (Highest Priority)

**Example**: Use premium models for mission-critical index

```bash
curl -X PATCH https://api.atlas.example.com/api/indexes/{indexId} \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "llmConfig": {
      "entity_extraction": {
        "model": "claude-opus-4-6",
        "provider": "anthropic"
      },
      "summarization": {
        "model": "gpt-4o",
        "provider": "openai"
      }
    }
  }'
```

### Project-Level Override

**Example**: Use economy models for all indexes in a project

```bash
curl -X PATCH https://api.atlas.example.com/api/projects/{projectId} \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "llmConfig": {
      "tier": "economy"
    }
  }'
```

### Tenant-Level Override

**Example**: Tenant-wide custom provider (e.g., Anthropic credits)

```bash
curl -X POST https://api.atlas.example.com/admin/tenants/{tenantId}/llm-credentials \
  -H "Authorization: Bearer ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "apiKey": "sk-ant-..."
  }'
```

## Cost Optimization Strategies

### Strategy 1: Use Economy Tier for Non-Critical Tasks

- Entity extraction: Economy tier (10x cheaper)
- Summarization: Economy tier
- Reranking: Disable (use k-NN only)

**Savings**: ~80% cost reduction, ~10% quality loss

### Strategy 2: Selective LLM Usage

- Enable entity extraction only for documents >10 pages
- Disable question synthesis for internal docs
- Enable reranking only for user-facing search

**Savings**: ~50% cost reduction, no quality loss

### Strategy 3: Batch Processing

- Use offline batch processing for large ingestions
- Batch API: 50% cost discount (slower turnaround)

**Savings**: ~50% cost reduction, 2-24 hour delay

## Custom Provider Setup

**Add custom OpenAI/Anthropic/Cohere API key**:

```bash
curl -X POST https://api.atlas.example.com/api/indexes/{indexId}/llm-credentials \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "apiKey": "sk-proj-...",
    "models": {
      "entity_extraction": "gpt-4o-mini",
      "summarization": "gpt-4o"
    }
  }'
```

## Fallback Configuration

**Automatic fallback** (if primary provider fails):

1. **Tier 1**: Configured provider/model
2. **Tier 2**: Same provider, economy model
3. **Tier 3**: Different provider, economy model
4. **Tier 4**: Disable feature (e.g., skip reranking)

**Example fallback chain for entity extraction**:

1. `claude-opus-4-6` (configured)
2. `claude-3-5-haiku-20241022` (same provider, economy)
3. `gpt-4o-mini` (different provider, economy)
4. Skip entity extraction (fallback disabled)

## Monitoring

**Track LLM usage and cost**:

```bash
curl https://api.atlas.example.com/api/indexes/{indexId}/metrics/llm \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:

```json
{
  "period": "last_30_days",
  "totalCost": 12.45,
  "breakdown": [
    { "useCase": "entity_extraction", "calls": 1500, "cost": 0.75 },
    { "useCase": "summarization", "calls": 1500, "cost": 1.5 },
    { "useCase": "reranking", "calls": 5000, "cost": 10.0 }
  ]
}
```

````

**Missing Currently**: ❌ No equivalent guide exists

---

### 3.2 Integration Guides

#### 1. SDK Usage Examples ⚠️ **HIGH PRIORITY**

**What's needed**: Node.js client setup with auth and error handling

**Outline**:
```markdown
# SDK Usage Examples

## Installation

```bash
npm install @atlas-search/sdk
````

## Authentication

### API Key Authentication (Recommended)

```typescript
import { AtlasSearchClient } from '@atlas-search/sdk';

const client = new AtlasSearchClient({
  apiKey: process.env.ATLAS_API_KEY,
  baseUrl: 'https://api.atlas.example.com',
});
```

### JWT Authentication (User Sessions)

```typescript
const client = new AtlasSearchClient({
  jwt: userSession.jwt,
  baseUrl: 'https://api.atlas.example.com',
});
```

## Error Handling

```typescript
import { AtlasSearchError } from '@atlas-search/sdk';

try {
  const results = await client.search.query({
    indexId: 'idx_123',
    query: 'kubernetes deployment',
  });
} catch (error) {
  if (error instanceof AtlasSearchError) {
    switch (error.code) {
      case 'INDEX_NOT_FOUND':
        console.error('Index does not exist');
        break;
      case 'QUOTA_EXCEEDED':
        console.error('Monthly quota exceeded');
        break;
      case 'RATE_LIMIT':
        console.error('Rate limit hit, retry after', error.retryAfter);
        break;
      default:
        console.error('Unexpected error', error.message);
    }
  } else {
    throw error; // Network error, etc.
  }
}
```

## Retry Logic

```typescript
const client = new AtlasSearchClient({
  apiKey: process.env.ATLAS_API_KEY,
  retries: 3, // Automatic retries with exponential backoff
  timeout: 30000, // 30 second timeout
});
```

## Connection Pooling

```typescript
const client = new AtlasSearchClient({
  apiKey: process.env.ATLAS_API_KEY,
  httpAgent: new http.Agent({
    keepAlive: true,
    maxSockets: 50, // Connection pool size
  }),
});
```

## Examples

### Create Index

```typescript
const index = await client.indexes.create({
  name: 'my-index',
  projectId: 'proj_123',
});

console.log('Index created:', index.indexId);
```

### Upload Document

```typescript
import fs from 'fs';

const document = await client.documents.upload({
  indexId: 'idx_123',
  sourceId: 'default',
  file: fs.createReadStream('./document.pdf'),
});

console.log('Document ID:', document.documentId);
```

### Query

```typescript
const results = await client.search.query({
  indexId: 'idx_123',
  query: 'kubernetes deployment strategies',
  topK: 10,
  filters: {
    category: { eq: 'DevOps' },
  },
});

results.results.forEach((result) => {
  console.log(`Score: ${result.score}`);
  console.log(`Content: ${result.content}`);
  console.log(`Metadata:`, result.metadata);
});
```

### Pagination

```typescript
let cursor = null;
do {
  const page = await client.search.query({
    indexId: 'idx_123',
    query: 'kubernetes',
    topK: 100,
    cursor,
  });

  page.results.forEach((result) => {
    console.log(result.content);
  });

  cursor = page.nextCursor;
} while (cursor);
```

### Add Vocabulary

```typescript
await client.vocabulary.add({
  indexId: 'idx_123',
  term: 'premium customers',
  type: 'filter',
  field: 'customerTier',
  value: 'gold',
  aliases: ['vip customers', 'gold tier'],
});
```

### Check Document Status

```typescript
const status = await client.documents.getStatus({
  indexId: 'idx_123',
  documentId: 'doc_456',
});

console.log('Status:', status.status); // processing | completed | failed
console.log('Progress:', status.progress); // 0-100
console.log('Chunks:', status.chunkCount);
```

````

**Missing Currently**: ❌ No equivalent guide exists

---

#### 2. REST API Complete Reference ⚠️ **HIGH PRIORITY**

**What's needed**: OpenAPI/Swagger spec for all endpoints

**Recommendation**: Generate from route definitions

**Example OpenAPI snippet**:
```yaml
openapi: 3.0.0
info:
  title: ATLAS Search API
  version: 1.0.0
  description: Semantic search platform for documents and structured data

servers:
  - url: https://api.atlas.example.com
    description: Production

paths:
  /api/indexes:
    post:
      summary: Create index
      operationId: createIndex
      tags:
        - Indexes
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                  example: my-index
                projectId:
                  type: string
                  example: proj_123
              required:
                - name
                - projectId
      responses:
        '201':
          description: Index created
          content:
            application/json:
              schema:
                type: object
                properties:
                  indexId:
                    type: string
                    example: idx_abc123
                  name:
                    type: string
                  status:
                    type: string
                    enum: [active, inactive]
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '409':
          description: Index name already exists

  /api/indexes/{indexId}/sources/{sourceId}/documents:
    post:
      summary: Upload document
      operationId: uploadDocument
      tags:
        - Documents
      parameters:
        - name: indexId
          in: path
          required: true
          schema:
            type: string
        - name: sourceId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file:
                  type: string
                  format: binary
      responses:
        '202':
          description: Document accepted for processing
          content:
            application/json:
              schema:
                type: object
                properties:
                  documentId:
                    type: string
                  status:
                    type: string
                    enum: [processing]
                  estimatedTime:
                    type: number

  /api/search/{indexId}/query:
    post:
      summary: Execute search query
      operationId: query
      tags:
        - Search
      parameters:
        - name: indexId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                  example: kubernetes deployment
                queryType:
                  type: string
                  enum: [vector, hybrid]
                  default: vector
                topK:
                  type: integer
                  minimum: 1
                  maximum: 100
                  default: 10
                filters:
                  type: object
                  additionalProperties: true
      responses:
        '200':
          description: Search results
          content:
            application/json:
              schema:
                type: object
                properties:
                  results:
                    type: array
                    items:
                      type: object
                      properties:
                        chunkId:
                          type: string
                        score:
                          type: number
                          format: float
                        content:
                          type: string
                        metadata:
                          type: object
                  latency:
                    type: number
                  correlationId:
                    type: string

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key

  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
              code:
                type: string
    Unauthorized:
      description: Authentication required
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
                example: Unauthorized
              code:
                type: string
                example: AUTH_REQUIRED

security:
  - BearerAuth: []
  - ApiKeyAuth: []
````

**Missing Currently**: ❌ No OpenAPI spec exists

**Action Item**: Generate from TypeScript route definitions using `@asteasolutions/zod-to-openapi` or similar

---

#### 3. Webhook/Callback Guide ⚠️ **LOW PRIORITY**

**What's needed**: Ingestion completion webhooks

**Outline**:

````markdown
# Webhook Guide

## Overview

Webhooks notify your application when asynchronous operations complete (document ingestion, index rebuild, etc.).

## Supported Events

| Event                           | Trigger                       | Payload                                   |
| ------------------------------- | ----------------------------- | ----------------------------------------- |
| `document.processing.completed` | Document ingestion completed  | Document ID, chunk count, processing time |
| `document.processing.failed`    | Document ingestion failed     | Document ID, error code, error message    |
| `index.rebuild.completed`       | Index rebuild completed       | Index ID, document count, duration        |
| `job.completed`                 | Structured data job completed | Job ID, table ID, row count               |

## Setup

### Register Webhook URL

```bash
curl -X POST https://api.atlas.example.com/api/webhooks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhooks/atlas",
    "events": ["document.processing.completed", "document.processing.failed"],
    "secret": "whsec_..."
  }'
```
````

**Response**:

```json
{
  "webhookId": "wh_abc123",
  "url": "https://your-app.com/webhooks/atlas",
  "events": ["document.processing.completed"],
  "status": "active"
}
```

## Event Payload Format

### document.processing.completed

```json
{
  "event": "document.processing.completed",
  "timestamp": "2026-02-24T12:00:00Z",
  "data": {
    "documentId": "doc_123",
    "indexId": "idx_456",
    "status": "completed",
    "chunkCount": 42,
    "processingTime": 125.5,
    "metadata": {
      "filename": "document.pdf",
      "mimeType": "application/pdf",
      "fileSize": 5242880
    }
  }
}
```

### document.processing.failed

```json
{
  "event": "document.processing.failed",
  "timestamp": "2026-02-24T12:00:00Z",
  "data": {
    "documentId": "doc_123",
    "indexId": "idx_456",
    "status": "failed",
    "error": {
      "code": "EXTRACTION_FAILED",
      "message": "Failed to extract text from PDF"
    }
  }
}
```

## Webhook Verification

**Signature header**: `X-Atlas-Signature`

**Algorithm**: HMAC-SHA256

**Verification**:

```typescript
import crypto from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// Express.js example
app.post('/webhooks/atlas', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-atlas-signature'] as string;
  const payload = req.body.toString('utf8');

  if (!verifyWebhook(payload, signature, process.env.WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(payload);
  console.log('Webhook received:', event.event);

  res.status(200).send('OK');
});
```

## Retry Behavior

**Automatic retries** (exponential backoff):

- 1st retry: Immediate
- 2nd retry: 5 seconds
- 3rd retry: 25 seconds
- 4th retry: 125 seconds
- 5th retry: 625 seconds (final)

**Failure handling**:

- After 5 failed attempts, webhook is marked as failed
- Manual retry: `POST /api/webhooks/{webhookId}/retry`

## Best Practices

1. **Verify signature**: Always validate `X-Atlas-Signature`
2. **Return 200 quickly**: Acknowledge webhook within 5 seconds
3. **Process async**: Queue webhook for background processing
4. **Idempotency**: Handle duplicate deliveries gracefully
5. **Monitor failures**: Track webhook delivery rate

````

**Missing Currently**: ❌ No equivalent guide exists

---

#### 4. Client Library Documentation ⚠️ **LOW PRIORITY**

**What's needed**: Python, Java, Go client examples

**Status**: Check if these clients exist before documenting

---

### 3.3 Operational Guides (DevOps/SRE)

#### 1. Deployment Guide ⚠️ **HIGH PRIORITY**

**What's needed**: Production deployment (Docker Compose, Kubernetes)

**Outline**:
```markdown
# Deployment Guide

## Prerequisites

- Docker 24.0+ and Docker Compose 2.20+
- Kubernetes 1.28+ (if deploying to K8s)
- MongoDB 7.0+
- OpenSearch 2.11+
- Redis 7.2+
- Neo4j 5.15+ (if using knowledge graph)
- ClickHouse 23.8+ (if using structured data)

## Architecture

````

┌─────────────────────────────────────────────────────────┐
│ Load Balancer (nginx) │
└─────────────────────────────────────────────────────────┘
│
┌──────────────────┼──────────────────┐
│ │ │
▼ ▼ ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ search-ai │ │search-ai-rt │ │ Preprocessing│
│ (Port 3005) │ │ (Port 3004) │ │ (Port 8003) │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
│ │ │
└──────────────────┼──────────────────┘
│
┌──────────────────┼──────────────────┐
│ │ │
▼ ▼ ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ MongoDB │ │ OpenSearch │ │ Redis │
│ (Port 27017)│ │ (Port 9200) │ │ (Port 6379) │
└──────────────┘ └──────────────┘ └──────────────┘

````

## Docker Compose (Development)

**File**: `docker-compose.yml`

```yaml
version: '3.8'

services:
  mongodb:
    image: mongo:7.0
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}

  opensearch:
    image: opensearchproject/opensearch:2.11.1
    ports:
      - "9200:9200"
    volumes:
      - opensearch_data:/usr/share/opensearch/data
    environment:
      - discovery.type=single-node
      - "OPENSEARCH_JAVA_OPTS=-Xms2g -Xmx2g"
      - plugins.security.disabled=true

  redis:
    image: redis:7.2-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  search-ai:
    build: ./apps/search-ai
    ports:
      - "3005:3005"
    environment:
      - MONGODB_URL=mongodb://admin:${MONGO_PASSWORD}@mongodb:27017
      - OPENSEARCH_URL=http://opensearch:9200
      - REDIS_URL=redis://redis:6379
      - PORT=3005
    depends_on:
      - mongodb
      - opensearch
      - redis

  search-ai-runtime:
    build: ./apps/search-ai-runtime
    ports:
      - "3004:3004"
    environment:
      - MONGODB_URL=mongodb://admin:${MONGO_PASSWORD}@mongodb:27017
      - OPENSEARCH_URL=http://opensearch:9200
      - REDIS_URL=redis://redis:6379
      - PORT=3004
    depends_on:
      - mongodb
      - opensearch
      - redis

volumes:
  mongodb_data:
  opensearch_data:
  redis_data:
````

**Start**:

```bash
docker-compose up -d
```

## Kubernetes (Production)

### Helm Chart Structure

```
helm/
  ├── Chart.yaml
  ├── values.yaml
  ├── values-dev.yaml
  ├── values-prod.yaml
  └── templates/
      ├── search-ai-deployment.yaml
      ├── search-ai-runtime-deployment.yaml
      ├── preprocessing-deployment.yaml
      ├── mongodb-statefulset.yaml
      ├── opensearch-statefulset.yaml
      ├── redis-statefulset.yaml
      ├── ingress.yaml
      └── service.yaml
```

### Install

```bash
helm install atlas-search ./helm \
  -f helm/values-prod.yaml \
  --namespace atlas \
  --create-namespace
```

### Example Deployment (search-ai-runtime)

**File**: `templates/search-ai-runtime-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: search-ai-runtime
  labels:
    app: search-ai-runtime
spec:
  replicas: {{ .Values.runtime.replicas }}
  selector:
    matchLabels:
      app: search-ai-runtime
  template:
    metadata:
      labels:
        app: search-ai-runtime
    spec:
      containers:
        - name: runtime
          image: {{ .Values.runtime.image.repository }}:{{ .Values.runtime.image.tag }}
          ports:
            - containerPort: 3004
          env:
            - name: MONGODB_URL
              valueFrom:
                secretKeyRef:
                  name: mongodb-credentials
                  key: url
            - name: OPENSEARCH_URL
              value: http://opensearch:9200
            - name: REDIS_URL
              value: redis://redis:6379
            - name: PORT
              value: "3004"
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 10
            periodSeconds: 5
```

## Service Dependencies Startup Order

**Critical**: Start services in this order to avoid connection failures

1. **MongoDB** (primary datastore)
2. **OpenSearch** (vector store)
3. **Redis** (cache, queue)
4. **Neo4j** (if using knowledge graph)
5. **ClickHouse** (if using structured data)
6. **search-ai-runtime** (query service, no workers)
7. **search-ai** (ingestion service + workers)
8. **preprocessing** (Phase 3 service)

**Why this order?**

- search-ai-runtime has NO workers, starts fastest
- search-ai has workers that poll queues → needs Redis ready
- Preprocessing service is optional → start last

## Health Checks

**search-ai**:

```bash
curl http://localhost:3005/health
```

**search-ai-runtime**:

```bash
curl http://localhost:3004/health
```

**Expected response**:

```json
{
  "status": "ok",
  "services": {
    "mongodb": "connected",
    "opensearch": "connected",
    "redis": "connected"
  },
  "uptime": 3600
}
```

## Load Balancer Setup

**nginx config** (`/etc/nginx/conf.d/atlas.conf`):

```nginx
upstream search_ai {
    least_conn;
    server search-ai-1:3005;
    server search-ai-2:3005;
    server search-ai-3:3005;
}

upstream search_ai_runtime {
    least_conn;
    server runtime-1:3004;
    server runtime-2:3004;
    server runtime-3:3004;
}

server {
    listen 80;
    server_name api.atlas.example.com;

    location /api/search/ {
        proxy_pass http://search_ai_runtime;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }

    location /api/ {
        proxy_pass http://search_ai;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;  # Longer timeout for ingestion
    }
}
```

## Environment Variables Checklist

**Critical (must be set)**:

- `MONGODB_URL`
- `OPENSEARCH_URL`
- `REDIS_URL`
- `PORT`

**Optional but recommended**:

- `NODE_ENV=production`
- `LOG_LEVEL=info`
- `ANTHROPIC_API_KEY` (if using Claude models)
- `OPENAI_API_KEY` (if using OpenAI models)
- `COHERE_API_KEY` (if using Cohere reranking)

**Security-critical (NEVER commit)**:

- `DEV_BYPASS_AUTH=false` (must be false in production!)
- `JWT_SECRET`
- `API_KEY_SALT`

```

**Missing Currently**: ❌ No equivalent guide exists

---

#### 2. Scaling Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: Horizontal/vertical scaling strategies

**Outline**:
- Worker concurrency tuning
- Database sharding
- OpenSearch cluster sizing
- Neo4j cluster setup

**Missing Currently**: ❌ No equivalent guide exists

---

#### 3. Monitoring & Alerting ⚠️ **HIGH PRIORITY**

**What's needed**: Prometheus metrics + alert rules

**Outline**:
- Prometheus scrape config
- Alert rules (high latency, high cost, error rate)
- Grafana dashboard JSON templates
- Tracing configuration (OpenTelemetry?)

**Missing Currently**: ❌ No equivalent guide exists

---

#### 4. Backup & Disaster Recovery ⚠️ **MEDIUM PRIORITY**

**What's needed**: Backup procedures for all datastores

**Outline**:
- MongoDB backup (mongodump, Atlas backups)
- OpenSearch snapshot configuration
- Neo4j backup procedures
- S3 backup for uploaded files
- Recovery testing procedures

**Missing Currently**: ❌ No equivalent guide exists

---

#### 5. Security Hardening ⚠️ **MEDIUM PRIORITY**

**What's needed**: Production security checklist

**Outline**:
- JWT configuration (secret rotation, expiration)
- API key management (scoping, rate limits)
- Network isolation (VPC, security groups)
- Encryption at rest/transit
- Secret rotation procedures

**Missing Currently**: ❌ No equivalent guide exists

---

#### 6. Troubleshooting Runbook ⚠️ **HIGH PRIORITY**

**What's needed**: Common issues + solutions (expand from QUERY-PIPELINE-GUIDE.md Section 10)

**Outline**:
- Performance degradation diagnosis
- Worker failure recovery
- Index corruption recovery
- Data migration procedures
- Connection pool exhaustion
- Memory leaks (Node.js heap snapshots)

**Missing Currently**: ⚠️ Partial (Section 10 of QUERY-PIPELINE-GUIDE.md has basic troubleshooting)

---

### 3.4 Developer Guides (Internal Contributors)

#### 1. Architecture Decision Records (ADRs) ⚠️ **LOW PRIORITY**

**What's needed**: Document why key architectural choices were made

**Examples**:
- ADR-001: Why Docling over LlamaIndex
- ADR-002: Why metadata-only chunking for structured data
- ADR-003: Why BGE-M3 over OpenAI embeddings
- ADR-004: Why Neo4j for knowledge graph
- ADR-005: Why ClickHouse for structured data storage

**Missing Currently**: ❌ No ADRs exist

---

#### 2. Testing Guide ⚠️ **LOW PRIORITY**

**What's needed**: How to run tests locally

**Outline**:
- Unit test setup
- Integration test setup
- Mock service configuration
- Test data generation
- Performance test procedures

**Missing Currently**: ❌ No equivalent guide exists

---

#### 3. Worker Development Guide ⚠️ **LOW PRIORITY**

**What's needed**: How to add new workers

**Outline**:
- Worker architecture patterns
- BullMQ queue configuration
- Error handling patterns
- Retry logic
- Job prioritization

**Missing Currently**: ❌ No equivalent guide exists

---

#### 4. Contributing Guide ⚠️ **LOW PRIORITY**

**What's needed**: Code style, PR process, release process

**Missing Currently**: ❌ No CONTRIBUTING.md exists

---

### 3.5 Feature-Specific Guides

#### 1. Progressive Summarization Guide ⚠️ **LOW PRIORITY**

**What's needed**: What it is, how to configure, cost implications

**Missing Currently**: ⚠️ Mentioned in Phase 2 docs, but no standalone user guide

---

#### 2. Question Synthesis Guide ⚠️ **LOW PRIORITY**

**What's needed**: What it is, use cases (FAQ generation)

**Missing Currently**: ⚠️ Mentioned in Phase 2 docs, but no standalone user guide

---

#### 3. Visual Enrichment Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: When to enable, cost-benefit analysis

**Missing Currently**: ⚠️ Partial (MULTIMODAL.md exists, but incomplete per Section 2.2)

---

#### 4. Index Strategy Selection Guide ⚠️ **MEDIUM PRIORITY**

**What's needed**: Shared vs per-app vs per-connector

**Missing Currently**: ⚠️ Mentioned in KNOWLEDGE_GRAPH.md, but no decision tree or cost calculator

---

#### 5. Reranking Guide ⚠️ **LOW PRIORITY**

**What's needed**: Provider comparison, cost-benefit analysis

**Missing Currently**: ⚠️ Mentioned in QUERY-PIPELINE-GUIDE.md, but no standalone guide

---

## 4. Documentation Quality Issues

### 4.1 Consistency Problems

#### Port Numbers

**Problem**: Inconsistent port references across docs

**Occurrences**:
- README.md: "search-ai runs on port 3005"
- .env file: `PORT=3113`
- QUERY-PIPELINE-GUIDE.md: "runtime is on port 3004"

**Fix**: Standardize on 3005 (search-ai) and 3004 (runtime)

---

#### Model Names

**Problem**: Inconsistent model naming conventions

**Occurrences**:
- "claude-3-5-sonnet" (correct)
- "claude-3.5-sonnet" (incorrect)
- "claude-3-5-haiku" (correct)
- "text-embedding-3-small" (correct)
- "ada-002" (deprecated, should be "text-embedding-ada-002")

**Fix**: Use official model IDs from provider docs

---

#### Index Naming

**Problem**: Multiple prefixing conventions

**Occurrences**:
- "kb_" prefix (knowledge base IDs)
- "search-vectors-" prefix (OpenSearch index names)
- Project-specific names (user-defined)

**Fix**: Document all three conventions and when to use each

---

### 4.2 Outdated Information

#### Hybrid Search Status

**Problem**: Conflicting status across docs

**Occurrences**:
- README.md: "🚧 In Progress"
- QUERY-PIPELINE-GUIDE.md: "Not Implemented" (stub code)
- HYBRID-RETRIEVAL-PLAN.md: "Planned for Q2 2026"

**Fix**: Standardize on "Not Implemented (Stub), Planned Q2 2026"

---

#### Knowledge Graph Phase

**Problem**: Unclear what's deployed

**Occurrences**:
- KNOWLEDGE_GRAPH.md: "Phase 1 Complete (February 2026)"
- README.md: "Phase 2 In Progress (Q2 2026)"
- Unclear which features are production-ready

**Fix**: Add deployment status table:
| Feature | Status | Production Ready? |
|---------|--------|-------------------|
| Entity extraction | ✅ Complete | ✅ Yes |
| Shared index strategy | ✅ Complete | ✅ Yes |
| Visual enrichment | 🚧 In Progress | ❌ No |
| Cross-index entity linking | 📋 Planned | ❌ No |

---

#### Preprocessing Service

**Problem**: Unclear if Phase 3 is production-ready

**Occurrences**:
- QUERY-PIPELINE-GUIDE.md: "Phase 3 multilingual preprocessing (optional)"
- No clear deployment status

**Fix**: Add status banner:
> **Status**: ✅ Production-ready (as of February 2026)
> **Enable**: Set `PREPROCESSING_ENABLED=true`

---

## 5. Priority Recommendations

### HIGH PRIORITY (Blocking User Adoption)

| Priority | Doc | Impact | Effort | Notes |
|----------|-----|--------|--------|-------|
| 1 | **Complete REST API Reference** | Critical | 3 days | Generate OpenAPI spec from routes |
| 2 | **Getting Started Tutorial** | Critical | 2 days | 15-min onboarding, reduces support load |
| 3 | **File Upload Guide** | High | 2 days | Formats, limits, best practices |
| 4 | **Query Guide** | High | 2 days | When to use vector/structured/hybrid |
| 5 | **SDK Usage Examples** | High | 2 days | Node.js auth + error handling |
| 6 | **Deployment Guide** | High | 3 days | Docker Compose + K8s Helm chart |
| 7 | **Monitoring & Alerting** | High | 2 days | Prometheus metrics + Grafana dashboards |
| 8 | **Troubleshooting Runbook** | High | 2 days | Expand from QUERY-PIPELINE-GUIDE.md |

**Total HIGH Priority**: ~18 days

---

### MEDIUM PRIORITY (Operational Excellence)

| Priority | Doc | Impact | Effort | Notes |
|----------|-----|--------|--------|-------|
| 9 | **Vocabulary Management Guide** | Medium | 1 day | Business term mapping |
| 10 | **Structured Data Ingestion Guide** | Medium | 1 day | Two-phase API, metadata-only chunking |
| 11 | **LLM Configuration Guide** | Medium | 1 day | Cost optimization, custom providers |
| 12 | **Backup & Disaster Recovery** | Medium | 2 days | All datastores (MongoDB, OpenSearch, Neo4j) |
| 13 | **Security Hardening** | Medium | 2 days | JWT, API keys, encryption |
| 14 | **Scaling Guide** | Medium | 2 days | Horizontal/vertical scaling |
| 15 | **Visual Enrichment Guide** | Medium | 1 day | Complete MULTIMODAL.md |
| 16 | **Index Strategy Selection** | Medium | 1 day | Decision tree, cost calculator |

**Total MEDIUM Priority**: ~11 days

---

### LOW PRIORITY (Nice to Have)

| Priority | Doc | Impact | Effort | Notes |
|----------|-----|--------|--------|-------|
| 17 | **Architecture Decision Records** | Low | 3 days | Why we made these choices |
| 18 | **Testing Guide** | Low | 1 day | For contributors |
| 19 | **Worker Development Guide** | Low | 2 days | For internal developers |
| 20 | **Contributing Guide** | Low | 1 day | Code style, PR process |
| 21 | **Progressive Summarization** | Low | 1 day | Feature-specific tuning |
| 22 | **Question Synthesis** | Low | 1 day | FAQ generation |
| 23 | **Reranking Guide** | Low | 1 day | Provider comparison |
| 24 | **Webhook/Callback Guide** | Low | 2 days | Ingestion webhooks |
| 25 | **Client Library Docs** | Low | 3 days | Python, Java, Go clients (if they exist) |

**Total LOW Priority**: ~15 days

---

**GRAND TOTAL**: ~44 days of documentation work

---

## 6. Action Items

### Immediate (This Week)

1. **Audit and reconcile port numbers** across all docs (README, .env, guides)
2. **Update hybrid search status** to "Not Implemented (Stub), Planned Q2 2026"
3. **Create API endpoint inventory spreadsheet** with documentation status
4. **Document file size limits** (100MB for PDFs, 500MB for CSVs) in user-facing docs
5. **Document plain text file support** (.txt files, LlamaIndex legacy support)
6. **Fix DEV_BYPASS_AUTH security warning** in configuration docs

---

### Short-Term (Next 2 Weeks)

7. **Generate OpenAPI spec** from route definitions (use @asteasolutions/zod-to-openapi)
8. **Write Getting Started tutorial** (15 minutes, end-to-end)
9. **Write File Upload Guide** (formats, limits, batch upload, error handling)
10. **Write Query Guide** (vector vs structured vs hybrid, filter syntax, pagination)
11. **Write SDK Usage Examples** (Node.js auth + error handling + retries)

---

### Medium-Term (Next Month)

12. **Write Deployment Guide** (Docker Compose + K8s Helm chart)
13. **Create Prometheus metrics guide** + Grafana dashboard JSONs
14. **Expand Troubleshooting Runbook** from QUERY-PIPELINE-GUIDE.md
15. **Write Vocabulary Management Guide** (business term mapping)
16. **Write Structured Data Ingestion Guide** (two-phase API)
17. **Write LLM Configuration Guide** (cost optimization, custom providers)

---

### Long-Term (Next Quarter)

18. **Complete all MEDIUM priority docs** (11 days)
19. **Complete all LOW priority docs** (15 days)
20. **Set up docs.atlas.example.com** (Docusaurus, VitePress, or similar)
21. **Create interactive API playground** (Swagger UI)
22. **Record video tutorials** (Getting Started, File Upload, Querying)

---

## Summary

**Total Gaps**: 60+ missing or incomplete documentation items

**Critical Gaps** (blocking adoption):
- ❌ 40+ undocumented API endpoints
- ❌ 14+ undocumented file formats (including plain text .txt)
- ❌ Getting Started tutorial missing
- ❌ REST API reference incomplete
- ❌ Deployment guide missing
- ❌ SDK usage examples missing

**Estimated Effort**: ~44 days to close all gaps

**Recommendation**: Focus on HIGH priority items first (18 days) to unblock user adoption, then iterate on MEDIUM/LOW priority.

---

**Next Steps**:
1. Review this analysis with product/engineering team
2. Prioritize based on user feedback and adoption metrics
3. Assign documentation work to engineering + tech writers
4. Set up documentation site (docs.atlas.example.com)
5. Track progress in Jira/GitHub Issues
```
