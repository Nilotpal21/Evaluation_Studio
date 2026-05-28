# High-Level Design: Custom External Events

**Feature:** custom-external-events
**Date:** 2026-03-23
**Status:** PLANNED

---

## 1. Architecture Overview

Custom External Events extends the ABL Platform's event system to support tenant-defined event types that bridge external business systems with agent behavior and analytics pipelines. The design introduces 4 new components while extending 3 existing ones.

### Component Diagram

```
External Systems (CRM, ERP, IoT)
        |
        | REST API (POST /custom-events)
        v
+-------------------+      +-----------------------+
| Custom Events API |----->| Event Type Registry   |  (MongoDB)
| (Runtime Route)   |      | (Schema Validation)   |
+-------------------+      +-----------------------+
        |
        | Validated Event
        v
+-------------------+      +-----------------------+
| Runtime Event Bus |----->| Kafka Producer        |  (abl.custom.<name>)
| (extended)        |      | (Pipeline Triggers)   |
+-------------------+      +-----------------------+
        |                           |
        | In-Process Delivery       | Kafka Consumption
        v                           v
+-------------------+      +-----------------------+
| Session Event     |      | PipelineTrigger       |
| Dispatcher        |      | (extended)            |
+-------------------+      +-----------------------+
        |                           |
        v                           v
+-------------------+      +-----------------------+
| RECALL/REMEMBER   |      | Pipeline Run          |
| Execution         |      | Workflow              |
+-------------------+      +-----------------------+
        |
        v
+-------------------+
| ClickHouse Writer |  (custom_events table)
+-------------------+
        |
        v
+-------------------+
| Webhook Delivery  |  (BullMQ async)
| Queue             |
+-------------------+
```

### Key Decisions

| Decision                   | Choice               | Rationale                                                                   |
| -------------------------- | -------------------- | --------------------------------------------------------------------------- |
| Event type storage         | MongoDB              | Consistent with all other project-scoped config (agents, pipelines, creds)  |
| Event payload validation   | Ajv (JSON Schema)    | Industry standard; already used in pipeline-engine config validation        |
| Event delivery to sessions | In-process event bus | Sub-500ms latency requirement; no cross-pod concern for MVP                 |
| Event persistence          | ClickHouse           | Consistent with existing analytics; time-series optimized                   |
| Webhook delivery           | BullMQ queue         | Async, retryable, observable; existing pattern in pipeline-engine           |
| Kafka topic naming         | `abl.custom.<name>`  | Clear namespace separation from built-in `abl.session.*`, `abl.message.*`   |
| Event name namespace       | `custom:<name>`      | Distinct from lifecycle events; matches existing `tool:`, `agent:` patterns |

### Naming Convention Mapping

The same logical event uses different naming conventions in different layers, consistent with how built-in events work:

| Layer                  | Convention          | Example                    | Rationale                                      |
| ---------------------- | ------------------- | -------------------------- | ---------------------------------------------- |
| DSL / RECALL           | `custom:<name>`     | `custom:order.shipped`     | Colon-separated like `agent:X:before`          |
| Event Bus (in-process) | `custom.<name>`     | `custom.order.shipped`     | Dot-separated like `session.ended`             |
| Kafka Topic            | `abl.custom.<name>` | `abl.custom.order.shipped` | Prefixed like `abl.session.ended`              |
| API Request Body       | Plain name          | `order.shipped`            | No prefix; context is the `/custom-events` URL |

Conversion functions:

- API name to lifecycle: `custom:${name}`
- API name to event bus: `custom.${name}`
- API name to Kafka: `abl.custom.${name}`

## 2. Data Model

### 2.1 Custom Event Type (MongoDB)

```typescript
interface CustomEventType {
  _id: string; // Generated UUID
  tenantId: string; // Tenant isolation
  projectId: string; // Project scope
  name: string; // e.g., "order.shipped" -- unique per project
  description: string;
  category: string; // e.g., "commerce", "support", "iot"
  payloadSchema?: object; // JSON Schema for payload validation
  webhookSubscribers?: WebhookSubscriber[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookSubscriber {
  id: string;
  url: string;
  secret: string; // HMAC signing key
  active: boolean;
  createdAt: Date;
}
```

**Indexes:**

- `{ tenantId: 1, projectId: 1, name: 1 }` -- unique compound index
- `{ tenantId: 1, projectId: 1 }` -- list queries

### 2.2 Custom Events (ClickHouse)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.custom_events (
    tenant_id        String,
    project_id       String,
    event_type       LowCardinality(String),
    event_id         String,
    session_id       Nullable(String),
    correlation_id   Nullable(String),
    payload          String,           -- JSON-encoded
    timestamp        DateTime64(3),
    source_ip        Nullable(String),
    webhook_status   Nullable(String)  -- 'pending', 'delivered', 'failed'
)
ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY (tenant_id, toYYYYMM(timestamp))
ORDER BY (tenant_id, project_id, event_type, event_id)
TTL toDateTime(timestamp) + INTERVAL 365 DAY DELETE
```

### 2.3 Extended EventType (Runtime)

```typescript
// In apps/runtime/src/services/event-bus/types.ts
export type EventType =
  | 'session.created'
  | 'session.ended'
  | 'session.handoff'
  | 'session.escalation'
  | 'message.user'
  | 'message.agent'
  | 'tool.called'
  | 'tool.completed'
  | `custom.${string}`; // NEW: custom event namespace
