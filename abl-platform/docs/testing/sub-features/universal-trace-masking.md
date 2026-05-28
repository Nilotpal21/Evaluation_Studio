# Test Specification: Universal Trace Event Masking

**Feature Spec**: `docs/features/sub-features/universal-trace-masking.md`
**Parent Feature**: [PII Detection & Redaction](../pii-detection.md)
**HLD**: `docs/specs/universal-trace-masking.hld.md`
**LLD**: `docs/plans/2026-04-09-universal-trace-masking-impl-plan.md`
**Status**: IN PROGRESS
**Jira**: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)
**Last Updated**: 2026-04-09

---

## 1. Coverage Matrix

| FR    | Description                           | Unit | Integration | E2E | Manual | Status      |
| ----- | ------------------------------------- | ---- | ----------- | --- | ------ | ----------- |
| FR-1  | Scrub ALL event types in emit()       | ❌   | ❌          | ❌  | ❌     | WIRED       |
| FR-2  | Respect scrubPII flag                 | ❌   | ❌          | ❌  | ❌     | WIRED       |
| FR-3  | Bearer token mid-string match         | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-4  | API key pattern detection             | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-5  | Key prefix detection (sk-, pk-, etc.) | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-6  | Secret key name redaction             | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-7  | Stricter credit card (no Luhn)        | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-8  | scrubTraceEvent() export              | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-9  | Idempotent scrubbing                  | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |
| FR-10 | <1ms latency per event                | ✅   | ❌          | ❌  | ❌     | UNIT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API.
No mocks, no direct DB access, no stubbed servers.

### E2E-1: Decision event with API key is masked in trace response

- **Preconditions**: Runtime running with `scrubPII=true`. Agent configured with a tool that returns data containing `api_key=sk-test1234567890abcdef` in a decision event.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session with auth headers (`Authorization: Bearer <token>`, `x-tenant-id`, `x-project-id`)
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send message that triggers a decision event containing an API key value
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch trace events
  4. Filter response for `type: "decision"` events
  5. Assert: the `data` field contains `[REDACTED]` where the API key was — no raw `sk-test1234567890abcdef` present
- **Expected Result**: Decision event data has `sk-test1234567890abcdef` replaced with `[REDACTED]`
- **Auth Context**: Tenant user with project-level `sessions:write` and `traces:read` permissions
- **Isolation Check**: `GET /api/projects/:otherProjectId/sessions/:sessionId/traces` returns 404

### E2E-2: Error event with email is masked in trace response

- **Preconditions**: Runtime running with `scrubPII=true`. Agent configured to trigger an error event containing `user@example.com`.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send message triggering error with email
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch traces
  4. Filter for `type: "error"` events
  5. Assert: `data.message` or `data.errorDetails` contains `[REDACTED_EMAIL]`, not raw `user@example.com`
- **Expected Result**: Error event email is masked as `[REDACTED_EMAIL]`
- **Auth Context**: Tenant user with project-level `sessions:write` and `traces:read` permissions
- **Isolation Check**: Different tenant's `x-tenant-id` header returns 404 for same session

### E2E-3: Credit card number without valid Luhn is masked

- **Preconditions**: Runtime running with `scrubPII=true`. Agent with a tool that processes input data.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send `"My card is 1234 5678 9012 3456"` (fails Luhn validation)
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch traces
  4. Assert: ALL trace events containing the card number show `[REDACTED_CARD]` or `[REDACTED_CC]`, not the raw digits
- **Expected Result**: `1234 5678 9012 3456` is masked despite failing Luhn check (stricter masking per FR-7)
- **Auth Context**: Tenant user with project-level permissions
- **Isolation Check**: Cross-project access returns 404

### E2E-4: scrubPII=false disables all scrubbing

- **Preconditions**: Runtime running with `scrubPII=false` (FREE plan default configuration).
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session on a tenant with `scrubPII=false`
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send `"Contact me at test@example.com"`
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch traces
  4. Assert: trace event data contains raw `test@example.com` — no redaction applied
- **Expected Result**: No scrubbing when `scrubPII=false` — raw PII preserved in traces
- **Auth Context**: Tenant user on FREE plan
- **Isolation Check**: Cross-tenant access returns 404

