# Feature: Feedback System

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA (WS capture path)
**Feature Area(s)**: `customer experience`, `observability`, `agent lifecycle`
**Package(s)**: `apps/runtime`, `packages/eventstore`, `packages/database`, `packages/web-sdk`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: `../testing/feedback.md`
**Last Updated**: 2026-05-14

---

## Implementation Status (ABLP-1068)

In-chat WS capture is wired and exercised by 100+ unit/integration tests
(`apps/runtime/src/services/feedback/`, `packages/web-sdk/src/__tests__/`).
REST endpoints, stats queries, and the Studio analytics tab remain
DEFERRED — feature-spec FR-1, FR-3, FR-9, FR-10 are explicit about REST
and stay unchanged below.

| Capability                                                                                  | Status            | Trace                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `feedback.submit` ingress                                                                | **IMPLEMENTED**   | `apps/runtime/src/websocket/sdk-handler.ts:handleFeedbackSubmit`; routed via dispatcher case `'feedback.submit'`                                                                                                                               |
| `action_submit(actionId='feedback')`                                                        | **IMPLEMENTED**   | `apps/runtime/src/websocket/sdk-handler.ts:handleActionSubmitFeedback`; short-circuit branch at top of `handleActionSubmit` (no `executeMessage`)                                                                                              |
| WS `feedback.ack` server message                                                            | **IMPLEMENTED**   | `apps/runtime/src/types/index.ts:ServerMessage`; constructor at `apps/runtime/src/websocket/events.ts:ServerMessages.feedbackAck`                                                                                                              |
| Feedback service (dedup, validation, persistence)                                           | **IMPLEMENTED**   | `apps/runtime/src/services/feedback/feedback-service.ts`                                                                                                                                                                                       |
| ClickHouse `abl_platform.feedback` table                                                    | **IMPLEMENTED**   | `packages/database/src/clickhouse-schemas/init.ts` (DDL appended); encryption manifest `feedback.fieldsToEncrypt = ['feedback_text']`                                                                                                          |
| ClickHouse `agent_name` on `messages`                                                       | **IMPLEMENTED**   | `packages/database/src/clickhouse-schemas/init.ts` (fresh-deploy DDL + inline converge ALTER); migration `clickhouse.add-agent-name-to-messages` in `packages/database/src/change-management/manifest.ts`                                      |
| Persisted-id binding (`responseMessageId` → Mongo `_id` / CH `message_id` / in-memory `id`) | **IMPLEMENTED**   | `apps/runtime/src/services/message-persistence-queue.ts:PersistMessageRequest.messageId`; threaded through `sdk-handler.ts` assistant persist sites                                                                                            |
| `MessageStore.getMessageById(...)`                                                          | **IMPLEMENTED**   | `packages/compiler/src/platform/stores/message-store.ts` (abstract); Mongo + CH + InMemory implementations                                                                                                                                     |
| `MessageMetadata.agentName`                                                                 | **IMPLEMENTED**   | `packages/compiler/src/platform/core/types.ts:MessageMetadata`; Mongo schema field on `packages/database/src/models/message.model.ts:IMessage`                                                                                                 |
| EventStore `feedback.submitted` emit                                                        | **IMPLEMENTED**   | Direct `getEventStore().emitter.emit({event_type:'feedback.submitted', ...})` in `feedback-service.ts`. PII-minimised — raw `feedback_text` NOT in `platform_events.data`.                                                                     |
| TraceStore broadcast                                                                        | **IMPLEMENTED**   | Same call site as EventStore emit; mirrors PII policy                                                                                                                                                                                          |
| Web-SDK `ChatClient.submitFeedback(...)`                                                    | **IMPLEMENTED**   | `packages/web-sdk/src/chat/ChatClient.ts`; pending registry + 10s default timeout                                                                                                                                                              |
| Rich-template `TemplateContext.submitFeedback`                                              | **IMPLEMENTED**   | `packages/web-sdk/src/templates/types.ts`; renderer prefers it over `onAction('feedback', ...)` with back-compat fallback                                                                                                                      |
| Thumbs-down comment UX                                                                      | **IMPLEMENTED**   | `packages/web-sdk/src/templates/renderers/feedback.ts` (React + vanilla DOM)                                                                                                                                                                   |
| DSL `FEEDBACK:` parser / IR compile                                                         | **PARSER EXISTS** | `packages/core/src/parser/agent-based-parser.ts:5654` (keys list); `packages/compiler/src/platform/ir/compiler.ts:2911` (compile to `FeedbackTemplateIR`). Capture does NOT depend on agent opt-in. Studio drag-and-drop authoring is the gap. |
| REST `POST /api/projects/:projectId/feedback`                                               | **DEFERRED**      | FR-1 / FR-3 / FR-10 stay NOT IMPLEMENTED. Not in V1 scope.                                                                                                                                                                                     |
| `GET /feedback/stats`, `/feedback/recent`                                                   | **DEFERRED**      | FR-9. Awaits ABLP-988.                                                                                                                                                                                                                         |
| Studio analytics tab                                                                        | **DEFERRED**      | Out of scope for ABLP-1068.                                                                                                                                                                                                                    |
| Materialized view `feedback_daily_dest`                                                     | **DEFERRED**      | Aggregation tier follows in a separate change.                                                                                                                                                                                                 |

