# Runtime Event Production System — Design Document

## Date: 2026-03-01

**Scope**: Event production from Runtime to Kafka, connecting session/message/execution lifecycle events to the existing pipeline engine for customer-defined analytics (competitor detection, toxicity scoring, fulfillment analysis, containment trends).

---

## 1. Problem Statement

### 1.1 Current State — One-Way Pipeline Trigger

The pipeline engine (Restate-based, `packages/pipeline-engine/`) can consume Kafka events, match them to active pipeline definitions, and execute durable DAG workflows. The consumer side works:

```
Kafka Topic → PipelineTrigger.handleEvent() → PipelineRun workflow → Steps → Results
```

But **nothing produces events to Kafka**. The Runtime emits trace events over WebSocket and ClickHouse for debugging, but these are internal observability signals — not business events that customers can act on.

### 1.2 What's Missing

The Runtime processes user conversations, agent responses, tool calls, handoffs, and escalations — all valuable signals for analytics. But none of them flow to Kafka:

| Signal                | Where It Exists Today                              | Flows to Kafka? |
| --------------------- | -------------------------------------------------- | --------------- |
| User sends a message  | WebSocket handler → persisted to MongoDB           | No              |
| Agent responds        | WebSocket handler → streamed to client → persisted | No              |
| Session created       | WebSocket handler → audit log                      | No              |
| Session ended         | WebSocket close → audit log + MongoDB              | No              |
| Tool called/completed | Reasoning executor → trace event                   | No              |
| Agent handoff         | Routing executor → trace event                     | No              |
| Escalation triggered  | Routing executor → trace event                     | No              |

### 1.3 What This Design Solves

Customers want to run analytics pipelines triggered by conversation events:

- **Competitor mention detection**: Analyze every user message for competitor brand names → alert on Slack
- **Toxicity scoring**: Score every agent response → flag toxic outputs → store scores in ClickHouse
- **Session fulfillment analysis**: When a session ends, evaluate whether the user's query was resolved
- **Containment trend analysis**: Every hour, compute the ratio of sessions resolved without escalation

The first three are **real-time event-driven** — triggered by individual messages or session lifecycle events. The fourth is **time-frequency based** — triggered on a schedule, querying accumulated data.

This design provides the "left side of Kafka" — producing events from Runtime so the existing pipeline engine can consume them.

### 1.4 What This Design Does NOT Do

- Does not change the pipeline engine or Restate workflows (consumer side is unchanged)
- Does not replace the trace system (WebSocket traces continue for debugging)
- Does not add stream processing (no Flink/Kafka Streams — scheduled pipelines handle periodic analysis)
- Does not introduce new infrastructure beyond what exists (Kafka broker already runs for pipeline triggers)

---

## 2. Architecture Overview

### 2.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  Runtime Process                                                     │
│                                                                      │
│  ┌──────────────────┐                                                │
│  │ ExecutionCoord.   │──┐                                            │
│  ├──────────────────┤  │  emit()   ┌───────────────────────────┐    │
│  │ WebSocket Handler │──┼────────→ │         EventBus           │    │
│  ├──────────────────┤  │          │                             │    │
│  │ Session Manager   │──┘          │  - subscriptionRegistry    │    │
│  └──────────────────┘              │  - subscribers[]            │    │
│                                     │  - emit(event)             │    │
│                                     │  - subscribe(fn)           │    │
│                                     └──────────┬────────────────┘    │
│                                                 │                     │
│                                    ┌────────────┼────────────┐       │
│                                    ▼            ▼            ▼       │
│                             ┌───────────┐ ┌──────────┐ ┌────────┐   │
│                             │  Kafka    │ │ (future) │ │(future)│   │
│                             │Subscriber │ │ Webhook  │ │Metrics │   │
│                             └─────┬─────┘ └──────────┘ └────────┘   │
│                                   │                                   │
│                        ┌──────────┼──────────┐                       │
│                        ▼          ▼          ▼                       │
│                   ┌────────┐ ┌────────┐ ┌────────┐                  │
│                   │ Batch  │ │ Retry  │ │  Dead  │                  │
│                   │ Buffer │ │ Queue  │ │ Letter │                  │
│                   └────────┘ └────────┘ └────────┘                  │
└────────────────────────┬─────────────────────┬──────────────────────┘
                         │                     │
                         ▼                     ▼
                    ┌──────────┐         ┌────────────┐
                    │  Kafka   │         │ ClickHouse │
                    │  Broker  │         │ (dead ltr) │
                    └─────┬────┘         └────────────┘
                          │
                          ▼
                  ┌───────────────┐
                  │ Pipeline      │
                  │ Trigger       │
                  │ (existing)    │
                  └───────┬───────┘
                          │
                          ▼
                  ┌───────────────┐
                  │ PipelineRun   │
                  │ (Restate)     │
                  └───────────────┘
