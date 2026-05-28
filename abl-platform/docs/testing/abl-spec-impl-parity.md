# Test Specification: ABL Spec-Implementation Parity

**Feature Spec**: `docs/features/abl-spec-impl-parity.md`
**HLD**: N/A (not yet created)
**LLD**: N/A (not yet created)
**Status**: PLANNED
**Last Updated**: 2026-03-25

---

## 1. Coverage Matrix

| FR   | Description                 | Unit  | Integration | E2E   | Manual | Status                                                |
| ---- | --------------------------- | ----- | ----------- | ----- | ------ | ----------------------------------------------------- |
| FR-1 | ESCALATE — Agent Transfer   | EXIST | -           | -     | -      | PARTIAL                                               |
| FR-2 | ESCALATE — ITSM Webhook     | -     | -           | -     | -      | NOT TESTED (requires new `connector_action` IR field) |
| FR-3 | HOOKS Lifecycle             | -     | -           | -     | -      | NOT TESTED                                            |
| FR-4 | BEHAVIOR_PROFILES Overrides | EXIST | -           | -     | -      | PARTIAL                                               |
| FR-5 | Voice IR Resolution         | EXIST | -           | -     | -      | PARTIAL (requires VoiceConfigIR extension)            |
| FR-6 | ACTION_HANDLERS             | -     | -           | -     | -      | NOT TESTED                                            |
| FR-7 | GATHER Attachment Fields    | EXIST | EXIST       | EXIST | -      | PARTIAL                                               |
| FR-8 | Agent-Level ON_ERROR        | TODO  | -           | -     | -      | NOT TESTED                                            |
| FR-9 | Documentation Sync          | N/A   | N/A         | N/A   | -      | manual                                                |

Legend: `PASS` | `FAIL` | `EXIST` (tests exist, not covering new gaps) | `TODO` (stubs only) | `-` (not tested)

### Existing Coverage Baseline

| FR   | Existing Files                                                                                                                         | Test Count | Gap                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| FR-1 | `escalation-negative.test.ts`, `escalation-transfer-wiring.test.ts`, `escalation-channel-templates.test.ts`                            | ~88        | All unit with mocks. No HTTP API E2E. No session pause/resume. No resolution API.                                      |
| FR-2 | None                                                                                                                                   | 0          | ITSM connector action for escalation is new capability.                                                                |
| FR-3 | `new-features.e2e.test.ts` (ON_START SET only)                                                                                         | ~3         | ON_START is different from HOOKS. Zero tests for before_agent/after_agent/before_turn/after_turn.                      |
| FR-4 | `behavior-profile.e2e.test.ts`, `profile-resolver.test.ts`, `profile-integration.test.ts`, `trace-profile-resolution.test.ts`          | ~123       | Good merge/resolve coverage. TOOLS_ADD/TOOLS_HIDE NOT verified in LLM tool list. No HTTP API E2E.                      |
| FR-5 | 20+ voice test files                                                                                                                   | ~200+      | Strong pipeline coverage. Zero tests for DSL `provider`/`voice_id` reaching TTS.                                       |
| FR-6 | `flow-action-dispatch.test.ts`, `actions-channel-roundtrip.test.ts`                                                                    | ~15        | ON_ACTION within flows tested. Standalone `ACTION_HANDLERS:` DSL block not tested.                                     |
| FR-7 | 18+ attachment test files including `attachment-advanced.e2e.test.ts`, `attachment-config.e2e.test.ts`, `attachment-tools.e2e.test.ts` | ~150+      | Strong tool-level coverage. Declarative `AttachmentFieldIR` validation (mime type, size, processing flags) not tested. |
| FR-8 | `error-handler-router.test.ts` (8 `test.todo()` stubs), `error-handling.test.ts` (general errors)                                      | 0 (stubs)  | 100% TODO stubs. Resolution chain exists in code but zero tests for agent-level non-tool error routing.                |

---

## 2. E2E Test Scenarios (MANDATORY — 16 scenarios)

**CRITICAL**: E2E tests must exercise the real system through its HTTP API. No mocks of codebase components, no direct DB access, no stubbed servers.

**All E2E tests MUST**:

- Start real Express servers on random ports (`{ port: 0 }`) via `runtime-api-harness.ts`
- Use full middleware chain (auth, rate limiting, tenant isolation, validation)
- Interact only via HTTP API (no direct DB queries, no `vi.mock` of codebase components)
- Only mock external third-party services (ITSM APIs, TTS providers, LLM providers) via dependency injection
- Assert trace events via the trace API (not direct TraceStore access)
- Include auth context: tenant ID + project ID + user ID
- Verify isolation: cross-tenant access returns 404 (not 403)

**Production Wired Criterion**: Every scenario verifies (a) code path executes, (b) trace events emitted, (c) correct HTTP responses returned.

---

### E2E-1: ESCALATE full lifecycle — trigger, pause, resolve, resume

