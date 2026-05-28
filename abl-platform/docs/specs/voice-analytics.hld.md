# Voice Analytics — High-Level Design

> **Feature #34** | Status: ALPHA | Created: 2026-03-22
> Feature Spec: `docs/features/voice-analytics.md`
> Test Spec: `docs/testing/voice-analytics.md`

## 1. Overview

Voice Analytics provides aggregated metrics, dashboards, and insights for voice interactions on the ABL platform. The system collects per-turn and per-session voice quality data during calls, stores it in ClickHouse via the EventStore, pre-aggregates it with materialized views, and exposes it through REST APIs consumed by the Studio dashboard.

## 2. Architecture

### 2.1 System Context

```
+-------------------+     SIP/RTP     +-------------------+     HEP      +----------+
|  Caller (Phone)   |<--------------->|  KoreVG/Jambonz   |------------>| Homer DB |
+-------------------+                 +-------------------+              +----------+
                                             | WebSocket                       |
                                             v                                 |
                                    +-------------------+                      |
                                    | Runtime (Express) |<---------------------+
                                    |  KorevgSession    |  Homer API queries
                                    |  VoicePipeline    |
                                    +--------+----------+
                                             |
                            +----------------+----------------+
                            |                |                |
                            v                v                v
                    +------------+    +----------+    +-------------+
                    | EventStore |    | TraceStore|    | MongoDB     |
                    | (emitter)  |    | (Redis)   |    | (sessions)  |
                    +------+-----+    +----------+    +-------------+
                           |
                           v
                    +---------------------+
                    | ClickHouse          |
                    | platform_events     |
                    | (buffered writer)   |
                    +---------+-----------+
                              |
                              v
                    +---------------------+     +---------------------+
                    | Materialized View   |     | Analytics Tables    |
                    | voice_hourly_dest   |     | (sentiment, intent, |
                    |                     |     |  quality evals)     |
                    +----------+----------+     +---------------------+
                               |
                               v
                    +---------------------+
                    | Voice Analytics API  |
                    | /summary, /hourly   |
                    +----------+----------+
                               |
                               v
                    +---------------------+
                    | Studio Dashboard    |
                    | VoiceAnalyticsPage  |
                    +---------------------+
```

### 2.2 Component Architecture

| Component              | Package                                       | Responsibility                                                    |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| KorevgSession          | `apps/runtime/src/services/voice/korevg/`     | Per-call session handler, metric collection, trace event emission |
| VoicePipeline          | `apps/runtime/src/services/voice/`            | STT/LLM/TTS orchestration for pipeline mode                       |
| VoiceQualityAnalyzer   | `apps/runtime/src/observability/`             | Multi-signal ASR quality scoring (metric 201)                     |
| ASRCascadeDetector     | `apps/runtime/src/observability/`             | Cascade failure detection (metric 210)                            |
| HomerClient            | `apps/runtime/src/services/voice/korevg/`     | RTCP QoS data retrieval, network MOS computation                  |
| Voice Events           | `packages/eventstore/src/schema/events/`      | 9 Zod-validated event schemas                                     |
| Voice Analytics Routes | `apps/runtime/src/routes/`                    | REST API for /summary and /hourly                                 |
| ClickHouse Init        | `packages/database/src/clickhouse-schemas/`   | DDL for tables, MVs                                               |
| VoiceAnalyticsPage     | `apps/studio/src/components/voice-analytics/` | Dashboard with 4 widget sections                                  |
| useVoiceAnalytics      | `apps/studio/src/hooks/`                      | SWR data fetching hook                                            |

### 2.3 Data Flow

1. **Collection Phase** (real-time, during call):
   - KorevgSession tracks per-turn timing, STT confidence, TTS metrics, barge-in events, silence accumulation
   - VoiceQualityAnalyzer analyzes ASR quality across all turns at session end
   - ASRCascadeDetector evaluates cascade risk per turn
   - HomerClient queries RTCP data from Homer at session end for network MOS (async, after WebSocket close, before final event emission; 5s timeout with graceful null fallback)

