# EventStore Pipeline Documentation

> **Date:** 2026-02-27
> **Package:** `@abl/eventstore`
> **Status:** Production -- dual-write pipeline active, events stored in ClickHouse

---

## Architecture Overview

```
Runtime Agent Execution
    │
    ▼
trace-emitter.ts (14+ log methods)
    ├── TraceStore.addEvent()         ← legacy path (memory/ClickHouse traces)
    ├── WebSocket.send()              ← real-time debug UI
    └── emitTraceEventAsAnalytics()   ← EventStore dual-write path
              │
              ▼
trace-bridge.ts (12+ per-type data mappers)
    │  Converts runtime trace types → platform event types
    │  Maps camelCase → snake_case fields
    │
    ▼
EventEmitter.emit()
    │  Validates against Zod schema via EventRegistry
    │  Enriches with event_id (ULID), category, timestamp
    │
    ▼
IEventQueue.enqueue()
    ├── DirectQueue    → handler() immediately (default)
    ├── BullMQQueue    → Redis LPUSH → Worker polls → handler()
    ├── KafkaQueue     → Producer.send(topic) → Consumer.eachMessage → handler()
    └── MemoryQueue    → array.push() → flush() drains (tests only)
              │
              ▼
          handler = (event) => store.write(event)
              │
              ▼
ClickHouseEventStore.write()
    │  RowMapper.toRow() — Date→string, bool→UInt8, data→JSON
    │
    ▼
BufferedClickHouseWriter.insert()
    │  buffer.push(row)
    │  if buffer >= 10,000 → flush()
    │  also: setInterval flush every 5s // configurable every 1 sec by default
    │
    ▼
ClickHouse INSERT INTO platform_events FORMAT JSONEachRow
    │  Batched, async, 3 retries + exponential backoff
    │
    ▼
┌──────────────────────────────────────┐
│  platform_events (MergeTree)         │
│  ORDER BY (tenant_id, category,      │
│            event_type, timestamp)    │
└──────────────────────────────────────┘
```

---

## Stage 1: Runtime Emits a Trace Event

When an agent processes a message, the runtime calls methods like `logLLMCall()`, `logAgentEnter()`, etc. Each calls the internal `emit()` function.

**File:** `apps/runtime/src/services/trace-emitter.ts`

```typescript
function emit(event: TraceEvent): TraceEventWithId | undefined {
  const storedEvent: TraceEventWithId = {
    ...event,
    id: crypto.randomUUID(),
    sessionId,
    ...(deploymentId && { deploymentId }),
    ...(environment && { environment }),
    ...(agentVersions && { agentVersions }),
  };

  // 1. Store in TraceStore (legacy path)
  getTraceStore().addEvent(sessionId, storedEvent);

  // 2. Send over WebSocket to debug UI
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'trace_event', sessionId, event: storedEvent }));
  }

  // 3. Dual-write to EventStore (fire-and-forget, non-fatal)
  if (tenantId) {
    loadEventStoreBridge()
      .then((bridge) => {
        if (!bridge) return;
        const eventStore = bridge.getEventStore();
        if (!eventStore) return;
        bridge.emitTraceEventAsAnalytics(eventStore.emitter, {
          event_type: storedEvent.type,
          session_id: sessionId,
          tenant_id: tenantId,
          project_id: projectId,
          agent_name: storedEvent.agentName,
          timestamp: storedEvent.timestamp,
          duration_ms: storedEvent.durationMs,
          data: storedEvent.data || {},
        });
      })
      .catch(() => {
        /* non-fatal */
      });
  }
  return storedEvent;
}
```

### Available Log Methods

