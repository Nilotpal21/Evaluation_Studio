# EventStore High-Level Design (HLD)

> **Status**: STABLE
> **Package**: `packages/eventstore` (`@abl/eventstore`)
> **Last Updated**: 2026-03-22
> **Feature Spec**: `docs/features/eventstore.md`
> **Test Spec**: `docs/testing/eventstore.md`

---

## 1. System Context

EventStore is the unified event sourcing and data pipeline infrastructure for the ABL platform. It sits between the runtime execution engine and the analytics/compliance layer, capturing every meaningful operation as a structured PlatformEvent.

### System Context Diagram

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Studio UI   │     │  Admin API   │     │  External    │
│  Dashboards  │     │  (Retention) │     │  Webhooks    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
       │ HTTP Query         │ Retention/GDPR      │ Webhook Delivery
       │                    │                     │
┌──────▼────────────────────▼─────────────────────▼───────┐
│                                                          │
│                    @abl/eventstore                        │
│                                                          │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Emitter │  │  Query   │  │Retention │  │ Webhook  │ │
│  │         │  │ Service  │  │ + GDPR   │  │Forwarder │ │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │            │             │              │        │
│  ┌────▼────┐  ┌────▼─────┐  ┌───▼──────┐      │        │
│  │ Queue   │  │ Cache    │  │Lifecycle │      │        │
│  │ Layer   │  │ Layer    │  │ Layer    │      │        │
│  └────┬────┘  └────┬─────┘  └───┬──────┘      │        │
│       │            │             │              │        │
│  ┌────▼────────────▼─────────────▼──────────────▼──────┐ │
│  │              IEventStore (pluggable)                 │ │
│  │  ┌──────────────┐  ┌──────────┐  ┌───────────────┐ │ │
│  │  │  ClickHouse  │  │  Memory  │  │ Remote HTTP   │ │ │
│  │  │  (production)│  │  (tests) │  │ (service mode)│ │ │
│  │  └──────────────┘  └──────────┘  └───────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
└──────────────────────────────────────────────────────────┘
       ▲
       │ emit()
       │
