# Test Spec: Proactive Messaging (#36)

> **Feature**: Proactive Messaging
> **Status**: PLANNED
> **Created**: 2026-03-22
> **Feature Spec**: `docs/features/proactive-messaging.md`

---

## 1. Test Coverage Matrix

### Component Coverage

| Component                        | Unit | Integration | E2E | Status  |
| -------------------------------- | ---- | ----------- | --- | ------- |
| ProactiveMessageService          | 8    | 3           | 3   | PLANNED |
| ProactiveScheduleService         | 5    | 2           | 1   | PLANNED |
| ProactiveTriggerService          | 5    | 2           | 1   | PLANNED |
| ProactiveDeliveryWorker          | 6    | 3           | 2   | PLANNED |
| ConsentService                   | 5    | 2           | 1   | PLANNED |
| ProactiveRateLimiter             | 4    | 2           | 1   | PLANNED |
| Contact Channel Resolution       | 3    | 2           | 1   | PLANNED |
| DSL Parser (PROACTIVE block)     | 10   | 0           | 0   | PLANNED |
| IR Compiler (ProactiveConfigIR)  | 6    | 0           | 0   | PLANNED |
| API Routes (proactive-messages)  | 0    | 4           | 3   | PLANNED |
| API Routes (proactive-schedules) | 0    | 3           | 1   | PLANNED |
| API Routes (proactive-triggers)  | 0    | 3           | 1   | PLANNED |
| API Routes (consent)             | 0    | 2           | 1   | PLANNED |

### FR Coverage

| FR    | Description                  | E2E          | Integration    | Unit           |
| ----- | ---------------------------- | ------------ | -------------- | -------------- |
| FR-1  | Proactive Message Submission | E2E-1, E2E-2 | INT-1          | U-1 thru U-4   |
| FR-2  | Contact Channel Resolution   | E2E-3        | INT-5          | U-5 thru U-7   |
| FR-3  | Session Creation             | E2E-1, E2E-6 | INT-2          | U-8 thru U-10  |
| FR-4  | Schedule Management          | E2E-7        | INT-6, INT-7   | U-11 thru U-15 |
| FR-5  | Event Trigger                | E2E-8        | INT-8, INT-9   | U-16 thru U-20 |
| FR-6  | Rate Limiting                | E2E-5        | INT-3          | U-21 thru U-24 |
| FR-7  | Delivery Pipeline            | E2E-2, E2E-9 | INT-4, INT-10  | U-25 thru U-30 |
| FR-8  | Consent Enforcement          | E2E-4        | INT-11, INT-12 | U-31 thru U-35 |
| FR-9  | Audit Trail                  | E2E-10       | INT-13         | U-36 thru U-38 |
| FR-10 | DSL Compilation              | —            | —              | U-39 thru U-48 |

---

## 2. E2E Test Scenarios

All E2E tests interact exclusively via HTTP API. Real Express servers started on random ports. No mocking of codebase components. Auth context provided via valid JWT tokens.

### E2E-1: API-Triggered Proactive Message — Happy Path

**Objective**: Verify a proactive message can be submitted via API and delivered to a contact's channel.

**Preconditions**:

- Runtime server running on random port with full middleware chain
- MongoDB with tenant, project, agent, and contact seeded via API
- Contact has email channel address and `opted_in` consent
- Mock SMTP/channel endpoint to capture delivered messages

**Steps**:

1. POST `/api/projects/:projectId/proactive-messages` with `{ agentName: "notifier", contactId: "<seeded>", message: "Your order shipped" }`
2. Assert response: `{ success: true, data: { messageId, sessionId, deliveryStatus: "pending" } }`
3. Poll GET `/api/projects/:projectId/proactive-messages/:messageId` until `delivery.status === "delivered"` (max 10s)
4. Verify mock channel endpoint received the message with correct content
5. GET `/api/projects/:projectId/sessions/:sessionId` — verify session exists with `initiator: "agent"`

**Expected**:

- 201 response with messageId
- Delivery completes within 5s
- Session created with agent as initiator
- Mock channel received correctly formatted message

### E2E-2: Delivery Retry on Transient Failure

**Objective**: Verify the delivery worker retries on transient channel failures and eventually succeeds.

**Preconditions**:

- Mock channel endpoint configured to fail first 2 requests with 503, succeed on 3rd
- Contact with `opted_in` consent

**Steps**:

1. POST proactive message
2. Poll message status — expect `delivering` initially
3. Wait for retry cycle (exponential backoff: 30s, 60s)
4. Verify message eventually reaches `delivered` status
5. GET message detail — verify `delivery.attempts === 3`
6. Verify mock endpoint received exactly 3 requests

**Expected**:

- Message delivered after retries
- `delivery.attempts` reflects actual attempt count
- Each retry logged as trace event `proactive.delivery.attempted`

### E2E-3: Contact Channel Resolution Fallback

**Objective**: Verify the system falls back to alternative channels when the preferred channel is unavailable.

**Preconditions**:

- Contact with email (opted_in) and slack (opted_in) channel addresses
- Email channel adapter returns failure (simulate down)

**Steps**:

1. POST proactive message with `channelPreference: "email"`
2. Verify delivery attempts email first, fails
3. System falls back to slack channel
4. Verify message delivered via slack
5. GET message detail — verify `channelType` is "slack"

**Expected**:

- Fallback to next available channel
- Delivery succeeds via slack
- Trace events show channel resolution path

### E2E-4: Consent Block — Opted-Out Contact

**Objective**: Verify proactive messages are blocked for contacts who have opted out.

**Preconditions**:

- Contact with `opted_out` consent for all channels

**Steps**:

1. POST proactive message to opted-out contact
2. Assert response: `{ success: false, error: { code: "CONSENT_BLOCKED", message: "..." } }` or delivery immediately fails
3. GET message detail — verify `delivery.status === "cancelled"` with `failureReason` containing consent
4. Verify NO message sent to any channel endpoint
5. Verify trace event `proactive.message.failed` emitted with consent reason

**Expected**:

- Message not delivered
- Clear error indicating consent block
- Audit trail records the consent-based rejection

### E2E-5: Rate Limit Enforcement

**Objective**: Verify per-contact rate limits are enforced.

**Preconditions**:

- Rate limit configured: 3 messages per day per contact
- Contact with `opted_in` consent

**Steps**:

1. POST 3 proactive messages to the same contact — all succeed
2. POST 4th message — expect rate limit rejection
3. Assert response: `{ success: false, error: { code: "RATE_LIMIT_EXCEEDED" } }` with `Retry-After` header
4. Verify only 3 messages exist with `delivery.status !== "cancelled"`

**Expected**:

- First 3 messages accepted and delivered
- 4th message rejected with 429 status
- `Retry-After` header present

### E2E-6: Session Resume for Repeat Proactive Contact

**Objective**: Verify a second proactive message to the same contact reuses the existing session.

**Preconditions**:

- First proactive message already delivered, session exists

**Steps**:

1. POST first proactive message — note `sessionId`
2. POST second proactive message to same contact + agent
3. Verify second message uses the same `sessionId`
4. GET session — verify conversation has both agent messages

**Expected**:

- Same session reused
- Conversation history shows both messages

### E2E-7: Schedule Creation and Execution

**Objective**: Verify a cron schedule can be created and fires at the scheduled time.

**Preconditions**:

- Contact matching the schedule's contact filter
- Contact with `opted_in` consent

**Steps**:

1. POST `/api/projects/:projectId/proactive-schedules` with cron set to fire within 60s
2. Assert schedule created with `status: "active"`
3. Wait for cron execution (poll schedule detail for `lastExecutedAt` change, max 90s)
4. Verify proactive message created for the matching contact
5. Verify message delivered

**Expected**:

- Schedule fires on time
- Matching contacts receive messages
- `executionCount` incremented

### E2E-8: Event Trigger Fires on Platform Event

**Objective**: Verify an event-driven trigger fires when a matching platform event occurs.

**Preconditions**:

- ProactiveTrigger registered for event type `session.completed`
- Contact resolver maps `event.data.contactId` to a contact

**Steps**:

1. POST `/api/projects/:projectId/proactive-triggers` with `{ eventType: "session.completed", contactResolver: "event.data.contactId" }`
2. Trigger the event: complete a session via normal conversation flow
3. Verify proactive message created for the resolved contact
4. Verify message delivered

**Expected**:

- Trigger matches the event
- Contact resolved from event data
- Message delivered

### E2E-9: Delivery to Multiple Channel Types

**Objective**: Verify proactive messages can be delivered to Slack, Email, and HTTP async channels.

**Preconditions**:

- Three contacts: one with email, one with slack, one with http_async channel
- All with `opted_in` consent
- Mock endpoints for each channel

**Steps**:

1. POST proactive message to email contact — verify email mock receives it
2. POST proactive message to slack contact — verify slack mock receives Block Kit format
3. POST proactive message to http_async contact — verify webhook mock receives it
4. Verify each message has correct `channelType` in the message record

**Expected**:

- Each channel type receives correctly formatted message
- Channel-specific formatting applied (rich content for Slack, HTML for email)

### E2E-10: Full Audit Trail Verification

**Objective**: Verify all proactive messaging operations emit correct trace events.

**Preconditions**:

- Standard setup with one contact

**Steps**:

1. POST proactive message
2. Wait for delivery
3. Query trace events for the session/message
4. Verify events: `proactive.message.created`, `proactive.delivery.attempted`, `proactive.message.delivered`
5. Each event has `tenantId`, `projectId`, `contactId`, `agentName`

**Expected**:

- Complete trace event chain
- All required fields present in each event
- Events queryable by tenantId + projectId

---

## 3. Integration Test Scenarios

Integration tests use real service boundaries (MongoDB, Redis, BullMQ). No mocking of codebase components. External channel adapters are mocked via dependency injection.

### INT-1: ProactiveMessageService — Create and Enqueue

**Objective**: Verify message creation stores to MongoDB and enqueues BullMQ job.

**Setup**: Real MongoDB + Redis. Channel adapter mocked via DI.

**Steps**:

1. Call `ProactiveMessageService.create({ agentName, contactId, message })`
2. Query MongoDB: verify `ProactiveMessage` record exists with correct fields
3. Inspect BullMQ `proactive-delivery` queue: verify job enqueued with messageId

**Assert**:

- MongoDB record matches input
- BullMQ job present with correct payload
- `delivery.status === "pending"`

### INT-2: Session Creation — New vs Resume

**Objective**: Verify correct session creation/resumption logic.

**Setup**: Real MongoDB session store.

**Steps**:

1. Create proactive message for contact with no existing session — verify new session created with `initiator: "agent"`
2. Create second proactive message for same contact+agent — verify existing session reused
3. Create proactive message for contact with expired session — verify new session created

**Assert**:

- New session has `initiator: "agent"` and `trigger` metadata
- Resumed session has appended message
- Expired session not reused

### INT-3: Rate Limiter — Sliding Window Accuracy

**Objective**: Verify Redis sliding window rate limiter under concurrent access.

**Setup**: Real Redis.

**Steps**:

1. Configure rate limit: 5 per contact per day
2. Send 5 check requests concurrently — all should pass
3. Send 6th request — should fail
4. Advance time window — verify limit resets

**Assert**:

- Exactly 5 pass, 6th fails
- Concurrent access doesn't cause race conditions (Redis Lua atomicity)
- Window expiry works correctly

### INT-4: Delivery Worker — Retry and DLQ

**Objective**: Verify delivery worker retry behavior and dead letter queue routing.

**Setup**: Real BullMQ. Channel adapter mock returns failures.

**Steps**:

1. Enqueue delivery job
2. Mock adapter fails all 3 attempts
3. Verify job moved to DLQ after 3 failures
4. Verify `ProactiveMessage.delivery.status === "failed"`
5. Verify `delivery.attempts === 3`

**Assert**:

- 3 retry attempts with exponential backoff
- Job in DLQ
- Message status updated to `failed`

### INT-5: Contact Channel Resolution — Priority Ordering

**Objective**: Verify channel resolution follows priority order.

**Setup**: Real MongoDB with contact having multiple channel addresses.

**Steps**:

1. Contact has: email (opted_in), slack (opted_in), web_chat (opted_in)
2. No `channelPreference` specified
3. Resolve channel — should return email (highest priority)
4. Mark email as opted_out — should return slack
5. Mark slack as opted_out — should return web_chat

**Assert**:

- Priority order: email > slack > msteams > whatsapp > web_chat
- Consent status respected in resolution

### INT-6: Schedule Service — BullMQ Repeatable Job

**Objective**: Verify schedule creates correct BullMQ repeatable job.

**Setup**: Real Redis + BullMQ.

**Steps**:

1. Create schedule with cron `*/1 * * * *` (every minute)
2. Verify BullMQ repeatable job created with correct cron
3. Pause schedule — verify job removed
4. Resume schedule — verify job recreated
5. Delete schedule — verify job removed

**Assert**:

- Repeatable job ID derived from schedule ID
- Pause/resume correctly manages the BullMQ job
- Delete cleans up completely

### INT-7: Schedule Execution — Contact Filter Resolution

