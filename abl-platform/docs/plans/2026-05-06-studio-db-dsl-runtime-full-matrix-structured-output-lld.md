# LLD: Studio -> DB -> DSL -> Runtime Full Matrix Structured Output Closure

**Audit Source**: `docs/audit/2026-05-06-studio-db-dsl-runtime-propagation-master-tracker.md`
**Status**: IN PROGRESS
**Date**: 2026-05-06

## Design Decisions

| #   | Decision                                                                                          | Rationale                                                                                           | Alternatives Rejected                                                                  |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D-1 | Treat structured-only assistant output as a first-class message, not metadata on text.            | Cards, actions, voice config, and localized envelopes are user-visible even when text is empty.     | Forcing authors to add dummy text; silently dropping payloads.                         |
| D-2 | Persist a content envelope whenever structured output exists, even if `response` is empty.        | Readback, rehydration, PII history, and channel replay need one canonical persisted representation. | Keeping hook-only empty-message behavior as a one-off.                                 |
| D-3 | Move branch payload handling outside `if (respond)` gates.                                        | Runtime branch control flow and runtime payload emission are independent concerns.                  | Duplicating branch-specific fixes in each lane.                                        |
| D-4 | Prefer serializer preservation for Studio visual mutation safety.                                 | Visual editors already preserve invisible sibling fields in state; serializers should not erase.    | Blocking all visual saves for structured-only lifecycle payloads.                      |
| D-5 | Keep unknown adapter/readback cells as proof slices after canonical runtime persistence is fixed. | Adapter parity tests are meaningful only after runtime always creates a stable structured message.  | Starting with adapter-specific patches before the canonical runtime contract is fixed. |

## Target Contract

Every assistant-authored output seam must preserve this invariant:

```typescript
interface AuthoredAssistantOutputContract {
  response: string; // may be empty
  richContent?: RichContentIR;
  voiceConfig?: VoiceConfigIR;
  actions?: ActionSetIR;
  localization?: unknown;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2; // required when any structured field exists
}
```

The delivery form may redact PII for the user. The history form must tokenize PII where the session policy requires it. Both forms must retain structured fields when `response === ""`.

## Implementation Gap Backlog

This backlog is the implementation feed from the master tracker. It intentionally includes confirmed bugs, likely contract gaps, and proof gaps that must become deterministic regression locks before a slice is considered closed.

| ID      | Priority | Gap                                                                                                                                               | Primary files                                                                                                                                                 | Implementation slice |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| MTR-001 | P1       | Normal `FLOW`, `ON_INPUT`, navigation shortcut, and `ON_RESULT` action payloads are not interpolated consistently.                                | `apps/runtime/src/services/execution/flow-step-executor.ts`                                                                                                   | Slice 2              |
| MTR-002 | P2       | WebSocket, SDK WebSocket, and HTTP chat hand-roll structured assistant content instead of delegating to the canonical helper.                     | `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/routes/chat.ts`                                       | Slice 6              |
| MTR-003 | P2       | Trace-only Studio replay synthesizes text-only assistant messages and drops structured payloads.                                                  | `apps/studio/src/utils/replay-trace-events.ts`                                                                                                                | Slice 5              |
| MTR-004 | P2       | Session detail live/persisted merge can prefer a text-equivalent but structurally poorer message.                                                 | `apps/runtime/src/routes/sessions.ts`                                                                                                                         | Slice 5              |
| MTR-005 | P3       | Observatory summaries read legacy `message`/`text` instead of `dsl_respond.rendered`.                                                             | `apps/studio/src/utils/observatory-event-presentation.ts`                                                                                                     | Slice 5              |
| MTR-006 | P2       | Channel outcome traces do not carry successful structured output if traces are expected to be rehydratable.                                       | `apps/runtime/src/services/channel/outcome.ts`                                                                                                                | Slice 7              |
| MTR-007 | P2       | AI4W flattens `richContent` and `actions` to transformed text without an explicit capability contract.                                            | `apps/runtime/src/routes/ai4w-channel.ts`, `apps/runtime/src/channels/adapters/ai4w-content-transformer.ts`                                                   | Slice 7              |
| MTR-008 | P2       | Manifest channels lack all-payload parity proof for `richContent`, `voiceConfig`, and `actions` according to capability.                          | `apps/runtime/src/channels/manifest.ts`, `apps/runtime/src/channels/adapters/*`, `apps/runtime/src/services/channel/outcome.ts`                               | Slice 8              |
| MTR-009 | P2       | Agent-transfer websocket, channel adapter, and voice gateway lanes lack structured payload and transcript parity proof.                           | `apps/runtime/src/services/agent-transfer/message-bridge.ts`, `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`                            | Slice 9              |
| MTR-010 | P2       | Runtime config propagation is only partially locked across Studio/API save, compiler IR, runtime resolution, import, and read surfaces.           | `apps/runtime/src/routes/project-runtime-config.ts`, `apps/runtime/src/services/config/*`, `packages/project-io/src/import/runtime-config-save-validation.ts` | Slice 10             |
| MTR-011 | P2       | Import/export propagation is only partially locked for project importer/exporter, direct apply, runtime config, and rich payload materialization. | `packages/project-io/src/import/*`, `packages/project-io/src/export/*`, `apps/studio/src/lib/project-import/*`                                                | Slice 11             |