---

## 1. Introduction / Overview

### Problem Statement

Operators deploying agents on the ABL platform have no unified way to collect, store, and analyze end-user feedback across channels. The only feedback mechanism today is email CSAT (1-5 star ratings via signed JWT links), which covers a single channel and a single rating type. In-chat interactions (WebSocket, SDK, web widget) have no feedback mechanism at all. Without structured feedback data, operators cannot measure agent quality, identify underperforming agents, or track CSAT trends over time. Competitors (Decagon AOPs, Sierra Agent OS) provide built-in feedback dashboards as a baseline expectation.

### Goal Statement

Provide a comprehensive feedback collection system that supports multiple rating types (thumbs up/down, 1-5 star, free-text) across all channels (email, WebSocket, SDK, web widget). Store feedback in ClickHouse for efficient aggregation. Surface feedback analytics in Studio so operators can measure and improve agent quality.

### Summary

The Feedback System extends the existing email CSAT mechanism into a platform-wide capability. It adds:

1. **In-chat feedback API** -- authenticated REST endpoint for submitting feedback on specific messages within a session
2. **WebSocket feedback** -- `feedback.submit` message type for real-time chat interfaces
3. **ClickHouse storage** -- dedicated `feedback` table for efficient aggregation and analytics queries
4. **Studio dashboard** -- feedback analytics tab showing CSAT trends, per-agent breakdown, and recent feedback
5. **Unified event model** -- all feedback flows through the existing `feedback.submitted` eventstore event

The existing email CSAT endpoint (`/api/v1/feedback/:token`) continues unchanged. The new authenticated endpoint (`/api/projects/:projectId/feedback`) handles in-chat and programmatic feedback.

---

## 2. Scope

### Goals

- Authenticated REST API for submitting feedback on agent messages (`POST /api/projects/:projectId/feedback`)
- WebSocket message type (`feedback.submit`) for in-chat feedback without HTTP round-trip
- Support three rating types: `thumbs` (0 or 1), `star` (1-5), `text` (free-form string)
- ClickHouse `feedback` table for analytics-optimized storage with tenant/project isolation
- Emit `feedback.submitted` trace events (reuse existing eventstore schema)
- Studio analytics tab for viewing feedback trends, per-agent breakdown, and recent submissions
- Deduplication: one feedback per (sessionId, messageId, userId) tuple
- Backward compatibility with existing email CSAT endpoint

### Non-Goals (Out of Scope)

- NPS (Net Promoter Score) surveys or multi-question survey flows
- Feedback-driven agent retraining or automated quality improvement loops
- SearchAI query feedback (handled separately via `feedback_score` in `search_queries` ClickHouse table)
- A/B testing or experiment-linked feedback
- Real-time feedback notifications to operators (push/WebSocket)
- Feedback moderation or approval workflows
- Feedback on non-message targets (e.g., rating an entire session rather than a specific message)

---

## 3. User Stories

