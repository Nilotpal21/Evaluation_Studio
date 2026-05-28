# Test Specification: Feedback System

**Feature Spec**: `docs/features/feedback.md`
**HLD**: `docs/specs/feedback.hld.md`
**LLD (in-chat WS capture)**: `docs/plans/2026-05-14-feedback-capture-impl-plan.md`
**Prior LLD (REST, deferred)**: `docs/plans/2026-03-23-feedback-impl-plan.md`
**Status**: PARTIAL — WS capture path PASS, REST path DEFERRED
**Last Updated**: 2026-05-14

---

## 1. Coverage Matrix

| FR    | Description                                                  | Unit | Integration | E2E          | Manual | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------ | ---- | ----------- | ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | POST /api/projects/:projectId/feedback accepts feedback      | UT-1 | INT-1       | E2E-1        | --     | DEFERRED (REST path not in V1 scope — ABLP-1068 ships WS only)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| FR-2  | Validate ratingType and ratingValue ranges                   | UT-2 | --          | E2E-9        | --     | **PASS** — `apps/runtime/src/services/feedback/__tests__/types.test.ts` (30 cases)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FR-3  | Auth via createUnifiedAuthMiddleware + requireProjectScope   | --   | INT-2       | E2E-7        | --     | DEFERRED (REST-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-4  | Deduplicate per (sessionId, messageId, userId)               | UT-3 | INT-3       | E2E-3        | --     | **PASS** — WS path uses Redis SETNX (`feedback-service.ts` + `dedup.ts`). Wire-level shape differs from FR-1 (`feedback.ack { success:false, error.code:'DUPLICATE_FEEDBACK' }` instead of HTTP 409). Read-side `argMax(feedback_id) GROUP BY (tenant_id, session_id, message_id, user_id)` is the backstop when Redis is unavailable (soft-allow). Tests: `dedup.test.ts`, `feedback-service.test.ts`, `feedback-ws-handler.integration.test.ts`, `feedback-capture-public-surface.test.ts:E2E-4`. |
| FR-5  | Emit feedback.submitted trace event                          | UT-4 | INT-4       | --           | --     | **PASS** — direct `getEventStore().emitter.emit(...)` (not via `TRACE_TO_PLATFORM_TYPE`). TraceStore broadcast is a parallel non-durable path. Tests: `feedback-service.test.ts` (PII-minimisation assertions).                                                                                                                                                                                                                                                                                     |
| FR-6  | Insert into ClickHouse feedback table                        | --   | INT-1       | E2E-4        | --     | **PASS** — `BufferedClickHouseWriter` + `getClickHouseEncryptionInterceptor()`. Tests: `feedback-service.test.ts` (encryption + plaintext routing), `feedback-capture-public-surface.test.ts:E2E-1`.                                                                                                                                                                                                                                                                                                |
| FR-7  | Email CSAT endpoint unchanged                                | UT-5 | --          | E2E-5        | --     | PASS (existing — pre-ABLP-1068)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| FR-8  | WebSocket feedback.submit message handler                    | UT-6 | INT-5       | E2E-1..E2E-7 | --     | **PASS** — full surface tested via `feedback-ws-handler.integration.test.ts` (12 cases) + `feedback-capture-public-surface.test.ts` (7 cases) + SDK side `chat-client-feedback.test.ts` (9 cases).                                                                                                                                                                                                                                                                                                  |
| FR-9  | GET /feedback/stats and GET /feedback/recent endpoints       | UT-7 | INT-6       | E2E-4        | --     | DEFERRED (ABLP-988 consumer ticket)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| FR-10 | Rate limit 10/min per user                                   | --   | INT-7       | E2E-10       | --     | DEFERRED (REST-only middleware)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| FR-11 | Standard envelope format { success, data/error }             | UT-8 | --          | E2E-1        | --     | **PASS for WS** — ack uses the WS envelope `{ type: 'feedback.ack', success, feedbackId? \| error: { code, message } }` (LLD §2.3), not the REST `{ success, data \| error }` envelope. Tested in `feedback-ws-handler.integration.test.ts` (ServerMessages.feedbackAck constructor cases).                                                                                                                                                                                                         |
| FR-12 | Validate target message belongs to session                   | UT-9 | INT-8       | E2E-8        | --     | **PASS** — `messageStore.getMessageById(tenantId, projectId, sessionId, messageId)` enforces full scope. Cross-tenant / project / session lookups return `null` → `INVALID_TARGET`. Tests: `feedback-service.test.ts`, `feedback-capture-public-surface.test.ts:E2E-2`.                                                                                                                                                                                                                             |
| FR-13 | Target message ownership validation                          | --   | --          | --           | --     | **PASS** — see FR-12. Also asserts `role === 'assistant'` (user/system messages → `INVALID_TARGET`).                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-14 | Durable EventStore emission (PII-minimised)                  | --   | --          | --           | --     | **PASS** — `feedback-service.test.ts` "runs EventStore + TraceStore emits through scrubSecrets — never sends raw feedback_text".                                                                                                                                                                                                                                                                                                                                                                    |
| FR-15 | Persisted message id binding                                 | --   | --          | --           | --     | **PASS** — Mongo `_id`, CH `message_id`, in-memory `id` all bind to transport `responseMessageId`. Tests: compiler `message-store.test.ts` (InMemory contract), `feedback-capture-public-surface.test.ts:E2E-7`.                                                                                                                                                                                                                                                                                    |
| FR-16 | action_submit(actionId='feedback') short-circuits agent loop | --   | --          | --           | --     | **PASS** — `feedback-ws-handler.integration.test.ts` (action_submit branch tests) + `feedback-capture-public-surface.test.ts:E2E-6` (asserts payloads.length === 1, only ack).                                                                                                                                                                                                                                                                                                                      |
| FR-17 | PII storage policy                                           | --   | --          | --           | --     | **PASS** — raw `feedback_text` only in CH `feedback.feedback_text` (encrypted via interceptor). `platform_events.data` and TraceStore event carry `has_feedback_text` + `feedback_text_length` only. Tests: `feedback-service.test.ts` (PII path) + `feedback-capture-public-surface.test.ts:E2E-3`.                                                                                                                                                                                                |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks of codebase components, no direct DB access, no stubbed servers. Only external third-party services (ClickHouse client, LLM providers) may be mocked via dependency injection.

### E2E-1: Submit thumbs-up feedback and verify success response

- **Preconditions**: Runtime server running on random port. Authenticated user with project membership. Active session with at least one agent message.
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` with Bearer token, body: `{ "sessionId": "<session-id>", "messageId": "<message-id>", "ratingType": "thumbs", "ratingValue": 1 }`
  2. Assert HTTP 201 response
  3. Assert response body matches `{ "success": true, "data": { "feedbackId": "<uuid>" } }`
- **Expected Result**: 201 Created with feedbackId in standard envelope format
- **Auth Context**: Valid tenant + project membership + user session
- **Isolation Check**: N/A (happy path)

### E2E-2: Submit star rating with text comment

- **Preconditions**: Runtime server running. Authenticated user with project membership. Active session.
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` with Bearer token, body: `{ "sessionId": "<session-id>", "messageId": "<message-id>", "ratingType": "star", "ratingValue": 4, "feedbackText": "Very helpful response, resolved my issue quickly." }`
  2. Assert HTTP 201 response
  3. Assert response body contains `feedbackId`
  4. `GET /api/projects/:projectId/feedback/recent?limit=1` with Bearer token
  5. Assert the most recent feedback entry has `ratingType: "star"`, `ratingValue: 4`, and `feedbackText` present
- **Expected Result**: Feedback stored and queryable via recent endpoint
- **Auth Context**: Valid tenant + project membership + user session
- **Isolation Check**: N/A (happy path with round-trip verification)

### E2E-3: Duplicate feedback returns 409 Conflict

- **Preconditions**: Runtime server running. Authenticated user. One feedback already submitted for (sessionId, messageId, userId).
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` with body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "thumbs", "ratingValue": 1 }`
  2. Assert HTTP 201 (first submission)
  3. `POST /api/projects/:projectId/feedback` with same body (same sessionId, messageId, same user)
  4. Assert HTTP 409 response
  5. Assert response body: `{ "success": false, "error": { "code": "DUPLICATE_FEEDBACK", "message": "..." } }`
- **Expected Result**: Second submission rejected with 409; first feedback unchanged
- **Auth Context**: Same authenticated user for both requests
- **Isolation Check**: Dedup is per-user -- different userId for same message should succeed

### E2E-4: Submit feedback then query stats and verify counts

- **Preconditions**: Runtime server running. Empty feedback state for the project. Authenticated user.
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` -- thumbs up (value=1) for message M1
  2. `POST /api/projects/:projectId/feedback` -- thumbs down (value=0) for message M2
  3. `POST /api/projects/:projectId/feedback` -- star rating (value=5) for message M3
  4. `GET /api/projects/:projectId/feedback/stats?from=<1h-ago>&to=<now>`
  5. Assert stats contain: `totalCount >= 3`, `thumbsUpCount >= 1`, `thumbsDownCount >= 1`, `starCount >= 1`, `averageStarRating == 5.0`
- **Expected Result**: Stats endpoint returns correct aggregated metrics
- **Auth Context**: Valid tenant + project membership
- **Isolation Check**: Stats only include feedback for this project

### E2E-5: Email CSAT endpoint backward compatibility

- **Preconditions**: Runtime server running. JWT_SECRET configured.
- **Steps**:
  1. Generate a valid feedback token using the JWT signing logic with payload: `{ tenantId: "t1", projectId: "p1", sessionId: "s1", messageId: "m1", connectionId: "c1" }`
  2. `GET /api/v1/feedback/<token>?rating=4`
  3. Assert HTTP 200 with HTML content containing "Thank you"
  4. `GET /api/v1/feedback/<token>?rating=4` (duplicate)
  5. Assert HTTP 200 with HTML content containing "already been recorded" (Redis dedup)
- **Expected Result**: Email CSAT endpoint works unchanged with token auth and Redis dedup
- **Auth Context**: No auth required (JWT token IS authorization)
- **Isolation Check**: Invalid/tampered token returns 404

### E2E-6: Cross-tenant feedback isolation (tenant A cannot see tenant B data)

- **Preconditions**: Runtime server running. Two tenants (A and B) with separate projects. Tenant A has feedback submitted.
- **Steps**:
  1. As Tenant A user: `POST /api/projects/:projectIdA/feedback` -- submit feedback
  2. As Tenant A user: `GET /api/projects/:projectIdA/feedback/stats` -- verify feedback visible
  3. As Tenant B user: `GET /api/projects/:projectIdA/feedback/stats` -- attempt to access Tenant A's project
  4. Assert HTTP 404 (NOT 403 -- do not leak resource existence)
- **Expected Result**: Cross-tenant access returns 404
- **Auth Context**: Tenant B Bearer token targeting Tenant A's projectId
- **Isolation Check**: PRIMARY -- validates tenant isolation at API layer

### E2E-7: Unauthenticated request returns 401

- **Preconditions**: Runtime server running.
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` with no Authorization header, body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "thumbs", "ratingValue": 1 }`
  2. Assert HTTP 401 response
  3. `GET /api/projects/:projectId/feedback/stats` with no Authorization header
  4. Assert HTTP 401 response
  5. `GET /api/projects/:projectId/feedback/recent` with no Authorization header
  6. Assert HTTP 401 response
- **Expected Result**: All authenticated endpoints return 401 without valid Bearer token
- **Auth Context**: None (no token)
- **Isolation Check**: Auth middleware blocks before any data access

### E2E-8: Session-project mismatch returns 400

- **Preconditions**: Runtime server running. Session S1 belongs to Project A.
- **Steps**:
  1. `POST /api/projects/:projectIdB/feedback` with body: `{ "sessionId": "S1", "messageId": "m1", "ratingType": "thumbs", "ratingValue": 1 }` (S1 belongs to Project A, submitting under Project B)
  2. Assert HTTP 400 or 404
  3. Assert error: session does not belong to this project
- **Expected Result**: Cross-project session reference rejected
- **Auth Context**: Valid auth for Project B, but session belongs to Project A
- **Isolation Check**: Validates FR-12 session-project binding

### E2E-9: Invalid rating values rejected with 400

- **Preconditions**: Runtime server running. Authenticated user.
- **Steps**:
  1. `POST /api/projects/:projectId/feedback` with body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "thumbs", "ratingValue": 5 }` (thumbs only allows 0 or 1)
  2. Assert HTTP 400 with validation error
  3. `POST /api/projects/:projectId/feedback` with body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "star", "ratingValue": 6 }` (star allows 1-5)
  4. Assert HTTP 400 with validation error
  5. `POST /api/projects/:projectId/feedback` with body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "text" }` (text requires feedbackText)
  6. Assert HTTP 400 with validation error about missing feedbackText
  7. `POST /api/projects/:projectId/feedback` with body: `{ "sessionId": "s1", "messageId": "m1", "ratingType": "invalid_type", "ratingValue": 1 }`
  8. Assert HTTP 400 with validation error about invalid ratingType
