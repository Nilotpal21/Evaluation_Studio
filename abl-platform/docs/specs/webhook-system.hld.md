# High-Level Design: Webhook System

**Feature:** `webhook-system`
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Overview

The Webhook System provides reliable, secure delivery of agent execution results to external HTTP endpoints. It serves as the outbound delivery mechanism for the HTTP Async channel, enabling server-to-server integrations where clients cannot maintain persistent WebSocket connections. The system handles subscription management, message ingestion, agent execution, and signed webhook delivery with at-least-once semantics via BullMQ queues.

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Layer (Express)                               │
│                                                                             │
│  ┌─────────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │  http-async-channel.ts          │  │  channel-webhooks.ts             │  │
│  │  - POST /subscribe              │  │  - POST /:channelType/webhook    │  │
│  │  - GET/PATCH/DELETE /subs/:id   │  │  (inbound from Slack/WA/etc.)    │  │
│  │  - POST /message                │  │                                  │  │
│  │  - GET /deliveries/:id          │  │                                  │  │
│  └──────────────┬──────────────────┘  └──────────────────────────────────┘  │
│                 │                                                            │
│  ┌──────────────▼──────────────────────────────────────────────────────────┐ │
│  │                    Auth Middleware + Rate Limiting                       │ │
│  │  authMiddleware → requirePermission('credential:*')                     │ │
│  │  tenantRateLimit('request')                                             │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Queue Layer (BullMQ + Redis)                       │
│                                                                             │
│  ┌─────────────────────────────┐  ┌───────────────────────────────────────┐ │
│  │   channel-inbound queue     │  │    webhook-delivery queue             │ │
│  │   3 attempts, 2s exp backoff│  │    5 attempts, 3s exp backoff         │ │
│  │   removeOnComplete: 1000    │  │    removeOnComplete: 1000             │ │
│  │   removeOnFail: 5000        │  │    removeOnFail: 5000                 │ │
│  └──────────────┬──────────────┘  └──────────────┬────────────────────────┘ │
│                 │                                 │                          │
│  ┌──────────────▼──────────────┐  ┌──────────────▼────────────────────────┐ │
│  │   InboundWorker             │  │    DeliveryWorker                     │ │
│  │   - Dedup (Redis SET NX)    │  │    - Load subscription (tenant)       │ │
│  │   - Session lock            │  │    - Decrypt secret                   │ │
│  │   - Resolve/create session  │  │    - SSRF re-check                   │ │
│  │   - Execute agent           │  │    - HMAC sign payload                │ │
│  │   - Create delivery record  │  │    - POST to callback URL             │ │
│  │   - Enqueue delivery job    │  │    - Update delivery status            │ │
│  │   concurrency: N/A          │  │    - Handle 410 auto-deactivate       │ │
│  └─────────────────────────────┘  │    concurrency: 10                    │ │
│                                    └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Persistence Layer (MongoDB)                           │
│                                                                             │
│  ┌───────────────────────────┐  ┌─────────────────────────────────────────┐ │
│  │  webhook_subscriptions    │  │   webhook_deliveries                    │ │
│  │  - tenantId (required)    │  │   - tenantId (required)                 │ │
│  │  - channelConnectionId    │  │   - subscriptionId                      │ │
│  │  - callbackUrl            │  │   - idempotencyKey (unique w/ tenant)   │ │
│  │  - encryptedSecret        │  │   - eventType                           │ │
│  │  - events (JSON)          │  │   - payload (JSON)                      │ │
│  │  - status                 │  │   - status, httpStatus                  │ │
│  │  - failureCount           │  │   - attempts, responseBody              │ │
│  └───────────────────────────┘  │   - TTL index (retention)               │ │
│                                  └─────────────────────────────────────────┘ │
│  ┌───────────────────────────┐                                              │
│  │  channel_connections      │                                              │
│  │  - HTTP async connections │                                              │
│  └───────────────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

**Outbound (agent response delivery):**

