# Feature Spec: Proactive Messaging (#36)

> **Status**: PLANNED
> **Created**: 2026-03-22
> **Last Updated**: 2026-03-22
> **Feature ID**: #36

---

## 1. Problem Statement

The ABL platform currently operates in a purely **reactive** model: every execution flow begins with an inbound user message (via WebSocket, HTTP, Slack webhook, etc.). The `ExecutionCoordinator.submit()` method (`apps/runtime/src/services/execution/execution-coordinator.ts`) always requires a `sessionId` and `userMessage` — there is no mechanism for agents to **initiate** contact with users.

This is a critical gap for enterprise use cases:

- **Appointment reminders** — a healthcare agent should remind patients of upcoming appointments
- **Order status updates** — an e-commerce agent proactively notifies customers when orders ship
- **Campaign outreach** — a sales agent reaches out to leads based on CRM triggers
- **Proactive support** — an agent detects anomalies (billing errors, service outages) and contacts affected users
- **Follow-up nurturing** — after a conversation ends, an agent follows up days later with relevant offers
- **SLA-driven escalation** — a ticket nearing SLA breach triggers an agent to contact the customer

Without proactive messaging, the platform cannot serve the majority of enterprise outbound communication needs, which competitors (Decagon AOPs, Sierra Agent OS, Cognigy) are actively addressing.

---

## 2. Scope

### In Scope

- **Proactive Message API** — REST endpoint to trigger agent-initiated outbound messages to identified contacts
- **Trigger Engine** — support for three trigger types: API-driven, schedule-based (cron), and event-driven (internal platform events)
- **Contact Resolution** — resolve target recipients via the existing `contacts` system (`apps/runtime/src/contacts.ts`)
- **Channel Routing** — determine the best channel to reach a contact (preference order, channel availability, consent)
- **Session Management** — create or resume sessions for proactive conversations, with distinct `initiator: 'agent'` tracking
- **Delivery Pipeline** — leverage the existing `ChannelDispatcher` 3-tier delivery model for outbound message delivery
- **Rate Limiting & Throttling** — per-tenant, per-channel, and per-contact rate limits to prevent abuse
- **Consent Management** — opt-in/opt-out tracking per contact per channel
- **Audit Trail** — full traceability via `TraceEvent` emissions and `eventstore` integration
- **Studio UI** — campaign creation, scheduling, delivery monitoring dashboard
- **DSL Extension** — new `PROACTIVE:` block in ABL for declaring outbound message templates and trigger conditions

### Out of Scope

- **Batch campaign orchestration** (bulk send to thousands) — Phase 2
- **A/B testing of proactive messages** — Phase 2
- **WhatsApp template message pre-approval workflow** — channel-specific, deferred
- **SMS channel support** — requires new channel adapter
- **Real-time streaming of proactive messages** — initial delivery is fire-and-forget with status tracking

---

## 3. User Stories

### US-1: API-Triggered Proactive Message

**As a** platform integrator, **I want to** trigger an agent to send a proactive message to a specific contact via REST API, **so that** my external systems (CRM, helpdesk, monitoring) can initiate agent conversations.

**Acceptance Criteria:**

- POST `/api/projects/:projectId/proactive-messages` with `{ agentName, contactId, message, channelPreference?, metadata? }`
- Returns `{ success: true, data: { messageId, sessionId, deliveryStatus } }`
- Tenant isolation enforced (`tenantId` from auth context, `projectId` from route)
- Contact must exist and have at least one reachable channel
- Message delivered via the contact's preferred channel (or explicit `channelPreference`)

### US-2: Schedule-Based Proactive Message

**As a** business user, **I want to** schedule an agent to send messages at specific times (cron-based), **so that** I can automate recurring outreach like appointment reminders.

**Acceptance Criteria:**

- Create schedule via Studio UI or API: `{ agentName, schedule: { cron, timezone }, contactFilter, messageTemplate }`
- Schedule stored in MongoDB with tenant/project isolation
- BullMQ repeatable job executes at scheduled times
- Each execution resolves contacts matching the filter, sends individualized messages
- Schedule can be paused, resumed, or deleted