**FR**: FR-1
**Risk**: HIGHEST — most complex gap, core false-confidence scenario
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`

**Preconditions**:

- Agent DSL with `ESCALATE:` block: `WHEN: user.requests_human == true`, `context_for_human: [reason, sentiment]`, `on_human_complete: [{ condition: "resolution == 'resolved'", action: "continue" }]`
- Agent-transfer module bootstrapped with test adapter
- Runtime API harness (internally backed by MongoMemoryServer — test interacts via HTTP API only)

**Steps**:

1. POST `/api/v1/sessions` with `{ agentId, channel: "web" }` — create session. Auth: tenant A, project P1, user U1.
2. POST `/api/v1/sessions/:id/messages` with `{ text: "I need to talk to a human" }` — triggers `user.requests_human = true`.
3. Assert: response body includes escalation indicator (e.g., `{ escalated: true, message: "Connecting you to an agent..." }`).
4. GET `/api/v1/sessions/:id` — assert `status === "escalated"`.
5. GET `/api/v1/sessions/:id/escalation` — assert HumanTask: `{ status: "pending", source: { type: "agent_escalation", sessionId: <id> }, context: { reason: ..., sentiment: ... } }`.
6. POST `/api/v1/sessions/:id/messages` with `{ text: "hello?" }` — assert session rejects new messages while escalated (returns 409 or queues).
7. POST `/api/v1/sessions/:id/escalation/resolve` with `{ resolution: "resolved", respondedBy: "agent-jane", fields: { summary: "Issue fixed" }, notes: "Reset password" }`. Auth: user with `escalation:resolve` permission.
8. GET `/api/v1/sessions/:id` — assert `status === "active"` (resumed).
9. Assert: response from step 7 or subsequent GET includes `on_human_complete` output (the `continue` action resumes the conversation).

**Trace assertions**: `escalation_triggered` event (with trigger condition, priority), `escalation_resolved` event (with resolution data, duration).

**Auth context**: Tenant A, Project P1, user U1 for session; user with escalation permission for resolution.

---

### E2E-2: ESCALATE fires ITSM webhook via connector action

**FR**: FR-2
**Risk**: HIGH — new capability, connector integration
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`
**Implementation prerequisite**: Requires new `connector_action?: string` field on `EscalationConfig` or `EscalationRouting` in `schema.ts`, plus corresponding compiler support. This field does not exist in the current IR.

**Preconditions**:

- Agent DSL with `ESCALATE:` block including `connector_action: "servicenow_create_incident"` (requires IR extension)
- Connector registered for tenant with mock ServiceNow endpoint (DI-injected HTTP mock)
- Agent-transfer module bootstrapped

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. POST `/api/v1/sessions/:id/messages` — trigger escalation.
3. Assert: mock ServiceNow endpoint received POST with: `{ short_description: ..., description: ..., caller_id: ..., urgency: ... }` derived from `context_for_human`.
4. GET `/api/v1/sessions/:id/escalation` — assert `connectorTicketId` is populated (e.g., `"INC0012345"`), `connectorTicketUrl` populated.
5. Assert: both agent-transfer AND ITSM paths fired (not mutually exclusive).

**Trace assertions**: `escalation_triggered` event includes `connectorAction: "servicenow_create_incident"`.

---

### E2E-3: ESCALATE + ITSM webhook failure is non-blocking