```

## 3. API Design

### 3.1 Custom Event Type CRUD

```
POST   /api/projects/:projectId/custom-event-types
GET    /api/projects/:projectId/custom-event-types
GET    /api/projects/:projectId/custom-event-types/:id
PUT    /api/projects/:projectId/custom-event-types/:id
DELETE /api/projects/:projectId/custom-event-types/:id
```

**Request (POST):**

```json
{
  "name": "order.shipped",
  "description": "Fired when an order ships",
  "category": "commerce",
  "payloadSchema": {
    "type": "object",
    "properties": {
      "orderId": { "type": "string" },
      "carrier": { "type": "string" },
      "trackingUrl": { "type": "string", "format": "uri" }
    },
    "required": ["orderId"]
  }
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "cet-abc123",
    "name": "order.shipped",
    "description": "Fired when an order ships",
    "category": "commerce",
    "kafkaTopic": "abl.custom.order.shipped",
    "createdAt": "2026-03-23T00:00:00Z"
  }
}
```

### 3.2 Custom Event Ingestion

```
POST   /api/projects/:projectId/custom-events
POST   /api/projects/:projectId/custom-events/batch
GET    /api/projects/:projectId/custom-events
```

**Request (POST single):**

```json
{
  "eventType": "order.shipped",
  "sessionId": "sess-xyz",
  "correlationId": "order-123",
  "payload": {
    "orderId": "order-123",
    "carrier": "FedEx",
    "trackingUrl": "https://fedex.com/track/123"
  }
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "eventId": "cevt-1679529600000-a1b2c3"
  }
}
```

### 3.3 Webhook Subscriber Management

```
POST   /api/projects/:projectId/custom-event-types/:id/webhooks
GET    /api/projects/:projectId/custom-event-types/:id/webhooks
DELETE /api/projects/:projectId/custom-event-types/:id/webhooks/:webhookId
```

## 4. Twelve Architectural Concerns

### 4.1 Resource Isolation

- **Tenant isolation:** Every MongoDB query includes `tenantId`. ClickHouse queries filter by `tenant_id`. Event bus delivery gated by tenant subscription.
- **Project isolation:** Event types are scoped to `projectId`. Custom events ingested for project A are never visible in project B.
- **User isolation:** `createdBy` tracked on event types. Deletion requires `project:write` permission.
- Cross-scope access returns **404** (not 403).

### 4.2 Authentication & Authorization

- All routes use `authMiddleware` + `requireProjectScope('projectId')`.
- Event type management requires `project:write` permission.
- Event ingestion requires `project:write` permission (or API key with `events:write` scope).
- Event listing requires `session:read` permission.
- Webhook secret generation uses `crypto.randomBytes(32).toString('hex')`.

### 4.3 Rate Limiting

- Event ingestion: `tenantRateLimit('event_ingestion')` -- 10,000/min per project (configurable).
- Batch endpoint: counts as N events toward rate limit.
- Event type CRUD: standard `tenantRateLimit('request')`.

### 4.4 Validation

- Event type names: Zod schema with `z.string().min(2).max(128).regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/)`.
- Reserved name prefixes: `session`, `agent`, `tool`, `entity`, `step`, `message` -- blocked at creation.
- Payload: Ajv validation against registered JSON Schema (if defined).
- Payload size: 64KB limit enforced via Express body-parser and explicit check.
- IDs: `z.string().min(1)` for projectId, tenantId, eventTypeId (per CLAUDE.md -- never `.cuid()`).

### 4.5 Error Handling

- All API responses use `{ success, data?, error?: { code, message } }` envelope.
- Error codes: `UNKNOWN_EVENT_TYPE`, `PAYLOAD_VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE`, `DUPLICATE_EVENT_TYPE`, `RESERVED_EVENT_NAME`, `RATE_LIMIT_EXCEEDED`.
- ClickHouse write failures: logged + event still returned as accepted (async persistence; fire-and-forget with retry).
- Event bus delivery failures: caught per-subscriber, logged, never propagate.

### 4.6 Observability

- TraceEvents emitted for: event ingestion, schema validation, event bus delivery, RECALL execution, webhook delivery.
- Structured logging via `createLogger('custom-events')`.
- ClickHouse `custom_events` table serves as persistent audit trail.
- Webhook delivery status tracked in ClickHouse (pending/delivered/failed).

### 4.7 Performance

- Event ingestion target: < 100ms p99 API response.
- ClickHouse writes are async (fire-and-forget with in-memory buffer, flushed every 1s or 100 events).
- Event type definitions cached in-memory with 5-min TTL and max 1000 entries per pod.
- Schema validators compiled once and cached (Ajv's compiled validator pattern).
- Batch endpoint uses single ClickHouse insert for all events.

### 4.8 Data Integrity

- Event IDs are generated server-side (timestamp + random) to prevent client-side collisions.
- ClickHouse ReplacingMergeTree deduplicates by event_id on merge.
- MongoDB unique index on `(tenantId, projectId, name)` prevents duplicate event type names.
- Payload schema validation runs before persistence (fail-fast).

### 4.9 Scalability

- Event type registry: MongoDB with indexes; 1000 types/project is well within MongoDB's comfort zone.
- Event ingestion: ClickHouse handles 10K+ inserts/sec natively; async batch writes prevent API blocking.
- Event bus: in-process delivery for MVP; Kafka fan-out for cross-pod delivery (future).
- Webhook delivery: BullMQ queue with configurable concurrency and backoff.

### 4.10 Compliance

- Event payloads may contain PII -- ClickHouse retention TTL (365 days) ensures eventual deletion.
- Right to erasure: deletion cascade deletes from MongoDB (event types) and ClickHouse (events by tenant_id).
- Webhook secrets encrypted at rest in MongoDB using the platform's `encryption_master_key`.
- Audit log entry emitted for event type creation, update, deletion.

### 4.11 Backward Compatibility

- No breaking changes to existing APIs or event types.
- Existing `external-events` route and ClickHouse table remain unchanged.
- Compiler changes are additive (new pattern recognition, no removed patterns).
- Event bus extension is additive (new event types, existing types unaffected).

### 4.12 Failure Modes

| Failure                              | Impact                      | Mitigation                                           |
| ------------------------------------ | --------------------------- | ---------------------------------------------------- |
| MongoDB down                         | Cannot validate event type  | Return 503; events queued in Redis for retry         |
| ClickHouse down                      | Events not persisted        | API still returns success; events buffered in memory |
| Session disconnected during delivery | Event lost for that session | Redis TTL queue (30s); re-deliver on reconnect       |
| Webhook endpoint down                | Webhook not delivered       | BullMQ retry (3 attempts, exponential backoff)       |
| Schema validation OOM (huge schema)  | Worker crash                | Max schema size 32KB; Ajv timeout                    |
| Kafka producer failure               | Pipeline not triggered      | Log error; retry via Restate durable execution       |

## 5. Alternatives Considered

### 5.1 Extend Existing External Events API

**Option:** Add schema validation and event bus delivery to the existing `external-events.ts` route.

**Rejected because:** The existing route is purely an analytics overlay (ClickHouse insert + query). Adding runtime behavior (event bus delivery, RECALL triggering) would violate single responsibility and create a confusing API where the same endpoint both stores analytics events AND triggers agent behavior.

### 5.2 WebSocket-Based Event Delivery

**Option:** Clients push events via WebSocket instead of REST.

**Rejected because:** External systems (CRMs, ERPs) overwhelmingly use REST webhooks for outbound events. Requiring WebSocket connections adds complexity for integrators with no meaningful benefit.

### 5.3 gRPC Event Ingestion

**Option:** Offer gRPC alongside REST for high-throughput event ingestion.

**Deferred:** REST meets the 10K events/min requirement. gRPC can be added later if throughput needs increase significantly.

### 5.4 Event Sourcing Pattern

**Option:** Implement full event sourcing where custom events are the source of truth for agent state.

**Rejected because:** Massive increase in complexity for marginal benefit. Custom events are supplementary signals, not primary state transitions.

## 6. Migration Strategy

No migration needed -- this is a net-new feature. Rollout plan:

1. **Alpha:** API + event bus + compiler support. No UI. Manual testing via curl/Postman.
2. **Beta:** Studio UI + pipeline triggers + webhook delivery. Limited to opt-in tenants.
3. **Stable:** GA for all tenants. Documentation and SDK support.

## 7. Sequence Diagrams

### 7.1 Event Ingestion Flow

```
Client                  Runtime API           EventTypeRegistry    EventBus           ClickHouse
  |                         |                       |                  |                   |
  |-- POST /custom-events ->|                       |                  |                   |
  |                         |-- findOne(type) ------>|                  |                   |
  |                         |<-- schema + config ----|                  |                   |
  |                         |-- validate payload --->|                  |                   |
  |                         |                       |                  |                   |
  |                         |-- emit(custom:name) ------------------>  |                   |
  |                         |                       |                  |-- to subscribers   |
  |                         |                       |                  |                   |
  |                         |-- async insert ------------------------------------------>  |
  |                         |                       |                  |                   |
  |<-- { eventId } ---------|                       |                  |                   |
```

### 7.2 RECALL Execution on Custom Event

```
EventBus              SessionDispatcher      MemoryIntegration      AgentRuntime
  |                         |                       |                     |
  |-- custom:order.shipped->|                       |                     |
  |                         |-- find session ------->                     |
  |                         |-- deliver event ------>|                     |
  |                         |                       |-- match RECALL ----->|
  |                         |                       |   (event matches)   |
  |                         |                       |<-- execute recall ---|
  |                         |                       |   with payload      |
  |                         |                       |-- emit trace ------->|
```
