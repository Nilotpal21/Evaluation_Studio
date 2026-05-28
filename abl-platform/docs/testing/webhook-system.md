# Test Spec: Webhook System

**Feature:** `webhook-system`
**Status:** PLANNED
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## Test Coverage Matrix

| Area                            | Unit | Integration | E2E     | Status   |
| ------------------------------- | ---- | ----------- | ------- | -------- |
| Webhook signature (sign/verify) | YES  | -           | -       | Existing |
| Event type contract             | YES  | -           | -       | Existing |
| Callback URL SSRF policy        | YES  | -           | -       | Existing |
| Subscription CRUD               | -    | PLANNED     | PLANNED | -        |
| Message ingestion + delivery    | -    | PLANNED     | PLANNED | -        |
| Retry behavior                  | -    | PLANNED     | PLANNED | -        |
| Tenant isolation                | -    | -           | PLANNED | -        |
| Idempotency                     | -    | PLANNED     | PLANNED | -        |
| Auth + permissions              | -    | -           | PLANNED | -        |
| Subscription lifecycle          | -    | PLANNED     | PLANNED | -        |

---

## E2E Test Scenarios

### E2E-1: Full message flow — subscribe, send, receive delivery

**Priority:** P0
**Preconditions:** Running runtime with Redis and MongoDB

**Steps:**

1. Authenticate as tenant user with `credential:write` permission
2. Start a local HTTP server to receive webhook deliveries
3. POST `/api/v1/channels/http-async/subscribe` with the local server URL, a project ID, and agent ID
4. Store the returned `subscription_id` and `secret`
5. POST `/api/v1/channels/http-async/message` with `subscription_id`, `message: "Hello"`, and an `idempotency_key`
6. Wait for delivery at the local HTTP server (with timeout)
7. Verify the delivery payload contains `event_type: "agent.response"` and a non-empty `response`
8. Verify `x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id` headers are present
9. Verify the signature using `verifyWebhookSignature(secret, body, signature, timestamp)`
10. GET `/api/v1/channels/http-async/deliveries/:id` and verify status is `delivered`

**Expected Results:**

- Subscription created with status `active`
- Message accepted with 202
- Webhook delivered to callback URL with valid HMAC signature
- Delivery record shows `status: delivered`, `httpStatus: 200`, `attempts: 1`

### E2E-2: SSRF protection rejects private/reserved IPs

**Priority:** P0
**Preconditions:** Running runtime, production-like config

**Steps:**

1. Authenticate as tenant user
2. POST `/api/v1/channels/http-async/subscribe` with `callback_url: "http://127.0.0.1:8080/webhook"`
3. Verify response is 400 with SSRF-related error message
4. POST `/api/v1/channels/http-async/subscribe` with `callback_url: "http://169.254.169.254/metadata"`
5. Verify response is 400
6. POST `/api/v1/channels/http-async/subscribe` with `callback_url: "http://10.0.0.1/webhook"`
7. Verify response is 400
8. POST `/api/v1/channels/http-async/subscribe` with `callback_url: "http://metadata.google.internal/computeMetadata/v1/"`
9. Verify response is 400

**Expected Results:**

- All private/reserved IPs, metadata endpoints, and link-local addresses rejected
- Error messages indicate SSRF-related validation failure

### E2E-3: Tenant isolation — cross-tenant subscription access returns 404

**Priority:** P0
**Preconditions:** Running runtime with two distinct tenants

**Steps:**

1. Authenticate as Tenant A, create a webhook subscription
2. Authenticate as Tenant B
3. GET `/api/v1/channels/http-async/subscriptions/:idFromTenantA`
4. Verify response is 404 (not 403)
5. PATCH `/api/v1/channels/http-async/subscriptions/:idFromTenantA` with `status: "paused"`
6. Verify response is 404
7. DELETE `/api/v1/channels/http-async/subscriptions/:idFromTenantA`
8. Verify response is 404
9. Authenticate as Tenant A, verify subscription is still active and unchanged

**Expected Results:**

- Cross-tenant access returns 404 on all operations
- Original subscription is unaffected by cross-tenant attempts

### E2E-4: Delivery retry on 5xx with exponential backoff

**Priority:** P0
**Preconditions:** Running runtime with Redis and MongoDB

**Steps:**

1. Start a local HTTP server that returns 500 for the first 3 requests, then 200
2. Create a subscription pointing to the local server
3. Send a message via `/message`
4. Track delivery attempts at the local server
5. Verify the server received exactly 4 requests (initial + 3 retries before success)
6. Verify delivery record shows `status: delivered`, `attempts: 4`
7. Verify the time between attempts shows exponential backoff pattern

