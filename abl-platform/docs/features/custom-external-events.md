# Feature Spec: Custom External Events

**Status:** ALPHA
**Author:** SDLC Pipeline
**Date:** 2026-03-23
**Slug:** `custom-external-events`

---

## 1. Problem Statement

The ABL Platform has two separate event systems that are disconnected:

1. **Runtime Lifecycle Events** -- Built-in events (`session:start`, `session:end`, `agent:<name>:before`, `tool:<name>:after`, etc.) that fire during agent execution and drive RECALL instructions, REMEMBER triggers, and memory integration. These are hardcoded in `packages/compiler/src/platform/constants.ts` and detected by `apps/runtime/src/services/execution/event-detector.ts`.

2. **External Events API** -- A ClickHouse-backed analytics overlay (`apps/runtime/src/routes/external-events.ts`) that ingests events of types `deployment`, `incident`, `crm_update`, `benchmark`, `product_release`, `outage`, and `custom` for correlation with metric timeseries. These events have no connection to agent behavior at runtime.

**Gap:** There is no way for:

- External systems (CRMs, ERPs, ticketing systems, IoT platforms) to send domain-specific events that **trigger agent behavior** -- e.g., "order shipped", "payment failed", "appointment reminder".
- Agent DSL authors to define **custom event types** beyond the hardcoded lifecycle patterns and react to them via RECALL, REMEMBER, or flow transitions.
- Pipeline authors to trigger pipelines on **custom Kafka topics** defined by tenants, rather than only the 3 built-in platform topics (`abl.session.ended`, `abl.message.user`, `abl.message.agent`).

This limits the platform to conversational-only triggers, preventing event-driven agent architectures where external business events drive proactive agent behavior.

## 2. Scope

### In Scope

- **Custom Event Type Registry** -- Tenant/project-scoped registry for defining custom event types with schemas (name, description, payload JSON Schema, category).
- **Custom Event Ingestion API** -- REST endpoint to ingest custom events from external systems, with schema validation against registered types.
- **Runtime Event Bus Extension** -- Extend `EventType` and `RuntimeEventBus` to support custom event types (pattern: `custom:<event-name>`), enabling agents to react via RECALL/REMEMBER.
- **DSL Integration** -- Extend the compiler's event validation to recognize `custom:<name>` patterns so RECALL instructions can reference custom events without warnings.
- **Pipeline Trigger Extension** -- Allow pipeline trigger definitions to reference custom Kafka topics (`abl.custom.<event-name>`) for event-driven pipeline execution.
- **Studio UI** -- Management interface for registering, editing, and deleting custom event types; event ingestion log viewer.
- **Webhook Delivery** -- Optional outbound webhook delivery when custom events are received, enabling event fan-out to external subscribers.

### Out of Scope

- Replacing the existing external events analytics overlay (the ClickHouse-backed correlation system remains as-is).
- Complex event processing (CEP) patterns like windowed aggregation, event correlation, or temporal joins.
- Custom event types modifying the agent's tool set or identity at runtime.
- Cross-tenant event sharing or federation.
- Event replay or event sourcing patterns.

## 3. User Stories

### US-1: Register Custom Event Type

**As a** project admin, **I want to** define a custom event type (e.g., `order.shipped`) with a payload schema, **so that** external systems can send structured events that my agents understand.

**Acceptance Criteria:**

- Can create a custom event type with name, description, category, and optional JSON Schema for payload validation.
- Event type names must be unique within a project and follow the pattern `[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*` (dot-separated lowercase segments).
- Can list, update, and delete custom event types via API and Studio UI.
- Deleting an event type that is referenced by an active RECALL instruction or pipeline trigger shows a warning.

### US-2: Ingest Custom Event

**As an** external system, **I want to** send a custom event to the platform via REST API, **so that** it can trigger agent behavior and pipeline processing.

**Acceptance Criteria:**

- `POST /api/projects/:projectId/custom-events` accepts `{ eventType, sessionId?, payload, correlationId? }`.
- Payload is validated against the registered event type's JSON Schema (if defined).
- Event is published to the Runtime Event Bus as `custom:<eventType>`.
- Event is persisted to ClickHouse for analytics and audit trail.
- If `sessionId` is provided, the event is delivered to that specific session's agent.
- If `sessionId` is omitted, the event is published to the event bus only (for pipeline triggers and analytics). No session delivery occurs unless explicitly opted in via a future broadcast flag.
- Returns `{ success: true, data: { eventId } }` on success.

### US-3: React to Custom Events in DSL

**As a** DSL author, **I want to** write RECALL instructions that fire on custom events, **so that** my agent proactively responds when external systems report changes.

**Acceptance Criteria:**

- `RECALL` instructions can reference `custom:<event-name>` events (e.g., `ON: custom:order.shipped`).
- The compiler validates `custom:*` event patterns without emitting "unrecognized event" warnings.
- At runtime, when a custom event is ingested for the session, matching RECALL instructions execute.
- Event payload is accessible in the RECALL instruction context.

### US-4: Trigger Pipelines on Custom Events

**As a** pipeline author, **I want to** configure a pipeline to trigger on custom events, **so that** I can run analytics or processing when business events occur.

**Acceptance Criteria:**

- Pipeline trigger definitions support `kafkaTopic: 'abl.custom.<event-name>'` for custom event types.
- The trigger registry includes custom event types registered for the project.
- `PipelineTrigger.handleEvent` matches custom event topics and starts pipeline runs.
- Event payload is passed as `pipelineInput`.