- **Expected Result**: All invalid rating combinations rejected with 400 and descriptive error
- **Auth Context**: Valid auth
- **Isolation Check**: N/A (validation test)

### E2E-10: Rate limit enforcement (11th request returns 429)

- **Preconditions**: Runtime server running. Authenticated user. Rate limit configured to 10/min.
- **Steps**:
  1. Submit 10 valid feedback requests (each with unique messageId) rapidly
  2. Assert all 10 return 201
  3. Submit 11th feedback request
  4. Assert HTTP 429 Too Many Requests
- **Expected Result**: Rate limiting enforced per user
- **Auth Context**: Same authenticated user for all requests
- **Isolation Check**: Different users should have independent rate limits

### E2E-11: Recent feedback with pagination

- **Preconditions**: Runtime server running. At least 15 feedback entries submitted for the project.
- **Steps**:
  1. `GET /api/projects/:projectId/feedback/recent?limit=5&offset=0`
  2. Assert 200, response contains exactly 5 entries, ordered by timestamp descending
  3. `GET /api/projects/:projectId/feedback/recent?limit=5&offset=5`
  4. Assert 200, response contains next 5 entries (no overlap with page 1)
  5. `GET /api/projects/:projectId/feedback/recent?limit=5&offset=10`
  6. Assert 200, response contains next 5 entries
  7. Verify no entry appears in multiple pages
