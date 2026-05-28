# Studio -> DB -> DSL -> Runtime Full Multidimensional Contract Matrix

Date: 2026-05-05

Scope: current working tree audit of authored response and execution-control contracts from Studio visual/DSL authoring through YAML/import/export, compiler IR, runtime execution, channel delivery, assistant persistence, traces, and readback.

Important note: this audit was run against the local workspace after commit `ffc31c150` plus the currently dirty working tree. Some issues from earlier drafts are now closed in this workspace, so this matrix supersedes the narrower `docs/audits/2026-05-05-studio-db-dsl-runtime-propagation-audit.md`.

## Coverage Model

The old "field x layer" matrix missed bugs because it collapsed runtime into one bucket and mostly measured happy-path text propagation. This matrix tracks each contract by boundary plus tags:

| Axis              | Values used in this audit                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Authoring surface | Studio visual, Studio DSL, YAML import, YAML export, saved IR reload                                                         |
| Mutation type     | create, edit, partial edit, add/remove item, toggle, no-op save                                                              |
| Execution lane    | init-time, normal turn, auto-advance, shortcut, terminal step, hook-triggered, handoff/delegate return, async/channel resume |
| Control-flow mode | happy path, branch match, ELSE/fallback, tool result, tool error, guardrail/constraint, completion, fail-open/fail-closed    |
| Payload shape     | text, rich content, voice config, actions, content envelope, tokenized history vs delivery                                   |
| Verification      | deterministic test, inspected only, not covered                                                                              |

## Status Legend

| Status       | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| PASS         | Code path is inspected and has direct or helper-level deterministic coverage.           |
| PARTIAL      | Main path works, but at least one lane/payload/mutation variant is unverified or lossy. |
| FAIL         | Confirmed current-code defect.                                                          |
| BLOCKED_SAFE | Surface cannot author the field, but save is blocked before silent corruption.          |
| UNKNOWN      | Not yet traced deeply enough to call safe.                                              |
| N/A          | Not applicable to this contract.                                                        |

## Boundary Matrix

| Contract item                       | Studio visual mutation | Studio DSL / YAML parse | YAML export / import | Compiler lowering | Runtime executor seam | Channel delivery | Persistence / readback | Coverage status                                                                                  |
| ----------------------------------- | ---------------------- | ----------------------- | -------------------- | ----------------- | --------------------- | ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `respond` text                      | PASS                   | PASS                    | PASS                 | PASS              | PASS                  | PASS             | PASS                   | Tested broadly                                                                                   |
| `rich_content`                      | PARTIAL                | PASS                    | PASS                 | PASS              | PARTIAL               | PASS             | PARTIAL                | Parser/compiler tests exist; structured-only runtime/history gaps remain                         |
| `voice_config`                      | PARTIAL                | PASS                    | PASS                 | PASS              | PARTIAL               | PASS             | PARTIAL                | Cross-pod and channel outcome improved; structured-only gaps remain                              |
| `actions`                           | PARTIAL                | PASS                    | PASS                 | PASS              | PARTIAL               | PASS             | PARTIAL                | Action-handler/flow support improved; structured-only and visual mutation gaps remain            |
| `store`                             | PARTIAL                | PASS                    | PASS                 | PASS              | PASS                  | N/A              | PASS                   | Completion store path is present; visual editor can preserve but not author all variants         |
| `default_handler`                   | PARTIAL                | PASS                    | PASS                 | PASS              | PASS                  | PASS             | PARTIAL                | Template rich content now lowers; visual structured-only serializer gap remains                  |
| `call_spec.with/as`                 | PARTIAL                | PASS                    | PASS                 | PASS              | PASS                  | N/A              | PASS                   | Canonical invocation is preserved in ON_START/hooks/branches; visual arg editing remains limited |
| `delegate` / `handoff` / `escalate` | PARTIAL                | PASS                    | PASS                 | PASS              | PARTIAL               | PARTIAL          | PARTIAL                | Main coordination works; terminal return/readback still has one lossy caller                     |
| PII registry / policy context       | N/A                    | N/A                     | PARTIAL              | PASS              | PARTIAL               | PARTIAL          | PASS                   | Output protection helpers are broad; structured-only no-history lanes need locks                 |