## Strict Gate Policy

`pnpm audit:propagation:lint` is the inventory gate: it should pass when all surfaces and known gaps are documented. Implementation slices should add or use a stricter enforcement gate that fails on unresolved `GAP`, `Bypass`, `Unknown`, `Missing`, or `Open` statuses for the slice being closed.

## Slice Plan

### Slice 1: Canonical Structured-Only History

**Goal**: A structured-only execution result creates an assistant history entry with a persisted content envelope.

**Tests First**:

- Add helper-level regression coverage for `emitProtectedExecutionResult()` with `richContent`, `voiceConfig`, and `actions` but no text.
- Assert delivery payload is redacted, history envelope is tokenized, and `conversationHistory` receives an assistant entry.

**Implementation**:

- Extend `protectExecutionResultForUser()` to retain the protected history-side structured payload.
- Update `emitProtectedExecutionResult()` to push an empty-text assistant message with `contentEnvelope` whenever structured history payload exists.

**Exit Criteria**:

- `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts` passes.
- No existing text-only output behavior changes.

### Slice 2: Runtime Branch Structured-Only Lanes

**Goal**: `ON_START`, `ON_INPUT`, and `ON_RESULT` preserve structured-only payloads through delivery and pending auto-advance state.

**Tests First**:

- Add `ON_START` structured-only runtime test.
- Add `ON_INPUT` normal and navigation/gather shortcut structured-only tests.
- Add `ON_RESULT` structured-only test.

**Implementation**:

- Introduce a small flow-step helper that interpolates, protects, emits history envelope, and remembers structured payloads independently from `respond`.
- Use it from `executeOnStart()`, `applyOnInputBranchResult()`, and matched `ON_RESULT` branch handling.

**Exit Criteria**:

- Relevant execution tests pass.
- Branches with `respond` keep current streaming and trace behavior.

### Slice 3: Terminal Child-Thread Return Parity

**Goal**: Terminal complete-transition child returns pass the full structured `ExecutionResult` to parent threads.

**Tests First**:

- Add a regression that exercises the `nextStep === COMPLETE` flow-transition lane with child structured payloads.
- Assert parent history contains the structured `contentEnvelope`.

**Implementation**:

- Build a full terminal result object at the complete-transition seam and pass it to `tryThreadReturn()` instead of the plain response string.

**Exit Criteria**:

- Existing `tryThreadReturn()` tests and new terminal-lane test pass.

### Slice 4: Studio Visual Mutation Safety

**Goal**: Visual lifecycle saves do not drop structured-only `ON_ERROR` or `COMPLETE` payloads.

**Tests First**:

- Add serializer tests for `ON_ERROR.DEFAULT` and `COMPLETE.conditions` with no `respond` and with structured payloads.
- Add a diff serializer test to prove partial visual edits preserve invisible sibling payloads.

**Implementation**:

- Emit structured respond payload blocks whenever structured lifecycle fields exist, not only under truthy `respond`.
- If DSL grammar requires a parent `RESPOND`, emit `RESPOND: ""` explicitly as the stable carrier.

**Exit Criteria**:

- Studio serializer tests pass.
- Parsed serialized output round-trips through `parseAgentBasedABL()` without errors.

### Slice 5: Adapter and Readback Proof

**Goal**: Convert rehydration, trace replay, session detail, and observatory readback gaps into deterministic coverage.

**Tests First**:

- Add representative readback/replay test comparing runtime result to session read API content envelope.
- Add Studio trace-only replay coverage for `message.agent` with `contentEnvelope`, `richContent`, `voiceConfig`, and `actions`.
- Add session detail merge coverage where text matches but only one message has structured payloads.
- Add observatory presentation coverage for `dsl_respond.rendered`.

**Implementation**:

- Prefer the richest structured message during active/persisted session merge.
- Rehydrate trace-only assistant messages from structured `message.agent` payloads before text-only fallbacks.
- Read `data.rendered` before legacy `message`/`text` fields in observatory summaries.

**Exit Criteria**:

- MTR-003, MTR-004, and MTR-005 are fixed or explicitly blocked with regression locks.

### Slice 6: Canonical Direct Chat Constructors

**Goal**: Eliminate structured-content drift in direct chat surfaces.

**Tests First**:

- Add parity tests for WebSocket, SDK WebSocket, typed interrupt, on-start, and HTTP chat responses against `buildPersistedMessageStructuredContent()`.
- Include `richContent`, `voiceConfig`, `actions`, localization, retry/completion metadata, and future envelope fields.

**Implementation**:

- Replace manual `assistantStructuredContent` constructors with a thin shared adapter that delegates to the canonical persisted-message helper.
- Keep channel-specific response shaping separate from durable content envelope construction.

**Exit Criteria**:

- MTR-002 is fixed.
- Bypass scan classifications for `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, and `apps/runtime/src/routes/chat.ts` move from `Partial/bypass` to canonical or intentionally channel-specific.

### Slice 7: Channel Outcome and AI4W Contract

**Goal**: Decide and lock whether channel traces and AI4W responses are rehydratable structured surfaces or deliberate text-only capability boundaries.

**Tests First**:

- Add channel outcome trace coverage proving successful structured outcomes are either emitted for replay or intentionally absent because durable messages are source of truth.
- Add AI4W coverage for structured sideband delivery or explicit text-only flattening with documented capability metadata.

**Implementation**:

- If traces are rehydratable, include successful structured channel outcome payloads in `buildOutcomeTraceEvent()`.
- If AI4W is text-only, document the capability boundary in channel behavior/manifest tests and ensure flattening is deterministic.

**Exit Criteria**:

- MTR-006 and MTR-007 are fixed or downgraded to documented non-issues with regression locks.

### Slice 8: Manifest Channel Parity

**Goal**: Every channel in `CHANNEL_MANIFEST` has a capability-aware proof for `richContent`, `voiceConfig`, and `actions`.

**Tests First**:

- Add a table-driven channel manifest conformance test that asserts every channel has one of: preserves structured payload, transforms to native structured format, or intentionally rejects/flattens with documented capability status.
- Prioritize Slack, Teams, WhatsApp, Messenger, Telegram, email, AG-UI, SDK/web debug/web chat, voice LiveKit/Twilio/KoreVG/AudioCodes, and A2A.

**Implementation**:

- Add missing adapter capability declarations or native transforms only where tests prove drift.
- Keep text-only channels explicit rather than treating them as failures.

**Exit Criteria**:

- The Channel Surface Coverage Matrix has no unexplained `P`, `GAP`, `Unknown`, or missing lock for the channels in scope.

### Slice 9: Agent Transfer Parity

**Goal**: Agent-transfer websocket, channel adapter, and voice gateway lanes preserve transcript identity and structured-output decisions.

**Tests First**:

- Add transfer bridge tests for human-agent responses containing rich payload surrogates, actions/forms, and voice gateway transcript metadata.
- Add transcript persistence coverage for delivery channel, participant type, PII scope, source session identity, and structured flattening decisions.

**Implementation**:

- Route agent-transfer delivery through the same channel capability/structured-output helpers where possible.
- Keep human-agent form rendering text-only only when the destination channel contract requires it.

**Exit Criteria**:

- Agent-transfer matrix rows have deterministic regression locks and no unclassified direct assistant history writes.

### Slice 10: Runtime Config Propagation

**Goal**: Runtime config survives Studio/API save, DB persistence, compiler IR, runtime resolution, import validation, and readback.

**Tests First**:

- Add end-to-end route/import/readback coverage for representative runtime config fields, including NLU/model/provider/tool config where applicable.
- Add compiler/runtime resolver parity coverage for the same fixture.

**Implementation**:

- Fix schema-route-resolver drops surfaced by the tests.
- Keep import validation aligned with runtime write validation.

**Exit Criteria**:

- Runtime config row moves from partial to fully locked for the fields in scope.

### Slice 11: Import/Export Propagation

**Goal**: Project import/export and direct apply preserve runtime config, rich templates, actions, voice config, lifecycle blocks, and module metadata.

**Tests First**:

- Add project export/import round-trip fixtures covering rich templates, lifecycle `ON_*` blocks, runtime config, guardrails, PII/module metadata, and agent transfer/channel references.
- Add direct-apply tests proving imported structured payloads reach DB and compile/runtime read surfaces.

**Implementation**:

- Fix exporter materialization or importer direct-apply drops surfaced by the round-trip tests.
- Keep backward-compat import stripping explicit and documented.

**Exit Criteria**:

- Import/export row has deterministic round-trip locks and no unclassified propagation drops.

## File-Level Change Map

| File                                                                               | Change                                                                 | Risk |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| `apps/runtime/src/services/execution/session-output-protection.ts`                 | Canonical structured-only history emission.                            | Med  |
| `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`  | Helper-level regression lock.                                          | Low  |
| `apps/runtime/src/services/execution/flow-step-executor.ts`                        | Remove `respond` gates from structured branch payload handling.        | High |
| `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`            | Runtime structured-only lane regressions.                              | Low  |
| `apps/runtime/src/__tests__/routing/routing-executor-helpers.test.ts`              | Terminal return regression, if existing helper coverage is sufficient. | Low  |
| `apps/studio/src/lib/abl-serializers.ts`                                           | Preserve structured-only lifecycle payloads.                           | Med  |
| `apps/studio/src/__tests__/abl-serializers.test.ts`                                | Studio visual serializer regression locks.                             | Low  |
| `docs/audit/2026-05-06-studio-db-dsl-runtime-propagation-master-tracker.md`        | Update cell statuses after implementation.                             | Low  |
| `docs/plans/2026-05-06-studio-db-dsl-runtime-full-matrix-structured-output-lld.md` | Track implementation status.                                           | Low  |

## Future-Ready Guardrails

- Structured fields must never be nested under text-only conditionals in runtime emission code.
- Any new assistant output helper must accept empty `response` plus structured payloads.
- New channel adapters must prove behavior for structured-only payloads, not only text-plus-structure.
- Studio visual serializers must either preserve invisible fields or block saves with a compatibility finding; silent omission is never allowed.

## Acceptance Criteria

- All six confirmed matrix failures have deterministic regression tests.
- All six confirmed matrix failures are fixed or intentionally blocked safe.
- The audit matrix is updated with final PASS/PARTIAL/UNKNOWN status.
- Scoped runtime and Studio test commands pass.
- Changed files are formatted with Prettier before commit.
