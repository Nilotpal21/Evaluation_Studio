# HLD: Universal Trace Event Masking

**Feature Spec**: `docs/features/sub-features/universal-trace-masking.md`
**Test Spec**: `docs/testing/sub-features/universal-trace-masking.md`
**Status**: APPROVED
**Author**: Platform Team
**Date**: 2026-04-09
**Jira**: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)

---

## Overview / Goal

Apply universal PII and secret scrubbing to ALL trace events at the single emission chokepoint (`emit()` in `trace-emitter.ts`) so that no event reaches MongoDB, ClickHouse, WebSocket, or logs with unmasked sensitive data. Enhance the trace-scrubber pattern library with API key detection, key prefix detection, and secret key name detection. Make credit card detection stricter by removing Luhn validation.

---

## 1. Problem Statement

Runtime's `trace-emitter.ts` `emit()` function is the single chokepoint through which every trace event passes before reaching MongoDB (TraceStore), ClickHouse (EventStore), and WebSocket (Studio). However, `emit()` performs **zero** scrubbing. Only two helper functions — `logToolCall()` (line 232) and `logLLMCall()` (line 203) — scrub their data before calling `emit()`. All other event types (`decision`, `error`, `handoff`, `agent_enter`, `agent_exit`, `constraint_check`, `flow_step_enter`, `flow_step_exit`, `flow_transition`, `delegate_start`, `delegate_complete`, `user_message`, `agent_response`, `session_updated`, `tool_auth_resolved`, custom events) pass through `emit()` completely unmasked.

The `scrubPII` tenant configuration flag exists and propagates to the trace emitter via `createTraceEmitter({ scrubPII })`, but `emit()` never reads it. The existing `trace-scrubber.ts` in the compiler package only matches: Bearer tokens (with an incorrect `^` anchor preventing mid-string matches), `{{secrets.*}}` template placeholders, 6 sensitive header names, and PII via `redactPII()`. It lacks API key pattern detection, key prefix detection, and secret key name detection.

---

## 2. Alternatives Considered

### Option A: Scrub inside `emit()` — universal chokepoint (Selected)

- **Description**: Add a single `scrubTraceEvent(event.data)` call inside the `emit()` function, gated by `enableScrub`. Every event type is scrubbed before reaching any downstream consumer (MongoDB, ClickHouse, WebSocket). Enhance `trace-scrubber.ts` with new patterns and export `scrubTraceEvent()`.
- **Pros**: Single insertion point — all current and future event types are automatically covered. No risk of forgetting to scrub a new event type. Minimal code change (5-10 lines in `emit()`). Double-scrubbing for `tool_call`/`llm_call` is safe due to idempotency.
- **Cons**: Double-scrubbing overhead for `tool_call`/`llm_call` events (negligible — idempotent operation on already-redacted strings). Cannot apply event-type-specific scrubbing rules if needed in the future.
- **Effort**: S

### Option B: Scrub in each individual log function

- **Description**: Add scrubbing to `logError()`, `logConstraintCheck()`, `logHandoff()`, `logAgentEnter()`, `logAgentExit()`, `logFlowStepEnter()`, `logFlowStepExit()`, `logFlowTransition()`, `logDelegateStart()`, `logDelegateComplete()`, `logCustom()`, `logUserMessage()`, `logAgentResponse()`, `logSessionUpdated()`, `logToolAuthResolved()`, and `emitDecision()`. Same pattern as existing `logToolCall()`/`logLLMCall()`.
- **Pros**: Per-function control over what gets scrubbed. No double-scrubbing. Can apply type-specific scrubbing logic.
- **Cons**: 15+ functions need modification. Every new event type added in the future must remember to add scrubbing — the same failure mode that caused ABLP-214 in the first place. High maintenance burden and high risk of regression.
- **Effort**: M

### Option C: Scrub at the storage/transport layer

