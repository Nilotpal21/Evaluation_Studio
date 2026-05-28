# LLD & Implementation Plan: Structured Data (#38)

**Feature:** Structured Data Extraction, Storage & Querying
**Created:** 2026-03-22
**Feature Spec:** `docs/features/structured-data.md`
**Test Spec:** `docs/testing/structured-data.md`
**HLD:** `docs/specs/structured-data.hld.md`

---

## Overview

This implementation plan addresses the 7 incomplete components identified in the feature spec. The existing codebase already has a strong foundation (11 completed components). This plan focuses on closing the remaining gaps to bring the feature from ALPHA to BETA status.

**Tech Stack:** TypeScript, Express, ClickHouse, Redis, MongoDB, BullMQ, Vitest

**Completed Foundation (no work needed):**

- Schema Analyzer (CSV, JSON, Excel parsing + type detection)
- ClickHouse Client (CRUD operations, tenant isolation)
- Chunking Strategy (metadata-only, 100% savings)
- Analysis Cache (Redis with gzip compression)
- Ingest Routes (analyze, finalize, job status)
- Ingestion Worker (BullMQ with retry)
- Path Extractor (hierarchical JSON indexing)
- Types and Ingestion Types

---

## Phase Overview

| Phase | Name                        | Description                                                      | Exit Criteria                       | Estimated Effort |
| ----- | --------------------------- | ---------------------------------------------------------------- | ----------------------------------- | ---------------- |
| 1     | Observability & Security    | Replace console.log, strengthen SQL validation, add health check | Zero console.log, parameterized SQL | 1 day            |
| 2     | Table Management API        | REST endpoints for list/get/delete tables                        | 3 endpoints passing E2E tests       | 1 day            |
| 3     | Text-to-SQL Query Execution | LLM-based SQL generation from natural language                   | SQL queries return real results     | 2 days           |
| 4     | Query REST API              | REST endpoint for executing structured data queries              | Query API returns results via HTTP  | 1 day            |
| 5     | Cascade Delete & Compliance | Cascade delete (ClickHouse + MongoDB), audit logging             | Delete cleans all stores            | 1 day            |
| 6     | E2E Test Suite              | Real infrastructure E2E tests per test spec                      | 7 E2E + 8 integration passing       | 2 days           |

---

## Phase 1: Observability & Security Hardening

**Goal:** Replace all console.log with platform logger, strengthen SQL injection prevention, add ClickHouse health check.

### Task 1.1: Replace console.log with createLogger

**Files to modify:**

- `apps/search-ai/src/services/structured-data/clickhouse-client.ts` (lines 69, 93, 262)
- `apps/search-ai/src/services/structured-data/schema-analyzer.ts` (no console.log -- clean)
- `apps/search-ai/src/services/structured-data/chunking-strategy.ts` (line 117)
- `apps/search-ai/src/services/structured-data/query-router.ts` (lines 236, 254, 274, 293)
- `apps/search-ai/src/services/structured-data/table-discovery.ts` (lines 67, 76, 88, 99, 114)
- `apps/search-ai/src/routes/structured-data-ingest.ts` (lines 106, 122, 216, 232, 265, 350)

**Implementation:**

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('structured-data');