1. As an **end-user**, I want to give a thumbs up or thumbs down on an agent's message in a chat so that I can quickly express satisfaction or dissatisfaction.
2. As an **end-user**, I want to optionally add a text comment when giving feedback so that I can explain why I liked or disliked a response.
3. As an **end-user**, I want to rate an email response by clicking a star rating link so that I can provide CSAT feedback without logging in.
4. As a **project admin**, I want to view feedback trends (average rating, thumbs up ratio) over time in Studio so that I can track agent quality improvements.
5. As a **project admin**, I want to see per-agent feedback breakdowns so that I can identify which agents need improvement.
6. As a **project admin**, I want to view recent feedback submissions with the associated message content so that I can understand specific complaints.
7. As a **platform admin**, I want feedback data to follow the platform retention policy (730-day TTL) so that storage costs are controlled.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept feedback via `POST /api/projects/:projectId/feedback` with body `{ sessionId, messageId, ratingType, ratingValue, feedbackText? }`.
2. **FR-2**: The system must validate `ratingType` as one of `thumbs`, `star`, `text` and `ratingValue` as: 0-1 for thumbs, 1-5 for star, ignored for text (text requires `feedbackText`).
3. **FR-3**: The system must authenticate the feedback endpoint using `createUnifiedAuthMiddleware` and scope it to the project via `requireProjectScope`.
4. **FR-4**: The system must deduplicate feedback per `(sessionId, messageId, userId)` -- reject duplicate submissions with `409 Conflict`.
5. **FR-5**: The system must emit a `feedback.submitted` trace event (reusing the existing eventstore schema) with `rating_type`, `rating_value`, `target_message_id`, and optional `feedback_text`.
6. **FR-6**: The system must insert feedback records into the ClickHouse `feedback` table with `tenant_id`, `project_id`, `session_id`, `message_id`, `agent_name`, `user_id`, `rating_type`, `rating_value`, `feedback_text`, and `timestamp`.
7. **FR-7**: The existing email CSAT endpoint (`GET /api/v1/feedback/:token`) must continue to work unchanged with JWT token-based auth and Redis deduplication.
8. **FR-8**: The system must accept feedback via WebSocket message type `feedback.submit` with payload `{ messageId, ratingType, ratingValue, feedbackText? }`, using the session's existing auth context.
9. **FR-9**: The system must provide analytics query endpoints: `GET /api/projects/:projectId/feedback/stats` (aggregate metrics) and `GET /api/projects/:projectId/feedback/recent` (paginated recent feedback).
10. **FR-10**: The system must rate-limit the authenticated feedback endpoint to 10 submissions per minute per user (using existing `tenantRateLimit` middleware).
11. **FR-11**: The system must return responses in the standard envelope format: `{ success: true, data: { feedbackId } }` on success, `{ success: false, error: { code, message } }` on failure.
12. **FR-12**: The system must validate that the referenced `sessionId` belongs to the specified `projectId` before accepting feedback.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                    |
| -------------------------- | ------------ | -------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Feedback is project-scoped; analytics per project        |
| Agent lifecycle            | SECONDARY    | Per-agent feedback breakdown enables quality tracking    |
| Customer experience        | PRIMARY      | End-users submit feedback on agent responses             |
| Integrations / channels    | SECONDARY    | Email CSAT, WebSocket, SDK channels                      |
| Observability / tracing    | PRIMARY      | Feedback events flow through eventstore/ClickHouse       |
| Governance / controls      | NONE         | No governance impact                                     |
| Enterprise / compliance    | SECONDARY    | PII in feedback text, retention policy, right to erasure |
| Admin / operator workflows | SECONDARY    | Studio analytics dashboard for operators                 |

### Related Feature Integration Matrix

