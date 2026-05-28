# ClickHouse Integration Changelog

All changes made to integrate ClickHouse as the persistence backend for high-volume time-series data (messages, traces, metrics, audit events, facts).

---

## 1. Schema Alignment: Prisma (SQLite) to ClickHouse

Every Prisma model field has been mapped to a corresponding ClickHouse column. The table below documents the exact field-by-field mapping.

### 1.1 Message (Prisma) → messages (ClickHouse)

| Prisma Field | Prisma Type                   | CH Column     | CH Type                                     | Notes                                 |
| ------------ | ----------------------------- | ------------- | ------------------------------------------- | ------------------------------------- |
| `id`         | `String @id @default(cuid())` | `message_id`  | `String CODEC(NONE)`                        | Renamed; CUID → UUID in CH            |
| `sessionId`  | `String`                      | `session_id`  | `String CODEC(ZSTD(1))`                     | Part of ORDER BY                      |
| `tenantId`   | `String?`                     | `tenant_id`   | `String CODEC(ZSTD(1))`                     | Required in CH (no Nullable)          |
| `role`       | `String`                      | `role`        | `LowCardinality(String)`                    | user/assistant/system/tool            |
| `content`    | `String`                      | `content`     | `String CODEC(NONE)`                        | **Encrypted** (compress-then-encrypt) |
| `channel`    | `String`                      | `channel`     | `LowCardinality(String)`                    | web/voice/sms/whatsapp                |
| `traceId`    | `String?`                     | `trace_id`    | `String DEFAULT ''`                         | Empty string instead of NULL          |
| `hasPII`     | `Boolean @default(false)`     | `has_pii`     | `UInt8 DEFAULT 0`                           | Boolean → UInt8                       |
| `scrubbed`   | `Boolean @default(false)`     | `scrubbed`    | `UInt8 DEFAULT 0`                           | Boolean → UInt8                       |
| `metadata`   | `String @default("{}")`       | `metadata`    | `String DEFAULT '{}' CODEC(ZSTD(3))`        | Plaintext JSON (queryable)            |
| `timestamp`  | `DateTime @default(now())`    | `created_at`  | `DateTime64(3) CODEC(DoubleDelta, ZSTD(1))` | Renamed; millisecond precision        |
| —            | —                             | `contact_id`  | `String DEFAULT ''`                         | **Extra in CH** for GDPR lookups      |
| —            | —                             | `encrypted`   | `UInt8 DEFAULT 1`                           | **Extra in CH** encryption flag       |
| —            | —                             | `key_version` | `UInt16 DEFAULT 1`                          | **Extra in CH** for key rotation      |

### 1.2 LLMUsageMetric (Prisma) → llm_metrics (ClickHouse)

| Prisma Field    | Prisma Type                   | CH Column         | CH Type                                     | Notes                              |
| --------------- | ----------------------------- | ----------------- | ------------------------------------------- | ---------------------------------- |
| `id`            | `String @id @default(cuid())` | —                 | —                                           | Not needed in CH (no primary key)  |
| `sessionId`     | `String`                      | `session_id`      | `String CODEC(ZSTD(1))`                     |                                    |
| `projectId`     | `String`                      | `project_id`      | `String CODEC(ZSTD(1))`                     |                                    |
| `userId`        | `String`                      | `user_id`         | `String DEFAULT '' CODEC(ZSTD(1))`          | Added in this PR                   |
| `tenantId`      | `String?`                     | `tenant_id`       | `String CODEC(ZSTD(1))`                     | Required in CH                     |
| `modelId`       | `String`                      | `model_id`        | `LowCardinality(String)`                    | Part of ORDER BY                   |
| `provider`      | `String`                      | `provider`        | `LowCardinality(String)`                    | Part of ORDER BY                   |
| `operationType` | `String?`                     | `operation_type`  | `LowCardinality(String) DEFAULT ''`         |                                    |
| `agentName`     | `String?`                     | `agent_name`      | `LowCardinality(String) DEFAULT ''`         |                                    |
| `inputTokens`   | `Int`                         | `input_tokens`    | `UInt32 CODEC(T64, ZSTD(1))`                |                                    |
| `outputTokens`  | `Int`                         | `output_tokens`   | `UInt32 CODEC(T64, ZSTD(1))`                |                                    |
| `totalTokens`   | `Int`                         | `total_tokens`    | `UInt32 CODEC(T64, ZSTD(1))`                |                                    |
| `estimatedCost` | `Float?`                      | `estimated_cost`  | `Float64 DEFAULT 0 CODEC(Gorilla, ZSTD(1))` |                                    |
| `latencyMs`     | `Int`                         | `latency_ms`      | `UInt32 CODEC(T64, ZSTD(1))`                |                                    |
| `streamingUsed` | `Boolean @default(false)`     | `streaming_used`  | `UInt8 DEFAULT 0`                           | Boolean → UInt8                    |
| `toolCallCount` | `Int @default(0)`             | `tool_call_count` | `UInt8 DEFAULT 0`                           |                                    |
| `createdAt`     | `DateTime @default(now())`    | `timestamp`       | `DateTime64(3)`                             | Renamed                            |
| —               | —                             | `success`         | `UInt8 DEFAULT 1`                           | **Extra in CH** for error tracking |
| —               | —                             | `error_type`      | `LowCardinality(String) DEFAULT ''`         | **Extra in CH**                    |

