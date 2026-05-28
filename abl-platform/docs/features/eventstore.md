# EventStore Feature Spec

> **Status**: STABLE
> **Package**: `packages/eventstore` (`@abl/eventstore`)
> **Owner**: Platform Core
> **Last Updated**: 2026-04-09

---

## 1. Problem Statement

The ABL platform needs a unified event sourcing and data pipeline infrastructure that captures every meaningful operation across the runtime -- session lifecycle, LLM calls, tool invocations, agent routing, flow execution, evaluations, and more. Before EventStore, telemetry was fragmented across MongoDB TraceStore, ClickHouse `llm_metrics` table, and ad-hoc logging. This created:

- **Siloed analytics**: No single query surface for cross-category metrics (e.g., correlating LLM cost with session completion rate).
- **No structured retention**: No plan-based TTL or GDPR compliance for telemetry data.
- **No real-time forwarding**: No webhook-based event delivery to external systems.
- **Fragile dual-writes**: Trace events persisted to MongoDB TraceStore only; no structured analytics pipeline.

## 2. Target Users

| User Role                | Need                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| **Platform Operators**   | Retention policy enforcement, tenant offboarding, GDPR compliance |
| **Agent Developers**     | Session-level traces, LLM cost breakdown, error rate dashboards   |
| **Product Managers**     | Session completion rate, evaluation scores, quality trends        |
| **ML/Eval Engineers**    | Async evaluation pipeline, scoring, anomaly detection             |
| **External Integrators** | Webhook-based event forwarding to external analytics/CRM systems  |

## 3. Scope

### In Scope

- Unified event envelope (`PlatformEvent`) with 15+ categories
- Pluggable storage backends (ClickHouse production, Memory test)
- Pluggable queue backends (Direct, BullMQ, Kafka, Memory)
- 3-level failover for zero data loss (Queue -> Direct -> WAL)
- Zod-based schema registry with 40+ validated event types
- Plan-based retention with TTL tiers (FREE/TEAM/BUSINESS/ENTERPRISE)
- GDPR compliance: session cascade, actor anonymization, tenant deletion
- Webhook forwarding with pattern matching and subscription caching
- Async evaluation pipeline: dispatcher, LLM judge, code scorer
- Threshold-based alerting engine with cooldown and notifications
- ClickHouse DDL: tiered storage, materialized views, skip indexes
- Analytics API routes (`/api/projects/:projectId/analytics/*`)
- Runtime integration: singleton, trace-emitter dual-write, WAL recovery
- LLM metrics migration bridge (legacy `llm_metrics` -> PlatformEvent)
- 3 deployment modes: embedded, remote (HTTP client), standalone service

### Out of Scope

- Real-time streaming to external systems (Kafka consumer for Spark/Flink)
- Studio UI dashboard components (separate feature)
- Custom evaluator marketplace
- Cross-tenant analytics aggregation (admin-level)
- ClickHouse cluster management / sharding topology

## 4. Requirements

### Functional Requirements

| ID    | Requirement                                                                         | Priority | Status |
| ----- | ----------------------------------------------------------------------------------- | -------- | ------ |
| FR-1  | Emit events with Zod validation, auto-enrichment (event_id, category, timestamp)    | P0       | DONE   |
| FR-2  | Persist events to ClickHouse via BufferedWriter (10K batch / 5s flush / 100K max)   | P0       | DONE   |
| FR-3  | Query events with tenant/project scoping, time range, category/type/session filters | P0       | DONE   |
| FR-4  | Aggregate events with GROUP BY (category, event_type, agent, channel, hour, day)    | P0       | DONE   |
| FR-5  | Plan-based retention: purge expired events, scrub PII on schedule                   | P0       | DONE   |
| FR-6  | GDPR: cascade delete by session, anonymize actor, delete tenant                     | P0       | DONE   |
| FR-7  | Webhook forwarding with pattern matching and BullMQ delivery                        | P1       | DONE   |
| FR-8  | 3-level failover: primary queue -> fallback direct write -> filesystem WAL          | P1       | DONE   |
| FR-9  | WAL recovery: startup replay + periodic recovery (5min interval)                    | P1       | DONE   |
| FR-10 | Async evaluation pipeline: session.ended trigger, sampling, fan-out                 | P1       | DONE   |
| FR-11 | LLM judge evaluator and code scorer evaluator implementations                       | P1       | DONE   |
| FR-12 | Threshold-based alerting: rule evaluation, cooldown, webhook notification           | P2       | DONE   |
| FR-13 | LLM metrics migration bridge (dual-write from legacy table)                         | P2       | DONE   |
| FR-14 | Analytics API: metrics, events, cost-breakdown, session-metrics, sql-query          | P0       | DONE   |
| FR-15 | Remote mode: HTTP client for query/lifecycle when running as separate service       | P2       | DONE   |

