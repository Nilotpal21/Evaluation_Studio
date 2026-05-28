# Insights Pipeline Engine Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Extend the pipeline engine with domain-specific insight handlers (compute activities) that cover the full analytics spec (Tiers 1-4), storing results in a unified ClickHouse table.

**Architecture:** Each insight handler is a standalone Restate activity service. Customers compose pipelines from these building blocks (compute + evaluate + store steps). Handlers query ClickHouse traces and/or MongoDB conversations, produce standardized `InsightResult` outputs, and persist to a single `insight_results` ClickHouse table with a granularity column.

**Reference:** Full metrics specification in `abl-review/metrics/analytics-metrics-insights-market-research.md`.

**Phase 1 Status:** COMPLETED (2026-03-02). Foundation + 2 handlers (compute-toxicity, compute-tool-effectiveness, store-insight) implemented and E2E tested via SDK WebSocket -> Kafka -> Pipeline Engine -> ClickHouse.

---

## Architecture & Data Flow

```
SDK WebSocket / API
  → Runtime emits session.ended, message.user, tool.completed, etc.
    → EventBus (subscription-gated by tenant + event type)
      → KafkaSubscriber (batched: 100 events or 500ms linger)
        → Kafka topics (abl.session.ended, etc.)
          → PipelineTrigger matches active pipelines by topic + tenant
            → Injects pipelineId + runId into pipelineInput
              → PipelineRun workflow executes steps:

        [Compute Handlers]               [Evaluate/Action Handlers]
        ├── compute-toxicity              ├── evaluate-metrics (existing)
        ├── compute-tool-effectiveness    ├── evaluate-policy (existing)
        ├── compute-agent-performance     ├── store-insight (NEW → ClickHouse)
        ├── compute-conversation-quality  ├── send-notification (existing)
        ├── compute-sentiment             └── transform (existing)
        ├── compute-user-struggle
        ├── compute-latency
        ├── compute-cost-attribution
        └── (20+ more handlers...)
```

### Event Flow Detail (Phase 1)

The end-to-end flow for SDK-triggered pipelines:

1. **SDK WebSocket close** (or explicit `end_session` message) triggers `emitSessionEnded()` in `sdk-handler.ts`
2. **EventBus** checks `EventSubscriptionRegistry.isSubscribed(tenantId, eventType)` — only delivers if a matching active pipeline exists for that tenant
3. **EventSubscriptionRegistry** syncs every 60s from `pipeline_definitions` collection (`status: 'active'`, `trigger.type: 'kafka'`), strips `abl.` prefix from `kafkaTopic` to build `Map<tenantId, Set<eventType>>`
4. **KafkaSubscriber** buffers events, flushes when `batchSize` (100) reached or `lingerMs` (500ms) elapses
5. **PipelineTrigger** receives from Kafka, matches pipeline definition, generates `runId`, injects `pipelineId` + `runId` into `pipelineInput`, starts PipelineRun workflow
6. **PipelineRun** executes steps sequentially via ActivityRouter, passing `previousSteps` between steps
7. **ActivityRouter** dispatches to the correct handler via `SERVICE_HANDLERS` dispatch table

### Three Activity Categories

| Category                    | Purpose                                   | Data Source               | AI Cost           |
| --------------------------- | ----------------------------------------- | ------------------------- | ----------------- |
| **Compute** (new)           | Read data, run analysis, produce scores   | ClickHouse and/or MongoDB | Varies by handler |
| **Evaluate** (existing)     | Apply rules/thresholds to computed scores | previousSteps only        | None              |
| **Action** (existing + new) | Store results, notify, transform          | N/A                       | None              |

### Typical Customer Pipeline

1. **Compute** step reads data from ClickHouse/MongoDB, produces scores
2. **Evaluate** step (optional) checks scores against thresholds/policy
3. **Store** step writes results to `insight_results` ClickHouse table

---

## Handler Taxonomy (~24 Handlers)

### Category 1: Quantitative (ClickHouse queries, no AI cost)

| Handler                            | Spec Section | Granularity      | Key Outputs                                                                                       |
| ---------------------------------- | ------------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| `compute-agent-performance`        | T2 S7.1      | agent, project   | invocation count, step count, tool count, containment rate, escalation rate, error rate, avg cost |
| `compute-tool-effectiveness`       | T2 S7.3      | agent, session   | selection accuracy, parameter accuracy, retry rate, call efficiency, unused tool rate             |
| `compute-latency`                  | T1 S6.2      | span, session    | e2e latency (P50/P95/P99), TTFT, tool duration, retrieval latency                                 |
| `compute-cost-attribution`         | T1 S6.3      | agent, project   | token usage (in/out/reasoning), cost by tenant/project/agent/tool                                 |
| `compute-error-rates`              | T1 S6.4      | agent, project   | LLM error rate, tool failure rate, guardrail trigger rate                                         |
| `compute-rag-retrieval`            | T2 S7.5      | session          | precision@K, recall@K, MRR, context utilization, coverage                                         |
| `compute-extraction-metrics`       | T2 S7.7      | session          | extraction accuracy, completeness, efficiency, clarification rate                                 |
| `compute-multi-agent-coordination` | T2 S7.8      | session, project | handoff accuracy, handoff latency, context preservation, resolution depth                         |
| `compute-conversation-flow`        | T3 S8.7      | session          | path analysis, drop-off funnels, loop detection, turn efficiency                                  |
| `compute-business-outcomes`        | T4 S9        | session, project | containment, deflection, FCR, handle time, drop-off, customer effort                              |

### Category 2: LLM-as-Judge (requires tenant LLM credentials)

| Handler                        | Spec Section | Granularity      | Key Outputs                                                                                          |
| ------------------------------ | ------------ | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `compute-conversation-quality` | T3 S8.1      | session          | resolution quality, accuracy, helpfulness, coherence, professionalism (1-5 each), composite CX score |
| `compute-goal-completion`      | T2 S7.2      | session          | goal achieved? topic adherence? instruction following?                                               |
| `compute-helpfulness`          | T3 S8.2      | session          | info gain per turn, task progression rate, wasted turn rate                                          |
| `compute-hallucination`        | T3 S8.9      | session, message | faithfulness, groundedness, contradiction rate                                                       |
| `compute-conversation-summary` | T3 S8.10     | session          | structured summary (topics, actions, outcome, sentiment arc, risk flags)                             |
| `compute-conversation-tags`    | T3 S8.11     | session          | auto-classification (keyword, pattern, LLM-based, outcome-based, composite)                          |
| `compute-reasoning-quality`    | T2 S7.4      | session          | coherence score, confidence calibration, self-correction rate, routing precision                     |

### Category 3: Behavioral / Zero-Cost Detection

| Handler                      | Spec Section | Granularity      | Key Outputs                                                                   |
| ---------------------------- | ------------ | ---------------- | ----------------------------------------------------------------------------- |
| `compute-toxicity`           | T3 S8.8      | message, session | toxicity score (user + agent), PII detection, jailbreak attempts              |
| `compute-sentiment`          | T3 S8.4      | message, session | turn-level sentiment, trajectory, frustration detection, pivot points         |
| `compute-user-struggle`      | T3 S8.3      | session          | friction score (rephrasing, length trend, explicit frustration, turn outlier) |
| `compute-consistency`        | T3 S8.5      | session          | consistency index, memory recall, entity tracking accuracy                    |
| `compute-topic-distribution` | T3 S8.6      | session, project | intent volume distribution, trends, emerging topics                           |

### Category 4: Voice-Specific

| Handler                 | Spec Section | Granularity |
| ----------------------- | ------------ | ----------- |
| `compute-voice-metrics` | T4 S9        | session     |

---

## Data Access

Handlers use **existing shared clients** from the platform — no new abstraction needed.

### ClickHouse (Quantitative handlers)

```typescript
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

// In handler:
const ch = getClickHouseClient();
const result = await ch.query({
  query: `SELECT ... FROM abl_platform.traces WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}`,
  query_params: { tenantId: input.tenantId, sessionId },
});
```

### MongoDB (Qualitative/behavioral handlers)

```typescript
import mongoose from 'mongoose';

// In handler:
const messages = mongoose.connection.collection('messages');
const docs = await messages.find({ tenantId: input.tenantId, sessionId }).toArray();
```

### LLM (LLM-as-Judge handlers)

Uses the existing LLM credential resolution chain:

1. `LLMCredential` collection (standalone credential)
2. `TenantModel` -> connection `credentialId` -> `LLMCredential` lookup
3. Environment variable fallback (dev only)

### Pipeline Engine Server Startup

ClickHouse initialization alongside existing MongoDB connection in `server.ts`:

```typescript
// Existing
await mongoose.connect(MONGODB_URL);

// ClickHouse — creates insight_results table if missing
import { getClickHouseClient, initClickHouseSchema } from '@agent-platform/database/clickhouse';
const chClient = getClickHouseClient();
await initClickHouseSchema(chClient);
```

---

## PipelineTrigger: Context Injection

PipelineTrigger injects `pipelineId` and `runId` into `pipelineInput` before starting the PipelineRun workflow. This makes pipeline context available to all downstream steps (especially `store-insight`).

**Kafka-triggered runs:**

```typescript
const runId = `${pipeline._id}-${ctx.rand.uuidv4()}`;
ctx.workflowSendClient(pipelineRun, runId).run({
  pipelineDefinition: pipeline,
  pipelineInput: { tenantId, pipelineId: pipeline._id, runId, ...event },
});
```

**Manual trigger runs:**

