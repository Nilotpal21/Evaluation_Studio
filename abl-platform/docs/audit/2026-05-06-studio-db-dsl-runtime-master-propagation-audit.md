# Studio -> DB -> DSL -> Runtime Master Propagation Audit

Date: 2026-05-06

Scope: comprehensive propagation audit for authored assistant output, structured payloads, lifecycle metadata, branch metadata, and project-scoped PII policy across Studio, DSL/YAML, compiler IR, runtime execution, channel delivery, persistence, traces, rehydration, and read surfaces.

This pass intentionally stops before implementation. The goal is a more stable master inventory: matrix first, canonical helper contracts second, bypass classification third, implementation slices later.

## Canonical End-To-End Matrix

Legend:

- `PASS`: source inspected and either covered by deterministic regression or clearly routed through an already-tested canonical helper
- `PARTIAL`: one or more sibling lanes are still missing, lossy, or not fully authorable
- `FAIL`: confirmed live gap in the current tree
- `UNKNOWN`: not fully traced or lacks enough proof
- `N/A`: not applicable

| Layer / Boundary    | Text response                      | Rich content            | Voice config            | Actions                 | Retry metadata | Completion metadata | Hook metadata | PII registry / policy propagation |
| ------------------- | ---------------------------------- | ----------------------- | ----------------------- | ----------------------- | -------------- | ------------------- | ------------- | --------------------------------- |
| Studio visual save  | `PASS` for visible text            | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `PARTIAL`      | `PARTIAL`           | `PARTIAL`     | `N/A`                             |
| Studio DSL save     | `PASS`                             | `PASS`                  | `PASS`                  | `PASS`                  | `PASS`         | `PASS`              | `PASS`        | `N/A`                             |
| DB persistence      | `PASS` for saved DSL/IR            | `PASS` for saved DSL/IR | `PASS` for saved DSL/IR | `PASS` for saved DSL/IR | `PASS`         | `PASS`              | `PASS`        | `PARTIAL`                         |
| YAML parser         | `PASS`                             | `PASS`                  | `PASS`                  | `PASS`                  | `PASS`         | `PASS`              | `PASS`        | `N/A`                             |
| DSL parser          | `PASS`                             | `PASS`                  | `PASS`                  | `PASS`                  | `PASS`         | `PASS`              | `PASS`        | `N/A`                             |
| Compiler IR         | `PASS`                             | `PASS`                  | `PASS`                  | `PASS`                  | `PASS`         | `PASS`              | `PASS`        | `N/A`                             |
| Runtime execution   | `PARTIAL`                          | `FAIL`                  | `FAIL`                  | `FAIL`                  | `PASS`         | `PASS`              | `PASS`        | `PARTIAL`                         |
| Channel delivery    | `PARTIAL`                          | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `N/A`          | `PARTIAL`           | `PARTIAL`     | `PARTIAL`                         |
| Message persistence | `PASS` for main protected envelope | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `N/A`          | `PARTIAL`           | `PARTIAL`     | `PARTIAL`                         |
| Traces              | `PARTIAL`                          | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `N/A`          | `N/A`               | `N/A`         | `PARTIAL`                         |
| Rehydration         | `PARTIAL`                          | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `N/A`          | `PARTIAL`           | `PARTIAL`     | `PARTIAL`                         |
| Read surfaces       | `PARTIAL`                          | `PARTIAL`               | `PARTIAL`               | `PARTIAL`               | `N/A`          | `PARTIAL`           | `PARTIAL`     | `PARTIAL`                         |

## Canonical Helper Contracts

