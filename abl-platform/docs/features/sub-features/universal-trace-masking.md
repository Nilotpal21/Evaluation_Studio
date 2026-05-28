# Feature: Universal Trace Event Masking

**Doc Type**: SUB-FEATURE
**Parent Feature**: [PII Detection & Redaction](../pii-detection.md)
**Status**: ALPHA
**Feature Area(s)**: `governance`, `observability`, `enterprise`
**Package(s)**: `packages/compiler`, `apps/runtime`
**Owner(s)**: `Platform Team`
**Testing Guide**: `../../testing/sub-features/universal-trace-masking.md`
**Last Updated**: 2026-04-09
**LLD**: `docs/plans/2026-04-09-universal-trace-masking-impl-plan.md`
**HLD**: `docs/specs/universal-trace-masking.hld.md`
**Jira**: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)

---

## 1. Introduction / Overview

### Problem Statement

The PII Detection & Redaction feature (BETA) claims to scrub trace data before it reaches observability systems (FR-14). However, the current implementation only scrubs **two** event types (`tool_call` and `llm_call`) at their construction sites in `trace-emitter.ts`. All other event types — `decision`, `error`, `handoff`, `agent_enter`, `agent_exit`, `constraint_check`, `flow_step_enter`, `flow_step_exit`, `flow_transition`, `delegate_start`, `delegate_complete`, `user_message`, `agent_response`, `session_updated`, and custom events — pass through the `emit()` function **completely unmasked**.

This means sensitive data in these events is:

- Stored **unmasked** in MongoDB (TraceStore)
- Stored **unmasked** in ClickHouse (EventStore)
- Transmitted **unmasked** over WebSocket to Studio
- Potentially logged **unmasked** in server logs

The Studio-side masking (`mask-sensitive-data.ts`) only masks data at display time — the raw data has already been persisted and transmitted.

### Goal Statement

Apply universal PII and secret scrubbing to ALL trace events at the single emission chokepoint (`emit()` in `trace-emitter.ts`) so that no event reaches storage, transport, or logging with unmasked sensitive data.

### Summary

This sub-feature closes the gap between FR-14's promise ("scrub PII from trace data") and reality. By scrubbing `event.data` inside the `emit()` function — the single point through which every trace event flows — all downstream consumers (MongoDB, ClickHouse, WebSocket, logs) receive already-masked data. Additionally, the trace-scrubber's pattern library is enhanced with API key detection, well-known key prefix detection (sk-, pk-, abl*, ghp*, gho\_), and secret key name detection (password, token, api_key fields). Credit card detection is made stricter by removing Luhn validation and masking all 13-19 digit sequences.

---

## 2. Scope

### Goals

- Scrub ALL trace event data inside `emit()` before any storage or transmission
- Enhance `trace-scrubber.ts` with API key, key prefix, and secret key name patterns
- Fix Bearer token regex (remove `^` anchor so it matches mid-string)
- Make credit card masking stricter (remove Luhn validation, mask all 13-19 digit sequences)
- Export a new `scrubTraceEvent()` function from `@abl/compiler` for universal trace scrubbing
- Remove redundant Studio-side masking (`mask-sensitive-data.ts`) after Runtime masking is verified

### Non-Goals (Out of Scope)

- Custom PII patterns (from PIIProtectionTab) in trace scrubbing — custom patterns are for guardrail-level filtering, not trace-level
- Scrubbing top-level event metadata fields (agentName, sessionId, type, timestamp) — these are system identifiers, not user data
- ML/NER-based pattern detection
- Retroactive scrubbing of already-stored unmasked data in MongoDB/ClickHouse
- Changing the `scrubPII` configuration model (existing tenant plan-based defaults remain)

---

## 3. User Stories

1. As a **platform operator**, I want all trace events to have sensitive data masked before reaching any storage system so that database compromises don't expose PII or credentials.
2. As a **compliance officer**, I want API keys and tokens appearing in decision/error trace events to be redacted so that our audit trail doesn't contain leaked credentials.
3. As a **project builder**, I want the PII Protection settings I configured in Studio to actually protect data at the source (Runtime) so that I have confidence my compliance posture is real.
4. As a **security engineer**, I want secret key names (password, token, api_key) to trigger value redaction regardless of the value's content so that new/unknown secret formats are still protected.
5. As a **platform operator**, I want credit card-like number sequences to be masked even if they fail Luhn validation so that test/staging card numbers and typos are still protected.

