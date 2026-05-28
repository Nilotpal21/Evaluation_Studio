# Structured Data Ingestion -- Low-Level Design

**Feature Spec**: `docs/features/structured-data.md`
**HLD**: `docs/specs/structured-data.hld.md`
**Testing Guide**: `docs/testing/structured-data.md`
**Status**: BETA

---

## Implementation Structure

### Services (`apps/search-ai/src/services/structured-data/`)

| File                        | Purpose                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                  | Re-exports all structured data services                                                                                                                                           |
| `types.ts`                  | Shared types: ColumnSchema, TableSchema, TableMetadata, ClickHouseTableRow, IngestionResult                                                                                       |
| `ingestion-types.ts`        | API types: DetectedColumn, DetectedForeignKey, AnalyzeResponse, FinalizeRequest, FinalizeResponse, IngestionJobData                                                               |
| `schema-analyzer.ts`        | Core analyzer: parseFile (CSV/JSON/Excel), detectColumns (type inference with confidence), detectPrimaryKey, detectForeignKeys, calculateEstimates, assessQuality                 |
| `clickhouse-client.ts`      | ClickHouse operations: initialize() creates table_metadata, createDataTable() creates per-table storage, bulkInsert(), storeTableMetadata(), executeQuery() with tenant isolation |
| `chunking-strategy.ts`      | Row-based and group-based chunking for CSV/Excel data                                                                                                                             |
| `json-chunking-strategy.ts` | JSON-specific chunking with nested path extraction                                                                                                                                |
| `query-router.ts`           | Intent analysis (semantic/sql/hybrid), route execution, result aggregation                                                                                                        |
| `text-to-sql.ts`            | LLM-based SQL generation: buildSchemaContext, buildSystemPrompt, generateSQL, validateSQL                                                                                         |
| `table-discovery.ts`        | Semantic search over table_metadata chunks: discovers relevant tables by query keywords                                                                                           |
| `foreign-key-detector.ts`   | FK detection: detectForeignKeysLocal (naming convention), validateForeignKeys (value check with configurable minMatchRate=0.9)                                                    |
| `path-extractor.ts`         | JSON path extraction for nested structures                                                                                                                                        |
| `analysis-cache.ts`         | Redis-backed analysis result cache with 1-hour TTL                                                                                                                                |

### Routes

| File                                                  | Purpose                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/structured-data-ingest.ts` | Two-phase API. Phase 1: multer upload -> SchemaAnalyzer.analyze() -> AnalysisCacheService.cache() -> return schema. Phase 2: AnalysisCacheService.get() -> createQueue(QUEUE_STRUCTURED_INGESTION).add() -> return jobId. |

### Workers

| File                                                             | Queue                       | Purpose                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/workers/structured-data-ingestion-worker.ts` | `structured-data-ingestion` | Full ingestion: parse file -> create ClickHouse table -> bulk insert -> store metadata -> apply chunking -> create SearchChunks -> enqueue embedding |

---

## Schema Analyzer Detail

The `StructuredDataSchemaAnalyzer` class handles multi-format parsing and schema detection:

### File Parsing

- **CSV**: Parsed with header detection; supports comma, semicolon, tab delimiters.
- **JSON**: Supports flat arrays and nested objects. Nested objects are flattened with dot notation.
- **Excel (.xlsx)**: Parsed via library; only `.xlsx` supported (`.xls` throws error).

### Column Type Detection

For each column, samples rows and infers type based on value patterns:

- `string`: Default fallback
- `number`: Numeric values (int or float)
- `boolean`: true/false/yes/no/0/1
- `date`: ISO format, common date patterns
- `json`: Nested objects or arrays
- `array`: Array values

Confidence score is the percentage of non-null values matching the detected type.

### Primary Key Detection

Candidates: columns that are (a) fully unique, (b) fully non-null, and (c) match naming patterns (`id`, `_id`, `key`, `code`, `uuid`). If multiple candidates, prefer the one with the strongest naming match.

### Foreign Key Detection

The `ForeignKeyDetector` uses 4 strategies:

1. **Naming convention**: Column named `{table}_id` suggests FK to `{table}.id`.
2. **Value validation**: Sample FK values checked against target table (match rate >= 0.9).
3. **Cardinality analysis**: Many-to-one relationship pattern.
4. **Type matching**: FK column type matches referenced PK type.

---

## ClickHouse Storage Detail

### Table Metadata

The `table_metadata` table stores:

- Schema: columns (JSON array), column_types (JSON array), primary_key
- Statistics: per-column stats (min, max, distinct count, null count)
- Discovery: searchable_text field for semantic table discovery
- Sample rows: first N rows for preview

### Data Tables

Per-table storage (`sd_{tableId}`) with:

- Isolation columns: tenant_id, index_id
- Row tracking: row_number (UInt64)
- Data: all columns stored as String type (ClickHouse handles casting)
- Timestamps: created_at, updated_at

---

## Chunking Strategies

### Row-Based (CSV/Excel)

Each row becomes a chunk. Text format: `Column1: Value1 | Column2: Value2 | ...`. Good for wide tables with many distinct rows.

### Group-Based (CSV/Excel)

Groups of N rows become a single chunk. Provides richer context for embedding. Good for tables with related consecutive rows.

### JSON Path-Based (JSON)

Extracts values at specific JSON paths and creates chunks per path or per object. Preserves nested structure context.

---

## Test Files

| Test File                                  | What It Tests                                    |
| ------------------------------------------ | ------------------------------------------------ |
| `schema-analyzer.test.ts`                  | Column detection, PK detection, CSV/JSON parsing |
| `clickhouse-client.test.ts`                | Table creation, insert, metadata (mocked)        |
| `clickhouse-client.integration.test.ts`    | Real ClickHouse operations                       |
| `chunking-strategy.test.ts`                | Row-based and group-based chunking               |
| `json-chunking-strategy.test.ts`           | JSON path-based chunking                         |
| `query-router.test.ts`                     | Intent analysis, routing decisions               |
| `text-to-sql.test.ts`                      | SQL generation, validation                       |
| `table-discovery.test.ts`                  | Semantic table matching                          |
| `foreign-key-detector.test.ts`             | FK naming convention, match rate                 |
| `path-extractor.test.ts`                   | JSON path extraction                             |
| `analysis-cache.test.ts`                   | Cache TTL, retrieval                             |
| `structured-data-ingestion-worker.test.ts` | Worker flow (mocked)                             |
| `ingest-api.test.ts`                       | API contract validation                          |
| `structured-data-integration.test.ts`      | Full flow integration                            |
| `end-to-end-validation.test.ts`            | Data quality validation                          |

---

## Known Gaps

1. **ClickHouse columns as String**: All data stored as String type loses native ClickHouse type benefits (sorting, aggregation performance).
2. **No streaming parse**: Large files are fully loaded into memory before parsing.
3. **FK detection requires both tables**: Cannot detect FKs until both tables are ingested.
4. **QueryRouter partial wiring**: Not fully integrated with the main search endpoint.
5. **No tenant isolation E2E**: ClickHouse tenant isolation is not validated in tests.
