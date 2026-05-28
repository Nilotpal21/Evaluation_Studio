# Feature Spec: Structured Data Extraction, Storage & Querying

**Feature ID:** #38
**Status:** BETA
**Owner:** SearchAI Team
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Problem Statement

Enterprise knowledge bases contain critical structured data (CSV, JSON, Excel) that users need to query alongside unstructured documents. Current semantic-search-only approaches fail on structured data because:

- Embedding every row of a 100K-row CSV is cost-prohibitive and semantically meaningless for numeric/categorical data
- Users expect SQL-like queries ("show me all orders over $1000 in Q4") that vector search cannot answer
- Schema detection must be accurate to avoid silent data corruption (e.g., ZIP codes treated as integers)
- Multi-table joins and aggregations require a columnar query engine, not a document store

Without this feature, SearchAI cannot serve enterprise use cases involving product catalogs, sales data, inventory reports, financial records, or any tabular dataset.

---

## 2. Goals

1. **G1**: Enable ingestion of structured data files (CSV, JSON, Excel) with automatic schema detection and user-validated schema correction
2. **G2**: Store structured data efficiently in ClickHouse with tenant/index isolation for SQL querying
3. **G3**: Route natural-language queries intelligently between semantic search (metadata discovery), SQL execution (structured filters/aggregations), and hybrid approaches
4. **G4**: Provide a two-phase ingestion API (analyze then finalize) that prevents data quality issues while keeping onboarding fast
5. **G5**: Support hierarchical JSON path indexing for nested structure querying

---

## 3. Non-Goals

- **NG1**: Real-time streaming ingestion (batch upload only)
- **NG2**: Support for XML ingestion (deferred to future iteration)
- **NG3**: Cross-index joins (queries are scoped to a single search index)
- **NG4**: ClickHouse cluster management or sharding (single-node for MVP)
- **NG5**: Custom SQL editor UI in Studio (deferred; API-only for now)
- **NG6**: Data export/download from ClickHouse

---

## 4. User Stories

| ID    | As a...           | I want to...                                                        | So that...                                                  | Priority |
| ----- | ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| US-1  | Knowledge admin   | Upload a CSV file and review the detected schema before committing  | I can correct type detection errors before data is ingested | P0       |
| US-2  | Knowledge admin   | See cost estimates (embedding tokens, storage, processing time)     | I can make informed decisions about ingestion               | P0       |
| US-3  | Knowledge admin   | Upload a JSON array of objects and have it treated as a table       | Structured JSON data is queryable via SQL                   | P0       |
| US-4  | Knowledge admin   | Upload an Excel spreadsheet (.xlsx)                                 | Tabular data from Excel is queryable via SQL                | P0       |
| US-5  | End user          | Ask "how many orders were placed last month?" and get an SQL answer | I get precise aggregation results from structured data      | P0       |
| US-6  | End user          | Ask "find products similar to wireless headphones under $100"       | I get hybrid (semantic + SQL filter) results                | P1       |
| US-7  | Knowledge admin   | See which tables exist in my index and their schemas                | I can manage and understand my structured data              | P0       |
| US-8  | End user          | Query nested JSON paths like "users[0].profile.email"               | I can access deeply nested structured data                  | P1       |
| US-9  | Knowledge admin   | Poll ingestion job status after finalizing                          | I know when my data is ready for querying                   | P0       |
| US-10 | Platform operator | Ensure tenant A cannot query tenant B's structured data             | Multi-tenant isolation is enforced at the storage layer     | P0       |

---

## 5. Functional Requirements

### FR-1: Two-Phase Ingestion API

- **FR-1.1**: POST `/:indexId/ingest/analyze` accepts multipart file upload (CSV, JSON, XLSX), parses the file, detects column types with confidence scores, identifies primary keys and foreign keys, recommends embeddable/filterable columns, calculates cost estimates, and returns an `analysisId` with 1-hour TTL cache
- **FR-1.2**: POST `/:indexId/ingest/finalize` accepts `analysisId` + user-corrected schema, creates a ClickHouse table, enqueues a BullMQ ingestion job, and returns a `jobId` for polling
- **FR-1.3**: GET `/:indexId/ingest/jobs/:jobId` returns ingestion job status (pending/processing/completed/failed) with progress percentage
- **FR-1.4**: File size limit: 100MB. Supported MIME types: text/csv, application/csv, application/json, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