| Method                  | Trace Type          | Maps To                                     |
| ----------------------- | ------------------- | ------------------------------------------- |
| `logLLMCall()`          | `llm_call`          | `llm.call.completed` or `llm.call.failed`   |
| `logToolCall()`         | `tool_call`         | `tool.call.completed` or `tool.call.failed` |
| `logDecision()`         | `decision`          | `agent.decision`                            |
| `logConstraintCheck()`  | `constraint_check`  | `agent.constraint.checked`                  |
| `logHandoff()`          | `handoff`           | `agent.handoff`                             |
| `logEscalation()`       | `escalation`        | `agent.escalated`                           |
| `logError()`            | `error`             | (not mapped -- stays in trace system)       |
| `logAgentEnter()`       | `agent_enter`       | `agent.entered`                             |
| `logAgentExit()`        | `agent_exit`        | `agent.exited`                              |
| `logFlowStepEnter()`    | `flow_step_enter`   | `flow.step.entered`                         |
| `logFlowStepExit()`     | `flow_step_exit`    | `flow.step.exited`                          |
| `logFlowTransition()`   | `flow_transition`   | `flow.transition`                           |
| `logDelegateStart()`    | `delegate_start`    | `agent.delegated`                           |
| `logDelegateComplete()` | `delegate_complete` | `agent.delegated`                           |
| `logUserMessage()`      | `user_message`      | `message.user.received`                     |
| `logAgentResponse()`    | `agent_response`    | `message.agent.sent`                        |
| `logSessionUpdated()`   | `session_updated`   | `session.updated`                           |

---

## Stage 2: Trace Bridge Maps to Platform Event

The bridge converts camelCase runtime trace data into Zod-validated platform event schemas.

**File:** `packages/eventstore/src/migration/trace-bridge.ts`

```typescript
export function mapTraceEventToPlatformEvent(traceEvent: TraceEvent): PlatformEvent | null {
  const data = traceEvent.data;
  const durationMs = traceEvent.duration_ms;

  switch (traceEvent.event_type) {
    case 'llm_call': {
      const result = mapLLMCallData(data, durationMs);
      // → 'llm.call.completed' or 'llm.call.failed'
      break;
    }
    case 'tool_call': {
      const result = mapToolCallData(data, durationMs);
      // → 'tool.call.completed' or 'tool.call.failed'
      break;
    }
    case 'agent_enter': // → 'agent.entered'
    case 'agent_exit': // → 'agent.exited'
    case 'handoff': // → 'agent.handoff'
    case 'escalation': // → 'agent.escalated'
    case 'delegate': // → 'agent.delegated'
    case 'decision': // → 'agent.decision'
    case 'constraint_check': // → 'agent.constraint.checked'
    case 'flow_step_enter': // → 'flow.step.entered'
    case 'flow_step_exit': // → 'flow.step.exited'
    case 'flow_transition': // → 'flow.transition'
    case 'session_created': // → 'session.started'
    case 'user_message': // → 'message.user.received'
    case 'agent_response': // → 'message.agent.sent'
    case 'session_updated': // → 'session.updated'
    default:
      return null;
  }

  return {
    event_id: ulid(),
    event_type: platformEventType,
    category: platformEventType.split('.')[0],
    tenant_id: traceEvent.tenant_id,
    project_id: traceEvent.project_id || 'unknown',
    session_id: traceEvent.session_id,
    agent_name: traceEvent.agent_name,
    timestamp: traceEvent.timestamp,
    duration_ms: durationMs,
    has_error: hasError,
    data: mappedData,
  };
}
```

### Per-Type Data Transformers

Each mapper converts camelCase runtime fields to snake_case schema fields:

- `mapLLMCallData()` -- checks for error fields to determine completed vs failed
- `mapToolCallData()` -- checks `success !== false && !error` for completed vs failed
- `mapAgentEnteredData()` -- extracts `{ mode, trigger }`
- `mapAgentExitedData()` -- extracts `{ result, duration_ms }`
- `mapHandoffData()` -- extracts `{ from_agent, to_agent, return_expected }`
- `mapEscalationData()` -- extracts `{ from_agent, reason, priority }`
- `mapDelegateData()` -- extracts `{ from_agent, to_agent, task_summary, success }`
- `mapDecisionData()` -- extracts `{ decision_type, decision, reasoning }`
- `mapConstraintData()` -- extracts `{ constraint_name, passed, violation_type }`
- `mapFlowStepEnteredData()` -- extracts `{ step_name, step_type }`
- `mapFlowStepExitedData()` -- extracts `{ step_name, duration_ms }`
- `mapFlowTransitionData()` -- extracts `{ from_step, to_step, condition }`
- `mapSessionCreatedData()` -- extracts `{ channel, agent_name, deployment_id, resolution_method, caller_identity_tier }`
- `mapUserMessageData()` -- extracts `{ content_length, channel, has_attachments, attachment_count }`
- `mapAgentResponseData()` -- extracts `{ content_length, channel, has_rich_content, duration_ms }`
- `mapSessionUpdatedData()` -- extracts `{ update_source, keys_updated, update_count }`