| Concern                       | Canonical helper / contract                                                                                                                                                                                                | Expected caller behavior                                                                                                                                                                          | Current classification                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Structured output protection  | `protectSessionOutputForUser(...)`, `protectStructuredOutputForUser(...)`, `protectExecutionResultForUser(...)`, `emitProtectedExecutionResult(...)` in `apps/runtime/src/services/execution/session-output-protection.ts` | Any authored or model-generated assistant output should split redacted delivery from tokenized/protected history before `onChunk`, history, channel, or persistence.                              | `PARTIAL`                                        |
| Flow authored branch output   | `applyOnInputBranchResult(...)`, `rememberPendingRenderedPayload(...)`, and flow-local protection helpers in `apps/runtime/src/services/execution/flow-step-executor.ts`                                                   | Branch paths should interpolate, protect, remember, and return text plus `richContent` / `voiceConfig` / `actions` through the same helper family.                                                | `PARTIAL`                                        |
| Session PII context           | `refreshSessionPIIContext(...)`, session `piiRecognizerRegistry`, and policy snapshot helpers in `apps/runtime/src/services/pii/session-pii-context.ts`                                                                    | Runtime, traces, persistence, readback, guardrails, and CEL/builtin helpers should use the live project-scoped registry, not built-in-only fallbacks.                                             | `PARTIAL_FIXED` for structured return/readback   |
| Lifecycle serializer contract | `parseLifecycle(...)`, `serializeLifecycleToABL(...)`, `serializeLifecycleDiffToABL(...)`, `analyzeLifecycleVisualEditorCompatibility(...)`                                                                                | Studio visual saves should preserve supported hidden metadata or block unsafe writes when the visual editor cannot preserve a field.                                                              | `PARTIAL`                                        |
| Branch parsing contract       | `tryParseVoiceConfig(...)`, `tryParseFormatsBlock(...)`, `tryParseActionsBlock(...)`, YAML `parseActionSet(...)`, compiler `compileActions(...)`                                                                           | DSL/YAML/IR should carry `respond`, structured payloads, and action sets consistently for `ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`, `ON_FAILURE`, `ON_ERROR`, hooks, and completion.                 | `PASS` for parser/compiler, `PARTIAL` at runtime |
| Trace scrubbing               | `scrubTraceEvent(...)`, centralized trace handlers, `WritePipelineImpl.getPIIRecognizerRegistry`                                                                                                                           | Any trace data containing user text, tool args, model content, transcripts, or metadata should be scrubbed with the live session/project recognizer registry before TraceStore/EventStore writes. | `PARTIAL`                                        |

## Bypass Caller Classification