- **Expected Result**: Pagination works correctly with no duplicates or gaps
- **Auth Context**: Valid auth for the project
- **Isolation Check**: Only feedback for this project appears

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Feedback service writes record to ClickHouse feedback table

- **Boundary**: FeedbackService -> ClickHouse client
- **Setup**: ClickHouse client (mock or testcontainer). FeedbackService instantiated with injected client.
- **Steps**:
  1. Call `feedbackService.submitFeedback({ tenantId: "t1", projectId: "p1", sessionId: "s1", messageId: "m1", userId: "u1", ratingType: "thumbs", ratingValue: 1, agentName: "billing-agent", channel: "websocket", source: "api" })`
  2. Verify ClickHouse `insert` was called with correct table name (`abl_platform.feedback`)
  3. Verify inserted row contains all fields: `tenant_id`, `project_id`, `feedback_id`, `session_id`, `message_id`, `user_id`, `rating_type`, `rating_value`, `agent_name`, `channel`, `source`, `timestamp`
  4. Verify `feedback_id` is a valid UUID
  5. Verify `timestamp` is within 1 second of current time
- **Expected Result**: Row inserted into ClickHouse with all fields populated correctly
- **Failure Mode**: If ClickHouse client throws, service should propagate error (503 at route level)

### INT-2: Auth middleware chain blocks unauthorized feedback submission