| Related Feature              | Relationship Type | Why It Matters                                         | Key Touchpoints                              | Current State           |
| ---------------------------- | ----------------- | ------------------------------------------------------ | -------------------------------------------- | ----------------------- |
| Email Channel                | depends on        | Email CSAT links embedded in outgoing emails           | `email-adapter.ts`, `feedback-token.ts`      | Integrated (ALPHA)      |
| Tracing & Observability      | emits into        | Feedback recorded as trace events                      | `feedback.submitted` event, TraceStore       | Integrated (ALPHA)      |
| EventStore                   | shares data with  | Feedback events stored in ClickHouse platform_events   | `feedback-events.ts`, event-categories       | Schema exists           |
| Analytics Insights Dashboard | extends           | Feedback tab added to analytics dashboard              | `SessionsExplorerTab.tsx`, analytics routes  | Not yet integrated      |
| Agent Transfer / CSAT        | shares data with  | Post-agent CSAT flows emit similar feedback data       | `csat-handler.ts`, `PostAgentConfig`         | Parallel implementation |
| Memory & Sessions            | depends on        | Feedback references sessionId/messageId from sessions  | `session.model.ts`, `session-state.model.ts` | Session model exists    |
| Pipeline Engine              | shares data with  | Feedback events can be consumed by analytics pipelines | `pipeline-engine` eval services              | Event schema compatible |

---

## 6. Design Considerations (Optional)

### Studio UI

The feedback analytics will be added as a new tab in the existing analytics dashboard (`apps/studio/src/components/analytics/`). The tab should follow the established pattern used by `SessionsExplorerTab` and `QueryExplorerTab`:

- **KPI cards**: Average rating, total feedback count, thumbs up ratio, feedback response rate
- **Time-series chart**: Feedback volume and average rating over time
- **Per-agent table**: Agent name, feedback count, average rating, thumbs up/down ratio
- **Recent feedback list**: Paginated, showing message excerpt, rating, optional text, timestamp

### In-Chat Feedback UX

The in-chat feedback mechanism requires SDK/widget support. The runtime WebSocket handler processes `feedback.submit` messages. The UI rendering of thumbs up/down buttons is channel-dependent and implemented in each SDK/widget.

---

## 7. Technical Considerations (Optional)

- **ClickHouse over MongoDB**: Feedback is append-only, high-volume analytical data. ClickHouse is the right fit (same pattern as `llm_metrics`, `platform_events`). MongoDB is not used for feedback storage.
- **Eventstore alignment**: The `FeedbackSubmittedDataSchema` already supports `thumbs`, `star`, and `text` rating types. The new API must emit events matching this schema exactly.
- **Deduplication strategy**: The authenticated endpoint uses ClickHouse `ReplacingMergeTree` with `(session_id, message_id, user_id)` as the dedup key. The email endpoint continues using Redis for dedup (it has no userId).
- **Agent name resolution**: Feedback records need `agent_name` for per-agent analytics. The runtime must resolve which agent generated the target message. This can be derived from the session's trace data or message metadata.
- **Backward compatibility**: The email CSAT endpoint (`/api/v1/feedback/:token`) is untouched. Both endpoints write to the same ClickHouse table and emit the same eventstore event.

---

## 8. How to Consume

### Studio UI

Feedback analytics tab in the project analytics dashboard at:
`/projects/:projectId/analytics` (new "Feedback" tab alongside Sessions, Traces, Query Explorer)

### API (Runtime)

| Method | Path                                       | Purpose                                   |
| ------ | ------------------------------------------ | ----------------------------------------- |
| POST   | `/api/projects/:projectId/feedback`        | Submit feedback (authenticated)           |
| GET    | `/api/projects/:projectId/feedback/stats`  | Aggregate feedback metrics                |
| GET    | `/api/projects/:projectId/feedback/recent` | Paginated recent feedback                 |
| GET    | `/api/v1/feedback/:token`                  | Email CSAT feedback (existing, JWT-based) |
| WS     | `feedback.submit` message type             | In-chat feedback via WebSocket            |

### API (Studio)

| Method | Path                                 | Purpose                          |
| ------ | ------------------------------------ | -------------------------------- |
| GET    | `/api/projects/[id]/feedback/stats`  | Proxy to runtime feedback stats  |
| GET    | `/api/projects/[id]/feedback/recent` | Proxy to runtime recent feedback |

### Admin Portal

No admin-facing pages. Feedback retention follows platform-wide ClickHouse TTL policy.

### Channel / SDK / Voice / A2A / MCP Integration