```
1. Client POST /message
2. Route validates auth, subscription, connection
3. Job enqueued to channel-inbound queue
4. InboundWorker picks up job:
   a. Dedup check (Redis SET NX on idempotencyKey)
   b. Acquire session lock (Redis distributed lock)
   c. Resolve or create runtime session
   d. Execute agent pipeline
   e. Create WebhookDelivery record (status: pending)
   f. Enqueue DeliveryJobPayload to webhook-delivery queue
   g. Release session lock
5. DeliveryWorker picks up job:
   a. Load WebhookSubscription (with tenantId filter)
   b. Check subscription status (skip if not active)
   c. SSRF re-check on callback URL
   d. Decrypt HMAC secret (auth profile → legacy fallback)
   e. Build signature headers (HMAC-SHA256)
   f. POST to callback URL (30s timeout, redirect: manual)
   g. Update WebhookDelivery status
   h. Handle HTTP status codes (2xx=success, 410=deactivate, 4xx=fail, 5xx=retry)
```

## 3. 12 Architectural Concerns

### 3.1 Resource Isolation

**Tenant isolation** is enforced at every layer:

| Layer                | Mechanism                                                            |
| -------------------- | -------------------------------------------------------------------- |
| API routes           | `req.tenantContext.tenantId` from auth middleware                    |
| Subscription queries | `findOne({ _id, tenantId })` — never `findById`                      |
| Delivery queries     | `(tenantId, idempotencyKey)` unique index                            |
| Delivery worker      | `runWithTenantContext()` wrapper, tenant filter on subscription load |
| Cross-tenant access  | Returns 404 (not 403) to avoid leaking resource existence            |

**Project isolation**: Subscriptions are scoped to a `channelConnectionId` which belongs to a specific project. The `/subscribe` endpoint validates `project_id` belongs to the tenant before creating the subscription.

**User isolation**: Not applicable — webhook subscriptions are tenant-level resources, not user-owned. All users with `credential:*` permissions can manage subscriptions.

### 3.2 Authentication & Authorization

| Endpoint                  | Auth          | Permission                    |
| ------------------------- | ------------- | ----------------------------- |
| POST /subscribe           | API key / JWT | `credential:write`            |
| GET /subscriptions        | API key / JWT | `credential:read`             |
| PATCH /subscriptions/:id  | API key / JWT | `credential:write`            |
| DELETE /subscriptions/:id | API key / JWT | `credential:delete`           |
| POST /message             | API key / JWT | auth (any authenticated user) |
| GET /deliveries/:id       | API key / JWT | `credential:read`             |

Auth flow: `authMiddleware` (centralized, from `@agent-platform/shared-auth`) → `requirePermission()` → route handler.

### 3.3 Stateless & Distributed

The webhook system is fully stateless across pods:

- **No pod-local state**: All state is in MongoDB (subscriptions, deliveries) and Redis (queues, dedup keys, session locks)
- **BullMQ worker distribution**: Multiple runtime pods can run delivery workers concurrently; BullMQ handles job distribution
- **Dedup via Redis SET NX**: Prevents duplicate processing across pods
- **Session locks**: `acquireSessionLock()` uses Redis distributed lock to prevent concurrent agent execution for the same session

### 3.4 Traceability

| Event             | Trace Mechanism                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Subscription CRUD | `auditSubscriptionCreated/Updated/Deleted` via `AuditStore.log()`                 |
| Message ingestion | `createLogger('inbound-worker')` with tenantId, connectionId, messageId           |
| Delivery attempts | `createLogger('delivery-worker')` with tenantId, deliveryId, httpStatus, attempts |
| Queue failures    | BullMQ `failed` event handler with jobId, attempts, error                         |
| Delivery status   | `WebhookDelivery` record with full attempt history                                |

The `WebhookDelivery` collection serves as both a delivery log and an audit trail, recording every attempt, HTTP status, and response body (truncated).

### 3.5 Compliance

- **Encryption at rest**: `encryptedSecret` on `WebhookSubscription` uses Mongoose encryption plugin
- **Data minimization**: Delivery response bodies truncated to 1000 characters
- **TTL-based retention**: `WEBHOOK_DELIVERY_RETENTION_DAYS` configures MongoDB TTL index for automatic purge
- **Right to erasure**: Deactivating a subscription (soft delete) preserves audit trail; hard deletion would cascade to delivery records
- **Secret lifecycle**: Secrets shown once at creation, never returned in GET responses, regenerable via PATCH

### 3.6 Performance