## Runtime Seam Matrix

| Runtime seam                                             | Text | Rich content | Voice config | Actions | History/content envelope | Status                                                                                         |
| -------------------------------------------------------- | ---- | ------------ | ------------ | ------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `ON_START` with `RESPOND`                                | PASS | PASS         | PASS         | PASS    | PASS                     | Structured payload is returned and recorded in protected history envelopes                     |
| `ON_START` structured-only                               | N/A  | PASS         | PASS         | PASS    | PASS                     | Structured-only init payloads now return and append protected history envelopes                |
| Hooks: `before_agent`                                    | PASS | PASS         | PASS         | PASS    | PASS                     | Current code returns emitted structured message                                                |
| Hooks: `before_turn` / `after_turn`                      | PASS | PASS         | PASS         | PASS    | PASS                     | Current code merges hook emitted payload into result                                           |
| Flow step `respond`                                      | PASS | PASS         | PASS         | PASS    | PARTIAL                  | Text-gated history entry still hides structured-only outputs                                   |
| `ON_INPUT` branch with `respond`                         | PASS | PASS         | PASS         | PASS    | PARTIAL                  | Shared branch helper is now used by navigation shortcuts                                       |
| `ON_INPUT` structured-only branch                        | N/A  | PASS         | PASS         | PASS    | PASS                     | Branch helper now preserves structured-only delivery and protected history envelopes           |
| `ON_RESULT` / `ON_SUCCESS` / `ON_FAILURE` with `respond` | PASS | PASS         | PASS         | PASS    | PARTIAL                  | Main branch payload is carried                                                                 |
| `ON_RESULT` structured-only branch                       | N/A  | PASS         | PASS         | PASS    | PASS                     | Matched branch path now preserves structured-only delivery and protected history envelopes     |
| Completion conditions                                    | PASS | PASS         | PASS         | PASS    | PASS                     | `executeComplete()` supports structured payloads and `store`                                   |
| Thread return from structured child result               | PASS | PASS         | PASS         | PASS    | PASS                     | `tryThreadReturn()` can now accept structured results                                          |
| Thread return via complete-transition string caller      | PASS | PASS         | PASS         | PASS    | PASS                     | Complete-transition caller returns the full structured payload into `tryThreadReturn()`        |
| Cross-pod WebSocket pub/sub                              | PASS | PASS         | PASS         | PASS    | N/A                      | Current subscriber forwards `voiceConfig` and `handoffProgress`                                |
| Channel outcome adaptation                               | PASS | PASS         | PASS         | PASS    | N/A                      | `ChannelOutcome` carries payloads through behavior contract                                    |
| Message persistence queue                                | PASS | PASS         | PASS         | PASS    | PASS                     | `structuredContent` and `contentEnvelope` are supported                                        |
| Session read APIs                                        | PASS | PASS         | PASS         | PASS    | PASS                     | Session routes include `contentEnvelope`; full replay parity still should be locked end-to-end |

## Confirmed Failing Cells

### MATRIX-001: Studio visual save can drop structured-only `ON_ERROR` and `COMPLETE` payloads

- Severity: P1
- Contract items: `rich_content`, `voice_config`, `actions`, `default_handler`, `store-adjacent completion metadata`
- Axes: Studio visual + partial edit + structured-only payload + save serializer
- Status: PASS
- Evidence:
  - `parseLifecycle()` loads invisible structured fields for error handlers and completion conditions from IR into section state: `apps/studio/src/store/agent-detail-store.ts:889`, `apps/studio/src/store/agent-detail-store.ts:910`.
  - The compatibility gate treats `voice_config`, `rich_content`, `actions`, and `store` as supported fields, so editing those sections is not blocked: `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts:15`, `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts:31`.
  - `ErrorHandlingEditor` and `CompletionEditor` only expose text/simple fields, but they preserve unknown sibling fields via object spread during partial edits: `apps/studio/src/components/agent-editor/sections/ErrorHandlingEditor.tsx:74`, `apps/studio/src/components/agent-editor/sections/CompletionEditor.tsx:60`.
  - The serializers only emit structured payloads under `if (h.respond)` / `if (c.respond)`: `apps/studio/src/lib/abl-serializers.ts:948`, `apps/studio/src/lib/abl-serializers.ts:1005`.