┌──────┴───────┐
│   Runtime    │
│  (Trace      │
│   Emitter)   │
└──────────────┘
```

### Consumers

| Consumer              | Interaction                                             | Description                   |
| --------------------- | ------------------------------------------------------- | ----------------------------- |
| Runtime TraceEmitter  | `emitter.emit()` (fire-and-forget)                      | Dual-writes every trace event |
| Analytics API Routes  | `queryService.query/aggregate/count()`                  | Studio UI dashboards          |
| Retention Scheduler   | `retention.runRetention()`                              | Daily cron, plan-based TTLs   |
| GDPR Cascade          | `gdpr.deleteBySessionIds/anonymizeActor/deleteTenant()` | Session/tenant deletion       |
| Evaluation Dispatcher | `reader.query()` + `emitter.emit()`                     | Async evaluation pipeline     |
| Alert Scheduler       | `IMetricsReader.queryMetric()`                          | Threshold monitoring          |
| Webhook Forwarder     | `forwarder.maybeForward()`                              | External event delivery       |

## 2. Component Architecture

### 2.1 Event Emitter Layer

**Components**: `EventEmitter`, `ResilientEventEmitter`

**Responsibilities**:

- Accept raw event objects from callers
- Validate event data via Zod (EventRegistry)
- Enrich with auto-generated fields (event_id, category, timestamp)
- Enqueue to IEventQueue (non-blocking, fire-and-forget)

**Design decisions**:

- Validation is non-blocking by default (log warning, pass through). Strict mode throws.
- Unknown event types pass through without data validation (extensibility).
- ResilientEventEmitter adds 3-level failover for zero data loss.

### 2.2 Queue Layer

**Components**: `DirectQueue`, `BullMQEventQueue`, `KafkaEventQueue`, `MemoryEventQueue`

**Responsibilities**:

- Buffer events between emitter and store
- Provide durability guarantees (Redis/Kafka backing)
- Health check support for resilient emitter

**Design decisions**:

- `IEventQueue` is the minimal contract: `enqueue`, `onProcess`, `flush`, `close`, `isHealthy`
- DirectQueue is pass-through (zero latency, zero durability) for development
- Queue selection via factory pattern based on config

### 2.3 Store Layer

**Components**: `ClickHouseEventStore`, `MemoryEventStore`, `RemoteEventQueryClient`, `RemoteEventLifecycleClient`

**Responsibilities**:

- Persist events to durable storage
- Support query, aggregate, count operations
- Support lifecycle operations (purge, scrub, delete)

**Design decisions**:

- `IEventStore = IEventWriter + IEventReader + IEventLifecycle` (combined interface)
- ClickHouse writes use `BufferedClickHouseWriter` from `@agent-platform/database` for batching
- All queries are parameterized (no string interpolation) for SQL injection safety
- Remote mode splits reader/lifecycle into separate HTTP clients

### 2.4 Query Service Layer

**Component**: `EventQueryService`

**Responsibilities**:

- Wrap IEventReader with caching
- Provide convenience methods for dashboard queries
- Generate tenant-isolated cache keys

**Design decisions**:

- Cache key includes tenantId: `eventstore:{tenantId}:{operation}:{hash}`
- 60-second TTL default (configurable)
- SHA-256 hash of full params for key generation

### 2.5 Retention & GDPR Layer

**Components**: `EventRetentionService`, `EventGDPRService`

**Responsibilities**:

- Plan-based data retention (purge + PII scrub)
- GDPR compliance (cascade delete, actor anonymization, tenant offboarding)

**Design decisions**:

- Retention uses EventRegistry.getPIIEventTypes() to identify PII-bearing events
- ClickHouse uses ALTER TABLE DELETE/UPDATE (async, lightweight deletes)
- GDPR cascade hooks registered at runtime startup via `registerEventCascadeHook`

### 2.6 Schema Layer

**Components**: `EventRegistry`, `PlatformEvent`, event schema files

**Responsibilities**:

- Central registry of all event types with Zod schemas
- Category inference from event type prefix
- PII marking for GDPR scrubbing

**Design decisions**:

- Side-effect imports register schemas at module load time
- `.passthrough()` on schemas for forward compatibility
- ULID for event IDs (time-sortable, globally unique)

### 2.7 Evaluation Pipeline

**Components**: `EvaluationDispatcher`, `CodeScorer`, `LLMJudgeEvaluator`

**Responsibilities**:

- Subscribe to session.ended events
- Fan out to registered evaluators
- Emit evaluation result events

**Design decisions**:

- Dispatcher is backend-agnostic (injected config/conversation providers)
- Sampling at global and per-evaluator level
- Concurrency-limited fan-out via Promise.allSettled in chunks

### 2.8 Alerting Engine

**Components**: `AlertScheduler`, `ThresholdEvaluator`, `AlertNotifier`

**Responsibilities**:

- Periodic rule evaluation against aggregated metrics
- State machine: ok -> firing -> resolved
- Webhook notification with cooldown

**Design decisions**:

- Pure functions for threshold logic (fully testable)
- Cooldown via injected ICooldownStore (Redis-backed in production)
- Alert events emitted to EventStore for audit trail

### 2.9 Resilience Layer

**Components**: `FileSystemWAL`, `EventRecoveryService`

**Responsibilities**:

- Last-resort persistence when all infrastructure is down
- Startup + periodic WAL replay

**Design decisions**:

- JSONL format for simplicity and partial-read safety
- In-memory write buffer with periodic flush (100ms default)
- Hard cap: drop oldest events at 2x buffer size to prevent OOM
- File rotation at 100MB, retention at 24 hours

## 3. Data Model

### 3.1 ClickHouse Table Schema

```sql
CREATE TABLE abl_platform.platform_events (
    tenant_id         String,
    project_id        String,
    event_id          String,
    event_type        LowCardinality(String),
    category          LowCardinality(String),
    timestamp         DateTime64(3),
    session_id        String         DEFAULT '',
    trace_id          String         DEFAULT '',
    span_id           String         DEFAULT '',
    parent_span_id    String         DEFAULT '',
    agent_name        String         DEFAULT '',
    deployment_id     String         DEFAULT '',
    channel           String         DEFAULT '',
    actor_id          String         DEFAULT '',
    actor_type        LowCardinality(String) DEFAULT '',
    duration_ms       UInt32         DEFAULT 0,
    has_error         UInt8          DEFAULT 0,
    error_message     String         DEFAULT '',
    error_type        String         DEFAULT '',
    data              String,            -- JSON payload
    metadata          String         DEFAULT '{}',
    custom_dimensions Map(String, String) DEFAULT map(),
    _enc              String         DEFAULT ''
)
ENGINE = ReplicatedMergeTree
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, category, event_type, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
```

### 3.2 Index Strategy

| Index           | Type         | Column                                       | Granularity | Purpose                             |
| --------------- | ------------ | -------------------------------------------- | ----------- | ----------------------------------- |
| Primary         | ORDER BY     | (tenant_id, category, event_type, timestamp) | 8192        | Tenant-scoped category/type queries |
| idx_session     | bloom_filter | session_id                                   | 4           | Session trace lookups               |
| idx_trace       | bloom_filter | trace_id                                     | 4           | Distributed trace queries           |
| idx_span        | bloom_filter | span_id                                      | 4           | Span-level queries                  |
| idx_project     | bloom_filter | project_id                                   | 4           | Project-scoped queries              |
| idx_error       | set(2)       | has_error                                    | 4           | Error filtering                     |
| idx_custom_dims | ngrambf_v1   | mapKeys(custom_dimensions)                   | 4           | Custom dimension queries            |

### 3.3 Materialized Views

Three pre-designed MVs, deployed on-demand when queries prove slow (>2s):

1. **session_metrics_daily_mv**: AggregatingMergeTree, session KPIs per day
2. **llm_cost_hourly_mv**: AggregatingMergeTree, LLM cost per hour/model/provider
3. **platform_events_by_session_mv**: ReplacingMergeTree, session trace lookups (re-ordered by session_id)

## 4. Data Flow

### 4.1 Write Path (Embedded Mode)

```
Runtime TraceEmitter
    │
    ▼