| Caller / Pattern                            | Classification           | Evidence                                                                                                                          | Notes                                                                                                                                        |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitProtectedExecutionResult(...)` callers | uses canonical helper    | `constraint-checker.ts`, `await-attachment-executor.ts`, `routing-executor.ts`, `reasoning-executor.ts`                           | Main helper-owned text result path is much stronger now.                                                                                     |
| Flow `ON_INPUT` normal and navigation paths | uses canonical helper    | `applyOnInputBranchResult(...)` is used for normal, targeted, and navigation lanes                                                | Current tree includes the navigation shortcut fix.                                                                                           |
| Flow `ON_RESULT` branch response            | partial use              | `flow-step-executor.ts` protects text and remembers structured payloads, but passes branch `actions` without action interpolation | Confirmed action payload contract gap.                                                                                                       |
| Flow output guardrail result handling       | bypass / partial use     | `flow-step-executor.ts` replaces only `response`, then remembers and returns original structured payloads                         | Confirmed structured payload policy drift.                                                                                                   |
| Runtime non-flow input guardrail block      | bypass                   | `runtime-executor.ts` writes `blockMessage` directly to `onChunk` and history                                                     | Confirmed output protection bypass.                                                                                                          |
| Runtime voice STT/tool traces               | uses canonical helper    | `korevg-router.ts` and `korevg-session.ts` route transcript/tool trace payloads through `addScrubbedVoiceTraceEvent(...)`         | Revalidated closed in current tree for STT, TTS, realtime tool-call, and voice-turn payload events.                                          |
| REST chat inline trace return               | bypass                   | `chat.ts` accumulates executor trace events and returns them directly in JSON responses                                           | Confirmed read-surface PII rendering bypass for success, auth-failure, timeout, and error responses.                                         |
| Internal chat inline trace return           | bypass                   | `internal-chat.ts` accumulates executor trace events and returns them directly in JSON responses                                  | Confirmed read-surface PII rendering bypass.                                                                                                 |
| Transcript export                           | bypass                   | `transcripts.ts` writes `RuntimeExecutor.getSessionDetail(...)` messages and traces directly to JSON files                        | Confirmed transcript persistence/export bypass for raw messages, content envelopes, metadata, and trace events.                              |
| Studio completion visual editor             | partial use              | state/serializer preserve hidden fields, UI exposes only `when` and `respond`                                                     | Not a broad confirmed silent-loss bug, but not fully authorable.                                                                             |
| Studio error-handling visual editor         | partial use              | state/serializer preserve hidden fields, UI exposes only `type`, `respond`, `then`                                                | Same shape as completion.                                                                                                                    |
| Auth lifecycle traces                       | unknown / inspected only | writes summarized auth requirements directly to TraceStore                                                                        | No raw message text found in builder; still bypasses central trace path.                                                                     |
| Voice local handoff prompt                  | partial / likely bypass  | `routing-executor.ts` emits `localVoiceHandoffMessage.text` directly                                                              | Message is localized/template-derived and should probably use output protection even though current interpolation is limited to target name. |

## Master Issue Register

### SDR-MASTER-001: Flow Output Guardrails Leave Original Structured Payloads Attached

- Severity: High
- Status: `FIXED`
- Confidence: Confirmed
- Seam: Runtime execution -> channel delivery -> persistence
- Source file: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Affected path: Flow `RESPOND` / `ON_SUCCESS` / `ON_FAILURE` output guardrail block, escalate, reask fallback, redact/fix/filter
- Evidence:
  - Guardrail actions now replace `response` and clear the approved structured payload variables before history, pending payload, thread return, or result construction.
  - Modified-content outcomes (`redact`/`fix`/`filter`) use the same clearing path as block/escalate/reask fallback because the structured payload was authored for the original text.
  - Regression locks in `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` assert blocked and modified guardrail responses do not return, remember, or persist the original `richContent`, `voiceConfig`, or `actions`.
- Impact: Closed for flow-authored output guardrail replacements; blocked or modified text no longer carries the original card, button, or voice payload through result delivery, pending payload, or assistant history.
- Regression lock status: Added
- Fixed status: Closed in Slice 1

### SDR-MASTER-002: Non-Flow Input Guardrail Block Bypasses Output Protection

- Severity: High
- Status: `FAIL`
- Confidence: Confirmed
- Seam: Runtime execution -> stream to client -> assistant history
- Source file: `apps/runtime/src/services/runtime-executor.ts`
- Affected path: Standard runtime input guardrail block before flow/reasoning execution
- Evidence:
  - The block path now wraps `blockMessage` with `protectSessionOutputForUser(...)`.
  - Streaming and final result use protected delivery text; assistant history stores protected/tokenized history text.
  - Regression lock in `apps/runtime/src/__tests__/execution/runtime-executor.test.ts` verifies a policy-authored block message containing a project-recognized contract ID is redacted for delivery and tokenized in history.
- Impact: Closed for standard runtime input guardrail block messages.
- Regression lock status: Added
- Fixed status: Closed in Slice 2

### SDR-MASTER-003: Voice Trace Payload Scrubbing Revalidation

- Severity: Informational
- Status: `FIXED`
- Confidence: Revalidated closed in current tree
- Seam: Traces -> TraceStore/EventStore
- Source files:
  - `apps/runtime/src/services/voice/korevg/korevg-router.ts`
  - `apps/runtime/src/services/voice/korevg/korevg-session.ts`
- Affected path: Google/OpenAI/Grok realtime voice STT, TTS, voice tool-call, and voice pipeline trace events
- Evidence:
  - Voice STT, TTS, voice-turn, realtime tool-call, and KoreVG session helper writes now route through `addScrubbedVoiceTraceEvent(...)`.
  - The helper runs built-in trace scrubbing and then applies the live session `piiRecognizerRegistry` recursively before TraceStore and EventStore writes.
  - Regression locks in `apps/runtime/src/services/voice/korevg/voice-trace-scrubbing.test.ts` cover STT transcripts, realtime tool-call arguments, missing project PII fallback, and central-helper storage.
- Impact: Closed for voice transcript/tool argument trace writes.
- Regression lock status: Added
- Fixed status: Closed in Slice 3

### SDR-MASTER-004: Branch Action Payloads Are Protected But Not Interpolated

- Severity: High
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> structured action delivery
- Source file: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Affected paths:
  - `ON_INPUT` branch actions
  - `ON_RESULT` branch actions
  - `ON_SUCCESS` / `ON_FAILURE` branch actions
- Evidence:
  - `applyOnInputBranchResult(...)` now interpolates `branchResult.actions` before handing branch payloads to `rememberPendingRenderedPayload(...)`.
  - `ON_RESULT` matched-branch payloads now interpolate `matchedBranch.actions` before pending delivery.
  - The final response normalization block now interpolates `stepActions` alongside rich content and voice config before PII protection, assistant history, pending delivery, and result return.
  - `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` locks action interpolation for direct flow responses, normal `ON_INPUT`, navigation-command `ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`, and `ON_FAILURE`.
- Impact: Authored action labels, values, and descriptions now resolve `{{...}}` variables consistently across flow and branch response surfaces before delivery or storage.
- Regression lock status: Added
- Fixed status: Closed in Slice 4

### SDR-MASTER-005: Flow Step Check Failure Emits Raw Runtime Text

- Severity: Medium
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> stream to client
- Source file: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Affected path: Flow `CHECK` failure with no `on_fail`
- Evidence:
  - The failed-check path now emits a stable sanitized user message instead of `Check failed: ${step.check}`.
  - The sanitized message is routed through `emitProtectedAssistantText(...)`, preserving the protected delivery/history split.
  - The existing `constraint_check` trace still retains the diagnostic condition for operators.
  - Regression locks in `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` and `apps/runtime/src/__tests__/execution/flow-execution-coverage.test.ts` assert chunks, result text, and assistant history omit the raw condition.
- Impact: Failed flow `CHECK` responses no longer expose internal condition text or condition literals to user-visible surfaces.
- Regression lock status: Added
- Fixed status: Closed in Slice 5

### SDR-MULTI-015 / MDRC-003: Fallback, Default Error, And Terminal Return Structured Envelopes

- Severity: Medium
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> parent history/readback
- Source files:
  - `apps/runtime/src/services/execution/flow-step-executor.ts`
  - `apps/runtime/src/services/execution/types.ts`
- Affected path: default `ON_ERROR` continue fallback, ELSE fallback, terminal child-thread return, structured-only child-thread return
- Evidence:
  - Default `ON_ERROR` continue fallback now returns and remembers protected `richContent`, `voiceConfig`, and `actions`.
  - ELSE fallback structured output remains protected across delivery/history.
  - `tryThreadReturn(...)` now treats structured-only return payloads as visible output even when `response` text is empty, appending a protected parent-history `contentEnvelope` instead of dropping the child return.
  - Regression locks in `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` cover default handler structured fallback, text-plus-structured child return, and structured-only child return.
- Impact: Parent-thread history and readback no longer lose terminal structured payloads simply because the child return had no text carrier.
- Regression lock status: Added
- Fixed status: Closed in Slice 11

### SDR-MASTER-006: Studio Lifecycle Visual Editors Remain Partial Authoring Surfaces

- Severity: Medium
- Status: `PARTIAL_SAFE`
- Confidence: Confirmed product gap, not confirmed broad silent corruption
- Seam: Studio visual save
- Source files:
  - `apps/studio/src/components/agent-editor/sections/CompletionEditor.tsx`
  - `apps/studio/src/components/agent-editor/sections/ErrorHandlingEditor.tsx`
  - `apps/studio/src/store/agent-detail-store.ts`
  - `apps/studio/src/lib/abl-serializers.ts`
- Affected path: Visual creation/editing of completion and error-handling advanced metadata
- Evidence:
  - Completion editor exposes only `when` and `respond`.
  - Error-handling editor exposes only `type`, `respond`, and `then`.
  - Store and serializer types preserve hidden `voiceConfig`, `richContent`, `actions`, retry metadata, and `store`.
  - Mutation locks in `apps/studio/src/__tests__/components/lifecycle-visual-editors.test.tsx` prove visible-field edits preserve hidden completion/error-handler metadata, while remove actions intentionally delete only the selected item and preserve siblings.
  - Serializer diff locks in `apps/studio/src/__tests__/abl-serializers.test.ts` prove partial lifecycle saves retain structured-only payloads, retry metadata, and `store` siblings.
  - Compatibility locks in `apps/studio/src/__tests__/lifecycle-visual-editor-compat.test.ts` continue to block dirty lifecycle saves only when unsupported metadata would be unsafe.
- Impact: Existing advanced lifecycle metadata is protected against accidental visual partial-edit loss. The visual UI is still not fully expressive for creating every advanced field, so this remains a product parity gap rather than an open silent-corruption bug.
- Regression lock status: Added for mutation safety
- Fixed status: Closed for silent-loss safety in Slice 6; full visual authoring remains product backlog

### SDR-MASTER-007: REST Chat Returns Raw Inline Trace Events

- Severity: High
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> read surfaces -> PII registry/policy rendering
- Source file: `apps/runtime/src/routes/chat.ts`
- Affected path: REST chat success, auth-failure, timeout, and execution-error JSON responses containing `traceEvents`
- Evidence:
  - `apps/runtime/src/routes/chat.ts` now routes every inline `traceEvents` response through `renderInlineTraceEventsForResponse(...)`.
  - `renderInlineTraceEventsForResponse(...)` delegates to the shared runtime read-surface renderer, which applies built-in secret/PII scrubbing and live runtime-session PII context when available.
  - `apps/runtime/src/__tests__/routes/runtime-read-surface-contract.test.ts` locks the REST chat route against reintroducing raw inline trace response wiring.
- Impact: REST chat inline trace payloads now use the same read-surface boundary as session read APIs before returning success, auth-required, timeout, queue-full, or execution-error trace data.
- Regression lock status: Added
- Fixed status: Closed in read-surface Slice 1

### SDR-MASTER-008: Internal Chat Returns Raw Inline Trace Events

- Severity: High
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> internal read surfaces -> PII registry/policy rendering
- Source file: `apps/runtime/src/routes/internal-chat.ts`
- Affected path: Internal chat JSON responses containing `traceEvents`
- Evidence:
  - `apps/runtime/src/routes/internal-chat.ts` now renders inline trace events with `renderRuntimeTraceEventsForReadSurface(...)` before returning the internal chat response.
  - The renderer loads runtime-session PII context when available, then applies the canonical trace read-surface renderer.
  - `apps/runtime/src/__tests__/routes/internal-chat.test.ts` locks the route with a trace payload containing email and authorization-like secret data.
- Impact: Internal chat consumers no longer receive raw inline trace data for the protected read-surface lane.
- Regression lock status: Added
- Fixed status: Closed in read-surface Slice 2

### SDR-MASTER-009: Transcript Export Writes Raw Messages And Traces

- Severity: High
- Status: `PASS`
- Confidence: Confirmed
- Seam: Runtime execution -> transcript persistence/export -> readback
- Source files:
  - `apps/runtime/src/routes/transcripts.ts`
  - `apps/runtime/src/services/runtime-executor.ts`
- Affected path: Transcript JSON export for live in-memory sessions
- Evidence:
  - `apps/runtime/src/routes/transcripts.ts` now renders `detail.messages` through `renderRuntimeMessagesForReadSurface(...)` and trace events through `renderRuntimeTraceEventsForReadSurface(...)` before writing transcript JSON.
  - The shared renderer preserves the same built-in secret/PII scrub behavior and runtime-session PII context hook used by inline trace responses.
  - `apps/runtime/src/__tests__/transcript-routes.test.ts` locks transcript file output so raw email and authorization-like secret data cannot be written.
- Impact: Transcript exports no longer bypass canonical message and trace read-surface protection before persistence to exported JSON files.
- Regression lock status: Added
- Fixed status: Closed in read-surface Slice 3

## Likely / Unknown Tracker

| ID                | Area                                                               | Status           | Why it remains in the tracker                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SDR-UNKNOWN-001` | Async `ChannelDispatcher` structured pending delivery and readback | `UNKNOWN`        | It forwards structured payloads and persists envelopes, but this audit did not prove every pending/resume/read API lane preserves delivery/history parity.                                                                                                     |
| `SDR-UNKNOWN-002` | Auth lifecycle trace storage                                       | `INSPECTED_ONLY` | Builder stores summarized connector/auth profile references directly. No raw user text found, but it bypasses centralized trace scrub/registry handling.                                                                                                       |
| `SDR-UNKNOWN-003` | Voice local handoff prompt                                         | `LIKELY`         | Voice handoff messages are emitted directly. Current template only interpolates target name, but the lane should still be routed through output protection for consistency.                                                                                    |
| `SDR-UNKNOWN-004` | Cross-channel rich content adaptation                              | `UNKNOWN`        | `channel/outcome.ts` preserves payload fields, but this pass did not enumerate Slack/Line/voice/A2A adapter behavior for every payload family.                                                                                                                 |
| `SDR-UNKNOWN-005` | Read APIs for structured content envelopes                         | `PARTIAL_FIXED`  | Slice 14 proves SDK HTTP chat delivery to project-scoped session readback preserves response, rich content, voice config, actions, and content envelopes. This audit moved REST/internal inline trace and transcript export gaps to confirmed master findings. |