**FR**: FR-2
**Risk**: HIGH — failure path must not break escalation
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`
**Implementation prerequisite**: Same as E2E-2 — requires `connector_action` IR field.

**Preconditions**: Same as E2E-2 but mock ServiceNow returns 503.

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. POST `/api/v1/sessions/:id/messages` — trigger escalation.
3. Assert: session status is `"escalated"` (escalation succeeded despite ITSM failure).
4. GET `/api/v1/sessions/:id/escalation` — assert HumanTask created, `connectorTicketId` is null.

**Trace assertions**: `escalation_triggered` event present, error trace for ITSM failure.

---

### E2E-4: HOOKS before_turn and after_turn execute tool calls and SET

**FR**: FR-3
**Risk**: HIGH — zero existing coverage
**File**: `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`

**Preconditions**:

- Agent DSL with:
  ```
  HOOKS:
    before_turn:
      CALL: audit_logger
      SET: _turn_start = NOW()
    after_turn:
      CALL: metrics_reporter
  ```
- `audit_logger` and `metrics_reporter` defined as HTTP tools in agent's TOOLS section (pointing to DI-injected mock endpoints)

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. POST `/api/v1/sessions/:id/messages` with `{ text: "Hello" }`.
3. Assert: mock `audit_logger` endpoint received a call with session context BEFORE the LLM was invoked.
4. Assert: mock `metrics_reporter` endpoint received a call AFTER LLM response.
5. GET `/api/v1/sessions/:id` — assert `_turn_start` variable is set in session context (ISO timestamp).
6. POST `/api/v1/sessions/:id/messages` with `{ text: "Another message" }` — verify hooks fire again on second turn.
7. Assert: `audit_logger` called twice total, `metrics_reporter` called twice total.

**Trace assertions**: `hook_executed` events for each hook invocation (4 total: 2x before_turn, 2x after_turn), each with hook type, tool name, duration.

---

### E2E-5: HOOKS before_agent and after_agent fire on session lifecycle

**FR**: FR-3
**Risk**: HIGH
**File**: `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`

**Preconditions**:

- Agent DSL with:
  ```
  HOOKS:
    before_agent:
      SET: _session_created = true
      CALL: session_tracker
    after_agent:
      CALL: session_cleanup
  ```

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. Assert: `session_tracker` tool called during session initialization.
3. GET `/api/v1/sessions/:id` — assert `_session_created === true`.
4. POST `/api/v1/sessions/:id/messages` — send a message (verify before_agent doesn't fire again).
5. DELETE `/api/v1/sessions/:id` or POST end-session — terminate session.
6. Assert: `session_cleanup` tool called during session teardown.

**Trace assertions**: `hook_executed` events for `before_agent` (once) and `after_agent` (once).

---

### E2E-6: HOOKS failure is non-fatal — main execution continues

**FR**: FR-3
**Risk**: MEDIUM — failure mode
**File**: `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`

**Preconditions**: Agent DSL with `before_turn: CALL: nonexistent_tool` (tool not defined in TOOLS section).

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. POST `/api/v1/sessions/:id/messages` with `{ text: "Hello" }`.
3. Assert: response contains a valid LLM-generated reply (main execution was NOT blocked by hook failure).
4. Assert: session status is `"active"` (not crashed).

**Trace assertions**: `hook_executed` event with error status for `before_turn`, main turn execution trace events present.

---

### E2E-7: BEHAVIOR_PROFILES TOOLS_ADD injects tool into LLM call

**FR**: FR-4
**Risk**: MEDIUM — GAP-003, profile merge works but tool set not consumed
**File**: `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`

**Preconditions**:

- Agent DSL with:
  - Base tools: `[search, respond]`
  - Behavior profile: `WHEN: context.channel == "sdk"` → `TOOLS_ADD: [show_carousel]`, `TOOLS_HIDE: [search]`
  - `show_carousel` tool definition in profile

**Steps**:

1. POST `/api/v1/sessions` with `{ channel: "sdk" }` — create session.
2. POST `/api/v1/sessions/:id/messages` with `{ text: "Show me options" }`.
3. Assert: LLM was called with tool list that includes `show_carousel` and excludes `search`.
4. POST `/api/v1/sessions` with `{ channel: "api" }` — create second session (different channel).
5. POST `/api/v1/sessions/:id2/messages` with `{ text: "Show me options" }`.
6. Assert: LLM was called with default tool list (includes `search`, no `show_carousel`).

**Trace assertions**: `behavior_profile_applied` event for SDK session listing `{ tools_added: ["show_carousel"], tools_hidden: ["search"] }`. No profile event for API session.

---

### E2E-8: BEHAVIOR_PROFILES does not hide system tools

**FR**: FR-4
**Risk**: MEDIUM — safety check
**File**: `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`

**Preconditions**: Agent with profile `TOOLS_HIDE: [__escalate__]` (attempting to hide system tool).

**Steps**:

1. POST `/api/v1/sessions` — create session matching profile condition.
2. POST `/api/v1/sessions/:id/messages` — trigger reasoning.
3. Assert: `__escalate__` is still in the LLM tool list (system tools cannot be hidden).

**Trace assertions**: `behavior_profile_applied` event, warning about attempting to hide system tool.

---

### E2E-9: Voice IR provider/voice_id reaches TTS provider

**FR**: FR-5
**Risk**: MEDIUM — compiler + runtime gap
**File**: `apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts`
**Implementation prerequisite**: Requires `VoiceConfigIR` to be extended with `provider?: string`, `voice_id?: string`, `speed?: number` fields per FR-5. Tests cannot be written until compiler IR change in `schema.ts` is complete.

**Preconditions**:

- Agent DSL with `EXECUTION: voice: { provider: "elevenlabs", voice_id: "aria", speed: 1.2 }` (requires IR extension)
- Mock TTS provider via DI (external service)

**Steps**:

1. POST `/api/v1/sessions` with `{ channel: "voice" }` — create voice session.
2. POST `/api/v1/sessions/:id/messages` with `{ text: "Hello" }` — trigger TTS.
3. Assert: mock TTS provider received `{ provider: "elevenlabs", voice_id: "aria", speed: 1.2 }`.

**Trace assertions**: `voice_config_resolved` event with `{ provider: "elevenlabs", voice_id: "aria", source: "agent_ir" }`.

---

### E2E-10: ACTION_HANDLERS — button click triggers SET + RESPOND + transition

**FR**: FR-6
**Risk**: MEDIUM — compiler + runtime gap
**File**: `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`

**Preconditions**:

- Agent DSL with GATHER step containing:
  ```
  ACTION_HANDLERS:
    confirm_order:
      SET: order_confirmed = true
      RESPOND: "Order confirmed!"
      THEN: next_step
  ```

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. POST `/api/v1/sessions/:id/messages` — advance to GATHER step (agent presents options).
3. POST `/api/v1/sessions/:id/messages` with `{ action: { id: "confirm_order" } }` — simulate button click.
4. Assert: response contains "Order confirmed!".
5. GET `/api/v1/sessions/:id` — assert `order_confirmed === true` in session context.
6. Assert: flow transitioned to `next_step`.

**Trace assertions**: `action_handler_executed` event with `{ action_id: "confirm_order", handler_result: "transition" }`.

---

### E2E-11: GATHER attachment mime type validation rejects bad file

**FR**: FR-7
**Risk**: MEDIUM
**File**: `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`

**Preconditions**:

- Agent DSL with GATHER field: `type: attachment, category: image, allowed_mime_types: ["image/png", "image/jpeg"], max_file_size_bytes: 5242880`

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. Advance to GATHER step.
3. POST attachment with `content-type: application/pdf` — assert: rejection with error message specifying allowed types.
4. POST attachment with `content-type: image/png` but size 10MB — assert: rejection with max size error.
5. POST attachment with `content-type: image/png`, size 2MB — assert: accepted.

**Trace assertions**: Validation rejection events for steps 3-4, acceptance event for step 5.

---

### E2E-12: GATHER attachment processing flags forwarded to multimodal pipeline

**FR**: FR-7
**Risk**: MEDIUM
**File**: `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`

**Preconditions**:

- Agent DSL with GATHER field: `type: attachment, processing: { ocr_enabled: true, transcription_enabled: true }`
- Mock multimodal pipeline endpoint via DI

**Steps**:

1. POST `/api/v1/sessions` — create session, advance to GATHER. Auth: tenant A, project P1, user U1.
2. POST image attachment.
3. Assert: multimodal pipeline received processing request with `{ ocr_enabled: true, transcription_enabled: true }`.

**Trace assertions**: `attachment_processing_requested` event with `{ ocr_enabled: true, transcription_enabled: true }`.

**Auth context**: Tenant A, Project P1, user U1.

---

### E2E-13: Agent-level ON_ERROR handles unknown_error with recovery

**FR**: FR-8
**Risk**: HIGH — 100% TODO stubs in existing tests
**File**: `apps/runtime/src/__tests__/agent-on-error.e2e.test.ts`

**Preconditions**:

- Agent DSL with:
  ```
  ON_ERROR:
    unknown_error:
      RESPOND: "Something went wrong. Let me try again."
    invalid_input:
      RESPOND: "I didn't understand that. Could you rephrase?"
  ```

**Steps**:

1. POST `/api/v1/sessions` — create session.
2. Trigger an `unknown_error` (e.g., tool returns malformed response that causes internal error).
3. Assert: response contains "Something went wrong. Let me try again."
4. POST `/api/v1/sessions/:id/messages` with normal text — assert session continues (not crashed).
5. GET `/api/v1/sessions/:id` — assert status is `"active"`.

**Trace assertions**: Error event with type `unknown_error`, `on_error_handler_executed` event.

---

### E2E-14: Cross-tenant escalation resolution returns 404

**FR**: FR-1
**Risk**: HIGH — security isolation
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`