```

### 2.2 Design Decisions

| Decision           | Choice                      | Rationale                                                                                                                                   |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer location  | Inside Runtime              | Lowest latency, simplest deployment. Abstracted behind `EventPublisher` interface for future sidecar migration.                             |
| Event granularity  | Fine-grained types          | Pipelines subscribe to exact event types (`message.user`, not `messages`). Precise control, no wasted processing.                           |
| Topic strategy     | One topic per event type    | `abl.session.created`, `abl.message.user`, etc. Clean separation, independent scaling per event type.                                       |
| Payload strategy   | Tiered by event type        | Message events carry full content (needed for NLP). Session events carry summary metrics. Tool events carry call signature + result status. |
| Scheduled analysis | Pipeline-scheduled triggers | Existing `trigger.type: 'schedule'` in pipeline definitions. No new scheduler service. Pipeline's first step queries accumulated data.      |
| Reliability        | Best-effort + dead-letter   | Async publish with 3 retries. Failed events logged to ClickHouse `dead_letter_events` table. Runtime never blocked.                         |
| Tenant gating      | EventSubscriptionRegistry   | Only produce events for tenants with active pipelines subscribed to that event type. Zero Kafka writes for inactive tenants.                |

---

## 3. Event Catalog

### 3.1 Common Envelope

All events share this structure:

```typescript
interface PlatformEvent<T extends string, P> {
  eventId: string; // UUID v7 (time-sortable)
  type: T; // discriminant — e.g., 'message.user'
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  channel: string; // 'web', 'whatsapp', 'sdk', etc.
  timestamp: string; // ISO 8601
  payload: P; // type-specific, see below
}
```

### 3.2 Session Events — Lightweight (summary metrics)

**`session.created`** — Topic: `abl.session.created`

```typescript
interface SessionCreatedPayload {
  customerId?: string;
  anonymousId?: string;
  deploymentId?: string;
  resumedFrom?: string; // session ID if resumed
}
```

**`session.ended`** — Topic: `abl.session.ended`

```typescript
interface SessionEndedPayload {
  reason: 'completed' | 'timeout' | 'error' | 'user_left';
  durationMs: number;
  turnCount: number;
  agentsUsed: string[]; // all agents active during session
}
```

**`session.handoff`** — Topic: `abl.session.handoff`

```typescript
interface SessionHandoffPayload {
  fromAgent: string;
  toAgent: string;
  reason: string;
  context?: Record<string, unknown>;
}
```

**`session.escalation`** — Topic: `abl.session.escalation`

```typescript
interface SessionEscalationPayload {
  agent: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  targetTeam?: string;
}
```

### 3.3 Message Events — Rich (carry content for NLP analysis)

**`message.user`** — Topic: `abl.message.user`

```typescript
interface MessageUserPayload {
  messageId: string;
  content: string; // full message text
  messageIndex: number;
  locale?: string;
}
```

**`message.agent`** — Topic: `abl.message.agent`

```typescript
interface MessageAgentPayload {
  messageId: string;
  content: string; // full agent response text
  messageIndex: number;
  modelId?: string;
  tokensUsed?: number;
}
```

### 3.4 Execution Events — Medium (call signature + result status)

**`tool.called`** — Topic: `abl.tool.called`

```typescript
interface ToolCalledPayload {
  toolName: string;
  parameters: Record<string, unknown>;
}
```

**`tool.completed`** — Topic: `abl.tool.completed`

```typescript
interface ToolCompletedPayload {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  resultSummary?: string; // truncated/summarized result, not full payload
}
```

### 3.5 Partition Key

All events use `${tenantId}:${sessionId}` as the Kafka partition key. This guarantees:

- Ordering within a session (messages arrive in order)
- Distribution across tenants (different tenants hit different partitions)
- Co-location of related events (all events for a session land on the same partition)

---

## 4. EventBus Architecture

### 4.1 Interfaces

```typescript
// Event sources call this — no knowledge of Kafka or any destination
interface EventBus {
  emit(event: PlatformEvent<string, unknown>): void; // fire-and-forget, never throws
  subscribe(fn: EventSubscriber): void;
  unsubscribe(fn: EventSubscriber): void;
  shutdown(): Promise<void>; // drain buffers on graceful shutdown
}

