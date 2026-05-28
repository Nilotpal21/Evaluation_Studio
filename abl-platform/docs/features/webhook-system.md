# Feature Spec: Webhook System

**Slug:** `webhook-system`
**Status:** ALPHA
**Owner:** Runtime Team
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Problem Statement

Agent platform users integrating via the HTTP Async channel need a reliable, secure mechanism to receive agent responses and session lifecycle events at their own endpoints. Without a robust webhook system, integrators must poll for results, leading to unnecessary latency, wasted compute, and poor developer experience. The platform must deliver events to external callback URLs with guaranteed at-least-once semantics, HMAC signature verification, SSRF protection, retry with exponential backoff, and full delivery observability.

## 2. Background & Context

The ABL platform supports multiple channel types (Slack, WhatsApp, WebSocket, A2A, etc.) for agent interaction. The HTTP Async channel provides a REST-based integration path where:

1. Clients register a **webhook subscription** with a callback URL
2. Clients send messages via `POST /api/v1/channels/http-async/message`
3. The runtime processes the message through the agent execution pipeline
4. Agent responses are delivered as **signed webhook POSTs** to the callback URL

This pattern is standard across API platforms (Stripe, GitHub, Twilio) and is critical for headless/server-to-server integrations where real-time WebSocket connections are impractical.

### Existing Infrastructure

The webhook system already has substantial implementation:

- **Database models**: `WebhookSubscription`, `WebhookDelivery`, `WebhookSubscriptionConnector` (Mongoose + tenant isolation plugin)
- **BullMQ queues**: `channel-inbound` (message ingestion) and `webhook-delivery` (outbound delivery)
- **Workers**: `inbound-worker.ts` (processes incoming messages) and `delivery-worker.ts` (delivers webhooks)
- **Routes**: `http-async-channel.ts` (subscription CRUD, message ingestion, delivery status)
- **Security**: SSRF protection (`callback-url-policy.ts`), HMAC-SHA256 signing (`webhook-signature.ts`), encryption plugin for secrets
- **Additional webhook surfaces**: Channel webhooks (`channel-webhooks.ts`), agent transfer webhooks, guardrail webhooks, alert delivery webhooks

## 3. Goals

1. **Reliable delivery**: At-least-once delivery with idempotency keys, BullMQ retry (5 attempts, exponential backoff), and persistent delivery records
2. **Security**: HMAC-SHA256 signed payloads with timestamp-based replay protection, SSRF-safe callback URL validation, encrypted-at-rest secrets
3. **Observability**: Full delivery audit trail with per-delivery status tracking (pending/delivered/failed), HTTP response codes, attempt counts
4. **Multi-event support**: Deliver `agent.response`, `session.completed`, `session.escalated`, and `delivery.failed` event types
5. **Tenant isolation**: Every subscription and delivery is scoped to `tenantId`; cross-tenant access returns 404
6. **Developer experience**: One-time secret display on creation, subscription lifecycle management (active/paused/deactivated), delivery logs

## 4. Non-Goals

1. **Webhook fanout / pub-sub**: No broadcasting a single event to multiple independent subscriber systems (each subscription is 1:1 with a callback URL)
2. **Guaranteed ordering**: Events may arrive out of order during retries; consumers must handle via idempotency keys
3. **Real-time streaming**: Webhooks are async POST callbacks, not SSE/WebSocket streams
4. **Custom transformation**: No per-subscription payload transformation or filtering beyond event type selection
5. **Self-service UI in Studio**: Studio webhook management UI is a separate feature (attachment-settings-ui)
6. **Webhook for non-HTTP-Async channels**: Channel webhooks (Slack, WhatsApp, etc.) are inbound; this feature covers outbound delivery

## 5. User Stories

### US-1: Register a webhook subscription

**As** an API integrator, **I want** to register a callback URL for receiving agent responses, **so that** I can receive asynchronous agent responses at my server.

**Acceptance Criteria:**