**Preconditions**: Session escalated for tenant A.

**Steps**:

1. POST `/api/v1/sessions` (tenant A) — create and escalate session.
2. POST `/api/v1/sessions/:id/escalation/resolve` with **tenant B auth** — assert: 404 (not 403).
3. GET `/api/v1/sessions/:id/escalation` with **tenant B auth** — assert: 404.
4. POST `/api/v1/sessions/:id/escalation/resolve` with **tenant A, different project** — assert: 404.

---

### E2E-15: Escalation resolution requires project permission

**FR**: FR-1
**Risk**: HIGH — authorization
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`

**Preconditions**: Session escalated for tenant A, project P1.

**Steps**:

1. POST `/api/v1/sessions/:id/escalation/resolve` with tenant A, project P1, user with **read-only** permission — assert: 403.
2. POST `/api/v1/sessions/:id/escalation/resolve` with tenant A, project P1, user with `escalation:resolve` permission — assert: 200.
3. Assert: HumanTask response records the authorized user as `respondedBy`.

---

### E2E-16: Cross-user escalation access returns 404

**FR**: FR-1
**Risk**: HIGH — user isolation
**File**: `apps/runtime/src/__tests__/escalation.e2e.test.ts`

**Preconditions**: Session created by user U1 in tenant A, project P1, then escalated.

**Steps**:

1. GET `/api/v1/sessions/:id/escalation` with **user U2** auth (same tenant A, project P1, no escalation permission) — assert: 404.
2. POST `/api/v1/sessions/:id/escalation/resolve` with **user U2** auth (same tenant, no escalation permission) — assert: 403 or 404.
3. GET `/api/v1/sessions/:id/escalation` with **user U3** auth (same tenant, project P1, with `escalation:resolve` permission) — assert: 200 (escalation-permitted users can see escalation details).

**Auth context**: U1 (session owner), U2 (same tenant, no escalation permission), U3 (same tenant, with escalation permission).

---

## 3. Integration Test Scenarios (MANDATORY — 12 scenarios)

Integration tests verify real service boundaries. No mocking of codebase components. External services (ITSM APIs, TTS providers) may be mocked via DI.

---

### INT-1: EscalationBridge → HumanTask creation with IAgentEscalationSource

**FR**: FR-1
**Boundary**: `escalation-bridge.ts` → `packages/database` HumanTask model
**File**: `apps/runtime/src/__tests__/escalation-integration.test.ts`

**Setup**: MongoMemoryServer, EscalationBridge with real HumanTask model.

**Steps**:

1. Call `escalation-bridge.handleEscalate()` with IR-derived escalation context.
2. Assert: HumanTask created with `source: { type: "agent_escalation", sessionId, agentName }`.
3. Assert: `context` field contains `context_for_human` values.
4. Assert: `status === "pending"`, `priority` derived from escalation trigger.
5. Query by `{ 'source.sessionId': sessionId }` — assert index works.

**Failure mode**: MongoDB write failure → assert error trace emitted, session not stuck.

---

### INT-2: EscalationBridge → TransferToolExecutor → agent-transfer dispatch

**FR**: FR-1
**Boundary**: `escalation-bridge.ts` → `transfer-tool-executor.ts` → `packages/agent-transfer`
**File**: `apps/runtime/src/__tests__/escalation-integration.test.ts`

**Setup**: Real TransferToolExecutor, real agent-transfer module with test adapter, Redis for session store.

**Steps**:

1. Configure agent-transfer with a test adapter (`kore` provider).
2. Call `escalation-bridge.handleEscalate()` with routing config `{ provider: "kore", skills: ["billing"], priority: "high" }`.
3. Assert: `transfer_to_agent` dispatched with correct parameters.
4. Assert: transfer session created in agent-transfer Redis store.

**Failure mode**: Agent-transfer not initialized → assert HITL fallback (HumanTask created, error trace emitted, session remains usable).

---

### INT-3: ErrorHandlerRouter resolution chain — step-level to agent-level fallthrough

**FR**: FR-8
**Boundary**: `error-handler-router.ts` → `reasoning-executor.ts` / `flow-step-executor.ts`
**File**: `apps/runtime/src/__tests__/error-handler-integration.test.ts`

**Setup**: Agent IR with both step-level and agent-level ON_ERROR handlers.

**Steps**:

1. **Step-level match**: Trigger `tool_error` with subtype `timeout` on a step with `ON_ERROR: tool_error.timeout: RESPOND: "Tool timed out"`. Assert: step-level handler fires.
2. **Step-level type match**: Trigger `tool_error` (no subtype match at step). Assert: step-level type handler fires.
3. **Step DEFAULT**: Trigger `unknown_error` on step with DEFAULT handler. Assert: DEFAULT fires.
4. **Agent-level fallthrough**: Trigger `invalid_input` on step WITHOUT handler, agent WITH `ON_ERROR: invalid_input: RESPOND: "Bad input"`. Assert: agent-level handler fires.
5. **Agent-level type match**: Trigger `validation_error` — falls through step → agent-level type handler.
6. **Agent DEFAULT**: Trigger error with no matching type at step or agent level, agent has DEFAULT. Assert: agent DEFAULT fires.
7. **No handler at all**: Trigger error with no handlers anywhere. Assert: default error propagation (existing behavior).

**Failure mode**: Handler action itself throws → assert no infinite loop, error propagated.

---

### INT-4: BehaviorProfile tool set modification — TOOLS_ADD/HIDE consumed by LLM call

**FR**: FR-4
**Boundary**: `profile-resolver.ts` → `reasoning-executor.ts` tool binding
**File**: `apps/runtime/src/__tests__/behavior-profiles-integration.test.ts`

**Setup**: Agent IR with behavior profile: `WHEN: context.channel == "sdk"` → `TOOLS_ADD: [show_carousel]`, `TOOLS_HIDE: [internal_debug]`.

**Steps**:

1. Resolve profiles for channel "sdk" — assert `EffectiveAgentConfig` has correct tools_add/tools_hide.
2. Build tool definitions for LLM call using effective config.
3. Assert: tool array includes `show_carousel` definition, excludes `internal_debug`.
4. Repeat for channel "api" — assert: default tool set unchanged.
5. Verify base tool set is NOT corrupted after profile application (next turn on different channel returns original tools).

**Failure mode**: Unknown tool in TOOLS_ADD → assert: warning logged, tool skipped, other overrides still applied.

---

### INT-5: Hook execution ordering — full lifecycle sequence

**FR**: FR-3
**Boundary**: Hook executor → `ToolBindingExecutor` → session context
**File**: `apps/runtime/src/__tests__/hooks-integration.test.ts`

**Setup**: Agent IR with all 4 hook types. Track execution order via call timestamps.

**Steps**:

1. Initialize session — assert `before_agent` fires first.
2. Execute turn — assert order: `before_turn` → [LLM call] → `after_turn`.
3. Execute second turn — assert same order, `before_agent` does NOT fire again.
4. End session — assert `after_agent` fires last.
5. Verify full order: `before_agent` → `before_turn` → LLM → `after_turn` → `before_turn` → LLM → `after_turn` → `after_agent`.

**Failure mode**: Hook tool call throws → assert: error traced, main execution continues, subsequent hooks still fire.

---

### INT-6: Hook CALL action goes through standard tool middleware

**FR**: FR-3
**Boundary**: Hook executor → `ToolBindingExecutor` → SSRF protection → tool endpoint
**File**: `apps/runtime/src/__tests__/hooks-integration.test.ts`

**Steps**:

1. Configure hook with CALL to HTTP tool pointing to `http://169.254.169.254/metadata` (SSRF target).
2. Execute turn — assert: SSRF protection blocks the call.
3. Assert: hook failure is non-fatal, main execution continues.
4. Configure hook with CALL to valid endpoint — assert: call succeeds through standard tool pipeline.