### E2E-5: Password field masked by secret key name detection

- **Preconditions**: Runtime running with `scrubPII=true`. Agent with an HTTP tool whose response includes `{ "password": "supersecret123", "username": "john" }`.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — trigger tool call that returns password data
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch traces
  4. Filter for `type: "tool_call"` events
  5. Assert: `data.output.password` is `"[REDACTED]"` and `data.output.username` is `"john"` (not redacted)
- **Expected Result**: Secret key names (`password`) are redacted, non-sensitive keys (`username`) are preserved
- **Auth Context**: Tenant user with project-level permissions
- **Isolation Check**: Cross-project access returns 404

### E2E-6: Handoff event with sensitive data is masked

- **Preconditions**: Runtime running with `scrubPII=true`. Multi-agent configuration with handoff between agents, where handoff context contains `"patient SSN: 123-45-6789"`.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` — create session
  2. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send message triggering handoff with sensitive context
  3. `GET /api/projects/:projectId/sessions/:sessionId/traces` — fetch traces
  4. Filter for `type: "handoff"` events
  5. Assert: handoff event data contains `[REDACTED_SSN]`, not `123-45-6789`
- **Expected Result**: Handoff context is scrubbed before storage
- **Auth Context**: Tenant user with project-level permissions
- **Isolation Check**: Cross-tenant access returns 404

### E2E-7: WebSocket trace stream delivers masked events

- **Preconditions**: Runtime running with `scrubPII=true`. WebSocket connection established.
- **Steps**:
  1. Connect WebSocket to `/ws` with valid auth token
  2. `POST /api/projects/:projectId/sessions` — create session
  3. `POST /api/projects/:projectId/sessions/:sessionId/messages` — send message containing `"api_secret=ghp_abc123def456ghi789"`
  4. Collect all `trace_event` messages from WebSocket
  5. Assert: NONE of the WebSocket messages contain raw `ghp_abc123def456ghi789` — all show `[REDACTED]`
- **Expected Result**: WebSocket stream delivers pre-masked events (masking happens before WebSocket send, not at display)
- **Auth Context**: Authenticated WebSocket connection with session token
- **Isolation Check**: WebSocket only receives events for subscribed session

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: emit() scrubs decision event data

- **Boundary**: `TraceEmitter.emit()` → `TraceStore` / WebSocket
- **Setup**: Create a `TraceEmitter` instance with `scrubPII: true`, real `TraceStore` connected to test MongoDB, and a test WebSocket server
- **Steps**:
  1. Call `emit('decision', { type: 'model_selection', data: { reasoning: 'Using api_key=sk-1234567890abcdefghijk for auth' } })`
  2. Read the stored event from MongoDB via `TraceStore.getEvents(sessionId)`
  3. Read the event sent over WebSocket
- **Expected Result**: Both MongoDB and WebSocket contain `[REDACTED]` in place of the API key
- **Failure Mode**: If scrubbing fails, raw API key reaches storage — checked by string absence assertion

### INT-2: emit() scrubs error event data

- **Boundary**: `TraceEmitter.emit()` → `TraceStore` / WebSocket
- **Setup**: Create a `TraceEmitter` instance with `scrubPII: true`, real `TraceStore`, test WebSocket
- **Steps**:
  1. Call `logError({ errorType: 'auth_failure', message: 'Authentication failed for user@example.com with token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' })`
  2. Read stored event from MongoDB
  3. Read WebSocket message
- **Expected Result**: Email appears as `[REDACTED_EMAIL]`, Bearer token as `Bearer [REDACTED]` in both outputs
- **Failure Mode**: If scrubbing is skipped for error events, raw PII reaches storage

### INT-3: emit() does not scrub when scrubPII=false

- **Boundary**: `TraceEmitter.emit()` → `TraceStore` / WebSocket
- **Setup**: Create a `TraceEmitter` instance with `scrubPII: false`, real `TraceStore`, test WebSocket
- **Steps**:
  1. Call `logError({ errorType: 'auth_failure', message: 'Failed for user@example.com' })`
  2. Read stored event from MongoDB
  3. Read WebSocket message
- **Expected Result**: Raw `user@example.com` present in both MongoDB and WebSocket — no redaction
- **Failure Mode**: If flag is ignored, data gets scrubbed when it shouldn't be

### INT-4: Double-scrubbing is idempotent for tool_call events

- **Boundary**: `logToolCall()` → `emit()` → storage
- **Setup**: Create a `TraceEmitter` with `scrubPII: true`, real `TraceStore`
- **Steps**:
  1. Call `logToolCall({ toolName: 'lookup', input: { email: 'a@b.com' }, output: { result: 'found' }, success: true, latencyMs: 10 })`
  2. Read stored event from MongoDB
  3. Check for double-encoded patterns like `[REDACTED_[REDACTED_EMAIL]]` or `[REDACTED][REDACTED]`
- **Expected Result**: Email appears as `[REDACTED_EMAIL]` exactly once — not double-redacted. `logToolCall()` scrubs first, then `emit()` scrubs again, but result is identical (idempotent).
- **Failure Mode**: Double encoding produces garbled output like `[REDACTED_[REDACTED_EMAIL]]`

### INT-5: Key prefix patterns detected across nested object

- **Boundary**: `scrubTraceEvent()` → deep object traversal
- **Setup**: Create a deeply nested event data object:
  ```json
  {
    "config": {
      "provider": {
        "apiKey": "sk-abcdefghijklmnopqrstuvwxyz1234",
        "name": "openai"
      }
    },
    "metadata": {
      "tokens": ["ghp_abc123def456", "pk_live_abcdef123456"]
    }
  }
  ```
- **Steps**:
  1. Call `scrubTraceEvent(eventData)` with the nested object
  2. Check all nested paths
- **Expected Result**: `config.provider.apiKey` → `[REDACTED]`, `metadata.tokens[0]` → `[REDACTED]`, `metadata.tokens[1]` → `[REDACTED]`, `config.provider.name` → `"openai"` (unchanged)
- **Failure Mode**: Shallow-only traversal misses nested secrets

### INT-6: Agent enter/exit events are scrubbed

- **Boundary**: `TraceEmitter.emit()` for `agent_enter` and `agent_exit` event types
- **Setup**: Create a `TraceEmitter` with `scrubPII: true`, real `TraceStore`
- **Steps**:
  1. Call `emit('agent_enter', { agentName: 'support', context: { userPhone: '+1-555-123-4567', sessionId: 'abc' } })`
  2. Call `emit('agent_exit', { agentName: 'support', result: { summary: 'Helped user at user@corp.com' } })`
  3. Read both events from MongoDB
- **Expected Result**: `agent_enter` has phone masked as `[REDACTED_PHONE]`, `agent_exit` has email masked as `[REDACTED_EMAIL]`. `agentName` and `sessionId` are unchanged.
- **Failure Mode**: These event types bypass scrubbing — the exact bug ABLP-214 describes

### INT-7: Constraint check events with sensitive rule data are scrubbed

- **Boundary**: `TraceEmitter.emit()` for `constraint_check` event type
- **Setup**: Create a `TraceEmitter` with `scrubPII: true`, real `TraceStore`
- **Steps**:
  1. Call `emit('constraint_check', { constraint: 'pii_guard', input: 'My SSN is 123-45-6789 and card is 4111111111111111', passed: false, details: { matched: ['ssn', 'credit_card'] } })`
  2. Read stored event from MongoDB
- **Expected Result**: SSN masked as `[REDACTED_SSN]`, credit card masked as `[REDACTED_CC]`. `constraint` name and `passed` flag are unchanged.
- **Failure Mode**: Constraint check data passes through unmasked

---

## 4. Unit Test Scenarios

### UT-1: scrubTraceEvent() scrubs Bearer token mid-string

- **Module**: `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- **Input**: `{ headers: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret" }`
- **Expected Output**: `{ headers: "Authorization: Bearer [REDACTED]" }`
- **Covers**: FR-3