**Expected Results:**

- Worker retries on 5xx responses
- Exponential backoff delays between attempts
- Delivery eventually succeeds and record is updated

### E2E-5: Subscription lifecycle management (pause/resume/deactivate)

**Priority:** P1
**Preconditions:** Running runtime with Redis and MongoDB

**Steps:**

1. Create a subscription, verify status is `active`
2. Start a local HTTP server for deliveries
3. Send a message, verify delivery is received
4. PATCH subscription with `status: "paused"`
5. Send another message
6. Wait a reasonable time, verify NO delivery is received at the server
7. PATCH subscription with `status: "active"`
8. Send another message, verify delivery IS received
9. DELETE the subscription
10. GET the subscription, verify status is `deactivated`
11. Send another message, verify NO delivery is received

**Expected Results:**

- Paused subscriptions stop receiving deliveries
- Reactivated subscriptions resume delivery
- Deactivated subscriptions permanently stop delivery

### E2E-6: Idempotency key prevents duplicate processing

**Priority:** P1
**Preconditions:** Running runtime with Redis

**Steps:**

1. Create a subscription with a local server callback
2. POST `/message` with `idempotency_key: "key-123"` and `message: "Hello"`
3. Verify 202 Accepted
4. POST `/message` again with the same `idempotency_key: "key-123"` and `message: "Hello again"`
5. Verify 409 Conflict
6. Verify the local server received exactly ONE delivery (not two)
7. POST `/message` with a different `idempotency_key: "key-456"` and `message: "World"`
8. Verify 202 Accepted and a new delivery is received

**Expected Results:**

- Duplicate idempotency keys return 409
- Only one delivery per idempotency key
- Different keys process independently

### E2E-7: 410 Gone auto-deactivates subscription

**Priority:** P1
**Preconditions:** Running runtime with Redis and MongoDB

**Steps:**

1. Start a local HTTP server that returns 410 Gone
2. Create a subscription pointing to it
3. Send a message
4. Wait for delivery attempt
5. GET the subscription, verify status changed to `deactivated`
6. GET the delivery record, verify status is `failed` with `httpStatus: 410`

**Expected Results:**

- Subscription auto-deactivated on 410 response
- No further delivery attempts

---

## Integration Test Scenarios

### INT-1: Delivery worker processes job and delivers webhook

**Priority:** P0
**Preconditions:** BullMQ with real Redis, MongoDB with webhook models

**Steps:**

1. Create a WebhookSubscription in MongoDB with a known callback URL
2. Create a WebhookDelivery record with status `pending`
3. Enqueue a DeliveryJobPayload to the `webhook-delivery` BullMQ queue
4. Start the delivery worker
5. Start a local HTTP server at the callback URL
6. Wait for job completion
7. Verify the local server received a POST with correct signature headers
8. Verify the WebhookDelivery record is updated: `status: delivered`, `httpStatus: 200`, `attempts: 1`
9. Verify the WebhookSubscription `lastDeliveryAt` is updated and `failureCount` reset to 0

**Expected Results:**

- Worker loads subscription from MongoDB (with tenant filter)
- Worker decrypts secret and computes HMAC signature
- Delivery POST includes all required headers
- Delivery and subscription records updated correctly

### INT-2: Inbound worker processes message and enqueues delivery

**Priority:** P0
**Preconditions:** BullMQ with real Redis, MongoDB with channel connection and subscription

**Steps:**

1. Create ChannelConnection and WebhookSubscription in MongoDB
2. Enqueue an InboundJobPayload to the `channel-inbound` queue
3. Start the inbound worker (with agent execution mocked at the runtime boundary only)
4. Wait for job processing
5. Verify a WebhookDelivery record was created in MongoDB
6. Verify a job was added to the `webhook-delivery` queue with correct payload
7. Verify Redis dedup key was set

**Expected Results:**

- Inbound worker resolves session, executes agent, creates delivery record
- Delivery job enqueued with correct subscriptionId, tenantId, eventType, payload

### INT-3: Subscription CRUD with real MongoDB

**Priority:** P0
**Preconditions:** MongoDB with tenant isolation

**Steps:**

1. POST `/subscribe` with valid callback URL and project ID
2. Verify subscription created in MongoDB with correct fields
3. Verify `encryptedSecret` is NOT the same as the returned plaintext secret (encryption applied)
4. GET `/subscriptions` and verify the subscription appears in the list
5. PATCH the subscription with `status: "paused"` and `callback_url: "https://new.example.com/webhook"`
6. Verify both fields updated in MongoDB
7. PATCH with `regenerate_secret: true`, verify a new secret is returned
8. DELETE the subscription, verify status changed to `deactivated` in MongoDB