### FR-2: Schema Detection

- **FR-2.1**: Detect column types: string, number, integer, decimal, boolean, date, enum
- **FR-2.2**: Detect primary keys by column naming convention (`id`, `*_id`) and uniqueness check
- **FR-2.3**: Detect foreign key relationships by naming convention (`*_id` referencing pluralized table) with confidence scores
- **FR-2.4**: Recommend embeddable columns (text content >10 chars avg, excluding ID columns)
- **FR-2.5**: Recommend filterable columns (numeric, boolean, enum, low-cardinality strings)
- **FR-2.6**: Generate quality warnings (low confidence types, high null rates, no embeddable columns, wide tables >50 columns)

### FR-3: ClickHouse Storage

- **FR-3.1**: Create per-table data tables (`structured_data_{tableId}`) with tenant_id, index_id isolation in ORDER BY clause
- **FR-3.2**: Store table metadata in `table_metadata` table with schema, descriptions, statistics, sample rows, foreign keys, searchable text
- **FR-3.3**: Support bulk row insertion with JSON serialization
- **FR-3.4**: Support SQL query execution with mandatory tenant_id/index_id filters (security validation)
- **FR-3.5**: Support table deletion (metadata + data table drop)
- **FR-3.6**: Support table statistics retrieval (row count, size bytes)

### FR-4: Smart Chunking Strategy

- **FR-4.1**: Create exactly 1 metadata SearchChunk per table (type: `table_metadata`) for semantic table discovery
- **FR-4.2**: No individual row chunks -- all rows stored in ClickHouse only (100% chunk savings)
- **FR-4.3**: Select 10-20 representative sample rows (evenly spaced) for metadata chunk
- **FR-4.4**: Auto-generate table descriptions from schema when not provided

### FR-5: Query Routing

- **FR-5.1**: Analyze query intent (semantic vs SQL vs hybrid) using pattern matching heuristics
- **FR-5.2**: SQL intent detection: filters, comparisons, aggregations, sorting, grouping keywords
- **FR-5.3**: Semantic intent detection: find, search, similar, contains, description keywords
- **FR-5.4**: Hybrid intent detection: combined semantic terms AND SQL operators
- **FR-5.5**: Route to appropriate execution strategy (semantic search, SQL generation, or hybrid)

### FR-6: Table Discovery

- **FR-6.1**: Discover relevant tables for a query using keyword matching on table metadata (searchable_text, table_name, display_name, description)
- **FR-6.2**: Score and rank tables by relevance with configurable min score threshold (default 0.3)
- **FR-6.3**: Analyze query intent for single-table vs multi-table scenarios
- **FR-6.4**: List all tables in an index, get table by name

### FR-7: Hierarchical JSON Path Indexing

- **FR-7.1**: Extract all paths from JSON objects with configurable max depth (default 15)
- **FR-7.2**: Store path index entries in ClickHouse `json_path_index` table
- **FR-7.3**: Normalize paths for pattern matching (e.g., `users[0].name` -> `users[].name`)
- **FR-7.4**: Support path-based queries by normalized pattern
- **FR-7.5**: Sample large arrays (>1000 elements) instead of indexing all

### FR-8: Ingestion Worker

- **FR-8.1**: BullMQ worker processes `structured-data-ingestion` queue with 3 retries, exponential backoff
- **FR-8.2**: Pipeline: parse file -> chunk -> store rows in ClickHouse -> store metadata -> create SearchChunk -> enqueue embedding job
- **FR-8.3**: Progress updates at 10%, 20%, 40%, 50%, 60%, 85%, 100%
- **FR-8.4**: Run within tenant context (`withTenantContext`)

### FR-9: Analysis Cache

- **FR-9.1**: Cache analysis results in Redis with 1-hour TTL
- **FR-9.2**: Compress file buffers with gzip before caching
- **FR-9.3**: Validate tenant/index ownership on cache retrieval (security)
- **FR-9.4**: Delete cache entry after successful finalization

---

## 6. Non-Functional Requirements