- **Email**: Existing CSAT rating links via `signFeedbackToken()` in email adapter
- **WebSocket/SDK/Web Widget**: `feedback.submit` WebSocket message with `{ messageId, ratingType, ratingValue, feedbackText? }`
- **Voice**: Not applicable (voice sessions use post-call CSAT via agent-transfer `CsatHandler`)
- **A2A/MCP**: Not applicable in initial scope

---

## 9. Data Model

### ClickHouse: `feedback` table

```text
Table: abl_platform.feedback
Engine: ReplicatedMergeTree
Partition: toYYYYMM(timestamp)
Order: (tenant_id, project_id, timestamp, session_id)

Fields:
  - tenant_id         String               CODEC(ZSTD(1))
  - project_id        String               CODEC(ZSTD(1))
  - feedback_id       String               CODEC(ZSTD(1))
  - timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1))
  - session_id        String               CODEC(ZSTD(1))
  - message_id        String               CODEC(ZSTD(1))
  - agent_name        LowCardinality(String) CODEC(ZSTD(1))
  - user_id           String               DEFAULT '' CODEC(ZSTD(1))
  - channel           LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))
  - rating_type       LowCardinality(String) CODEC(ZSTD(1))   -- 'thumbs' | 'star' | 'text'
  - rating_value      Float32              CODEC(Gorilla, ZSTD(1))  -- 0/1 for thumbs, 1-5 for star, 0 for text
  - feedback_text     String               DEFAULT '' CODEC(ZSTD(3))
  - has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1))
  - encrypted         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1))
  - key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1))
  - source            LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))  -- 'api' | 'email' | 'websocket'

Indexes:
  INDEX idx_session session_id TYPE bloom_filter GRANULARITY 4
  INDEX idx_user    user_id    TYPE bloom_filter GRANULARITY 4
  INDEX idx_agent   agent_name TYPE set(100)     GRANULARITY 4
  INDEX idx_pii     has_pii    TYPE set(2)       GRANULARITY 4

TTL:
  toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm'
  toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold'
  toDateTime(timestamp) + INTERVAL 730 DAY DELETE
```

### ClickHouse: `feedback_daily_dest` (materialized view destination)

```text
Table: abl_platform.feedback_daily_dest
Engine: AggregatingMergeTree
Order: (tenant_id, project_id, agent_name, day)

Fields:
  - tenant_id          String
  - project_id         String
  - agent_name         LowCardinality(String)
  - day                Date
  - total_count        SimpleAggregateFunction(sum, UInt64)
  - thumbs_up_count    SimpleAggregateFunction(sum, UInt64)
  - thumbs_down_count  SimpleAggregateFunction(sum, UInt64)
  - star_sum           SimpleAggregateFunction(sum, Float64)
  - star_count         SimpleAggregateFunction(sum, UInt64)
  - text_count         SimpleAggregateFunction(sum, UInt64)
```

### Redis (existing, unchanged)

```text
Key pattern: feedback:csat:{tenantId}:{messageId}
Value: rating (string)
TTL: 30 days
Purpose: Deduplication for email CSAT endpoint only
```

### Key Relationships

- `feedback.session_id` references `session._id` in MongoDB (cross-store join via application layer)
- `feedback.message_id` references message IDs in the session's trace/message store
- `feedback.agent_name` corresponds to agents defined in the project's ABL configuration
- `feedback_daily_dest` is populated by a ClickHouse materialized view from the `feedback` table

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                       | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `packages/eventstore/src/schema/events/feedback-events.ts` | `feedback.submitted` event schema (exists)    |
| `packages/eventstore/src/schema/event-categories.ts`       | `FEEDBACK` category registration (exists)     |
| `packages/database/src/clickhouse-schemas/init.ts`         | ClickHouse DDL (add `feedback` table)         |
| `apps/runtime/src/services/email/feedback-token.ts`        | JWT token sign/verify for email CSAT (exists) |
| `packages/agent-transfer/src/post-agent/csat-handler.ts`   | Post-agent CSAT flow (exists, parallel)       |

### Routes / Handlers

