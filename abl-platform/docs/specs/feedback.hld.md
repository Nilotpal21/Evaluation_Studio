# HLD: Feedback System

**Feature Spec**: `docs/features/feedback.md`
**Test Spec**: `docs/testing/feedback.md`
**Status**: APPROVED
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

Operators deploying agents on the ABL platform have no unified way to collect, store, and analyze end-user feedback across channels. The only feedback mechanism today is email CSAT (1-5 star ratings via signed JWT links in `apps/runtime/src/routes/feedback.ts`), covering a single channel and a single rating type. In-chat interactions (WebSocket, SDK, web widget) have no feedback mechanism. Without structured feedback data in an analytics-optimized store, operators cannot measure agent quality, identify underperforming agents, or track CSAT trends. The existing `feedback.submitted` eventstore event schema (`packages/eventstore/src/schema/events/feedback-events.ts`) already supports `thumbs`, `star`, and `text` rating types, but only `star` is used.

---

## 2. Alternatives Considered

### Option A: Extend Existing TraceStore (Event-Only)

- **Description**: Keep feedback as trace events only. Add query endpoints that filter `platform_events` by `category='feedback'`. No dedicated ClickHouse table.
- **Pros**: Zero schema changes. Reuses existing eventstore query service. Fastest to implement.
- **Cons**: `platform_events` table is ordered by `(tenant_id, project_id, timestamp)` -- not optimized for feedback-specific aggregations (per-agent breakdown, thumbs up ratio). No materialized view for daily rollups. Mixed with millions of other events, queries will be slow for 90-day ranges.
- **Effort**: S

### Option B: Dedicated ClickHouse Table + Service Layer (Recommended)

- **Description**: Create a dedicated `feedback` table in ClickHouse with feedback-specific columns and a `feedback_daily_dest` materialized view for pre-aggregated analytics. Add a FeedbackService in the runtime that handles write (ClickHouse INSERT + trace event) and query (stats, recent). Expose via authenticated REST routes and WebSocket handler.
- **Pros**: Optimized ORDER BY for feedback queries. Pre-aggregated daily stats via materialized view. Clean separation from generic event stream. Follows the same pattern as `llm_metrics` + `llm_metrics_hourly_dest`.
- **Cons**: New DDL to manage. Additional query service. Slightly more code than Option A.
- **Effort**: M

### Option C: MongoDB Collection + ClickHouse Dual-Write

- **Description**: Store feedback in a MongoDB collection for CRUD operations and write to ClickHouse for analytics. Studio queries MongoDB for recent feedback and ClickHouse for aggregations.
- **Pros**: MongoDB enables update/delete operations (e.g., change rating). Familiar Mongoose patterns.
- **Cons**: Feedback is append-only by design (no updates per FR-4). Dual-write complexity. MongoDB not optimized for time-series aggregation. Contradicts the platform pattern where analytical data goes to ClickHouse only.
- **Effort**: L

### Recommendation: Option B -- Dedicated ClickHouse Table + Service Layer

**Rationale**: Feedback is append-only analytical data (same nature as LLM metrics, search queries, audit events). The platform already uses dedicated ClickHouse tables with materialized views for this pattern (`llm_metrics` + `llm_metrics_hourly_dest`, `search_queries`). Option A is too slow for 90-day aggregations across millions of events. Option C introduces unnecessary dual-write complexity for data that never needs MongoDB CRUD semantics. Option B is the architecturally consistent choice.

---

## 3. Architecture

### System Context Diagram

```
                                    ┌─────────────────────┐
                                    │    End Users         │
                                    │  (Chat / Email)      │
                                    └──────────┬──────────┘
                                               │
                        ┌──────────────────────┼──────────────────────┐
                        │                      │                      │
                        ▼                      ▼                      ▼
               ┌────────────────┐   ┌──────────────────┐   ┌────────────────┐
               │  WebSocket     │   │  REST API         │   │  Email CSAT    │
               │  feedback.     │   │  POST /feedback   │   │  GET /feedback │
               │  submit        │   │  GET /stats       │   │  /:token       │
               └───────┬────────┘   │  GET /recent      │   └───────┬────────┘
                       │            └─────────┬─────────┘           │
                       │                      │                     │
                       ▼                      ▼                     ▼
               ┌──────────────────────────────────────────────────────────┐
               │                     FeedbackService                      │
               │  - validateAndSubmit()   - getStats()   - getRecent()    │
               │  - deduplicate()         - resolveAgentName()            │
               └──────┬─────────────┬───────────────────┬────────────────┘
                      │             │                   │
                      ▼             ▼                   ▼
              ┌──────────────┐ ┌──────────┐    ┌──────────────────┐
              │  ClickHouse  │ │ Trace    │    │  Redis           │
              │  feedback    │ │ Store    │    │  (email dedup)   │
              │  table       │ │ addEvent │    │                  │
              └──────────────┘ └──────────┘    └──────────────────┘
                      │
                      ▼
              ┌──────────────────┐
              │  feedback_daily  │
              │  _dest (MV)      │
              └──────────────────┘
                      │
                      ▼
              ┌──────────────────┐
              │  Studio UI       │
              │  FeedbackTab     │
              └──────────────────┘
```

