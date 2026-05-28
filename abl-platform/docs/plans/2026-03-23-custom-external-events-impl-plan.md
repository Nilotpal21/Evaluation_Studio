# LLD + Implementation Plan: Custom External Events

**Feature:** custom-external-events
**Date:** 2026-03-23
**Status:** PLANNED
**HLD:** `docs/specs/custom-external-events.hld.md`
**Feature Spec:** `docs/features/custom-external-events.md`
**Test Spec:** `docs/testing/custom-external-events.md`

---

## Phase 1: Event Type Registry + Ingestion API (P0 Core)

**Goal:** Custom event types can be defined per project, and events can be ingested with schema validation.

### Exit Criteria

- [ ] MongoDB model for `CustomEventType` with unique compound index `(tenantId, projectId, name)`.
- [ ] CRUD routes at `/api/projects/:projectId/custom-event-types` with auth, project isolation, and validation.
- [ ] Ingestion route at `/api/projects/:projectId/custom-events` with Ajv schema validation.
- [ ] Batch ingestion at `/api/projects/:projectId/custom-events/batch` (max 100).
- [ ] ClickHouse `custom_events` table created via `init-analytics-tables.ts`.
- [ ] Event name validation: lowercase dot-separated, reserved prefix blocking.
- [ ] Payload size limit: 64KB enforced.
- [ ] `pnpm build --filter=runtime` succeeds.
- [ ] Unit tests for name validation, ID generation, schema compilation pass.
- [ ] Integration tests for CRUD lifecycle, schema validation, payload size pass.

### Task 1.1: MongoDB Schema for CustomEventType

**Files:**

- Create: `apps/runtime/src/schemas/custom-event-type.schema.ts`

**Details:**

```typescript
import { Schema, model, type Document } from 'mongoose';

export interface ICustomEventType extends Document {
  tenantId: string;
  projectId: string;
  name: string; // e.g., "order.shipped"
  description: string;
  category: string;
  payloadSchema?: Record<string, unknown>; // JSON Schema
  webhookSubscribers: Array<{
    id: string;
    url: string;
    secret: string; // encrypted
    active: boolean;
    createdAt: Date;
  }>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Unique compound index: (tenantId, projectId, name)
// List index: (tenantId, projectId)
```

### Task 1.2: Event Name Validation Utility

**Files:**

- Create: `apps/runtime/src/services/custom-events/validation.ts`
- Test: `apps/runtime/src/__tests__/custom-event-validation.test.ts`

**Details:**

```typescript
// Name pattern: ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$
// Min length: 2, Max length: 128
// Reserved prefixes: session, agent, tool, entity, step, message
// Returns: { valid: boolean, error?: string }
export function validateEventTypeName(name: string): {
  valid: boolean;
  error?: string;
};

// Payload size check
const MAX_PAYLOAD_SIZE_BYTES = 64 * 1024;
export function validatePayloadSize(payload: unknown): {
  valid: boolean;
  error?: string;
};
```

### Task 1.3: Ajv Schema Validator Service

**Files:**

- Create: `apps/runtime/src/services/custom-events/schema-validator.ts`
- Test: `apps/runtime/src/__tests__/custom-event-schema-validator.test.ts`

**Details:**

- Compile JSON Schema with Ajv on first use, cache compiled validators.
- Cache: `Map<string, ValidateFunction>` with max 1000 entries, LRU eviction.
- Max schema size: 32KB.
- Returns `{ valid: boolean, errors?: string[] }`.

### Task 1.4: Custom Event Type CRUD Routes

**Files:**

- Create: `apps/runtime/src/routes/custom-event-types.ts`
- Modify: `apps/runtime/src/server.ts` (mount route)

**Details:**