### 1.3 AuditLog (Prisma) → audit_events (ClickHouse)

| Prisma Field | Prisma Type                   | CH Column          | CH Type                                 | Notes                     |
| ------------ | ----------------------------- | ------------------ | --------------------------------------- | ------------------------- |
| `id`         | `String @id @default(cuid())` | `event_id`         | `String CODEC(NONE)`                    | Renamed                   |
| `userId`     | `String?`                     | `actor_id`         | `String DEFAULT ''`                     | Renamed                   |
| `tenantId`   | `String?`                     | `tenant_id`        | `String CODEC(ZSTD(1))`                 | Required in CH            |
| `action`     | `String`                      | `action`           | `LowCardinality(String)`                | Part of ORDER BY          |
| `ip`         | `String?`                     | `actor_ip`         | `String DEFAULT ''`                     | Renamed                   |
| `userAgent`  | `String?`                     | `actor_user_agent` | `String DEFAULT ''`                     | Added in this PR          |
| `metadata`   | `String?`                     | `metadata`         | `String DEFAULT '{}' CODEC(ZSTD(3))`    |                           |
| `createdAt`  | `DateTime @default(now())`    | `timestamp`        | `DateTime CODEC(Delta, ZSTD(1))`        | Renamed; second precision |
| —            | —                             | `actor_type`       | `LowCardinality(String) DEFAULT 'user'` | **Extra in CH**           |
| —            | —                             | `resource_type`    | `LowCardinality(String) DEFAULT ''`     | **Extra in CH**           |
| —            | —                             | `resource_id`      | `String DEFAULT ''`                     | **Extra in CH**           |
| —            | —                             | `session_id`       | `String DEFAULT ''`                     | **Extra in CH**           |
| —            | —                             | `project_id`       | `String DEFAULT ''`                     | **Extra in CH**           |
| —            | —                             | `old_value`        | `String DEFAULT '' CODEC(ZSTD(3))`      | **Extra in CH**           |
| —            | —                             | `new_value`        | `String DEFAULT '' CODEC(ZSTD(3))`      | **Extra in CH**           |
| —            | —                             | `success`          | `UInt8 DEFAULT 1`                       | **Extra in CH**           |
| —            | —                             | `failure_reason`   | `String DEFAULT ''`                     | **Extra in CH**           |

### 1.4 Fact (Prisma) → facts (ClickHouse) — Exact Match

| Prisma Field      | Prisma Type                   | CH Column           | CH Type                                   | Notes                      |
| ----------------- | ----------------------------- | ------------------- | ----------------------------------------- | -------------------------- |
| `id`              | `String @id @default(cuid())` | `id`                | `String CODEC(NONE)`                      |                            |
| `key`             | `String @unique`              | `key`               | `String CODEC(ZSTD(1))`                   | ORDER BY column            |
| `value`           | `String`                      | `value`             | `String CODEC(ZSTD(3))`                   | JSON serialized            |
| `createdAt`       | `DateTime @default(now())`    | `created_at`        | `DateTime64(3)`                           |                            |
| `updatedAt`       | `DateTime @updatedAt`         | `updated_at`        | `DateTime64(3)`                           | ReplacingMergeTree version |
| `expiresAt`       | `DateTime?`                   | `expires_at`        | `Nullable(DateTime64(3))`                 | Only Nullable in schema    |
| `sourceType`      | `String @default("system")`   | `source_type`       | `LowCardinality(String) DEFAULT 'system'` |                            |
| `sourceAgentName` | `String?`                     | `source_agent_name` | `String DEFAULT ''`                       |                            |
| `sourceSessionId` | `String?`                     | `source_session_id` | `String DEFAULT ''`                       |                            |
| `sourceTraceId`   | `String?`                     | `source_trace_id`   | `String DEFAULT ''`                       |                            |
| `metadata`        | `String @default("{}")`       | `metadata`          | `String DEFAULT '{}' CODEC(ZSTD(3))`      |                            |

