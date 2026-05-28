# Test Spec: Custom External Events

**Feature:** custom-external-events
**Date:** 2026-03-23
**Status:** PLANNED

---

## 1. Test Strategy

Custom External Events touches 5 packages: `apps/runtime` (API + event bus), `packages/compiler` (event validation), `packages/pipeline-engine` (triggers), `apps/studio` (UI), and `packages/database` (ClickHouse schema). Testing must cover the full event lifecycle: registration, ingestion, bus delivery, RECALL execution, pipeline triggering, and webhook fan-out.

### Test Layers

| Layer       | Scope                                         | Count | Mock Policy                                         |
| ----------- | --------------------------------------------- | ----- | --------------------------------------------------- |
| Unit        | Schema validation, event matching, name rules | 15+   | Pure functions, no mocks                            |
| Integration | API + MongoDB + event bus wiring              | 10+   | Real Express + MongoDB; mock ClickHouse and Kafka   |
| E2E         | Full HTTP API lifecycle                       | 10+   | Real servers, real middleware, no mocks of codebase |

## 2. E2E Test Scenarios

All E2E tests start real Express servers on random ports with full middleware chain (auth, rate limiting, tenant isolation, project permission).

### E2E-1: Custom Event Type CRUD Lifecycle

**Goal:** Verify full create/read/update/delete lifecycle for custom event types.

**Steps:**

1. `POST /api/projects/:projectId/custom-event-types` with `{ name: "order.shipped", description: "Order shipped event", category: "commerce", payloadSchema: { type: "object", properties: { orderId: { type: "string" }, carrier: { type: "string" } }, required: ["orderId"] } }` -- expect 201 with event type ID.
2. `GET /api/projects/:projectId/custom-event-types` -- expect array containing the created type.
3. `GET /api/projects/:projectId/custom-event-types/:id` -- expect full type with schema.
4. `PUT /api/projects/:projectId/custom-event-types/:id` with updated description -- expect 200.
5. `DELETE /api/projects/:projectId/custom-event-types/:id` -- expect 200.
6. `GET /api/projects/:projectId/custom-event-types/:id` -- expect 404.

**Assertions:** Each step returns `{ success: true/false }` envelope. Tenant isolation enforced (cross-tenant GET returns 404).

### E2E-2: Custom Event Ingestion with Schema Validation

**Goal:** Verify event ingestion validates payload against registered schema.

**Steps:**

1. Register event type `payment.failed` with schema `{ type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount"] }`.
2. `POST /api/projects/:projectId/custom-events` with valid payload `{ eventType: "payment.failed", payload: { amount: 99.99, currency: "USD" } }` -- expect 200 with eventId.
3. `POST /api/projects/:projectId/custom-events` with invalid payload `{ eventType: "payment.failed", payload: { currency: "USD" } }` (missing required `amount`) -- expect 400 with validation error.
4. `POST /api/projects/:projectId/custom-events` with unregistered event type `foo.bar` -- expect 400 with "unknown event type" error.

**Assertions:** Valid events return eventId. Invalid payloads return specific validation error codes.

### E2E-3: Tenant and Project Isolation

**Goal:** Verify events are fully isolated by tenant and project.

**Steps:**

1. Register event type `test.event` in project A (tenant 1).
2. Ingest event in project A.
3. Attempt to list events from project B (same tenant) -- expect empty list.
4. Attempt to list events from project A (different tenant) -- expect 404.
5. Attempt to ingest event with project A's event type in project B -- expect 400 (type not registered).

**Assertions:** Cross-project and cross-tenant access returns 404 or empty results. No data leakage.

### E2E-4: Session-Targeted Event Delivery

**Goal:** Verify custom events reach the correct active session's agent.

**Steps:**

1. Register event type `appointment.reminder`.
2. Start a session (via REST chat endpoint or WebSocket).
3. `POST /api/projects/:projectId/custom-events` with `{ eventType: "appointment.reminder", sessionId: "<session-id>", payload: { time: "2pm", doctor: "Dr. Smith" } }`.
4. Verify the session received the event (check trace events or session history for RECALL execution).

**Assertions:** Event is delivered only to the targeted session. Event payload is accessible in the RECALL context.

### E2E-5: Event Ingestion Rate Limiting

**Goal:** Verify rate limiting prevents abuse.

**Steps:**

1. Register event type `rate.test`.
2. Send 100 events in rapid succession.
3. Verify that after the rate limit threshold, subsequent requests return 429.

**Assertions:** Rate limit headers present. 429 response includes retry-after.

### E2E-6: Batch Event Ingestion

**Goal:** Verify batch endpoint processes multiple events atomically.

**Steps:**

1. Register event types `batch.a` and `batch.b`.
2. `POST /api/projects/:projectId/custom-events/batch` with array of 5 valid events.
3. Verify all 5 events are persisted.
4. `POST /api/projects/:projectId/custom-events/batch` with 1 valid + 1 invalid event -- expect 400, no events persisted (atomic).

