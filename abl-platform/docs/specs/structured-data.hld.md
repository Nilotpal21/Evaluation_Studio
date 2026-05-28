# HLD: Structured Data Extraction, Storage & Querying

**Feature:** Structured Data (#38)
**Status:** ALPHA
**Created:** 2026-03-22
**Feature Spec:** `docs/features/structured-data.md`
**Test Spec:** `docs/testing/structured-data.md`

---

## 1. Executive Summary

This HLD defines the architecture for structured data (CSV, JSON, Excel) ingestion, storage, and querying within SearchAI. The system uses a two-phase ingestion flow (analyze then finalize) with ClickHouse as the columnar storage engine, MongoDB for metadata chunk embeddings (semantic discovery), Redis for analysis caching, and BullMQ for async job processing. Natural language queries are routed between semantic search, SQL execution, and hybrid approaches based on intent classification.

---

## 2. Context Diagram

```
                                 External Systems
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    │    Studio UI / SDK / External Clients   │
                    │                                         │
                    └─────────────┬───────────────────────────┘
                                  │ HTTP REST API
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        SearchAI API Server                              │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ Ingest Routes     │  │ Query Routes      │  │ Table Mgmt Routes   │  │
│  │ /ingest/analyze   │  │ /query            │  │ /tables             │  │
│  │ /ingest/finalize  │  │ (future)          │  │ (future)            │  │
│  │ /ingest/jobs/:id  │  │                   │  │                     │  │
│  └──────┬───────────┘  └──────┬────────────┘  └──────┬──────────────┘  │
│         │                     │                       │                  │
│  ┌──────▼───────────┐  ┌─────▼─────────────┐  ┌─────▼──────────────┐  │
│  │ Schema Analyzer   │  │ Query Router      │  │ Table Discovery    │  │
│  │ Analysis Cache    │  │ Text-to-SQL       │  │ Service            │  │
│  │ Chunking Strategy │  │ Semantic Search   │  │                    │  │
│  └──────────────────┘  └───────────────────┘  └────────────────────┘  │
│                                                                         │
└────────┬──────────────────────┬──────────────────────┬──────────────────┘
         │                      │                      │
    ┌────▼────┐          ┌──────▼──────┐         ┌────▼─────┐
    │  Redis  │          │ ClickHouse   │         │ MongoDB  │
    │ (cache) │          │ (rows+meta)  │         │ (chunks) │
    └─────────┘          └──────────────┘         └──────────┘
         │
    ┌────▼─────┐
    │  BullMQ  │
    │  (jobs)  │
    └──────────┘
```

---

## 3. Component Architecture

### 3.1 Ingestion Pipeline

```
File Upload → Schema Analyzer → Analysis Cache (Redis)
                                       │
                              User Reviews Schema
                                       │
                              Finalize Request
                                       │
                                  ┌────▼─────┐
                                  │ BullMQ   │
                                  │ Queue    │
                                  └────┬─────┘
                                       │
                              ┌────────▼─────────┐
                              │ Ingestion Worker  │
                              │                   │
                              │ 1. Parse file     │
                              │ 2. Smart chunking │
                              │ 3. ClickHouse     │
                              │    (rows + meta)  │
                              │ 4. MongoDB chunk  │
                              │ 5. Embed queue    │
                              └───────────────────┘
```

### 3.2 Query Pipeline (Target Architecture)

```
Natural Language Query
         │
    ┌────▼─────────┐
    │ Query Router  │── Intent Analysis (semantic / sql / hybrid)
    └────┬─────────┘
         │
    ┌────▼─────────────┐
    │ Table Discovery   │── Find relevant tables from metadata
    └────┬─────────────┘
         │
    ┌────┴────────────────────────┐
    │                             │
    ▼                             ▼
┌──────────┐              ┌──────────────┐
│ Semantic │              │ Text-to-SQL  │
│ Search   │              │ (LLM-based)  │
│ (vectors)│              │              │
└────┬─────┘              └──────┬───────┘
     │                           │
     │    ┌──────────────┐       │
     └───►│   Merger /   │◄──────┘
          │   Ranker     │
          └──────┬───────┘
                 │
            ┌────▼─────┐
            │ Results   │
            └──────────┘
```

---

## 4. Architectural Concern #1: Resource Isolation

### Design

Every ClickHouse query includes mandatory `tenant_id` and `index_id` filters:

- **ORDER BY clause**: All MergeTree tables use `(tenant_id, index_id, ...)` as the primary sort key, ensuring ClickHouse physically partitions data by tenant
- **Query validation**: `executeQuery()` validates that SQL strings contain `tenant_id` and `index_id` references before execution
- **Parameterized queries**: All filters use ClickHouse query parameters (`{tenantId:String}`) to prevent injection
- **Route-level checks**: Every API endpoint verifies `req.tenantContext.tenantId` and validates index ownership via `SearchIndex.findOne({ _id: indexId, tenantId })`
- **Cache isolation**: Analysis cache includes `tenantId` + `indexId` in the cached payload; finalize validates ownership before use

### Cross-tenant access returns 404 (not 403) to avoid leaking resource existence, consistent with platform principle #1.

---

## 5. Architectural Concern #2: Authentication & Authorization

### Design

- **Middleware**: Routes use the platform `authMiddleware` from `src/middleware/auth.js` which populates `req.tenantContext`
- **No custom token verification**: All auth flows use the centralized middleware stack
- **Index ownership**: Every operation validates `SearchIndex.findOne({ _id: indexId, tenantId })` -- index must belong to the requesting tenant
- **Cache security**: Finalize endpoint validates `cached.tenantId !== tenantId || cached.indexId !== indexId` and returns 403

### Gap

- No per-user authorization on structured data operations (any user in the tenant can ingest/query)
- No RBAC for table management (delete table requires same auth as create)

---

## 6. Architectural Concern #3: Data Model & Storage

### ClickHouse Storage (Primary)

- **table_metadata**: One row per ingested table. Schema, descriptions, statistics, sample rows, foreign keys, searchable text. MergeTree engine with `ORDER BY (tenant_id, index_id, table_name)`.
- **structured*data*{tableId}**: One table per ingested dataset. Row data stored as JSON string. MergeTree engine with `ORDER BY (tenant_id, index_id, row_number)`.
- **json_path_index**: Path index for hierarchical JSON. MergeTree engine for path-based queries.

### MongoDB Storage (Metadata Chunks)

- **SearchChunk** with `chunkType: 'table_metadata'`: One document per table. Content is JSON-serialized metadata chunk. Embedded by the embedding service for semantic table discovery.

### Redis Storage (Ephemeral)

- **Analysis cache**: `structured-data:analysis:{analysisId}` with 1-hour TTL. Contains gzip-compressed file buffer + analysis results.

### Design Rationale

ClickHouse was chosen over PostgreSQL, DuckDB, and Elasticsearch based on:

- 10-100x faster analytical queries (columnar storage)
- 10:1 compression ratio (vs 2-3:1 for PostgreSQL)
- Full ANSI SQL support (unlike MongoDB/Elasticsearch)
- See ADR-003 for detailed comparison matrix

---

## 7. Architectural Concern #4: Performance & Scalability

### Ingestion Performance

- **Chunking strategy**: Metadata-only (1 chunk per table, not N chunks per row) reduces embedding costs by 99%+
- **Bulk insertion**: ClickHouse `INSERT ... FORMAT JSONEachRow` for batch writes
- **Async processing**: BullMQ worker decouples upload from ingestion; user gets immediate response
- **Gzip compression**: Analysis cache compresses file buffers before Redis storage

### Query Performance

- **ClickHouse columnar**: Sub-second aggregation queries on 1M+ rows
- **Metadata-first discovery**: Table discovery uses lightweight keyword matching on pre-indexed searchable_text
- **Connection pooling**: ClickHouse client reuses connections via singleton pattern

### Scalability Limits

| Dimension         | Current Limit | Scaling Path                                |
| ----------------- | ------------- | ------------------------------------------- |
| File size         | 100MB         | Streaming parser for CSV (chunked upload)   |
| Rows per table    | 1M            | ClickHouse handles 100M+ natively           |
| Columns per table | 100           | ClickHouse supports 1000+ columns           |
| Tables per index  | Unlimited     | Table discovery may degrade; add pagination |
| Concurrent jobs   | BullMQ config | Horizontal scaling via multiple worker pods |

---

## 8. Architectural Concern #5: Error Handling & Resilience

### Ingestion Errors

- **Retry policy**: BullMQ worker retries 3 times with exponential backoff (5s, 10s, 20s)
- **Job failure**: Failed jobs are marked `failed` with `failedReason`; queryable via job status API
- **Partial failure**: If ClickHouse write succeeds but MongoDB chunk creation fails, the data is in ClickHouse but not discoverable. Worker must be idempotent for retries.
- **Cache miss**: If Redis loses the analysis between analyze and finalize, the user receives a 404 with "Analysis not found or expired" and must re-upload.

### Query Errors

- **ClickHouse unavailable**: Query router should return `{ success: false, error: { code: 'CLICKHOUSE_UNAVAILABLE', message: '...' } }`
- **SQL generation failure**: Text-to-SQL should fall back to semantic-only search
- **Timeout**: ClickHouse queries should have a configurable timeout (default 30s)

### Gap

- No circuit breaker for ClickHouse connection failures
- No dead-letter queue for permanently failed ingestion jobs
- Redis cache loss is not retried automatically

---

## 9. Architectural Concern #6: Observability & Tracing

### Current State

All components use `console.log` / `console.error` with structured context objects containing `tableId`, `indexId`, `tenantId`, `filename`, `rowCount`.

### Gap

- Should use `createLogger('structured-data')` instead of `console.log` (platform standard)
- No TraceEvent emission for ingestion steps
- No metrics (ingestion throughput, query latency, schema accuracy)
- Worker progress updates (job.updateProgress) provide coarse tracking but no fine-grained observability

### Recommended Improvements

1. Replace all `console.log` with platform logger
2. Emit TraceEvents at each ingestion stage (parse, chunk, store, embed)
3. Add Prometheus metrics: `structured_data_ingestion_duration_seconds`, `structured_data_query_duration_seconds`, `structured_data_tables_total`

---

## 10. Architectural Concern #7: Security

### SQL Injection Prevention

- All ClickHouse queries use parameterized values (`{tenantId:String}`)
- `executeQuery()` validates that user-supplied SQL contains `tenant_id` and `index_id` references
- Text-to-SQL (when implemented) must use query allowlisting and validation

### File Upload Security

- Multer MIME type filter: only CSV, JSON, XLSX accepted
- 100MB file size limit enforced by multer
- File stored in memory (not disk) -- automatically garbage collected

### Data Security

- No encryption at rest for ClickHouse data (ClickHouse supports disk encryption, not enabled)
- Redis analysis cache contains raw file data -- should evaluate if sensitive data needs encryption

### Gap

- `executeQuery()` validates SQL by string-contains check for `tenant_id`/`index_id` -- this is weak. An attacker could include these strings in a comment while querying other tenants' data.
- No input sanitization on table names or column names (used in dynamic table creation)
- No rate limiting specific to ingestion endpoints

---

## 11. Architectural Concern #8: Deployment & Infrastructure

### Dependencies

| Service    | Required | Docker Image                      | Port      |
| ---------- | -------- | --------------------------------- | --------- |
| ClickHouse | Yes      | clickhouse/clickhouse-server:23.8 | 8123/9000 |
| Redis      | Yes      | redis:7                           | 6379      |
| MongoDB    | Yes      | mongo:6                           | 27017     |
| SearchAI   | Yes      | apps/search-ai                    | 3005      |

### ClickHouse Schema Migration

- Tables created at runtime via `initialize()` with `CREATE TABLE IF NOT EXISTS`
- No versioned migration system for ClickHouse schema changes
- `json_path_index` table created via SQL migration file `006_json_path_index.sql`

### Gap

- No ClickHouse migration framework (all schema changes are ad-hoc `CREATE TABLE IF NOT EXISTS`)
- No health check endpoint for ClickHouse connectivity
- No backup/restore strategy for ClickHouse data

---

## 12. Architectural Concern #9: Backward Compatibility

### API Compatibility

- New endpoints (`/ingest/analyze`, `/ingest/finalize`, `/ingest/jobs/:jobId`) are additive -- no existing API contracts broken
- Mounted under existing `/api/indexes/` router

### Data Compatibility

- New ClickHouse tables are independent of existing MongoDB data
- SearchChunk `chunkType: 'table_metadata'` is a new discriminator value that does not conflict with existing chunk types
- No schema changes to existing MongoDB models

### Migration Path

- No migration needed for existing deployments
- ClickHouse tables auto-created on first use

---

## 13. Architectural Concern #10: Configuration & Feature Flags

### Environment Variables

| Variable                      | Default                | Purpose                   |
| ----------------------------- | ---------------------- | ------------------------- |
| CLICKHOUSE_URL                | http://localhost:8123  | ClickHouse connection URL |
| REDIS_URL                     | redis://localhost:6379 | Redis for analysis cache  |
| STRUCTURED_DATA_MAX_FILE_SIZE | 104857600 (100MB)      | Max upload file size      |

### Feature Flags

- None currently. All structured data functionality is always available.
- Recommended: `STRUCTURED_DATA_TEXT_TO_SQL_ENABLED` (default: false) to gate LLM-powered SQL generation

---

## 14. Architectural Concern #11: Compliance & Data Governance

### Data Minimization

- Analysis cache has 1-hour TTL (auto-expired)
- No permanent storage of original uploaded files (only parsed data in ClickHouse)
- Compressed file buffer in Redis is deleted after successful finalization

### Right to Erasure

- `deleteTable()` drops both ClickHouse data table and metadata entry
- MongoDB SearchChunk must also be deleted (gap: no cascade delete implemented)

### Audit Logging

- No audit log for structured data operations (who uploaded what, when, which schema changes were made)

### Gap

- No cascade delete from table to SearchChunk
- No audit trail for ingestion and schema correction operations
- No data classification for uploaded files (PII detection in structured data)

---

## 15. Architectural Concern #12: Testing Strategy

### Current Test Coverage

- **13 unit test files** covering schema analyzer, chunking, query router, path extractor, analysis cache, clickhouse client, foreign key detector, table discovery, JSON chunking
- **1 E2E validation test** (`end-to-end-validation.test.ts`) but uses direct class instantiation, not HTTP API
- **1 API test** (`ingest-api.test.ts`) but uses vi.mock() extensively -- violates E2E standards

### Planned Coverage

- 7 E2E scenarios via HTTP API (see test spec)
- 8 integration scenarios with real infrastructure
- See `docs/testing/structured-data.md` for full test matrix

### Critical Testing Gap

- The existing `ingest-api.test.ts` mocks SearchIndex, AnalysisCacheService, ClickHouseClient, and BullMQ -- it would pass even if all those services were broken
- No E2E test exercises the real middleware chain (auth, tenant context)

---

## 16. Alternatives Considered

### Alternative 1: PostgreSQL for Structured Data

**Rejected.** PostgreSQL handles OLTP well but analytical queries (aggregations, GROUP BY, window functions) on 1M+ rows are 10-100x slower than ClickHouse's columnar engine. Additionally, ClickHouse's 10:1 compression ratio significantly reduces storage costs for large datasets.

### Alternative 2: DuckDB (Embedded)

**Considered.** DuckDB offers fast in-process analytical queries without a server. However: (a) no multi-tenant shared access across pods, (b) no persistent shared state for distributed workers, (c) data would need to be loaded into memory for each query. ClickHouse provides a shared, persistent, multi-tenant columnar store.

### Alternative 3: Single-Phase Ingestion (Auto-Ingest)

**Rejected.** Automatic schema detection is ~90% accurate. Without a review step, 10% of ingestions would have schema errors (wrong types, missing embeddable columns), leading to broken queries and poor user experience. The two-phase flow adds one API call but prevents data quality issues. See ADR-005 for detailed rationale.

### Alternative 4: Row-Level Chunking (Embed Every Row)

**Rejected.** A 100K-row table with 5 embeddable columns would generate 500K chunks. At $0.02/1M tokens for text-embedding-3-small, this creates significant embedding costs with minimal semantic value for numeric/categorical data. Metadata-only chunking (1 chunk per table) achieves 99%+ cost savings while enabling table-level semantic discovery.

---

## 17. Decision Log

| ID  | Decision                                    | Rationale                                                    | Date    |
| --- | ------------------------------------------- | ------------------------------------------------------------ | ------- |
| D1  | Use ClickHouse for structured data storage  | 10-100x faster than PostgreSQL for analytical queries        | 2025-Q4 |
| D2  | Two-phase ingestion (analyze then finalize) | Prevents 10% schema error rate from auto-detection           | 2025-Q4 |
| D3  | Metadata-only chunking (no row chunks)      | 99%+ cost savings on embeddings                              | 2026-02 |
| D4  | BullMQ for async ingestion processing       | Decouples upload from heavy processing                       | 2026-02 |
| D5  | Redis for analysis cache with 1-hour TTL    | In-memory speed for temporary data; auto-expiration          | 2026-02 |
| D6  | Pattern-based query intent classification   | Zero-cost heuristics before LLM-based text-to-SQL            | 2026-02 |
| D7  | JSON path indexing in ClickHouse            | Leverages existing ClickHouse infra for hierarchical queries | 2026-02 |

---

## 18. Open Architecture Questions

| ID   | Question                                                                      | Impact | Status   |
| ---- | ----------------------------------------------------------------------------- | ------ | -------- |
| AQ-1 | Should text-to-SQL have a query allowlist to prevent destructive SQL?         | HIGH   | DECIDED  |
| AQ-2 | Should ClickHouse health be integrated into the platform health check system? | MEDIUM | OPEN     |
| AQ-3 | Should we add a ClickHouse migration framework?                               | MEDIUM | OPEN     |
| AQ-4 | How should cascade deletes work (ClickHouse table + MongoDB chunk)?           | MEDIUM | OPEN     |
| AQ-5 | Should structured data support streaming ingestion in the future?             | LOW    | DEFERRED |