### 1.5 Traces — No Prisma Model (CH only)

Traces were previously in-memory only (`InMemoryTraceStore`). ClickHouse adds persistent storage with 14 columns: `tenant_id`, `session_id`, `trace_id`, `timestamp`, `span_id`, `parent_span_id`, `event_type`, `agent_name`, `data` (encrypted), `encrypted`, `key_version`, `duration_ms`, `has_error`, `error_message`, `node_id`, `sequence`.

### 1.6 Logs — No Prisma Model (CH only)

Application logs were console-based. ClickHouse adds structured log storage with 8 columns: `tenant_id`, `timestamp`, `service`, `level`, `session_id`, `request_id`, `message`, `data`.

---

## 2. Files Modified

### 2.1 New Files Created

| File                                                           | Purpose                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/runtime/src/services/stores/clickhouse-message-store.ts` | MessageStore impl — encrypts content, uses BufferedWriter                      |
| `apps/runtime/src/services/stores/clickhouse-metrics-store.ts` | MetricsStore impl — no encryption, batched inserts                             |
| `apps/runtime/src/services/stores/clickhouse-trace-store.ts`   | TraceStore impl — encrypts `data` column                                       |
| `apps/runtime/src/services/stores/clickhouse-audit-store.ts`   | AuditStore impl — no encryption (compliance)                                   |
| `apps/runtime/src/services/stores/clickhouse-fact-store.ts`    | FactStore impl — ReplacingMergeTree, FINAL dedup                               |
| `apps/runtime/src/services/stores/clickhouse-store-factory.ts` | Factory for creating ClickHouse stores                                         |
| `apps/runtime/src/__tests__/clickhouse-stores.test.ts`         | 45 unit tests for message/metrics/trace/audit stores                           |
| `apps/runtime/src/__tests__/clickhouse-fact-store.test.ts`     | 32 unit tests for fact store                                                   |
| `apps/runtime/src/__tests__/clickhouse-enterprise.test.ts`     | Enterprise hardening tests                                                     |
| `apps/runtime/src/__tests__/encryption-service.test.ts`        | Tests for compress-then-encrypt pipeline                                       |
| `packages/database/src/clickhouse.ts`                          | ClickHouse client singleton + BufferedClickHouseWriter                         |
| `packages/database/src/clickhouse-schemas/init.ts`             | DDL generation for all 8 tables + 2 materialized views                         |
| `packages/database/src/__tests__/clickhouse-writer.test.ts`    | BufferedWriter unit tests                                                      |
| `scripts/clickhouse-init/01-init.sql`                          | Raw SQL DDL (for manual init)                                                  |
| `scripts/clickhouse-init/storage.xml`                          | Tiered storage config (hot/warm/cold + S3)                                     |
| `docs/db/CLICKHOUSE_INTEGRATION.md`                            | Integration guide                                                              |
| `docs/DATA_ARCHITECTURE.md`                                    | Consolidated data architecture reference (Section 5: all ClickHouse table DDL) |

### 2.2 Files Modified

| File                                                     | Change Summary                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/encryption-service.ts`        | Added `TenantKeyCache` (LRU, 1000 entries, 30min TTL), `compressAndEncryptForTenant()`, `decryptAndDecompressForTenant()` with ZSTD + Base64                        |
| `apps/runtime/src/websocket/handler.ts`                  | Wired all 4 ClickHouse stores via lazy singleton `getChStores()`; added trace persistence in `onTraceEvent`; added message/metrics/audit persistence after response |
| `apps/runtime/src/websocket/sdk-handler.ts`              | Added per-tenant ClickHouse message and metrics store accessors                                                                                                     |
| `apps/runtime/src/routes/chat.ts`                        | Updated `getMetricsStoreAsync()` to return ClickHouseMetricsStore when `USE_MONGO_CLICKHOUSE=true`; `GET /api/chat/usage` now reads from ClickHouse                 |
| `apps/runtime/src/services/stores/index.ts`              | Added exports for all ClickHouse stores                                                                                                                             |
| `packages/database/package.json`                         | Added `@clickhouse/client` dependency                                                                                                                               |
| `packages/compiler/src/platform/stores/message-store.ts` | Added `clickhouse` type option, `traceId` to `AddMessageParams`                                                                                                     |
| `packages/compiler/src/platform/stores/metrics-store.ts` | Added `clickhouse` type option, `userId` to `LLMMetricInput`                                                                                                        |
| `packages/compiler/src/platform/stores/trace-store.ts`   | Added `clickhouse` type option                                                                                                                                      |
| `packages/compiler/src/platform/stores/fact-store.ts`    | Added `clickhouse` type option                                                                                                                                      |
| `packages/database/src/clickhouse.ts`                    | BufferedWriter batch size 10K rows / 5s flush; `onError` callback                                                                                                   |
| `apps/runtime/.env.example`                              | Added `USE_MONGO_CLICKHOUSE`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`                                                                            |

---

## 3. Data Flow: UI → ClickHouse

### 3.1 Write Paths (all fire-and-forget, non-blocking)

```
Studio UI → WebSocket → handler.ts
  ├── send_message → ClickHouseMessageStore.addMessage()     [user + assistant messages]
  ├── send_message → ClickHouseMetricsStore.record()         [LLM latency, tokens, cost]
  ├── send_message → ClickHouseTraceStore.appendEvent()      [trace events via onTraceEvent]
  └── send_message → ClickHouseAuditStore.logSessionStarted() [audit events]

