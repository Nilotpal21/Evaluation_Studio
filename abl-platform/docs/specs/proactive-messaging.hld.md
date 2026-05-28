# High-Level Design: Proactive Messaging (#36)

> **Status**: PLANNED
> **Created**: 2026-03-22
> **Feature Spec**: `docs/features/proactive-messaging.md`
> **Test Spec**: `docs/testing/proactive-messaging.md`

---

## 1. Executive Summary

Proactive Messaging enables ABL agents to initiate outbound conversations with users via API triggers, cron schedules, and platform event subscriptions. The system introduces a `ProactiveMessageService` layer that sits between trigger sources and the existing channel delivery infrastructure, adding consent enforcement, rate limiting, contact resolution, and session management as cross-cutting concerns.

The architecture follows the platform's established patterns: BullMQ for async job processing, MongoDB for persistence with tenant/project isolation, Redis for rate limiting and ephemeral state, and the existing `ChannelDispatcher` for multi-tier delivery.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       TRIGGER SOURCES                           │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ REST API │  │ BullMQ Scheduler │  │ Eventstore Listener  │  │
│  │ (manual) │  │ (cron schedules) │  │ (event triggers)     │  │
│  └────┬─────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│       │                 │                        │              │
└───────┼─────────────────┼────────────────────────┼──────────────┘
        │                 │                        │
        ▼                 ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PROACTIVE MESSAGE SERVICE                       │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │ Contact      │  │ Consent      │  │ Rate Limiter        │   │
│  │ Resolver     │  │ Enforcer     │  │ (Redis sliding win) │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬──────────┘   │
│         │                 │                      │              │
│         ▼                 ▼                      ▼              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │         ProactiveMessage Record (MongoDB)                │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                     │
└───────────────────────────┼─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  DELIVERY PIPELINE                               │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐ │
│  │ BullMQ Queue    │  │ Delivery Worker  │  │ Output         │ │
│  │ proactive-      │→ │ (concurrency 10) │→ │ Guardrails     │ │
│  │ delivery        │  │                  │  │                │ │
│  └─────────────────┘  └────────┬─────────┘  └────────┬───────┘ │
│                                │                      │         │
│                                ▼                      ▼         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │             Channel Adapter Registry                      │   │
│  │  ┌───────┐  ┌──────┐  ┌────────┐  ┌──────────┐          │   │
│  │  │ Email │  │ Slack│  │MS Teams│  │HTTP Async│  ...      │   │
│  │  └───────┘  └──────┘  └────────┘  └──────────┘          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Session Manager (create/resume proactive sessions)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Trace Event Emitter (proactive.* events)                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 12 Architectural Concerns

### 3.1 Resource Isolation

**Tenant Isolation**: Every MongoDB query includes `tenantId` as a required field. All collections (`proactive_messages`, `proactive_schedules`, `proactive_triggers`, `contact_consents`) have `tenantId` as the first field in every compound index. Cross-tenant access returns 404 (not 403).

**Project Isolation**: All routes are scoped under `/api/projects/:projectId/...`. Every query includes `projectId`. The `requireProjectPermission()` middleware validates project access before any handler executes.

**User Isolation**: Schedules and triggers are filtered by `createdBy` for list operations. Admin users can see all within their project scope.

**Implementation Pattern**: Repository layer enforces isolation by requiring `tenantId` and `projectId` as mandatory parameters on every method (not optional defaults).

### 3.2 Authentication & Authorization

**Auth Middleware**: All proactive endpoints use `createUnifiedAuthMiddleware()` (not custom token verification).

**Permissions**:
| Operation | Permission |
| --- | --- |
| Create/cancel proactive messages | `proactive:write` |
| List/view proactive messages | `proactive:read` |
| CRUD schedules and triggers | `proactive:write` / `proactive:read` |
| Manage consent | `contacts:write` / `contacts:read` |