- Impact:
  - A policy that intentionally has voice/rich/actions without `RESPOND` can be parsed and marked visually safe, but a partial visual edit rewrites the section without those structured fields.
- Test lock:
  - Add a Studio serializer regression for `ON_ERROR.DEFAULT` and `COMPLETE` conditions where `respond` is empty and `voiceConfig`/`richContent`/`actions` are present; assert the emitted DSL preserves them or the compat gate blocks the save.

### MATRIX-002: `ON_START` structured-only output is ignored at runtime

- Severity: P1
- Contract items: `rich_content`, `voice_config`, `actions`
- Axes: init-time + structured-only payload + runtime executor + persistence/readback
- Status: FAIL
- Evidence:
  - `executeOnStart()` emits and traces only when `onStart.respond` exists: `apps/runtime/src/services/execution/flow-step-executor.ts:4171`.
  - It returns a structured result for delegate or respond paths, but returns `null` otherwise: `apps/runtime/src/services/execution/flow-step-executor.ts:4189`, `apps/runtime/src/services/execution/flow-step-executor.ts:4217`, `apps/runtime/src/services/execution/flow-step-executor.ts:4234`.
  - `on_start` IR/YAML can carry `voice_config`, `rich_content`, and `actions` independently: `packages/language-service/src/serialize-yaml.ts:1542`.
- Impact:
  - A YAML/DSL-authored startup card, voice override, or action set with no text is valid through authoring/export/compile but disappears during session initialization.
- Test lock:
  - Add runtime init test for `ON_START` with only `rich_content`/`voice_config`/`actions`; assert returned result, live delivery, conversation history envelope, and session readback preserve it.

### MATRIX-003: `ON_INPUT` structured-only branches are ignored

- Severity: P1
- Contract items: `rich_content`, `voice_config`, `actions`
- Axes: normal turn + branch match + navigation shortcut + structured-only payload
- Status: FAIL
- Evidence:
  - The shared `applyOnInputBranchResult()` helper only renders and remembers branch payloads inside `if (branchResult.respond)`: `apps/runtime/src/services/execution/flow-step-executor.ts:4343`.
  - Navigation shortcuts now correctly use this shared helper: `apps/runtime/src/services/execution/flow-step-executor.ts:7480`, so the old duplicate path is gone, but the helper itself remains text-gated.
- Impact:
  - A branch that should show only buttons/cards/voice prompts while transitioning is parsed and lowered, but runtime drops the structured payload unless a text response is also present.
- Test lock:
  - Add one `ON_INPUT` branch test with `then` plus `actions`/`rich_content` and no `respond`; run it through both normal branch match and navigation-command/gather shortcut.

### MATRIX-004: `ON_RESULT` / success / failure structured-only branches are ignored

- Severity: P1
- Contract items: `rich_content`, `voice_config`, `actions`, `call_spec.as`
- Axes: tool-result branch + branch match + structured-only payload + runtime executor
- Status: FAIL
- Evidence:
  - Matched result branches only emit and remember structured payloads inside `if (matchedBranch.respond)`: `apps/runtime/src/services/execution/flow-step-executor.ts:8773`.
  - The lower-level call-result block path preserves `stepVoiceConfig`, `stepRichContent`, and `stepActions` once selected: `apps/runtime/src/services/execution/flow-step-executor.ts:9007`, but the direct matched branch response path is still text-gated.
- Impact:
  - Tool-result routing can execute and bind `call_spec.as`, but branch-authored cards/actions/voice-only prompts are dropped when no text accompanies them.