---

## 4. Functional Requirements

1. **FR-1**: The system must scrub `event.data` for ALL trace event types inside the `emit()` function before writing to TraceStore (MongoDB), EventStore (ClickHouse), or WebSocket.
2. **FR-2**: The system must respect the existing `scrubPII` tenant configuration flag — when `false`, no scrubbing is applied in `emit()`.
3. **FR-3**: The system must detect and redact Bearer tokens anywhere in a string value (not just at the start), replacing the token portion with `[REDACTED]` while preserving the "Bearer " prefix.
4. **FR-4**: The system must detect and redact API key assignment patterns (`api_key=xxx`, `secret_key: "xxx"`, `access_token=xxx`, etc.) in string values.
5. **FR-5**: The system must detect and redact well-known key prefixes (`sk-`, `pk-`, `abl_`, `ghp_`, `gho_`) of sufficient length in string values.
6. **FR-6**: The system must redact string values whose key names indicate secrets (password, token, api_key, credential, private_key, client_secret, and variants).
7. **FR-7**: The system must mask ALL 13-19 digit sequences (with optional space/dash separators) as credit cards, without requiring Luhn validation.
8. **FR-8**: The system must export a `scrubTraceEvent()` function from `@abl/compiler` that performs deep recursive scrubbing of a trace event's data object.
9. **FR-9**: The scrubbing must be idempotent — applying it to already-scrubbed data must produce the same output (no double-encoding or corruption of `[REDACTED]` markers).
10. **FR-10**: The system must add less than 1ms of latency per event for typical trace payloads when scrubbing is enabled.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                |
| -------------------------- | ------------ | -------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project model changes                                             |
| Agent lifecycle            | SECONDARY    | All agent trace events are now scrubbed                              |
| Customer experience        | NONE         | End-user experience unchanged — data was already masked in Studio UI |
| Integrations / channels    | NONE         | Channel-agnostic — scrubbing happens in trace emission layer         |
| Observability / tracing    | PRIMARY      | Core change — all trace data is now masked at source                 |
| Governance / controls      | PRIMARY      | Closes compliance gap — data is masked before storage                |
| Enterprise / compliance    | PRIMARY      | GDPR/CCPA/HIPAA compliance for trace data storage                    |
| Admin / operator workflows | NONE         | No admin UI changes                                                  |

### Related Feature Integration Matrix

| Related Feature                                        | Relationship Type | Why It Matters                                                            | Key Touchpoints                               | Current State       |
| ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------- | --------------------------------------------- | ------------------- |
| [PII Detection](../pii-detection.md)                   | extends           | This sub-feature closes the gap in FR-14's trace scrubbing implementation | `trace-scrubber.ts`, `pii-detector.ts`        | Parent feature BETA |
| [Tracing & Observability](../tracing-observability.md) | emits into        | All trace events flow through `emit()` — the scrubbing insertion point    | `trace-emitter.ts`                            | BETA                |
| [EventStore](../eventstore.md)                         | shares data with  | Scrubbed events are persisted to ClickHouse platform_events               | `emit-to-eventstore.ts`                       | BETA                |
| [Memory & Sessions](../memory-sessions.md)             | shares data with  | Trace events include session context that may contain PII                 | `trace-store.ts`, MongoDB sessions collection | BETA                |

---

## 6. Design Considerations

### Scrubbing Architecture (After)

```
┌─────────────┐
│ Trace Event  │
│ (any type)   │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────┐
│ emit() function              │
│                              │
│  if (enableScrub) {          │
│    event.data =              │
│      scrubTraceEvent(data)   │  ◄── UNIVERSAL SCRUBBING
│  }                           │
└──────┬───────────────────────┘
       │
       ├──► MongoDB    (masked)
       ├──► ClickHouse (masked)
       ├──► WebSocket  (masked)
       └──► Logs       (masked)
```

### Pattern Enhancement

Current `trace-scrubber.ts` only has:

- Bearer token regex (with incorrect `^` anchor)
- `{{secrets.*}}` template placeholder regex
- Sensitive header name set (6 headers)
- PII detection via `redactPII()` (email, phone, SSN, credit card, IP)

After enhancement, adds:

- API key assignment patterns (`api_key=xxx`, `secret_key: "xxx"`, etc.)
- Well-known key prefixes (`sk-`, `pk-`, `abl_`, `ghp_`, `gho_`)
- Secret key name detection (password, token, api_key, credential, etc.)
- Fixed Bearer token regex (matches anywhere, not just start of string)

### Double-Scrubbing Safety

`logToolCall()` and `logLLMCall()` already scrub their data before calling `emit()`. With universal scrubbing in `emit()`, data gets scrubbed twice. This is safe because:

- `redactPII("[REDACTED_EMAIL]")` returns `"[REDACTED_EMAIL]"` unchanged
- All regex patterns skip already-redacted markers
- Existing pre-scrubbing provides defense-in-depth

---

## 7. Technical Considerations

- **Backward compatibility**: No API or config changes. Existing `scrubPII` flag controls behavior.
- **Migration**: None. New events are scrubbed going forward. Historical unmasked data remains as-is.
- **Rollback**: Set `scrubPII: false` in tenant config to disable, or revert the commit.
- **Studio masking removal**: After Runtime masking is verified, `mask-sensitive-data.ts` and its consumers in Studio components become redundant and should be removed to avoid confusion about where masking happens.

---

## 8. How to Consume

### Studio UI

No changes to Studio consumption. Studio receives already-masked trace events over WebSocket. The PIIProtectionTab at **Project Settings > PII Protection** controls the `scrubPII` flag that enables/disables trace scrubbing.

After this feature, `mask-sensitive-data.ts` (Studio-side masking) is removed — Studio displays data as-received, which is now pre-masked.

### API (Runtime)

No new endpoints. Trace events emitted via WebSocket and stored in MongoDB/ClickHouse are now scrubbed.

| Method | Path                             | Purpose                          |
| ------ | -------------------------------- | -------------------------------- |
| N/A    | WebSocket `trace_event` messages | Events now contain scrubbed data |

### API (Studio)

No changes.

### Admin Portal

N/A — PII protection is project-scoped, not admin-scoped.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Scrubbing happens in the trace emission layer, which is transport-agnostic.

---

## 9. Data Model

### Collections / Tables

No schema changes. Existing collections store scrubbed data instead of raw data.

```text
Collection: sessions (MongoDB)
  - events[].data: now contains scrubbed values when scrubPII=true

Table: platform_events (ClickHouse)
  - data column: now contains scrubbed values when scrubPII=true
```

### Key Relationships

- `trace-emitter.ts` → `trace-store.ts` (MongoDB) — scrubbed before addEvent()
- `trace-emitter.ts` → `emit-to-eventstore.ts` (ClickHouse) — scrubbed before emitToEventStore()
- `trace-emitter.ts` → WebSocket — scrubbed before ws.send()

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                    | Purpose                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | Enhanced scrubbing: imports shared patterns, SECRET_KEY_NAMES set, `scrubTraceEvent()` export |
| `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts` | Shared secret patterns — added sk-, pk*live/test*, ghp*, gho* key prefix regexes              |
| `packages/compiler/src/platform/security/pii-detector.ts`               | Stricter credit card regex (13-19 digits, Luhn validation removed)                            |
| `packages/compiler/src/platform/constructs/index.ts`                    | Barrel export — added `scrubTraceEvent`                                                       |
| `packages/compiler/src/index.ts`                                        | Package barrel export — added `scrubTraceEvent`                                               |

### Routes / Handlers

| File                                         | Purpose                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/runtime/src/services/trace-emitter.ts` | Universal scrubbing in `emit()` — calls `scrubTraceEvent()` on all events |

### UI Components

| File                                                       | Purpose                                         |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/utils/mask-sensitive-data.ts`             | TO BE REMOVED — redundant after Runtime masking |
| `apps/studio/src/components/settings/PIIProtectionTab.tsx` | Existing PII settings UI (no changes)           |

### Tests