```typescript
const runId = `${pipeline._id}-${ctx.rand.uuidv4()}`;
ctx.workflowSendClient(pipelineRun, runId).run({
  pipelineDefinition: pipeline,
  pipelineInput: { tenantId: input.tenantId, pipelineId: pipeline._id, runId, ...input.data },
});
```

Pipeline definitions must include a `version` field (required for `PipelineRunRecord` creation).

---

## ClickHouse Storage: `insight_results` Table

Single table with a `granularity` column for all insight types and granularity levels.

```sql
CREATE TABLE abl_platform.insight_results
(
    -- Identity
    tenant_id        String                 CODEC(ZSTD(1)),
    project_id       String                 CODEC(ZSTD(1)),
    insight_type     LowCardinality(String) CODEC(ZSTD(1)),

    -- Granularity & scope
    granularity      Enum8(
                       'message' = 1,
                       'span' = 2,
                       'session' = 3,
                       'agent' = 4,
                       'project' = 5
                     ),
    session_id       Nullable(String)       CODEC(ZSTD(1)),
    message_id       Nullable(String)       CODEC(ZSTD(1)),
    span_id          Nullable(String)       CODEC(ZSTD(1)),
    agent_name       Nullable(String)       CODEC(ZSTD(1)),

    -- Result
    score            Float64                CODEC(Gorilla, ZSTD(1)),
    status           Enum8('pass' = 1, 'warn' = 2, 'fail' = 3),

    -- Flexible payload for handler-specific data
    dimensions       String                 DEFAULT '{}' CODEC(ZSTD(3)),

    -- Pipeline context
    pipeline_id      String                 CODEC(ZSTD(1)),
    run_id           String                 CODEC(ZSTD(1)),

    -- Time (UTC timezone)
    evaluated_at     DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    event_timestamp  DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    expires_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),

    -- Secondary indices for common query patterns
    INDEX idx_insight_type insight_type TYPE set(100)      GRANULARITY 4,
    INDEX idx_session_id   session_id   TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_status       status       TYPE set(3)        GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.insight_results', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(evaluated_at))
ORDER BY (tenant_id, project_id, insight_type, granularity, evaluated_at)
TTL toDateTime(expires_at) DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400;
```

**Note:** In dev mode (`CLICKHOUSE_REPLICATED !== 'true'`), `ReplicatedMergeTree` is automatically replaced with plain `MergeTree()` by `initClickHouseSchema()`.

### Design Choices

- **Partition by tenant + month**: Tenant isolation at storage level, efficient time-range pruning
- **Order by tenant -> project -> insight_type -> granularity -> time**: Optimized for "show me toxicity scores for project X this week"
- **`dimensions` as JSON string**: Flexible per-handler payload without schema changes (DEFAULT `'{}'`)
- **`score` + `status`**: Standardized across all insight types for cross-handler dashboards
- **TTL via `expires_at`**: Configurable retention per pipeline/tenant (`merge_with_ttl_timeout = 86400` = 24h cleanup interval)
- **CODEC compression**: ZSTD(1) for strings/IDs, Gorilla for float score, DoubleDelta for timestamps, ZSTD(3) for large dimensions JSON
- **`LowCardinality(String)` for `insight_type`**: Optimizes storage and queries for the limited set of handler types
- **Secondary indices**: Bloom filter on `session_id` for point lookups, set indices on `insight_type` and `status` for filtered scans
- **ReplicatedMergeTree**: Production-ready replication with Keeper paths, auto-downgrade for dev

### DateTime64 Format

ClickHouse DateTime64(3) requires `YYYY-MM-DD HH:MM:SS.mmm` format (no `T` or `Z`). The `store-insight` service uses a `toCHDateTime()` helper:

```typescript
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
```

---

## Handler Output Interface

Every compute handler returns a standardized output (defined in `pipeline/insight-types.ts`):

```typescript
type Granularity = 'message' | 'span' | 'session' | 'agent' | 'project';
type InsightStatus = 'pass' | 'warn' | 'fail';

interface InsightResult {
  insightType: string;
  granularity: Granularity;
  score: number; // 0.0-1.0 normalized
  status: InsightStatus;
  dimensions: Record<string, unknown>; // Handler-specific detail
  records?: InsightRecord[]; // For batch results (multiple rows)
}

interface InsightRecord {
  sessionId?: string;
  messageId?: string;
  spanId?: string;
  agentName?: string;
  score: number;
  status: InsightStatus;
  dimensions: Record<string, unknown>;
  eventTimestamp?: string;
}
```

The `store-insight` activity auto-maps these fields to the ClickHouse table columns. If a handler returns `records[]`, each record becomes a separate row. If `records` is omitted, a single row is written using the top-level fields.

---

## Handler Config Shape

Each handler receives configuration from the customer's pipeline definition:

```typescript
interface InsightHandlerConfig {
  params: Record<string, unknown>;
  // Handler-specific parameters, e.g.:
  // compute-toxicity:           { threshold: 0.7, includeAgent: true }
  // compute-tool-effectiveness: { tools: ['searchKB'], minCalls: 3 }
  // compute-conversation-quality: { rubric: 'helpfulness-5point' }
}
```

Scope (projectId, sessionId, agentName, timeRange) comes from `pipelineInput` (the Kafka event payload + injected `pipelineId`/`runId`), not from the handler config. This keeps handler configs focused on computation parameters.

---

## `store-insight` Activity

Activity service that writes compute handler outputs to ClickHouse:

1. Reads the previous compute step's output from `previousSteps` (auto-detects the source step by scanning for `InsightResult` output, or uses explicit `sourceStep` config)
2. Maps `InsightResult` fields to `insight_results` table columns
3. Uses direct `getClickHouseClient().insert()` with `JSONEachRow` format (single batch per invocation)
4. Always includes `tenant_id`, `pipeline_id`, `run_id` from context (`pipelineInput`)
5. Sets `evaluated_at` to current time, `event_timestamp` from record or pipelineInput
6. Calculates `expires_at` from `retentionDays` config (default: 90 days)
7. Skips gracefully when the source step failed (returns `status: 'skipped'`)

**Config options:**

- `sourceStep` (optional): Step ID to read InsightResult from. Auto-detected if omitted.
- `retentionDays` (optional): TTL in days for stored rows. Default: 90.

---

## `evaluate-policy` Activity

Rule-based policy evaluation with violation tracking. Evaluates rules against step outputs and pipeline input using the expression evaluator.

**Rule interface:**

```typescript
interface PolicyRule {
  name: string;
  field?: string; // Expression path (e.g. 'steps.score-toxicity.output.score')
  condition?: string; // @deprecated — use 'field' instead (backward compatible)
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte';
  expected: string | number | boolean;
  severity?: 'critical' | 'warning' | 'info';
}
```

Returns `PASS` / `WARN` / `FAIL` based on violation severities:

- **FAIL**: any critical violation
- **WARN**: only warning/info violations
- **PASS**: all rules satisfied

---

## Customer Configuration Example

### Toxicity Monitoring Pipeline

```json
{
  "_id": "insight-toxicity-acme-v1",
  "tenantId": "acme-corp",
  "projectId": "support-bot",
  "name": "Toxicity Safety Pipeline",
  "version": 1,
  "status": "active",
  "trigger": {
    "type": "kafka",
    "kafkaTopic": "abl.session.ended",
    "eventFilter": { "field": "projectId", "equals": "support-bot" }
  },
  "steps": [
    {
      "id": "score-toxicity",
      "name": "Score Message Toxicity",
      "type": "compute-toxicity",
      "config": { "params": { "threshold": 0.7, "includeAgent": false } }
    },
    {
      "id": "check-policy",
      "name": "Safety Policy Check",
      "type": "evaluate-policy",
      "config": {
        "policyId": "content-safety-v1",
        "rules": [
          {
            "name": "session-toxicity-limit",
            "field": "steps.score-toxicity.output.score",
            "operator": "lte",
            "expected": 0.5,
            "severity": "critical"
          }
        ]
      }
    },
    {
      "id": "persist",
      "name": "Store Results",
      "type": "store-insight",
      "config": {}
    }
  ]
}
```

### Tool Accuracy Pipeline

```json
{
  "_id": "insight-tool-accuracy-acme-v1",
  "tenantId": "acme-corp",
  "projectId": "support-bot",
  "name": "Tool Accuracy Analysis",
  "version": 1,
  "status": "active",
  "trigger": {
    "type": "kafka",
    "kafkaTopic": "abl.session.ended"
  },
  "steps": [
    {
      "id": "compute-accuracy",
      "name": "Compute Tool Call Accuracy",
      "type": "compute-tool-effectiveness",
      "config": {
        "params": { "tools": ["searchKB", "createTicket", "lookupOrder"], "minCalls": 3 }
      }
    },
    {
      "id": "persist",
      "name": "Store Results",
      "type": "store-insight",
      "config": {}
    }
  ]
}
```

---

## SDK Integration (Phase 1)

### Session End Event Emission

The Runtime SDK handler emits `session.ended` events via the EventBus when a WebSocket session closes. Two trigger paths:

1. **WebSocket close** — `ws.on('close')` handler flushes messages, ends the session, then calls `emitSessionEnded()`
2. **Explicit end_session message** — client sends `{ type: 'end_session' }`, handler calls `handleEndSession()` which closes the WebSocket

The `emitSessionEnded()` function constructs an `AnyPlatformEvent` with `type: 'session.ended'`, `tenantId`, `projectId`, `sessionId`, `agentName`, `channel`, and `payload: { reason, durationMs }`.

### Studio Preview Widget