### Non-Functional Requirements

| ID    | Requirement                                       | Target                 | Status                         |
| ----- | ------------------------------------------------- | ---------------------- | ------------------------------ |
| NFR-1 | Event validation latency                          | <1ms per event         | MET                            |
| NFR-2 | Write throughput (embedded, direct queue)         | 50K events/sec         | MET (BufferedWriter)           |
| NFR-3 | Query response time (raw events, <1M rows)        | <500ms                 | MET (parameterized ClickHouse) |
| NFR-4 | Aggregation response time (with MVs)              | <200ms                 | MET (AggregatingMergeTree MVs) |
| NFR-5 | Zero data loss under infrastructure failure       | WAL recovery 100%      | MET                            |
| NFR-6 | Tenant isolation: every query scoped by tenant_id | 100%                   | MET                            |
| NFR-7 | Cache TTL for query results                       | 60s default            | MET                            |
| NFR-8 | WAL file rotation                                 | 100MB default          | MET                            |
| NFR-9 | Subscription cache (webhook forwarder)            | 1000 entries, 1min TTL | MET                            |

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Runtime Process                             │
│                                                                  │
│  TraceEmitter ──> EventEmitter ──> IEventQueue ──> IEventStore  │
│       │                │               │               │         │
│       │         Zod Validation    [Direct|BullMQ    ClickHouse   │
│       │         + Enrichment       |Kafka|Memory]   Buffered     │
│       │                                              Writer      │
│       │                                                          │
│  (3-level failover if resilience=true)                          │
│       │         ┌──────────────────────┐                        │
│       └──>      │ ResilientEmitter     │                        │
│                 │  L1: Primary Queue   │                        │
│                 │  L2: Direct Write    │                        │
│                 │  L3: Filesystem WAL  │                        │
│                 └──────────────────────┘                        │
│                                                                  │
│  EventQueryService ──> IEventReader (cache layer)               │
│  EventRetentionService ──> IEventLifecycle                      │
│  EventGDPRService ──> IEventLifecycle                           │
│  EventWebhookForwarder ──> BullMQ webhook-delivery queue        │
│  EvaluationDispatcher ──> IEvaluator[] (LLM Judge, Code Scorer) │
│  AlertScheduler ──> ThresholdEvaluator ──> AlertNotifier        │
└─────────────────────────────────────────────────────────────────┘
```

### Deployment Modes

| Mode       | Description                  | Write Path              | Read Path    |
| ---------- | ---------------------------- | ----------------------- | ------------ |
| `embedded` | All in-process (default)     | Queue -> Store          | Store direct |
| `remote`   | Runtime delegates to service | Queue (Redis/Kafka)     | HTTP client  |
| `service`  | Standalone event service     | Queue consumer -> Store | Store direct |

## 6. Event Schema

### PlatformEvent Envelope

All events share this envelope (defined in `src/schema/platform-event.ts`):

| Field            | Type          | Required             | Description                                              |
| ---------------- | ------------- | -------------------- | -------------------------------------------------------- |
| `event_id`       | string (ULID) | Yes (auto-generated) | Unique event identifier                                  |
| `event_type`     | string        | Yes                  | Dotted notation: `session.started`, `llm.call.completed` |
| `category`       | EventCategory | Yes (auto-inferred)  | One of 15 categories                                     |
| `tenant_id`      | string        | Yes                  | Tenant isolation key                                     |
| `project_id`     | string        | Yes                  | Project scope                                            |
| `session_id`     | string        | Optional             | Session context                                          |
| `trace_id`       | string        | Optional             | Distributed trace ID                                     |
| `span_id`        | string        | Optional             | Span within trace                                        |
| `parent_span_id` | string        | Optional             | Parent span for nesting                                  |
| `agent_name`     | string        | Optional             | Agent that generated the event                           |
| `deployment_id`  | string        | Optional             | Deployment version                                       |
| `channel`        | string        | Optional             | Channel type (web, voice, sms)                           |
| `actor_id`       | string        | Optional             | User/contact who triggered                               |
| `actor_type`     | enum          | Optional             | user, contact, system, agent                             |
| `timestamp`      | DateTime64(3) | Yes (auto-generated) | UTC event time                                           |
| `duration_ms`    | UInt32        | Optional             | Operation duration                                       |
| `has_error`      | boolean       | Optional             | Error flag                                               |
| `error_message`  | string        | Optional             | Error detail                                             |
| `error_type`     | string        | Optional             | Error classification                                     |
| `data`           | JSON          | Yes                  | Event-specific payload (Zod validated)                   |
| `metadata`       | JSON          | Optional             | Tags, labels, custom dimensions                          |

### Event Categories (15)

session, message, llm, tool, agent, gather, flow, channel, deployment, search, voice, audit, evaluation, feedback, system

### Registered Event Types (40+)

**Session**: session.started, session.ended, session.resumed, session.terminated, session.updated
**Message**: message.user.received, message.agent.sent
**LLM**: llm.call.completed, llm.call.failed, llm.model.resolved
**Tool**: tool.call.completed, tool.call.failed
**Agent**: agent.entered, agent.exited, agent.handoff, agent.escalated
**Gather**: gather.started, gather.field.collected, gather.completed
**Flow**: flow.step.entered, flow.step.exited, flow.transition
**Channel**: channel.connected, channel.disconnected
**Deployment**: deployment.activated, deployment.deactivated
**Search**: search.query, search.result
**Voice**: voice.call.started, voice.call.ended
**Auth/Audit**: auth.login, auth.logout, audit.action
**Evaluation**: evaluation.started, evaluation.completed, evaluation.failed, evaluation.batch.completed, evaluation.threshold.violated, evaluation.quality.scored, evaluation.sentiment.analyzed, evaluation.summary.generated
**Feedback**: feedback.submitted
**System**: system.startup, system.shutdown

### PII-Containing Events

Events marked `containsPII: true` in the registry are subject to PII scrubbing during retention:

- `evaluation.summary.generated` (summaries may contain conversation PII)
- `feedback.submitted` (feedback text may contain PII)

## 7. Storage Architecture

### ClickHouse Table: `abl_platform.platform_events`

- **Engine**: ReplicatedMergeTree
- **ORDER BY**: (tenant_id, category, event_type, timestamp)
- **PARTITION BY**: toDate(timestamp)
- **TTL tiers**: 30d -> warm, 90d -> cold, 730d -> DELETE
- **Compression**: ZSTD(1) for identifiers, ZSTD(3) for JSON data
- **Skip indexes**: bloom_filter on session_id, trace_id, span_id, project_id; set(2) on has_error

### Materialized Views (deploy-on-demand)

| MV                              | Purpose                 | ORDER BY                                       |
| ------------------------------- | ----------------------- | ---------------------------------------------- |
| `session_metrics_daily_mv`      | Session KPIs per day    | (tenant_id, project_id, day, channel)          |
| `llm_cost_hourly_mv`            | LLM cost per hour/model | (tenant_id, project_id, hour, model, provider) |
| `platform_events_by_session_mv` | Session trace lookups   | (tenant_id, session_id, timestamp, event_id)   |

### Plan-Based Retention

| Plan       | Total Retention | PII Retention |
| ---------- | --------------- | ------------- |
| FREE       | 30 days         | 7 days        |
| TEAM       | 90 days         | 30 days       |
| BUSINESS   | 365 days        | 90 days       |
| ENTERPRISE | 2555 days (7y)  | 365 days      |

## 8. Queue Architecture

### Queue Backends

| Backend            | Durability        | Latency | Use Case                  |
| ------------------ | ----------------- | ------- | ------------------------- |
| `DirectQueue`      | None (in-process) | <1ms    | Development, low-volume   |
| `BullMQEventQueue` | Redis-backed      | ~5ms    | Standard production       |
| `KafkaEventQueue`  | Kafka log         | ~10ms   | High-throughput (>100K/s) |
| `MemoryEventQueue` | None (in-memory)  | <1ms    | Unit tests                |

### Resilient Emitter (3-Level Failover)

1. **Level 1**: Primary queue (Kafka/BullMQ) -- if `isHealthy()` returns true
2. **Level 2**: Direct store write (ClickHouse BufferedWriter) -- if primary fails
3. **Level 3**: Filesystem WAL (JSONL append-only) -- if store write fails

Health check runs every 5s. WAL files rotate at 100MB, expire after 24h.

## 9. Evaluation Pipeline

The async evaluation subsystem processes sessions after completion:

1. **Trigger**: `session.ended` event detected (via polling or event handler)
2. **Config lookup**: `IEvaluationConfigProvider.getConfig(tenantId, projectId)`
3. **Sampling**: Global and per-evaluator sampling (random, stratified, all, anomaly_triggered)
4. **Input assembly**: Fetch conversation messages + trace events for the session
5. **Fan-out**: Run evaluators concurrently (max 5 default) via `Promise.allSettled`
6. **Result emission**: Emit `evaluation.started`, `evaluation.completed`, `evaluation.failed` events

### Evaluator Types

| Type          | Implementation      | Description                         |
| ------------- | ------------------- | ----------------------------------- |
| `llm_judge`   | `LLMJudgeEvaluator` | LLM-as-judge with structured prompt |
| `code_scorer` | `CodeScorer`        | Deterministic metric computation    |
| `ml_model`    | (interface only)    | External ML model scoring           |
| `composite`   | (interface only)    | Weighted combination of evaluators  |

## 10. Alerting Engine

The alerting subsystem monitors metrics and sends notifications:

1. **Rule store**: `IAlertRuleStore` provides CRUD for tenant/project-scoped rules
2. **Metric reader**: `IMetricsReader` queries aggregated values from materialized views
3. **Threshold evaluation**: Pure function comparison (gt, gte, lt, lte, eq, neq)
4. **State machine**: ok -> firing -> resolved (with cooldown)
5. **Notification**: Webhook delivery with HMAC signing

## 11. Webhook Forwarding

Events matching tenant webhook subscriptions are forwarded to external URLs:

- **Pattern matching**: `events.session.*` matches `session.started`, `session.ended`, etc.
- **Delivery**: Enqueued to existing BullMQ `webhook-delivery` queue
- **Cache**: In-memory Map with 1-min TTL, max 1000 entries, periodic cleanup every 2min
- **Security**: HMAC-SHA256 signing, SSRF protection, retry with exponential backoff

## 12. Runtime Integration

### Singleton Pattern

`apps/runtime/src/services/eventstore-singleton.ts`:

- `initializeEventStore({ clickhouseReady })` at server startup
- `getEventStore()` returns `EventStoreServices | null`
- Registers GDPR cascade hooks via `registerEventCascadeHook()`
- WAL recovery on startup + periodic recovery

### Trace-Emitter Dual-Write

`apps/runtime/src/services/trace-emitter.ts`:

- Every trace event is dual-written to both TraceStore (MongoDB) and EventStore (ClickHouse)
- Trace type mapping via `TRACE_TO_PLATFORM_TYPE` lookup
- PII scrubbing and secret redaction before EventStore write
- Custom dimensions attached as metadata
- Non-blocking: fire-and-forget with try/catch

### Analytics API

`apps/runtime/src/routes/analytics.ts` -- mounted at `/api/projects/:projectId/analytics`:

- `GET /metrics` -- aggregated metrics with GROUP BY
- `GET /events` -- raw event listing with filters
- `GET /agents/:agentName` -- per-agent performance rollup
- `GET /cost-breakdown` -- LLM cost by model/provider
- `GET /session-metrics` -- session completion rate, avg duration
- `POST /query` -- ad-hoc event query
- `POST /aggregate` -- ad-hoc aggregation query
- `GET /event-counts` -- event counts by category
- `POST /sql-query` -- raw ClickHouse SQL (SELECT only, tenant-isolated)

All routes use `authMiddleware`, `requireProjectScope`, `requireProjectPermission`, and `tenantRateLimit`.

## 13. Security Considerations

### Tenant Isolation

- Every ClickHouse query includes `tenant_id = {tenantId:String}` in WHERE clause
- Cache keys include tenant ID: `eventstore:{tenantId}:{operation}:{hash}`
- Analytics API routes enforce `requireProjectPermission`
- SQL query endpoint enforces `tenant_id` filter presence

### KNOWN ISSUE: Cross-Tenant Wildcard in EvaluationDispatcher (HIGH)

**File**: `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`, line 193
**Finding**: `pollAndProcess()` queries with `tenantId: '*'` and `projectId: '*'`
**Impact**: If the ClickHouse store does not reject wildcard tenant IDs, this could query across all tenant data
**Mitigation**: The comment says "Cross-tenant poll -- dispatcher runs with system privileges" but:

1. The ClickHouse query uses `tenant_id = {tenantId:String}` which would match literal `'*'` not all tenants
2. MemoryEventStore implementation may behave differently
3. No authorization check confirms the caller has system privileges
   **Recommendation**: Replace wildcard polling with a proper event bus subscription or per-tenant iteration

### Other Security Notes

- SQL query endpoint blocks non-SELECT queries via regex + keyword check
- `data` field validated via Zod at emit time (non-blocking in non-strict mode)
- WAL directory created with `mode: 0o700` (owner-only access)
- PII scrubbing via `redactPII()` and `scrubSecrets()` before EventStore write

## 14. Code Quality Issues

### console.log Usage (58 occurrences)

The eventstore package uses `console.log/warn/error/debug` in 9 files (58 total occurrences) instead of the platform standard `createLogger('module')` from `@abl/compiler/platform`. This violates CLAUDE.md rule: "Never console.log in server code."

**Files affected**: event-recovery-service.ts, filesystem-wal.ts, event-webhook-forwarder.ts, resilient-event-emitter.ts, clickhouse-event-store.ts, kafka-queue.ts, event-emitter.ts, direct-queue.ts, bullmq-queue.ts

### In-Memory Map Without Eviction Policy

- `EvaluationDispatcher.evaluators` Map has no max size or TTL
- `AlertScheduler` has no Map concerns (uses injected stores)

### Passthrough Schemas

Many event data schemas use `.passthrough()` which allows arbitrary additional fields. While this supports extensibility, it weakens type safety and could lead to unbounded data payloads.

## 15. Migration Strategy

### LLM Metrics Bridge

`src/migration/llm-metrics-bridge.ts` provides:

- `mapLLMMetricsToPlatformEvent(metricsRow)` -- converts legacy `llm_metrics` rows to `llm.call.completed` events
- `emitLLMMetricsAsAnalytics(emitter, metricsRow)` -- emit as platform event

### Trace-Emitter Dual-Write

Runtime `trace-emitter.ts` dual-writes every trace event to both TraceStore and EventStore, enabling gradual migration from MongoDB-based traces to ClickHouse-based analytics.

## 16. Testing Strategy

### Existing Tests (packages/eventstore/src/**tests**)

| Test File                        | Coverage                                |
| -------------------------------- | --------------------------------------- |
| `factory.test.ts`                | Factory wiring for all 3 modes          |
| `event-emitter.test.ts`          | Validation, enrichment, batch           |
| `event-registry.test.ts`         | Registration, validation, PII detection |
| `event-categories.test.ts`       | Category inference from event type      |
| `store-contract.test.ts`         | IEventStore contract (MemoryEventStore) |
| `queue-contract.test.ts`         | IEventQueue contract                    |
| `query-service.test.ts`          | Caching, convenience methods            |
| `webhook-forwarder.test.ts`      | Pattern matching, subscription cache    |
| `evaluation-dispatcher.test.ts`  | Sampling, fan-out, stats                |
| `evaluation-code-scorer.test.ts` | Code scorer evaluator                   |
| `evaluation-llm-judge.test.ts`   | LLM judge evaluator                     |
| `alerting-scheduler.test.ts`     | Rule evaluation, cooldown, notification |
| `alerting-threshold.test.ts`     | Threshold comparison, state machine     |
| `retention-gdpr.test.ts`         | Retention, GDPR cascade, PII scrub      |

### Gaps

- No E2E tests against real ClickHouse
- No integration test for trace-emitter -> EventStore dual-write
- No test for cross-tenant wildcard in EvaluationDispatcher
- No test for WAL recovery after simulated infrastructure failure
- No load/performance test

## 17. Dependencies

### Internal

| Package                    | Direction   | Purpose                                                                       |
| -------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `@agent-platform/database` | Imports     | `BufferedClickHouseWriter`, `getClickHouseClient`, `registerEventCascadeHook` |
| `@abl/compiler`            | Imports     | `createLogger`, `scrubToolCallData`, `redactPII`, `scrubSecrets`              |
| `apps/runtime`             | Consumed by | Singleton initialization, trace-emitter, analytics routes                     |

### External

| Package              | Version   | Purpose                       |
| -------------------- | --------- | ----------------------------- |
| `@clickhouse/client` | workspace | ClickHouse Node.js client     |
| `zod`                | workspace | Event data validation         |
| `ulid`               | workspace | Event ID generation           |
| `bullmq`             | workspace | Redis-backed queue (optional) |
| `kafkajs`            | workspace | Kafka queue (optional)        |

## 18. Open Questions / Future Work

| ID   | Question                                                                                        | Status               |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------- |
| OQ-1 | Should EvaluationDispatcher use event bus subscription instead of polling with `tenantId: '*'`? | OPEN (HIGH priority) |
| OQ-2 | Should `.passthrough()` be removed from event schemas to prevent unbounded payloads?            | OPEN                 |
| OQ-3 | Should `console.log` be replaced with `createLogger` across all 9 files?                        | OPEN                 |
| OQ-4 | Should the Kafka queue be tested in CI with a real Kafka broker?                                | DEFERRED             |
| OQ-5 | Should the ClickHouse materialized views be auto-deployed vs. admin-deployed?                   | DEFERRED             |
| OQ-6 | Should the alerting engine support email/Slack notification channels?                           | DEFERRED             |
| OQ-7 | Should `EvaluationDispatcher.evaluators` Map have a max size limit?                             | OPEN                 |