| File                                                                | Type | Coverage Focus                                                             |
| ------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts` | unit | 23 tests: Bearer mid-string, API key, key prefixes, secret key names, perf |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`     | unit | 44 tests: stricter credit card masking (Luhn-failing cards now detected)   |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

| Setting             | Location                | Default | Description                      |
| ------------------- | ----------------------- | ------- | -------------------------------- |
| `security.scrubPII` | Tenant config (MongoDB) | `true`  | Enables/disables trace scrubbing |

Plan-based defaults in `apps/studio/src/services/tenant-config.ts`:

| Plan       | `scrubPII` Default |
| ---------- | ------------------ |
| FREE       | `false`            |
| TEAM       | `false`            |
| BUSINESS   | `true`             |
| ENTERPRISE | `true`             |

### DSL / Agent IR / Schema

N/A — no DSL changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Project isolation | N/A — scrubbing is per-tenant config, not project-scoped. All projects in a tenant share the same `scrubPII` setting. |
| Tenant isolation  | Each tenant's `scrubPII` flag is read independently. Tenant A's setting does not affect Tenant B.                     |
| User isolation    | N/A — scrubbing applies to all events in a session regardless of user.                                                |

### Security & Compliance

- Scrubbing prevents PII and credentials from persisting in MongoDB, ClickHouse, and WebSocket.
- Addresses GDPR Article 5(1)(c) (data minimization) and CCPA Section 1798.100 (right to know what data is collected).
- HIPAA Safe Harbor: removes identifiers from trace storage.
- All existing encryption-at-rest for MongoDB/ClickHouse remains. This feature adds defense-in-depth — even if encryption is compromised, data is already redacted.

### Performance & Scalability

- **Overhead per event**: ~0.2-0.8ms for deep recursive scrubbing with regex pattern matching
- **For 1000 events/session**: ~200-800ms additional total latency
- **Per-event**: negligible (<1ms)
- **Mitigation**: Regex patterns are pre-compiled. Only runs when `scrubPII=true`. Scrubbing is O(n) where n = data payload size.

### Reliability & Failure Modes

- If scrubbing throws an error, `emit()` should log a warning and emit the ORIGINAL event rather than dropping it (fail-open for observability, but log the failure for remediation).
- Idempotent scrubbing means retries and double-application are safe.

### Observability

- No new trace events or metrics for the scrubbing itself.
- Existing trace events now contain `[REDACTED]`, `[REDACTED_EMAIL]`, `[REDACTED_CARD]`, etc. markers that are visible in Studio.

### Data Lifecycle

- No changes to TTL or retention policies.
- Historical unmasked data remains as-is — this feature is forward-looking only.
- EventStore's `piiRetentionDays` policy continues to apply.

---

## 13. Delivery Plan / Work Breakdown

1. **Enhance trace-scrubber patterns (compiler)**
   1.1 Fix Bearer token regex — remove `^` anchor, match anywhere in string
   1.2 Add API key assignment pattern regex
   1.3 Add well-known key prefix pattern regex (sk-, pk-, abl*, ghp*, gho\_)
   1.4 Add secret key name detection (password, token, api_key, credential, etc.)
   1.5 Export new `scrubTraceEvent()` function
   1.6 Update barrel exports (`constructs/index.ts`, `compiler/src/index.ts`)
   1.7 Add/update unit tests for all new patterns

2. **Stricter credit card masking (compiler)**
   2.1 Update credit_card regex in `pii-detector.ts` to match 13-19 digit sequences
   2.2 Remove Luhn validation requirement
   2.3 Update unit test assertion (expect detection, not pass-through)

3. **Universal scrubbing in trace-emitter (runtime)**
   3.1 Import `scrubTraceEvent` from `@abl/compiler`
   3.2 Add scrubbing of `event.data` inside `emit()` gated by `enableScrub`
   3.3 Verify idempotency with existing `logToolCall`/`logLLMCall` pre-scrubbing

4. **Remove Studio-side masking (studio)**
   4.1 Delete `apps/studio/src/utils/mask-sensitive-data.ts`
   4.2 Remove masking imports/calls from ToolCallContent, DecisionContent, RawEventBlock, JsonViewer, LLMCallCard, NodeDetailPanel
   4.3 Verify Studio build succeeds
   4.4 Delete redundant test `apps/studio/src/__tests__/mask-sensitive-data.test.ts`