| File                                                             | Purpose                                |
| ---------------------------------------------------------------- | -------------------------------------- |
| `apps/runtime/src/routes/feedback.ts`                            | Email CSAT endpoint (exists)           |
| `apps/runtime/src/routes/feedback-api.ts`                        | Authenticated feedback API (new)       |
| `apps/studio/src/app/api/projects/[id]/feedback/stats/route.ts`  | Studio proxy for feedback stats (new)  |
| `apps/studio/src/app/api/projects/[id]/feedback/recent/route.ts` | Studio proxy for recent feedback (new) |

### UI Components

| File                                                   | Purpose                                |
| ------------------------------------------------------ | -------------------------------------- |
| `apps/studio/src/components/analytics/FeedbackTab.tsx` | Feedback analytics dashboard tab (new) |

### Jobs / Workers / Background Processes

| File | Purpose                                               |
| ---- | ----------------------------------------------------- |
| N/A  | No background jobs; ClickHouse MV handles aggregation |

### Tests

| File                                                         | Type        | Coverage Focus                        |
| ------------------------------------------------------------ | ----------- | ------------------------------------- |
| `apps/runtime/src/__tests__/email/feedback-token.test.ts`    | unit        | Token sign/verify (exists)            |
| `apps/runtime/src/__tests__/email/feedback-endpoint.test.ts` | unit        | Email endpoint behavior (exists)      |
| `apps/runtime/src/__tests__/feedback-api.test.ts`            | integration | Authenticated feedback API (new)      |
| `apps/runtime/src/__tests__/e2e/feedback-e2e.test.ts`        | e2e         | Full feedback flow via HTTP API (new) |

---

## 11. Configuration

### Environment Variables

| Variable     | Default | Description                                         |
| ------------ | ------- | --------------------------------------------------- |
| `JWT_SECRET` | --      | JWT signing secret for email CSAT tokens (existing) |
| `REDIS_URL`  | --      | Redis URL for email CSAT deduplication (existing)   |

### Runtime Configuration

No new feature flags. The feedback API is available when the runtime is running. The email CSAT endpoint is gated by the `csatEnabled` flag on the channel connection config (existing behavior).

### DSL / Agent IR / Schema

Feedback is not configurable in the ABL DSL. The email adapter's `csatEnabled` flag controls whether CSAT links are embedded in outgoing emails (existing behavior in channel connection config).

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every feedback query includes `tenant_id` in the ClickHouse WHERE clause. Cross-tenant access returns 404.                            |
| Project isolation | Every feedback API route is under `/api/projects/:projectId/...` with `requireProjectScope`. ClickHouse queries include `project_id`. |
| User isolation    | Deduplication key includes `user_id`. Users can only submit feedback in sessions they participate in.                                 |

### Security & Compliance

- **Authenticated endpoint**: Uses `createUnifiedAuthMiddleware` + `requireProjectScope` -- standard platform auth chain
- **Email endpoint**: Uses signed JWT tokens (existing) -- no authentication required, token IS the authorization
- **PII handling**: `feedback_text` may contain PII. Marked `has_pii` in ClickHouse. Eventstore schema has `containsPII: true`. Subject to PII scrubbing retention policy.
- **Right to erasure**: Feedback records for a user can be deleted via ClickHouse `ALTER TABLE DELETE WHERE user_id = ?` (standard GDPR cascade)
- **Rate limiting**: 10 submissions per minute per user via `tenantRateLimit` middleware

### Performance & Scalability

- **Write path**: Single ClickHouse INSERT per feedback + TraceStore event emission. Target: < 50ms p99.
- **Read path (stats)**: Pre-aggregated via `feedback_daily_dest` materialized view. Target: < 200ms for 90-day range.
- **Read path (recent)**: Direct query on `feedback` table with LIMIT/OFFSET. Target: < 100ms for page of 50.
- **Scale**: ClickHouse handles millions of feedback records per partition. No special sharding needed at current scale.
- **Email CSAT**: Unchanged -- O(1) Redis dedup + single TraceStore write.

### Reliability & Failure Modes