### Component Diagram

```
apps/runtime/
├── routes/
│   ├── feedback.ts              # Existing email CSAT (unchanged)
│   └── feedback-api.ts          # NEW: authenticated REST API
├── services/
│   └── feedback/
│       ├── feedback-service.ts  # NEW: write path (validate, dedup, insert, emit)
│       └── feedback-query.ts    # NEW: read path (stats, recent)
└── websocket/
    └── sdk-handler.ts           # MODIFIED: add feedback.submit handler

packages/database/
└── clickhouse-schemas/
    └── init.ts                  # MODIFIED: add feedback + feedback_daily_dest DDL

packages/eventstore/
└── schema/events/
    └── feedback-events.ts       # EXISTING: FeedbackSubmittedDataSchema (unchanged)

apps/studio/
├── app/api/projects/[id]/feedback/
│   ├── stats/route.ts           # NEW: proxy to runtime
│   └── recent/route.ts          # NEW: proxy to runtime
└── components/analytics/
    └── FeedbackTab.tsx           # NEW: analytics dashboard tab
```

### Data Flow

**Write Path (Authenticated API)**:

1. Client sends `POST /api/projects/:projectId/feedback` with Bearer token
2. `authMiddleware` validates token, extracts `tenantContext` (tenantId, userId)
3. `requireProjectScope('projectId')` verifies project membership
4. `tenantRateLimit('feedback')` checks rate limit (10/min per user)
5. Zod schema validates request body (`sessionId`, `messageId`, `ratingType`, `ratingValue`, `feedbackText?`)
6. `FeedbackService.validateAndSubmit()`:
   a. Verify `sessionId` belongs to `projectId` (session repo lookup)
   b. Check dedup: query ClickHouse for existing `(session_id, message_id, user_id)` -> 409 if exists
   c. Resolve `agent_name` from session trace data or message metadata
   d. INSERT into ClickHouse `feedback` table
   e. Emit `feedback.submitted` trace event via TraceStore
7. Return `{ success: true, data: { feedbackId } }`

**Write Path (WebSocket)**:

1. Client sends `{ type: "feedback.submit", payload: { messageId, ratingType, ratingValue, feedbackText? } }` over WebSocket
2. SDK handler extracts session context (tenantId, projectId, sessionId, userId) from established connection
3. Delegates to `FeedbackService.validateAndSubmit()` (same as step 6 above)
4. Sends ack message back over WebSocket

**Write Path (Email CSAT -- unchanged)**:

1. Customer clicks `/api/v1/feedback/:token?rating=N`
2. JWT verification extracts payload (tenantId, projectId, sessionId, messageId)
3. Redis dedup check
4. TraceStore event emission
5. **NEW (bridge)**: Also INSERT into ClickHouse `feedback` table with `source: 'email'`

**Read Path (Stats)**:

1. `GET /api/projects/:projectId/feedback/stats?from=&to=&agentName=`
2. Auth + project scope middleware
3. `FeedbackQueryService.getStats()` queries `feedback_daily_dest` with `WHERE tenant_id AND project_id AND day BETWEEN`
4. Returns aggregated metrics: `{ totalCount, thumbsUpCount, thumbsDownCount, thumbsUpRatio, averageStarRating, starCount, textFeedbackCount, byAgent: [...] }`

**Read Path (Recent)**:

1. `GET /api/projects/:projectId/feedback/recent?limit=50&offset=0`
2. Auth + project scope middleware
3. `FeedbackQueryService.getRecent()` queries `feedback` table with `WHERE tenant_id AND project_id ORDER BY timestamp DESC LIMIT offset, limit`
4. Returns paginated list: `{ items: [...], total, hasMore }`

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                             |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every ClickHouse query includes `tenant_id` in WHERE clause. API routes use `requireProjectScope` which validates tenant membership. Cross-tenant access returns 404 (not 403).                                                                                                                             |
| 2   | **Data Access Pattern** | ClickHouse client via `getClickHouseClient()` from `@agent-platform/database/clickhouse`. No repository layer -- direct parameterized queries (same as `llm_metrics` pattern). No caching for write path. Stats cached by ClickHouse materialized view.                                                     |
| 3   | **API Contract**        | Standard envelope: `{ success: true, data }` / `{ success: false, error: { code, message } }`. Zod validation on all inputs. `z.string().min(1)` for all ID fields. Paginated responses use `{ items, total, hasMore }`.                                                                                    |
| 4   | **Security Surface**    | Authenticated endpoint: `createUnifiedAuthMiddleware` + `requireProjectScope`. Email endpoint: signed JWT (existing). Input validation: Zod for body + query params. No SSRF risk (no user-controlled URLs). `feedbackText` marked `containsPII: true` in eventstore schema. Rate limited: 10/min per user. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                   |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Validation errors: 400 with `VALIDATION_ERROR` code. Auth errors: 401/404 (standard middleware). Duplicate: 409 with `DUPLICATE_FEEDBACK` code. ClickHouse unavailable: 503 with `SERVICE_UNAVAILABLE`. Rate limit: 429.                                                                          |
| 6   | **Failure Modes** | ClickHouse down: 503 (fail-closed for authenticated API). TraceStore down: log warning, continue (feedback persists to ClickHouse). Redis down (email only): fail-open, accept duplicates. No circuit breaker needed (ClickHouse is the only critical dependency and its client handles retries). |
| 7   | **Idempotency**   | Dedup via ClickHouse query before INSERT for authenticated API (exact match on session_id, message_id, user_id). Redis SET NX for email CSAT. ClickHouse `ReplacingMergeTree` as eventual-consistency backstop.                                                                                   |
| 8   | **Observability** | `feedback.submitted` trace events (existing schema). `createLogger('feedback-service')` / `createLogger('feedback-api')` for structured logging. Feedback metrics derived from `feedback_daily_dest` MV. Studio FeedbackTab as operator dashboard.                                                |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                              |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Write: < 50ms p99 (single ClickHouse INSERT + async trace event). Stats read: < 200ms p99 (pre-aggregated MV query). Recent read: < 100ms p99 (indexed query with LIMIT). Payload: feedback body < 10KB (text field max 5000 chars).                                                                         |
| 10  | **Migration Path**     | Additive only. New ClickHouse tables created by `initClickHouseSchema()`. No existing data migration. Email CSAT bridge is optional -- existing trace events continue working without it. Rollback: drop tables, remove routes.                                                                              |
| 11  | **Rollback Plan**      | Phase 1 (ClickHouse schema): `DROP TABLE feedback, feedback_daily_dest, feedback_daily_mv`. Phase 2 (routes): Remove route registration from `server.ts`. Phase 3 (Studio): Remove tab. Each phase is independently reversible.                                                                              |
| 12  | **Test Strategy**      | Unit: Zod validation, dedup key generation, event construction (9 scenarios). Integration: service -> ClickHouse, auth chain, dedup, trace events, WebSocket, stats, rate limit, session validation (8 scenarios). E2E: full HTTP API flow with auth context (11 scenarios). See `docs/testing/feedback.md`. |

---

## 5. Data Model

### New Tables

#### ClickHouse: `abl_platform.feedback`

```sql
CREATE TABLE IF NOT EXISTS abl_platform.feedback
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    feedback_id       String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    message_id        String               CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    user_id           String               DEFAULT '' CODEC(ZSTD(1)),
    channel           LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    rating_type       LowCardinality(String) CODEC(ZSTD(1)),
    rating_value      Float32              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    feedback_text     String               DEFAULT '' CODEC(ZSTD(3)),
    has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    encrypted         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),
    source            LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_session session_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_user    user_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_agent   agent_name TYPE set(100)     GRANULARITY 4,
    INDEX idx_pii     has_pii    TYPE set(2)       GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.feedback', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, project_id, timestamp, session_id)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
```

#### ClickHouse: `abl_platform.feedback_daily_dest`