### US-5: Manage Custom Events in Studio

**As a** Studio user, **I want to** manage custom event types and view ingested events in the UI, **so that** I can configure and monitor the event-driven architecture.

**Acceptance Criteria:**

- Studio sidebar includes an "Events" section under the project navigation.
- Event type management page: create, edit, delete event types with schema editor.
- Event log page: filterable list of recently ingested custom events with payload inspection.
- Inline documentation showing how to ingest events via API.

### US-6: Webhook Fan-Out

**As a** project admin, **I want to** configure webhook subscribers for custom event types, **so that** external systems are notified when events occur.

**Acceptance Criteria:**

- Can register webhook URLs for specific event types.
- Webhooks are delivered with HMAC-SHA256 signature for verification.
- Failed deliveries are retried with exponential backoff (3 attempts).
- Webhook delivery status is visible in the event log.

## 4. Requirements

### Functional Requirements

| ID    | Requirement                                                     | Priority |
| ----- | --------------------------------------------------------------- | -------- |
| FR-1  | Custom event type CRUD API scoped to project                    | P0       |
| FR-2  | Custom event ingestion API with schema validation               | P0       |
| FR-3  | Event published to Runtime Event Bus as `custom:<name>`         | P0       |
| FR-4  | Event persisted to ClickHouse `custom_events` table             | P0       |
| FR-5  | Compiler accepts `custom:*` event patterns in RECALL            | P0       |
| FR-6  | Runtime delivers custom events to matching RECALL instructions  | P0       |
| FR-7  | Session-targeted delivery when `sessionId` is provided          | P0       |
| FR-8  | Pipeline triggers on custom Kafka topics                        | P1       |
| FR-9  | Studio event type management UI                                 | P1       |
| FR-10 | Studio event log viewer                                         | P1       |
| FR-11 | Webhook fan-out with HMAC signing                               | P2       |
| FR-12 | Webhook retry with exponential backoff                          | P2       |
| FR-13 | Event bus publication (for pipeline triggers) when no sessionId | P1       |
| FR-14 | Event payload accessible in RECALL instruction context          | P0       |

### Non-Functional Requirements

| ID    | Requirement                                                       | Target |
| ----- | ----------------------------------------------------------------- | ------ |
| NFR-1 | Event ingestion latency (API response) < 100ms p99                | P0     |
| NFR-2 | Event delivery to active session < 500ms p99                      | P0     |
| NFR-3 | Support 1000 custom event types per project                       | P0     |
| NFR-4 | Support 10,000 events/minute per project                          | P1     |
| NFR-5 | Event payload max size 64KB                                       | P0     |
| NFR-6 | Custom events ClickHouse retention: 365 days                      | P0     |
| NFR-7 | Tenant isolation: events from one tenant never visible to another | P0     |
| NFR-8 | Rate limiting: per-tenant, per-project rate limits on ingestion   | P0     |

## 5. Dependencies

| Dependency                    | Type     | Status    | Notes                                                                  |
| ----------------------------- | -------- | --------- | ---------------------------------------------------------------------- |
| Runtime Event Bus             | Internal | Exists    | `apps/runtime/src/services/event-bus/` -- needs extension              |
| ClickHouse analytics tables   | Internal | Exists    | `external_events` table exists; need new `custom_events` table         |
| Compiler event validation     | Internal | Exists    | `packages/compiler/src/platform/ir/recall-validation.ts`               |
| Pipeline trigger registry     | Internal | Exists    | `packages/pipeline-engine/src/pipeline/trigger-registry.ts`            |
| Event detector                | Internal | Exists    | `apps/runtime/src/services/execution/event-detector.ts`                |
| RECALL/REMEMBER execution     | Internal | Exists    | `apps/runtime/src/services/execution/memory-integration.ts`            |
| Studio project navigation     | Internal | Exists    | Studio sidebar needs new "Events" section                              |
| MongoDB (event type registry) | External | Available | Event type definitions stored in MongoDB                               |
| Kafka (optional)              | External | Available | For pipeline trigger fan-out; in-process event bus for direct delivery |

## 6. Risks

| Risk                                                      | Likelihood | Impact | Mitigation                                                              |
| --------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| High event volume overwhelms ClickHouse inserts           | Medium     | High   | Batch inserts, rate limiting, async write path                          |
| Custom event types create naming conflicts with built-ins | Low        | Medium | `custom:` prefix namespace; validation rejects reserved names           |
| Session-targeted delivery to disconnected sessions        | Medium     | Medium | TTL-based event queue in Redis; drop after 30s                          |
| Webhook delivery failures cause back-pressure             | Medium     | Low    | Async delivery via BullMQ; circuit breaker per endpoint                 |
| Schema evolution breaks existing event producers          | Medium     | Medium | Schema versioning; backward-compatible validation (new fields optional) |

## 7. Success Metrics

| Metric                              | Target                  | Measurement                   |
| ----------------------------------- | ----------------------- | ----------------------------- |
| Custom event ingestion adoption     | 10+ projects in 30 days | Count of projects with events |
| Event-to-agent delivery latency p99 | < 500ms                 | Observatory traces            |
| Pipeline triggers on custom events  | 5+ pipelines in 30 days | Pipeline run records          |
| Webhook delivery success rate       | > 99%                   | Webhook delivery logs         |