---

### INT-7: VoiceConfigIR resolution with behavior profile override

**FR**: FR-5
**Boundary**: `VoiceConfigIR` → `profile-resolver.ts` → voice session
**File**: `apps/runtime/src/__tests__/voice-config-integration.test.ts`
**Implementation prerequisite**: Requires `VoiceConfigIR` to be extended with `provider?: string`, `voice_id?: string`, `speed?: number` fields per FR-5. Tests cannot be written until compiler IR change in `schema.ts` is complete.

**Setup**: Agent IR with `voice: { provider: "elevenlabs", voice_id: "aria" }` (requires IR extension) + behavior profile `WHEN: context.channel == "voice"` → `VOICE: { provider: "azure", voice_id: "en-US-Jenny" }`.

**Steps**:

1. Resolve voice config WITHOUT active profile — assert: `{ provider: "elevenlabs", voice_id: "aria" }`.
2. Resolve voice config WITH active profile — assert: `{ provider: "azure", voice_id: "en-US-Jenny" }` (profile overrides agent-level).
3. Resolve voice config with NO IR values — assert: falls back to external provisioning (current behavior).

---

### INT-8: ActionHandlerIR dispatch — match action_id and execute SET/RESPOND/transition

**FR**: FR-6
**Boundary**: Flow step executor → ActionHandlerIR matching → session context
**File**: `apps/runtime/src/__tests__/action-handlers-integration.test.ts`

**Setup**: GatherStepIR with `on_action: [{ action_id: "confirm", set: { confirmed: true }, respond: { text: "Confirmed!" }, transition: "next_step" }]`.

**Steps**:

1. Dispatch action with `id: "confirm"` — assert: matched handler executes.
2. Assert: `confirmed === true` in session context.
3. Assert: response includes "Confirmed!".
4. Assert: flow transitions to `next_step`.
5. Dispatch action with `id: "unknown_action"` — assert: no handler matched, appropriate fallback.

---

### INT-9: GATHER AttachmentFieldIR validation — mime type, size, processing flags

**FR**: FR-7
**Boundary**: GATHER field collection → `attachment-tool-executor.ts` → multimodal pipeline
**File**: `apps/runtime/src/__tests__/gather-attachment-integration.test.ts`