**Assertions:** Batch is all-or-nothing. Count matches.

### E2E-7: Event Type Name Validation

**Goal:** Verify event type name constraints.

**Steps:**

1. Attempt to create event type with name `session.start` (reserved built-in prefix) -- expect 400.
2. Attempt to create event type with name `Order.Shipped` (uppercase) -- expect 400.
3. Attempt to create event type with name `a` (too short) -- expect 400.
4. Create event type with name `my.custom.event.v2` -- expect 201.
5. Attempt to create duplicate name in same project -- expect 409.

**Assertions:** Name validation rules enforced. Reserved names blocked.

### E2E-8: Pipeline Trigger on Custom Event

**Goal:** Verify a pipeline triggers when a custom event is ingested.

**Steps:**

1. Register event type `order.completed`.
2. Create a pipeline with trigger `{ type: "kafka", kafkaTopic: "abl.custom.order.completed" }`.
3. Ingest a `order.completed` event.
4. Verify a pipeline run was created with the event payload as input.

**Assertions:** Pipeline run record exists with correct input. Trigger ID matches.

### E2E-9: Webhook Fan-Out Delivery

**Goal:** Verify webhook subscribers receive events with HMAC signature.

**Steps:**

1. Register event type `order.placed`.
2. Register a webhook subscriber with URL pointing to a test HTTP server.
3. Ingest an `order.placed` event.
4. Verify the test server received the webhook with correct payload and valid `X-Signature-256` header.
5. Verify retry on first delivery failure (test server returns 500, then 200).

**Assertions:** Webhook delivered with HMAC signature. Retry logic works. Delivery status visible in event log.

### E2E-10: ClickHouse Persistence and Query

**Goal:** Verify events are persisted to ClickHouse and queryable.

**Steps:**

1. Register and ingest 3 events of different types.
2. `GET /api/projects/:projectId/custom-events?eventType=order.shipped` -- expect filtered results.
3. `GET /api/projects/:projectId/custom-events?days=1` -- expect all 3 events.
4. Verify each event has correct tenant_id, project_id, event_type, payload.

**Assertions:** ClickHouse data matches ingested events. Filtering works correctly.

## 3. Integration Test Scenarios

### INT-1: Event Bus Extension for Custom Events

**Goal:** Verify the RuntimeEventBus delivers `custom:*` events to subscribers.

**Setup:** Real RuntimeEventBus + EventSubscriptionRegistry. Register tenant subscription for `custom:order.shipped`.

**Steps:**

1. Emit a `custom:order.shipped` event via the event bus.
2. Verify subscriber received the event with correct envelope fields.
3. Emit `custom:order.shipped` for a tenant without subscription -- verify subscriber NOT called.

**Assertions:** Subscription gating works for custom event types. Event envelope is complete.

### INT-2: Compiler RECALL Validation for Custom Events

**Goal:** Verify the compiler accepts `custom:*` patterns without warnings.

**Setup:** Compiler with agent IR containing RECALL instructions.

**Steps:**

1. Validate RECALL with event `custom:order.shipped` -- expect no diagnostics.
2. Validate RECALL with event `custom:*` (wildcard) -- expect no diagnostics.
3. Validate RECALL with event `customm:typo` (invalid prefix) -- expect warning.

**Assertions:** `custom:` prefix is recognized. Invalid prefixes still warn.

### INT-3: Event Type Schema Validation

**Goal:** Verify JSON Schema validation correctly validates event payloads.

**Setup:** Event type with JSON Schema defining required and optional fields.

**Steps:**

1. Validate payload matching schema exactly -- pass.
2. Validate payload with extra fields (additionalProperties) -- pass (lenient mode).
3. Validate payload missing required field -- fail with specific error.
4. Validate payload with wrong type for field -- fail.
5. Validate with no schema defined on event type -- pass (any payload).

**Assertions:** Schema validation is correct and produces actionable error messages.

### INT-4: RECALL Execution on Custom Event

**Goal:** Verify RECALL instructions fire when a custom event is delivered to a session.

**Setup:** Agent IR with RECALL `{ event: "custom:order.shipped", instruction: "Inform user their order has shipped" }`. Real memory integration pipeline.

**Steps:**

1. Deliver `custom:order.shipped` event with payload `{ orderId: "123", carrier: "FedEx" }`.
2. Verify RECALL instruction executes.
3. Verify event payload is available in the instruction context as `$event.payload`.

**Assertions:** RECALL fires. Payload accessible. Trace event emitted.

### INT-5: Event Type Deletion with Active References

**Goal:** Verify deletion warning when event type is referenced by RECALL or pipeline.

**Setup:** Event type `test.event` referenced by a pipeline trigger.

**Steps:**

1. Attempt to delete the event type.
2. Verify response includes warning about active references.
3. Force delete with `?force=true` -- succeeds.
4. Verify pipeline trigger becomes orphaned (logged as warning).

**Assertions:** Referential integrity checked. Force delete available.