// Replace: console.log('[structured-data-ingest] ...')
// With:    log.info('message', { context })
```

**Exit Criteria:**

- [ ] Zero `console.log` or `console.error` in any structured-data source file
- [ ] All log calls use `log.info('message', { context })` format (NOT pino-style)
- [ ] Build passes: `pnpm build --filter=search-ai`

### Task 1.2: Strengthen SQL Injection Prevention in executeQuery

**File:** `apps/search-ai/src/services/structured-data/clickhouse-client.ts` (line 226-238)

**Current (weak):**

```typescript
if (!sql.includes('tenant_id') || !sql.includes('index_id')) {
  throw new Error('SECURITY_VIOLATION: SQL must include tenant_id and index_id filters');
}
```

**Problem:** An attacker could include these strings in a SQL comment while querying other tenants' data.

**New approach:**

```typescript
async executeQuery(
  tenantId: string,
  indexId: string,
  sql: string,
  params?: Record<string, any>,
): Promise<any[]> {
  // 1. Parse SQL to validate it's a SELECT (no INSERT/UPDATE/DELETE/DROP)
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) {
    throw new Error('SECURITY_VIOLATION: Only SELECT queries are allowed');
  }

  // 2. Blocklist dangerous keywords
  const blocked = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE'];
  for (const kw of blocked) {
    // Check for keyword as a standalone word (not part of column name)
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(sql)) {
      throw new Error(`SECURITY_VIOLATION: ${kw} statements are not allowed`);
    }
  }

  // 3. Force tenant_id and index_id into WHERE clause via parameterized injection
  // Instead of trusting user-supplied SQL, wrap it with mandatory filters
  const wrappedSql = `
    SELECT * FROM (${sql}) AS __inner
    WHERE __inner.tenant_id = {tenantId:String}
      AND __inner.index_id = {indexId:String}
  `;

  const result = await this.client.query({
    query: wrappedSql,
    query_params: { tenantId, indexId, ...params },
    format: 'JSONEachRow',
  });

  return (await result.json()) as any;
}
```

**Exit Criteria:**

- [ ] Only SELECT statements allowed
- [ ] Blocked keywords (DROP, DELETE, INSERT, etc.) rejected
- [ ] Tenant/index filters injected via wrapping, not trusted from user SQL
- [ ] Unit tests for SQL validation edge cases

### Task 1.3: Sanitize Dynamic Table Names

**File:** `apps/search-ai/src/services/structured-data/clickhouse-client.ts` (line 387-391)

**Current:**

```typescript
private getDataTableName(tableId: string): string {
  const sanitized = tableId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `structured_data_${sanitized}`;
}
```

**Enhancement:** Add length validation and prefix check:

```typescript
private getDataTableName(tableId: string): string {
  const sanitized = tableId.replace(/[^a-zA-Z0-9_]/g, '_');
  if (sanitized.length === 0 || sanitized.length > 128) {
    throw new Error(`Invalid tableId length: ${tableId.length}`);
  }
  return `structured_data_${sanitized}`;
}
```

**Exit Criteria:**

- [ ] Empty and oversized tableIds rejected
- [ ] Unit test for edge cases

### Task 1.4: Add ClickHouse Health Check

**File to create:** Integration into existing health route or as a new check.

**Implementation:** Add `isClickHouseHealthy()` method to ClickHouseClient that runs `SELECT 1` and returns boolean. Wire into the `/health` endpoint.

**Exit Criteria:**

- [ ] Health endpoint includes ClickHouse status
- [ ] Graceful degradation when ClickHouse is down

---

## Phase 2: Table Management API

**Goal:** REST endpoints for listing, getting, and deleting structured data tables.

### Task 2.1: Create Table Management Routes

**File to create:** `apps/search-ai/src/routes/structured-data-tables.ts`

**Endpoints:**

```
GET    /api/indexes/:indexId/tables         -- List all tables
GET    /api/indexes/:indexId/tables/:tableId -- Get table details
DELETE /api/indexes/:indexId/tables/:tableId -- Delete table
```

**Implementation notes:**

- Use existing `StructuredDataClickHouseClient` and `TableDiscoveryService`
- All endpoints require `req.tenantContext` and validate index ownership
- DELETE cascades: ClickHouse (data table + metadata) + MongoDB (SearchChunk where chunkType='table_metadata' and metadata.tableId)
- Response format: `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`

### Task 2.2: Wire Routes into Server

**File:** `apps/search-ai/src/server.ts`

**Add:**

```typescript
import structuredDataTablesRouter from './routes/structured-data-tables.js';
app.use('/api/indexes', structuredDataTablesRouter);
```

**Exit Criteria:**

- [ ] GET /tables returns list of tables with schema info
- [ ] GET /tables/:tableId returns single table details
- [ ] DELETE /tables/:tableId removes ClickHouse data + metadata + MongoDB chunk
- [ ] All endpoints enforce tenant isolation
- [ ] Integration tests passing

---

## Phase 3: Text-to-SQL Query Execution

**Goal:** Implement LLM-based SQL generation so query router returns real results for SQL-intent queries.

### Task 3.1: Implement Text-to-SQL Service

**File to create/complete:** `apps/search-ai/src/services/structured-data/text-to-sql.ts`

**Design:**

1. Accept natural language query + table metadata (schema, sample rows)
2. Construct a prompt for the LLM with: table schema, column types, sample rows, foreign keys
3. LLM generates a ClickHouse-compatible SQL query
4. Validate generated SQL (SELECT only, no dangerous keywords)
5. Execute via ClickHouseClient.executeQuery() with mandatory tenant/index filters
6. Return results + generated SQL

**Prompt template:**

```
You are a SQL query generator for ClickHouse. Given the table schema and natural language question, generate a SQL SELECT query.