- **ClickHouse unavailable**: Feedback API returns 503. Email CSAT continues to emit trace events (fail-open for dedup, trace event always attempted).
- **Redis unavailable (email only)**: Fail-open -- duplicate submissions accepted rather than blocking feedback.
- **TraceStore unavailable**: Feedback still persisted to ClickHouse. Trace event emission logged as warning, not blocking.
- **Idempotency**: Authenticated endpoint rejects duplicates with 409. Email endpoint uses Redis dedup key. ClickHouse `ReplacingMergeTree` provides eventual dedup at query time.

### Observability

- **Trace events**: `feedback.submitted` events in eventstore (existing schema, `FEEDBACK` category)
- **Metrics**: Feedback count, average rating, thumbs up/down ratio (derived from ClickHouse `feedback_daily_dest`)
- **Logs**: Standard `createLogger('feedback-api')` / `createLogger('feedback-route')` logging
- **Dashboard**: Studio analytics Feedback tab (new)

### Data Lifecycle

- **Raw feedback**: 730-day TTL in ClickHouse (warm at 90 days, cold at 365 days, delete at 730 days) -- matches `platform_events` retention
- **Daily aggregates**: 1095-day TTL (3 years) -- matches `llm_metrics_daily_dest` retention
- **Redis dedup keys**: 30-day TTL (email CSAT only, matches token TTL)
- **PII scrubbing**: `feedback_text` with `has_pii=1` subject to retention scheduler (same mechanism as `messages` table)

---

## 13. Delivery Plan / Work Breakdown

1. ClickHouse schema
   1.1 Add `feedback` table DDL to `packages/database/src/clickhouse-schemas/init.ts`
   1.2 Add `feedback_daily_dest` aggregation table
   1.3 Add materialized view `feedback_daily_mv` populating `feedback_daily_dest`
2. Feedback service
   2.1 Create `apps/runtime/src/services/feedback/feedback-service.ts` -- write feedback to ClickHouse + emit trace event
   2.2 Create `apps/runtime/src/services/feedback/feedback-query.ts` -- query feedback stats and recent from ClickHouse
3. Authenticated feedback API
   3.1 Create `apps/runtime/src/routes/feedback-api.ts` -- POST /feedback, GET /feedback/stats, GET /feedback/recent
   3.2 Wire route in `apps/runtime/src/server.ts` under `/api/projects/:projectId/feedback`
   3.3 Add Zod validation schemas for request/response
4. WebSocket feedback handler
   4.1 Add `feedback.submit` message type handler in WebSocket connection handler
   4.2 Route to feedback service for storage + event emission
5. Studio proxy routes
   5.1 Create `apps/studio/src/app/api/projects/[id]/feedback/stats/route.ts`
   5.2 Create `apps/studio/src/app/api/projects/[id]/feedback/recent/route.ts`
6. Studio Feedback Tab
   6.1 Create `apps/studio/src/components/analytics/FeedbackTab.tsx` with KPI cards, time-series chart, agent table, recent list
   6.2 Wire tab into analytics dashboard navigation
   6.3 Add i18n keys for feedback analytics labels
7. Email CSAT bridge
   7.1 Update email CSAT endpoint to also write to ClickHouse `feedback` table (in addition to existing TraceStore event)
8. Tests
   8.1 Unit tests for feedback service (write, query, validation)
   8.2 Integration tests for feedback API endpoints (auth, isolation, dedup)
   8.3 E2E tests for full feedback flow via HTTP API
   8.4 Studio component tests for FeedbackTab

---

## 14. Success Metrics

| Metric                      | Baseline | Target  | How Measured                                           |
| --------------------------- | -------- | ------- | ------------------------------------------------------ |
| Feedback collection rate    | ~5%      | > 10%   | Feedback events / total sessions (per project)         |
| Average CSAT rating         | N/A      | > 3.5   | Mean star rating from feedback_daily_dest              |
| Feedback API p99 latency    | N/A      | < 100ms | Runtime request metrics                                |
| Analytics query p99 latency | N/A      | < 200ms | Runtime request metrics for stats endpoint             |
| Studio dashboard adoption   | N/A      | > 50%   | % of active projects where operators view feedback tab |

---

## 15. Open Questions