- POST `/api/v1/channels/http-async/subscribe` with `callback_url`, `project_id`, optional `agent_id`, `deployment_id`, `events`, `description`
- SSRF validation rejects private IPs, loopback, link-local, metadata endpoints
- Returns subscription ID + one-time webhook secret (cannot be retrieved again)
- Secret is encrypted at rest via Mongoose encryption plugin
- Audit log records subscription creation

### US-2: Receive signed webhook deliveries

**As** an API integrator, **I want** webhook deliveries to include HMAC-SHA256 signatures, **so that** I can verify the payload authenticity and prevent tampering.

**Acceptance Criteria:**

- Outbound POST includes `x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id` headers
- Signature is computed as `HMAC-SHA256(secret, timestamp + "." + body)`
- Consumer can verify using `verifyWebhookSignature()` with 5-minute replay tolerance
- Timing-safe comparison prevents timing attacks

### US-3: Retry failed deliveries

**As** the platform, **I want** failed webhook deliveries to be retried with exponential backoff, **so that** transient failures don't cause permanent message loss.

**Acceptance Criteria:**

- BullMQ webhook-delivery queue with 5 attempts, exponential backoff (3s base delay)
- 5xx responses trigger retry; 4xx responses (except 429) are non-retryable
- 410 Gone deactivates the subscription automatically
- Terminal failures (all retries exhausted) mark delivery as `failed`
- Each attempt updates delivery record with HTTP status, response body (truncated to 1000 chars), attempt count

### US-4: Manage subscription lifecycle

**As** an API integrator, **I want** to pause, resume, and deactivate webhook subscriptions, **so that** I can control delivery during maintenance windows.

**Acceptance Criteria:**

- PATCH `/api/v1/channels/http-async/subscriptions/:id` with `status`, `events`, `callback_url`, `regenerate_secret`
- Status transitions: active <-> paused, active/paused -> deactivated
- Delivery worker skips paused/deactivated subscriptions
- Audit log records all subscription changes

### US-5: Monitor delivery status

**As** an API integrator, **I want** to check the delivery status of individual webhook events, **so that** I can diagnose integration issues.

**Acceptance Criteria:**

- GET `/api/v1/channels/http-async/deliveries/:id` returns delivery details
- GET `/api/v1/channels/http-async/subscriptions/:id/deliveries` lists deliveries with pagination
- Each delivery includes: eventType, status, httpStatus, attempts, lastAttemptAt, deliveredAt

### US-6: Send messages with idempotency

**As** an API integrator, **I want** to send messages with idempotency keys, **so that** network retries don't create duplicate agent interactions.

**Acceptance Criteria:**

- POST `/api/v1/channels/http-async/message` accepts `idempotency_key`
- Redis `SET NX` deduplication on first attempt (bypassed on BullMQ retries)
- Duplicate messages return 409 Conflict
- Session keys support both canonical format and client tokens

## 6. Scope

### In Scope

- Webhook subscription CRUD (create, list, get, update, deactivate)
- Async message ingestion via HTTP Async channel
- BullMQ-based inbound processing and outbound delivery pipelines
- HMAC-SHA256 payload signing with timestamp-based replay protection
- SSRF protection with DNS resolution checks
- Delivery status tracking and observability
- Tenant isolation on all subscription and delivery operations
- Secret encryption at rest
- Auto-deactivation on 410 Gone responses
- Configurable delivery retention TTL via `WEBHOOK_DELIVERY_RETENTION_DAYS`

### Out of Scope

- Studio UI for webhook management
- Webhook event types beyond the defined 4 (`agent.response`, `session.completed`, `session.escalated`, `delivery.failed`)
- Webhook transformation/templating
- Rate limiting per subscription (currently uses tenant-level rate limiting)
- Dead letter queue (DLQ) for permanently failed deliveries
- Webhook health scoring / circuit breaker

## 7. Technical Approach

### Architecture Overview