### US-3: Event-Driven Proactive Message

**As a** platform developer, **I want to** configure agents to send proactive messages when specific platform events occur (e.g., session.completed, pipeline.alert), **so that** follow-up and escalation happen automatically.

**Acceptance Criteria:**

- Event trigger registered via API: `{ agentName, eventType, contactResolver, messageTemplate, conditions? }`
- Integrates with the existing `eventstore` event registry (`packages/eventstore/src/schema/event-registry.ts`)
- Condition expressions evaluated via CEL or JS sandbox
- Only fires for events matching the registered conditions
- Trace events emitted: `proactive.trigger.fired`, `proactive.trigger.skipped`

### US-4: Contact Consent Management

**As a** compliance officer, **I want to** manage per-contact, per-channel opt-in/opt-out preferences, **so that** proactive messages respect user consent and regulatory requirements (GDPR, TCPA).

**Acceptance Criteria:**

- Consent stored per `{ contactId, channelType, consentStatus: 'opted_in' | 'opted_out' | 'pending' }`
- Proactive message delivery blocked for opted-out contacts
- Consent changes audited via `eventstore`
- Self-service opt-out link/mechanism included in proactive messages
- Consent API: GET/PUT `/api/projects/:projectId/contacts/:contactId/consent`

### US-5: Delivery Monitoring Dashboard

**As a** operations manager, **I want to** view the status of all proactive messages (pending, delivered, failed, read), **so that** I can monitor outreach effectiveness and troubleshoot failures.

**Acceptance Criteria:**

- Studio page showing proactive message history with filters (status, agent, channel, date range)
- Real-time status updates via WebSocket or polling
- Drill-down to individual message: delivery chain, retry history, trace events
- Export to CSV

### US-6: DSL Proactive Block

**As a** agent developer, **I want to** declare proactive message templates and trigger conditions in ABL DSL, **so that** outbound messaging is version-controlled and compiled alongside agent logic.

**Acceptance Criteria:**

- New `PROACTIVE:` section in agent DSL with `TEMPLATE:`, `TRIGGER:`, `CHANNEL_PREFERENCE:`, `RATE_LIMIT:`
- Compiled to IR as `ProactiveConfigIR` with `triggers`, `templates`, `rateLimit`, `channelPreference`
- Validated at compile time: template references exist, trigger event types valid, rate limits sane
- Parser warnings for common mistakes (e.g., trigger without contact resolver)

---

## 4. Functional Requirements

### FR-1: Proactive Message Submission

The system MUST provide a REST API endpoint `POST /api/projects/:projectId/proactive-messages` that:

- Accepts `{ agentName, contactId, message, channelPreference?, metadata?, templateId? }`
- Validates the agent exists in the project
- Resolves the contact and their channel addresses
- Checks consent status for the target channel
- Creates a `ProactiveMessage` record in MongoDB
- Enqueues delivery via BullMQ `proactive-delivery` queue
- Returns the message ID and initial status

### FR-2: Contact Channel Resolution

The system MUST resolve the delivery channel for a proactive message by:

1. If `channelPreference` specified and contact has that channel address: use it
2. Otherwise, use the contact's `preferredChannel` field
3. Fallback to any available channel address in priority order: email > slack > msteams > whatsapp > web_chat
4. If no reachable channel: fail with `CONTACT_UNREACHABLE` error

### FR-3: Session Creation for Proactive Messages

The system MUST create or resume sessions for proactive conversations:

- If an active session exists for the contact + agent: resume it (append to conversation)
- Otherwise: create a new session with `initiator: 'agent'`, `trigger: { type, triggerId }`
- Session follows all existing session lifecycle rules (TTL, memory, state)
- The first message in a proactive session is from the agent (role: `assistant`), not the user

### FR-4: Schedule Management

The system MUST support cron-based scheduling:

- CRUD API: `POST/GET/PUT/DELETE /api/projects/:projectId/proactive-schedules`
- Each schedule has: `{ id, agentName, cron, timezone, contactFilter, messageTemplate, status, metadata }`
- BullMQ repeatable jobs with `jobId` derived from schedule ID for idempotent upserts
- Schedule execution creates individual `ProactiveMessage` records per resolved contact
- Max contacts per execution: configurable (default 1000), with pagination for large sets

### FR-5: Event Trigger Registration

The system MUST support event-driven triggers:

- CRUD API: `POST/GET/PUT/DELETE /api/projects/:projectId/proactive-triggers`
- Each trigger has: `{ id, agentName, eventType, conditions?, contactResolver, messageTemplate, status }`
- Triggers subscribe to the eventstore event bus
- Condition evaluation uses the existing CEL expression engine or sandboxed JS
- Contact resolver expression: maps event data to a `contactId`

### FR-6: Rate Limiting

The system MUST enforce rate limits on proactive messaging:

- Per-tenant: max messages per hour (default 10,000)
- Per-channel: max messages per minute per channel type (default 100)
- Per-contact: max messages per day per contact (default 5)
- Rate limits stored in Redis with sliding window counters
- Exceeded limits return `RATE_LIMIT_EXCEEDED` with `retryAfter` header
- Rate limit configuration: project-level override via `proactive.rateLimit` settings

### FR-7: Delivery Pipeline

The system MUST deliver proactive messages through the existing channel infrastructure:

- Delivery worker reads from BullMQ `proactive-delivery` queue
- For each message: resolve channel adapter, format message (rich content, templates), deliver
- Retry with exponential backoff (3 attempts, base 30s)
- Status tracking: `pending` → `delivering` → `delivered` | `failed` | `bounced`
- Delivery status persisted to `ProactiveMessage` record
- Trace events: `proactive.delivery.attempted`, `proactive.delivery.succeeded`, `proactive.delivery.failed`

### FR-8: Consent Enforcement

The system MUST enforce consent before every proactive message delivery:

- Check `ContactConsent` record for `{ contactId, channelType }`
- If no consent record exists: treat as `pending` (block delivery, optionally send consent request)
- If `opted_out`: block delivery, log reason
- If `opted_in`: proceed with delivery
- Every proactive message includes an unsubscribe mechanism (link or reply command)

### FR-9: Audit and Traceability

The system MUST emit trace events for all proactive messaging operations:

- `proactive.message.created` — message record created
- `proactive.message.delivered` — successful delivery
- `proactive.message.failed` — delivery failure with error details
- `proactive.schedule.executed` — schedule cron fired
- `proactive.trigger.fired` — event trigger matched and executed
- `proactive.consent.changed` — consent status updated
- All events include `tenantId`, `projectId`, `contactId`, `agentName`

### FR-10: DSL Compilation

The system MUST compile `PROACTIVE:` blocks in ABL DSL:

- Parser: `parseProactiveBlock()` in `packages/core/src/parser/agent-based-parser.ts`
- AST type: `ProactiveConfigAST` in `packages/core/src/types/agent-based.ts`
- IR type: `ProactiveConfigIR` in `packages/compiler/src/platform/ir/schema.ts`
- Compiler: `compileProactiveConfig()` in `packages/compiler/src/platform/ir/compiler.ts`
- Validation: template references, trigger event types, rate limit ranges

---

## 5. Non-Functional Requirements

### NFR-1: Latency

- API submission to delivery enqueue: < 200ms (p99)
- Delivery worker processing: < 2s per message (p99)
- Schedule trigger to first delivery: < 10s

### NFR-2: Throughput

- Support 10,000 proactive messages per tenant per hour
- Support 100 concurrent schedule executions per tenant
- BullMQ worker pool: auto-scaling 1-10 workers based on queue depth

### NFR-3: Reliability

- At-least-once delivery guaranteed via BullMQ persistence
- Delivery retries: 3 attempts with exponential backoff
- Dead letter queue for permanently failed messages
- No message loss on pod restart (all state in Redis/MongoDB)