EventEmitter.emit(event)
    │
    ├── 1. Zod Validation (EventRegistry)
    ├── 2. Enrichment (event_id, category, timestamp)
    │
    ▼
IEventQueue.enqueue(enrichedEvent)
    │
    ├── DirectQueue: synchronous pass-through
    ├── BullMQQueue: Redis-backed with retry
    ├── KafkaQueue: Kafka log with partitioning
    │
    ▼
IEventStore.write(event) [via onProcess handler]
    │
    ▼
BufferedClickHouseWriter
    │
    ├── Buffer events (up to 10K)
    ├── Flush every 5s or at batch size
    │
    ▼
ClickHouse INSERT INTO abl_platform.platform_events
```

### 4.2 Write Path (Resilient Mode)

```
ResilientEventEmitter.emit(event)
    │
    ├── L1: Primary Queue (if healthy)
    │       │
    │       ▼ (success) → done
    │
    ├── L2: Fallback Queue → Direct Store Write
    │       │
    │       ▼ (success) → done
    │
    ├── L3: FileSystem WAL
    │       │
    │       ▼ append(event) → JSONL file
    │
    └── (all failed) → log error, event lost (extremely rare)
```

### 4.3 Read Path

```
Analytics API Handler
    │
    ▼
EventQueryService.query/aggregate/count()
    │
    ├── 1. Check ICacheProvider (60s TTL)
    │       ├── Hit → return cached result
    │       └── Miss → continue
    │
    ▼
IEventReader.query/aggregate/count()
    │
    ├── ClickHouseEventStore: parameterized SQL query
    ├── RemoteEventQueryClient: HTTP GET to event service
    │
    ▼
Parse rows → PlatformEvent[] via ClickHouseRowMapper
    │
    ▼