---

## Stage 3: EventEmitter Validates & Enqueues

**File:** `packages/eventstore/src/emitter/event-emitter.ts`

```typescript
emit(event: unknown): void {
  const platformEvent = event as Partial<PlatformEvent>;

  // Zod validation via EventRegistry
  if (validationEnabled) {
    const validation = this.registry.validate(platformEvent);
    if (!validation.valid) {
      console.warn(`Invalid event: ${platformEvent.event_type} (dropped)`, { errors });
      return; // Drop invalid event -- never block the runtime
    }
  }

  // Enrich with auto-generated fields
  const enriched = {
    ...event,
    event_id: event.event_id || ulid(),
    category: event.category || getCategoryFromEventType(event.event_type),
    timestamp: event.timestamp || new Date(),
  };

  // Enqueue for persistence (non-blocking)
  this.queue.enqueue(enriched);
}
```

---

## Stage 4: Queue Implementations

### DirectQueue (Default -- zero latency)

**File:** `packages/eventstore/src/queues/direct-queue.ts`

```typescript
enqueue(event: unknown): void {
  // Synchronous pass-through -- calls handler immediately
  const result = this.handler(event);
  // Fire-and-forget if async
  if (result instanceof Promise) {
    result.catch((err) => console.error('DirectQueue: Handler error', err));
  }
}
```

### BullMQ Queue (Redis-backed, durable)

**File:** `packages/eventstore/src/queues/bullmq-queue.ts`

```typescript
// Producer: non-blocking enqueue to Redis
enqueue(event: unknown): void {
  this.queue.add('event', event);
}

// Consumer: Worker processes from Redis
this.worker = new Worker(this.queueName, async (job: Job) => {
  await handler(job.data);
}, { connection, concurrency: 10 });
```

Config: exponential backoff (1s base), `removeOnComplete: true`, `removeOnFail: false`.

### Kafka Queue (high-throughput, 100K+ events/sec)

**File:** `packages/eventstore/src/queues/kafka-queue.ts`

```typescript
// Producer: partition by tenant_id for ordered delivery
enqueue(event: unknown): void {
  const key = event.tenant_id; // Partition key
  this.producer.send({
    topic: 'platform-events',
    messages: [{ key, value: JSON.stringify(event) }],
  });
}

// Consumer: parallel processing across partitions
this.consumer.run({
  eachMessage: async ({ message }) => {
    const event = JSON.parse(message.value.toString());
    await handler(event);
  },
  partitionsConsumedConcurrently: 6,
});
```

Producer config: `idempotent: true`, 6 partitions, `eventstore-consumer` group.

### MemoryQueue (testing only)

**File:** `packages/eventstore/src/queues/memory-queue.ts`

Events pushed to array, only processed on `flush()`. Deterministic for tests.

---

## Stage 5: Factory Wires Queue to Store

**File:** `packages/eventstore/src/factory.ts`

```typescript
// Create store (ClickHouse or Memory)
const store =
  backend === 'clickhouse' ? new ClickHouseEventStore(config.clickhouse!) : new MemoryEventStore();

// Create queue (Direct, BullMQ, Kafka, or Memory)
const primaryQueue = createEventQueue(config.queue ?? { type: 'direct' });

// Wire: every dequeued event gets written to the store
primaryQueue.onProcess((event) => store.write(event));

// Create emitter with validation
emitter = new EventEmitter(primaryQueue, eventRegistry, config);
```

With resilience enabled (3-level failover):

```
Level 1: Primary queue (BullMQ/Kafka)
Level 2: Direct fallback queue (in-process)
Level 3: WAL (filesystem write-ahead log)
```

---

## Stage 6: ClickHouseEventStore Writes via BufferedWriter

**File:** `packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts`

```typescript
write(event: unknown): void {
  const platformEvent = event as PlatformEvent;
  const row = this.rowMapper.toRow(platformEvent);
  this.writer.insert(row);  // Push to buffer
}
```

---

## Stage 7: Row Mapper Converts Types

**File:** `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts`