| Aspect               | Design                                                             |
| -------------------- | ------------------------------------------------------------------ |
| Delivery concurrency | 10 concurrent workers per pod                                      |
| Delivery timeout     | 30 seconds per attempt                                             |
| Queue cleanup        | `removeOnComplete: 1000`, `removeOnFail: 5000`                     |
| Retry backoff        | Exponential: 3s, 6s, 12s, 24s, 48s (5 attempts)                    |
| Response truncation  | 1000 char limit on stored response bodies                          |
| Index design         | Compound indexes on (tenantId, \*) for all frequent query patterns |
| TTL retention        | Configurable delivery record purge                                 |

### 3.7 Error Handling

Error responses follow the platform pattern `{ success: false, error: { code, message } }` for routes that use it (alert-config routes), while HTTP Async routes use `{ error: "message" }` for backwards compatibility.

| Error Type                      | Handling                                              |
| ------------------------------- | ----------------------------------------------------- |
| SSRF violation                  | `CallbackUrlError` thrown → 400 response              |
| Duplicate message               | MongoDB 11000 duplicate key → 409 response            |
| Queue unavailable               | 503 with retry suggestion                             |
| Delivery network error          | BullMQ retry with exponential backoff                 |
| Delivery 4xx                    | Non-retryable, increment `failureCount`               |
| Delivery 5xx                    | Retryable via BullMQ                                  |
| Terminal failure                | Mark delivery `failed`, log error, no further retries |
| Auth profile resolution failure | Fallback to legacy encrypted secret with warning log  |

### 3.8 Scalability

- **Horizontal scaling**: Each runtime pod runs its own InboundWorker and DeliveryWorker; BullMQ distributes jobs
- **Queue depth monitoring**: BullMQ provides queue metrics (waiting, active, completed, failed counts)
- **Concurrency tuning**: Delivery worker concurrency (currently 10) configurable per deployment
- **No bottlenecks**: Delivery is independent per subscription — one slow endpoint doesn't block others
- **TTL-based storage**: Delivery records auto-purge prevents unbounded storage growth

### 3.9 Observability

- **Structured logging**: All components use `createLogger()` with contextual fields (tenantId, subscriptionId, deliveryId, httpStatus)
- **Audit store**: `AuditStore.log()` for subscription lifecycle events with full 14-field structured records
- **Delivery records**: Complete attempt history (httpStatus, responseBody, attempts, timestamps) queryable via API
- **BullMQ events**: Job lifecycle events (completed, failed) with attempt counts and error messages
- **Failure tracking**: `WebhookSubscription.failureCount` for monitoring unhealthy endpoints

### 3.10 Backward Compatibility

- **Auth profile dual-read**: Delivery worker checks auth profile first when `authProfileId` is present, then falls back to legacy `encryptedSecret`
- **Event type contract**: `WebhookEventType` union is forward-looking (4 types defined); subscription creation currently restricts to `agent.response` only
- **API versioned path**: Routes mounted under `/api/v1/channels/http-async`

### 3.11 Deployment & Configuration

| Variable                          | Purpose                               | Default               |
| --------------------------------- | ------------------------------------- | --------------------- |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | TTL for delivery records              | `0` (disabled)        |
| `RUNTIME_PUBLIC_BASE_URL`         | Base URL for webhook URL construction | Inferred from request |
| `CHANNEL_EXECUTE_TIMEOUT_MS`      | Agent execution timeout               | `120000` (2 min)      |
| Redis URL                         | BullMQ connection                     | From runtime config   |

Infrastructure requirements:

- MongoDB with TTL index support
- Redis for BullMQ, dedup, session locks
- Network egress to customer callback URLs

### 3.12 Alternatives Considered

| Alternative                     | Rejected Because                                                        |
| ------------------------------- | ----------------------------------------------------------------------- |
| Direct HTTP delivery (no queue) | No retry, no backpressure, blocks request thread                        |
| AWS SNS/SQS for delivery        | Adds infrastructure dependency; BullMQ already in-stack                 |
| Server-Sent Events (SSE)        | Requires persistent connection; doesn't solve server-to-server use case |
| Polling API only                | Poor developer experience, unnecessary latency and compute waste        |
| Webhook fanout (pub-sub)        | Over-engineering for current 1:1 subscription model                     |
| Separate webhook microservice   | Unnecessary complexity; delivery worker is lightweight and colocated    |

## 4. Data Model

### 4.1 WebhookSubscription