Cache result → return to caller
```

## 5. Twelve Architectural Concerns

### 5.1 Tenant Isolation

- **ClickHouse**: Every query includes `tenant_id = {tenantId:String}` in WHERE clause
- **Cache**: Keys include tenantId: `eventstore:{tenantId}:{operation}:{hash}`
- **API**: Routes use `requireProjectPermission`, tenantId from auth context
- **SQL endpoint**: Enforces `tenant_id` filter presence in query text
- **GAP**: EvaluationDispatcher `pollAndProcess()` uses `tenantId: '*'` (see Section 5.12)

### 5.2 Authentication & Authorization

- Analytics API routes use `authMiddleware` + `requireProjectScope` + `requireProjectPermission`
- SQL query endpoint additionally enforces table allowlist and keyword blocklist
- EventStore package itself is auth-agnostic (trusts caller to provide correct tenantId)
- Rate limiting via `tenantRateLimit('request')`

### 5.3 Performance

- **Write**: BufferedClickHouseWriter batches 10K events, flushes every 5s
- **Read**: 60-second cache TTL on query results
- **Storage**: ZSTD compression, DoubleDelta for timestamps, T64 for integers
- **Indexes**: bloom_filter skip indexes for common access patterns
- **MVs**: Pre-aggregated materialized views for dashboard queries
- **Aggregation limit**: 1000 rows max on aggregate queries

### 5.4 Scalability

- **Horizontal**: ReplicatedMergeTree supports multi-shard ClickHouse cluster
- **Write scaling**: Kafka queue with configurable partitions (default 6)
- **Read scaling**: Cache layer reduces ClickHouse load, MVs reduce query cost
- **Service extraction**: Remote mode enables independent scaling of event service
- **Partition pruning**: PARTITION BY toDate(timestamp) enables efficient range queries

### 5.5 Availability

- **3-level failover**: Primary queue -> direct write -> filesystem WAL
- **WAL recovery**: Startup replay + periodic recovery (5 minutes)
- **Health checks**: Primary queue health probed every 5 seconds
- **Non-blocking**: All writes are fire-and-forget, never block runtime execution
- **Graceful shutdown**: Flush buffers, drain queues, close WAL on SIGTERM

### 5.6 Observability

- **GAP**: Package uses `console.log` instead of `createLogger` (58 occurrences)
- **Emitter metrics**: `pendingCount` exposed for buffer monitoring
- **Dispatcher stats**: evaluationsStarted/completed/failed/skipped
- **Scheduler stats**: evaluationsRun/alertsFired/resolved/skippedCooldown
- **OTEL integration**: Not yet wired (INTEGRATION.md suggests meter.createObservableGauge)

### 5.7 Data Consistency

- **Event IDs**: ULID ensures globally unique, time-sortable identifiers
- **Validation**: Zod schemas validate data at emit time (not write time)
- **Passthrough**: `.passthrough()` allows unknown fields (extensibility vs. strictness tradeoff)
- **Timestamp**: Auto-generated if not provided, ensures monotonic ordering within a session
- **Dedup**: platform_events_by_session uses ReplacingMergeTree for natural deduplication

### 5.8 Security

- **SQL injection**: All ClickHouse queries use parameterized queries
- **SQL endpoint**: Keyword blocklist + table allowlist + SELECT-only enforcement
- **WAL security**: Directory created with `mode: 0o700`
- **PII**: Scrubbed before EventStore write via `redactPII()` and `scrubSecrets()`
- **Webhook**: HMAC-SHA256 signing, SSRF protection via existing infrastructure
- **CRITICAL GAP**: `tenantId: '*'` in EvaluationDispatcher.pollAndProcess()

### 5.9 Compliance (GDPR/Retention)

- **Right to erasure**: `gdpr.deleteBySessionIds()`, `gdpr.anonymizeActor()`, `gdpr.deleteTenant()`
- **Plan-based retention**: FREE(30d), TEAM(90d), BUSINESS(365d), ENTERPRISE(2555d)
- **PII scrubbing**: Separate PII retention window, scrubs to `{"anonymized":true}`
- **Cascade integration**: Registered via `registerEventCascadeHook` at runtime startup
- **Audit trail**: Alert and evaluation events provide compliance audit records

### 5.10 Extensibility

- **New event types**: Register Zod schema in `src/schema/events/`, no code changes needed
- **New storage backends**: Implement `IEventStore` interface
- **New queue backends**: Implement `IEventQueue` interface
- **New evaluators**: Implement `IEvaluator` interface
- **New notification channels**: Implement delivery in `AlertNotifier`
- **Custom dimensions**: `Map(String, String)` column in ClickHouse, attached via metadata

### 5.11 Migration

- **LLM metrics bridge**: `mapLLMMetricsToPlatformEvent()` converts legacy rows
- **Dual-write**: TraceEmitter writes to both TraceStore and EventStore simultaneously
- **Schema evolution**: `.passthrough()` ensures old consumers tolerate new fields
- **DDL migration**: ClickHouse ALTER TABLE ADD COLUMN is non-blocking

### 5.12 Known Issues & Risks

| ID     | Severity | Description                                                           | Location                       |
| ------ | -------- | --------------------------------------------------------------------- | ------------------------------ |
| RISK-1 | HIGH     | Cross-tenant wildcard `tenantId: '*'` in EvaluationDispatcher polling | `evaluation-dispatcher.ts:193` |
| RISK-2 | MEDIUM   | 58 `console.log` occurrences instead of `createLogger`                | 9 files across package         |
| RISK-3 | LOW      | `.passthrough()` on Zod schemas allows unbounded payloads             | All event schema files         |
| RISK-4 | LOW      | `EvaluationDispatcher.evaluators` Map has no size limit               | `evaluation-dispatcher.ts:53`  |
| RISK-5 | INFO     | OTEL metrics not yet wired for buffer/queue monitoring                | All emitters/queues            |

## 6. API Design

### 6.1 TypeScript API (Package Interface)

```typescript
// Factory entry point
function createEventStore(config: EventStoreConfig): EventStoreServices;