### INT-6: Custom Event to Kafka Topic Mapping

**Goal:** Verify custom events are published to the correct Kafka topic.

**Setup:** Event bus with Kafka producer mock.

**Steps:**

1. Ingest `order.shipped` custom event.
2. Verify event published to Kafka topic `abl.custom.order.shipped`.
3. Verify event envelope includes tenantId, projectId, timestamp.

**Assertions:** Topic naming convention correct. Envelope complete.

### INT-7: Event Payload Size Enforcement

**Goal:** Verify the 64KB payload size limit is enforced.

**Setup:** Event type with no schema (any payload).

**Steps:**

1. Ingest event with 1KB payload -- success.
2. Ingest event with 63KB payload -- success.
3. Ingest event with 65KB payload -- expect 413 or 400 with payload_too_large error.

**Assertions:** Size limit enforced at API boundary. Clear error message.

### INT-8: Concurrent Event Ingestion

**Goal:** Verify concurrent event ingestion does not cause race conditions.

**Steps:**

1. Register event type.
2. Fire 50 concurrent POST requests for the same event type.
3. Verify all 50 events are persisted with unique eventIds.
4. No duplicate events, no lost events.

**Assertions:** Thread-safe. Unique IDs. Correct count.

### INT-9: Event Type Update and Schema Migration

**Goal:** Verify updating an event type's schema handles in-flight events correctly.

**Steps:**

1. Register event type with schema v1 (field A required).
2. Ingest event with field A -- success.
3. Update schema to v2 (field A + field B required).
4. Ingest event with only field A -- fail (new schema enforced).
5. Ingest event with fields A + B -- success.

**Assertions:** Schema updates take effect immediately. Existing persisted events are not revalidated.

### INT-10: Event Bus Subscription Registry Sync

**Goal:** Verify the subscription registry picks up new custom event subscriptions.

**Steps:**

1. Start event bus with empty subscriptions.
2. Emit custom event -- verify dropped (no subscription).
3. Add subscription via sync function.
4. Emit same event -- verify delivered.

**Assertions:** Dynamic subscription updates propagate correctly.

## 4. Unit Test Scenarios

### UT-1: Event Type Name Validation Rules

- Valid: `order.shipped`, `payment.failed.v2`, `my.custom.event`
- Invalid: `Order.Shipped` (uppercase), `session.start` (reserved), `.leading.dot`, `trailing.`, `a` (too short), `with spaces`, `with-dashes`

### UT-2: Custom Event Name to Kafka Topic Mapping

- `order.shipped` -> `abl.custom.order.shipped`
- `payment.failed.v2` -> `abl.custom.payment.failed.v2`

### UT-3: Event Matching for Custom Patterns

- `custom:order.shipped` matches `["custom:order.shipped"]` -- true
- `custom:*` matches `["custom:order.shipped"]` -- true
- `custom:order.shipped` matches `["custom:payment.failed"]` -- false
- `custom:order.*` matches `["custom:order.shipped"]` -- true (wildcard segment)

### UT-4: Payload Schema Compilation

- Valid JSON Schema compiles without error.
- Invalid JSON Schema (circular $ref) returns compilation error.
- Empty schema accepts any payload.

### UT-5: Event ID Generation

- Event IDs follow pattern `cevt-<timestamp>-<random>`.
- IDs are unique across 10,000 generations.
- IDs are URL-safe.

## 5. Coverage Matrix

| Component                        | Unit | Integration   | E2E          |
| -------------------------------- | ---- | ------------- | ------------ |
| Event type CRUD API              |      | INT-5         | E2E-1, E2E-7 |
| Event ingestion API              | UT-5 | INT-7, INT-8  | E2E-2, E2E-6 |
| Schema validation                | UT-4 | INT-3, INT-9  | E2E-2        |
| Name validation                  | UT-1 |               | E2E-7        |
| Tenant/project isolation         |      |               | E2E-3        |
| Event bus extension              | UT-3 | INT-1, INT-10 | E2E-4        |
| Compiler RECALL validation       | UT-3 | INT-2         |              |
| RECALL execution on custom event |      | INT-4         | E2E-4        |
| Pipeline trigger                 | UT-2 | INT-6         | E2E-8        |
| Rate limiting                    |      |               | E2E-5        |
| Webhook delivery                 |      |               | E2E-9        |
| ClickHouse persistence           |      |               | E2E-10       |
| Payload size limit               |      | INT-7         |              |
| Concurrent ingestion             |      | INT-8         |              |

## 6. Test Infrastructure Requirements

- **Real Express servers** on random ports for all E2E tests.
- **MongoMemoryServer** for event type registry persistence.
- **ClickHouse test instance** (or mock for integration; real for E2E-10).
- **Test HTTP server** for webhook delivery verification (E2E-9).
- **Auth fixtures** with tenant/project scoped tokens.
- **No `vi.mock()` or `jest.mock()`** for any codebase component in E2E tests.