The Studio preview page (`apps/studio/src/app/preview/page.tsx`) includes an End Session button in the chat widget header. When clicked, it sends `{ type: 'end_session' }` over the WebSocket, which triggers the pipeline.

---

## Implementation Phasing

### Phase 1: Foundation + 2 Handlers (MVP) — COMPLETED

| Component                        | What                                                                                                                  | Status |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| **ClickHouse setup**             | `insight_results` table in `initClickHouseSchema()`, ClickHouse client in pipeline engine `server.ts`                 | Done   |
| **InsightResult types**          | `insight-types.ts` with `InsightResult`, `InsightRecord`, `Granularity`, `InsightStatus`                              | Done   |
| **`store-insight` activity**     | Writes `InsightResult` to ClickHouse via direct insert, auto-detects source step                                      | Done   |
| **`compute-toxicity`**           | Category 3 (behavioral). Reads MongoDB messages, keyword/pattern scoring, session + per-message results               | Done   |
| **`compute-tool-effectiveness`** | Category 1 (quantitative). Queries ClickHouse traces for tool call spans, computes accuracy + retry rate + efficiency | Done   |
| **`evaluate-policy` update**     | Updated to use `field` (with `condition` as deprecated fallback), added guard for missing expression                  | Done   |
| **PipelineTrigger update**       | Injects `pipelineId` + `runId` into `pipelineInput` for both Kafka and manual triggers                                | Done   |
| **Registration**                 | Registered in `ACTIVITY_TYPES`, `SERVICE_HANDLERS` dispatch table, `server.ts` Restate bindings                       | Done   |
| **SDK integration**              | `emitSessionEnded()` in sdk-handler, End Session button in Studio preview                                             | Done   |
| **E2E verified**                 | SDK WebSocket -> session.ended -> Kafka -> PipelineTrigger -> PipelineRun -> ClickHouse                               | Done   |

### Phase 2: Core Quality Metrics (Tier 2-3)

| Handler                        | Category                     |
| ------------------------------ | ---------------------------- |
| `compute-agent-performance`    | Quantitative (ClickHouse)    |
| `compute-latency`              | Quantitative (ClickHouse)    |
| `compute-cost-attribution`     | Quantitative (ClickHouse)    |
| `compute-sentiment`            | Behavioral (MongoDB)         |
| `compute-user-struggle`        | Behavioral (MongoDB)         |
| `compute-conversation-quality` | LLM-as-Judge (MongoDB + LLM) |

### Phase 3: Advanced Quality + Business (Tier 3-4)

| Handler                        | Category     |
| ------------------------------ | ------------ |
| `compute-conversation-summary` | LLM-as-Judge |
| `compute-hallucination`        | LLM-as-Judge |
| `compute-goal-completion`      | LLM-as-Judge |
| `compute-business-outcomes`    | Quantitative |
| `compute-rag-retrieval`        | Quantitative |
| `compute-conversation-tags`    | LLM-as-Judge |

### Phase 4: Remaining Handlers

All remaining handlers from the taxonomy (error-rates, extraction-metrics, multi-agent-coordination, conversation-flow, consistency, topic-distribution, reasoning-quality, voice-metrics).

---

## Key Design Decisions

1. **Approach A (separate activity types)** chosen over generic dispatcher — each handler is a standalone Restate service for independent timeout/retry config
2. **Existing shared clients** for data access — no new abstraction (`getClickHouseClient()`, `mongoose.connection`)
3. **Single ClickHouse table** with granularity column — simpler schema, flexible enough for all handler types
4. **Handler output standardized** as `InsightResult` — enables cross-handler dashboards and unified storage
5. **`store-insight` as separate step** (not built into compute handlers) — separation of concerns, composability, compute handler can be used without storage
6. **Direct insert over BufferedWriter** — each pipeline run writes a small batch (typically 1-50 rows), buffering adds complexity without benefit at this scale
7. **`pipelineId` + `runId` injected by PipelineTrigger** — downstream steps access pipeline context via `pipelineInput` without needing separate config
8. **`field` over `condition` in policy rules** — clearer naming; `condition` kept as deprecated alias for backward compatibility
9. **Auto-detect source step in store-insight** — scans `previousSteps` for last successful `InsightResult` output, explicit `sourceStep` config optional
10. **EventBus subscription gating** — events are silently dropped if no active pipeline subscribes for that tenant + event type, preventing unnecessary Kafka traffic

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the pipeline engine with `store-insight`, `compute-toxicity`, and `compute-tool-effectiveness` activity services, storing results in a unified ClickHouse `insight_results` table.

**Architecture:** Each insight handler is a standalone Restate activity service returning standardized `InsightResult` output. A new `store-insight` activity writes results to ClickHouse via `BufferedClickHouseWriter`. Handlers are registered in the existing activity metadata, router dispatch table, and server bindings.

**Tech Stack:** Restate SDK, ClickHouse (`@agent-platform/database`), Mongoose (MongoDB), Vitest

**Reference:** Design doc at `docs/plans/2026-03-02-insights-pipeline-engine-design.md`

---

## Task 1: Add `insight_results` ClickHouse Table DDL

Add the `insight_results` table to the existing ClickHouse schema initialization so it's auto-created on startup.

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts` (append to `TABLES` array before line 483)
- Test: `packages/pipeline-engine/src/__tests__/insight-results-schema.test.ts`

**Step 1: Write the failing test**

Create a test that imports the `TABLES` array and verifies `insight_results` is present with the expected columns.

```typescript
// packages/pipeline-engine/src/__tests__/insight-results-schema.test.ts
import { describe, test, expect } from 'vitest';
import { TABLES } from '@agent-platform/database/clickhouse-schemas/init';