// Returned services
interface EventStoreServices {
  store?: IEventStore; // Only in embedded/service modes
  emitter: IEventEmitter; // Write events
  queryService: IEventQueryService; // Read events
  retention: IEventRetention; // Plan-based retention
  gdpr: IEventGDPR; // GDPR compliance
  recovery?: EventRecoveryService; // WAL recovery (when resilience enabled)
  webhookForwarder?: EventWebhookForwarder; // When webhook configured
}
```

### 6.2 HTTP API (Analytics Routes)

All routes under `/api/projects/:projectId/analytics`:

| Method | Path                 | Auth         | Description                           |
| ------ | -------------------- | ------------ | ------------------------------------- |
| GET    | `/metrics`           | session:read | Aggregated metrics with GROUP BY      |
| GET    | `/events`            | session:read | Raw event listing with filters        |
| GET    | `/agents/:agentName` | session:read | Per-agent performance rollup          |
| GET    | `/cost-breakdown`    | session:read | LLM cost by model/provider            |
| GET    | `/session-metrics`   | session:read | Session completion rate, avg duration |
| GET    | `/event-counts`      | session:read | Event counts by category              |
| POST   | `/query`             | session:read | Ad-hoc event query with full filters  |
| POST   | `/aggregate`         | session:read | Ad-hoc aggregation with GROUP BY      |
| POST   | `/sql-query`         | session:read | Raw ClickHouse SQL (SELECT only)      |

## 7. Alternatives Considered

### 7.1 MongoDB vs ClickHouse for Event Storage

**Chosen**: ClickHouse

**Rationale**: Events are append-only, time-series data with high write volume and analytical query patterns. ClickHouse is purpose-built for this: columnar storage, vectorized execution, and automatic compression. MongoDB's document model adds write amplification and lacks native time-series aggregation.

### 7.2 Single Queue vs Pluggable Queues

**Chosen**: Pluggable queue interface with 4 implementations

**Rationale**: Different deployments have different durability/throughput needs. Development uses DirectQueue (zero overhead), production uses BullMQ or Kafka depending on scale. The IEventQueue interface is 6 methods -- minimal abstraction cost.

### 7.3 Monolithic vs Microservice Event Store

**Chosen**: Three modes (embedded, remote, service) with config-based switching

**Rationale**: Start embedded for simplicity, extract to service when scaling demands. The IEventStore interface makes this transparent to callers. Remote mode adds ~5ms latency for HTTP queries but enables independent scaling.

### 7.4 Custom WAL vs Existing Solutions (RocksDB, SQLite)

**Chosen**: Custom JSONL-based WAL

**Rationale**: The WAL is a last-resort fallback, not a primary write path. JSONL is simple, human-readable, partial-read-safe, and requires no additional dependencies. RocksDB/SQLite would add complexity for a path that should rarely activate.