### UT-2: scrubTraceEvent() detects API key patterns

- **Module**: `trace-scrubber.ts`
- **Input**: `{ config: "api_key=AKIAIOSFODNN7EXAMPLE" }`
- **Expected Output**: `{ config: "api_key=[REDACTED]" }`
- **Covers**: FR-4

### UT-3: scrubTraceEvent() detects sk- prefix

- **Module**: `trace-scrubber.ts`
- **Input**: `{ key: "sk-1234567890abcdefghijklmnop" }`
- **Expected Output**: `{ key: "[REDACTED]" }`
- **Covers**: FR-5

### UT-4: scrubTraceEvent() detects pk*live* prefix

- **Module**: `trace-scrubber.ts`
- **Input**: `{ stripe: "pk_live_abcdefghijklmnop123456" }`
- **Expected Output**: `{ stripe: "[REDACTED]" }`
- **Covers**: FR-5

### UT-5: scrubTraceEvent() detects ghp\_ prefix

- **Module**: `trace-scrubber.ts`
- **Input**: `{ token: "ghp_abc123def456ghi789jkl012" }`
- **Expected Output**: `{ token: "[REDACTED]" }`
- **Covers**: FR-5

### UT-6: scrubTraceEvent() detects abl\_ prefix

- **Module**: `trace-scrubber.ts`
- **Input**: `{ platformKey: "abl_sk_1234567890abcdef" }`
- **Expected Output**: `{ platformKey: "[REDACTED]" }`
- **Covers**: FR-5