- Test lock:
  - Add a flow tool result test where `ON_RESULT` matched branch has `actions` and `rich_content` but no `respond`; assert runtime result and persistence envelope.

### MATRIX-005: Terminal child-thread return still has a string-only caller

- Severity: P1
- Contract items: `delegate` / `handoff`, `rich_content`, `voice_config`, `actions`, content envelope
- Axes: terminal step + handoff/delegate return + structured payload + parent history
- Status: FAIL
- Evidence:
  - `tryThreadReturn()` supports structured results and writes a parent `contentEnvelope`: `apps/runtime/src/services/execution/types.ts:1574`, `apps/runtime/src/services/execution/types.ts:1693`.
  - The `nextStep === COMPLETE` path in flow execution now passes the full structured response payload rather than only `response`.
- Impact:
  - Child flow completion through this terminal-transition lane preserves child cards/actions/voice in parent history.
- Test lock:
  - Covered by `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`.

### MATRIX-006: Structured-only runtime messages often have no assistant history entry

- Severity: P2
- Contract items: content envelope, PII tokenized history vs delivery, rich/voice/actions
- Axes: structured-only payload + persistence/readback + PII output protection
- Status: PARTIAL
- Evidence:
  - `emitProtectedExecutionResult()` only pushes conversation history when `historyText` is non-empty: `apps/runtime/src/services/execution/session-output-protection.ts:393`.
  - Flow execution now appends protected assistant history envelopes for several structured-only authored paths, including `ON_START`, `ON_INPUT`, navigation, `ON_RESULT`, ELSE fallback, and default error-handler continue paths.
  - Hook execution has a special-case empty assistant entry for structured-only payloads: `apps/runtime/src/services/execution/hook-executor.ts:122`, showing the canonical behavior exists but is not shared.
- Impact:
  - Remaining helper-owned fallback/terminal paths can still miss messages whose only user-visible payload is a card, button set, or voice config.
- Test lock:
  - Continue narrowing helper-owned structured-only return paths with focused regressions.

## Confirmed Pass / Improved Cells

| Cell                                      | Current finding                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-pod WebSocket delivery              | `handler.ts` now parses and forwards `voiceConfig` and `handoffProgress` from pub/sub messages: `apps/runtime/src/websocket/handler.ts:1025`.                                                                                                                                                             |
| Hook output propagation                   | `before_agent`, `before_turn`, and `after_turn` emitted payloads are captured and merged into returned results: `apps/runtime/src/services/runtime-executor.ts:2079`, `apps/runtime/src/services/execution/reasoning-executor.ts:1841`, `apps/runtime/src/services/execution/reasoning-executor.ts:3778`. |
| Default handler template rich content     | Compiler tests now cover `TEMPLATE` rich content for `default_handler`: `packages/compiler/src/__tests__/template-resolution.test.ts:465`.                                                                                                                                                                |
| YAML export structured lifecycle payloads | `serialize-yaml` carries lifecycle rich/voice/actions/on_start fields: `packages/language-service/src/serialize-yaml.ts:100`, `packages/language-service/src/serialize-yaml.ts:1538`.                                                                                                                     |
| Message persistence envelope              | `persistMessage()` accepts structured content and builds `contentEnvelope`: `apps/runtime/src/services/message-persistence-queue.ts:1187`, `apps/runtime/src/services/message-persistence-queue.ts:1365`.                                                                                                 |
| Session read APIs                         | Session routes include `contentEnvelope` in returned message shapes: `apps/runtime/src/routes/sessions.ts:789`, `apps/runtime/src/routes/sessions.ts:888`.                                                                                                                                                |

## High-Value Unknown Cells