---

## 14. Success Metrics

| Metric                          | Baseline                | Target                    | How Measured                               |
| ------------------------------- | ----------------------- | ------------------------- | ------------------------------------------ |
| Trace event types scrubbed      | 2 (tool_call, llm_call) | ALL (~15+ types)          | Code audit of emit() path                  |
| Unmasked PII in MongoDB traces  | Present                 | Zero (when scrubPII=true) | `db.sessions.findOne()` inspection         |
| Unmasked PII in ClickHouse      | Present                 | Zero (when scrubPII=true) | `SELECT * FROM platform_events` inspection |
| Unmasked secrets over WebSocket | Present                 | Zero (when scrubPII=true) | WebSocket message inspection               |
| Scrubbing latency per event     | 0ms (no scrubbing)      | <1ms                      | Performance benchmark                      |

---

## 15. Open Questions

1. Should scrubbing eventually consume custom PII patterns from `pii-patterns` API (per-project patterns from PIIProtectionTab), or should trace scrubbing remain limited to built-in patterns?
2. Should there be audit logging when scrubbing detects and redacts sensitive data in trace events (separate from the existing PII audit log which tracks vault operations)?
3. Should historical unmasked data in MongoDB/ClickHouse be retroactively scrubbed via a migration script?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                        | Severity | Status           |
| ------- | -------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| GAP-001 | Custom PII patterns from PIIProtectionTab are not used in trace scrubbing — only built-in patterns | Medium   | Open             |
| GAP-002 | Historical data stored before this fix remains unmasked                                            | Medium   | Open             |
| GAP-003 | FREE/TEAM plan tenants have scrubPII=false by default — their trace data remains unmasked          | Low      | Open (by design) |
| GAP-004 | Top-level event fields (agentName, sessionId) are not scrubbed — only event.data                   | Low      | Open (by design) |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                           | Coverage Type | Status  | Test File / Note         |
| --- | -------------------------------------------------- | ------------- | ------- | ------------------------ |
| 1   | Bearer token redaction (mid-string match)          | unit          | PASSING | `trace-scrubber.test.ts` |
| 2   | API key pattern detection                          | unit          | PASSING | `trace-scrubber.test.ts` |
| 3   | Key prefix detection (sk-, pk-, ghp*, abl*)        | unit          | PASSING | `trace-scrubber.test.ts` |
| 4   | Secret key name redaction (password, token fields) | unit          | PASSING | `trace-scrubber.test.ts` |
| 5   | Stricter credit card masking (no Luhn)             | unit          | PASSING | `pii-detector.test.ts`   |
| 6   | Universal emit() scrubbing for decision events     | integration   | PLANNED | TBD                      |
| 7   | Universal emit() scrubbing for error events        | integration   | PLANNED | TBD                      |
| 8   | Idempotent double-scrubbing                        | unit          | PASSING | `trace-scrubber.test.ts` |
| 9   | scrubPII=false bypasses scrubbing                  | integration   | PLANNED | TBD                      |
| 10  | Scrubbing performance <1ms per event               | unit          | PASSING | `trace-scrubber.test.ts` |

### Testing Notes

All 12 new unit tests for `scrubTraceEvent()` and 1 updated credit card assertion pass (67/67 total in affected test files). Integration tests for the `emit()` wiring (INT-1 to INT-7) and E2E tests (E2E-1 to E2E-7) remain planned — they require a running Runtime + MongoDB stack.

> Full testing details: `../../testing/sub-features/universal-trace-masking.md`

---

## 18. References

- Jira: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)
- Parent feature: [PII Detection & Redaction](../pii-detection.md)
- HLD: `docs/specs/universal-trace-masking.hld.md`
- LLD + Implementation Plan: `docs/plans/2026-04-09-universal-trace-masking-impl-plan.md`
- Implementation Log: `docs/sdlc-logs/ablp-214-universal-trace-masking/implementation.log.md`
- Related HLD: `docs/specs/pii-detection.hld.md`