```typescript
toRow(event: PlatformEvent): ClickHouseEventRow {
  return {
    tenant_id: event.tenant_id,
    event_id: event.event_id,
    event_type: event.event_type,
    category: event.category,
    timestamp: this.formatDateTime64(event.timestamp), // "2026-02-28 10:48:25.249"
    has_error: event.has_error ? 1 : 0,                // boolean → UInt8
    data: JSON.stringify(event.data),                   // object → JSON string
    // ... other fields with defaults
  };
}

private formatDateTime64(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
```

---

## Stage 8: BufferedClickHouseWriter Batches & Flushes

**File:** `packages/database/src/clickhouse.ts`

```typescript
insert(row: T): void {
  if (this.buffer.length >= this.maxBufferSize) {  // 100K
    this.buffer.splice(0, this.batchSize);         // Drop oldest to prevent OOM
  }
  this.buffer.push(row);
  if (this.buffer.length >= this.batchSize) {      // 10K
    this.flush();
  }
}

async flush(): Promise<void> {
  const batch = this.buffer.splice(0, this.batchSize);
  await this.client.insert({
    table: 'abl_platform.platform_events',
    values: batch,
    format: 'JSONEachRow',
  });
}

// Also flushes every 5 seconds on a timer
constructor() {
  this.flushTimer = setInterval(() => this.flush(), 5000);
}
```

Retry: 3 attempts, failed batches re-added to front of buffer. After max retries, batch is dropped.

---

## All Event Types and Schemas

### Session Events (`session-events.ts`)

| Event Type           | Data Schema                                                                                                                                                   | PII |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `session.started`    | `{ channel, agent_name, deployment_id, resolution_method: 'new'\|'resumed'\|'artifact', caller_identity_tier: 'anonymous'\|'identified'\|'verified' }`        | No  |
| `session.ended`      | `{ reason: 'completed'\|'timeout'\|'error'\|'user_exit', total_duration_ms, total_turns, total_llm_calls, total_tool_calls, total_tokens?, estimated_cost? }` | No  |
| `session.resumed`    | `{ resolution_method: 'explicit_id'\|'channel_artifact', original_session_age_ms, channel }`                                                                  | No  |
| `session.terminated` | `{ reason: 'stale'\|'expired'\|'over_capacity', inactivity_duration_ms }`                                                                                     | No  |
| `session.updated`    | `{ update_source: 'injection'\|'gather'\|'set'\|'tool_result'\|'handoff', keys_updated: string[], update_count }`                                             | No  |

### Message Events (`message-events.ts`)

| Event Type              | Data Schema                                                         | PII |
| ----------------------- | ------------------------------------------------------------------- | --- |
| `message.user.received` | `{ content_length, channel?, has_attachments?, attachment_count? }` | No  |
| `message.agent.sent`    | `{ content_length, channel?, has_rich_content?, duration_ms }`      | No  |

### LLM Events (`llm-events.ts`)

| Event Type           | Data Schema                                                                                                                                                                                                         | PII |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `llm.call.completed` | `{ model, provider, input_tokens, output_tokens, total_tokens, estimated_cost, latency_ms, streaming_used, tool_call_count?, time_to_first_token_ms?, cache_creation_tokens?, cache_read_tokens?, finish_reason? }` | No  |
| `llm.call.failed`    | `{ model, provider, error_type, error_message, latency_ms, retry_attempt? }`                                                                                                                                        | No  |
| `llm.model.resolved` | `{ requested_model?, resolved_model, resolution_source: 'agent'\|'project'\|'tenant'\|'env' }`                                                                                                                      | No  |

### Tool Events (`tool-events.ts`)

| Event Type            | Data Schema                                                                                              | PII |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --- |
| `tool.call.completed` | `{ tool_name, tool_type?: 'http'\|'lambda'\|'mcp'\|'sandbox', success, latency_ms, result_size_bytes? }` | No  |
| `tool.call.failed`    | `{ tool_name, tool_type?, error_type, error_message, latency_ms }`                                       | No  |
| `tool.call.retried`   | `{ tool_name, attempt, max_retries, delay_ms, reason }`                                                  | No  |
| `tool.error.handled`  | `{ tool_name, error_type, handler_action: 'retry'\|'respond'\|'handoff'\|'backtrack' }`                  | No  |