- Uses `createOpenAPIRouter` pattern (same as `external-events.ts`).
- Auth: `authMiddleware` + `requireProjectScope('projectId')`.
- Permission: `project:write` for create/update/delete, `session:read` for list/get.
- All queries include `tenantId` and `projectId`.
- Delete with `?force=true` bypasses reference check; without it, check for pipeline triggers referencing the event type.
- Zod validation: `z.string().min(1)` for IDs (never `.cuid()`).

### Task 1.5: Custom Event Ingestion Route

**Files:**

- Create: `apps/runtime/src/routes/custom-events.ts`
- Modify: `apps/runtime/src/server.ts` (mount route)

**Details:**

- `POST /` -- single event ingestion:
  1. Validate `eventType` exists in registry (MongoDB lookup, cached).
  2. Validate `payload` against event type's JSON Schema (if defined).
  3. Validate payload size <= 64KB.
  4. Generate `eventId`: `cevt-<timestamp>-<random6>`.
  5. Async write to ClickHouse `custom_events` table.
  6. Return `{ success: true, data: { eventId } }`.

- `POST /batch` -- batch ingestion (max 100):
  1. Validate all events before inserting (fail-fast).
  2. Single ClickHouse batch insert.

- `GET /` -- list events with filters (eventType, days, sessionId).

### Task 1.6: ClickHouse Table Definition

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`

**Details:**

Add `custom_events` table and daily materialized view to the `ANALYTICS_TABLES` array:

```sql
CREATE TABLE IF NOT EXISTS ${DATABASE}.custom_events (
    tenant_id        String,
    project_id       String,
    event_type       LowCardinality(String),
    event_id         String,
    session_id       Nullable(String),
    correlation_id   Nullable(String),
    payload          String,
    timestamp        DateTime64(3),
    source_ip        Nullable(String),
    webhook_status   Nullable(String)
)
ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY (tenant_id, toYYYYMM(timestamp))
ORDER BY (tenant_id, project_id, event_type, event_id)
TTL toDateTime(timestamp) + INTERVAL 365 DAY DELETE
```

---

## Phase 2: Event Bus Extension + RECALL Integration (P0 Core)

**Goal:** Custom events flow through the Runtime Event Bus and trigger RECALL instructions in active sessions.

### Exit Criteria

- [ ] `EventType` union extended with `custom.${string}` pattern.
- [ ] `EventSubscriptionRegistry` supports custom event type subscriptions.
- [ ] Custom events emitted to event bus from ingestion route.
- [ ] Compiler `recall-validation.ts` accepts `custom:*` patterns.
- [ ] `event-matching.ts` matches `custom:*` patterns with wildcards.
- [ ] `event-detector.ts` exports `resolveCustomEvents()`.
- [ ] `memory-integration.ts` delivers custom events to RECALL executor.
- [ ] Session-targeted delivery when `sessionId` is provided.
- [ ] Integration tests for event bus delivery and RECALL execution pass.

### Task 2.1: Extend EventType and Event Bus Types

**Files:**

- Modify: `apps/runtime/src/services/event-bus/types.ts`

**Details:**

```typescript
// Add to EventType union:
| `custom.${string}`;