**Setup**: GatherStepIR with attachment field: `{ category: "image", allowed_mime_types: ["image/png"], max_file_size_bytes: 5242880, processing: { ocr_enabled: true } }`.

**Steps**:

1. Submit `application/pdf` attachment — assert: rejected with "Allowed types: image/png".
2. Submit `image/png` at 10MB — assert: rejected with "Max size: 5MB".
3. Submit `image/png` at 2MB — assert: accepted.
4. Assert: multimodal pipeline receives `{ ocr_enabled: true }` processing flags.
5. Submit `image/png` with category mismatch (`video` field) — assert: rejected.

---

### INT-10: Connector action execution for ITSM escalation

**FR**: FR-2
**Boundary**: `escalation-bridge.ts` → connector registry → connector executor
**File**: `apps/runtime/src/__tests__/escalation-integration.test.ts`
**Implementation prerequisite**: Requires new `connector_action?: string` field on `EscalationConfig` or `EscalationRouting` in `schema.ts`. This field does not exist in the current IR.

**Setup**: Connector registered with mock ITSM endpoint. Agent IR with `connector_action: "servicenow_create_incident"` (requires IR extension).

**Steps**:

1. Trigger escalation with connector action reference.
2. Assert: connector registry resolves action for tenant.
3. Assert: connector executor POSTs to mock endpoint with escalation context payload.
4. Assert: returned ticket ID stored on HumanTask (`connectorTicketId`, `connectorTicketUrl`).

**Failure mode**: Connector not found → assert: escalation continues, `connectorTicketId` null, error trace emitted.

---

### INT-11: Concurrent double escalation — idempotency guard

**FR**: FR-1
**Boundary**: `escalation-bridge.ts` concurrent access → HumanTask model
**File**: `apps/runtime/src/__tests__/escalation-integration.test.ts`

**Steps**:

1. Fire two concurrent `handleEscalate()` calls for the same session ID.
2. Assert: only ONE HumanTask created (idempotency guard).
3. Assert: session escalated only once.

---

### INT-12: ON_ERROR retry with exponential backoff and exhaustion

**FR**: FR-8
**Boundary**: `error-handler-router.ts` → retry logic → fallback action
**File**: `apps/runtime/src/__tests__/error-handler-integration.test.ts`

**Setup**: Agent-level ON_ERROR (IR-level `ErrorHandler`) with `retry: 3, retry_backoff: "exponential"`, `then: "escalate"`. Note: `retry_backoff` values (`'fixed' | 'exponential' | 'linear'`) are from the `ErrorHandler` IR type in `schema.ts`.
**Dependency**: The `then: "escalate"` fallback depends on FR-1 (ESCALATE wiring) to trigger the full escalation pipeline.

**Steps**:

1. Trigger error that matches handler with retry.
2. Assert: retries 3 times with exponential backoff delays.
3. Assert: after 3rd failure, `then: "escalate"` action fires (requires FR-1 ESCALATE wiring).
4. Assert: trace events record each retry attempt and final escalation.

---

## 4. Unit Test Scenarios

### UT-1: EscalationConfig IR parsing — trigger conditions, context_for_human, on_human_complete

**Module**: `packages/compiler` — compilation of ESCALATE block
**Input**: DSL with ESCALATE block containing WHEN triggers, context, on_human_complete
**Expected Output**: `EscalationConfig` IR with correct trigger array, context fields, and `OnHumanComplete[]`

### UT-2: HooksConfig IR parsing — all 4 hook types with CALL/SET/RESPOND actions

**Module**: `packages/compiler` — compilation of HOOKS block
**Input**: DSL with HOOKS: before_agent, after_agent, before_turn, after_turn
**Expected Output**: `HooksConfig` IR with correct `HookAction` entries for each type

### UT-3: ActionHandlerIR compilation from standalone ACTION_HANDLERS DSL block

**Module**: `packages/compiler` — compilation of ACTION_HANDLERS block
**Input**: DSL with `ACTION_HANDLERS:` block containing action definitions
**Expected Output**: `ActionHandlerIR[]` with correct action_id, condition, set, respond, transition

### UT-4: VoiceConfigIR extension — provider, voice_id, speed from DSL

**Module**: `packages/compiler` — compilation of EXECUTION voice block
**Input**: DSL with `EXECUTION: voice: { provider: "elevenlabs", voice_id: "aria", speed: 1.2 }`
**Expected Output**: `VoiceConfigIR` with `provider`, `voice_id`, `speed` populated

### UT-5: ErrorHandlerRouter — handler matching priority order

**Module**: `apps/runtime` — `error-handler-router.ts`
**Input**: Error with type `invalid_input`, subtype `json_parse`
**Expected Output**: Matches step-level `invalid_input.json_parse` → step-level `invalid_input` → step DEFAULT → agent `invalid_input.json_parse` → agent `invalid_input` → agent DEFAULT (in priority order)

### UT-6: HookAction executor — CALL dispatches to ToolBindingExecutor

**Module**: `apps/runtime` — hook action executor
**Input**: `HookAction` with `call: "audit_logger"`
**Expected Output**: Tool binding executor invoked with tool name, result captured in trace

### UT-7: HookAction executor — SET assigns variable in session context

**Module**: `apps/runtime` — hook action executor
**Input**: `HookAction` with `set: { _turn_start: "NOW()" }`
**Expected Output**: Session context updated with `_turn_start` = current ISO timestamp

### UT-8: OnHumanComplete evaluation — condition matching and action dispatch