- **Description**: Add scrubbing inside `TraceStore.addEvent()`, `ws.send()` wrapper, and `emitToEventStore()` — scrub at each consumer rather than at the emission point.
- **Pros**: Guarantees nothing unmasked reaches storage. Each consumer can apply different rules. `emitToEventStore()` already has its own scrubbing (via `scrubSecrets` + `redactPIIFn`).
- **Cons**: Three separate insertion points to maintain. `TraceStore` is in a different package — cross-package change. WebSocket `send()` requires wrapping or monkey-patching. Divergent scrubbing between consumers could lead to inconsistent masked data. Higher blast radius if one consumer's scrubbing breaks.
- **Effort**: M-L

### Recommendation: Option A — Scrub inside `emit()`

**Rationale**: Option A is the direct fix for the root cause — `emit()` is the single chokepoint and it does nothing. Adding scrubbing here covers all event types automatically, prevents regression when new event types are added, and requires minimal code change. The double-scrubbing concern for `tool_call`/`llm_call` is a non-issue because `redactPII("[REDACTED_EMAIL]")` returns `"[REDACTED_EMAIL]"` unchanged. Option B repeats the exact architectural mistake that caused ABLP-214 (per-function responsibility instead of centralized). Option C spreads the fix across multiple packages and introduces consumer-specific divergence risk.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Runtime Service                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────┐           │
│  │              trace-emitter.ts                        │           │
│  │                                                     │           │
│  │  logToolCall()──┐  logLLMCall()──┐                  │           │
│  │  (pre-scrubs)   │  (pre-scrubs)  │                  │           │
│  │                 │                │                   │           │
│  │  logError()─────┤  logHandoff()──┤  emitDecision()──┤           │
│  │  logAgentEnter()┤  logCustom()───┤  logConstraint() ┤           │
│  │  (NO scrubbing) │  (NO scrubbing)│  (NO scrubbing)  │           │
│  │                 │                │                   │           │
│  │                 ▼                ▼                   │           │
│  │           ┌──────────────────────────┐              │           │
│  │           │        emit()            │              │           │
│  │           │                          │              │           │
│  │           │  ┌────────────────────┐  │ ◄── NEW      │           │
│  │           │  │ if (enableScrub) { │  │              │           │
│  │           │  │   event.data =     │  │              │           │
│  │           │  │   scrubTraceEvent( │  │              │           │
│  │           │  │     event.data)    │  │              │           │
│  │           │  │ }                  │  │              │           │
│  │           │  └────────────────────┘  │              │           │
│  │           │            │             │              │           │
│  │           └────────────┼─────────────┘              │           │
│  └────────────────────────┼─────────────────────────────┘           │
│                           │                                         │
│              ┌────────────┼────────────┐                           │
│              │            │            │                            │
│              ▼            ▼            ▼                            │
│         ┌────────┐  ┌──────────┐  ┌──────────┐                    │
│         │MongoDB │  │ClickHouse│  │WebSocket │                    │
│         │Trace   │  │EventStore│  │(Studio)  │                    │
│         │Store   │  │          │  │          │                    │
│         └────────┘  └──────────┘  └──────────┘                    │
│          (masked)    (masked)      (masked)                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────┐
│ packages/compiler                                │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ trace-scrubber.ts                         │   │
│  │                                           │   │
│  │  scrubToolCallData()  (existing)          │   │
│  │  redactEndpoint()     (existing)          │   │
│  │  scrubTraceEvent()    (NEW)               │   │
│  │                                           │   │
│  │  Internal:                                │   │
│  │  ├─ scrubValue() — deep recursive walk    │   │
│  │  ├─ scrubString() — regex pattern match   │   │
│  │  ├─ SECRET_PATTERNS[] — Bearer, API key   │   │
│  │  │   assignment, key prefixes (NEW)       │   │
│  │  ├─ SENSITIVE_HEADERS Set (existing)      │   │
│  │  ├─ SECRET_KEY_NAMES Set (NEW)            │   │
│  │  └─ redactPII() — email, phone, SSN,     │   │
│  │      credit card (stricter), IP           │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ pii-detector.ts                           │   │
│  │                                           │   │
│  │  credit_card regex: updated to 13-19      │   │
│  │  digits, Luhn validation REMOVED          │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  Barrel exports:                                 │
│  constructs/index.ts → scrubTraceEvent (NEW)     │
│  compiler/src/index.ts → scrubTraceEvent (NEW)   │
└─────────────────────────────────────────────────┘
          │
          │ import { scrubTraceEvent } from '@abl/compiler'
          ▼