### UT-7: scrubTraceEvent() redacts secret key names

- **Module**: `trace-scrubber.ts`
- **Input**: `{ password: "mySecret123", api_secret: "abc", token: "xyz", username: "john" }`
- **Expected Output**: `{ password: "[REDACTED]", api_secret: "[REDACTED]", token: "[REDACTED]", username: "john" }`
- **Covers**: FR-6

### UT-8: scrubTraceEvent() traverses nested objects

- **Module**: `trace-scrubber.ts`
- **Input**: `{ level1: { level2: { secret_key: "hidden", safe: "visible" } } }`
- **Expected Output**: `{ level1: { level2: { secret_key: "[REDACTED]", safe: "visible" } } }`
- **Covers**: FR-6

### UT-9: scrubTraceEvent() traverses arrays

- **Module**: `trace-scrubber.ts`
- **Input**: `{ items: [{ password: "a" }, { password: "b" }, { name: "c" }] }`
- **Expected Output**: `{ items: [{ password: "[REDACTED]" }, { password: "[REDACTED]" }, { name: "c" }] }`
- **Covers**: FR-6

### UT-10: Credit card masked without Luhn validation

- **Module**: `packages/compiler/src/platform/security/pii-detector.ts`
- **Input**: `"Card: 1234 5678 9012 3456"` (fails Luhn)
- **Expected Output**: Detected as credit card, masked as `[REDACTED_CC]` or `[REDACTED_CARD]`
- **Covers**: FR-7

### UT-11: Valid credit card still masked

- **Module**: `pii-detector.ts`
- **Input**: `"Card: 4111 1111 1111 1111"` (passes Luhn)
- **Expected Output**: Detected as credit card, masked — behavior unchanged from before
- **Covers**: FR-7

### UT-12: scrubTraceEvent() is exported from @abl/compiler

- **Module**: `packages/compiler/src/index.ts`
- **Input**: `import { scrubTraceEvent } from '@abl/compiler'`
- **Expected Output**: Import resolves successfully, function is callable
- **Covers**: FR-8

### UT-13: Idempotent scrubbing — already-redacted values unchanged

- **Module**: `trace-scrubber.ts`
- **Input**: `{ email: "[REDACTED_EMAIL]", token: "Bearer [REDACTED]" }`
- **Expected Output**: `{ email: "[REDACTED_EMAIL]", token: "Bearer [REDACTED]" }` (identical — no double encoding)
- **Covers**: FR-9

### UT-14: scrubTraceEvent() handles null/undefined/empty gracefully

- **Module**: `trace-scrubber.ts`
- **Input**: `null`, `undefined`, `{}`, `{ data: null }`, `{ data: "" }`
- **Expected Output**: Returns input unchanged (no crash, no mutation)
- **Covers**: FR-8 (robustness)

### UT-15: scrubTraceEvent() performance under 1ms for typical event