Table: {tableName} ({displayName})
Description: {description}
Columns:
{columns formatted as: - column_name (type) [filterable/embeddable] description}

Sample rows:
{3-5 sample rows as JSON}

Foreign keys:
{foreign key relationships}

Rules:
- Generate ClickHouse-compatible SQL only
- Always include WHERE tenant_id = {tenantId:String} AND index_id = {indexId:String}
- Use parameterized values for tenant_id and index_id
- The data table name is: structured_data_{tableId}
- Row data is stored in a JSON column called row_data
- Access fields via: JSONExtractString(row_data, 'field_name') or JSONExtractFloat64(row_data, 'field_name')
- Only generate SELECT queries

Question: {userQuery}
```

**LLM Integration:**

- Use the SearchAI LLM credential resolution (existing pattern)
- Fall back to keyword-based SQL generation if LLM is unavailable

### Task 3.2: Wire Text-to-SQL into Query Router

**File:** `apps/search-ai/src/services/structured-data/query-router.ts`

**Replace empty `executeSQLQuery()` and `executeHybridQuery()` implementations with real execution:**

```typescript
private async executeSQLQuery(
  request: StructuredDataQueryRequest,
  tables: TableMetadata[],
): Promise<{ results: StructuredDataResult[]; sql: string }> {
  const textToSql = new TextToSQLService(this.clickhouseClient);
  return textToSql.generateAndExecute(request, tables);
}
```

**Exit Criteria:**

- [ ] SQL-intent queries generate and execute real SQL
- [ ] Generated SQL uses ClickHouse JSON functions correctly
- [ ] Results include actual row data from ClickHouse
- [ ] Tenant isolation enforced in generated SQL
- [ ] Integration test: "count all products" returns correct count

---

## Phase 4: Query REST API

**Goal:** REST endpoint for executing structured data queries via HTTP.

### Task 4.1: Create Query Route

**File to create:** `apps/search-ai/src/routes/structured-data-query.ts`

**Endpoint:**

```
POST /api/indexes/:indexId/query
Content-Type: application/json

Request:
{
  "query": "how many products cost more than $100?",
  "tableId": "optional-specific-table",
  "limit": 50,
  "offset": 0
}