describe('insight_results ClickHouse table', () => {
  const table = TABLES.find((t) => t.name === 'insight_results');

  test('table definition exists in TABLES array', () => {
    expect(table).toBeDefined();
  });

  test('DDL contains required columns', () => {
    const ddl = table!.ddl;
    const requiredColumns = [
      'tenant_id',
      'project_id',
      'insight_type',
      'granularity',
      'session_id',
      'message_id',
      'span_id',
      'agent_name',
      'score',
      'status',
      'dimensions',
      'pipeline_id',
      'run_id',
      'evaluated_at',
      'event_timestamp',
      'expires_at',
    ];
    for (const col of requiredColumns) {
      expect(ddl).toContain(col);
    }
  });

  test('DDL uses MergeTree engine', () => {
    expect(table!.ddl).toMatch(/MergeTree/);
  });

  test('DDL partitions by tenant_id and month', () => {
    expect(table!.ddl).toMatch(/PARTITION BY.*tenant_id.*toYYYYMM/s);
  });

  test('DDL orders by tenant, project, insight_type, granularity, evaluated_at', () => {
    expect(table!.ddl).toMatch(
      /ORDER BY.*tenant_id.*project_id.*insight_type.*granularity.*evaluated_at/s,
    );
  });

  test('DDL includes TTL on expires_at', () => {
    expect(table!.ddl).toMatch(/TTL.*expires_at/s);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/insight-results-schema.test.ts`
Expected: FAIL — `TABLES.find(t => t.name === 'insight_results')` returns `undefined`

**Step 3: Add the table DDL**

In `packages/database/src/clickhouse-schemas/init.ts`, add a new entry to the `TABLES` array (before the closing `];` at line 483):

```typescript
  {
    name: 'insight_results',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.insight_results
(
    tenant_id        String                 CODEC(ZSTD(1)),
    project_id       String                 CODEC(ZSTD(1)),
    insight_type     LowCardinality(String) CODEC(ZSTD(1)),

    granularity      Enum8(
                       'message' = 1,
                       'span' = 2,
                       'session' = 3,
                       'agent' = 4,
                       'project' = 5
                     ),

    session_id       Nullable(String)       CODEC(ZSTD(1)),
    message_id       Nullable(String)       CODEC(ZSTD(1)),
    span_id          Nullable(String)       CODEC(ZSTD(1)),
    agent_name       Nullable(String)       CODEC(ZSTD(1)),

    score            Float64                CODEC(Gorilla, ZSTD(1)),
    status           Enum8('pass' = 1, 'warn' = 2, 'fail' = 3),

    dimensions       String                 DEFAULT '{}' CODEC(ZSTD(3)),

    pipeline_id      String                 CODEC(ZSTD(1)),
    run_id           String                 CODEC(ZSTD(1)),

    evaluated_at     DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    event_timestamp  DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    expires_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_insight_type insight_type TYPE set(100)      GRANULARITY 4,
    INDEX idx_session_id   session_id   TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_status        status       TYPE set(3)        GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.insight_results', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(evaluated_at))
ORDER BY (tenant_id, project_id, insight_type, granularity, evaluated_at)
TTL toDateTime(expires_at) DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
`,
  },
```

**Step 4: Build the database package and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/insight-results-schema.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add packages/database/src/clickhouse-schemas/init.ts packages/pipeline-engine/src/__tests__/insight-results-schema.test.ts
git commit -m "[ABLP-39] feat(database): add insight_results ClickHouse table schema"
```

---

## Task 2: Add `@agent-platform/database` Dependency & ClickHouse Init to Server

Connect the pipeline engine to ClickHouse at startup.

**Files:**

- Modify: `packages/pipeline-engine/package.json` (add dependency)
- Modify: `packages/pipeline-engine/src/pipeline/server.ts` (add ClickHouse init)

**Step 1: Add the dependency**

In `packages/pipeline-engine/package.json`, add to `dependencies`:

```json
"@agent-platform/database": "workspace:*"
```

**Step 2: Install and build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm install && pnpm build`
Expected: Build succeeds

**Step 3: Update server.ts to initialize ClickHouse**

In `packages/pipeline-engine/src/pipeline/server.ts`, add ClickHouse initialization after the MongoDB connection (line 31):

```typescript
// Add imports at top (after line 10):
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { initClickHouseSchema } from '@agent-platform/database/clickhouse-schemas/init';

// Add after "console.log('MongoDB connected');" (line 31):
// Initialize ClickHouse (shared client, creates insight_results table if missing)
const chClient = getClickHouseClient();
await initClickHouseSchema(chClient);
console.log('ClickHouse initialized');
```

**Step 4: Build and verify no TypeScript errors**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build`
Expected: Build succeeds with no errors

**Step 5: Run existing tests to ensure no regressions**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter @agent-platform/pipeline-engine test`
Expected: All existing 157 tests pass

**Step 6: Commit**

```bash
git add packages/pipeline-engine/package.json packages/pipeline-engine/src/pipeline/server.ts pnpm-lock.yaml
git commit -m "[ABLP-39] feat(pipeline-engine): add ClickHouse client and schema init at startup"
```

---

## Task 3: Create `InsightResult` Types

Define the standardized `InsightResult` and `InsightRecord` interfaces used by all compute handlers.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/insight-types.ts`
- Test: `packages/pipeline-engine/src/__tests__/insight-types.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/insight-types.test.ts
import { describe, test, expect } from 'vitest';
import type {
  InsightResult,
  InsightRecord,
  Granularity,
  InsightStatus,
} from '../pipeline/insight-types.js';

describe('InsightResult types', () => {
  test('InsightResult can represent a session-level toxicity result', () => {
    const result: InsightResult = {
      insightType: 'toxicity',
      granularity: 'session',
      score: 0.85,
      status: 'pass',
      dimensions: { avgToxicity: 0.12, maxToxicity: 0.35, messageCount: 5 },
    };
    expect(result.insightType).toBe('toxicity');
    expect(result.granularity).toBe('session');
    expect(result.score).toBe(0.85);
  });

  test('InsightResult with batch records for per-message toxicity', () => {
    const result: InsightResult = {
      insightType: 'toxicity',
      granularity: 'message',
      score: 0.6,
      status: 'warn',
      dimensions: { messageCount: 3 },
      records: [
        { messageId: 'msg-1', score: 0.1, status: 'pass', dimensions: { text: 'hello' } },
        { messageId: 'msg-2', score: 0.9, status: 'fail', dimensions: { text: 'toxic' } },
        { messageId: 'msg-3', score: 0.3, status: 'pass', dimensions: { text: 'thanks' } },
      ],
    };
    expect(result.records).toHaveLength(3);
    expect(result.records![1].status).toBe('fail');
  });

  test('InsightResult with agent-level tool effectiveness', () => {
    const result: InsightResult = {
      insightType: 'tool-effectiveness',
      granularity: 'agent',
      score: 0.78,
      status: 'pass',
      dimensions: {
        selectionAccuracy: 0.85,
        parameterAccuracy: 0.72,
        retryRate: 0.1,
        toolCallCount: 15,
      },
    };
    expect(result.dimensions.selectionAccuracy).toBe(0.85);
  });

  test('Granularity type accepts all valid levels', () => {
    const levels: Granularity[] = ['message', 'span', 'session', 'agent', 'project'];
    expect(levels).toHaveLength(5);
  });

  test('InsightStatus type accepts pass, warn, fail', () => {
    const statuses: InsightStatus[] = ['pass', 'warn', 'fail'];
    expect(statuses).toHaveLength(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/insight-types.test.ts`
Expected: FAIL — module `../pipeline/insight-types.js` not found

**Step 3: Create the types file**

```typescript
// packages/pipeline-engine/src/pipeline/insight-types.ts
/**
 * Standardized types for insight compute handlers.
 *
 * Every compute handler returns an InsightResult. The store-insight activity
 * maps these fields to the ClickHouse insight_results table columns.
 */

export type Granularity = 'message' | 'span' | 'session' | 'agent' | 'project';
export type InsightStatus = 'pass' | 'warn' | 'fail';

/**
 * Output from a compute handler — a single aggregate result, optionally
 * with per-record detail rows.
 */
export interface InsightResult {
  /** Handler identifier, e.g. 'toxicity', 'tool-effectiveness' */
  insightType: string;

  /** Granularity of the result — maps to ClickHouse Enum8 column */
  granularity: Granularity;

  /** Normalized score (0.0–1.0) */
  score: number;

  /** Overall pass/warn/fail status */
  status: InsightStatus;

  /** Handler-specific payload — stored as JSON string in ClickHouse `dimensions` column */
  dimensions: Record<string, unknown>;

  /**
   * Optional batch records — each becomes a separate ClickHouse row.
   * If omitted, a single row is written using the top-level fields.
   */
  records?: InsightRecord[];
}

/**
 * A single detail row within a batch InsightResult.
 * Each record becomes one row in the insight_results table.
 */
export interface InsightRecord {
  sessionId?: string;
  messageId?: string;
  spanId?: string;
  agentName?: string;
  score: number;
  status: InsightStatus;
  dimensions: Record<string, unknown>;
  eventTimestamp?: string;
}
```

**Step 4: Build and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/insight-types.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/insight-types.ts packages/pipeline-engine/src/__tests__/insight-types.test.ts
git commit -m "[ABLP-39] feat(pipeline-engine): add InsightResult and InsightRecord types"
```

---

## Task 4: Create `store-insight` Activity Service

Write the `store-insight` Restate service that reads a compute handler's `InsightResult` from `previousSteps` and writes rows to ClickHouse `insight_results`.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/store-insight.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/store-insight.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/store-insight.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock the ClickHouse client before importing the service
const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: mockInsert,
  }),
}));

// Import after mock setup
const { storeInsightService } = await import('../pipeline/services/store-insight.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(storeInsightService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  const toxicityResult: InsightResult = {
    insightType: 'toxicity',
    granularity: 'session',
    score: 0.85,
    status: 'pass',
    dimensions: { avgToxicity: 0.12, messageCount: 5 },
  };
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      sourceStep: 'compute-toxicity',
    },
    previousSteps: {
      'compute-toxicity': {
        status: 'success',
        data: toxicityResult,
      },
    },
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
      pipelineId: 'pipeline-001',
      runId: 'run-001',
    },
    ...overrides,
  };
}

describe('StoreInsight service', () => {
  beforeEach(() => {
    mockInsert.mockClear();
  });

  test('writes single InsightResult row to ClickHouse', async () => {
    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
    expect(mockInsert).toHaveBeenCalledOnce();

    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.insight_results');
    expect(insertCall.format).toBe('JSONEachRow');
    expect(insertCall.values).toHaveLength(1);

    const row = insertCall.values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.project_id).toBe('support-bot');
    expect(row.insight_type).toBe('toxicity');
    expect(row.granularity).toBe('session');
    expect(row.score).toBe(0.85);
    expect(row.status).toBe('pass');
    expect(row.session_id).toBe('sess-001');
    expect(JSON.parse(row.dimensions)).toEqual({ avgToxicity: 0.12, messageCount: 5 });
  });

  test('writes batch records as separate rows', async () => {
    const batchResult: InsightResult = {
      insightType: 'toxicity',
      granularity: 'message',
      score: 0.6,
      status: 'warn',
      dimensions: { messageCount: 2 },
      records: [
        {
          messageId: 'msg-1',
          score: 0.1,
          status: 'pass',
          dimensions: { text: 'hello' },
          eventTimestamp: '2026-03-01T10:00:00.000Z',
        },
        {
          messageId: 'msg-2',
          score: 0.9,
          status: 'fail',
          dimensions: { text: 'toxic' },
          eventTimestamp: '2026-03-01T10:01:00.000Z',
        },
      ],
    };

    const input = makeInput({
      previousSteps: {
        'compute-toxicity': { status: 'success', data: batchResult },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(2);
    expect(mockInsert.mock.calls[0][0].values).toHaveLength(2);

    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows[0].message_id).toBe('msg-1');
    expect(rows[0].score).toBe(0.1);
    expect(rows[1].message_id).toBe('msg-2');
    expect(rows[1].score).toBe(0.9);
  });

  test('auto-detects source step when sourceStep config not provided', async () => {
    const input = makeInput({
      config: {},
      previousSteps: {
        'compute-toxicity': {
          status: 'success',
          data: {
            insightType: 'toxicity',
            granularity: 'session',
            score: 0.85,
            status: 'pass',
            dimensions: {},
          } satisfies InsightResult,
        },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
  });

  test('fails when no InsightResult found in previousSteps', async () => {
    const input = makeInput({
      config: { sourceStep: 'nonexistent-step' },
      previousSteps: {},
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('nonexistent-step');
  });

  test('fails when source step output lacks insightType', async () => {
    const input = makeInput({
      config: { sourceStep: 'compute-toxicity' },
      previousSteps: {
        'compute-toxicity': { status: 'success', data: { someOtherField: 42 } },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('insightType');
  });

  test('skips when source step failed', async () => {
    const input = makeInput({
      previousSteps: {
        'compute-toxicity': { status: 'fail', data: { error: 'upstream error' } },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('skipped');
  });

  test('sets default expires_at 90 days from now when not configured', async () => {
    const result = await execute(ctx(), makeInput());

    const row = mockInsert.mock.calls[0][0].values[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(88);
    expect(diffDays).toBeLessThan(92);
  });

  test('uses configured retentionDays for expires_at', async () => {
    const input = makeInput({
      config: { sourceStep: 'compute-toxicity', retentionDays: 30 },
    });

    const result = await execute(ctx(), input);

    const row = mockInsert.mock.calls[0][0].values[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(28);
    expect(diffDays).toBeLessThan(32);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/store-insight.test.ts`
Expected: FAIL — module `../pipeline/services/store-insight.service.js` not found

**Step 3: Implement the service**

```typescript
// packages/pipeline-engine/src/pipeline/services/store-insight.service.ts
/**
 * StoreInsight — Restate activity service for persisting InsightResult to ClickHouse.
 *
 * Reads a compute handler's InsightResult from previousSteps, maps fields to
 * the insight_results table columns, and writes via direct ClickHouse insert.
 *
 * Config:
 *   sourceStep?:     Step ID to read InsightResult from (auto-detected if omitted)
 *   retentionDays?:  TTL in days (default: 90)
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { InsightResult, InsightRecord } from '../insight-types.js';

const TABLE = 'abl_platform.insight_results';
const DEFAULT_RETENTION_DAYS = 90;

interface InsightRow {
  tenant_id: string;
  project_id: string;
  insight_type: string;
  granularity: string;
  session_id: string | null;
  message_id: string | null;
  span_id: string | null;
  agent_name: string | null;
  score: number;
  status: string;
  dimensions: string;
  pipeline_id: string;
  run_id: string;
  evaluated_at: string;
  event_timestamp: string;
  expires_at: string;
}

function isInsightResult(data: unknown): data is InsightResult {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.insightType === 'string' &&
    typeof d.granularity === 'string' &&
    typeof d.score === 'number'
  );
}

function findInsightSource(
  previousSteps: Record<string, { status: string; data: Record<string, any> }>,
  sourceStep?: string,
): { stepId: string; result: InsightResult } | null {
  if (sourceStep) {
    const step = previousSteps[sourceStep];
    if (!step) return null;
    if (isInsightResult(step.data)) return { stepId: sourceStep, result: step.data };
    return null;
  }

  // Auto-detect: find the last step whose output is an InsightResult
  const entries = Object.entries(previousSteps);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [id, step] = entries[i];
    if (step.status === 'success' && isInsightResult(step.data)) {
      return { stepId: id, result: step.data };
    }
  }
  return null;
}

function buildRow(
  input: PipelineStepContext,
  insight: InsightResult,
  record: InsightRecord | null,
  retentionDays: number,
): InsightRow {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  return {
    tenant_id: input.tenantId,
    project_id: input.projectId ?? '',
    insight_type: insight.insightType,
    granularity: record ? insight.granularity : insight.granularity,
    session_id: record?.sessionId ?? input.sessionId ?? null,
    message_id: record?.messageId ?? null,
    span_id: record?.spanId ?? null,
    agent_name: record?.agentName ?? null,
    score: record?.score ?? insight.score,
    status: record?.status ?? insight.status,
    dimensions: JSON.stringify(record?.dimensions ?? insight.dimensions),
    pipeline_id: input.pipelineInput.pipelineId ?? '',
    run_id: input.pipelineInput.runId ?? '',
    evaluated_at: now.toISOString(),
    event_timestamp:
      record?.eventTimestamp ?? input.pipelineInput.eventTimestamp ?? now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

export const storeInsightService = restate.service({
  name: 'StoreInsight',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const sourceStep = input.config.sourceStep as string | undefined;
      const retentionDays = (input.config.retentionDays as number) ?? DEFAULT_RETENTION_DAYS;

      try {
        // Find the InsightResult in previousSteps
        const source = findInsightSource(input.previousSteps, sourceStep);

        if (sourceStep && !input.previousSteps[sourceStep]) {
          return {
            status: 'fail',
            data: { error: `Source step '${sourceStep}' not found in previousSteps` },
            durationMs: Date.now() - startTime,
          };
        }

        if (sourceStep && input.previousSteps[sourceStep]?.status === 'fail') {
          return {
            status: 'skipped',
            data: { reason: `Source step '${sourceStep}' failed — skipping storage` },
            durationMs: Date.now() - startTime,
          };
        }

        if (!source) {
          // Check if the configured source step exists but doesn't have insightType
          if (sourceStep && input.previousSteps[sourceStep]) {
            return {
              status: 'fail',
              data: { error: `Step '${sourceStep}' output missing required 'insightType' field` },
              durationMs: Date.now() - startTime,
            };
          }
          return {
            status: 'fail',
            data: {
              error:
                'No InsightResult found in previousSteps (provide sourceStep config or ensure a compute handler ran)',
            },
            durationMs: Date.now() - startTime,
          };
        }

        const { result: insight } = source;

        // Build rows
        const rows: InsightRow[] = [];
        if (insight.records && insight.records.length > 0) {
          for (const record of insight.records) {
            rows.push(buildRow(input, insight, record, retentionDays));
          }
        } else {
          rows.push(buildRow(input, insight, null, retentionDays));
        }

        // Write to ClickHouse
        const recordsWritten = await ctx.run('store-insight-ch', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: TABLE,
            values: rows,
            format: 'JSONEachRow',
          });
          return rows.length;
        });

        return {
          status: 'success',
          data: {
            recordsWritten,
            insightType: insight.insightType,
            granularity: insight.granularity,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type StoreInsightService = typeof storeInsightService;
```

**Step 4: Build and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/store-insight.test.ts`
Expected: PASS (8 tests)

**Step 5: Run full test suite for regressions**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter @agent-platform/pipeline-engine test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/store-insight.service.ts packages/pipeline-engine/src/__tests__/store-insight.test.ts
git commit -m "[ABLP-39] feat(pipeline-engine): add store-insight activity service for ClickHouse writes"
```

---

## Task 5: Create `compute-toxicity` Handler

Behavioral/zero-cost handler. Reads MongoDB messages for a session, scores toxicity per message using keyword/pattern detection, produces session-level and per-message InsightResult.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock mongoose
const mockToArray = vi.fn();
const mockFind = vi.fn().mockReturnValue({ toArray: mockToArray });
const mockCollection = vi.fn().mockReturnValue({ find: mockFind });
vi.mock('mongoose', () => ({
  default: {
    connection: {
      collection: mockCollection,
    },
  },
}));

const { computeToxicityService } = await import('../pipeline/services/compute-toxicity.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computeToxicityService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      params: { threshold: 0.7 },
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

describe('ComputeToxicity service', () => {
  beforeEach(() => {
    mockToArray.mockReset();
    mockFind.mockClear();
    mockCollection.mockClear();
    mockFind.mockReturnValue({ toArray: mockToArray });
    mockCollection.mockReturnValue({ find: mockFind });
  });

  test('scores safe messages as pass with low toxicity', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Hello, can you help me?',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-2',
        role: 'user',
        content: 'Thank you for your help!',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.insightType).toBe('toxicity');
    expect(insight.granularity).toBe('session');
    expect(insight.score).toBeGreaterThan(0.5);
    expect(insight.status).toBe('pass');
    expect(insight.records).toHaveLength(2);
    expect(insight.records![0].status).toBe('pass');
  });

  test('detects toxic language and marks as fail', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'This is terrible service, you are completely incompetent idiots!',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.status).toBe('fail');
    expect(insight.records![0].score).toBeGreaterThan(0.7);
    expect(insight.records![0].status).toBe('fail');
  });

  test('returns per-message records with messageId', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Hello',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-2',
        role: 'user',
        content: 'Goodbye',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.records![0].messageId).toBe('msg-1');
    expect(insight.records![1].messageId).toBe('msg-2');
  });

  test('filters to user messages only by default (skips assistant)', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Question',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-2',
        role: 'assistant',
        content: 'Answer',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-3',
        role: 'user',
        content: 'Follow-up',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    // Only user messages scored
    expect(insight.records).toHaveLength(2);
  });

  test('includes agent messages when includeAgent param is true', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Question',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-2',
        role: 'assistant',
        content: 'Answer',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const input = makeInput({
      config: { params: { threshold: 0.7, includeAgent: true } },
    });
    const result = await execute(ctx(), input);
    const insight = result.data as InsightResult;

    expect(insight.records).toHaveLength(2);
  });

  test('queries MongoDB with correct tenantId and sessionId filter', async () => {
    mockToArray.mockResolvedValue([]);

    await execute(ctx(), makeInput());

    expect(mockCollection).toHaveBeenCalledWith('messages');
    expect(mockFind).toHaveBeenCalledWith({
      tenantId: 'acme-corp',
      sessionId: 'sess-001',
    });
  });

  test('fails when sessionId is missing', async () => {
    const input = makeInput({ sessionId: undefined });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('returns pass with empty records when no messages found', async () => {
    mockToArray.mockResolvedValue([]);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.score).toBe(1.0);
    expect(insight.status).toBe('pass');
    expect(insight.records).toHaveLength(0);
  });

  test('session-level score is average of per-message scores', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Hello nice to meet you',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
      {
        _id: 'msg-2',
        role: 'user',
        content: 'You stupid incompetent idiots are the worst terrible awful service!',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    // Session score = 1 - avg(toxicityScores)
    // msg-1 should be low, msg-2 should be high
    expect(insight.records).toHaveLength(2);
    expect(insight.records![0].score).toBeLessThan(insight.records![1].score);
    // Dimensions should include per-message stats
    expect(insight.dimensions).toHaveProperty('avgToxicity');
    expect(insight.dimensions).toHaveProperty('maxToxicity');
    expect(insight.dimensions).toHaveProperty('messageCount');
  });

  test('uses custom threshold from params', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'This is somewhat annoying terrible service',
        tenantId: 'acme-corp',
        sessionId: 'sess-001',
      },
    ]);

    // Low threshold means more things are toxic
    const inputLow = makeInput({ config: { params: { threshold: 0.1 } } });
    const resultLow = await execute(ctx(), inputLow);
    const insightLow = resultLow.data as InsightResult;

    // High threshold means fewer things are toxic
    const inputHigh = makeInput({ config: { params: { threshold: 0.99 } } });
    const resultHigh = await execute(ctx(), inputHigh);
    const insightHigh = resultHigh.data as InsightResult;

    // With low threshold, the message might fail; with high threshold, it passes
    // The raw score should be the same, but status depends on threshold
    expect(insightLow.records![0].score).toBe(insightHigh.records![0].score);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/compute-toxicity.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the service**

```typescript
// packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts
/**
 * ComputeToxicity — Restate activity service for behavioral toxicity scoring.
 *
 * Category 3: Zero-cost detection (no AI/LLM calls).
 * Reads MongoDB messages for a session, scores each message using keyword/pattern
 * matching, and returns a session-level InsightResult with per-message records.
 *
 * Config params:
 *   threshold?:     Score above which a message is toxic (default: 0.7)
 *   includeAgent?:  Also score assistant messages (default: false)
 *
 * Spec reference: T3 S8.8 (toxicity score, PII detection, jailbreak attempts)
 */
import * as restate from '@restatedev/restate-sdk';
import mongoose from 'mongoose';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { InsightResult, InsightRecord, InsightStatus } from '../insight-types.js';

const DEFAULT_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Toxicity keyword patterns (weighted)
// ---------------------------------------------------------------------------

interface ToxicPattern {
  pattern: RegExp;
  weight: number;
}

const TOXIC_PATTERNS: ToxicPattern[] = [
  // Profanity/insults — high weight
  { pattern: /\b(idiot|stupid|moron|dumb|fool|incompetent|useless|pathetic)\b/gi, weight: 0.3 },
  // Aggressive language
  { pattern: /\b(hate|terrible|worst|awful|disgusting|horrible|unacceptable)\b/gi, weight: 0.15 },
  // Threats
  { pattern: /\b(sue|lawyer|legal action|report you|fire you|kill)\b/gi, weight: 0.35 },
  // Explicit hostility
  { pattern: /\b(shut up|go away|leave me alone|damn|hell)\b/gi, weight: 0.1 },
  // ALL CAPS (shouting indicator) — if >50% of word chars are uppercase and message > 20 chars
  { pattern: /^[^a-z]*$/g, weight: 0.05 },
  // Excessive punctuation (frustration indicator)
  { pattern: /[!?]{3,}/g, weight: 0.05 },
];

/**
 * Score a single message's toxicity (0.0 = safe, 1.0 = maximally toxic).
 * Uses keyword/pattern matching — no AI cost.
 */
function scoreToxicity(content: string): number {
  if (!content || content.trim().length === 0) return 0;

  let totalScore = 0;

  for (const { pattern, weight } of TOXIC_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      // More matches = higher score (diminishing returns via log)
      const matchFactor = Math.min(1, Math.log2(matches.length + 1) / 3);
      totalScore += weight * (0.5 + 0.5 * matchFactor);
    }
  }

  // Clamp to 0.0–1.0
  return Math.min(1.0, Math.max(0.0, totalScore));
}

function statusFromScore(score: number, threshold: number): InsightStatus {
  if (score >= threshold) return 'fail';
  if (score >= threshold * 0.7) return 'warn';
  return 'pass';
}

export const computeToxicityService = restate.service({
  name: 'ComputeToxicity',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const params = (input.config.params ?? {}) as Record<string, unknown>;
      const threshold = (params.threshold as number) ?? DEFAULT_THRESHOLD;
      const includeAgent = (params.includeAgent as boolean) ?? false;

      if (!input.sessionId) {
        return {
          status: 'fail',
          data: { error: 'ComputeToxicity requires sessionId in pipeline context' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const insight = await ctx.run('compute-toxicity', async () => {
          // Fetch messages from MongoDB
          const collection = mongoose.connection.collection('messages');
          const docs = await collection
            .find({ tenantId: input.tenantId, sessionId: input.sessionId })
            .toArray();

          // Filter by role
          const messages = includeAgent ? docs : docs.filter((d: any) => d.role === 'user');

          if (messages.length === 0) {
            return {
              insightType: 'toxicity',
              granularity: 'session' as const,
              score: 1.0,
              status: 'pass' as const,
              dimensions: { avgToxicity: 0, maxToxicity: 0, messageCount: 0 },
              records: [],
            };
          }

          // Score each message
          const records: InsightRecord[] = [];
          let totalToxicity = 0;
          let maxToxicity = 0;

          for (const msg of messages) {
            const content = (msg as any).content ?? '';
            const toxicityScore = scoreToxicity(content);
            const msgStatus = statusFromScore(toxicityScore, threshold);

            totalToxicity += toxicityScore;
            maxToxicity = Math.max(maxToxicity, toxicityScore);

            records.push({
              messageId: String((msg as any)._id),
              score: toxicityScore,
              status: msgStatus,
              dimensions: {
                role: (msg as any).role,
                contentLength: content.length,
              },
            });
          }

          const avgToxicity = totalToxicity / messages.length;
          // Session score: 1.0 - avgToxicity (higher = safer)
          const sessionScore = 1.0 - avgToxicity;
          const sessionStatus = statusFromScore(avgToxicity, threshold);

          return {
            insightType: 'toxicity',
            granularity: 'session' as const,
            score: sessionScore,
            status: sessionStatus,
            dimensions: {
              avgToxicity: Math.round(avgToxicity * 1000) / 1000,
              maxToxicity: Math.round(maxToxicity * 1000) / 1000,
              messageCount: messages.length,
              threshold,
            },
            records,
          } satisfies InsightResult;
        });

        return {
          status: 'success',
          data: insight,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ComputeToxicityService = typeof computeToxicityService;
```

**Step 4: Build and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/compute-toxicity.test.ts`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts
git commit -m "[ABLP-39] feat(pipeline-engine): add compute-toxicity handler with keyword-based scoring"
```

---

## Task 6: Create `compute-tool-effectiveness` Handler

Quantitative handler. Queries ClickHouse traces for tool call spans, computes selection accuracy, parameter accuracy, retry rate, and call efficiency.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/compute-tool-effectiveness.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/compute-tool-effectiveness.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock ClickHouse client
const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockQuery,
  }),
}));

const { computeToolEffectivenessService } =
  await import('../pipeline/services/compute-tool-effectiveness.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computeToolEffectivenessService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      params: {},
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

/** Helper to create a mock ClickHouse JSON result set */
function chResult(rows: Record<string, unknown>[]) {
  return {
    json: async () => rows,
  };
}

describe('ComputeToolEffectiveness service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('computes tool effectiveness from successful tool calls', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 9,
          retried_calls: 1,
          avg_duration_ms: 150,
        },
        {
          tool_name: 'createTicket',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 200,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.insightType).toBe('tool-effectiveness');
    expect(insight.granularity).toBe('session');
    expect(insight.score).toBeGreaterThan(0);
    expect(insight.dimensions).toHaveProperty('selectionAccuracy');
    expect(insight.dimensions).toHaveProperty('retryRate');
    expect(insight.dimensions).toHaveProperty('totalToolCalls');
  });

  test('returns per-tool records', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 8,
          retried_calls: 2,
          avg_duration_ms: 150,
        },
        {
          tool_name: 'createTicket',
          total_calls: 3,
          successful_calls: 3,
          retried_calls: 0,
          avg_duration_ms: 200,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.records).toHaveLength(2);
    expect(insight.records![0].dimensions).toHaveProperty('toolName', 'searchKB');
    expect(insight.records![1].dimensions).toHaveProperty('toolName', 'createTicket');
  });

  test('filters to specific tools when tools param provided', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 100,
        },
      ]),
    );

    const input = makeInput({
      config: { params: { tools: ['searchKB', 'lookupOrder'] } },
    });

    await execute(ctx(), input);

    // Verify the query included tool name filter
    const queryCall = mockQuery.mock.calls[0][0];
    expect(queryCall.query).toContain('tool_name');
  });

  test('handles zero tool calls gracefully', async () => {
    mockQuery.mockResolvedValue(chResult([]));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.score).toBe(1.0);
    expect(insight.status).toBe('pass');
    expect(insight.dimensions.totalToolCalls).toBe(0);
    expect(insight.records).toHaveLength(0);
  });

  test('fails when sessionId is missing', async () => {
    const input = makeInput({ sessionId: undefined });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('queries ClickHouse with tenant_id and session_id params', async () => {
    mockQuery.mockResolvedValue(chResult([]));

    await execute(ctx(), makeInput());

    const queryCall = mockQuery.mock.calls[0][0];
    expect(queryCall.query_params.tenantId).toBe('acme-corp');
    expect(queryCall.query_params.sessionId).toBe('sess-001');
  });

  test('high retry rate results in lower score', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 5,
          retried_calls: 5,
          avg_duration_ms: 300,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.score).toBeLessThan(0.8);
    expect(insight.dimensions.retryRate).toBeGreaterThan(0.3);
  });

  test('perfect tool calls result in score near 1.0', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 10,
          retried_calls: 0,
          avg_duration_ms: 100,
        },
        {
          tool_name: 'createTicket',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 50,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.score).toBeGreaterThanOrEqual(0.9);
    expect(insight.status).toBe('pass');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/compute-tool-effectiveness.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the service**

```typescript
// packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts
/**
 * ComputeToolEffectiveness — Restate activity service for quantitative tool analysis.
 *
 * Category 1: Quantitative (ClickHouse queries, no AI cost).
 * Queries ClickHouse traces for tool call spans in a session, computes:
 * - Selection accuracy (successful / total)
 * - Retry rate (retried / total)
 * - Call efficiency (avg duration)
 * - Per-tool breakdowns
 *
 * Config params:
 *   tools?:     Array of tool names to filter (all tools if omitted)
 *   minCalls?:  Minimum calls to include a tool in results (default: 1)
 *
 * Spec reference: T2 S7.3 (selection accuracy, parameter accuracy, retry rate, call efficiency)
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { InsightResult, InsightRecord, InsightStatus } from '../insight-types.js';

const DEFAULT_MIN_CALLS = 1;

function statusFromScore(score: number): InsightStatus {
  if (score >= 0.8) return 'pass';
  if (score >= 0.5) return 'warn';
  return 'fail';
}

export const computeToolEffectivenessService = restate.service({
  name: 'ComputeToolEffectiveness',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const params = (input.config.params ?? {}) as Record<string, unknown>;
      const tools = params.tools as string[] | undefined;
      const minCalls = (params.minCalls as number) ?? DEFAULT_MIN_CALLS;

      if (!input.sessionId) {
        return {
          status: 'fail',
          data: { error: 'ComputeToolEffectiveness requires sessionId in pipeline context' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const insight = await ctx.run('compute-tool-effectiveness', async () => {
          const client = getClickHouseClient();

          // Build query for tool call aggregates from traces
          let toolFilter = '';
          const queryParams: Record<string, string | string[]> = {
            tenantId: input.tenantId,
            sessionId: input.sessionId!,
          };

          if (tools && tools.length > 0) {
            toolFilter = `AND tool_name IN ({tools:Array(String)})`;
            queryParams.tools = tools;
          }

          const result = await client.query({
            query: `
              SELECT
                tool_name,
                count() AS total_calls,
                countIf(success = 1) AS successful_calls,
                countIf(retry_attempt > 0) AS retried_calls,
                avg(duration_ms) AS avg_duration_ms
              FROM abl_platform.traces
              WHERE tenant_id = {tenantId:String}
                AND session_id = {sessionId:String}
                AND event_type = 'tool.call'
                ${toolFilter}
              GROUP BY tool_name
              HAVING total_calls >= ${minCalls}
              ORDER BY total_calls DESC
            `,
            query_params: queryParams,
          });

          const rows = (await result.json()) as Array<{
            tool_name: string;
            total_calls: number;
            successful_calls: number;
            retried_calls: number;
            avg_duration_ms: number;
          }>;

          if (rows.length === 0) {
            return {
              insightType: 'tool-effectiveness',
              granularity: 'session' as const,
              score: 1.0,
              status: 'pass' as const,
              dimensions: {
                selectionAccuracy: 1.0,
                retryRate: 0,
                avgDurationMs: 0,
                totalToolCalls: 0,
                toolCount: 0,
              },
              records: [],
            } satisfies InsightResult;
          }

          // Aggregate across all tools
          let totalCalls = 0;
          let totalSuccessful = 0;
          let totalRetried = 0;
          let weightedDuration = 0;
          const records: InsightRecord[] = [];

          for (const row of rows) {
            const calls = Number(row.total_calls);
            const successful = Number(row.successful_calls);
            const retried = Number(row.retried_calls);
            const avgDuration = Number(row.avg_duration_ms);

            totalCalls += calls;
            totalSuccessful += successful;
            totalRetried += retried;
            weightedDuration += avgDuration * calls;

            const toolAccuracy = calls > 0 ? successful / calls : 1.0;
            const toolRetryRate = calls > 0 ? retried / calls : 0;
            const toolScore = toolAccuracy * (1 - toolRetryRate * 0.5);

            records.push({
              agentName: row.tool_name,
              score: Math.round(toolScore * 1000) / 1000,
              status: statusFromScore(toolScore),
              dimensions: {
                toolName: row.tool_name,
                totalCalls: calls,
                successfulCalls: successful,
                retriedCalls: retried,
                accuracy: Math.round(toolAccuracy * 1000) / 1000,
                retryRate: Math.round(toolRetryRate * 1000) / 1000,
                avgDurationMs: Math.round(avgDuration),
              },
            });
          }

          const selectionAccuracy = totalCalls > 0 ? totalSuccessful / totalCalls : 1.0;
          const retryRate = totalCalls > 0 ? totalRetried / totalCalls : 0;
          const avgDurationMs = totalCalls > 0 ? weightedDuration / totalCalls : 0;

          // Overall score: accuracy weighted by retry penalty
          const overallScore = selectionAccuracy * (1 - retryRate * 0.5);

          return {
            insightType: 'tool-effectiveness',
            granularity: 'session' as const,
            score: Math.round(overallScore * 1000) / 1000,
            status: statusFromScore(overallScore),
            dimensions: {
              selectionAccuracy: Math.round(selectionAccuracy * 1000) / 1000,
              retryRate: Math.round(retryRate * 1000) / 1000,
              avgDurationMs: Math.round(avgDurationMs),
              totalToolCalls: totalCalls,
              toolCount: rows.length,
            },
            records,
          } satisfies InsightResult;
        });

        return {
          status: 'success',
          data: insight,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ComputeToolEffectivenessService = typeof computeToolEffectivenessService;
```

**Step 4: Build and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/compute-tool-effectiveness.test.ts`
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts packages/pipeline-engine/src/__tests__/compute-tool-effectiveness.test.ts
git commit -m "[ABLP-39] feat(pipeline-engine): add compute-tool-effectiveness handler with ClickHouse queries"
```

---

## Task 7: Register New Activity Types (Metadata + Router + Server)

Wire the three new services into the activity metadata registry, router dispatch table, and server bindings.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (add 3 entries to `ACTIVITY_TYPES`)
- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (add 3 entries to `SERVICE_HANDLERS`)
- Modify: `packages/pipeline-engine/src/pipeline/server.ts` (add 3 `.bind()` calls)
- Test: Update `packages/pipeline-engine/src/__tests__/activity-router.test.ts` (add 3 test cases)

**Step 1: Write the failing tests**

Add to `packages/pipeline-engine/src/__tests__/activity-router.test.ts` inside the `describe('ActivityRouter service')` block:

```typescript
test('known activity type "store-insight" returns success', async () => {
  const ctx = createMockRouterContext();
  const input = makeRouterInput({
    type: 'store-insight',
    config: { sourceStep: 'compute-step' },
  });
  // Provide a mock compute step output that is a valid InsightResult
  input.previousSteps = {
    'compute-step': {
      status: 'success',
      data: {
        insightType: 'toxicity',
        granularity: 'session',
        score: 0.85,
        status: 'pass',
        dimensions: {},
      },
    },
  };

  const result = await execute(ctx, input);
  // The store-insight handler will try to write to ClickHouse (which isn't mocked here)
  // so it may fail — but the important thing is the router dispatched it (no "Unknown activity type" error)
  expect(result.data.error).not.toContain('Unknown activity type');
});

test('known activity type "compute-toxicity" is recognized', async () => {
  const ctx = createMockRouterContext();
  const input = makeRouterInput({
    type: 'compute-toxicity',
    config: { params: { threshold: 0.7 } },
  });

  const result = await execute(ctx, input);
  expect(result.data.error).not.toContain('Unknown activity type');
});

test('known activity type "compute-tool-effectiveness" is recognized', async () => {
  const ctx = createMockRouterContext();
  const input = makeRouterInput({
    type: 'compute-tool-effectiveness',
    config: { params: {} },
  });

  const result = await execute(ctx, input);
  expect(result.data.error).not.toContain('Unknown activity type');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/activity-router.test.ts`
Expected: FAIL — "Unknown activity type" for store-insight, compute-toxicity, compute-tool-effectiveness

**Step 3: Update activity-metadata.ts**

Add to the `ACTIVITY_TYPES` object in `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (before the closing `};` at line 182):

```typescript
  'store-insight': {
    name: 'Store Insight',
    description: 'Write InsightResult from a compute handler to ClickHouse insight_results table',
    configSchema: {
      required: [],
      properties: {
        sourceStep: {
          type: 'string',
          description: 'Step ID to read InsightResult from (auto-detected if omitted)',
        },
        retentionDays: {
          type: 'number',
          description: 'TTL in days for the stored rows (default: 90)',
        },
      },
    },
    outputSchema: {
      properties: {
        recordsWritten: { type: 'number', description: 'Number of rows written to ClickHouse' },
        insightType: { type: 'string', description: 'Handler type that produced the result' },
        granularity: { type: 'string', description: 'Granularity level of the stored result' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 3,
  },

  'compute-toxicity': {
    name: 'Compute Toxicity',
    description: 'Score message toxicity for a session using keyword/pattern detection (zero AI cost)',
    configSchema: {
      required: [],
      properties: {
        params: {
          type: 'object',
          description: '{ threshold?: number (default 0.7), includeAgent?: boolean (default false) }',
        },
      },
    },
    outputSchema: {
      properties: {
        insightType: { type: 'string', description: 'Always "toxicity"' },
        granularity: { type: 'string', description: 'Always "session"' },
        score: { type: 'number', description: 'Session-level safety score (1.0 - avgToxicity)' },
        status: { type: 'string', description: 'pass | warn | fail' },
        dimensions: { type: 'object', description: '{ avgToxicity, maxToxicity, messageCount, threshold }' },
        records: { type: 'array', description: 'Per-message toxicity scores' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'compute-tool-effectiveness': {
    name: 'Compute Tool Effectiveness',
    description: 'Analyze tool call accuracy, retry rate, and efficiency from ClickHouse traces',
    configSchema: {
      required: [],
      properties: {
        params: {
          type: 'object',
          description: '{ tools?: string[] (filter to specific tools), minCalls?: number (default 1) }',
        },
      },
    },
    outputSchema: {
      properties: {
        insightType: { type: 'string', description: 'Always "tool-effectiveness"' },
        granularity: { type: 'string', description: 'Always "session"' },
        score: { type: 'number', description: 'Overall effectiveness score (0.0–1.0)' },
        status: { type: 'string', description: 'pass | warn | fail' },
        dimensions: {
          type: 'object',
          description: '{ selectionAccuracy, retryRate, avgDurationMs, totalToolCalls, toolCount }',
        },
        records: { type: 'array', description: 'Per-tool effectiveness breakdown' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },
```

**Step 4: Update activity-router.service.ts**

In `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`:

Add imports (after line 20):

```typescript
import { storeInsightService } from '../services/store-insight.service.js';
import { computeToxicityService } from '../services/compute-toxicity.service.js';
import { computeToolEffectivenessService } from '../services/compute-tool-effectiveness.service.js';
```

Add to `SERVICE_HANDLERS` (after line 45, before the `};`):

```typescript
  'store-insight': (storeInsightService as any).service.execute,
  'compute-toxicity': (computeToxicityService as any).service.execute,
  'compute-tool-effectiveness': (computeToolEffectivenessService as any).service.execute,
```

**Step 5: Update server.ts**

In `packages/pipeline-engine/src/pipeline/server.ts`:

Add imports (after the existing service imports):

```typescript
import { storeInsightService } from './services/store-insight.service.js';
import { computeToxicityService } from './services/compute-toxicity.service.js';
import { computeToolEffectivenessService } from './services/compute-tool-effectiveness.service.js';
```

Add `.bind()` calls (after `.bind(runLegacyWorkflowService)` on line 44):

```typescript
    .bind(storeInsightService)
    .bind(computeToxicityService)
    .bind(computeToolEffectivenessService)
```

**Step 6: Build and run the router tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/activity-router.test.ts`
Expected: PASS (all existing + 3 new tests)

**Step 7: Run full test suite**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter @agent-platform/pipeline-engine test`
Expected: All tests pass (157 existing + new tests)

**Step 8: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/activity-metadata.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/server.ts packages/pipeline-engine/src/__tests__/activity-router.test.ts
git commit -m "[ABLP-39] feat(pipeline-engine): register store-insight, compute-toxicity, compute-tool-effectiveness"
```

---

## Task 8: Integration Test — Toxicity Pipeline End-to-End

Create a zero-mock integration test that chains `compute-toxicity` → `store-insight`, verifying the full data flow from MongoDB messages to ClickHouse write.

**Files:**

- Create: `packages/pipeline-engine/src/__tests__/integration-insight-pipeline.test.ts`

**Step 1: Write the integration test**

```typescript
// packages/pipeline-engine/src/__tests__/integration-insight-pipeline.test.ts
/**
 * Integration test: Insight pipeline — ComputeToxicity → StoreInsight
 *
 * Tests the data flow from compute handler output to ClickHouse storage mapping.
 * Mocks only external I/O (MongoDB, ClickHouse) — all business logic runs real.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock MongoDB (for compute-toxicity)
const mockToArray = vi.fn();
const mockFind = vi.fn().mockReturnValue({ toArray: mockToArray });
const mockCollection = vi.fn().mockReturnValue({ find: mockFind });
vi.mock('mongoose', () => ({
  default: { connection: { collection: mockCollection } },
}));

// Mock ClickHouse (for store-insight)
const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ insert: mockInsert }),
}));

const { computeToxicityService } = await import('../pipeline/services/compute-toxicity.service.js');
const { storeInsightService } = await import('../pipeline/services/store-insight.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (...args: any[]) => console.log('[Restate]', ...args) },
  };
}

function handler(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return svc.service.execute;
}

describe('Integration: ComputeToxicity → StoreInsight pipeline', () => {
  const computeToxicity = handler(computeToxicityService);
  const storeInsight = handler(storeInsightService);

  beforeEach(() => {
    mockToArray.mockReset();
    mockFind.mockClear().mockReturnValue({ toArray: mockToArray });
    mockCollection.mockClear().mockReturnValue({ find: mockFind });
    mockInsert.mockClear().mockResolvedValue(undefined);
  });

  test('safe session → compute produces InsightResult → store writes 1 summary + N records', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'Hello, can you help?',
        tenantId: 'acme',
        sessionId: 'sess-1',
      },
      { _id: 'msg-2', role: 'user', content: 'Thank you!', tenantId: 'acme', sessionId: 'sess-1' },
    ]);

    // Step 1: Compute toxicity
    const computeResult = await computeToxicity(ctx(), {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      config: { params: { threshold: 0.7 } },
      previousSteps: {},
      pipelineInput: { tenantId: 'acme', projectId: 'proj-1', sessionId: 'sess-1' },
    });

    expect(computeResult.status).toBe('success');
    const insight = computeResult.data as InsightResult;
    expect(insight.insightType).toBe('toxicity');
    expect(insight.status).toBe('pass');
    expect(insight.records).toHaveLength(2);

    // Step 2: Store the insight
    const storeResult = await storeInsight(ctx(), {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      config: { sourceStep: 'compute-toxicity' },
      previousSteps: { 'compute-toxicity': computeResult },
      pipelineInput: {
        tenantId: 'acme',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        pipelineId: 'pipe-1',
        runId: 'run-1',
      },
    });

    expect(storeResult.status).toBe('success');
    expect(storeResult.data.recordsWritten).toBe(2); // per-message records

    // Verify ClickHouse rows
    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe('acme');
    expect(rows[0].insight_type).toBe('toxicity');
    expect(rows[0].pipeline_id).toBe('pipe-1');
    expect(rows[0].run_id).toBe('run-1');
  });

  test('toxic session → store captures fail status and high scores', async () => {
    mockToArray.mockResolvedValue([
      {
        _id: 'msg-1',
        role: 'user',
        content: 'You stupid incompetent idiots are terrible!',
        tenantId: 'acme',
        sessionId: 'sess-2',
      },
    ]);

    const computeResult = await computeToxicity(ctx(), {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-2',
      config: { params: { threshold: 0.3 } },
      previousSteps: {},
      pipelineInput: { tenantId: 'acme', projectId: 'proj-1', sessionId: 'sess-2' },
    });

    const insight = computeResult.data as InsightResult;
    expect(insight.status).toBe('fail');

    const storeResult = await storeInsight(ctx(), {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-2',
      config: { sourceStep: 'compute-toxicity' },
      previousSteps: { 'compute-toxicity': computeResult },
      pipelineInput: {
        tenantId: 'acme',
        projectId: 'proj-1',
        sessionId: 'sess-2',
        pipelineId: 'pipe-1',
        runId: 'run-2',
      },
    });

    expect(storeResult.status).toBe('success');
    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.status).toBe('fail');
    expect(row.score).toBeGreaterThan(0.3);
  });

  test('store-insight skips when compute step failed', async () => {
    const storeResult = await storeInsight(ctx(), {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-3',
      config: { sourceStep: 'compute-toxicity' },
      previousSteps: {
        'compute-toxicity': { status: 'fail', data: { error: 'MongoDB timeout' } },
      },
      pipelineInput: {
        tenantId: 'acme',
        projectId: 'proj-1',
        sessionId: 'sess-3',
        pipelineId: 'p',
        runId: 'r',
      },
    });

    expect(storeResult.status).toBe('skipped');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
```

**Step 2: Build and run the test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm --filter @agent-platform/pipeline-engine test -- --run src/__tests__/integration-insight-pipeline.test.ts`
Expected: PASS (3 tests)

**Step 3: Run full test suite**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter @agent-platform/pipeline-engine test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/__tests__/integration-insight-pipeline.test.ts
git commit -m "[ABLP-39] test(pipeline-engine): add insight pipeline integration tests"
```

---

## Summary of Deliverables

| Task | Component                                 | Files                                              | Tests                  |
| ---- | ----------------------------------------- | -------------------------------------------------- | ---------------------- |
| 1    | ClickHouse `insight_results` DDL          | `packages/database/src/clickhouse-schemas/init.ts` | 6                      |
| 2    | Pipeline engine → ClickHouse init         | `package.json`, `server.ts`                        | 0 (build verification) |
| 3    | `InsightResult` types                     | `insight-types.ts`                                 | 5                      |
| 4    | `store-insight` activity service          | `store-insight.service.ts`                         | 8                      |
| 5    | `compute-toxicity` handler                | `compute-toxicity.service.ts`                      | 10                     |
| 6    | `compute-tool-effectiveness` handler      | `compute-tool-effectiveness.service.ts`            | 8                      |
| 7    | Registration (metadata + router + server) | 3 existing files                                   | 3                      |
| 8    | Integration test                          | `integration-insight-pipeline.test.ts`             | 3                      |

**Total new tests:** ~43
**Total new files:** 7 (3 services, 1 types, 3 test files)
**Modified files:** 5 (init.ts, package.json, server.ts, activity-metadata.ts, activity-router.service.ts)