```
Client -> POST /message -> BullMQ channel-inbound -> InboundWorker
                                                         |
                                              Execute agent pipeline
                                                         |
                                              Create WebhookDelivery record
                                                         |
                                              BullMQ webhook-delivery -> DeliveryWorker
                                                                              |
                                                                    Load subscription + decrypt secret
                                                                    SSRF check callback URL
                                                                    POST to callback with HMAC headers
                                                                    Update delivery status
```

### Key Components

| Component                 | Location                                                     | Responsibility                                        |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| WebhookSubscription model | `packages/database/src/models/webhook-subscription.model.ts` | Subscription persistence with tenant isolation        |
| WebhookDelivery model     | `packages/database/src/models/webhook-delivery.model.ts`     | Delivery tracking with TTL retention                  |
| HTTP Async routes         | `apps/runtime/src/routes/http-async-channel.ts`              | Subscription CRUD, message ingestion                  |
| Inbound worker            | `apps/runtime/src/services/queues/inbound-worker.ts`         | Message dedup, session resolution, agent execution    |
| Delivery worker           | `apps/runtime/src/services/queues/delivery-worker.ts`        | HMAC signing, HTTP delivery, retry handling           |
| Channel queues            | `apps/runtime/src/services/queues/channel-queues.ts`         | BullMQ queue initialization                           |
| Webhook signature         | `packages/shared-kernel/src/security/webhook-signature.ts`   | HMAC-SHA256 signing and verification                  |
| Callback URL policy       | `apps/runtime/src/channels/security/callback-url-policy.ts`  | SSRF protection with DNS resolution                   |
| Channel dispatcher        | `apps/runtime/src/services/execution/channel-dispatcher.ts`  | Multi-tier delivery routing (WebSocket, A2A, webhook) |

### Security Model

1. **Authentication**: API key/JWT via `authMiddleware` + `requirePermission('credential:*')`
2. **Secret Management**: Webhook secrets generated via `generateWebhookSecret()` (32 random bytes, `whsec_` prefix), encrypted at rest via Mongoose encryption plugin
3. **SSRF Protection**: `assertAllowedCallbackUrl()` blocks private IPs, loopback, link-local, CGNAT, metadata endpoints; resolves DNS to detect hidden private IPs
4. **Signature Verification**: `buildSignatureHeaders()` produces `x-webhook-signature` (HMAC-SHA256), `x-webhook-timestamp` (Unix epoch), `x-webhook-id` (UUID)
5. **Replay Protection**: 5-minute timestamp tolerance window in `verifyWebhookSignature()`
6. **Redirect Prevention**: `redirect: 'manual'` on delivery fetch prevents SSRF via HTTP redirects

### Data Model

**WebhookSubscription:**

- `_id`, `tenantId`, `channelConnectionId`, `callbackUrl`, `encryptedSecret`, `authProfileId`, `events` (JSON string), `status`, `description`, `lastDeliveryAt`, `failureCount`, `_v`, timestamps
- Indexes: `(tenantId, status)`, `(channelConnectionId)`, `(tenantId, createdAt)`, `(tenantId, channelConnectionId)`

**WebhookDelivery:**

- `_id`, `tenantId`, `subscriptionId`, `idempotencyKey`, `eventType`, `payload`, `status`, `httpStatus`, `responseBody`, `attempts`, `lastAttemptAt`, `deliveredAt`, `_v`, timestamps
- Indexes: `(tenantId, idempotencyKey)` UNIQUE, `(subscriptionId, status)`, `(tenantId, createdAt)`, `(tenantId, subscriptionId, createdAt)`
- Optional TTL index on `createdAt` via `WEBHOOK_DELIVERY_RETENTION_DAYS`

## 8. API Surface

### Endpoints