| ID     | Category      | Requirement                                                              | Target               |
| ------ | ------------- | ------------------------------------------------------------------------ | -------------------- |
| NFR-1  | Performance   | Schema analysis (Phase 1) completes in <5 seconds for files up to 10MB   | p95 < 5s             |
| NFR-2  | Performance   | ClickHouse SQL queries return in <1 second for tables up to 1M rows      | p95 < 1s             |
| NFR-3  | Performance   | Ingestion throughput: 100 rows/second minimum                            | >= 100 rows/s        |
| NFR-4  | Scalability   | Support tables up to 1M rows, 100 columns                                | 1M rows, 100 cols    |
| NFR-5  | Security      | Every ClickHouse query includes tenant_id and index_id filters           | 100% enforcement     |
| NFR-6  | Security      | SQL injection prevention via parameterized queries                       | Zero SQL injection   |
| NFR-7  | Reliability   | Ingestion worker retries failed jobs 3 times with exponential backoff    | 3 retries            |
| NFR-8  | Storage       | ClickHouse columnar compression achieves 10:1 ratio                      | >= 10:1              |
| NFR-9  | Availability  | Redis cache degradation does not block ingestion (graceful fallback)     | Graceful degradation |
| NFR-10 | Observability | All ingestion steps emit structured logs with tableId, indexId, tenantId | 100% coverage        |

---

## 7. API Contracts

### 7.1 Analyze Endpoint

```
POST /api/indexes/:indexId/ingest/analyze
Content-Type: multipart/form-data

Request:
  file: <binary> (required)
  metadata: <JSON string> (optional)

Response 200:
{
  "analysisId": "uuid",
  "schema": {
    "tableName": "products",
    "rowCount": 5000,
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "nullable": false,
        "confidence": 1.0,
        "sampleValues": [1, 2, 3],
        "uniqueCount": 5000,
        "nullCount": 0,
        "isEmbeddable": false,
        "isFilterable": true
      }
    ],
    "primaryKey": "id",
    "foreignKeys": [
      {
        "sourceField": "category_id",
        "targetTable": "categories",
        "targetField": "id",
        "confidence": 0.7,
        "detectionMethod": "naming_convention"
      }
    ]
  },
  "estimates": {
    "embeddingTokens": 25000,
    "embeddingCost": 0.0005,
    "storageBytes": 1024000,
    "chunkCount": 100,
    "processingTimeSeconds": 50
  },
  "quality": {
    "overallConfidence": 0.92,
    "warnings": ["Low confidence type detection for: zip_code"],
    "recommendations": ["Review and correct column types before finalizing"]
  },
  "expiresAt": "2026-03-22T13:00:00Z"
}
```

### 7.2 Finalize Endpoint

```
POST /api/indexes/:indexId/ingest/finalize
Content-Type: application/json

Request:
{
  "analysisId": "uuid",
  "schema": {
    "tableName": "products",
    "displayName": "Product Catalog",
    "description": "E-commerce product listings",
    "columns": [
      { "name": "id", "type": "integer", "isEmbeddable": false, "isFilterable": true }
    ],
    "primaryKey": "id"
  }
}

Response 201:
{
  "jobId": "structured-ingest:uuid",
  "status": "pending",
  "tableId": "uuid",
  "createdAt": "2026-03-22T12:00:00Z",
  "estimatedCompletionSeconds": 50
}
```

### 7.3 Job Status Endpoint

```
GET /api/indexes/:indexId/ingest/jobs/:jobId

Response 200:
{
  "jobId": "structured-ingest:uuid",
  "status": "completed",
  "progress": 100,
  "createdAt": "2026-03-22T12:00:00Z",
  "processedAt": "2026-03-22T12:00:05Z",
  "finishedAt": "2026-03-22T12:00:55Z",
  "failedReason": null
}
```

---

## 8. Data Model

### 8.1 ClickHouse Tables

**table_metadata** (MergeTree, ORDER BY tenant_id, index_id, table_name):

- table_id, table_name, display_name, tenant_id, index_id
- columns (JSON array), column_types (JSON array), primary_key, row_count
- table_description, column_descriptions (JSON object)
- statistics (JSON object), sample_rows (JSON array)
- foreign_keys (JSON array), searchable_text
- created_at, updated_at

**structured*data*{tableId}** (MergeTree, ORDER BY tenant_id, index_id, row_number):