- **Boundary**: Express middleware chain -> feedback route handler
- **Setup**: Real Express app with full middleware chain (authMiddleware, requireProjectScope, tenantRateLimit). No DB mocks for auth -- use test tokens.
- **Steps**:
  1. Send POST with no Authorization header -> assert 401
  2. Send POST with expired/invalid Bearer token -> assert 401
  3. Send POST with valid Bearer token but user not in project -> assert 404
  4. Send POST with valid Bearer token and project membership -> assert request reaches handler (201 or subsequent validation error)
- **Expected Result**: Auth middleware chain executes in correct order, blocking unauthorized requests before reaching business logic
- **Failure Mode**: If auth middleware is missing, unauthorized requests reach the feedback handler

### INT-3: Deduplication rejects second feedback for same (session, message, user)

- **Boundary**: FeedbackService -> ClickHouse (dedup check)
- **Setup**: ClickHouse client with one existing feedback record for (s1, m1, u1).
- **Steps**:
  1. Call `feedbackService.submitFeedback(...)` with sessionId=s1, messageId=m1, userId=u1
  2. Assert it throws or returns a duplicate error
  3. Call `feedbackService.submitFeedback(...)` with sessionId=s1, messageId=m1, userId=u2 (different user)
  4. Assert it succeeds (different user = different dedup key)
  5. Call `feedbackService.submitFeedback(...)` with sessionId=s1, messageId=m2, userId=u1 (different message)
  6. Assert it succeeds (different message = different dedup key)