| Method | Path                                                       | Auth                | Description                                       |
| ------ | ---------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| POST   | `/api/v1/channels/http-async/subscribe`                    | `credential:write`  | Register a webhook subscription                   |
| GET    | `/api/v1/channels/http-async/subscriptions`                | `credential:read`   | List subscriptions (optional `project_id` filter) |
| GET    | `/api/v1/channels/http-async/subscriptions/:id`            | `credential:read`   | Get subscription details                          |
| PATCH  | `/api/v1/channels/http-async/subscriptions/:id`            | `credential:write`  | Update subscription                               |
| DELETE | `/api/v1/channels/http-async/subscriptions/:id`            | `credential:delete` | Deactivate subscription                           |
| POST   | `/api/v1/channels/http-async/message`                      | auth                | Send async message                                |
| GET    | `/api/v1/channels/http-async/subscriptions/:id/deliveries` | `credential:read`   | List deliveries for subscription                  |
| GET    | `/api/v1/channels/http-async/deliveries/:id`               | `credential:read`   | Get delivery status                               |

### Webhook Delivery Payload

```json
{
  "event_type": "agent.response",
  "session_id": "http_async:tenant123:sub456:default",
  "message_id": "uuid",
  "response": "Agent response text",
  "metadata": {},
  "timestamp": "2026-03-22T10:00:00.000Z"
}
```

### Webhook Signature Headers

```
x-webhook-signature: <HMAC-SHA256 hex digest>
x-webhook-timestamp: <Unix epoch seconds>
x-webhook-id: <UUID>
Content-Type: application/json
User-Agent: ABL-Platform-Webhook/1.0
```

## 9. Event Types

| Event Type          | Description                                  | When Emitted                      |
| ------------------- | -------------------------------------------- | --------------------------------- |
| `agent.response`    | Agent produced a response to user input      | After agent execution completes   |
| `session.completed` | Session reached completion state             | When completion detector triggers |
| `session.escalated` | Session was escalated (e.g., to human agent) | On agent transfer initiation      |
| `delivery.failed`   | Webhook delivery permanently failed          | After all retries exhausted       |

Currently only `agent.response` is accepted during subscription creation. The other event types are defined in the `WebhookEventType` union and will be wired as session lifecycle delivery is implemented.

## 10. Error Handling

| Scenario                  | Behavior                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| Invalid callback URL      | 400 with `CallbackUrlError` message                                    |
| SSRF-blocked URL          | 400 at registration time; blocked at delivery time as defense-in-depth |
| Duplicate idempotency key | 409 Conflict                                                           |
| Subscription not found    | 404                                                                    |
| Cross-tenant access       | 404 (not 403, per platform invariant)                                  |
| Queue unavailable         | 503                                                                    |
| Delivery 4xx              | Mark failed, no retry, increment failure count                         |
| Delivery 5xx              | Retry via BullMQ (5 attempts, exponential backoff)                     |
| Delivery 410 Gone         | Deactivate subscription, mark delivery failed                          |
| Delivery timeout          | 30s timeout, retry on network errors                                   |

## 11. Observability

- **Structured logging**: `createLogger('delivery-worker')`, `createLogger('inbound-worker')`, `createLogger('http-async-routes')` with tenantId, subscriptionId, deliveryId context
- **Audit trail**: `auditSubscriptionCreated`, `auditSubscriptionUpdated`, `auditSubscriptionDeleted` via `AuditStore.log()`
- **Delivery records**: Full attempt history in `WebhookDelivery` collection (httpStatus, responseBody, attempts, timestamps)
- **BullMQ metrics**: Job completion/failure events, attempt tracking, queue depth
- **Failure counts**: `WebhookSubscription.failureCount` tracks consecutive delivery failures

## 12. Performance Considerations

- **Delivery worker concurrency**: 10 concurrent deliveries per worker instance
- **Queue backpressure**: BullMQ `removeOnComplete: 1000`, `removeOnFail: 5000` for memory management
- **Delivery timeout**: 30s per attempt, 5 attempts max
- **Response body truncation**: Delivery response bodies truncated to 1000 characters
- **TTL-based retention**: MongoDB TTL index on `WebhookDelivery.createdAt` (configurable via `WEBHOOK_DELIVERY_RETENTION_DAYS`)
- **Session locking**: Redis-based distributed lock (`acquireSessionLock`) prevents concurrent execution for same session