SDK Widget → WebSocket → sdk-handler.ts
  ├── chat → ClickHouseMessageStore.addMessage()             [user + assistant messages]
  └── chat → ClickHouseMetricsStore.record()                 [LLM metrics]

REST API → chat.ts
  └── POST /api/chat/agent → ClickHouseMessageStore.addMessage() [messages]
```

### 3.2 Read Paths

| Endpoint                       | Data                             | Source (USE_MONGO_CLICKHOUSE=false) | Source (USE_MONGO_CLICKHOUSE=true) |
| ------------------------------ | -------------------------------- | ----------------------------------- | ---------------------------------- |
| `GET /api/chat/usage`          | Metrics summary + cost breakdown | PrismaMetricsStore                  | **ClickHouseMetricsStore**         |
| `GET /api/sessions/:id`        | Session messages + state         | RuntimeExecutor (in-memory)         | RuntimeExecutor (in-memory)\*      |
| `GET /api/sessions/:id/traces` | Trace events                     | TraceStore (in-memory)              | TraceStore (in-memory)\*           |

\*Active session data stays in-memory for low latency. ClickHouse is the persistence layer for historical session retrieval (planned for future cross-pod session access).

### 3.3 Materialized Views (auto-populated)

Raw `llm_metrics` inserts automatically populate:

- `llm_metrics_hourly_dest` — hourly rollups via `AggregatingMergeTree`
- `llm_metrics_daily_dest` — daily rollups via `AggregatingMergeTree`

Both use `SimpleAggregateFunction` for correct weighted averages during merges.

---

## 4. DateTime Format Fix

ClickHouse `DateTime64(3)` expects `YYYY-MM-DD HH:MM:SS.mmm` format (no `T`, no `Z`). All stores use:

```typescript
function toClickHouseDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
```

The `ClickHouseFactStore.parseChDate()` helper handles the reverse conversion, appending `Z` so JavaScript interprets the timestamp as UTC (not local time).

---

## 5. ClickHouse Tables Summary

| Table                     | Engine               | ORDER BY                                                        | Partition | TTL (Delete) | Encrypted | Indexes                                         |
| ------------------------- | -------------------- | --------------------------------------------------------------- | --------- | ------------ | --------- | ----------------------------------------------- |
| `messages`                | MergeTree\*          | `(tenant_id, session_id, created_at)`                           | Daily     | 730d         | `content` | bloom(contact_id), set(pii)                     |
| `llm_metrics`             | MergeTree\*          | `(tenant_id, toStartOfHour(timestamp), model_id, provider)`     | Monthly   | 730d         | None      | bloom(session_id), set(operation)               |
| `traces`                  | MergeTree\*          | `(tenant_id, session_id, trace_id, timestamp)`                  | Daily     | 90d          | `data`    | bloom(trace_id), set(event_type), set(error)    |
| `logs`                    | MergeTree\*          | `(tenant_id, timestamp, service, level)`                        | Monthly   | 30d          | None      | set(level), tokenbf(message), bloom(session_id) |
| `audit_events`            | MergeTree\*          | `(tenant_id, timestamp, action)`                                | Monthly   | No delete    | None      | set(action), bloom(actor), bloom(session)       |
| `facts`                   | ReplacingMergeTree   | `(key)`                                                         | —         | —            | None      | minmax(expires_at), set(source)                 |
| `llm_metrics_hourly_dest` | AggregatingMergeTree | `(tenant_id, project_id, model_id, provider, agent_name, hour)` | Monthly   | 1095d        | N/A       | —                                               |
| `llm_metrics_daily_dest`  | AggregatingMergeTree | `(tenant_id, project_id, model_id, provider, day)`              | Monthly   | 1095d        | N/A       | —                                               |

\*ReplicatedMergeTree in production (when `CLICKHOUSE_REPLICATED=true`)

---

## 6. Dev Mode DDL Adjustments

When `CLICKHOUSE_REPLICATED !== 'true'` (dev), the init script:

1. Replaces `ReplicatedMergeTree(...)` with `MergeTree()`
2. Strips `TO VOLUME 'warm'` / `TO VOLUME 'cold'` TTL rules (no tiered storage)
3. Cleans up stray commas and empty TTL blocks

---

## 7. Environment Variables

| Variable                | Default                 | Purpose                              |
| ----------------------- | ----------------------- | ------------------------------------ |
| `USE_MONGO_CLICKHOUSE`  | `false`                 | Enable ClickHouse persistence        |
| `CLICKHOUSE_URL`        | `http://localhost:8123` | ClickHouse HTTP endpoint             |
| `CLICKHOUSE_USER`       | `default`               | ClickHouse user                      |
| `CLICKHOUSE_PASSWORD`   | —                       | ClickHouse password                  |
| `CLICKHOUSE_REPLICATED` | `false`                 | Use ReplicatedMergeTree (production) |