2. **Emission Phase** (per-event):
   - Each metric emits a typed trace event via `emitVoiceTraceEvent()`
   - Events flow through TraceStore (in-memory ring buffer for live view) and EventStore (ClickHouse writer)

3. **Storage Phase** (buffered):
   - EventStore BufferedWriter batches events (10K rows or 5s) for ClickHouse insertion
   - Events land in `platform_events` table partitioned by `(tenant_id, toYYYYMM(timestamp))`

4. **Aggregation Phase** (materialized view):
   - `platform_events_voice_hourly_dest` MV aggregates voice.session.ended events into hourly buckets
   - Pre-computes sums for all metric fields; weighted averages derived from sum/count at query time

5. **Query Phase** (on-demand):
   - Voice analytics API reads from MV with tenant+project isolation
   - Summary endpoint returns scalar KPIs; hourly endpoint returns time-series
   - Studio dashboard renders widgets from API responses

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

All ClickHouse queries include `tenant_id` in the WHERE clause. The `requireProjectScope('projectId')` middleware extracts and validates the project context. Cross-tenant access returns 404 (not 403). The MV is partitioned by `(tenant_id, toYYYYMM(hour))` for efficient partition pruning.

### 3.2 Authentication & Authorization

- `authMiddleware` validates JWT tokens on all voice analytics routes
- `requireProjectPermission(req, res, 'session:read')` enforces RBAC
- No custom token verification; uses centralized auth from `@agent-platform/shared`

### 3.3 Data Integrity

- Zod schemas validate all voice events at emission time (9 schemas in `voice-events.ts`)
- ClickHouse ReplicatedMergeTree ensures data durability across replicas
- Materialized views use SummingMergeTree for deterministic aggregation
- Weighted averages use sum/count pairs to avoid incorrect averaging of averages

### 3.4 Performance

- **Pre-aggregation**: Hourly MV avoids scanning raw events for dashboard queries
- **Partition pruning**: Queries filter by `tenant_id` + time range for efficient reads
- **Query limits**: 500-row limit on hourly responses; 15s execution timeout
- **Buffered writes**: 10K events per batch minimizes ClickHouse insert pressure
- **Compression**: ZSTD codec on all ClickHouse columns (ZSTD(1) for most, ZSTD(3) for content)

**Rate Limiting**: Voice analytics endpoints are covered by the existing per-tenant rate limiter in the Runtime middleware chain. No additional rate limiting is needed since these are read-only aggregate queries (not per-event writes). The 15s query timeout provides a natural backpressure mechanism.

### 3.5 Scalability

- ClickHouse scales horizontally via sharding (ReplicatedMergeTree with Keeper)
- MV aggregation is incremental; no backfill required for new data
- EventStore BufferedWriter handles burst traffic by queuing
- API stateless; multiple Runtime pods serve analytics queries via round-robin

### 3.6 Observability

- OTEL spans: `voice_turn` > `stt` > `llm` > `tts` per voice interaction
- 15+ OTEL metrics: turn duration, STT/LLM/TTS latency, confidence, barge-in count
- Structured logging via `createLogger('voice-analytics-route')` with tenant/project context
- Query failures return 503 with logged stack traces
- TraceStore provides real-time event streaming via WebSocket for Studio live view

### 3.7 Error Handling

- ClickHouse unavailability: API returns 503 with user-friendly message, logs warning
- Homer unavailability: Metrics degrade to null (no network MOS); does not block call teardown
- Invalid event data: Zod validation rejects; error logged with event context
- Query timeout: 15s limit prevents long-running queries from blocking ClickHouse
- Empty data: Graceful zero-state response (not error)

### 3.8 Compliance & Privacy

- PII fields (caller numbers, transcripts in cascade events) marked with `containsPII: true`
- Aggregate analytics queries exclude PII fields (only aggregate sums/counts)
- 730-day TTL on all analytics tables for GDPR compliance
- Right-to-erasure supported via tenant-level data deletion from ClickHouse
- All trace event data payloads compressed then encrypted at rest