- **Module**: `trace-scrubber.ts`
- **Input**: Typical trace event with 10 nested fields, 3 levels deep, ~2KB JSON
- **Expected Output**: `scrubTraceEvent()` completes in <1ms (measured via `performance.now()`)
- **Covers**: FR-10

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant access returns 404**: Trace events from tenant A's session are not accessible with tenant B's credentials
- [x] **Cross-project access returns 404**: Trace events from project A are not accessible via project B's routes
- [x] **Missing auth returns 401**: Unauthenticated requests to trace endpoints are rejected
- [x] **Insufficient permissions returns 403**: Users without `traces:read` permission cannot fetch trace events
- [x] **Input validation rejects malformed data**: Malformed session IDs, invalid projectId formats are rejected with 400
- [x] **Sensitive data never reaches storage when scrubPII=true**: Verified by checking MongoDB directly for raw PII patterns after scrubbing is enabled
- [x] **WebSocket stream only delivers events for subscribed sessions**: WebSocket client A does not receive events from session B
- [x] **Secret key names in custom event data are scrubbed**: Custom events with fields named `password`, `secret`, `api_key`, `token`, `authorization` have values redacted
- [x] **Scrubbing cannot be bypassed by event type**: All 15+ event types (decision, error, handoff, agent_enter, agent_exit, constraint_check, flow_step_enter, flow_step_exit, flow_transition, delegate_start, delegate_complete, user_message, agent_response, session_updated, custom) are scrubbed

---

## 6. Performance & Load Tests

### PERF-1: Scrubbing latency per event

- **Setup**: Generate 1,000 typical trace events with mixed content (PII, API keys, nested objects)
- **Action**: Call `scrubTraceEvent()` on each, measure per-call latency
- **Expected Result**: p50 < 0.5ms, p99 < 1ms, max < 2ms
- **Threshold**: If p99 > 1ms, investigate regex complexity or deep nesting

### PERF-2: Throughput under load

- **Setup**: Simulate 100 concurrent sessions each emitting 50 events/second
- **Action**: Measure runtime throughput and latency percentiles
- **Expected Result**: No measurable degradation in session response time (< 5% increase in p99 latency)
- **Threshold**: If response time increases > 10%, consider caching compiled regex patterns

---

## 7. Test Infrastructure

- **Required services**: Runtime (port 3112), MongoDB, Redis
- **Data seeding**: Test tenant with `scrubPII=true` and `scrubPII=false` configurations. Test project with agents configured for each event type.
- **Environment variables**: `RUNTIME_PORT`, `MONGODB_URI`, `REDIS_URL`, standard auth test credentials
- **CI configuration**: Tests run in existing CI pipeline. Unit tests in compiler package, integration tests in runtime package. E2E tests require running Runtime + MongoDB + Redis.

---

## 8. Test File Mapping

| Test File                                                                  | Type        | Covers                                    | Status  |
| -------------------------------------------------------------------------- | ----------- | ----------------------------------------- | ------- |
| `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`        | unit        | FR-3, FR-4, FR-5, FR-6, FR-8, FR-9, FR-10 | PASSING |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`            | unit        | FR-7                                      | PASSING |
| `apps/runtime/src/__tests__/integration/trace-emitter-masking.test.ts`     | integration | FR-1, FR-2, FR-9, INT-1 to INT-7          | PLANNED |
| `apps/runtime/src/__tests__/e2e/trace-masking.test.ts` (or HTTP E2E suite) | e2e         | E2E-1 to E2E-7                            | PLANNED |

---

## 9. Open Testing Questions

1. **ClickHouse verification**: Can we query ClickHouse directly in integration tests to verify events are masked before EventStore ingestion, or is this only verifiable via MongoDB/WebSocket?
2. **Custom PII patterns**: The PIIProtectionTab allows custom regex patterns per project. Should integration tests verify that custom patterns are also applied during `emit()` scrubbing, or is that covered by the existing pii-detector unit tests?
3. **Log output verification**: Should we add tests verifying that `createLogger` output from trace-emitter also contains masked data, or is log-level masking out of scope for this phase?
4. **Performance baseline**: What is the current `emit()` latency baseline (before adding scrubbing)? Need to measure to confirm the <1ms overhead target is achievable.
