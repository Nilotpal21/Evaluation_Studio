# Custom Events & External Events -- Low-Level Design

**Status**: STABLE
**Feature Spec**: [../features/custom-external-events.md](../features/custom-external-events.md)
**HLD**: [../specs/custom-external-events.hld.md](../specs/custom-external-events.hld.md)
**Testing Guide**: [../testing/custom-external-events.md](../testing/custom-external-events.md)
**Last Updated**: 2026-03-22

---

## Task T-1: ClickHouse DDL

### Files

- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` -- DDL for `custom_events`, `external_events`, `conversation_tags`, `mv_daily_custom_events`

### Table Definitions

**`abl_platform.custom_events`**:

- Columns: `tenant_id`, `project_id`, `session_id`, `event_name`, `properties` (JSON string), `timestamp` (DateTime64(3)), `inserted_at` (DateTime64(3) DEFAULT now64(3))
- Engine: ReplacingMergeTree(inserted_at)
- Partition: (tenant_id, toYYYYMM(timestamp))
- Order: (tenant_id, project_id, event_name, timestamp, session_id)
- TTL: 730 days
- Note: `event_id` is inserted by route code but is NOT defined in DDL (GAP-001)

**`abl_platform.external_events`**:

- Columns: `tenant_id`, `project_id`, `event_type` (LowCardinality), `event_id`, `title`, `description`, `properties` (JSON string), `timestamp` (DateTime64(3)), `duration_minutes` (Nullable UInt32), `severity` (Nullable String), `inserted_at` (DateTime64(3) DEFAULT now64(3))
- Engine: ReplacingMergeTree(inserted_at)
- Partition: (tenant_id, toYYYYMM(timestamp))
- Order: (tenant_id, project_id, event_type, timestamp)
- TTL: 730 days

**`abl_platform.mv_daily_custom_events`** (Materialized View):

- Engine: SummingMergeTree()
- Source: `abl_platform.custom_events`
- Columns: `tenant_id`, `project_id`, `event_name`, `day` (toDate), `event_count` (count), `unique_sessions` (uniqExact)
- Partition: (tenant_id, toYYYYMM(day))
- Order: (tenant_id, project_id, event_name, day)

---

## Task T-2: Custom Events Route

### Files

- `apps/runtime/src/routes/custom-events.ts` -- 304 lines, 4 endpoints

### Endpoints

**POST /emit** -- Record a custom business event

- Permission: `session:write`
- Validation: `eventName` (string, required), `sessionId` (string, required), `properties` (optional object)
- Generates `eventId` via `crypto.randomUUID()`
- Inserts into `abl_platform.custom_events` via ClickHouse JSONEachRow
- Returns `{ success: true, data: { eventId } }`

**GET /summary** -- Aggregated event counts by name

- Permission: `session:read`
- Query params: `days` (default 30)
- SQL: GROUP BY `event_name`, aggregates `count()`, `uniqExact(session_id)`, `min/max(timestamp)`
- Note: `days` interpolated into SQL via `${days}`, safe via `Number()` coercion

**GET /timeseries** -- Daily event volume for specific event

- Permission: `session:read`
- Query params: `eventName` (required), `days` (default 30)
- SQL: GROUP BY `toDate(timestamp)`, returns daily counts and unique sessions

**GET /conversion** -- Conversion rate between paired events

- Permission: `session:read`
- Query params: `offerEvent` (required), `acceptEvent` (required), `days` (default 30)
- SQL: Uses `countDistinctIf` for session-level conversion
- Returns `{ offer_sessions, accept_sessions, conversion_rate }`

---

## Task T-3: External Events Route

### Files

- `apps/runtime/src/routes/external-events.ts` -- 470 lines, 4 endpoints

### Constants

- `VALID_EVENT_TYPES`: `deployment`, `incident`, `crm_update`, `benchmark`, `product_release`, `outage`, `custom`
- `MAX_BATCH_SIZE`: 100
- `METRIC_MAP`: Maps `avg_sentiment`, `avg_quality`, `conversation_count` to MV table and aggregation columns

### Endpoints

**POST /** -- Ingest single external event

- Permission: `project:write`
- Validation: `eventType` (valid set), `title` (string, required), optional `description`, `properties`, `timestamp`, `durationMinutes`, `severity`
- Generates `eventId` via `ext-{timestamp}-{random}` format
- Inserts into `abl_platform.external_events`

**POST /batch** -- Batch ingest (max 100)

- Permission: `project:write`
- Validates: `events` is non-empty array, length <= 100, all events have valid `eventType` + `title`
- All events validated before any insert (all-or-nothing validation)
- Single batch insert into ClickHouse

**GET /** -- List external events

- Permission: `session:read`
- Query params: `eventType` (optional filter), `days` (default 90)
- Results: LIMIT 200, ORDER BY timestamp DESC
- Builds dynamic query string with optional `eventType` filter

**GET /correlate** -- Correlate events with metric timeseries

- Permission: `session:read`
- Query params: `metric` (required, from METRIC_MAP), `eventType` (required), `days` (default 30), `windowHours` (default 24)
- Two parallel queries: (1) external events, (2) metric timeseries from MV
- Returns `{ events, timeseries, windowHours }`
- Note: `windowHours` included in response but NOT used in query logic (GAP-005)

---

## Task T-4: Semantic Layer

### Files

- `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts` -- metadata for `conversation_tags` and `external_events` tables registered for NL analytics

---

## Task T-5: Server Wiring

### Files

- `apps/runtime/src/server.ts` -- import and mount at lines 103-104 (imports) and 523-524 (mounts)

### Mount Points

```typescript
app.use('/api/projects/:projectId/custom-events', customEventsRouter);
app.use('/api/projects/:projectId/external-events', externalEventsRouter);
```

---

## Known Gaps

| ID      | Description                                                                                                       | Severity |
| ------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| GAP-001 | `event_id` column inserted into `custom_events` but not in DDL schema                                             | Medium   |
| GAP-002 | Zero test files for both custom events and external events                                                        | Critical |
| GAP-003 | `days` param interpolated into SQL string (safe via Number() but unparameterized)                                 | Low      |
| GAP-004 | No idempotency mechanism for event ingestion                                                                      | Medium   |
| GAP-005 | `windowHours` in correlate response but not used in query                                                         | Low      |
| GAP-006 | No pagination for summary or timeseries endpoints                                                                 | Low      |
| GAP-007 | Error responses inconsistent -- custom-events uses bare string, external-events uses structured { code, message } | Low      |

---

## Dependencies

- `@agent-platform/database/clickhouse` -- ClickHouse client access
- `@agent-platform/openapi/express` -- OpenAPI router creation
- `@agent-platform/shared-auth` -- `requireProjectScope`
- `@abl/compiler/platform` -- `createLogger`
- `apps/runtime/src/middleware/auth.js` -- `authMiddleware`
- `apps/runtime/src/middleware/rate-limiter.js` -- `tenantRateLimit`
- `apps/runtime/src/middleware/rbac.js` -- `requireProjectPermission`

---

## Exit Criteria

- All routes return correct data shapes for valid inputs
- All validation rejects invalid inputs with appropriate 400 error codes
- ClickHouse queries include `tenant_id` and `project_id` in WHERE clause
- `max_execution_time = 10` set on all analytical queries
- Batch ingestion validates all events before inserting any
- GAP-001 should be investigated: either add `event_id` to DDL or remove from insert