- tenant_id, index_id, table_id, row_data (JSON string), row_number, created_at

**json_path_index** (MergeTree):

- tenant_id, index_id, object_id, object_type
- path, path_normalized, depth, value_type
- value_string, value_number, value_boolean
- parent_path, path_tokens (Array(String))
- created_at

### 8.2 MongoDB Collections

**SearchChunk** (existing, extended):

- chunkType: 'table_metadata' for structured data table discovery
- metadata.tableId, metadata.tableName, metadata.displayName
- metadata.rowCount, metadata.columnCount, metadata.primaryKey

### 8.3 Redis Keys

- `structured-data:analysis:{analysisId}` -- cached analysis with compressed file buffer (TTL: 1 hour)

---

## 9. Architecture Overview

```
                          ┌─────────────┐
                          │   Studio UI  │
                          └──────┬───────┘
                                 │ Upload file
                                 ▼
                    ┌───────────────────────┐
                    │  SearchAI API Server   │
                    │  /api/indexes/:id/     │
                    │    ingest/analyze      │──► Schema Analyzer
                    │    ingest/finalize     │──► Redis Cache
                    │    ingest/jobs/:id     │──► BullMQ Queue
                    └───────────┬───────────┘
                                │
                       ┌────────┴────────┐
                       ▼                 ▼
              ┌─────────────┐   ┌──────────────┐
              │  BullMQ Job  │   │ Query Router  │
              │  Worker      │   │  (NL → SQL)   │
              └──────┬───────┘   └──────┬────────┘
                     │                  │
          ┌──────────┼──────────┐       │
          ▼          ▼          ▼       ▼
   ┌───────────┐ ┌────────┐ ┌──────────────┐
   │ ClickHouse│ │MongoDB │ │  ClickHouse  │
   │  (rows)   │ │(chunks)│ │  (SQL exec)  │
   └───────────┘ └────────┘ └──────────────┘
```

---

## 10. Dependencies

| Dependency            | Type     | Notes                                                    |
| --------------------- | -------- | -------------------------------------------------------- |
| ClickHouse            | External | Columnar DB for structured data storage and SQL querying |
| Redis                 | External | Analysis cache with 1-hour TTL                           |
| BullMQ                | Library  | Job queue for async ingestion processing                 |
| papaparse             | Library  | CSV parsing                                              |
| exceljs               | Library  | Excel (.xlsx) parsing                                    |
| MongoDB (SearchChunk) | Internal | Metadata chunk storage for semantic discovery            |
| Embedding Service     | Internal | BGE-M3 embeddings for metadata chunks                    |

---

## 11. Risks & Mitigations

| Risk                                          | Impact | Mitigation                                                                       |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Schema detection accuracy below 90%           | HIGH   | Two-phase flow lets users correct before commit; quality warnings surface issues |
| ClickHouse availability affects all queries   | HIGH   | Health checks; graceful degradation returns "structured data unavailable"        |
| Large file uploads exhaust memory             | MEDIUM | 100MB limit; multer memory storage; streaming parser for CSV (future)            |
| Redis cache loss between analyze and finalize | MEDIUM | User re-uploads file; clear error message "analysis expired"                     |
| SQL injection via text-to-SQL                 | HIGH   | Parameterized queries; tenant_id/index_id string validation; query allowlist     |
| Cross-tenant data leakage in ClickHouse       | HIGH   | Every query includes tenant_id filter; security validation in executeQuery()     |

---

## 12. Success Metrics

| Metric                          | Target      | Measurement                                     |
| ------------------------------- | ----------- | ----------------------------------------------- |
| Schema detection accuracy       | >= 90%      | Correct type inference on benchmark datasets    |
| Ingestion success rate          | >= 99%      | Jobs completed / jobs submitted                 |
| Query routing accuracy          | >= 85%      | Correct intent classification on test query set |
| p95 analysis latency (10MB)     | < 5 seconds | API response time for analyze endpoint          |
| p95 SQL query latency (1M rows) | < 1 second  | ClickHouse query execution time                 |
| Chunk cost savings              | >= 99%      | (1 metadata chunk) vs (N row chunks)            |

---

## 13. Feature Flags & Rollout