### NFR-4: Security

- All API endpoints require `createUnifiedAuthMiddleware` with `proactive:write` / `proactive:read` permissions
- Consent data encrypted at rest
- Proactive message content passes through output guardrails before delivery
- SSRF protection on webhook-based channel delivery
- Rate limits prevent abuse by compromised API keys

### NFR-5: Observability

- Prometheus metrics: `proactive_messages_total{status,channel}`, `proactive_delivery_latency_ms`, `proactive_schedule_executions_total`
- Structured logging via `createLogger('proactive-messaging')`
- Trace events queryable in Observatory

### NFR-6: Compliance

- GDPR: right to erasure cascades to `ProactiveMessage` and `ContactConsent` records
- Data minimization: message content TTL (default 90 days, configurable)
- Consent audit trail immutable (append-only)

---

## 6. Data Model

### ProactiveMessage

```typescript
interface ProactiveMessage {
  _id: string;
  tenantId: string;
  projectId: string;
  agentName: string;
  contactId: string;
  sessionId?: string; // created/resumed session
  channelType: string;
  channelAddress: string; // e.g., email, Slack user ID
  content: {
    text: string;
    richContent?: RichContentIR;
    templateId?: string;
  };
  trigger: {
    type: 'api' | 'schedule' | 'event';
    triggerId?: string; // schedule or trigger ID
    eventData?: Record<string, unknown>;
  };
  delivery: {
    status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'bounced' | 'cancelled';
    attempts: number;
    lastAttemptAt?: Date;
    deliveredAt?: Date;
    failureReason?: string;
    externalMessageId?: string; // channel-specific ID (Slack ts, email Message-ID)
  };
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date; // TTL for data minimization
}
```

### ProactiveSchedule