┌─────────────────────────────────────────────────┐
│ apps/runtime                                     │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ trace-emitter.ts                          │   │
│  │                                           │   │
│  │  emit() function:                         │   │
│  │  + if (enableScrub && event.data) {       │   │
│  │  +   event.data = scrubTraceEvent(data)   │   │
│  │  + }                                      │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Data Flow

**Before (current — broken):**

```
1. logError({ message: "Failed for user@example.com" })
2. → emit({ type: 'error', data: { message: "Failed for user@example.com" } })
3. → TraceStore.addEvent(...)     // raw email stored in MongoDB
4. → ws.send(...)                 // raw email sent to Studio
5. → emitToEventStore(...)        // scrubbed for ClickHouse only (separate path)
```

**After (fixed):**

```
1. logError({ message: "Failed for user@example.com" })
2. → emit({ type: 'error', data: { message: "Failed for user@example.com" } })
3.   → if (enableScrub) data = scrubTraceEvent(data)
4.   → data = { message: "Failed for [REDACTED_EMAIL]" }
5. → TraceStore.addEvent(...)     // masked email in MongoDB
6. → ws.send(...)                 // masked email to Studio
7. → emitToEventStore(...)        // also masked (double-scrub is idempotent)
```

### Sequence Diagram

```
  Caller          emit()           scrubTraceEvent()    TraceStore   WebSocket   EventStore
    │                │                    │                 │            │           │
    │  emit(event)   │                    │                 │            │           │
    │───────────────>│                    │                 │            │           │
    │                │                    │                 │            │           │
    │                │  enableScrub?      │                 │            │           │
    │                │────┐               │                 │            │           │
    │                │    │ yes           │                 │            │           │
    │                │<───┘               │                 │            │           │
    │                │                    │                 │            │           │
    │                │  scrubTraceEvent() │                 │            │           │
    │                │───────────────────>│                 │            │           │
    │                │                    │                 │            │           │
    │                │  scrubbed data     │                 │            │           │
    │                │<──────────────────│                 │            │           │
    │                │                    │                 │            │           │
    │                │  addEvent(scrubbed)│                 │            │           │
    │                │──────────────────────────────────────>            │           │
    │                │                    │                 │            │           │
    │                │  ws.send(scrubbed) │                 │            │           │
    │                │─────────────────────────────────────────────────>│           │
    │                │                    │                 │            │           │
    │                │  emitToEventStore(scrubbed)          │            │           │
    │                │────────────────────────────────────────────────────────────>│
    │                │                    │                 │            │           │
    │  storedEvent   │                    │                 │            │           │
    │<───────────────│                    │                 │            │           │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                            |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Scrubbing is controlled by the per-tenant `scrubPII` flag. Each tenant's flag is read independently at `createTraceEmitter()` time and stored in the closure as `enableScrub`. Tenant A's setting does not affect Tenant B. The flag propagates from `handler.ts` via `createTraceEmitter({ scrubPII })`.  |
| 2   | **Data Access Pattern** | No new data access. `scrubTraceEvent()` is a pure function — it receives data, returns scrubbed data. No DB reads, no caching, no state. The existing `TraceStore.addEvent()`, `ws.send()`, and `emitToEventStore()` paths are unchanged except they now receive pre-scrubbed data.                        |
| 3   | **API Contract**        | No API changes. No new endpoints, no modified request/response shapes. The only observable difference is that trace event `data` fields now contain `[REDACTED]` markers instead of raw secrets/PII. This is a data quality improvement, not a contract change.                                            |
| 4   | **Security Surface**    | This feature _reduces_ the security surface by removing PII/secrets from storage and transport. No new inputs, endpoints, or auth flows. The `scrubTraceEvent()` function is a pure data transformation with no side effects. The only security consideration is ensuring the function cannot be bypassed. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                          |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | If `scrubTraceEvent()` throws, `emit()` catches the error, logs a warning via `createLogger('trace-emitter')`, and emits the **original unmodified event**. Rationale: observability is more important than scrubbing — a failed scrub should not drop trace events. The warning log enables monitoring and remediation. |
| 6   | **Failure Modes** | Single failure mode: regex throws on pathological input (e.g., catastrophic backtracking). Mitigated by: (a) pre-compiled regex patterns, (b) bounded recursion depth (max 10 levels), (c) try/catch in `emit()` with fail-open semantics. No network, DB, or external service dependencies in the scrubbing path.       |
| 7   | **Idempotency**   | `scrubTraceEvent()` is idempotent by design. `redactPII("[REDACTED_EMAIL]")` returns `"[REDACTED_EMAIL]"` unchanged. Secret patterns do not match `[REDACTED]` markers. This is verified by UT-13 and INT-4 in the test spec. Safe for double-scrubbing of `tool_call` and `llm_call` events.                            |
| 8   | **Observability** | No new trace events or metrics for the scrubbing itself. The existing trace event markers (`[REDACTED]`, `[REDACTED_EMAIL]`, etc.) are visible in Studio Observatory. The warning log for scrubbing failures (concern #5) is the only new log entry.                                                                     |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Target: <1ms per event for typical payloads (~2KB JSON, 10 fields, 3 levels deep). Approach: pre-compiled regex patterns (compiled once at module load), recursive walk is O(n) where n = total string characters. Bounded recursion depth (max 10). No JSON.parse/stringify round-trip — direct object walk.                                                                                                                                                                                                                                                                  |
| 10  | **Migration Path**     | No migration. This is a forward-looking change — new events are scrubbed, historical data remains as-is. The `scrubPII` flag is already propagated to `createTraceEmitter()`. The only code change is inside `emit()` (5-10 lines) and `trace-scrubber.ts` (new patterns + export).                                                                                                                                                                                                                                                                                            |
| 11  | **Rollback Plan**      | Three rollback options ordered by speed: (1) Set `scrubPII: false` in tenant config — immediate, per-tenant. (2) Revert the `emit()` change in `trace-emitter.ts` — single-line revert. (3) Full commit revert. All options are safe because scrubbing is purely additive — it only modifies event data, not control flow.                                                                                                                                                                                                                                                     |
| 12  | **Test Strategy**      | **Unit tests** (15 scenarios): Pure function testing of `scrubTraceEvent()` patterns — Bearer, API key, key prefix, secret key names, nested objects, arrays, idempotency, null safety, performance. **Integration tests** (7 scenarios): Real `TraceEmitter` → real MongoDB via `TraceStore` — verify scrubbed data reaches storage. Tests real service boundary (`emit()` → `TraceStore`). **E2E tests** (7 scenarios): Full HTTP API interaction — POST messages, GET traces, assert masked data. No mocks. Real Runtime + MongoDB + Redis. See test spec for full details. |

---

## 5. Data Model

### New Collections/Tables

None.

### Modified Collections/Tables

No schema changes. Existing collections store scrubbed data instead of raw data when `scrubPII=true`:

```
Collection: sessions (MongoDB)
  - Field: events[].data
  - Change: Values now contain [REDACTED], [REDACTED_EMAIL], [REDACTED_CARD],
            [REDACTED_SSN], [REDACTED_PHONE], [REDACTED_IP] markers
  - When: scrubPII=true for the tenant