### Agent Events (`agent-events.ts`)

| Event Type                 | Data Schema                                                                                 | PII |
| -------------------------- | ------------------------------------------------------------------------------------------- | --- |
| `agent.entered`            | `{ mode: 'scripted'\|'reasoning', trigger: 'user_message'\|'handoff'\|'delegate' }`         | No  |
| `agent.exited`             | `{ result: 'completed'\|'handoff'\|'delegate'\|'error', duration_ms }`                      | No  |
| `agent.handoff`            | `{ from_agent, to_agent, return_expected, context_fields_passed? }`                         | No  |
| `agent.escalated`          | `{ from_agent, reason, priority: 'low'\|'medium'\|'high'\|'critical', user_message_count }` | No  |
| `agent.delegated`          | `{ from_agent, to_agent, task_summary, success, duration_ms }`                              | No  |
| `agent.fanout.completed`   | `{ from_agent, target_count, success_count, failure_count, total_duration_ms }`             | No  |
| `agent.decision`           | `{ decision_type: 'routing'\|'escalation'\|'constraint', decision, reasoning? }`            | No  |
| `agent.constraint.checked` | `{ constraint_name, passed, violation_type?, handler_action? }`                             | No  |

### Gather Events (`gather-events.ts`)

| Event Type                   | Data Schema                                                                              | PII |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --- |
| `gather.field.extracted`     | `{ step_name, field_name, extraction_method: 'llm'\|'pattern', latency_ms }`             | Yes |
| `gather.field.validated`     | `{ field_name, passed, validation_rule, error_message? }`                                | No  |
| `gather.completed`           | `{ step_name, fields_collected, duration_ms, clarification_count, extraction_attempts }` | No  |
| `gather.correction.detected` | `{ field_name, original_value, corrected_value }`                                        | Yes |

### Flow Events (`flow-events.ts`)

| Event Type          | Data Schema                                                        | PII |
| ------------------- | ------------------------------------------------------------------ | --- |
| `flow.step.entered` | `{ step_name, step_type?: 'gather'\|'call'\|'respond'\|'branch' }` | No  |
| `flow.step.exited`  | `{ step_name, duration_ms, next_step? }`                           | No  |
| `flow.transition`   | `{ from_step, to_step, condition?, reason? }`                      | No  |

### Channel Events (`channel-events.ts`)

| Event Type                  | Data Schema                                                                        | PII |
| --------------------------- | ---------------------------------------------------------------------------------- | --- |
| `channel.message.received`  | `{ channel_type, connection_id, deduped, processing_duration_ms, status }`         | No  |
| `channel.message.sent`      | `{ channel_type, role, has_pii }`                                                  | No  |
| `channel.webhook.delivered` | `{ subscription_id, event_type, http_status, latency_ms, status, retry_attempt? }` | No  |

### Deployment Events (`deployment-events.ts`)

| Event Type               | Data Schema                                                    | PII |
| ------------------------ | -------------------------------------------------------------- | --- |
| `deployment.created`     | `{ environment, entry_agent, agent_count, created_by }`        | No  |
| `deployment.retired`     | `{ draining_started_at, linked_channel_count, retired_by }`    | No  |
| `deployment.rolled_back` | `{ previous_deployment_id, channels_updated, rolled_back_by }` | No  |

### Auth Events (`auth-events.ts`)

| Event Type           | Data Schema                                            | PII |
| -------------------- | ------------------------------------------------------ | --- |
| `auth.login`         | `{ auth_type: 'dev_login'\|'oauth'\|'api_key', role }` | Yes |
| `auth.token.created` | `{ token_type: 'access'\|'sdk', expires_in }`          | No  |

### Evaluation Events (`evaluation-events.ts`)