- No feature flag gating currently -- structured data endpoints are always available when SearchAI is running
- Potential future flag: `STRUCTURED_DATA_TEXT_TO_SQL_ENABLED` for LLM-powered SQL generation (currently returns empty results)
- Potential future flag: `STRUCTURED_DATA_SEMANTIC_QUERY_ENABLED` for vector-based semantic search on structured data

---

## 14. Accessibility & Internationalization

- API responses use English error messages and recommendations
- Column names and table names preserve original encoding (UTF-8)
- No UI components in scope (API-only feature)
- Error codes are machine-readable for i18n in consuming UIs

---

## 15. Testing Strategy

- **Unit tests**: Schema analyzer, chunking strategy, query router intent analysis, path extractor, foreign key detector
- **Integration tests**: ClickHouse client operations, analysis cache Redis operations, ingestion worker pipeline
- **E2E tests**: Full analyze -> finalize -> query flow via HTTP API with real ClickHouse and Redis
- See `docs/testing/structured-data.md` for detailed test spec

---

## 16. Open Questions

| ID   | Question                                                            | Status    | Decision                                                     |
| ---- | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| OQ-1 | Should text-to-SQL use LLM or rule-based SQL generation?            | DECIDED   | LLM-based (TODO in query-router); rule-based as fallback     |
| OQ-2 | Should semantic search on structured data use row-level embeddings? | DECIDED   | No -- metadata-only chunking; rows queried via SQL           |
| OQ-3 | Should we support multi-sheet Excel files?                          | DECIDED   | First sheet only for MVP; multi-sheet as future enhancement  |
| OQ-4 | Should path index be created for all JSON or only nested?           | DECIDED   | Only for nested JSON (depth > 1); flat JSON treated as table |
| OQ-5 | What is the retention policy for ClickHouse data?                   | AMBIGUOUS | Need product decision on TTL vs permanent storage            |

---

## 17. Implementation Status

### Completed Components

| Component         | File                                                               | Status   |
| ----------------- | ------------------------------------------------------------------ | -------- |
| Schema Analyzer   | `apps/search-ai/src/services/structured-data/schema-analyzer.ts`   | COMPLETE |
| ClickHouse Client | `apps/search-ai/src/services/structured-data/clickhouse-client.ts` | COMPLETE |
| Chunking Strategy | `apps/search-ai/src/services/structured-data/chunking-strategy.ts` | COMPLETE |
| Analysis Cache    | `apps/search-ai/src/services/structured-data/analysis-cache.ts`    | COMPLETE |
| Ingest Routes     | `apps/search-ai/src/routes/structured-data-ingest.ts`              | COMPLETE |
| Ingestion Worker  | `apps/search-ai/src/workers/structured-data-ingestion-worker.ts`   | COMPLETE |
| Path Extractor    | `apps/search-ai/src/services/structured-data/path-extractor.ts`    | COMPLETE |
| Query Router      | `apps/search-ai/src/services/structured-data/query-router.ts`      | PARTIAL  |
| Table Discovery   | `apps/search-ai/src/services/structured-data/table-discovery.ts`   | PARTIAL  |
| Types             | `apps/search-ai/src/services/structured-data/types.ts`             | COMPLETE |
| Ingestion Types   | `apps/search-ai/src/services/structured-data/ingestion-types.ts`   | COMPLETE |

### Incomplete / TODO Components

| Component                  | Gap                                                                     | Priority |
| -------------------------- | ----------------------------------------------------------------------- | -------- |
| Semantic query execution   | `executeSemanticQuery()` returns empty; needs vector search integration | P1       |
| SQL query execution        | `executeSQLQuery()` returns empty; needs text-to-SQL LLM integration    | P0       |
| Hybrid query execution     | `executeHybridQuery()` returns empty; needs both semantic + SQL         | P1       |
| Table discovery (semantic) | Uses keyword matching only; needs embedding-based search                | P1       |
| Foreign key validation     | Cross-table FK validation against existing tables                       | P2       |
| Query result API           | No REST endpoint for executing structured data queries                  | P0       |
| Table management API       | No endpoints for listing/deleting tables                                | P1       |

---

## 18. Revision History

| Date       | Author        | Change                                           |
| ---------- | ------------- | ------------------------------------------------ |
| 2026-03-22 | SDLC Pipeline | Initial feature spec generated via SDLC pipeline |