## Implementation Slice Status

Completed read-surface hardening slices:

1. `SDR-MASTER-007`: REST chat inline trace responses now use canonical runtime trace rendering with runtime-session PII context when available.
2. `SDR-MASTER-008`: internal chat inline trace responses now use the same canonical runtime trace renderer.
3. `SDR-MASTER-009`: transcript-export messages and traces are rendered through canonical read-surface helpers before JSON files are written.

Remaining future-ready backlog:

1. `SDR-UNKNOWN-003`: decide whether voice local handoff prompts need the same output-protection seam despite the currently narrow interpolation source.
2. `SDR-UNKNOWN-004`: enumerate channel adapters for rich content, voice config, action, and completion/hook payload adaptation.
3. `SDR-MASTER-006`: decide whether Studio visual lifecycle parity means full UI editing or explicit blocked editing for unsupported fields.

## Audit Commands Used

Representative searches:

```bash
rg -n "emitProtectedAssistant|protectSessionOutput|protect.*Output|session-output-protection|refreshSessionPIIContext|piiRecognizerRegistry|serializeLifecycle|parseLifecycle|applyOnInputBranchResult|rememberPendingRenderedPayload|scrubTraceEvent" apps packages docs/audit
rg -n "conversationHistory\\.push|\\.conversationHistory\\.push|push\\(\\{ role: ['\\\"]assistant|role: ['\\\"]assistant|onChunk\\(|responseChunk|response_chunk|TraceStore|addEvent\\(|scrubTraceEvent\\(|richContent|voiceConfig|actions" apps/runtime/src/services apps/runtime/src/websocket packages/compiler/src/platform packages/core/src/parser apps/studio/src/lib apps/studio/src/store apps/studio/src/components/agent-editor/sections
rg -n "ON_INPUT|ON_RESULT|ON_SUCCESS|ON_FAILURE|ON_ERROR|COMPLETE|HOOKS|default_handler|compile.*Branch|compile.*Hook|compile.*Error|compile.*Complete|resolveFormats|voice_config|rich_content|actions" packages/core/src/parser packages/compiler/src/platform/ir apps/studio/src/lib apps/studio/src/store apps/studio/src/components/agent-editor/sections
rg -n "getTraceStore\\(\\)\\.addEvent|TraceStore\\.addEvent|addEvent\\(.*trace|scrubTraceEvent\\(" apps/runtime/src/services apps/runtime/src/websocket
```

## Notes

- This audit is not a mathematical proof of completeness. It is a bounded, source-backed tracker that is much harder to accidentally shrink back to the happy path.
- Any new finding should update this document as a row in the master issue register before code changes begin.
- Any fix should update `Fixed status` and add the exact regression lock.