| Event Type                      | Data Schema                                                                                                                                                                               | PII |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `evaluation.started`            | `{ evaluation_id, evaluator_type, evaluator_name, target_session_id, sampling_strategy?, criteria_count? }`                                                                               | No  |
| `evaluation.completed`          | `{ evaluation_id, evaluator_type, evaluator_name, target_session_id, scores, composite_score?, reasoning?, confidence?, latency_ms, model_used?, tokens_used?, estimated_cost? }`         | No  |
| `evaluation.failed`             | `{ evaluation_id, evaluator_type, evaluator_name, target_session_id, error_type, error_message, latency_ms, retry_attempt? }`                                                             | No  |
| `evaluation.batch.completed`    | `{ batch_id, total_evaluations, succeeded, failed, skipped, total_duration_ms, total_cost?, evaluator_names }`                                                                            | No  |
| `evaluation.threshold.violated` | `{ evaluator_name, metric_name, threshold, actual_value, direction, severity, window_minutes, sample_size }`                                                                              | No  |
| `evaluation.quality.scored`     | `{ evaluation_id, target_session_id, resolution_quality, response_accuracy, helpfulness, coherence, professionalism, safety, pii_handling, composite_cx_score, reasoning?, model_used? }` | No  |
| `evaluation.sentiment.analyzed` | `{ evaluation_id, target_session_id, overall_sentiment, sentiment_score, trajectory, frustration_detected, pivot_turn?, turn_scores? }`                                                   | No  |
| `evaluation.summary.generated`  | `{ evaluation_id, target_session_id, executive_summary, key_topics, actions_taken, outcome, next_steps?, risk_flags?, model_used?, tokens_used? }`                                        | Yes |

### Feedback Events (`feedback-events.ts`)

| Event Type           | Data Schema                                                                                   | PII |
| -------------------- | --------------------------------------------------------------------------------------------- | --- |
| `feedback.submitted` | `{ rating_type: 'thumbs'\|'star'\|'text', rating_value, target_message_id?, feedback_text? }` | Yes |

---

## Event Categories

| Category     | Prefix               | Description                       |
| ------------ | -------------------- | --------------------------------- |
| `session`    | `session.*`          | Session lifecycle                 |
| `message`    | `message.*`          | User messages and agent responses |
| `llm`        | `llm.*`              | LLM calls                         |
| `tool`       | `tool.*`             | Tool execution                    |
| `agent`      | `agent.*`            | Agent routing and orchestration   |
| `gather`     | `gather.*`           | Data collection and extraction    |
| `flow`       | `flow.*`             | Scripted flow execution           |
| `channel`    | `channel.*`          | External channel messaging        |
| `deployment` | `deployment.*`       | Deployment lifecycle              |
| `search`     | `search.*`           | Search operations                 |
| `voice`      | `voice.*`            | Voice interactions                |
| `audit`      | `auth.*` / `audit.*` | Authentication and audit          |
| `evaluation` | `evaluation.*`       | Quality evaluation                |
| `feedback`   | `feedback.*`         | User feedback and ratings         |
| `system`     | (default)            | System events                     |

---

## ClickHouse Table Schema

```sql
CREATE TABLE abl_platform.platform_events (
    tenant_id      String,
    project_id     String,
    event_id       String,
    event_type     String,
    category       LowCardinality(String),
    timestamp      DateTime64(3),
    session_id     String,
    agent_name     String,
    deployment_id  String,
    channel        String,
    actor_id       String,
    actor_type     LowCardinality(String),
    duration_ms    UInt32,
    has_error      UInt8,
    error_message  String,
    error_type     String,
    data           String,        -- JSON serialized event data
    metadata       String         -- JSON serialized metadata
)
ENGINE = MergeTree()
ORDER BY (tenant_id, category, event_type, timestamp)
TTL timestamp + INTERVAL 365 DAY
SETTINGS index_granularity = 8192
```

---

## Configuration

The eventstore is configured via the factory:

```typescript
const services = createEventStore({
  mode: 'embedded', // 'embedded' | 'remote' | 'service'
  backend: 'clickhouse', // 'clickhouse' | 'memory'
  queue: { type: 'direct' }, // 'direct' | 'bullmq' | 'kafka' | 'memory'
  clickhouse: { client },
  validation: { enabled: true, strictMode: false },
  resilience: {
    enabled: false,
    wal: { directory: '/tmp/eventstore-wal' },
  },
});
```

Environment variables:

- `EVENTSTORE_ENABLED` -- enable/disable (default: true)
- `EVENTSTORE_MODE` -- embedded/remote/service
- `EVENTSTORE_BACKEND` -- clickhouse/memory
- `EVENTSTORE_RESILIENCE_ENABLED` -- enable WAL failover
- `EVENTSTORE_WAL_DIR` -- WAL directory path