**Module**: `apps/runtime` — escalation resolution handler
**Input**: `OnHumanComplete[]` = `[{ condition: "resolution == 'resolved'", action: "continue" }]`, resolution = `"resolved"`
**Expected Output**: Condition matches, `continue` action fires, session resumes

### UT-9: AttachmentFieldIR validation — category derivation from mime type

**Module**: `apps/runtime` — attachment field validator
**Input**: mime type `image/png`, field category `image`
**Expected Output**: Category matches. Input `application/pdf`, field category `image` → rejection.

### UT-10: BehaviorProfile system tool protection — **escalate** cannot be hidden

**Module**: `apps/runtime` — profile tool merger
**Input**: Profile with `TOOLS_HIDE: ["__escalate__", "user_tool"]`
**Expected Output**: `__escalate__` preserved in tool list, `user_tool` removed, warning emitted.

---

## 5. Security & Isolation Tests

### Tenant Isolation

- [x] Cross-tenant escalation resolution returns 404 (E2E-14)
- [x] Cross-tenant escalation GET returns 404 (E2E-14)
- [x] HumanTask queries use `findOne({_id, tenantId})` pattern (INT-1)
- [ ] Hook tool calls carry session's tenantId — no cross-tenant tool execution
- [ ] ITSM connector action resolved from tenant's connector registry, not global

### Project Isolation

- [x] Cross-project escalation resolution returns 404 (E2E-14)
- [x] Escalation resolution requires `requireProjectPermission()` (E2E-15)
- [ ] HumanTask scoped by `projectId` in all queries

### User Isolation

- [x] Escalation resolution requires authorized user (E2E-15)
- [x] Session escalation details visible only to session owner + escalation-permitted users (E2E-16)
- [ ] Hook execution does not expose other users' session data

### Input Validation

- [ ] Escalation resolution API validates required fields (`respondedBy`, `fields`)
- [ ] Malformed action IDs rejected in ACTION_HANDLERS dispatch
- [ ] Attachment uploads validated against declared field constraints before processing
- [ ] Hook tool references validated at compile time (no injection via tool names)

### Data Protection

- [ ] `context_for_human` may contain PII — TraceScrubber applied to escalation traces
- [ ] ITSM webhook payload limited to `context_for_human` fields only (no session data leakage)
- [ ] Connector actions for ITSM use existing connector auth (OAuth/API key), no new credential paths

---

## 6. Performance & Load Tests

### PERF-1: Hooks latency impact per turn

**Target**: Hooks add < 100ms overhead per turn when hook tools respond within 50ms.
**Method**: Measure turn latency with and without hooks over 100 turns. Compare p50/p95.

### PERF-2: Concurrent escalation safety

**Target**: 5 concurrent sessions escalating simultaneously — no duplicate HumanTasks, no race conditions.
**Method**: `Promise.all()` with 5 concurrent escalation triggers for different sessions.

### PERF-3: Hook tool timeout does not block turn

**Target**: Slow hook tool (30s response) does not delay user's turn response beyond hook timeout.
**Method**: Configure hook with tool that sleeps 30s. Verify turn completes within normal timeout.

### PERF-4: Behavior profile evaluation at scale

**Target**: 10+ behavior profiles evaluated per turn with negligible latency (< 5ms).
**Method**: Agent with 15 profiles, measure evaluation time over 100 turns.

---

## 7. Test Infrastructure

### Required Services

| Service        | Source                 | Purpose                                         |
| -------------- | ---------------------- | ----------------------------------------------- |
| MongoDB        | MongoMemoryServer      | HumanTask persistence, session store            |
| Redis          | `redis-server-harness` | Agent-transfer session store, distributed locks |
| Express server | `runtime-api-harness`  | Full HTTP API with middleware chain             |

### Test Helpers

| Helper                | File                                                          | Used By               |
| --------------------- | ------------------------------------------------------------- | --------------------- |
| Runtime API Harness   | `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`   | All E2E tests         |
| MongoDB Setup         | `apps/runtime/src/__tests__/helpers/setup-mongo.ts`           | All integration tests |
| Redis Server Harness  | `apps/runtime/src/__tests__/helpers/redis-server-harness.ts`  | Agent-transfer tests  |
| Auth Context          | `apps/runtime/src/__tests__/helpers/auth-context.ts`          | Auth/isolation tests  |
| Channel E2E Bootstrap | `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` | Voice E2E tests       |
| Orchestration Harness | `apps/runtime/src/__tests__/helpers/orchestration-harness.ts` | Multi-agent tests     |

### Data Seeding Pattern

All tests use DSL-based seeding: raw ABL DSL strings → `compileToResolvedAgent()` → session-ready agent. Agent fixtures include:

- **Escalation agent**: ESCALATE block with triggers, context_for_human, on_human_complete, routing config
- **Hooks agent**: HOOKS block with all 4 lifecycle hooks using CALL/SET/RESPOND
- **Profile agent**: BEHAVIOR_PROFILES with WHEN conditions, TOOLS_ADD, TOOLS_HIDE, VOICE
- **Voice agent**: EXECUTION voice block with provider, voice_id, speed
- **Action agent**: GATHER step with ACTION_HANDLERS block
- **Attachment agent**: GATHER field with type:attachment, mime type constraints, processing flags
- **Error agent**: Agent-level ON_ERROR for invalid_input, validation_error, unknown_error

### Environment Variables

No new environment variables required. Tests use existing harness defaults:

- `ENCRYPTION_MASTER_KEY` — set by test harness
- `JWT_SECRET` — set by test harness
- Agent-transfer config — set programmatically in test setup

### CI Configuration

- E2E tests: `pnpm test` (default vitest tier, 30s timeout)
- Integration tests: `pnpm test:integration` (integration tier, 60s timeout, requires MongoMemoryServer)
- Run order: unit → integration → E2E (via Turbo pipeline)