---

## 8. Test Coverage

| Test File                       | Tests | Description                                     |
| ------------------------------- | ----- | ----------------------------------------------- |
| `clickhouse-stores.test.ts`     | 45    | Message, Metrics, Trace, Audit store unit tests |
| `clickhouse-fact-store.test.ts` | 32    | Fact store CRUD, batch ops, TTL, factory        |
| `clickhouse-enterprise.test.ts` | ~26   | Enterprise hardening (encryption, key rotation) |
| `encryption-service.test.ts`    | ~20   | Compress-then-encrypt pipeline, key cache       |
| `clickhouse-writer.test.ts`     | ~10   | BufferedWriter batch/flush behavior             |

Total: **~133 ClickHouse-specific tests**, all passing. Full suite: **2984 passing** / 12 pre-existing failures (remote-agent-coordination + E2E).

---

## 9. Bugs Fixed During Integration

| Issue                        | Root Cause                                                                       | Fix                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| DateTime parse error         | `toISOString()` produces `T` and `Z` characters rejected by CH DateTime64        | `.replace('T', ' ').replace('Z', '')` in all stores                  |
| Silent write failures        | `BufferedClickHouseWriter.reportError()` drops errors when no `onError` callback | Added `onError` logging callbacks to all store writers               |
| TTL SET syntax error         | CH TTL SET doesn't support `if()` with commas (interpreted as rule separators)   | Removed TTL SET; PII scrubbing delegated to retention-scheduler      |
| Stray comma in DDL           | Dev-mode regex stripped volume moves but left trailing commas                    | Added cleanup regex: `TTL\s*,` → `TTL\n`                             |
| Empty TTL block              | `audit_events` only had volume move TTL; stripping left empty `TTL SETTINGS`     | Added regex: `TTL\s+SETTINGS` → `SETTINGS`                           |
| Timezone offset in facts     | `new Date('2025-01-01 00:00:00.000')` parsed as local time, not UTC              | Added `parseChDate()` helper that appends `Z` for UTC interpretation |
| Missing `user_id` in metrics | Prisma `LLMUsageMetric.userId` had no CH counterpart                             | Added `user_id String DEFAULT ''` column to DDL and store            |
| Missing `userAgent` in audit | Prisma `AuditLog.userAgent` had no CH counterpart                                | Added `actor_user_agent String DEFAULT ''` column                    |
| Metrics reads from Prisma    | `GET /api/chat/usage` always used `PrismaMetricsStore`                           | Added `getMetricsStoreAsync()` that returns CH store when enabled    |