```typescript
interface IWebhookSubscription {
  _id: string; // uuidv7
  tenantId: string; // required, indexed
  channelConnectionId: string; // FK to ChannelConnection
  callbackUrl: string; // max 2048 chars
  encryptedSecret: string; // encrypted at rest
  authProfileId: string | null; // optional auth profile FK
  events: string; // JSON array, validated
  status: 'active' | 'paused' | 'deactivated';
  description: string | null;
  lastDeliveryAt: Date | null;
  failureCount: number; // consecutive failures
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**

- `(tenantId, status)` — list active subscriptions
- `(channelConnectionId)` — lookup by connection
- `(tenantId, createdAt)` — time-ordered listing
- `(tenantId, channelConnectionId)` — tenant-scoped connection lookup

### 4.2 WebhookDelivery

```typescript
interface IWebhookDelivery {
  _id: string; // uuidv7
  tenantId: string; // required, indexed
  subscriptionId: string; // FK to WebhookSubscription
  idempotencyKey: string; // unique with tenantId
  eventType: WebhookEventType; // 'agent.response' | ...
  payload: string; // JSON payload
  status: 'pending' | 'delivered' | 'failed';
  httpStatus: number | null;
  responseBody: string | null; // truncated to 1000 chars
  attempts: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**

- `(tenantId, idempotencyKey)` UNIQUE — dedup
- `(subscriptionId, status)` — delivery listing
- `(tenantId, createdAt)` — time-ordered listing
- `(tenantId, subscriptionId, createdAt)` — scoped listing
- `(createdAt)` TTL — optional retention purge

## 5. Security Design

### 5.1 Webhook Signing

```
Secret generation:  crypto.randomBytes(32).toString('hex') → "whsec_<hex>"
Signed content:     timestamp + "." + JSON body
Algorithm:          HMAC-SHA256(secret_without_prefix, signed_content)
Headers:            x-webhook-signature, x-webhook-timestamp, x-webhook-id
Verification:       timing-safe comparison, 5-minute replay tolerance
```

### 5.2 SSRF Protection Chain

```
1. Registration:  assertAllowedCallbackUrl(url, isProduction)
                  → Protocol check (HTTPS in production)
                  → Hostname block list (localhost, metadata endpoints)
                  → IP range check (private, loopback, link-local, CGNAT)
                  → DNS resolution check (all A/AAAA records)

2. Delivery:      assertAllowedCallbackUrl(url, isProduction)  [defense-in-depth]
                  → Same checks as registration
                  → redirect: 'manual' on fetch (prevent redirect SSRF)
```

### 5.3 Secret Lifecycle

```
Create:     generateWebhookSecret() → show once in response → encrypt via plugin → store
Read:       GET /subscriptions/:id → never returns secret
Update:     PATCH with regenerate_secret: true → new secret shown once
Delivery:   decrypt(encryptedSecret) OR resolveAuthProfileCredentials() → use for HMAC
```

## 6. Failure Modes & Mitigation

| Failure Mode             | Impact                         | Mitigation                                                  |
| ------------------------ | ------------------------------ | ----------------------------------------------------------- |
| Callback URL unreachable | Delivery delayed               | BullMQ retry (5 attempts, exponential backoff)              |
| Callback returns 5xx     | Temporary failure              | Retry with backoff; failureCount incremented                |
| Callback returns 410     | Permanent endpoint removal     | Auto-deactivate subscription                                |
| Redis down               | Queue unavailable              | 503 response; messages not lost (not yet enqueued)          |
| MongoDB down             | No subscription/delivery reads | 500 response; BullMQ jobs remain in queue                   |
| Worker crash             | In-flight job interrupted      | BullMQ visibility timeout requeues job                      |
| DNS resolution fails     | Delivery blocked               | Mark delivery failed; SSRF policy blocks resolution failure |
| Secret decryption fails  | Delivery cannot sign           | Error logged, delivery fails, job retried                   |

## 7. Future Enhancements

1. **Circuit breaker**: Auto-disable subscriptions after N consecutive failures; re-enable via API
2. **Dead letter queue**: Move permanently failed deliveries to DLQ for manual inspection
3. **Delivery rate limiting**: Per-subscription rate limits to protect consumer endpoints
4. **Additional event types**: Wire `session.completed`, `session.escalated` into delivery pipeline
5. **Webhook health dashboard**: API endpoint for success rate, p99 latency, failure trends
6. **Payload transformation**: Per-subscription Handlebars/JSONata templates for custom payloads
7. **Batch delivery**: Group multiple events into a single webhook POST for high-throughput scenarios