---

## 8. Test File Mapping

| Test File                                                          | Type        | Covers                                    | Status  |
| ------------------------------------------------------------------ | ----------- | ----------------------------------------- | ------- |
| `apps/runtime/src/__tests__/escalation.e2e.test.ts`                | E2E         | FR-1, FR-2 (E2E-1 to E2E-3, E2E-14-16)    | PLANNED |
| `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`           | E2E         | FR-3 (E2E-4 to E2E-6, CROSS-2)            | PLANNED |
| `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`         | E2E         | FR-4 (E2E-7, E2E-8, CROSS-4)              | PLANNED |
| `apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts`       | E2E         | FR-5 (E2E-9)                              | PLANNED |
| `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`           | E2E         | FR-6 (E2E-10)                             | PLANNED |
| `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`        | E2E         | FR-7 (E2E-11, E2E-12)                     | PLANNED |
| `apps/runtime/src/__tests__/agent-on-error.e2e.test.ts`            | E2E         | FR-8 (E2E-13)                             | PLANNED |
| `apps/runtime/src/__tests__/escalation-integration.test.ts`        | Integration | FR-1, FR-2 (INT-1, INT-2, INT-10, INT-11) | PLANNED |
| `apps/runtime/src/__tests__/error-handler-integration.test.ts`     | Integration | FR-8 (INT-3, INT-12, CROSS-6)             | PLANNED |
| `apps/runtime/src/__tests__/behavior-profiles-integration.test.ts` | Integration | FR-4 (INT-4)                              | PLANNED |
| `apps/runtime/src/__tests__/hooks-integration.test.ts`             | Integration | FR-3 (INT-5, INT-6, CROSS-3)              | PLANNED |
| `apps/runtime/src/__tests__/voice-config-integration.test.ts`      | Integration | FR-5 (INT-7)                              | PLANNED |
| `apps/runtime/src/__tests__/action-handlers-integration.test.ts`   | Integration | FR-6 (INT-8, CROSS-5)                     | PLANNED |
| `apps/runtime/src/__tests__/gather-attachment-integration.test.ts` | Integration | FR-7 (INT-9)                              | PLANNED |

---

## 9. Cross-Feature Interaction Tests

These scenarios verify behavior at the intersection of multiple features wired in this effort.

### CROSS-1: BEHAVIOR_PROFILES + Voice — profile VOICE override reaches TTS

**Covers**: FR-4 + FR-5
**Type**: Integration (INT-7)
**Scenario**: Agent has base voice config `elevenlabs:aria`. Profile active for voice channel overrides to `azure:en-US-Jenny`. Assert TTS receives profile override.

### CROSS-2: ESCALATE + HOOKS — after_turn hook fires on escalation turn

**Covers**: FR-1 + FR-3
**Type**: E2E
**File**: `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`
**Scenario**: Agent with ESCALATE + after_turn hook. Escalation triggers mid-turn. Assert after_turn hook still fires (turn completed, regardless of escalation).

### CROSS-3: HOOKS + ON_ERROR — hook failure does not trigger ON_ERROR

**Covers**: FR-3 + FR-8
**Type**: Integration
**File**: `apps/runtime/src/__tests__/hooks-integration.test.ts`
**Scenario**: Hook CALL fails. Assert: hook failure is non-fatal (traced as warning), does NOT enter ON_ERROR handler chain. ON_ERROR is for execution errors, not hook infrastructure errors.

### CROSS-4: BEHAVIOR_PROFILES + ESCALATE — system tool protection

**Covers**: FR-4 + FR-1
**Type**: E2E (E2E-8)
**File**: `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`
**Scenario**: Profile tries `TOOLS_HIDE: [__escalate__]`. Assert `__escalate__` still available.

### CROSS-5: ACTION_HANDLERS + GATHER Attachments — action alongside attachment collection

**Covers**: FR-6 + FR-7
**Type**: Integration
**File**: `apps/runtime/src/__tests__/action-handlers-integration.test.ts`
**Scenario**: GATHER step with attachment field + action handler "Skip". User clicks Skip → transition fires, attachment not required.

### CROSS-6: ON_ERROR + ESCALATE — error handler triggers escalation

**Covers**: FR-8 + FR-1
**Type**: Integration
**File**: `apps/runtime/src/__tests__/error-handler-integration.test.ts`
**Scenario**: Agent ON_ERROR handler with `then: "escalate"`. Error occurs, retries exhausted → escalation triggers via the full ESCALATE pipeline.

---

## 10. Open Testing Questions

1. **LLM mock strategy for E2E**: E2E tests need an LLM to produce responses. Should we use a DI-injected mock LLM client (existing pattern from `MockAnthropicClient`) or a deterministic response fixture? The mock must be injected via DI, not `vi.mock`.
2. **Agent-transfer adapter for E2E**: The `kore` adapter talks to external Kore.ai APIs. For E2E tests, should we use the existing test adapter or create a lightweight in-memory adapter?
3. **Hook tool endpoint mocking**: Hooks fire CALL to tools. For E2E, tool endpoints need to be reachable. Should we use a local HTTP mock server (like `nock` or `msw` started as a real server) or define tools as `inline` type?
4. **Escalation resolution callback**: How does the human agent's resolution reach the runtime? Is it via webhook callback from agent-transfer, or direct API call? This affects E2E test design.
5. **ON_ERROR trigger mechanism for E2E**: How to reliably trigger an `unknown_error` in E2E without mocking? Options: send a message that causes the LLM mock to return invalid JSON, or configure a tool that always fails.