**Objective**: Verify schedule execution correctly resolves contacts from filter.

**Setup**: Real MongoDB with contacts.

**Steps**:

1. Seed 5 contacts: 3 with tag "vip", 2 without
2. Create schedule with contactFilter `{ tags: ["vip"] }`
3. Execute schedule
4. Verify 3 proactive messages created (one per VIP contact)
5. Verify non-VIP contacts receive no messages

**Assert**:

- Contact filter correctly applied
- Each matching contact gets individual message
- Non-matching contacts excluded

### INT-8: Event Trigger — Condition Evaluation

**Objective**: Verify event trigger condition expressions work correctly.

**Setup**: Real MongoDB.

**Steps**:

1. Create trigger with condition `event.data.priority === "high"`
2. Emit event with `{ priority: "high" }` — trigger should fire
3. Emit event with `{ priority: "low" }` — trigger should not fire
4. Verify fire count incremented only for matching events

**Assert**:

- Condition evaluated correctly
- Non-matching events ignored
- `fireCount` accurate

### INT-9: Event Trigger — Contact Resolver Expression

**Objective**: Verify the contact resolver expression maps event data to contactId.

**Setup**: Real MongoDB with contacts.

**Steps**:

1. Create trigger with `contactResolver: "event.data.userId"`
2. Emit event with `{ userId: "<valid-contact-id>" }`
3. Verify proactive message created for that contact
4. Emit event with `{ userId: "<invalid-id>" }` — verify graceful failure

**Assert**:

- Contact resolved from event data
- Invalid contact ID produces error trace event, not crash

### INT-10: Delivery Worker — Message Formatting per Channel

**Objective**: Verify delivery worker applies channel-specific formatting.

**Setup**: Real BullMQ. Channel adapter captures formatted output.

**Steps**:

1. Enqueue message with `richContent: { markdown: "**Bold**", slack: '{"blocks":[...]}' }` for slack channel
2. Verify adapter receives Block Kit format, not markdown
3. Enqueue same message for email channel — verify HTML/markdown format
4. Enqueue message with no rich content — verify plain text

**Assert**:

- Channel-specific format selected
- Fallback to plain text when no rich content

### INT-11: Consent Service — CRUD and Audit Trail

**Objective**: Verify consent changes are persisted with audit trail.

**Setup**: Real MongoDB.

**Steps**:

1. Set consent `opted_in` for contact + email
2. Verify `ContactConsent` record created with audit entry
3. Update to `opted_out` — verify audit trail has 2 entries
4. Verify `revokedAt` timestamp set
5. Re-opt-in — verify audit trail has 3 entries

**Assert**:

- Each consent change appends to audit trail
- Timestamps accurate
- Status transitions correct

### INT-12: Consent — Cascade on Contact Deletion

**Objective**: Verify consent records are cleaned up when a contact is deleted (right to erasure).

**Setup**: Real MongoDB.

**Steps**:

1. Create contact with consent records
2. Delete contact via API
3. Verify `ContactConsent` records deleted

**Assert**:

- No orphaned consent records
- GDPR erasure cascade works

### INT-13: Trace Event Emission — All Proactive Events

**Objective**: Verify all FR-9 trace events are emitted during the proactive message lifecycle.

**Setup**: Real trace store.

**Steps**:

1. Create and deliver a proactive message
2. Query trace store for all `proactive.*` events
3. Verify: `proactive.message.created`, `proactive.delivery.attempted`, `proactive.message.delivered`
4. For a failed delivery: verify `proactive.message.failed`
5. For consent change: verify `proactive.consent.changed`

**Assert**:

- All expected events present
- Event payloads include required fields (tenantId, projectId, etc.)

---

## 4. Unit Test Scenarios

### DSL Parser (10 tests)

- U-39: Parse minimal `PROACTIVE:` block with one template
- U-40: Parse `PROACTIVE:` with multiple templates and triggers
- U-41: Parse `RATE_LIMIT:` with per-contact and per-channel limits
- U-42: Parse `CHANNEL_PREFERENCE:` ordered list
- U-43: Parse trigger with `CONDITION:` expression
- U-44: Parse trigger with `CONTACT_RESOLVER:` expression
- U-45: Error on `PROACTIVE:` without templates
- U-46: Error on trigger referencing non-existent template
- U-47: Parse template with `FORMATS:` sub-block
- U-48: Parse template with `ACTIONS:` sub-block

### IR Compiler (6 tests)