```typescript
interface ProactiveSchedule {
  _id: string;
  tenantId: string;
  projectId: string;
  agentName: string;
  name: string;
  description?: string;
  schedule: {
    cron: string;
    timezone: string;
  };
  contactFilter: {
    tags?: string[];
    segments?: string[];
    customFilter?: Record<string, unknown>;
  };
  messageTemplate: {
    text: string;
    richContent?: RichContentIR;
    variables?: Record<string, string>; // template variable mappings
  };
  channelPreference?: string;
  rateLimit?: {
    maxPerExecution: number;
    maxPerDay: number;
  };
  status: 'active' | 'paused' | 'completed' | 'failed';
  lastExecutedAt?: Date;
  nextExecutionAt?: Date;
  executionCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### ProactiveTrigger

```typescript
interface ProactiveTrigger {
  _id: string;
  tenantId: string;
  projectId: string;
  agentName: string;
  name: string;
  eventType: string; // from eventstore registry
  conditions?: string; // CEL expression
  contactResolver: string; // expression: event data → contactId
  messageTemplate: {
    text: string;
    richContent?: RichContentIR;
    variables?: Record<string, string>;
  };
  channelPreference?: string;
  status: 'active' | 'paused';
  fireCount: number;
  lastFiredAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### ContactConsent

```typescript
interface ContactConsent {
  _id: string;
  tenantId: string;
  projectId: string;
  contactId: string;
  channelType: string;
  status: 'opted_in' | 'opted_out' | 'pending';
  consentedAt?: Date;
  revokedAt?: Date;
  source: 'user_action' | 'api' | 'import' | 'default';
  auditTrail: Array<{
    action: 'opt_in' | 'opt_out' | 'reset';
    timestamp: Date;
    source: string;
    reason?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}
```

### MongoDB Indexes

| Collection            | Index                                                      | Purpose             |
| --------------------- | ---------------------------------------------------------- | ------------------- |
| `proactive_messages`  | `{ tenantId, projectId, status, createdAt }`               | Dashboard queries   |
| `proactive_messages`  | `{ tenantId, contactId, createdAt }`                       | Per-contact history |
| `proactive_messages`  | `{ delivery.status, createdAt }` + TTL on `expiresAt`      | Cleanup + retry     |
| `proactive_schedules` | `{ tenantId, projectId, status }`                          | Schedule listing    |
| `proactive_triggers`  | `{ tenantId, projectId, eventType, status }`               | Event matching      |
| `contact_consents`    | `{ tenantId, projectId, contactId, channelType }` (unique) | Consent lookup      |

---

## 7. API Design

### Proactive Messages

| Method | Path                                                     | Permission        | Description               |
| ------ | -------------------------------------------------------- | ----------------- | ------------------------- |
| POST   | `/api/projects/:projectId/proactive-messages`            | `proactive:write` | Submit proactive message  |
| GET    | `/api/projects/:projectId/proactive-messages`            | `proactive:read`  | List messages (paginated) |
| GET    | `/api/projects/:projectId/proactive-messages/:messageId` | `proactive:read`  | Get message detail        |
| DELETE | `/api/projects/:projectId/proactive-messages/:messageId` | `proactive:write` | Cancel pending message    |

### Proactive Schedules

| Method | Path                                                              | Permission        | Description         |
| ------ | ----------------------------------------------------------------- | ----------------- | ------------------- |
| POST   | `/api/projects/:projectId/proactive-schedules`                    | `proactive:write` | Create schedule     |
| GET    | `/api/projects/:projectId/proactive-schedules`                    | `proactive:read`  | List schedules      |
| GET    | `/api/projects/:projectId/proactive-schedules/:scheduleId`        | `proactive:read`  | Get schedule detail |
| PUT    | `/api/projects/:projectId/proactive-schedules/:scheduleId`        | `proactive:write` | Update schedule     |
| DELETE | `/api/projects/:projectId/proactive-schedules/:scheduleId`        | `proactive:write` | Delete schedule     |
| POST   | `/api/projects/:projectId/proactive-schedules/:scheduleId/pause`  | `proactive:write` | Pause schedule      |
| POST   | `/api/projects/:projectId/proactive-schedules/:scheduleId/resume` | `proactive:write` | Resume schedule     |

### Proactive Triggers

| Method | Path                                                     | Permission        | Description        |
| ------ | -------------------------------------------------------- | ----------------- | ------------------ |
| POST   | `/api/projects/:projectId/proactive-triggers`            | `proactive:write` | Create trigger     |
| GET    | `/api/projects/:projectId/proactive-triggers`            | `proactive:read`  | List triggers      |
| GET    | `/api/projects/:projectId/proactive-triggers/:triggerId` | `proactive:read`  | Get trigger detail |
| PUT    | `/api/projects/:projectId/proactive-triggers/:triggerId` | `proactive:write` | Update trigger     |
| DELETE | `/api/projects/:projectId/proactive-triggers/:triggerId` | `proactive:write` | Delete trigger     |

### Contact Consent

| Method | Path                                                                | Permission       | Description        |
| ------ | ------------------------------------------------------------------- | ---------------- | ------------------ |
| GET    | `/api/projects/:projectId/contacts/:contactId/consent`              | `contacts:read`  | Get consent status |
| PUT    | `/api/projects/:projectId/contacts/:contactId/consent/:channelType` | `contacts:write` | Update consent     |

---

## 8. DSL Syntax

```
AGENT: OrderNotifier
  GOAL: "Proactively notify customers about order status changes"

  PROACTIVE:
    TEMPLATES:
      order_shipped:
        TEXT: "Great news! Your order {{orderId}} has been shipped. Track it here: {{trackingUrl}}"
        FORMATS:
          MARKDOWN: "## Order Shipped\nYour order **{{orderId}}** has been shipped.\n[Track your order]({{trackingUrl}})"
          SLACK: '{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Order Shipped*\nOrder `{{orderId}}` is on its way!"}}]}'

      order_delivered:
        TEXT: "Your order {{orderId}} has been delivered. How was your experience?"
        ACTIONS:
          - BUTTON: "great" LABEL: "Great!" VALUE: "positive"
          - BUTTON: "issue" LABEL: "I have an issue" VALUE: "negative"

    TRIGGERS:
      - EVENT: "order.status.changed"
        CONDITION: "event.data.newStatus == 'shipped'"
        CONTACT_RESOLVER: "event.data.customerId"
        TEMPLATE: order_shipped
        CHANNEL_PREFERENCE: email

      - EVENT: "order.status.changed"
        CONDITION: "event.data.newStatus == 'delivered'"
        CONTACT_RESOLVER: "event.data.customerId"
        TEMPLATE: order_delivered

    RATE_LIMIT:
      PER_CONTACT: 5/day
      PER_CHANNEL: 100/minute

    CHANNEL_PREFERENCE:
      - email
      - slack
      - web_chat
```

---

## 9. Architecture Integration Points

### Existing Systems Leveraged

| System                 | How Used                                                     | Source Location                                                |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `ExecutionCoordinator` | Submit proactive messages as agent-initiated executions      | `apps/runtime/src/services/execution/execution-coordinator.ts` |
| `ChannelDispatcher`    | 3-tier delivery for outbound messages                        | `apps/runtime/src/services/execution/channel-dispatcher.ts`    |
| Channel Adapters       | Format and deliver messages per channel (Slack, Email, etc.) | `apps/runtime/src/channels/adapters/`                          |
| `ContactStore`         | Resolve contact channel addresses                            | `apps/runtime/src/contacts.ts`                                 |
| Event Registry         | Register and subscribe to platform events                    | `packages/eventstore/src/schema/event-registry.ts`             |
| BullMQ                 | Delivery queue, schedule execution, retry                    | `apps/runtime/src/services/execution/redis-execution-queue.ts` |
| `TraceStore`           | Emit trace events for all operations                         | `apps/runtime/src/services/trace-store.ts`                     |
| Output Guardrails      | Filter proactive message content                             | `apps/runtime/src/services/execution/output-guardrails.ts`     |
| Template Engine        | Resolve `{{variable}}` in message templates                  | `apps/runtime/src/services/execution/template-engine.ts`       |
| Suspension/Resumption  | Support async proactive conversations                        | `packages/execution/src/suspension.ts`                         |

### New Components

| Component                  | Location                                                                                           | Purpose                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `ProactiveMessageService`  | `apps/runtime/src/services/proactive/message-service.ts`                                           | Core business logic for proactive messages |
| `ProactiveScheduleService` | `apps/runtime/src/services/proactive/schedule-service.ts`                                          | Schedule management and execution          |
| `ProactiveTriggerService`  | `apps/runtime/src/services/proactive/trigger-service.ts`                                           | Event trigger registration and firing      |
| `ProactiveDeliveryWorker`  | `apps/runtime/src/services/proactive/delivery-worker.ts`                                           | BullMQ worker for message delivery         |
| `ConsentService`           | `apps/runtime/src/services/proactive/consent-service.ts`                                           | Consent management                         |
| `ProactiveRateLimiter`     | `apps/runtime/src/services/proactive/rate-limiter.ts`                                              | Redis sliding window rate limiting         |
| Proactive Routes           | `apps/runtime/src/routes/proactive-messages.ts`, `proactive-schedules.ts`, `proactive-triggers.ts` | REST API routes                            |
| Proactive Models           | `apps/runtime/src/db/proactive-message.ts`, etc.                                                   | Mongoose models                            |
| DSL Parser Extension       | `packages/core/src/parser/agent-based-parser.ts`                                                   | `parseProactiveBlock()`                    |
| IR Schema Extension        | `packages/compiler/src/platform/ir/schema.ts`                                                      | `ProactiveConfigIR`                        |
| Studio Pages               | `apps/studio/src/components/proactive/`                                                            | Campaign UI, monitoring dashboard          |

---

## 10. Security Considerations

1. **Authorization**: All proactive endpoints require `proactive:write` or `proactive:read` permission via `requireProjectPermission(req, res, 'proactive:write')`
2. **Tenant Isolation**: Every query includes `tenantId` (platform invariant #1)
3. **Project Isolation**: Every query in project-scoped routes includes `projectId`
4. **User Isolation**: Schedules and triggers filtered by `createdBy`
5. **Content Safety**: Proactive messages pass through the output guardrail pipeline (`output-guardrails.ts`) before delivery
6. **SSRF Protection**: All outbound webhook/channel URLs validated against SSRF allowlist
7. **Rate Limiting**: Multi-level rate limits prevent abuse (tenant, channel, contact)
8. **Consent Enforcement**: Hard block on delivery to opted-out contacts; no override
9. **Data Encryption**: Consent data and message content encrypted at rest via the existing KMS
10. **Audit Trail**: All operations emit immutable trace events

---

## 11. Compliance & Privacy

- **GDPR Article 7**: Consent must be freely given, specific, informed, and unambiguous — the consent model captures source and timestamp
- **GDPR Article 17**: Right to erasure cascades to `ProactiveMessage`, `ContactConsent`, and `ProactiveSchedule` (contact filter cleanup)
- **TCPA**: Per-contact rate limits prevent excessive automated contact
- **CAN-SPAM**: Every email proactive message includes unsubscribe mechanism
- **Data Minimization**: Message content has TTL (default 90 days), delivery metadata retained longer for compliance audit

---

## 12. Performance Considerations

- **Delivery queue**: BullMQ with configurable concurrency (default 10 workers)
- **Rate limiter**: Redis sliding window — O(1) per check via Lua script
- **Schedule execution**: Contacts resolved in batches of 100, messages enqueued in bulk
- **Channel adapter selection**: O(1) registry lookup
- **Template rendering**: Mustache-style — linear in template size, no recursive expansion
- **MongoDB queries**: All queries use covered indexes (see section 6)
- **Payload compression**: Messages > 1KB compressed before BullMQ enqueue (gzip)

---

## 13. Testing Strategy

### E2E Tests (minimum 5)

1. **API → Delivery**: Submit proactive message via API, verify delivery to mock channel endpoint
2. **Schedule Execution**: Create schedule, advance time, verify contacts receive messages
3. **Event Trigger**: Emit platform event, verify trigger fires and message created
4. **Consent Block**: Submit message to opted-out contact, verify delivery blocked
5. **Rate Limit**: Submit messages exceeding rate limit, verify 429 response with retry-after

### Integration Tests (minimum 5)

1. **ProactiveMessageService**: Create message, verify MongoDB record and BullMQ job
2. **ConsentService**: CRUD operations, audit trail integrity
3. **ProactiveRateLimiter**: Sliding window accuracy under concurrent load
4. **ProactiveDeliveryWorker**: Retry behavior, DLQ routing, status updates
5. **Contact Channel Resolution**: Priority ordering, fallback behavior

### Unit Tests

- DSL parser: `PROACTIVE:` block parsing (templates, triggers, rate limits)
- IR compiler: `compileProactiveConfig()` output validation
- Template rendering with variable substitution
- Cron expression validation
- CEL condition evaluation for event triggers

---

## 14. Rollout Plan

### Phase 1: API-Triggered Proactive Messages (MVP)

- ProactiveMessage model and routes
- Contact channel resolution
- Delivery worker with BullMQ
- Consent enforcement (basic opt-in/opt-out)
- Rate limiting (per-tenant, per-contact)
- Trace events and audit trail
- **Exit Criteria**: API submission → delivery to Slack/Email channel verified

### Phase 2: Schedules & Triggers

- ProactiveSchedule model and routes
- BullMQ repeatable jobs for cron schedules
- ProactiveTrigger model and routes
- Eventstore integration for trigger matching
- Studio UI: schedule creation, trigger configuration
- **Exit Criteria**: Cron schedule fires, event trigger matches and delivers

### Phase 3: DSL Extension & Studio UI

- ABL parser: `PROACTIVE:` block
- IR compiler: `ProactiveConfigIR`
- Studio: campaign dashboard, delivery monitoring
- Studio: consent management page
- **Exit Criteria**: DSL-declared triggers compile and execute at runtime

---

## 15. Dependencies

| Dependency                                      | Status      | Risk                                                                 |
| ----------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Contact system (`apps/runtime/src/contacts.ts`) | Implemented | Low — existing CRUD, may need channel address enrichment             |
| Channel adapters                                | Implemented | Low — 9 adapters exist, need outbound-only support                   |
| BullMQ infrastructure                           | Implemented | Low — used extensively (SearchAI, pipeline-engine)                   |
| Eventstore                                      | Implemented | Low — event registry and emission exist                              |
| Output guardrails                               | Implemented | Low — `output-guardrails.ts` exists                                  |
| CEL expression engine                           | Partial     | Medium — used in guardrails, may need extension for event conditions |
| Template engine                                 | Implemented | Low — `template-engine.ts` with Mustache-style rendering             |
| Studio routing                                  | Implemented | Low — add new pages to existing navigation                           |

---

## 16. Risks & Mitigations

| Risk                                    | Impact | Probability | Mitigation                                                                                              |
| --------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------- |
| Channel adapter outbound gaps           | High   | Medium      | Audit each adapter for outbound support; some (WebSocket, web_debug) don't support unsolicited outbound |
| Rate limit bypass via multiple API keys | Medium | Low         | Rate limits keyed on `tenantId + contactId`, not API key                                                |
| Consent data inconsistency              | High   | Low         | Use MongoDB transactions for consent changes; audit trail is append-only                                |
| BullMQ queue backlog during spikes      | Medium | Medium      | Auto-scaling workers, priority queues, circuit breaker on channel adapters                              |
| DSL parser complexity increase          | Medium | Low         | Proactive block is isolated, doesn't interact with flow step parsing                                    |
| Schedule drift from pod restarts        | Low    | Medium      | BullMQ repeatable jobs survive restarts; reconciliation on startup                                      |

---

## 17. Success Metrics

| Metric                          | Target                           | Measurement                                                      |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Proactive message delivery rate | > 95%                            | `delivered / (delivered + failed)` over 24h rolling window       |
| API submission latency (p99)    | < 200ms                          | Prometheus histogram                                             |
| Schedule execution accuracy     | < 5s drift from cron             | Compare `scheduledAt` vs `executedAt`                            |
| Consent compliance              | 100%                             | Zero deliveries to opted-out contacts (audit trail verification) |
| Adoption                        | > 3 tenants using within 30 days | Count of tenants with `proactive_messages_total > 0`             |

---

## 18. Open Questions

| #   | Question                                                                                  | Status   | Decision                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should proactive messages support agent reasoning (full LLM call) or only template-based? | DECIDED  | Phase 1: template-only. Phase 2: option to invoke agent reasoning loop for personalized messages                          |
| 2   | Should batch campaigns (1000+ contacts) use a separate BullMQ Flow or individual jobs?    | DECIDED  | Individual jobs with batch enqueue (100 at a time) for Phase 1. BullMQ Flows for Phase 2                                  |
| 3   | How should consent be bootstrapped for existing contacts?                                 | DECIDED  | Default to `pending` — first proactive attempt sends a consent request instead of the actual message                      |
| 4   | Should the DSL `PROACTIVE:` block be agent-level or project-level?                        | DECIDED  | Agent-level — each agent declares its own proactive config, compiled into its IR                                          |
| 5   | Which channels support unsolicited outbound?                                              | INFERRED | Email, Slack, MS Teams, WhatsApp (with template approval), HTTP async webhooks. WebSocket/web_chat require active session |
| 6   | Should proactive messages go through the full ExecutionCoordinator or bypass it?          | DECIDED  | Bypass for template-only (Phase 1). Route through ExecutionCoordinator for reasoning-based (Phase 2)                      |