### 3.9 Backward Compatibility

- Voice events use versioned schemas (`version: '1.0.0'` in EventStore registry)
- New optional fields added with `z.optional()` to avoid breaking existing events
- API responses include all fields even when null (consistent contract)
- ClickHouse ALTER TABLE with `ADD COLUMN IF NOT EXISTS` for schema evolution

### 3.10 Failure Modes & Recovery

| Failure                  | Impact                                                   | Recovery                                            |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| ClickHouse down          | Analytics API returns 503; metrics collection unaffected | BufferedWriter retries; MV catches up automatically |
| Homer unreachable        | No network MOS; proxy MOS still available                | Graceful null fallback; logged as warning           |
| EventStore write failure | Events lost for that batch                               | BufferedWriter logs error; next batch retries       |
| Corrupt event data       | Single event rejected by Zod validation                  | Other events unaffected; error logged               |
| Runtime pod restart      | In-flight call metrics may be incomplete                 | Session-end event still emitted with available data |

### 3.11 Testing Strategy

- E2E: Real Express server + ClickHouse with seeded events, testing isolation and aggregation
- Integration: Event emission through EventStore, MV population verification
- Unit: VoiceQualityAnalyzer scoring, ASRCascadeDetector risk calculation, Homer MOS computation
- UI: Component rendering with mock data for all widget sections
- See full test spec: `docs/testing/voice-analytics.md`

### 3.12 Deployment & Operations

- No new infrastructure: leverages existing ClickHouse, EventStore, Runtime
- Schema evolution via `initClickHouseSchema()` at Runtime startup (idempotent DDL)
- MV creation idempotent (`IF NOT EXISTS`)
- Feature flag: not needed (dashboard behind navigation guard, route registered only if voice enabled)
- Monitoring: existing Coroot + OTEL pipeline captures voice analytics metrics

## 4. Alternatives Analysis

### Alternative A: Real-time Stream Processing (Kafka/Flink)

**Description**: Use Kafka for event streaming and Apache Flink for real-time aggregation instead of ClickHouse materialized views.

| Aspect         | Pros                                   | Cons                                                           |
| -------------- | -------------------------------------- | -------------------------------------------------------------- |
| Latency        | Sub-second aggregation                 | Significant infrastructure overhead                            |
| Scalability    | Excellent horizontal scale             | Kafka + Flink cluster management                               |
| Complexity     | Industry standard for stream analytics | 3 new infrastructure components (Kafka, Flink, state store)    |
| Cost           | Good for very high throughput          | Overkill for current call volumes (hundreds/day, not millions) |
| Existing infra | None                                   | Requires new infrastructure setup                              |

**Decision**: Rejected. Current call volumes (hundreds to low thousands per day) don't justify the infrastructure complexity. ClickHouse MVs provide sufficient aggregation performance with zero additional infrastructure.

### Alternative B: MongoDB Aggregation Pipeline

**Description**: Store voice events in MongoDB and use aggregation pipelines for analytics queries.

| Aspect         | Pros                     | Cons                                                     |
| -------------- | ------------------------ | -------------------------------------------------------- |
| Infrastructure | Already have MongoDB     | MongoDB aggregation is slow for large time-range queries |
| Schema         | Flexible document model  | No columnar compression; storage grows linearly          |
| Performance    | OK for small datasets    | Degrades significantly at scale; no partition pruning    |
| Joins          | Easy with $lookup        | Not needed for voice analytics (single table)            |
| Real-time      | Change streams available | Poor for analytical workloads vs OLAP databases          |

**Decision**: Rejected. MongoDB is optimized for OLTP workloads, not analytical queries over large time ranges. ClickHouse provides 10-100x better query performance for time-series aggregation with columnar compression.

### Alternative C: ClickHouse with Materialized Views (Selected)

**Description**: Store raw events in ClickHouse `platform_events`, use materialized views for pre-aggregation, query from MVs for dashboard rendering.