| Cell ID     | Contract                      | Axes                                                                                 | Why still unknown                                                                                                            | Best proof                                                                                                                |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| UNKNOWN-001 | Channel adapters              | async/channel resume + adapter-specific transform + structured-only payload          | Channel outcome contract is strong, but individual adapters still transform independently.                                   | Adapter-by-adapter black-box tests for structured-only cards/actions/voice on Slack, Teams, WhatsApp, VXML, and AI4W.     |
| UNKNOWN-002 | Readback/rehydration          | persisted envelope + session resume + Studio interactions tab                        | Session routes expose envelopes and Studio can enrich interactions, but not every resumed-session replay lane was traced.    | E2E session replay test comparing original runtime result to read API and Studio interactions enrichment.                 |
| UNKNOWN-003 | PII registry/policy context   | structured payload + handoff/delegate + parent return + read API reveal              | PII protection helpers are used widely, but structured-only parent-return and no-history lanes need closure first.           | Test with PII in card/action/voice payload across child return and readback under redact-output policy.                   |
| UNKNOWN-004 | Studio visual add/remove item | add/remove lifecycle handler or completion condition with invisible sibling metadata | Slice 6 locks partial edits as hidden-field preserving and remove actions as intentional deletion of only the selected item. | Covered by `apps/studio/src/__tests__/components/lifecycle-visual-editors.test.tsx` plus lifecycle serializer diff locks. |

## Test-First Closure Plan

### 2026-05-06 Implementation Update

The six confirmed failures from this matrix are now covered by deterministic tests and fixed in the local working tree:

| Cell       | Status after implementation | Regression lock                                                                                                        |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| MATRIX-001 | PASS                        | `apps/studio/src/__tests__/abl-serializers.test.ts` structured-only `ON_ERROR` and `COMPLETE`.                         |
| MATRIX-002 | PASS                        | `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` structured-only `ON_START`.                    |
| MATRIX-003 | PASS                        | `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` structured-only `ON_INPUT`.                    |
| MATRIX-004 | PASS                        | `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` structured-only `ON_RESULT`.                   |
| MATRIX-005 | PASS                        | `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` child-thread return envelope.                  |
| MATRIX-006 | PASS                        | `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts` plus flow history envelope coverage. |

The high-value unknown cells remain intentionally open for a follow-up adapter/readback proof pass.

1. Structured-only history contract
   - Lock `emitProtectedExecutionResult()` and flow-step structured-only history behavior first.
   - Implement one canonical `emitProtectedStructuredAssistantResult()` helper used by hooks, completion, flow steps, and branch helpers.

2. Runtime branch structured-only lanes
   - Lock `ON_START`, `ON_INPUT`, and `ON_RESULT` structured-only outputs.
   - Move payload interpolation/remembering outside `if (respond)` gates.

3. Terminal return parity
   - Lock child flow terminal completion with rich/voice/actions.
   - Pass a full `ExecutionResult` into `tryThreadReturn()` on the `nextStep === COMPLETE` path.

4. Studio visual mutation safety
   - Either serialize structured payloads even when `respond` is absent, or mark those cells unsupported so visual save blocks.
   - Add serializer and compat tests for `ON_ERROR.DEFAULT`, normal handlers, and `COMPLETE.conditions`.

5. Adapter/readback proof
   - After the canonical structured-only history fix, add end-to-end readback tests for session APIs and representative channel adapters.

## Audit Commands

Representative commands used:

```bash
rg -n "voice_config|rich_content|actions|default_handler|CompletionEditor|ErrorHandlingEditor|serializeOnStartToABL|parseLifecycle" apps/studio/src packages/core/src packages/compiler/src apps/runtime/src
rg -n "executeHook\\(|before_agent|before_turn|after_turn|emitProtectedAssistantText|tryThreadReturn|handoffProgress|persistMessage" apps/runtime/src/services apps/runtime/src/websocket packages/compiler/src/platform/ir/compiler.ts
rg -n "call_spec|with:| as:|delegate|handoff|escalate|PII|pii|policy|registry|store:" packages/core/src packages/compiler/src apps/runtime/src/services apps/studio/src
rg -n "contentEnvelope|structuredContent|buildExecutionResultContentEnvelope|createPersistedStructuredMessageEnvelope|persistMessage\\(" apps/runtime/src/services apps/runtime/src/websocket apps/runtime/src/routes
```