- U-49: Compile `ProactiveConfigAST` to `ProactiveConfigIR` (snake_case conversion)
- U-50: Compile templates with rich content
- U-51: Compile triggers with conditions
- U-52: Compile rate limits
- U-53: Compile channel preference array
- U-54: Validation error for invalid cron expression in trigger

### ProactiveMessageService (8 tests)

- U-1: Create message with valid input
- U-2: Reject message with non-existent agent
- U-3: Reject message with non-existent contact
- U-4: Reject message when contact has no channel addresses
- U-5: Channel resolution returns preferred channel
- U-6: Channel resolution falls back when preferred unavailable
- U-7: Channel resolution returns `CONTACT_UNREACHABLE` when no channels
- U-8: Session creation with `initiator: "agent"` metadata

### ConsentService (5 tests)

- U-31: Get consent for contact+channel pair
- U-32: Update consent with audit trail entry
- U-33: Default to `pending` for unknown consent
- U-34: Block delivery for opted-out consent
- U-35: Allow delivery for opted-in consent

### ProactiveRateLimiter (4 tests)

- U-21: Allow within limit
- U-22: Block when exceeded
- U-23: Calculate correct retry-after duration
- U-24: Different limits for different granularities (tenant vs contact)

### Delivery Worker (6 tests)

- U-25: Process job successfully
- U-26: Retry on transient error (5xx)
- U-27: Fail immediately on permanent error (4xx)
- U-28: Route to DLQ after max retries
- U-29: Update message status on success
- U-30: Update message status on failure

### Schedule & Trigger (10 tests)

- U-11: Create schedule with valid cron
- U-12: Reject invalid cron expression
- U-13: Pause/resume schedule
- U-14: Execute schedule resolves contacts
- U-15: Schedule execution respects `maxPerExecution` limit
- U-16: Create trigger with valid event type
- U-17: Reject trigger with unknown event type
- U-18: Evaluate trigger condition — match
- U-19: Evaluate trigger condition — no match
- U-20: Resolve contact from trigger expression

---

## 5. Test Infrastructure Requirements

### Server Setup

```typescript
// E2E test setup pattern
const app = createExpressApp({
  middleware: [createUnifiedAuthMiddleware(), rateLimitMiddleware(), tenantIsolationMiddleware()],
});

// Start on random port
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://localhost:${port}`;
```

### Mock Channel Endpoints

For E2E tests, channel delivery is verified via mock HTTP endpoints (not by mocking codebase adapters):

```typescript
// Mock Slack webhook server
const slackMock = createMockServer((req, res) => {
  capturedMessages.push(req.body);
  res.status(200).json({ ok: true });
});

// Mock SMTP relay (use a test SMTP server like ethereal.email or a local mock)
const emailMock = createMockSMTPServer();
```

### Data Seeding

All test data seeded via API (not direct DB access):

```typescript
// Seed via API
const agent = await api.post(`/api/projects/${projectId}/agents`, { name: 'notifier', dsl: '...' });
const contact = await api.post(`/api/projects/${projectId}/contacts`, {
  name: 'John',
  email: 'john@test.com',
});
const consent = await api.put(`/api/projects/${projectId}/contacts/${contact.id}/consent/email`, {
  status: 'opted_in',
});
```

### Auth Context

```typescript
// Generate valid JWT for test tenant
const token = generateTestJWT({
  tenantId: testTenantId,
  userId: testUserId,
  permissions: ['proactive:read', 'proactive:write', 'contacts:read', 'contacts:write'],
});
```

---

## 6. Quality Gates

| Gate                   | Criteria                                      | Blocking |
| ---------------------- | --------------------------------------------- | -------- |
| E2E pass rate          | 100% (all 10 scenarios)                       | Yes      |
| Integration pass rate  | 100% (all 13 scenarios)                       | Yes      |
| Unit test coverage     | > 80% line coverage for new code              | Yes      |
| No mocking of codebase | Zero `vi.mock()` / `jest.mock()` in E2E tests | Yes      |
| API-only interaction   | Zero direct DB queries in E2E tests           | Yes      |
| Consent compliance     | Zero deliveries to opted-out contacts         | Yes      |
| Tenant isolation       | Cross-tenant access returns 404               | Yes      |
| Auth enforcement       | Unauthenticated requests return 401           | Yes      |

---

## 7. Iteration Log

| Iteration  | Date | Tests Run | Passed | Failed | Notes |
| ---------- | ---- | --------- | ------ | ------ | ----- |
| (none yet) | —    | —         | —      | —      | —     |
