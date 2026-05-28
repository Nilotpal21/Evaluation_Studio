# Test Spec: Structured Data Extraction, Storage & Querying

**Feature:** Structured Data (#38)
**Status:** ALPHA
**Created:** 2026-03-22
**Feature Spec:** `docs/features/structured-data.md`

---

## 1. Test Strategy Overview

This test spec covers structured data ingestion (CSV, JSON, Excel), ClickHouse storage, query routing, table discovery, and the full two-phase ingestion pipeline. Tests are organized into three tiers:

- **E2E Tests (7 scenarios)**: Full HTTP API round-trips with real ClickHouse, Redis, MongoDB, and BullMQ
- **Integration Tests (8 scenarios)**: Service-boundary tests with real infrastructure (ClickHouse or Redis)
- **Unit Tests (referenced)**: Already exist for schema analyzer, chunking strategy, query router, path extractor, analysis cache, clickhouse client

All E2E tests interact exclusively via HTTP API -- no mocks, no direct DB access, no stubbed servers.

---

## 2. E2E Test Scenarios

### E2E-1: CSV Full Ingestion Lifecycle

**Description:** Upload a CSV file through analyze -> finalize -> poll -> verify data in ClickHouse.

**Preconditions:**

- Real SearchAI Express server running on random port
- Real ClickHouse, Redis, and MongoDB connections
- A search index exists for the test tenant

**Steps:**

1. POST `/:indexId/ingest/analyze` with a 5-row CSV file containing products (id, name, description, price, category)
2. Assert response: 200, `analysisId` present, schema has 5 columns, rowCount = 5
3. Assert: `id` detected as integer, `price` detected as number, `description` detected as string
4. Assert: `description.isEmbeddable = true`, `price.isFilterable = true`
5. Assert: `primaryKey = "id"`, quality.overallConfidence > 0.8
6. POST `/:indexId/ingest/finalize` with the `analysisId` and corrected schema (change category type to enum)
7. Assert response: 201, `jobId` and `tableId` present, status = "pending"
8. Poll GET `/:indexId/ingest/jobs/:jobId` until status = "completed" (max 30s)
9. Assert: progress = 100, finishedAt is set, failedReason is null
10. Verify ClickHouse: query `table_metadata` for the tableId, assert rowCount matches
11. Verify ClickHouse: query data table for rows, assert 5 rows returned with correct data

**Expected Result:** Full lifecycle completes; data queryable in ClickHouse.

**Coverage:** FR-1.1, FR-1.2, FR-1.3, FR-2.1, FR-2.2, FR-2.4, FR-2.5, FR-3.1, FR-3.2, FR-3.3, FR-4.1, FR-8.1, FR-8.2, FR-8.3, NFR-7

---

### E2E-2: JSON Array Ingestion

**Description:** Upload a JSON array of objects and verify it's treated as a table.

**Preconditions:** Same as E2E-1.

**Steps:**

1. POST `/:indexId/ingest/analyze` with a JSON file: `[{"id": 1, "name": "Alice", "age": 30}, ...]`
2. Assert response: 200, schema.tableName derived from filename, columns = [id, name, age]
3. Assert: `id` type = integer, `name` type = string, `age` type = integer
4. POST `/:indexId/ingest/finalize` with approved schema
5. Poll until completed
6. Verify ClickHouse: data table contains correct rows

**Expected Result:** JSON array treated as flat table, ingested into ClickHouse.

**Coverage:** FR-1.1, FR-1.2, US-3

---

### E2E-3: Excel (.xlsx) Ingestion

**Description:** Upload an Excel spreadsheet and verify schema detection and ingestion.

**Preconditions:** Same as E2E-1 plus a pre-built .xlsx file fixture.

**Steps:**

1. Create an .xlsx file with headers [order_id, customer_name, amount, order_date, status] and 10 rows
2. POST `/:indexId/ingest/analyze` with the .xlsx file
3. Assert: schema detects 5 columns with correct types (order_id=integer, amount=number, order_date=date, status=enum)
4. Assert: estimates.embeddingTokens > 0, estimates.storageBytes > 0
5. POST `/:indexId/ingest/finalize`
6. Poll until completed
7. Verify ClickHouse data matches Excel content

**Expected Result:** Excel data correctly parsed and ingested.

**Coverage:** FR-1.1, FR-1.4, US-4

---

### E2E-4: Tenant Isolation in ClickHouse Queries

**Description:** Verify that tenant A cannot access tenant B's structured data.

**Preconditions:** Two different tenant contexts configured.

**Steps:**

1. As Tenant A: POST analyze + finalize for a products CSV
2. Wait for ingestion to complete
3. As Tenant B: POST analyze for a different CSV (verify this works -- different tenant can ingest)
4. As Tenant B: Try to GET job status for Tenant A's jobId -- expect 404
5. Verify ClickHouse: query data table with Tenant B's tenantId returns 0 rows for Tenant A's table
6. As Tenant B: Try POST finalize with Tenant A's analysisId -- expect 403 ("Analysis does not belong to this tenant/index")

**Expected Result:** Cross-tenant access returns 404 or 403; no data leakage.

**Coverage:** FR-3.4, FR-9.3, NFR-5, US-10

---

### E2E-5: Analysis Expiration and Re-upload

**Description:** Verify that an expired analysis requires re-upload.

**Preconditions:** Redis configured with short TTL for testing (override or wait).

**Steps:**

1. POST analyze for a CSV file
2. Manually delete the Redis key `structured-data:analysis:{analysisId}` (simulating expiration)
3. POST finalize with the expired analysisId
4. Assert response: 404, error message contains "expired"
5. Re-upload the file via POST analyze
6. Assert: new analysisId returned
7. POST finalize with new analysisId -- succeeds

**Expected Result:** Expired analysis returns clear error; re-upload path works.

**Coverage:** FR-9.1, FR-9.4, NFR-9

---

### E2E-6: Query Router Intent Classification via API

**Description:** Verify query routing classifies intents correctly through the API (when query endpoint is implemented).

**Preconditions:** Structured data tables ingested. Query API endpoint available.

**Steps:**

1. Ingest a products table (id, name, description, price, category)
2. Query: "how many products cost more than $100?" -- expect intent.type = "sql"
3. Query: "find products similar to wireless headphones" -- expect intent.type = "semantic"
4. Query: "find products described as 'premium' with price less than 50" -- expect intent.type = "hybrid"
5. Query: "show me all data" -- expect intent.type = "semantic" (default)

**Expected Result:** Intent classification matches expected types with confidence > 0.5.

**Note:** This test will be fully functional once the query REST endpoint is implemented. Currently validates the QueryRouter.analyzeIntent() method.

**Coverage:** FR-5.1, FR-5.2, FR-5.3, FR-5.4, US-5, US-6

---

### E2E-7: Large File Rejection and Error Handling

**Description:** Verify proper error handling for oversized files and unsupported formats.

**Preconditions:** Same as E2E-1.

**Steps:**

1. POST analyze with a file > 100MB -- expect 413 or multer error
2. POST analyze with a .pdf file (unsupported MIME type) -- expect 400 with "Unsupported file type"
3. POST analyze with no file attached -- expect 400 "No file uploaded"
4. POST analyze with an empty CSV (headers only, no rows) -- expect error about no data rows
5. POST finalize with missing analysisId -- expect 400 "analysisId is required"
6. POST finalize with missing schema -- expect 400 "schema is required"
7. POST analyze without tenant context -- expect 401 "Tenant context required"

**Expected Result:** All error cases return appropriate HTTP status codes and descriptive messages.

**Coverage:** FR-1.4, FR-1.1, FR-1.2

---

## 3. Integration Test Scenarios

### INT-1: ClickHouse Table Lifecycle

**Description:** Test ClickHouse client operations: create table, insert rows, query, delete.

**Preconditions:** Real ClickHouse connection.

**Steps:**

1. Initialize ClickHouse client (create `table_metadata` table)
2. Create a data table for a test tableId
3. Insert 100 rows with diverse column types
4. Query rows with limit/offset -- verify correct subset returned
5. Insert table metadata -- verify it's retrievable by tenantId + indexId
6. Get table stats -- verify row count and size bytes
7. Delete table -- verify both metadata and data table are removed
8. Query again -- verify 0 results or table not found

**Expected Result:** Full CRUD lifecycle works correctly.

**Coverage:** FR-3.1, FR-3.2, FR-3.3, FR-3.4, FR-3.5, FR-3.6

---

### INT-2: Analysis Cache with Redis

**Description:** Test Redis cache set/get/delete with gzip compression.

**Preconditions:** Real Redis connection.

**Steps:**

1. Create an AnalysisCacheService with a real Redis client
2. Store an analysis with a 1MB file buffer
3. Retrieve it -- verify file buffer matches original (after gzip round-trip)
4. Verify analysis metadata (tenantId, indexId, timestamps) match
5. Check exists() returns true
6. Delete the analysis
7. Check exists() returns false
8. Get returns null

**Expected Result:** Cache correctly compresses, stores, retrieves, and deletes.

**Coverage:** FR-9.1, FR-9.2, FR-9.3, FR-9.4

---

### INT-3: Schema Analyzer Accuracy

**Description:** Test schema detection against diverse real-world datasets.

**Preconditions:** None (pure computation).

**Steps:**

1. Analyze a CSV with: ID (integer), name (string), email (string), ZIP code (string that looks like integer "02134"), price (decimal), is_active (boolean), created_at (date)
2. Assert: ZIP code detected as string (not integer) due to leading zeros
3. Assert: ID detected as primary key (unique + named "ID")
4. Analyze a JSON with nested objects -- verify it handles flat extraction
5. Analyze an Excel file with formatted cells (currency, percentages) -- verify normalization
6. Analyze a CSV with >50% null values in a column -- verify warning generated
7. Analyze a CSV with all numeric columns -- verify warning "No embeddable columns"

**Expected Result:** Schema detection handles edge cases correctly.

**Coverage:** FR-2.1, FR-2.2, FR-2.4, FR-2.5, FR-2.6

---

### INT-4: Ingestion Worker Pipeline

**Description:** Test the BullMQ worker processes a job correctly with real ClickHouse.

**Preconditions:** Real ClickHouse, Redis, MongoDB connections.

**Steps:**

1. Create a mock IngestionJobData with a valid CSV buffer (10 rows)
2. Enqueue the job on the `structured-data-ingestion` queue
3. Wait for worker to process (poll job status)
4. Verify ClickHouse: data table created with 10 rows
5. Verify ClickHouse: table_metadata entry created
6. Verify MongoDB: SearchChunk created with chunkType = 'table_metadata'
7. Verify BullMQ: embedding job enqueued on QUEUE_EMBEDDING

**Expected Result:** Worker executes full pipeline: parse, chunk, store, embed.

**Coverage:** FR-8.1, FR-8.2, FR-8.3, FR-8.4, FR-4.1, FR-4.2

---

### INT-5: Path Extractor for Hierarchical JSON

**Description:** Test path extraction from deeply nested JSON objects.

**Preconditions:** None (pure computation).

**Steps:**

1. Extract paths from: `{ users: [{ name: "Alice", profile: { email: "a@b.com", tags: ["admin", "user"] } }] }`
2. Assert paths include: `users`, `users[0]`, `users[0].name`, `users[0].profile`, `users[0].profile.email`, `users[0].profile.tags`, `users[0].profile.tags[0]`, `users[0].profile.tags[1]`
3. Assert normalized paths: `users[]`, `users[].name`, `users[].profile.email`, `users[].profile.tags[]`
4. Assert value types: name=string, email=string, tags=array
5. Test max depth limit (set to 3, verify deeper paths are not extracted)
6. Test large array sampling (1500-element array with maxArraySize=1000)
7. Assert statistics: totalPaths, maxDepth, truncatedArrays counts

**Expected Result:** All paths extracted correctly; normalization and limits work.

**Coverage:** FR-7.1, FR-7.3, FR-7.5

---

### INT-6: Table Discovery Keyword Scoring

**Description:** Test table discovery ranks tables correctly by keyword relevance.

**Preconditions:** ClickHouse with test table metadata.

**Steps:**

1. Insert 3 table metadata entries: "products" (electronics catalog), "orders" (customer orders), "reviews" (product reviews)
2. Query "show me product prices" -- expect "products" ranked highest
3. Query "customer order history" -- expect "orders" ranked highest
4. Query "feedback and ratings" -- expect "reviews" ranked highest (matches via description)
5. Query "xyzzy nonsense" -- expect no tables above minScore threshold
6. Query with empty string -- expect all tables with neutral scores

**Expected Result:** Keyword scoring correctly prioritizes relevant tables.

**Coverage:** FR-6.1, FR-6.2, FR-6.3

---

### INT-7: Query Router Heuristic Classification

**Description:** Test query intent classification accuracy across diverse queries.

**Preconditions:** None (pure computation).

**Steps:**

1. SQL queries: "count all orders", "average price greater than 50", "group by category", "sorted by date" -- all should return type=sql
2. Semantic queries: "find similar products", "search for wireless devices", "products described as premium" -- all should return type=semantic
3. Hybrid queries: "find products described as 'wireless' AND price < 100" -- should return type=hybrid
4. Ambiguous queries: "products", "data" -- should default to semantic with lower confidence
5. Assert confidence ranges: sql > 0.6 for clear SQL queries, semantic > 0.6 for clear semantic queries

**Expected Result:** 85%+ accuracy on test query corpus.

**Coverage:** FR-5.1, FR-5.2, FR-5.3, FR-5.4

---

### INT-8: Chunking Strategy Metadata Generation

**Description:** Test that chunking creates correct metadata chunks with representative samples.

**Preconditions:** None (pure computation).

**Steps:**

1. Create a 1000-row dataset with 5 columns (mixed types)
2. Apply chunking strategy
3. Assert: exactly 1 metadataChunk created (type = 'table_metadata')
4. Assert: 0 rowChunks created (100% savings)
5. Assert: metadataChunk.sampleRows has 10-20 entries (evenly spaced)
6. Assert: metadataChunk.columns matches input columns
7. Assert: statistics.savingsPercent = 100
8. Test with 5-row dataset -- sampleRows should contain all 5 rows

**Expected Result:** Metadata-only chunking correctly generates representative samples.

**Coverage:** FR-4.1, FR-4.2, FR-4.3, FR-4.4

---

## 4. Coverage Matrix

| Functional Requirement | E2E Tests     | Integration Tests | Unit Tests (existing)  |
| ---------------------- | ------------- | ----------------- | ---------------------- |
| FR-1 (Ingest API)      | E2E-1,2,3,5,7 | -                 | ingest-api.test.ts     |
| FR-2 (Schema Detect)   | E2E-1         | INT-3             | schema-analyzer.test   |
| FR-3 (ClickHouse)      | E2E-1,4       | INT-1             | clickhouse-client.test |
| FR-4 (Chunking)        | E2E-1         | INT-4, INT-8      | chunking-strategy.test |
| FR-5 (Query Routing)   | E2E-6         | INT-7             | query-router.test      |
| FR-6 (Table Discovery) | -             | INT-6             | table-discovery.test   |
| FR-7 (Path Index)      | -             | INT-5             | path-extractor.test    |
| FR-8 (Worker)          | E2E-1         | INT-4             | ingestion-worker.test  |
| FR-9 (Cache)           | E2E-5         | INT-2             | analysis-cache.test    |
| NFR-5 (Tenant Iso)     | E2E-4         | INT-1             | -                      |
| NFR-7 (Retry)          | E2E-1         | INT-4             | -                      |

---

## 5. Test Data Fixtures

| Fixture           | Format | Rows | Columns | Purpose                                    |
| ----------------- | ------ | ---- | ------- | ------------------------------------------ |
| products.csv      | CSV    | 5    | 5       | Basic CSV ingestion, FK detection          |
| orders.csv        | CSV    | 20   | 6       | FK relationships, date types, aggregations |
| users.json        | JSON   | 10   | 4       | JSON array ingestion                       |
| employees.xlsx    | XLSX   | 10   | 5       | Excel parsing, formatted cells             |
| nested-data.json  | JSON   | 1    | nested  | Hierarchical path extraction               |
| large-dataset.csv | CSV    | 1000 | 5       | Performance and chunking strategy          |
| edge-cases.csv    | CSV    | 100  | 7       | ZIP codes, nulls, mixed types              |

---

## 6. Infrastructure Requirements

| Service    | Version | Purpose                  | Test Setup                             |
| ---------- | ------- | ------------------------ | -------------------------------------- |
| ClickHouse | 23.8+   | Structured data storage  | Docker container on random port        |
| Redis      | 7.0+    | Analysis cache           | Docker container or MongoMemoryServer  |
| MongoDB    | 6.0+    | SearchChunk, SearchIndex | MongoMemoryServer or Docker            |
| BullMQ     | 4.x     | Job queue                | Real Redis connection                  |
| Express    | 4.x     | HTTP API server          | Started on random port (`{ port: 0 }`) |

---

## 7. Test Execution Notes

- All E2E tests must start a real Express server with full middleware chain (auth, rate limiting, tenant isolation)
- ClickHouse integration tests require `CLICKHOUSE_URL` env var (or default localhost:8123)
- Redis integration tests require `REDIS_URL` env var (or default localhost:6379)
- Tests that modify ClickHouse tables must clean up after themselves (drop test tables)
- Test tenant IDs should use unique prefixes to avoid collision: `test-tenant-{random}`
- Existing unit tests (13 test files) provide baseline coverage; E2E/integration tests validate real infrastructure