Response:
{
  "success": true,
  "data": {
    "queryId": "qry_...",
    "intent": { "type": "sql", "confidence": 0.85, "reasoning": "..." },
    "results": [
      {
        "tableId": "...",
        "tableName": "products",
        "rowNumber": 0,
        "rowData": { "count": 42 },
        "score": 1.0
      }
    ],
    "totalCount": 1,
    "executionTimeMs": 150,
    "sqlGenerated": "SELECT count() FROM ..."
  }
}
```

### Task 4.2: Wire into Server

**File:** `apps/search-ai/src/server.ts`

```typescript
import structuredDataQueryRouter from './routes/structured-data-query.js';
app.use('/api/indexes', structuredDataQueryRouter);
```

**Exit Criteria:**

- [ ] POST /query returns results for SQL-intent queries
- [ ] POST /query returns results for semantic-intent queries (or empty with explanation)
- [ ] Tenant isolation enforced
- [ ] Error handling for invalid queries, missing tables
- [ ] Response time < 5s for simple queries

---

## Phase 5: Cascade Delete & Compliance

**Goal:** Ensure table deletion cleans all stores; add basic audit logging.

### Task 5.1: Implement Cascade Delete

**Cascade flow:**

1. Delete ClickHouse data table: `DROP TABLE IF EXISTS structured_data_{tableId}`
2. Delete ClickHouse metadata: `DELETE FROM table_metadata WHERE table_id = {tableId} AND tenant_id = {tenantId}`
3. Delete MongoDB SearchChunk: `SearchChunk.deleteMany({ chunkType: 'table_metadata', 'metadata.tableId': tableId, tenantId })`
4. Delete ClickHouse path index entries: `DELETE FROM json_path_index WHERE object_id = {tableId} AND tenant_id = {tenantId}`

**File:** Extend `StructuredDataClickHouseClient.deleteTable()` or create a new `StructuredDataLifecycleService`.

### Task 5.2: Add Basic Audit Logging

**Log structured data operations:**

- Table created (ingestion finalized): who, when, table name, row count
- Table deleted: who, when, table ID
- Query executed: who, when, query text, intent type, execution time

**Implementation:** Use platform logger with a dedicated `structured-data-audit` module. Log to structured format that can be forwarded to an audit store.

**Exit Criteria:**

- [ ] Table delete removes data from all 3 stores (ClickHouse, MongoDB, optionally path index)
- [ ] Audit log entries emitted for create, delete, and query operations
- [ ] Integration test: delete table, verify all stores are clean

---

## Phase 6: E2E Test Suite

**Goal:** Implement the 7 E2E and 8 integration test scenarios from the test spec.

### Task 6.1: E2E Test Infrastructure

**File to create:** `apps/search-ai/src/__tests__/structured-data/e2e/setup.ts`

**Setup:**

- Start real Express server on random port with full middleware chain
- Connect to real ClickHouse, Redis, MongoDB (docker-compose)
- Create test tenant context
- Create test search index

### Task 6.2: Implement E2E Tests

**Files to create:**

- `apps/search-ai/src/__tests__/structured-data/e2e/csv-lifecycle.e2e.test.ts` (E2E-1)
- `apps/search-ai/src/__tests__/structured-data/e2e/json-ingestion.e2e.test.ts` (E2E-2)
- `apps/search-ai/src/__tests__/structured-data/e2e/excel-ingestion.e2e.test.ts` (E2E-3)
- `apps/search-ai/src/__tests__/structured-data/e2e/tenant-isolation.e2e.test.ts` (E2E-4)
- `apps/search-ai/src/__tests__/structured-data/e2e/cache-expiration.e2e.test.ts` (E2E-5)
- `apps/search-ai/src/__tests__/structured-data/e2e/query-routing.e2e.test.ts` (E2E-6)
- `apps/search-ai/src/__tests__/structured-data/e2e/error-handling.e2e.test.ts` (E2E-7)

### Task 6.3: Implement Integration Tests

**Files to create:**

- `apps/search-ai/src/__tests__/structured-data/integration/clickhouse-lifecycle.integration.test.ts` (INT-1)
- `apps/search-ai/src/__tests__/structured-data/integration/redis-cache.integration.test.ts` (INT-2)
- Remaining integration tests (INT-3 through INT-8) either already exist as unit tests or should be added.

**Exit Criteria:**

- [ ] All 7 E2E tests passing with real infrastructure
- [ ] All 8 integration tests passing
- [ ] No vi.mock() in any E2E test file
- [ ] All tests interact via HTTP API only (no direct DB access in E2E)
- [ ] Test cleanup: all ClickHouse test tables dropped after test run

---

## Wiring Checklist

Every new file or route must be wired into the application. Verify:

| Component                 | Wired Into                               | Verified |
| ------------------------- | ---------------------------------------- | -------- |
| structured-data-tables.ts | server.ts `app.use()` route mount        | [ ]      |
| structured-data-query.ts  | server.ts `app.use()` route mount        | [ ]      |
| text-to-sql.ts            | query-router.ts `executeSQLQuery()`      | [ ]      |
| ClickHouse health check   | health route or middleware               | [ ]      |
| Cascade delete            | table management DELETE endpoint         | [ ]      |
| Audit logging             | ingest routes, table routes, query route | [ ]      |

---

## Dependencies Between Phases

```
Phase 1 (Security) ──────────────────────────────┐
                                                   │
Phase 2 (Table Mgmt) ──────► Phase 5 (Cascade) ──┤
                                                   │
Phase 3 (Text-to-SQL) ──► Phase 4 (Query API) ───┤
                                                   │
                                                   ▼
                                            Phase 6 (E2E Tests)
```

- Phase 1 can run independently
- Phase 2 and Phase 3 can run in parallel
- Phase 4 depends on Phase 3
- Phase 5 depends on Phase 2
- Phase 6 depends on all other phases

---

## Risk Mitigation

| Risk                                               | Mitigation                                                    |
| -------------------------------------------------- | ------------------------------------------------------------- |
| LLM-generated SQL has incorrect ClickHouse syntax  | Validate generated SQL, fall back to keyword-based generation |
| ClickHouse JSON functions differ from standard SQL | Include ClickHouse-specific examples in the LLM prompt        |
| E2E tests flaky due to ClickHouse startup time     | Use health check polling before test execution                |
| Cascade delete partially fails                     | Implement as transaction-like sequence with rollback logging  |
| Text-to-SQL generates queries that time out        | Add 30s query timeout, return partial results or error        |