**Expected Results:**

- Full CRUD lifecycle works with real MongoDB
- Encryption plugin encrypts secrets before storage
- Tenant isolation enforced on all operations

### INT-4: HMAC signature round-trip verification

**Priority:** P0
**Preconditions:** `@agent-platform/shared-kernel` security package

**Steps:**

1. Generate a webhook secret using `generateWebhookSecret()`
2. Create a payload body string
3. Call `buildSignatureHeaders(secret, body)` to get headers
4. Extract `x-webhook-signature`, `x-webhook-timestamp` from headers
5. Call `verifyWebhookSignature(secret, body, signature, timestamp)` and verify it returns `true`
6. Modify the body and verify the signature fails
7. Modify the timestamp to 6 minutes ago and verify replay protection rejects it
8. Verify timing-safe comparison by testing with wrong-length signatures

**Expected Results:**

- Valid signatures verify correctly
- Tampered body fails verification
- Expired timestamps fail replay check
- Wrong-length signatures fail safely

### INT-5: Delivery worker handles auth profile dual-read

**Priority:** P1
**Preconditions:** MongoDB, auth profile service

**Steps:**

1. Create a subscription with `authProfileId` set
2. Create a matching auth profile with `secrets.webhookSecret`
3. Enqueue a delivery job
4. Verify the worker uses the auth profile secret (not the encrypted legacy secret)
5. Remove the webhook secret from the auth profile
6. Enqueue another delivery job
7. Verify the worker falls back to the legacy encrypted secret with a warning log

**Expected Results:**

- Auth profile takes precedence when available
- Graceful fallback to legacy secret with logged warning
- Delivery succeeds in both paths

### INT-6: Callback URL SSRF validation with DNS resolution

**Priority:** P1
**Preconditions:** Running callback URL policy

**Steps:**

1. Call `assertAllowedCallbackUrl("https://example.com/webhook", true)` — should pass
2. Call `assertAllowedCallbackUrl("http://example.com/webhook", true)` — should fail (HTTPS required in production)
3. Call `assertAllowedCallbackUrl("http://localhost/webhook", true)` — should fail
4. Call `assertAllowedCallbackUrl("https://evil.com/webhook", true)` where `evil.com` resolves to `10.0.0.1` — should fail (DNS resolution check)
5. Call `assertAllowedCallbackUrl("http://0.0.0.0/webhook", true)` — should fail
6. In dev mode: `assertAllowedCallbackUrl("http://localhost:3000/webhook", false)` — should pass

**Expected Results:**

- Production mode requires HTTPS, blocks private IPs and localhost
- DNS resolution catches hostnames resolving to private IPs
- Dev mode allows localhost for testing

### INT-7: BullMQ queue job options and retry configuration

**Priority:** P1
**Preconditions:** Redis for BullMQ

**Steps:**

1. Initialize channel queues via `initChannelQueues()`
2. Verify `channel-inbound` queue has `attempts: 3`, `backoff: exponential, delay: 2000`
3. Verify `webhook-delivery` queue has `attempts: 5`, `backoff: exponential, delay: 3000`
4. Add a job to the delivery queue and verify default job options are applied
5. Verify `removeOnComplete: 1000` and `removeOnFail: 5000` are set

**Expected Results:**

- Queue configurations match expected retry/backoff settings
- Job lifecycle management configured for memory control

---

## Existing Test Coverage

| Test File                                                                 | Type | What It Tests                                                               |
| ------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `packages/shared-kernel/src/security/__tests__/webhook-signature.test.ts` | Unit | HMAC signing, verification, replay protection                               |
| `apps/runtime/src/__tests__/http-async-events.test.ts`                    | Unit | WebhookEventType union contract (4 types), DeliveryJobPayload compatibility |
| `apps/runtime/src/__tests__/inbound-worker.test.ts`                       | Unit | Inbound worker message processing                                           |
| `apps/runtime/src/__tests__/inbound-worker-twilio-sms.test.ts`            | Unit | Twilio SMS inbound worker                                                   |

## Gaps Identified

1. **No E2E tests** for the full subscribe-send-deliver flow
2. **No integration tests** for delivery worker with real Redis + MongoDB
3. **No tenant isolation tests** for subscription CRUD
4. **No SSRF E2E tests** validating end-to-end URL rejection
5. **No retry behavior tests** with controlled HTTP server responses
6. **No subscription lifecycle tests** (pause/resume/deactivate flow)
7. **No auth profile dual-read tests** for delivery worker
8. **No idempotency E2E tests** verifying dedup behavior