type EventSubscriber = (event: PlatformEvent<string, unknown>) => void;

// Kafka-specific — one implementation of EventSubscriber
interface EventPublisher {
  publish(topic: string, key: string, event: PlatformEvent<string, unknown>): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

### 4.2 EventBus Behavior

- **`emit()` is synchronous and never throws.** Event sources (execution-coordinator, WebSocket handler) must not be blocked or crashed by event delivery failures. The bus catches all errors internally and logs them.
- **Topic derivation is automatic.** The bus maps `event.type` to a topic name: `message.user` → `abl.message.user`. Callers never specify topic names.
- **Tenant gating happens at emit time.** The `EventSubscriptionRegistry` is checked before forwarding to subscribers. Events for tenants with no active pipelines are dropped silently (O(1) lookup).

### 4.3 Tenant Event Subscription Registry

Not all tenants want all events processed. The registry gates event production to avoid flooding Kafka with unprocessed events.

```
Pipeline activated/deactivated
    │
    ▼
Query: PipelineDefinition.find({
  status: 'active',
  'trigger.type': 'kafka',
  'trigger.topic': /^abl\./
})
    │
    ▼
Build: Map<tenantId, Set<eventType>>
    T1 → ['message.user', 'session.ended']
    T2 → ['message.user', 'message.agent', 'tool.called']
    T3 → []  (no active pipelines — zero events produced)
    │
    ▼
EventBus.emit(event)
    → registry.isSubscribed(tenantId, eventType)?
       YES → forward to subscribers
       NO  → drop silently
```

**Sync strategy:** Refresh every 60s via a periodic query against MongoDB. Lightweight — a single aggregation on active pipeline definitions grouped by tenant. The 60s window means a newly activated pipeline may miss events for up to one minute. Acceptable for analytics use cases.

**Data structure:** `Map<string, Set<string>>` — O(1) lookup at emit time. No I/O in the hot path.

### 4.4 Location

New module inside Runtime: `apps/runtime/src/services/event-bus/`

```
apps/runtime/src/services/event-bus/
  ├── types.ts                      # PlatformEvent, EventBus, EventSubscriber interfaces
  ├── event-bus.ts                  # EventBus implementation
  ├── subscription-registry.ts      # Tenant subscription registry
  ├── kafka-subscriber.ts           # KafkaEventPublisher (batch + retry + dead-letter)
  └── dead-letter-writer.ts         # ClickHouse dead-letter persistence
```

Not a separate package yet. Extracted to `packages/event-bus/` only if a second service (e.g., search-ai) needs it.

---

## 5. Kafka Producer

### 5.1 Producer Configuration

```typescript
const producer = kafka.producer({
  allowAutoTopicCreation: false, // topics pre-created at deployment
  idempotent: true, // exactly-once per producer session
  maxInFlightRequests: 5,
  retry: {
    initialRetryTime: 100, // 100ms → 200ms → 400ms
    retries: 3,
    factor: 2,
  },
  compression: CompressionTypes.LZ4, // matches existing broker config
});
```

### 5.2 Batching

Events are not sent individually. The `KafkaSubscriber` accumulates events in bounded per-topic buffers and flushes as a batch:

| Parameter   | Default    | Env Override             |
| ----------- | ---------- | ------------------------ |
| Batch size  | 100 events | `EVENT_KAFKA_BATCH_SIZE` |
| Linger time | 500ms      | `EVENT_KAFKA_LINGER_MS`  |

Flush triggers when **either** threshold is reached — whichever comes first.

```typescript
producer.sendBatch([
  { topic: 'abl.message.user', messages: [...buffered] },
  { topic: 'abl.session.ended', messages: [...buffered] },
]);
```

Each Kafka message:

```typescript
{
  key: `${tenantId}:${sessionId}`,      // partition key
  value: JSON.stringify(event),          // PlatformEvent JSON
  headers: {
    'event-type': event.type,
    'tenant-id': event.tenantId,
    'event-id': event.eventId,           // consumer dedup
  },
  timestamp: event.timestamp,
}
```

### 5.3 Topic Configuration

Topics are pre-created at deployment (via the existing Kafka init script pattern in `apps/pipeline-docker/`):

| Topic                    | Partitions | Rationale                                   |
| ------------------------ | ---------- | ------------------------------------------- |
| `abl.session.created`    | 6          | Moderate volume — one per session           |
| `abl.session.ended`      | 6          | Moderate volume — one per session           |
| `abl.session.handoff`    | 3          | Low volume — not every session has handoffs |
| `abl.session.escalation` | 3          | Low volume — escalations are infrequent     |
| `abl.message.user`       | 12         | High volume — every conversation turn       |
| `abl.message.agent`      | 12         | High volume — every conversation turn       |
| `abl.tool.called`        | 6          | Medium volume — depends on agent design     |
| `abl.tool.completed`     | 6          | Medium volume — matches tool.called         |

Replication factor: 1 (dev), 3 (production).

---

## 6. Dead-Letter Handling

### 6.1 Why ClickHouse, Not a Kafka Dead-Letter Topic

If Kafka itself is the failure point, writing to a Kafka dead-letter topic doesn't help. ClickHouse is already connected from Runtime (trace store) — no new dependency. It's also queryable: ops team can filter by tenant, event type, time range, and error reason.

### 6.2 Dead-Letter Table Schema

```sql
CREATE TABLE IF NOT EXISTS abl_platform.dead_letter_events (
  event_id       UUID,
  event_type     LowCardinality(String),
  tenant_id      String,
  session_id     String,
  payload        String,                   -- full JSON event
  error_message  String,
  retry_count    UInt8,
  failed_at      DateTime64(3, 'UTC'),
  replayed       Bool DEFAULT 0
)
ENGINE = MergeTree()
ORDER BY (tenant_id, failed_at, event_type)
TTL failed_at + INTERVAL 30 DAY;          -- auto-cleanup after 30 days
```

### 6.3 Failure Flow

```
producer.sendBatch() fails after 3 retries
    │
    ▼
For each failed event:
    │
    ├── Log warning: 'Event delivery failed' { eventId, eventType, tenantId, error }
    │
    └── Write to dead_letter_events via ClickHouse buffered writer
        (same pattern as existing trace store — batched inserts)
```

### 6.4 Replay

Manual/admin operation — a CLI command or Studio admin endpoint:

```sql
SELECT * FROM abl_platform.dead_letter_events
WHERE replayed = 0
  AND tenant_id = {tenantId:String}
  AND failed_at > now() - INTERVAL 24 HOUR
ORDER BY failed_at;
```

Read rows → publish to Kafka → set `replayed = 1`. Not automated — ops team decides when to replay. Automation can be added later if dead-letter volume warrants it.

---

## 7. Runtime Integration Points

### 7.1 Principle

Tap into existing code paths. Each event emission is a single `eventBus.emit()` call placed next to where the action already happens (audit log, trace event, message persistence). No restructuring of handlers.

### 7.2 Event Emission Map

| Event                | File                    | Function                 | Insert Point                                  | What's Already There                                                |
| -------------------- | ----------------------- | ------------------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| `session.created`    | `handler.ts`            | `ensureDebugDbSession()` | After DB session created (~L205)              | `auditSessionCreated()` already fires                               |
| `session.ended`      | `handler.ts`            | `ws.on('close')`         | After disposition determined (~L467)          | `auditSessionEnded()` already fires                                 |
| `session.handoff`    | `routing-executor.ts`   | `handleHandoff()`        | After handoff succeeds (~L192)                | Trace event `type: 'handoff'` already emitted                       |
| `session.escalation` | `routing-executor.ts`   | `handleEscalate()`       | After escalation state set (~L909)            | Trace event `type: 'escalation'` already emitted                    |
| `message.user`       | `handler.ts`            | `handleSendMessage()`    | After message queued for persistence (~L1284) | `persistMessage(role='user')` already called                        |
| `message.agent`      | `handler.ts`            | `handleSendMessage()`    | After response finalized (~L1295)             | `responseEnd()` + `persistMessage(role='assistant')` already called |
| `tool.called`        | `reasoning-executor.ts` | `executeToolCall()`      | Before tool execution begins (~L685)          | `startTime = Date.now()` already recorded                           |
| `tool.completed`     | `reasoning-executor.ts` | `executeToolCall()`      | After tool result computed (~L804)            | Trace event `type: 'tool_call'` already emitted                     |

### 7.3 Injection Pattern

Every emit site follows the same pattern:

```typescript
// EXISTING CODE (already in codebase):
auditSessionEnded(auditRepo, dbSessionId, tenantId, durationMs, disposition);

// ADDED (one line):
eventBus.emit({
  eventId: randomUUID(),
  type: 'session.ended',
  tenantId,
  projectId,
  sessionId: dbSessionId,
  agentName,
  channel,
  timestamp: new Date().toISOString(),
  payload: { reason: disposition, durationMs, turnCount, agentsUsed },
});
```

### 7.4 EventBus Dependency Injection

The `EventBus` instance is created once at Runtime startup and passed through the existing dependency chain:

- **`handler.ts`** — receives `eventBus` as a parameter to `handleConnection()`, same pattern as `executor`, `traceStore`, `auditRepo`
- **`routing-executor.ts`** and **`reasoning-executor.ts`** — receive `eventBus` via the session context or callback pattern (same way `onTraceEvent` is already passed)

### 7.5 What's NOT Changed

- WebSocket trace system continues unchanged for real-time debugging
- ClickHouse trace store continues unchanged for long-term observability
- Audit logging continues unchanged
- Message persistence continues unchanged
- REST `/api/chat/` routes are not included initially (they don't create persistent sessions)

---

## 8. Pipeline Trigger Integration

### 8.1 What Already Works

The pipeline trigger (`PipelineTrigger.handleEvent()`) already supports:

- Subscribing to arbitrary Kafka topics by name
- Event filtering via `trigger.eventFilter` (JSONPath conditions)
- Input schema validation via `trigger.inputSchema`
- Spawning Restate workflow runs for matching events

No changes needed to the trigger service. When a customer creates a pipeline with `trigger.topic: 'abl.message.user'`, the trigger service subscribes to that topic and processes matching events.

### 8.2 Required Change: Tenant Isolation Validation

Shared topics carry events from all tenants. A pipeline without a `tenantId` filter on an `abl.*` topic would process every tenant's messages — violating tenant isolation.

**Change:** Add a validation rule in `validatePipeline()`:

> If `trigger.topic` starts with `abl.`, then `eventFilter.tenantId` is **required**. Reject pipeline definitions that subscribe to platform event topics without tenant scoping.

### 8.3 Pipeline Definition Examples

**Competitor mention detection** — triggers on every user message for tenant T1:

```json
{
  "name": "Competitor Mention Detector",
  "trigger": {
    "type": "kafka",
    "topic": "abl.message.user",
    "eventFilter": {
      "tenantId": "tenant-123",
      "projectId": "project-456"
    }
  },
  "steps": [
    {
      "id": "detect",
      "type": "evaluate_metrics",
      "config": {
        "metric": "competitor_mentions",
        "source": "payload.content"
      }
    },
    {
      "id": "alert",
      "type": "send_notification",
      "condition": "steps.detect.output.detected === true",
      "config": { "channel": "slack", "severity": "medium" }
    }
  ]
}
```

**Toxicity scoring on agent responses** — scores every agent message:

```json
{
  "name": "Agent Response Toxicity Check",
  "trigger": {
    "type": "kafka",
    "topic": "abl.message.agent",
    "eventFilter": {
      "tenantId": "tenant-123"
    }
  },
  "steps": [
    {
      "id": "toxicity",
      "type": "evaluate_metrics",
      "config": {
        "metric": "toxicity_score",
        "source": "payload.content"
      }
    },
    {
      "id": "store",
      "type": "store_results",
      "config": { "destination": "clickhouse", "table": "toxicity_scores" }
    },
    {
      "id": "alert",
      "type": "send_notification",
      "condition": "steps.toxicity.output.score > 0.7",
      "config": { "channel": "slack", "severity": "high" }
    }
  ]
}
```

**Session fulfillment analysis** — triggers when sessions end successfully:

```json
{
  "name": "Query Fulfillment Analyzer",
  "trigger": {
    "type": "kafka",
    "topic": "abl.session.ended",
    "eventFilter": {
      "tenantId": "tenant-123",
      "payload.reason": "completed"
    }
  },
  "steps": [
    {
      "id": "evaluate",
      "type": "evaluate_metrics",
      "config": {
        "metric": "query_fulfillment",
        "sessionId": "$.sessionId"
      }
    },
    {
      "id": "store",
      "type": "store_results",
      "config": { "destination": "clickhouse", "table": "fulfillment_scores" }
    }
  ]
}
```

**Containment trend analysis** — scheduled, no Kafka trigger:

```json
{
  "name": "Hourly Containment Trend",
  "trigger": {
    "type": "schedule",
    "scheduleConfig": { "cron": "0 * * * *" }
  },
  "steps": [
    {
      "id": "query",
      "type": "evaluate_metrics",
      "config": {
        "metric": "containment_rate",
        "source": "clickhouse",
        "timeWindow": "1h"
      }
    },
    {
      "id": "policy",
      "type": "evaluate_policy",
      "config": {
        "policy": "containment_threshold",
        "threshold": 0.85
      }
    },
    {
      "id": "alert",
      "type": "send_notification",
      "condition": "steps.policy.output.breached === true",
      "config": { "channel": "email", "template": "containment_drop_alert" }
    }
  ]
}
```

### 8.4 End-to-End Flow

```
User sends message in chat
    │
    ▼
Runtime: handler.ts → handleSendMessage()
    │
    ├── Process message (existing)
    ├── Persist message (existing)
    ├── eventBus.emit({ type: 'message.user', tenantId: 'T1', payload: { content: '...' } })
    │       │
    │       ▼
    │   EventSubscriptionRegistry: T1 subscribed to 'message.user'? YES
    │       │
    │       ▼
    │   KafkaSubscriber: buffer (100 events or 500ms) → flush
    │       │
    │       ▼
    │   producer.sendBatch('abl.message.user', [...])
    │
    ▼
Kafka broker: abl.message.user, partition by T1:session-123
    │
    ▼
PipelineTrigger consumer receives message
    │
    ├── Find active pipelines for topic 'abl.message.user'
    │   → "Competitor Mention Detector" (tenant T1)
    │
    ├── eventFilter: tenantId === 'T1'? YES
    ├── inputSchema: payload.content exists? YES
    │
    ▼
Spawn PipelineRun via Restate
    │
    ├── Step 1: evaluate_metrics → detect competitor mentions
    ├── Step 2: send_notification → Slack alert (if detected)
    │
    ▼
Run record persisted to MongoDB
```

---

## 9. Configuration

All constants are configurable via environment variables. No magic numbers.

| Constant                          | Default | Env Override                      | Purpose                                |
| --------------------------------- | ------- | --------------------------------- | -------------------------------------- |
| `EVENT_KAFKA_BATCH_SIZE`          | 100     | `EVENT_KAFKA_BATCH_SIZE`          | Events per batch before flush          |
| `EVENT_KAFKA_LINGER_MS`           | 500     | `EVENT_KAFKA_LINGER_MS`           | Max time before batch flush            |
| `EVENT_KAFKA_RETRIES`             | 3       | `EVENT_KAFKA_RETRIES`             | Retry attempts per batch               |
| `EVENT_KAFKA_RETRY_INITIAL_MS`    | 100     | `EVENT_KAFKA_RETRY_INITIAL_MS`    | First retry delay                      |
| `EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS` | 10000   | `EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS` | Max drain time on SIGTERM              |
| `EVENT_REGISTRY_SYNC_MS`          | 60000   | `EVENT_REGISTRY_SYNC_MS`          | Subscription registry refresh interval |
| `EVENT_KAFKA_ENABLED`             | false   | `EVENT_KAFKA_ENABLED`             | Master switch — disabled by default    |

**Master switch:** `EVENT_KAFKA_ENABLED` defaults to `false`. When disabled, `EventBus` is a no-op — emit calls do nothing. No Kafka connection, no registry sync, no overhead. Enabled per-environment when Kafka is available.

---

## 10. Graceful Shutdown

```
SIGTERM received
    │
    ▼
EventBus.shutdown()
    │
    ├── Stop accepting new events (emit becomes no-op)
    ├── Stop subscription registry sync timer
    │
    ├── KafkaSubscriber.flush()
    │       │
    │       ▼
    │   producer.sendBatch()        // drain remaining buffered events
    │       │
    │       ▼ (success)
    │   producer.disconnect()
    │       │
    │       ▼ (failure within 10s timeout)
    │   Write remaining to dead-letter (ClickHouse)
    │   producer.disconnect()
    │
    ├── DeadLetterWriter.flush()    // drain any buffered DL events
    │
    ▼
Process exits
```

---

## 11. Future Migration Path: Runtime → Sidecar

The `EventBus` + `EventPublisher` abstraction makes sidecar migration a deployment change, not a code rewrite.

### Current (Phase 1): Direct Kafka

```
Runtime EventBus → KafkaSubscriber → Kafka
```

### Future (Phase 2): Sidecar via Redis Streams

```
Runtime EventBus → RedisStreamSubscriber → Redis Streams
                                                │
                                    ┌───────────┘
                                    ▼
                          Event Sidecar Service
                          (reads Redis Streams)
                                    │
                                    ▼
                                  Kafka
```

**Migration steps:**

1. Implement `RedisStreamSubscriber` (same `EventSubscriber` interface)
2. Swap subscriber in Runtime config — no changes to emit sites
3. Deploy sidecar service that reads Redis Streams and publishes to Kafka
4. Remove `KafkaSubscriber` from Runtime

The Runtime already publishes to Redis Streams via `RedisTraceStore`. The pattern is proven.

---

## 12. Tenant Isolation Considerations

### Producer Side

- `EventSubscriptionRegistry` ensures events are only produced for tenants with active pipelines
- Every event carries `tenantId` in both the envelope and Kafka headers
- Partition key includes `tenantId` — events for different tenants land on different partitions

### Consumer Side (Pipeline Trigger)

- `eventFilter.tenantId` is **mandatory** for `abl.*` topics (enforced by `validatePipeline()`)
- Pipeline definitions are tenant-scoped in MongoDB — a tenant can only create pipelines for their own `tenantId`
- Pipeline run records are tenant-scoped — query isolation enforced at the data layer

### No Cross-Tenant Leakage Vectors

- A tenant cannot subscribe to another tenant's events (pipeline validation rejects mismatched tenantId)
- A tenant cannot see another tenant's pipeline runs (MongoDB queries include tenantId filter)
- Dead-letter table is tenant-scoped in queries (admin access only, filtered by tenantId)

---

## 13. Testing Strategy

### Unit Tests

- `EventBus`: emit → subscriber called, emit with no subscribers → no error, shutdown drains
- `EventSubscriptionRegistry`: build from pipeline definitions, sync refresh, tenant not subscribed → event dropped
- `KafkaSubscriber`: batch accumulation, flush on size threshold, flush on linger timeout
- Dead-letter writer: failed events written to ClickHouse with correct schema

### Integration Tests

- Runtime emit → Kafka topic receives message with correct schema and partition key
- Pipeline trigger receives event → matches pipeline → spawns run
- Tenant gating: tenant with no active pipelines → zero Kafka messages produced
- Dead-letter: Kafka unavailable → events land in ClickHouse dead-letter table
- Graceful shutdown: SIGTERM → buffered events flushed before disconnect

### Tenant Isolation Tests

- Two tenants, both with active pipelines on `abl.message.user`
- Tenant A's messages only trigger Tenant A's pipelines
- Tenant B's messages only trigger Tenant B's pipelines
- Pipeline created without `tenantId` filter on `abl.*` topic → validation error

## Implementation Plan

**Goal:** Produce business events (session lifecycle, messages, tool calls) from Runtime to Kafka so the existing pipeline engine can consume them for customer-defined analytics.

**Architecture:** An in-process EventBus in Runtime decouples event sources from Kafka delivery. A KafkaSubscriber batches and publishes events. A tenant-aware SubscriptionRegistry gates production to only emit events for tenants with active pipelines. Dead-letter events go to ClickHouse.

**Tech Stack:** KafkaJS, ClickHouse (BufferedWriter), Vitest, existing Runtime services

---

### Task 1: Add KafkaJS Dependency and Event Constants

Add `kafkajs` to `apps/runtime/package.json`. Add event production constants to `packages/config/src/constants.ts`: `DEFAULT_KAFKA_BROKER`, `EVENT_KAFKA_BATCH_SIZE` (100), `EVENT_KAFKA_LINGER_MS` (500), `EVENT_KAFKA_RETRIES` (3), `EVENT_KAFKA_RETRY_INITIAL_MS` (100), `EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS` (10000), `EVENT_REGISTRY_SYNC_MS` (60000). Add topic name constants for all 8 `abl.*` topics.

### Task 2: Create PlatformEvent Types

Create `apps/runtime/src/services/event-bus/types.ts` with `PlatformEvent<T, P>` envelope interface, payload interfaces for all 8 event types (`SessionCreatedPayload`, `SessionEndedPayload`, `SessionHandoffPayload`, `SessionEscalationPayload`, `MessageUserPayload`, `MessageAgentPayload`, `ToolCalledPayload`, `ToolCompletedPayload`), and helper type `AnyPlatformEvent`.

### Task 3: Implement EventBus

Create `apps/runtime/src/services/event-bus/event-bus.ts`. Synchronous `emit()` that never throws. Topic derivation from `event.type`. Tenant gating via `EventSubscriptionRegistry`. Subscriber management. Graceful `shutdown()`.

### Task 4: Implement EventSubscriptionRegistry

Create `apps/runtime/src/services/event-bus/subscription-registry.ts`. `Map<string, Set<string>>` for O(1) lookup at emit time. Periodic sync (60s) against MongoDB `PipelineDefinition.find({ status: 'active', 'trigger.type': 'kafka' })`. `isSubscribed(tenantId, eventType)` method.

### Task 5: Implement KafkaSubscriber

Create `apps/runtime/src/services/event-bus/kafka-subscriber.ts`. Batching (100 events or 500ms linger). Idempotent producer with LZ4 compression. Per-topic bounded buffers. Flush on size threshold or linger timeout. Retry with exponential backoff (3 retries). Failed events forwarded to dead-letter writer.

### Task 6: Implement Dead-Letter Writer

Create `apps/runtime/src/services/event-bus/dead-letter-writer.ts`. ClickHouse buffered writer to `abl_platform.dead_letter_events` table. Captures `event_id`, `event_type`, `tenant_id`, `session_id`, `payload`, `error_message`, `retry_count`, `failed_at`. 30-day TTL auto-cleanup.

### Task 7: Add Tenant Isolation Validation to Pipeline Trigger

Modify `validatePipeline()` to require `eventFilter.tenantId` when `trigger.topic` starts with `abl.`. Reject pipeline definitions subscribing to platform event topics without tenant scoping.

### Task 8: Wire Event Emissions into Runtime

Add `eventBus.emit()` calls at 8 integration points: `session.created` in `handler.ts` after DB session created, `session.ended` in `handler.ts` on WS close, `session.handoff` in `routing-executor.ts` after handoff succeeds, `session.escalation` in `routing-executor.ts` after escalation state set, `message.user` in `handler.ts` after message persistence, `message.agent` in `handler.ts` after response finalized, `tool.called` in `reasoning-executor.ts` before tool execution, `tool.completed` in `reasoning-executor.ts` after tool result.

### Task 9: Initialize EventBus at Runtime Startup

Wire EventBus creation in server initialization. Master switch via `EVENT_KAFKA_ENABLED` (default: false). When disabled, EventBus is a no-op. Pass `eventBus` to handlers via dependency injection. Register graceful shutdown hook.

### Task 10: Kafka Topic Creation Script

Add topic creation to existing Kafka init script in `apps/pipeline-docker/`. Create all 8 `abl.*` topics with configured partition counts (3-12 depending on volume). Replication factor: 1 (dev), 3 (production).

### Task 11: Integration Tests

Test EventBus emit -> subscriber called, tenant gating, KafkaSubscriber batching/flushing, dead-letter on Kafka failure, graceful shutdown drain, full end-to-end emit -> Kafka -> pipeline trigger, tenant isolation (two tenants, cross-tenant prevention).

### Task 12: Build, Test, Verify

Full monorepo build, runtime tests, pipeline-engine tests, type check, verify existing tests pass.