1. Should the in-chat feedback UI (thumbs up/down buttons) be rendered by the runtime/SDK or delegated entirely to the client application?
2. Should feedback support updating a previous rating (change thumbs down to thumbs up) or is it immutable once submitted?
3. Should the feedback analytics tab support custom date ranges or only predefined ranges (24h, 7d, 30d, 90d)?
4. Should the email CSAT endpoint be migrated to also write to ClickHouse, or should email feedback remain trace-event-only?
5. Should there be a mechanism for operators to respond to or acknowledge text feedback?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                 | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No E2E test for feedback collection through email flow                                      | Medium   | Open   |
| GAP-002 | No feedback analytics dashboard in Studio                                                   | High     | Open   |
| GAP-003 | Only email CSAT implemented; no in-chat thumbs up/down API                                  | High     | Open   |
| GAP-004 | No dedicated ClickHouse feedback table (feedback stored only as trace events)               | High     | Open   |
| GAP-005 | Redis dedup is best-effort for email (fail-open allows duplicates when Redis is down)       | Low      | Open   |
| GAP-006 | No WebSocket message handler for `feedback.submit`                                          | Medium   | Open   |
| GAP-007 | Agent name resolution for feedback records not yet implemented                              | Medium   | Open   |
| GAP-008 | PII scrubbing for `feedback_text` relies on platform retention scheduler (not yet verified) | Medium   | Open   |
| GAP-009 | No feedback export (CSV/JSON) capability                                                    | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                      | Coverage Type | Status     | Test File / Note                                    |
| --- | --------------------------------------------- | ------------- | ---------- | --------------------------------------------------- |
| 1   | Feedback token sign/verify                    | unit          | PASS       | `runtime/__tests__/email/feedback-token.test.ts`    |
| 2   | Email CSAT endpoint behavior                  | unit          | PASS       | `runtime/__tests__/email/feedback-endpoint.test.ts` |
| 3   | Redis deduplication (email)                   | unit          | PASS       | Covered in feedback-endpoint.test.ts                |
| 4   | Redis unavailability (fail-open)              | unit          | NOT TESTED | Email endpoint fail-open path                       |
| 5   | Authenticated feedback POST                   | e2e           | NOT TESTED | New API endpoint                                    |
| 6   | Feedback deduplication (authenticated)        | integration   | NOT TESTED | 409 on duplicate (sessionId, messageId, userId)     |
| 7   | Feedback stats aggregation query              | integration   | NOT TESTED | ClickHouse query via stats endpoint                 |
| 8   | Feedback recent query with pagination         | integration   | NOT TESTED | ClickHouse query via recent endpoint                |
| 9   | Cross-tenant feedback isolation               | e2e           | NOT TESTED | Tenant A cannot see Tenant B's feedback             |
| 10  | Cross-project feedback isolation              | e2e           | NOT TESTED | Project A cannot see Project B's feedback           |
| 11  | WebSocket feedback.submit handler             | integration   | NOT TESTED | WebSocket message processing                        |
| 12  | Studio FeedbackTab rendering                  | unit          | NOT TESTED | Component rendering with mock data                  |
| 13  | E2E full feedback flow (submit + query stats) | e2e           | NOT TESTED | POST feedback, GET stats, verify counts             |

### Testing Notes

Core email CSAT functionality has unit test coverage (token service and endpoint behavior). The major gaps are all related to the new functionality: authenticated API, ClickHouse storage, WebSocket handler, Studio UI, and isolation tests. E2E tests must use real HTTP API calls with proper auth context -- no mocking of codebase components.

> Full testing details: `../testing/feedback.md`

---

## 18. References

- Existing email CSAT: `apps/runtime/src/routes/feedback.ts`, `apps/runtime/src/services/email/feedback-token.ts`
- Eventstore schema: `packages/eventstore/src/schema/events/feedback-events.ts`
- ClickHouse schemas: `packages/database/src/clickhouse-schemas/init.ts`
- Agent-transfer CSAT: `packages/agent-transfer/src/post-agent/csat-handler.ts`
- Related feature docs: [analytics-insights-dashboard](./analytics-insights-dashboard.md), [email-channel](./email-channel.md), [tracing-observability](./tracing-observability.md)