## 13. Testing Strategy

- **Unit tests**: Webhook signature computation/verification, callback URL policy, event type contract
- **Integration tests**: BullMQ queue operations, delivery worker with mocked HTTP, subscription CRUD with real MongoDB
- **E2E tests**: Full message flow (subscribe -> send message -> receive delivery), SSRF rejection, signature verification, retry behavior, subscription lifecycle

## 14. Migration & Rollout

The webhook system is already deployed as part of the HTTP Async channel. Key infrastructure:

- MongoDB collections: `webhook_subscriptions`, `webhook_deliveries`
- BullMQ queues: `channel-inbound`, `webhook-delivery`
- Environment variables: `WEBHOOK_DELIVERY_RETENTION_DAYS`, `RUNTIME_PUBLIC_BASE_URL`

No migration required for the base feature. Future enhancements (additional event types, circuit breaker) will be additive.

## 15. Dependencies

| Dependency                      | Type           | Notes                                           |
| ------------------------------- | -------------- | ----------------------------------------------- |
| MongoDB                         | Infrastructure | Subscription and delivery persistence           |
| Redis                           | Infrastructure | BullMQ queues, session dedup, distributed locks |
| `@agent-platform/database`      | Package        | Mongoose models with tenant isolation           |
| `@agent-platform/shared-kernel` | Package        | Webhook signature utilities, SSRF protection    |
| `@agent-platform/shared-auth`   | Package        | Authentication middleware, tenant context       |
| `@agent-platform/execution`     | Package        | Channel binding types                           |
| BullMQ                          | Library        | Job queue with retry and backoff                |

## 16. Security Considerations

1. **Secret lifecycle**: Secrets shown once at creation, encrypted at rest, can be regenerated via PATCH with `regenerate_secret: true`
2. **Auth profile dual-read**: Delivery worker checks auth profile first (if enabled), falls back to legacy encrypted secret
3. **SSRF defense-in-depth**: URL validated at registration AND at delivery time
4. **No redirect following**: `redirect: 'manual'` prevents SSRF via HTTP 3xx chains
5. **Tenant isolation**: All queries scoped by `tenantId`; cross-tenant returns 404
6. **Permission model**: `credential:read`, `credential:write`, `credential:delete` permissions
7. **Replay protection**: 5-minute timestamp tolerance on signature verification
8. **Timing-safe comparison**: `crypto.timingSafeEqual` prevents timing attacks on signature verification

## 17. Open Questions

1. **Circuit breaker**: Should the platform auto-disable subscriptions after N consecutive failures? Currently `failureCount` is tracked but no threshold is enforced.
2. **Rate limiting per subscription**: Should individual subscriptions have delivery rate limits beyond the tenant-level rate limit?
3. **Dead letter queue**: Should permanently failed deliveries be moved to a DLQ for manual retry/inspection?
4. **Event filtering granularity**: Should subscriptions support filtering by `agent_id` or `project_id` at the event level (beyond connection-level scoping)?
5. **Webhook health dashboard**: Should there be an API endpoint for subscription health metrics (success rate, p99 latency)?

## 18. Decision Log

| Date       | Decision                      | Rationale                                                                                              |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-03-22 | Use BullMQ for delivery queue | Consistent with platform's existing queue infrastructure; provides retry, backoff, concurrency control |
| 2026-03-22 | HMAC-SHA256 with timestamp    | Industry standard (Stripe, GitHub); prevents tampering and replay attacks                              |
| 2026-03-22 | One-time secret display       | Follows Stripe/GitHub pattern; reduces secret exposure surface                                         |
| 2026-03-22 | 410 Gone auto-deactivation    | Allows consumers to signal permanent removal; prevents wasted delivery attempts                        |
| 2026-03-22 | Events stored as JSON string  | Mongoose schema stores events as serialized JSON string for validation flexibility                     |
| 2026-03-22 | Soft delete (deactivate)      | Subscriptions are deactivated rather than deleted to preserve audit history                            |