- **Expected Result**: Dedup is strictly per (sessionId, messageId, userId) tuple
- **Failure Mode**: If dedup check is missing, duplicate submissions accepted (inflated metrics)

### INT-4: Feedback submission emits feedback.submitted trace event

- **Boundary**: FeedbackService -> TraceStore / EventEmitter
- **Setup**: FeedbackService with injected TraceStore (real or spy). ClickHouse client (mock).
- **Steps**:
  1. Call `feedbackService.submitFeedback(...)` with ratingType="star", ratingValue=4, feedbackText="Great help"
  2. Assert TraceStore.addEvent was called with event type `feedback.submitted`
  3. Assert event data matches `FeedbackSubmittedDataSchema`: `{ rating_type: "star", rating_value: 4, target_message_id: "m1", feedback_text: "Great help" }`
  4. Assert event sessionId matches the submitted sessionId
- **Expected Result**: Every feedback submission emits a properly structured trace event
- **Failure Mode**: If TraceStore is unavailable, feedback should still persist to ClickHouse (log warning, don't fail)

### INT-5: WebSocket feedback.submit message handler routes to FeedbackService

- **Boundary**: WebSocket message handler -> FeedbackService
- **Setup**: WebSocket connection with established session context (tenantId, projectId, sessionId, userId). FeedbackService (spy).
- **Steps**:
  1. Send WebSocket message: `{ "type": "feedback.submit", "payload": { "messageId": "m1", "ratingType": "thumbs", "ratingValue": 1 } }`
  2. Assert FeedbackService.submitFeedback was called with correct parameters derived from session context
  3. Assert WebSocket response/ack is sent back to client
  4. Send malformed message: `{ "type": "feedback.submit", "payload": { "messageId": "m1" } }` (missing ratingType)
  5. Assert error response sent via WebSocket (not a crash)
- **Expected Result**: WebSocket handler correctly extracts session context and delegates to FeedbackService
- **Failure Mode**: Missing fields should return error via WebSocket, not crash the connection

### INT-6: Stats query returns correct aggregations from ClickHouse

- **Boundary**: FeedbackQueryService -> ClickHouse
- **Setup**: ClickHouse client with pre-seeded feedback_daily_dest data: `{ tenant_id: "t1", project_id: "p1", agent_name: "billing", day: today, total_count: 10, thumbs_up_count: 7, thumbs_down_count: 3, star_sum: 40, star_count: 10, text_count: 2 }`
- **Steps**:
  1. Call `feedbackQueryService.getStats({ tenantId: "t1", projectId: "p1", from: yesterday, to: tomorrow })`
  2. Assert result contains: `totalCount: 10`, `thumbsUpRatio: 0.7`, `averageStarRating: 4.0`, `textFeedbackCount: 2`
  3. Call with different projectId -> assert empty/zero results
  4. Call with different tenantId -> assert empty/zero results
- **Expected Result**: Aggregation query correctly computes metrics from materialized view data
- **Failure Mode**: Wrong WHERE clause allows cross-tenant data leakage

### INT-7: Rate limiter enforces per-user feedback limits

- **Boundary**: tenantRateLimit middleware -> request handler
- **Setup**: Real Express app with rate limit middleware configured. Rate limit set to 10/min for feedback.
- **Steps**:
  1. Send 10 POST requests with same user token
  2. Assert all 10 return non-429 status
  3. Send 11th POST request with same user token
  4. Assert 429 response with standard error envelope
  5. Send POST request with different user token
  6. Assert non-429 (different user has independent limit)
- **Expected Result**: Rate limit is per-user, not global
- **Failure Mode**: If rate limit is global, legitimate users blocked when another user spams

### INT-8: Session-project validation rejects cross-project sessions

- **Boundary**: FeedbackService -> Session store (MongoDB)
- **Setup**: Session S1 exists in MongoDB with projectId=P1. FeedbackService instantiated with session repo access.
- **Steps**:
  1. Call `feedbackService.validateSessionProject("S1", "P1")` -> assert returns true
  2. Call `feedbackService.validateSessionProject("S1", "P2")` -> assert returns false or throws
  3. Call `feedbackService.validateSessionProject("nonexistent", "P1")` -> assert returns false or throws
- **Expected Result**: Feedback only accepted when session belongs to the specified project
- **Failure Mode**: Missing validation allows feedback injection into wrong project's analytics

---

## 4. Unit Test Scenarios

### UT-1: Feedback request body Zod validation

- **Module**: Feedback API route Zod schemas
- **Input**: Various request bodies with valid and invalid fields
- **Expected Output**:
  - Valid: `{ sessionId: "s1", messageId: "m1", ratingType: "thumbs", ratingValue: 1 }` -> passes
  - Invalid ratingType: `{ ..., ratingType: "emoji" }` -> ZodError
  - Missing required field: `{ messageId: "m1", ratingType: "thumbs" }` -> ZodError (sessionId missing)
  - Empty string IDs: `{ sessionId: "", messageId: "m1", ... }` -> ZodError (`z.string().min(1)`)

### UT-2: Rating value range validation per type

- **Module**: Feedback validation logic
- **Input/Expected**:
  - `thumbs` + `ratingValue: 0` -> valid
  - `thumbs` + `ratingValue: 1` -> valid
  - `thumbs` + `ratingValue: 2` -> invalid
  - `thumbs` + `ratingValue: -1` -> invalid
  - `star` + `ratingValue: 1` -> valid
  - `star` + `ratingValue: 5` -> valid
  - `star` + `ratingValue: 0` -> invalid
  - `star` + `ratingValue: 6` -> invalid
  - `star` + `ratingValue: 3.5` -> valid (allow half-stars) or invalid (integers only) -- per design decision
  - `text` + `feedbackText: "Great"` -> valid (ratingValue ignored)
  - `text` + no feedbackText -> invalid

### UT-3: Dedup key generation

- **Module**: FeedbackService dedup logic
- **Input**: `{ sessionId: "s1", messageId: "m1", userId: "u1" }`
- **Expected**: Dedup key is deterministic and unique per tuple. Same inputs always produce same key.

### UT-4: Trace event data construction from feedback input

- **Module**: FeedbackService event builder
- **Input**: `{ ratingType: "star", ratingValue: 4, messageId: "m1", feedbackText: "Helpful" }`
- **Expected**: Event data matches `FeedbackSubmittedDataSchema`: `{ rating_type: "star", rating_value: 4, target_message_id: "m1", feedback_text: "Helpful" }`

### UT-5: Email CSAT token sign/verify (existing tests)

- **Module**: `feedback-token.ts`
- **Status**: PASS -- 4 existing tests cover sign, verify, tampered token, wrong purpose

### UT-6: WebSocket feedback.submit message parsing

- **Module**: WebSocket message handler
- **Input**: Raw WebSocket message JSON with `type: "feedback.submit"`
- **Expected**: Correctly parses `messageId`, `ratingType`, `ratingValue`, `feedbackText` from payload

### UT-7: Stats query parameter construction

- **Module**: FeedbackQueryService
- **Input**: `{ tenantId: "t1", projectId: "p1", from: "2026-03-01", to: "2026-03-23", agentName: "billing" }`
- **Expected**: ClickHouse query includes `WHERE tenant_id = 't1' AND project_id = 'p1'` and date range filter. Optional agentName filter applied correctly.

### UT-8: Response envelope formatting

- **Module**: Feedback API route response builder
- **Input**: Success with feedbackId; failure with validation error
- **Expected**:
  - Success: `{ success: true, data: { feedbackId: "uuid" } }`
  - Failure: `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }`

### UT-9: Session-project binding validation logic

- **Module**: FeedbackService session validation
- **Input**: sessionId and projectId
- **Expected**: Returns true only when session.projectId matches the provided projectId

---

## 5. Security & Isolation Tests

### Tenant Isolation

- [x] Cross-tenant feedback stats access returns 404 (not 403) -- E2E-6
- [ ] Cross-tenant feedback recent access returns 404 -- similar to E2E-6
- [ ] ClickHouse queries always include `tenant_id` in WHERE clause -- INT-6

### Project Isolation

- [ ] Cross-project feedback access returns 404 -- E2E-6 variant with same tenant, different project
- [ ] Session-project mismatch rejected -- E2E-8, INT-8
- [ ] Stats only include feedback for the queried project -- E2E-4, INT-6

### User Isolation

- [ ] Dedup key includes userId -- users can rate the same message independently -- INT-3
- [ ] Users can only submit feedback in sessions they participate in (session membership check)

### Auth & Permissions

- [ ] Missing auth returns 401 -- E2E-7
- [ ] Expired/invalid token returns 401 -- INT-2
- [ ] Email CSAT invalid/tampered token returns 404 -- E2E-5

### Input Validation

- [ ] Invalid ratingType rejected -- E2E-9
- [ ] Out-of-range ratingValue rejected -- E2E-9
- [ ] Empty string IDs rejected (z.string().min(1)) -- UT-1
- [ ] Missing required fields rejected -- UT-1
- [ ] Text feedback without feedbackText rejected -- E2E-9

### Rate Limiting

- [ ] 10/min per user enforced -- E2E-10, INT-7
- [ ] Different users have independent limits -- INT-7
- [ ] Rate limit response uses standard error envelope -- E2E-10

---

## 6. Performance & Load Tests (if applicable)

| Scenario                                   | Target      | Tool                |
| ------------------------------------------ | ----------- | ------------------- |
| Feedback write throughput (100 concurrent) | < 50ms p99  | k6 or custom script |
| Stats query latency (90-day range)         | < 200ms p99 | supertest loop      |
| Recent query latency (page of 50)          | < 100ms p99 | supertest loop      |
| Email CSAT endpoint latency                | < 100ms p99 | supertest loop      |

Performance tests are run manually or in CI staging, not as part of the standard test suite. Benchmarks live in `benchmarks/` directory.

---

## 7. Test Infrastructure

### Required Services

| Service    | Purpose                       | Test Configuration                                       |
| ---------- | ----------------------------- | -------------------------------------------------------- |
| Runtime    | API server under test         | Express on random port (`{ port: 0 }`)                   |
| ClickHouse | Feedback storage              | Mock via `createMockClickHouseClient()` or testcontainer |
| Redis      | Email CSAT dedup              | Mock or real (test-specific Redis instance)              |
| MongoDB    | Session lookup for validation | MongoMemoryServer or mock session repo                   |

### Data Seeding

| Seed                          | Purpose                                | Method                                    |
| ----------------------------- | -------------------------------------- | ----------------------------------------- |
| Test tenant + project         | Auth context for all requests          | In-memory or fixture setup                |
| Test session with messages    | Valid sessionId/messageId for feedback | POST to session API or mock store         |
| Pre-existing feedback entries | Stats and pagination tests             | Direct ClickHouse insert or service calls |
| Multiple tenants/projects     | Isolation tests                        | Separate auth contexts                    |

### Environment Variables

| Variable         | Test Value                            |
| ---------------- | ------------------------------------- |
| `JWT_SECRET`     | `test-secret-for-feedback`            |
| `REDIS_URL`      | `redis://localhost:6379/15` (test DB) |
| `CLICKHOUSE_URL` | Mock or `http://localhost:8123`       |
| `NODE_ENV`       | `test`                                |

### CI Configuration

- Unit tests: Run in every CI build (`pnpm test --filter=runtime`)
- Integration tests: Run in CI with Docker services (ClickHouse, Redis, MongoDB)
- E2E tests: Run in CI staging environment or with full Docker Compose

---

## 8. Test File Mapping

| Test File                                                              | Type        | Covers                                                                                                           |
| ---------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/email/feedback-token.test.ts`              | unit        | FR-7 (UT-5) -- existing                                                                                          |
| `apps/runtime/src/__tests__/email/feedback-endpoint.test.ts`           | unit        | FR-7 (email endpoint) -- existing                                                                                |
| `apps/runtime/src/__tests__/feedback/feedback-validation.test.ts`      | unit        | FR-2 (UT-1, UT-2), FR-11 (UT-8)                                                                                  |
| `apps/runtime/src/__tests__/feedback/feedback-service.test.ts`         | unit        | FR-4 (UT-3), FR-5 (UT-4), FR-12 (UT-9)                                                                           |
| `apps/runtime/src/__tests__/feedback/feedback-query.test.ts`           | unit        | FR-9 (UT-7)                                                                                                      |
| `apps/runtime/src/__tests__/feedback/feedback-ws.test.ts`              | unit        | FR-8 (UT-6)                                                                                                      |
| `apps/runtime/src/__tests__/feedback/feedback-api.integration.test.ts` | integration | FR-1 (INT-1), FR-3 (INT-2), FR-4 (INT-3), FR-5 (INT-4), FR-8 (INT-5), FR-9 (INT-6), FR-10 (INT-7), FR-12 (INT-8) |
| `apps/runtime/src/__tests__/e2e/feedback-e2e.test.ts`                  | e2e         | E2E-1 through E2E-11                                                                                             |
| `apps/studio/src/__tests__/feedback-tab.test.tsx`                      | unit        | Studio FeedbackTab component rendering                                                                           |

---

## 9. Open Testing Questions

1. Should integration tests use a real ClickHouse testcontainer or the existing `createMockClickHouseClient()` helper? Real ClickHouse would catch query syntax errors but adds CI complexity.
2. Should WebSocket feedback E2E tests (E2E-11) use a real WebSocket connection or be deferred to manual testing? The WebSocket test infrastructure is complex.
3. How should test sessions be seeded -- via the session API (real E2E) or via a test fixture that inserts directly into the session store?
4. Should the rate limit test (E2E-10) use a lower limit in test configuration (e.g., 3/min) to avoid needing 11 sequential requests?
5. Should performance tests be automated in CI or remain manual? Current benchmarks in `benchmarks/` are manual.