Table: platform_events (ClickHouse)
  - Column: data (JSON)
  - Change: Same scrubbed markers
  - When: scrubPII=true for the tenant
  - Note: emitToEventStore() already scrubs separately via scrubSecrets() + redactPIIFn().
          With emit()-level scrubbing, data arrives pre-scrubbed. Double-scrubbing is safe.
```

### Key Relationships

No new relationships. Existing data flow is unchanged:

- `trace-emitter.emit()` → `TraceStore.addEvent()` (MongoDB)
- `trace-emitter.emit()` → `ws.send()` (WebSocket)
- `trace-emitter.emit()` → `emitToEventStore()` (ClickHouse)

---

## 6. API Design

### New Endpoints

None. This feature modifies internal data processing, not API surface.

### Modified Endpoints

None. Trace retrieval endpoints return the same shape — the only difference is that `data` field values now contain redaction markers.

### New Internal API

| Export                  | Package         | Signature                                                    | Purpose                                |
| ----------------------- | --------------- | ------------------------------------------------------------ | -------------------------------------- |
| `scrubTraceEvent(data)` | `@abl/compiler` | `(data: Record<string, unknown>) => Record<string, unknown>` | Deep-scrub a trace event's data object |

### Error Responses

No new error responses. If scrubbing fails internally, the event is emitted with original data (fail-open) and a warning is logged.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No changes. Existing PII audit log tracks vault operations. Trace scrubbing does not produce audit entries. (Open question: should it?)
- **Rate Limiting**: N/A — scrubbing is an in-process data transformation, not an API operation.
- **Caching**: Regex patterns are pre-compiled at module load time. No runtime caching needed. No Maps, no TTLs, no eviction.
- **Encryption**: Unchanged. MongoDB encryption-at-rest and TLS-in-transit remain. Scrubbing adds defense-in-depth — even if encryption is compromised, data is already redacted.
- **Compliance**: Addresses GDPR Article 5(1)(c) data minimization, CCPA Section 1798.100, HIPAA Safe Harbor. Trace storage no longer contains raw PII when `scrubPII=true`.
- **Studio-side masking removal**: After Runtime masking is verified, `mask-sensitive-data.ts` and its consumers become redundant. Removal is Phase 4 of the delivery plan.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                     | Type             | Risk                                                                     |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------ |
| `@abl/compiler` trace-scrubber | Code (same repo) | Low — we own the code. Changes are in the same package.                  |
| `@abl/compiler` pii-detector   | Code (same repo) | Low — modifying credit card regex. Well-tested with existing unit tests. |
| `scrubPII` tenant config flag  | Configuration    | Low — already exists and propagates to `createTraceEmitter()`.           |
| `TraceStore.addEvent()`        | Runtime service  | None — no changes to TraceStore. It receives pre-scrubbed data.          |
| `emitToEventStore()`           | Runtime service  | Low — already has its own scrubbing. Will receive double-scrubbed data.  |

### Downstream (depends on this feature)

| Consumer               | Impact                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Studio Observatory     | Receives pre-masked events over WebSocket. `mask-sensitive-data.ts` becomes redundant.      |
| Analytics (ClickHouse) | `emitToEventStore()` receives pre-scrubbed data. Its own scrubbing still runs (idempotent). |
| Trace retrieval API    | Returns scrubbed data from MongoDB. No code changes needed in retrieval endpoints.          |
| Session export         | Exported sessions will contain scrubbed trace data. No code changes needed.                 |

---

## 9. Open Questions & Decisions Needed

1. **Custom PII patterns in trace scrubbing**: Should `scrubTraceEvent()` eventually consume custom patterns from the `pii-patterns` API (per-project patterns from PIIProtectionTab)? Current design uses only built-in patterns. Adding custom patterns requires fetching project-specific config at scrub time, which adds complexity and latency.

2. **Audit logging for scrubbing events**: Should there be audit entries when scrubbing detects and redacts sensitive data? This would add observability but also add latency and storage cost per event.

3. **Historical data remediation**: Should a migration script retroactively scrub already-stored unmasked data in MongoDB/ClickHouse? This is a separate initiative with its own risk profile (data mutation in production).

4. **`emitToEventStore()` redundancy**: After emit()-level scrubbing, the separate scrubbing in `emitToEventStore()` (lines 57-61: `scrubSecrets()` + `redactPIIFn()`) becomes redundant. Should it be removed for simplicity, or kept as defense-in-depth?

---

## 10. References

- Feature spec: `docs/features/sub-features/universal-trace-masking.md`
- Test spec: `docs/testing/sub-features/universal-trace-masking.md`
- Parent feature HLD: `docs/specs/pii-detection.hld.md`
- Parent feature LLD: `docs/plans/pii-detection.lld.md`
- Implementation plan: `docs/plans/2026-04-08-ablp-214-runtime-masking-implementation-plan.md`
- Jira: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)