**Service-to-Service**: Schedule and trigger execution (BullMQ workers) operate with a system service account that has `proactive:write` permission within the tenant context. The BullMQ job payload includes `tenantId` and `projectId` for proper scoping.

### 3.3 Stateless & Distributed

**No Pod-Local State**: All proactive message state lives in MongoDB (messages, schedules, triggers, consent) and Redis (rate limits, BullMQ jobs).

**BullMQ Workers**: Delivery workers are horizontally scalable. Each worker instance dequeues from the shared `proactive-delivery` queue. Job processing is idempotent via message status checks (only process if status is `pending` or `delivering`).

**Schedule Execution**: BullMQ repeatable jobs are cluster-safe. Only one worker processes each cron tick (BullMQ's built-in dedup). Schedule ID used as `jobId` for idempotent upserts.

**Distributed Locks**: Contact deduplication within a schedule execution uses Redis `SET NX PX` to prevent duplicate messages when multiple pods process the same schedule.

### 3.4 Traceability

**Trace Events**: All operations emit `TraceEvent`s via the shared `TraceStore`:

| Event                          | Severity | Data                                                  |
| ------------------------------ | -------- | ----------------------------------------------------- |
| `proactive.message.created`    | info     | messageId, agentName, contactId, channelType, trigger |
| `proactive.delivery.attempted` | info     | messageId, channelType, attemptNumber                 |
| `proactive.message.delivered`  | info     | messageId, deliveredAt, externalMessageId             |
| `proactive.message.failed`     | error    | messageId, failureReason, attemptCount                |
| `proactive.schedule.executed`  | info     | scheduleId, contactCount, messageCount                |
| `proactive.trigger.fired`      | info     | triggerId, eventType, contactId                       |
| `proactive.trigger.skipped`    | debug    | triggerId, eventType, reason                          |
| `proactive.consent.changed`    | info     | contactId, channelType, oldStatus, newStatus          |

**Structured Logging**: Uses `createLogger('proactive-messaging')` (not `console.log`). Error logging follows `log.error('message', { context })` pattern.

**Correlation**: Every trace event includes `tenantId`, `projectId`, `sessionId` (when applicable), and `messageId` for full correlation.

### 3.5 Compliance

**GDPR**:

- Right to erasure: Contact deletion cascades to `ProactiveMessage` (anonymize), `ContactConsent` (delete), schedule contact filters (remove reference)
- Data minimization: `ProactiveMessage` records have TTL (default 90 days, configurable per project)
- Consent record: Immutable audit trail captures source, timestamp, and reason for every consent change
- Lawful basis: Platform operator is responsible for ensuring lawful basis exists; system enforces consent checks

**TCPA/CAN-SPAM**:

- Per-contact daily rate limit prevents excessive automated contact
- Every email proactive message includes unsubscribe link (template footer injection)
- Opt-out processing within 24 hours (immediate in practice)

**Encryption**:

- Consent data encrypted at rest via the existing KMS (`packages/shared/src/services/encryption/`)
- Message content encrypted in transit (HTTPS) and at rest (MongoDB field-level encryption for PII fields)

### 3.6 Performance

**Latency Budget**:
| Operation | Budget | Breakdown |
| --- | --- | --- |
| API submission | < 200ms | Auth (20ms) + validation (10ms) + contact resolve (30ms) + consent check (20ms) + rate limit (10ms) + MongoDB write (50ms) + BullMQ enqueue (20ms) |
| Delivery processing | < 2s | Queue dequeue (10ms) + template render (5ms) + guardrails (100ms) + channel deliver (1.5s) + status update (50ms) |
| Schedule execution | < 10s per batch | Contact query (200ms) + batch enqueue 100 messages (500ms) |

**Throughput**:

- BullMQ `proactive-delivery` queue: concurrency 10 per worker, auto-scale 1-10 workers
- Rate limiter: Redis Lua script, O(1) per check
- MongoDB batch writes: insertMany for schedule-generated messages (100 per batch)

**Payload Compression**: Messages > 1KB compressed with gzip before BullMQ enqueue (per platform invariant #6).

### 3.7 Error Handling

**Error Envelope**: All API responses follow platform convention:

```typescript
// Success
{ success: true, data: { messageId, sessionId, deliveryStatus } }

// Failure
{ success: false, error: { code: "CONSENT_BLOCKED", message: "Contact has opted out of email channel" } }
```

**Error Codes**:
| Code | HTTP Status | Description |
| --- | --- | --- |
| `AGENT_NOT_FOUND` | 404 | Agent doesn't exist in project |
| `CONTACT_NOT_FOUND` | 404 | Contact doesn't exist in project |
| `CONTACT_UNREACHABLE` | 422 | Contact has no reachable channel addresses |
| `CONSENT_BLOCKED` | 403 | Contact has opted out |
| `RATE_LIMIT_EXCEEDED` | 429 | Rate limit exceeded (with Retry-After header) |
| `SCHEDULE_INVALID_CRON` | 400 | Invalid cron expression |
| `TRIGGER_INVALID_EVENT` | 400 | Unregistered event type |
| `DELIVERY_FAILED` | — | Internal: delivery worker failure (logged, not returned to API) |

**Retry Strategy**: Delivery worker uses exponential backoff with jitter:

- Attempt 1: immediate
- Attempt 2: 30s + random(0-5s)
- Attempt 3: 60s + random(0-10s)
- After 3 failures: route to dead letter queue, mark message as `failed`

**Circuit Breaker**: Per-channel circuit breaker (using Redis counters). If a channel adapter fails > 50% of requests in a 5-minute window, circuit opens for 60s. During open state, messages for that channel are queued (not dropped).

### 3.8 Scalability

**Horizontal Scaling**:

- Delivery workers: stateless, horizontally scalable via BullMQ
- API routes: stateless Express handlers behind load balancer
- Schedule execution: BullMQ repeatable jobs, single execution per cron tick (cluster-safe)

**Vertical Scaling**:

- MongoDB indexes cover all query patterns (no collection scans)
- Redis rate limiter uses O(1) Lua scripts
- BullMQ concurrency tunable per deployment

**Capacity Planning**:
| Scale Point | Phase 1 | Phase 2 (projected) |
| --- | --- | --- |
| Messages per tenant per hour | 10,000 | 100,000 |
| Concurrent delivery workers | 10 | 50 |
| Active schedules per tenant | 100 | 1,000 |
| Active triggers per tenant | 50 | 500 |

### 3.9 Backwards Compatibility

**API Versioning**: New endpoints under existing `/api/projects/:projectId/` prefix. No breaking changes to existing APIs.

**DSL Compatibility**: `PROACTIVE:` block is optional in agent DSL. Agents without `PROACTIVE:` block continue to work as before. The parser recognizes `PROACTIVE:` as a new top-level section; existing sections are unchanged.

**IR Compatibility**: `proactive_config` is an optional field on `AgentIR`. Existing IR consumers (runtime executor, flow step executor) ignore it. New `ProactiveConfigLoader` reads it during runtime startup.

**Database**: New collections (`proactive_messages`, `proactive_schedules`, `proactive_triggers`, `contact_consents`). No schema changes to existing collections. Additive only.

### 3.10 Observability

**Metrics** (Prometheus):
| Metric | Type | Labels |
| --- | --- | --- |
| `proactive_messages_total` | Counter | `status`, `channel`, `trigger_type` |
| `proactive_delivery_duration_ms` | Histogram | `channel`, `status` |
| `proactive_delivery_retries_total` | Counter | `channel` |
| `proactive_rate_limit_hits_total` | Counter | `granularity` (tenant/channel/contact) |
| `proactive_schedule_executions_total` | Counter | `status` |
| `proactive_trigger_fires_total` | Counter | `event_type` |
| `proactive_consent_changes_total` | Counter | `channel`, `action` (opt_in/opt_out) |
| `proactive_queue_depth` | Gauge | — |

**Dashboards**: Studio delivery monitoring page (section 14, FR-US-5). Grafana dashboard for operational metrics.

**Alerting Rules**:

- `proactive_delivery_failure_rate > 10%` for 5m → P2 alert
- `proactive_queue_depth > 10000` → P2 alert (queue backlog)
- `proactive_delivery_duration_ms_p99 > 5000` → P3 alert (latency)

### 3.11 Testing Strategy

Detailed in `docs/testing/proactive-messaging.md`. Summary:

| Level       | Count | Key Focus                                                    |
| ----------- | ----- | ------------------------------------------------------------ |
| E2E         | 10    | Full HTTP API interaction, real servers, auth, multi-channel |
| Integration | 13    | Service boundaries, MongoDB, Redis, BullMQ                   |
| Unit        | 52    | DSL parser, IR compiler, business logic, rate limiter        |

**Testing Constraints**:

- E2E: No mocking codebase components, API-only interaction, real middleware chain
- Integration: Real MongoDB/Redis, channel adapters mocked via DI (external service)
- Unit: Isolated functions, in-memory mocks for DB ports

### 3.12 Migration & Deployment

**Database Migration**:

1. Create `proactive_messages` collection with indexes (idempotent via `createIndex`)
2. Create `proactive_schedules` collection with indexes
3. Create `proactive_triggers` collection with indexes
4. Create `contact_consents` collection with indexes
5. All migrations are additive — no existing collections modified

**Feature Flag**: `PROACTIVE_MESSAGING_ENABLED` environment variable (default `false`). When disabled:

- API routes return 404
- BullMQ workers don't start
- Event listeners don't register
- Zero overhead on existing code paths

**Rollout Sequence**:

1. Deploy with feature flag disabled
2. Run database migration (create collections + indexes)
3. Enable feature flag for internal testing tenant
4. Verify E2E test suite passes against staging
5. Enable for early adopter tenants
6. Enable globally

**Rollback**: Disable feature flag. BullMQ jobs in queue will not be processed (workers stopped). Pending messages remain in MongoDB for retry after re-enabling.

---

## 4. Component Design

### 4.1 ProactiveMessageService

**Responsibility**: Core business logic for creating, validating, and tracking proactive messages.

**Dependencies** (injected via DI):

- `ProactiveMessageRepository` — MongoDB CRUD for `ProactiveMessage`
- `ContactRepository` — resolve contact details and channel addresses
- `ConsentService` — check/enforce consent
- `ProactiveRateLimiter` — rate limit checks
- `ProactiveDeliveryQueue` — BullMQ enqueue
- `SessionManager` — create/resume proactive sessions
- `TraceStore` — emit trace events

**Key Methods**:

```typescript
class ProactiveMessageService {
  async create(params: CreateProactiveMessageParams): Promise<ProactiveMessage>;
  async getById(
    tenantId: string,
    projectId: string,
    messageId: string,
  ): Promise<ProactiveMessage | null>;
  async list(
    tenantId: string,
    projectId: string,
    filters: ListFilters,
  ): Promise<PaginatedResult<ProactiveMessage>>;
  async cancel(tenantId: string, projectId: string, messageId: string): Promise<void>;
}
```

### 4.2 ProactiveDeliveryWorker

**Responsibility**: BullMQ worker that processes delivery jobs.

**Flow**:

1. Dequeue job from `proactive-delivery` queue
2. Load `ProactiveMessage` from MongoDB
3. Validate status is still `pending` or `delivering` (idempotency)
4. Render message template with variable substitution
5. Run output guardrails on rendered content
6. Resolve channel adapter from registry
7. Deliver via adapter
8. Update message status (`delivered` or `failed`)
9. Emit trace event

**Error Handling**:

- Transient errors (5xx, timeout): BullMQ automatic retry with backoff
- Permanent errors (4xx, validation): fail immediately, no retry
- DLQ: after 3 failed attempts

### 4.3 ProactiveScheduleService

**Responsibility**: CRUD for schedules + BullMQ repeatable job management.

**Schedule Execution Flow**:

1. BullMQ cron job fires
2. Load schedule from MongoDB
3. Resolve contacts matching `contactFilter`
4. For each contact (batched by 100):
   a. Check consent
   b. Check rate limit
   c. Create `ProactiveMessage` via `ProactiveMessageService.create()`
5. Update schedule `lastExecutedAt` and `executionCount`
6. Emit `proactive.schedule.executed` trace event

### 4.4 ProactiveTriggerService

**Responsibility**: Event trigger registration, matching, and firing.

**Event Subscription**:

- On startup, loads all active triggers for the tenant
- Subscribes to eventstore event bus (Redis Pub/Sub pattern)
- On event received: match against registered triggers by `eventType`
- Evaluate condition expression (CEL/sandbox)
- Resolve contactId from event data via `contactResolver` expression
- Create proactive message

**Hot Reload**: Trigger changes (create/update/delete) update an in-memory registry. Redis Pub/Sub used to propagate changes across pods.

### 4.5 ConsentService

**Responsibility**: Consent management with immutable audit trail.

**Consent Check Flow**:

1. Query `ContactConsent` by `{ tenantId, projectId, contactId, channelType }`
2. If no record: return `pending` (block delivery, optionally trigger consent request)
3. If `opted_out`: return blocked
4. If `opted_in`: return allowed

**Audit Trail**: Every status change appends to the `auditTrail` array (MongoDB `$push`). Never overwrites existing entries.

### 4.6 ProactiveRateLimiter

**Responsibility**: Multi-level sliding window rate limiting.

**Implementation**: Redis sorted sets with timestamp scores (sliding window log algorithm):

```
ZADD ratelimit:{tenantId}:{contactId}:daily {timestamp} {messageId}
ZREMRANGEBYSCORE ratelimit:{tenantId}:{contactId}:daily -inf {timestamp - 86400000}
ZCARD ratelimit:{tenantId}:{contactId}:daily
```

Wrapped in a Redis Lua script for atomicity.

**Levels**:
| Level | Key Pattern | Default Limit | Window |
| --- | --- | --- | --- |
| Per-tenant | `ratelimit:{tenantId}:hourly` | 10,000/hour | 1 hour |
| Per-channel | `ratelimit:{tenantId}:{channelType}:minute` | 100/minute | 1 minute |
| Per-contact | `ratelimit:{tenantId}:{contactId}:daily` | 5/day | 24 hours |

---

## 5. Data Flow Diagrams

### 5.1 API-Triggered Message Flow

```
Client                  API Route           ProactiveMessageService     BullMQ          DeliveryWorker     Channel
  │                        │                        │                     │                  │               │
  ├─POST /proactive-msgs──►│                        │                     │                  │               │
  │                        ├─validate+auth──────────►│                     │                  │               │
  │                        │                        ├─resolve contact─────►│                  │               │
  │                        │                        ├─check consent────────►│                  │               │
  │                        │                        ├─check rate limit─────►│                  │               │
  │                        │                        ├─save to MongoDB──────►│                  │               │
  │                        │                        ├─enqueue delivery──────►│                  │               │
  │                        │◄─201 { messageId }─────┤                     │                  │               │
  │◄─response──────────────┤                        │                     │                  │               │
  │                        │                        │                     ├─dequeue job──────►│               │
  │                        │                        │                     │                  ├─render+guard──►│
  │                        │                        │                     │                  │               │
  │                        │                        │                     │                  │◄─delivery ack──┤
  │                        │                        │                     │                  ├─update status──►│
```

### 5.2 Schedule Execution Flow

```
BullMQ Cron           ScheduleService      ContactRepo         MessageService       DeliveryQueue
     │                      │                   │                     │                   │
     ├─cron tick───────────►│                   │                     │                   │
     │                      ├─load schedule────►│                     │                   │
     │                      ├─resolve contacts──►│                     │                   │
     │                      │◄─contacts[]───────┤                     │                   │
     │                      │                   │                     │                   │
     │                      ├─for each contact: │                     │                   │
     │                      │  create message───────────────────────►│                   │
     │                      │                   │                     ├─enqueue──────────►│
     │                      │                   │                     │                   │
     │                      ├─update schedule───►│                     │                   │
     │                      ├─emit trace────────►│                     │                   │
```

---

## 6. Alternatives Considered

### Alternative 1: Reuse ExecutionCoordinator for All Proactive Messages

**Description**: Route all proactive messages through the existing `ExecutionCoordinator.submit()`, treating the proactive message as a "system message" that triggers the agent's reasoning loop.

**Pros**:

- Leverages existing execution infrastructure
- Agent can reason about the message before sending
- Full conversation history maintained

**Cons**:

- ExecutionCoordinator requires an active session with a user message — proactive messages have no user message
- Adds LLM call overhead for every proactive message (expensive for template-only messages)
- Concurrency model (serial/preemptive) doesn't apply to outbound messages
- Would require significant refactoring of ExecutionCoordinator to support "agent-initiated" mode

**Decision**: Rejected for Phase 1 (template-only). Phase 2 will add an optional reasoning mode that routes through ExecutionCoordinator.

### Alternative 2: Separate Proactive Messaging Microservice

**Description**: Build proactive messaging as a standalone microservice (new `apps/proactive/`) with its own Express server, database, and BullMQ workers.

**Pros**:

- Clean separation of concerns
- Independent scaling and deployment
- No risk of affecting runtime stability

**Cons**:

- Duplicates infrastructure (Express, auth, MongoDB connection, Redis)
- Adds operational complexity (another service to deploy, monitor, maintain)
- Loses direct access to channel adapters, contact store, session store
- Cross-service communication adds latency and failure modes
- Doesn't follow the existing monolith-first pattern of the platform

**Decision**: Rejected. The platform is a monorepo with runtime as the primary service. Adding a microservice would increase operational complexity without proportional benefit. Proactive messaging is a feature of the runtime, not a separate product.

### Alternative 3: Webhook-Only Delivery (No BullMQ)

**Description**: Deliver proactive messages synchronously in the API request handler, without queueing.

**Pros**:

- Simpler architecture (no queue, no worker)
- Immediate delivery feedback to API caller

**Cons**:

- API response time depends on channel delivery latency (could be seconds)
- No retry mechanism for transient failures
- No back-pressure handling for bursts
- Schedule execution would block the HTTP handler
- Single point of failure

**Decision**: Rejected. Async delivery via BullMQ is essential for reliability, retry, and throughput.

---

## 7. DSL & IR Schema Extensions

### ABL DSL Grammar Extension

```
proactive_block ::= "PROACTIVE:" NEWLINE INDENT proactive_body DEDENT

proactive_body ::= templates_section? triggers_section? rate_limit_section? channel_pref_section?

templates_section ::= "TEMPLATES:" NEWLINE INDENT (template_def)+ DEDENT
template_def ::= IDENTIFIER ":" NEWLINE INDENT template_body DEDENT
template_body ::= "TEXT:" STRING (formats_block)? (actions_block)?

triggers_section ::= "TRIGGERS:" NEWLINE INDENT (trigger_def)+ DEDENT
trigger_def ::= "- EVENT:" STRING NEWLINE trigger_body
trigger_body ::= ("CONDITION:" STRING NEWLINE)? "CONTACT_RESOLVER:" STRING NEWLINE "TEMPLATE:" IDENTIFIER NEWLINE ("CHANNEL_PREFERENCE:" IDENTIFIER NEWLINE)?

rate_limit_section ::= "RATE_LIMIT:" NEWLINE INDENT rate_entries DEDENT
rate_entries ::= ("PER_CONTACT:" rate_expr NEWLINE)? ("PER_CHANNEL:" rate_expr NEWLINE)?
rate_expr ::= NUMBER "/" ("minute" | "hour" | "day")

channel_pref_section ::= "CHANNEL_PREFERENCE:" NEWLINE INDENT ("- " IDENTIFIER NEWLINE)+ DEDENT
```

### IR Schema (`ProactiveConfigIR`)

```typescript
interface ProactiveConfigIR {
  templates: Record<string, ProactiveTemplateIR>;
  triggers: ProactiveTriggerIR[];
  rate_limit?: {
    per_contact?: { count: number; window: 'minute' | 'hour' | 'day' };
    per_channel?: { count: number; window: 'minute' | 'hour' | 'day' };
  };
  channel_preference?: string[];
}

interface ProactiveTemplateIR {
  text: string;
  rich_content?: RichContentIR;
  action_set?: ActionSetIR;
  voice_config?: VoiceConfigIR;
}

interface ProactiveTriggerIR {
  event_type: string;
  condition?: string;
  contact_resolver: string;
  template: string; // reference to templates key
  channel_preference?: string;
}
```

---

## 8. Security Architecture

### Threat Model

| Threat                                 | Mitigation                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unauthorized proactive message sending | `requireProjectPermission('proactive:write')` on all write endpoints                                |
| Cross-tenant message delivery          | `tenantId` mandatory in every query; cross-tenant access returns 404                                |
| Spam/abuse via proactive messaging     | Multi-level rate limiting (tenant, channel, contact)                                                |
| SSRF via channel webhook URLs          | Channel adapter validates outbound URLs against SSRF allowlist                                      |
| PII exposure in proactive messages     | Output guardrails filter PII before delivery                                                        |
| Consent bypass                         | Consent check is mandatory step in delivery pipeline; no bypass flag                                |
| Event trigger injection                | Event triggers only subscribe to registered eventstore events; condition expressions run in sandbox |
| DDoS via schedule execution            | Max contacts per execution (1000), per-tenant schedule limit (100)                                  |

### Secrets Management

- Channel adapter credentials stored in existing KMS (`packages/shared/src/services/encryption/`)
- BullMQ job payloads do NOT include channel credentials (resolved at delivery time)
- Consent data encrypted at rest
- API keys for proactive messaging use existing tenant API key infrastructure

---

## 9. Capacity & Resource Planning

### MongoDB Storage

| Collection            | Estimated Size per Record | Retention                 | Volume (per tenant/day)   |
| --------------------- | ------------------------- | ------------------------- | ------------------------- |
| `proactive_messages`  | ~2KB                      | 90 days TTL               | 10,000 records = 20MB/day |
| `proactive_schedules` | ~1KB                      | Permanent (manual delete) | ~100 records total        |
| `proactive_triggers`  | ~1KB                      | Permanent (manual delete) | ~50 records total         |
| `contact_consents`    | ~500B                     | Permanent (GDPR audit)    | ~10,000 records total     |

### Redis Memory

| Key Pattern              | Size             | TTL                 | Volume                                  |
| ------------------------ | ---------------- | ------------------- | --------------------------------------- |
| Rate limit sorted sets   | ~100B per entry  | Same as window      | ~50,000 keys (10K contacts \* 5 limits) |
| BullMQ jobs              | ~500B per job    | Job completion + 7d | ~10,000 active jobs                     |
| Circuit breaker counters | ~50B per channel | 5 minutes           | ~10 keys                                |

### BullMQ Configuration

```typescript
const deliveryQueue = new Queue('proactive-delivery', {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 30_000,
    },
    removeOnComplete: { age: 86400, count: 10000 }, // 24h or 10K
    removeOnFail: { age: 604800 }, // 7 days (for audit)
  },
});

const deliveryWorker = new Worker('proactive-delivery', processor, {
  concurrency: 10,
  limiter: {
    max: 100,
    duration: 60_000, // 100 jobs per minute per worker
  },
});
```

---

## 10. Integration with Existing Systems

### Channel Adapter Integration

The proactive delivery worker uses the existing channel adapter registry (`apps/runtime/src/channels/registry.ts`) to resolve the appropriate adapter for each channel type. Each adapter's `sendOutbound()` method (to be added) handles channel-specific formatting and delivery.

**Adapter Compatibility Matrix**:

| Channel Type    | Supports Outbound | Notes                                           |
| --------------- | ----------------- | ----------------------------------------------- |
| `email`         | Yes               | SMTP outbound via existing email service        |
| `slack`         | Yes               | `chat.postMessage` via Slack API                |
| `msteams`       | Yes               | Bot Framework outbound message                  |
| `whatsapp`      | Yes               | WhatsApp Cloud API (requires template approval) |
| `http_async`    | Yes               | Webhook POST to subscriber URL                  |
| `web_chat`      | Partial           | Only if user has active WebSocket session       |
| `web_debug`     | No                | Studio-only channel                             |
| `sdk_websocket` | Partial           | Only if SDK client connected                    |
| `api`           | No                | Synchronous request-response only               |
| `voice_*`       | No                | Voice channels are inbound-only                 |

### Session Store Integration

Proactive sessions are stored in the same session store as regular sessions (`apps/runtime/src/services/stores/`). The session record includes:

- `initiator: 'agent'` (vs `'user'` for normal sessions)
- `trigger: { type: 'api' | 'schedule' | 'event', triggerId }` metadata
- Standard session lifecycle (TTL, memory, state) applies

### Eventstore Integration

Event triggers subscribe to the eventstore's event bus via the `EventSubscriber` pattern (`packages/eventstore/`). On startup, the `ProactiveTriggerService` registers subscriptions for all active triggers. Events flow through:

1. Application emits event via `eventRegistry.emit()`
2. Event published to Redis Pub/Sub channel
3. `ProactiveTriggerService` receives event
4. Matches against registered triggers
5. Creates proactive messages for matching triggers

---

## 11. Failure Modes & Recovery

| Failure Mode            | Impact                                  | Detection                          | Recovery                                                             |
| ----------------------- | --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| Delivery worker crash   | Pending jobs delayed                    | BullMQ stalled job detection       | Auto-restart, stalled jobs requeued after 30s                        |
| MongoDB unavailable     | Cannot create/update messages           | Health check, error rate spike     | BullMQ retries; messages remain in queue                             |
| Redis unavailable       | Rate limiting fails open; BullMQ paused | Health check                       | Fail-open on rate limits (log warning); BullMQ recovers on reconnect |
| Channel adapter failure | Messages not delivered                  | Circuit breaker, error traces      | Retry with backoff; circuit breaker opens                            |
| Event bus disconnection | Triggers not firing                     | Subscription health check          | Auto-reconnect; missed events not replayed (accepted trade-off)      |
| Schedule drift          | Messages sent late                      | Metric: `scheduledAt - executedAt` | BullMQ reconciliation on startup                                     |

---

## 12. Key Design Decisions

| #   | Decision                                               | Rationale                                                     |
| --- | ------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | Template-only delivery in Phase 1 (no LLM reasoning)   | Reduces latency, cost, and complexity for MVP                 |
| 2   | BullMQ for delivery pipeline                           | Platform-standard, proven reliability, built-in retry/DLQ     |
| 3   | Consent as a hard block (no override)                  | Regulatory compliance (GDPR, TCPA) is non-negotiable          |
| 4   | Per-contact rate limits in Redis                       | O(1) checks, horizontal scaling, sliding window accuracy      |
| 5   | Feature flag for rollout                               | Zero-risk deployment, tenant-by-tenant enablement             |
| 6   | Proactive sessions share session store                 | Consistent session lifecycle, memory, state management        |
| 7   | Channel adapter outbound method (not separate service) | Reuses existing channel formatting, auth, and error handling  |
| 8   | Event triggers via eventstore (not external webhook)   | Eliminates SSRF risk, leverages existing event infrastructure |