```sql
CREATE TABLE IF NOT EXISTS abl_platform.feedback_daily_dest
(
    tenant_id          String,
    project_id         String,
    agent_name         LowCardinality(String),
    day                Date,
    total_count        SimpleAggregateFunction(sum, UInt64),
    thumbs_up_count    SimpleAggregateFunction(sum, UInt64),
    thumbs_down_count  SimpleAggregateFunction(sum, UInt64),
    star_sum           SimpleAggregateFunction(sum, Float64),
    star_count         SimpleAggregateFunction(sum, UInt64),
    text_count         SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, agent_name, day)
TTL day + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
```

#### ClickHouse: Materialized View

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.feedback_daily_mv
TO abl_platform.feedback_daily_dest AS
SELECT
    tenant_id,
    project_id,
    agent_name,
    toDate(timestamp) AS day,
    count() AS total_count,
    countIf(rating_type = 'thumbs' AND rating_value = 1) AS thumbs_up_count,
    countIf(rating_type = 'thumbs' AND rating_value = 0) AS thumbs_down_count,
    sumIf(rating_value, rating_type = 'star') AS star_sum,
    countIf(rating_type = 'star') AS star_count,
    countIf(rating_type = 'text') AS text_count
FROM abl_platform.feedback
GROUP BY tenant_id, project_id, agent_name, day
```

### Modified Tables

None. The existing `platform_events` table continues to receive `feedback.submitted` events via the eventstore. The new `feedback` table is a parallel dedicated store.

### Key Relationships

- `feedback.session_id` -> `sessions._id` (MongoDB, cross-store via application layer)
- `feedback.message_id` -> message IDs in session trace/message store
- `feedback.agent_name` -> agents defined in project ABL configuration
- `feedback_daily_mv` -> automatic aggregation from `feedback` to `feedback_daily_dest`

---

## 6. API Design

### New Endpoints

| Method | Path                                       | Purpose                  | Auth                  | FR   |
| ------ | ------------------------------------------ | ------------------------ | --------------------- | ---- |
| POST   | `/api/projects/:projectId/feedback`        | Submit feedback          | Bearer + projectScope | FR-1 |
| GET    | `/api/projects/:projectId/feedback/stats`  | Aggregate feedback stats | Bearer + projectScope | FR-9 |
| GET    | `/api/projects/:projectId/feedback/recent` | Paginated recent list    | Bearer + projectScope | FR-9 |

### Request/Response Schemas

**POST /feedback**

```typescript
// Request
{
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  ratingType: z.enum(['thumbs', 'star', 'text']),
  ratingValue: z.number(),          // validated per ratingType
  feedbackText: z.string().optional()
}

// Response 201
{ success: true, data: { feedbackId: string } }

// Response 409
{ success: false, error: { code: 'DUPLICATE_FEEDBACK', message: '...' } }

// Response 400
{ success: false, error: { code: 'VALIDATION_ERROR', message: '...' } }
```

**GET /feedback/stats**

```typescript
// Query params
from: z.string()   // ISO 8601
to: z.string()     // ISO 8601
agentName: z.string().optional()

// Response 200
{
  success: true,
  data: {
    totalCount: number,
    thumbsUpCount: number,
    thumbsDownCount: number,
    thumbsUpRatio: number,       // 0.0 - 1.0
    averageStarRating: number,   // 1.0 - 5.0
    starCount: number,
    textFeedbackCount: number,
    byAgent: Array<{
      agentName: string,
      totalCount: number,
      thumbsUpRatio: number,
      averageStarRating: number
    }>
  }
}
```

**GET /feedback/recent**

```typescript
// Query params
limit: z.number().min(1).max(100).default(50)
offset: z.number().min(0).default(0)