// Add to EVENT_TYPES array:
// (Cannot enumerate custom types statically -- the isSubscribed() check
// in EventSubscriptionRegistry already handles string matching)
```

Update `eventTypeToTopic()` to handle custom events:

```typescript
export function eventTypeToTopic(type: string): string {
  return `${EVENT_TOPIC_PREFIX}.${type}`;
}
// custom.order.shipped -> abl.custom.order.shipped
```

### Task 2.2: Extend Compiler Event Validation

**Files:**

- Modify: `packages/compiler/src/platform/ir/recall-validation.ts`
- Modify: `packages/compiler/src/platform/constants.ts`
- Test: `packages/compiler/src/__tests__/compiler-recall-validation.test.ts`

**Details:**

Add `custom:*` to `LIFECYCLE_PATTERNS`:

```typescript
// In constants.ts, add to LIFECYCLE_PATTERNS array:
/^custom:[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/,
/^custom:\*$/,
```

In `recall-validation.ts`, recognize `custom:` prefix before the "unrecognized event" fallback.

### Task 2.3: Extend Event Matching

**Files:**

- Modify: `apps/runtime/src/services/execution/event-matching.ts`
- Test: `apps/runtime/src/__tests__/event-matching-custom.test.ts`

**Details:**

The existing `eventMatches()` function already supports wildcard matching (`*`). Verify that `custom:order.*` matches `custom:order.shipped`. The existing regex-based wildcard should handle this, but add explicit tests.

### Task 2.4: Custom Event Detector

**Files:**

- Modify: `apps/runtime/src/services/execution/event-detector.ts`

**Details:**

```typescript
/**
 * Resolve custom event names for the event matching system.
 * Maps ingested custom event name to the lifecycle event pattern.
 */
export function resolveCustomEvents(eventName: string): string[] {
  return [`custom:${eventName}`, 'custom:*'];
}
```

### Task 2.5: Session Event Dispatcher

**Files:**

- Create: `apps/runtime/src/services/custom-events/session-dispatcher.ts`
- Modify: `apps/runtime/src/routes/custom-events.ts` (wire dispatcher)

**Details:**

When `sessionId` is provided in the ingestion request:

1. Look up the active session from Redis session store (`apps/runtime/src/services/session/redis-session-store.ts`).
2. If session is active on the current pod (in-memory session map), deliver directly via `memory-integration.ts`.
3. If session is on another pod (or Redis-only), enqueue a custom event message via the inbound worker pattern (`apps/runtime/src/services/queues/inbound-worker.ts`) -- this is the same mechanism used for async HTTP channel messages.
4. The inbound worker delivers to the session's agent, triggering matching RECALL instructions.
5. Event payload is available as `$event.payload` in RECALL context.
6. If session is not found (expired or invalid), return 404 with error code `SESSION_NOT_FOUND`.

When `sessionId` is omitted: Emit to event bus only (for pipeline triggers and analytics). No session delivery. The event is persisted to ClickHouse regardless.

### Task 2.6: Wire Event Bus Emission in Ingestion Route

**Files:**

- Modify: `apps/runtime/src/routes/custom-events.ts`

**Details:**

After successful validation and before ClickHouse write:

```typescript
const platformEvent: PlatformEvent<string, unknown> = {
  eventId,
  type: `custom.${eventType}`,
  tenantId,
  projectId,
  sessionId: sessionId ?? '',
  agentName: '',
  channel: 'api',
  timestamp: new Date().toISOString(),
  payload,
};
eventBus.emit(platformEvent);
```

---

## Phase 3: Pipeline Trigger Extension (P1)

**Goal:** Pipelines can trigger on custom event Kafka topics.

### Exit Criteria

- [ ] Trigger definitions support `abl.custom.*` Kafka topics.
- [ ] `PipelineTrigger.handleEvent` matches custom event topics.
- [ ] `EventSubscriptionRegistry` sync includes custom event subscriptions.
- [ ] Integration test: pipeline run created when custom event ingested.

### Task 3.1: Extend Trigger Registry

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/trigger-registry.ts`
- Modify: `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json`

**Details:**

Add a `custom-event` trigger definition template:

```json
{
  "id": "custom-event",
  "type": "kafka",
  "kafkaTopic": "abl.custom.*",
  "category": "custom",
  "label": "Custom Event",
  "description": "Trigger when a custom external event is received. Specify the event type in eventFilter.",
  "inputSchema": {
    "required": ["tenantId", "projectId"],
    "properties": {
      "tenantId": {
        "type": "string",
        "description": "Tenant ID from event"
      },
      "projectId": {
        "type": "string",
        "description": "Project ID from event"
      },
      "eventType": {
        "type": "string",
        "description": "Custom event type name"
      }
    }
  }
}
```

### Task 3.2: Extend PipelineTrigger.handleEvent

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`

**Details:**

The existing `getCachedDefinitions()` query already handles `trigger.kafkaTopic` matching. Custom events published to `abl.custom.<name>` will match pipeline definitions that specify that exact topic. No changes needed to the query logic -- only ensure the topic naming is consistent.

Verify that `resolveKafkaTopic()` correctly maps custom event types:

```typescript
// 'custom.order.shipped' -> 'abl.custom.order.shipped' (already works via prefix logic)
```

### Task 3.3: Subscription Registry Sync for Custom Events

**Files:**

- Modify: `apps/runtime/src/repos/pipeline-repo.ts` (or equivalent sync function)

**Details:**

The sync function that populates `EventSubscriptionRegistry` must include custom event types from tenant pipelines. The existing sync already queries `supportedTriggers.kafkaTopic` -- custom event topics (`abl.custom.*`) will be included automatically if pipelines reference them.

---

## Phase 4: Studio UI (P1)

**Goal:** Studio provides a management interface for custom event types and an event log viewer.

### Exit Criteria

- [ ] "Events" section in Studio sidebar under project navigation.
- [ ] Event type management page: CRUD with schema editor.
- [ ] Event log page: filterable list with payload inspection.
- [ ] API integration via SWR hooks.

### Task 4.1: API Hooks

**Files:**

- Create: `apps/studio/src/hooks/useCustomEventTypes.ts`
- Create: `apps/studio/src/hooks/useCustomEvents.ts`

**Details:**

SWR hooks for fetching/mutating custom event types and events:

```typescript
export function useCustomEventTypes(projectId: string);
export function useCreateCustomEventType(projectId: string);
export function useDeleteCustomEventType(projectId: string);
export function useCustomEvents(projectId: string, filters?: EventFilters);
```

### Task 4.2: Event Type Management Page

**Files:**

- Create: `apps/studio/src/app/(dashboard)/projects/[projectId]/events/page.tsx`
- Create: `apps/studio/src/components/events/EventTypeList.tsx`
- Create: `apps/studio/src/components/events/EventTypeCreateDialog.tsx`
- Create: `apps/studio/src/components/events/EventTypeSchemaEditor.tsx`

**Details:**

- List view with columns: Name, Category, Description, Created, Actions.
- Create dialog with form: name (validated), description, category (dropdown), payload schema (JSON editor).
- Edit inline or via dialog.
- Delete with confirmation + warning if referenced.

### Task 4.3: Event Log Page

**Files:**

- Create: `apps/studio/src/app/(dashboard)/projects/[projectId]/events/log/page.tsx`
- Create: `apps/studio/src/components/events/EventLog.tsx`
- Create: `apps/studio/src/components/events/EventPayloadViewer.tsx`

**Details:**

- Filterable table: event type, date range, session ID, correlation ID.
- Click row to expand payload JSON viewer.
- Auto-refresh with polling interval.

### Task 4.4: Sidebar Navigation

**Files:**

- Modify: `apps/studio/src/components/layout/Sidebar.tsx` (or equivalent navigation component)

**Details:**

Add "Events" link under the project navigation section, between "Pipelines" and "Settings" (or similar logical position). Use appropriate icon from Lucide.

---

## Phase 5: Webhook Delivery (P2)

**Goal:** Custom events can be forwarded to external webhook subscribers with HMAC signing and retry.

### Exit Criteria

- [ ] Webhook subscriber CRUD on event type.
- [ ] BullMQ queue for async webhook delivery.
- [ ] HMAC-SHA256 signing with per-subscriber secret.
- [ ] 3 retries with exponential backoff.
- [ ] Delivery status tracked in ClickHouse.

### Task 5.1: Webhook Delivery Service

**Files:**

- Create: `apps/runtime/src/services/custom-events/webhook-delivery.ts`

**Details:**

```typescript
export class WebhookDeliveryService {
  // Enqueue webhook delivery job to BullMQ
  async enqueueDelivery(event: CustomEvent, subscriber: WebhookSubscriber): Promise<void>;

  // Process delivery job (called by BullMQ worker)
  async processDelivery(job: Job): Promise<void>;

  // Sign payload with HMAC-SHA256
  private signPayload(payload: string, secret: string): string;
}
```

- HTTP POST to subscriber URL with JSON body.
- Headers: `Content-Type: application/json`, `X-Signature-256: sha256=<hmac>`, `X-Event-Type: <type>`, `X-Event-Id: <id>`.
- Retry: 3 attempts, backoff `[10s, 60s, 300s]`.
- Circuit breaker: after 5 consecutive failures, pause deliveries for 5 min.

### Task 5.2: Webhook Subscriber Routes

**Files:**

- Add to: `apps/runtime/src/routes/custom-event-types.ts`

**Details:**

Nested routes under event type:

```
POST   /api/projects/:projectId/custom-event-types/:id/webhooks
GET    /api/projects/:projectId/custom-event-types/:id/webhooks
DELETE /api/projects/:projectId/custom-event-types/:id/webhooks/:webhookId
```

Secret generated server-side, returned once on creation, then encrypted at rest.

### Task 5.3: Wire Webhook Delivery to Ingestion

**Files:**

- Modify: `apps/runtime/src/routes/custom-events.ts`

**Details:**

After successful ingestion, check event type for active webhook subscribers. Enqueue delivery jobs for each subscriber.

---

## Wiring Checklist

This checklist ensures all components are properly connected (addresses the "wiring gap" pattern).

- [ ] `custom-event-types.ts` route imported and mounted in `server.ts`.
- [ ] `custom-events.ts` route imported and mounted in `server.ts`.
- [ ] ClickHouse `custom_events` table added to `init-analytics-tables.ts`.
- [ ] `LIFECYCLE_PATTERNS` in `constants.ts` updated with `custom:*` pattern.
- [ ] `recall-validation.ts` recognizes `custom:` prefix.
- [ ] `event-detector.ts` exports `resolveCustomEvents()`.
- [ ] `event-matching.ts` tested with `custom:*` patterns.
- [ ] `memory-integration.ts` wired to call `resolveCustomEvents()` on event delivery.
- [ ] `EventType` union in `types.ts` includes `custom.${string}`.
- [ ] Event bus emission wired in `custom-events.ts` ingestion handler.
- [ ] Session dispatcher wired for `sessionId`-targeted delivery.
- [ ] Trigger definitions JSON updated with custom-event template.
- [ ] Studio sidebar updated with Events link.
- [ ] Studio event type hooks created and used in page components.
- [ ] Webhook delivery service created and wired to BullMQ.
- [ ] Webhook subscriber routes added to custom-event-types.ts.

## Risk Mitigations

| Risk                                 | Phase | Mitigation                                                |
| ------------------------------------ | ----- | --------------------------------------------------------- |
| Event type cache inconsistency       | 1     | 5-min TTL; invalidate on write; max 1000 entries with LRU |
| ClickHouse write failure             | 1     | Async write; retry queue; API returns success regardless  |
| Session not found for targeted event | 2     | Return 404 with clear error; log for debugging            |
| Pipeline trigger topic mismatch      | 3     | Explicit test for topic naming convention                 |
| Studio schema editor UX complexity   | 4     | Start with JSON textarea; upgrade to visual editor later  |
| Webhook delivery DDoS on subscriber  | 5     | Circuit breaker; rate limit per subscriber; max 3 retries |

## Estimated Effort

| Phase     | Description                     | Estimate       |
| --------- | ------------------------------- | -------------- |
| 1         | Event Type Registry + Ingestion | 3-4 days       |
| 2         | Event Bus + RECALL Integration  | 2-3 days       |
| 3         | Pipeline Trigger Extension      | 1-2 days       |
| 4         | Studio UI                       | 3-4 days       |
| 5         | Webhook Delivery                | 2-3 days       |
| **Total** |                                 | **11-16 days** |