| Aspect         | Pros                                      | Cons                                             |
| -------------- | ----------------------------------------- | ------------------------------------------------ |
| Infrastructure | Already deployed for platform events      | Single point of failure if ClickHouse goes down  |
| Performance    | Sub-second queries on pre-aggregated data | Materialized views add storage overhead (~5-10%) |
| Scalability    | Horizontal via ReplicatedMergeTree        | Requires Keeper for coordination                 |
| Complexity     | Minimal; DDL-only, no new services        | ClickHouse DDL is less familiar to most devs     |
| Cost           | Low; reuses existing cluster              | None significant                                 |

**Decision**: Selected. Leverages existing infrastructure, provides excellent query performance, and requires zero new services. The 5-10% storage overhead from MVs is negligible compared to the query performance improvement.

## 5. Data Model Details

### 5.1 EventStore Voice Event Flow

```
voice.session.started  ──┐
voice.stt.completed    ──┤
voice.tts.completed    ──┤
voice.turn.completed   ──┤──► platform_events (ClickHouse)
voice.barge_in.detected──┤
voice.asr_quality      ──┤
voice.tts_quality      ──┤
voice.asr_cascade      ──┤
voice.session.ended    ──┘──► platform_events_voice_hourly_dest (MV)
```

The materialized view triggers only on `voice.session.ended` events, which contain the session-level aggregated metrics. This avoids double-counting from per-turn events.

### 5.2 Hourly MV Schema

Key columns in the destination table:

- `hour` (DateTime) — truncated to hour
- `tenant_id`, `project_id` — isolation keys
- `session_count` — count of sessions in this hour
- `error_count` — sessions ending with reason='error'
- `sum_call_duration_ms`, `sum_inbound_mos`, `sum_outbound_mos` — sums for weighted averaging
- `mos_sample_count`, `metric_sample_count` — denominators for weighted averages
- `total_turns`, `total_barge_in_count`, `total_dtmf_turn_count` — absolute counts

### 5.3 Weighted Average Computation

Dashboard KPIs are computed as `SUM(metric) / SUM(sample_count)`, not `AVG(metric)`. This correctly handles:

- Hours with different session counts contributing proportionally
- Sessions with missing data (e.g., no Homer data) not dragging down averages
- Sparse data where some hours have 1 session and others have 100

## 6. Security Boundary

```
Browser (Studio)
    │
    │ HTTPS + JWT
    │
    ▼
Runtime API ── authMiddleware ── requireProjectScope ── requireProjectPermission
    │
    │ tenant_id + project_id filters
    │
    ▼
ClickHouse (internal network only, no external access)
```

- ClickHouse is accessible only from the internal network (not exposed externally)
- All queries use parameterized inputs (`{tenantId:String}`) to prevent SQL injection
- No raw user input interpolated into ClickHouse queries

## 7. Risks & Mitigations

| Risk                                               | Likelihood | Impact   | Mitigation                                                          |
| -------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------- |
| ClickHouse MV falls behind during high call volume | Low        | Medium   | BufferedWriter batching smooths writes; MV is incremental           |
| Homer API changes break network MOS collection     | Medium     | Low      | Graceful fallback to proxy-only MOS; HomerClient has error handling |
| New voice events break MV schema                   | Medium     | Medium   | MV only reads session.ended; new event types don't affect it        |
| Cross-tenant data leak via query bug               | Low        | Critical | Parameterized queries; E2E isolation tests; middleware enforcement  |
| Dashboard slow for tenants with millions of calls  | Low        | Medium   | MV pre-aggregation; partition pruning; 15s query timeout            |

## 8. Future Architecture Considerations

- **Real-time dashboard**: WebSocket subscription to TraceStore for live call quality updates (no architecture change needed; TraceStore already supports subscriptions)
- **Alert system**: Integration with `packages/eventstore/src/alerting/alert-scheduler.ts` for threshold-based alerts on voice quality metrics
- **Language segmentation**: Requires adding `language` column to the hourly MV and a new API endpoint (`/by-language`)
- **Per-agent comparison**: Requires adding `agent_name` to MV GROUP BY and a new API endpoint (`/by-agent`)