// Response 200
{
  success: true,
  data: {
    items: Array<{
      feedbackId: string,
      sessionId: string,
      messageId: string,
      agentName: string,
      ratingType: 'thumbs' | 'star' | 'text',
      ratingValue: number,
      feedbackText: string | null,
      timestamp: string,      // ISO 8601
      source: string           // 'api' | 'email' | 'websocket'
    }>,
    total: number,
    hasMore: boolean
  }
}
```

### Modified Endpoints

**Email CSAT (bridge addition)**: `GET /api/v1/feedback/:token` -- after recording the trace event (existing behavior), also INSERT into ClickHouse `feedback` table with `source: 'email'`, `user_id: ''` (email feedback has no authenticated user).

### Error Responses

| Code                  | HTTP | When                                                                  |
| --------------------- | ---- | --------------------------------------------------------------------- |
| `VALIDATION_ERROR`    | 400  | Invalid ratingType, out-of-range ratingValue, missing required fields |
| `SESSION_NOT_FOUND`   | 400  | sessionId does not belong to projectId                                |
| `DUPLICATE_FEEDBACK`  | 409  | Same (sessionId, messageId, userId) exists                            |
| `RATE_LIMIT_EXCEEDED` | 429  | More than 10 submissions per minute                                   |
| `SERVICE_UNAVAILABLE` | 503  | ClickHouse unavailable                                                |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Not required -- feedback is end-user action, not admin action. Feedback events in TraceStore provide sufficient audit trail.
- **Rate Limiting**: 10 submissions per minute per user on authenticated endpoint. Uses existing `tenantRateLimit('feedback')` middleware. Email endpoint: Redis-based dedup (30-day TTL) serves as implicit rate limit.
- **Caching**: No caching on write path. Read path uses ClickHouse `feedback_daily_dest` MV as a form of pre-computation (not TTL cache). No Redis caching for stats queries (ClickHouse is fast enough for pre-aggregated data).
- **Encryption**: `feedback_text` marked with `encrypted` and `key_version` columns for encryption-at-rest via the existing ClickHouse encryption interceptor. `has_pii` flag for PII scrubbing by retention scheduler.
- **i18n**: Studio FeedbackTab labels use `next-intl` with keys in `settings.feedback.*` namespace.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                             | Type           | Risk                                       |
| ------------------------------------------------------ | -------------- | ------------------------------------------ |
| ClickHouse (via `@agent-platform/database/clickhouse`) | Infrastructure | Low -- already deployed and stable         |
| EventStore singleton (`eventstore-singleton.ts`)       | Service        | Low -- existing, well-tested               |
| TraceStore (`trace-store.ts`)                          | Service        | Low -- existing, fail-open design          |
| Redis (`redis-client.ts`)                              | Infrastructure | Low -- only for email CSAT dedup           |
| Session store (MongoDB)                                | Data           | Low -- only for session-project validation |
| Auth middleware (`middleware/auth.ts`)                 | Middleware     | Low -- existing, standard chain            |
| `tenantRateLimit` (`middleware/rate-limiter.ts`)       | Middleware     | Low -- existing, parameterized             |

### Downstream (depends on this feature)

| Consumer                    | Impact                                                |
| --------------------------- | ----------------------------------------------------- |
| Studio FeedbackTab          | New UI component -- reads from proxy routes           |
| Pipeline Engine (future)    | Can consume `feedback.submitted` events for analytics |
| SDK/Widget clients (future) | Will use `feedback.submit` WebSocket message type     |

---

## 9. Open Questions & Decisions Needed

1. **Half-star ratings**: Should `star` ratingType accept `3.5` (Float) or only integers `1-5`? Current schema uses `Float32` which allows it, but validation may restrict to integers.
2. **Agent name resolution**: When feedback targets a message, how is the agent_name resolved? Options: (a) trace event lookup for the message, (b) session metadata, (c) client provides it. Option (a) is most accurate but adds a query.
3. **Email bridge timing**: Should the email CSAT bridge to ClickHouse be implemented in Phase 1 (with the table creation) or deferred to a later phase? It adds ClickHouse dependency to the currently-independent email endpoint.
4. **Feedback text max length**: What is the maximum character count for `feedbackText`? Suggested: 5000 characters (matches typical CSAT text fields).
5. **Studio proxy authentication**: Should Studio proxy routes use the same `apiFetch` pattern as other settings proxies, or should they use SWR with server-side fetch?

---

## 10. References

- Feature spec: `docs/features/feedback.md`
- Test spec: `docs/testing/feedback.md`
- Existing email CSAT: `apps/runtime/src/routes/feedback.ts`, `apps/runtime/src/services/email/feedback-token.ts`
- Eventstore schema: `packages/eventstore/src/schema/events/feedback-events.ts`
- ClickHouse schemas: `packages/database/src/clickhouse-schemas/init.ts`
- Agent-transfer CSAT: `packages/agent-transfer/src/post-agent/csat-handler.ts`
- Analytics routes pattern: `apps/runtime/src/routes/analytics.ts`
- WebSocket SDK handler: `apps/runtime/src/websocket/sdk-handler.ts`
- LLM metrics pattern (ClickHouse + MV): `packages/database/src/clickhouse-schemas/init.ts` (llm_metrics, llm_metrics_hourly_dest)
