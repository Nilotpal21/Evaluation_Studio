# LLD: Runtime + Studio Contract Convergence

- **Primary design input:** `docs/superpowers/specs/2026-04-18-runtime-studio-contract-convergence-design.md`
- **Supporting feature specs:** `docs/features/agent-transfer.md`, `docs/features/pipeline-observability.md`, `docs/features/sub-features/localization-asset-management.md`
- **Status:** IN PROGRESS
- **Created:** 2026-04-19
- **Tickets:** `ABLP-376`, `ABLP-334`, `ABLP-326`, `ABLP-320`, `ABLP-319`, `ABLP-289`, `ABLP-288`, `ABLP-283`, `ABLP-280`, `ABLP-261`, `ABLP-245`, `ABLP-242`, `ABLP-240`, `ABLP-235`, `ABLP-231`

---

## 1. Why These Tickets Are One Program

These tickets are different symptoms of the same failure mode: Runtime, Studio, voice runtimes, Web SDK, and persistence do not share a stable contract for execution semantics, response payload shape, or control-plane settings. Local fixes landed in individual entry points, but the durable behavior still drifts when a second surface exercises the same feature.

This plan groups the work by contract boundary instead of by Jira number. The objective is not to patch the current symptom only; it is to make the next related issue impossible or at least much cheaper to fix.

---

## 2. Design Decisions

| ID  | Decision                                                                                           | Rationale                                                                                                                                     | Alternatives Rejected                          |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D-1 | Introduce shared execution primitives before more ticket-specific patches                          | `SET`, gather normalization, reroute, and realtime tool dispatch all fail for the same reason: behavior is reimplemented in separate branches | Continue patching each branch independently    |
| D-2 | Use batched workstreams with a small first shipping slice                                          | The backlog is large, but some fixes are low-risk foundations that unblock multiple tickets immediately                                       | Attempt a single big-bang rewrite              |
| D-3 | Keep compatibility by dual-reading legacy formats while introducing canonical contracts            | Existing sessions, persisted messages, and settings payloads must keep working during rollout                                                 | Hard cutover of all persisted/live contracts   |
| D-4 | Treat response fidelity and localization as ownership-domain problems, not only rendering problems | A live payload can already be richer than persisted history; the durable fix is metadata-preserving contracts                                 | Continue adding one-off UI rendering fallbacks |
| D-5 | Separate project intent from platform infrastructure in settings                                   | `ABLP-334` and related transfer/settings drift come from mixing auth references, secrets, and routing intent in one payload                   | Keep env-driven config as the source of truth  |

---

## 2.1 Current Slice Status

Implemented on the current branch:

- Workstream A first slice: step-entry `SET` execution, CEL-backed `SET` resolution fallback, and numeric-aware spoken-input normalization
- Workstream B first slice: realtime voice tool-executor wiring through voice session resolution with runtime-session-aware fallback behavior
- Workstream C first slice: eval scenario list/edit/save DTO fidelity for `initialMessage`, `expectedOutcome`, `agentPath`, and `expectedMilestones`
- Workstream C second slice: shared project-scoped transfer settings contract with canonical routing connection references plus Studio/runtime compatibility shims
- Workstream B second slice: realtime voice active-agent refresh and `__return_to_parent__` parity through the shared runtime reroute helper

Still deferred in this program:

- lossless persisted/live response envelope and localization-domain ownership split
- broader reporting and observability scope shaping

---

## 3. Workstreams

### Workstream A: Execution Semantics Core

**Tickets:** `ABLP-376`, `ABLP-320`, `ABLP-242`, `ABLP-235`, `ABLP-231`
**Future-ready objective:** one shared semantics layer for step entry, computed `SET`, normalized gather input, and reroute affordances that can be reused by scripted runtime and realtime voice.

Key outcomes:

- step-entry `SET` executes through one action evaluator instead of ad hoc string parsing
- arithmetic/CEL-backed `SET` behaves consistently with existing CEL evaluation
- numeric-aware spoken input normalization happens before extraction only when existing emitted field types or semantics require it
- parent-reroute and interruption affordances move toward a reusable coordinator instead of surface-specific branches
- realtime voice tool calls use the same execution path as chat/runtime tool calls
- a later compiler/core sub-phase can emit a canonical validation-plan IR once the runtime primitive is proven, but it is not a prerequisite for the first shipping slice

### Workstream B: Voice/Realtime Contract Parity

**Tickets:** `ABLP-231`, `ABLP-319`, `ABLP-240`
**Future-ready objective:** one voice capability contract for tool dispatch, DTMF input, agent resolution, and channel-specific fallbacks.

Key outcomes:

- shared realtime tool execution is wired into voice session resolution
- DTMF stays a first-class input method in the shared gather contract
- runtime route resolution prevents DB-name/DSL-name drift from reappearing without validation

### Workstream C: Studio/Runtime DTO Convergence

**Tickets:** `ABLP-326`, `ABLP-334`, `ABLP-283`
**Future-ready objective:** Studio and Runtime read and write the same typed DTOs for eval scenarios, transfer settings, and run-start behavior.

Key outcomes:

- eval scenario types and editor hydration remain lossless across create/list/edit/save
- agent transfer settings store project intent and auth profile references instead of env-only infrastructure assumptions
- run-start flow degrades safely when downstream execution infrastructure is unavailable

### Workstream D: Lossless Response and Localization Contracts

**Tickets:** `ABLP-245`, `ABLP-289`, `ABLP-261`
**Future-ready objective:** one lossless response envelope for live, persisted, and resumed sessions with explicit ownership-domain metadata for localization and hosted SDK hydration.

Key outcomes:

- persisted message/session history preserves rich content, actions, and metadata needed for replay/resume
- localization resolution distinguishes project-owned content from platform-owned content
- externally hosted SDK bootstrap/session hydration consumes the same durable envelope as Studio/live chat

### Workstream E: Observability and Reporting Surfaces

**Tickets:** `ABLP-280`, `ABLP-288`
**Future-ready objective:** health, runs, preview, and reporting surfaces expose only what the platform can actually guarantee, with a clear line between ABL-owned metrics and external contact-center metrics.

Key outcomes:

- pipeline observability remains queryable via stable APIs and honest status markers
- reporting gaps are handled as scoped product work, not hidden behind partial UI placeholders

---

## 4. File-Level Change Map

### New Files

| File                                                                         | Purpose                                              | LOC Estimate |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| `apps/runtime/src/services/execution/input-normalization.ts`                 | Normalized input variants for gather/extraction      | 120          |
| `apps/runtime/src/__tests__/execution/input-normalization.test.ts`           | Unit coverage for numeric-aware normalization        | 160          |
| `apps/runtime/src/__tests__/services/voice-session-resolver.test.ts`         | Realtime voice tool wiring coverage                  | 180          |
| `apps/studio/src/__tests__/components/evals/create-scenario-dialog.test.tsx` | Regression test for lossless scenario edit hydration | 180          |

### Modified Files

| File                                                                | Change Description                                                                    | Risk   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/execution/value-resolution.ts`           | Add CEL-aware `SET` resolution with legacy literal compatibility                      | Medium |
| `apps/runtime/src/services/execution/flow-step-executor.ts`         | Execute step-entry `SET`, apply normalized extraction input, and reuse shared helpers | High   |
| `apps/runtime/src/services/voice/voice-session-resolver.ts`         | Inject realtime tool execution into resolved voice executors                          | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                         | Pass realtime tool callback into voice session resolution                             | Medium |
| `apps/runtime/src/websocket/twilio-media-handler.ts`                | Pass realtime tool callback into voice session resolution                             | Medium |
| `apps/runtime/src/__tests__/execution/value-resolution.test.ts`     | Add CEL/set regression coverage                                                       | Medium |
| `apps/runtime/src/__tests__/realtime-voice-executor.test.ts`        | Confirm shared tool execution path still behaves correctly                            | Low    |
| `apps/studio/src/repos/eval-repo.ts`                                | Return the full scenario fields needed for lossless edit hydration                    | Low    |
| `apps/studio/src/hooks/useEvalData.ts`                              | Restore full scenario DTO shape                                                       | Low    |
| `apps/studio/src/components/evals/dialogs/CreateScenarioDialog.tsx` | Fix edit-state hydration for all scenario fields                                      | Low    |

### Deferred / Later Work (same program, not first slice)

| File/Area                                                                                                                                                                            | Deferred Reason                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/*`, `packages/compiler/src/platform/ir/schema.ts`, `packages/compiler/src/platform/constructs/semantic-hints.ts` | Canonical `GatherValidationPlan`/validation-contract emission is a follow-up once the runtime primitive is landed on existing IR |
| `packages/database/src/models/message.model.ts` and session resume payloads                                                                                                          | Larger schema and back-compat rollout required for lossless response envelope                                                    |
| `apps/runtime/src/config/agent-transfer.ts` and Studio transfer settings shared DTOs                                                                                                 | Needs project-vs-platform ownership contract, not a local patch                                                                  |
| Pipeline/reporting APIs beyond existing `ABLP-280` alpha scope                                                                                                                       | Product scope and external metric ownership need separate acceptance criteria                                                    |

---

## 5. Implementation Phases

### Phase 1: Execution Primitives Foundation

**Goal:** make `SET` semantics and gather normalization deterministic across scripted execution paths.

**Scope note:** the first slice uses the IR already emitted today (`field.type`, `validation`, and `semantics`) and does not depend on a same-change compiler/core contract expansion. Compiler-authored validation-plan IR stays as an explicit follow-up in this program.

**Tasks:**

1.1. Add a shared input-normalization helper that preserves raw text and exposes extraction-friendly variants for numeric/phone-like fields.
1.2. Extend `resolveSetValue()` to evaluate CEL expressions while preserving quoted-string, boolean, number, and template compatibility.
1.3. Add a `step.set` application path that runs on step entry exactly once per entry, before gather/collect logic.
1.4. Add unit and integration coverage for arithmetic `SET`, literal `SET`, and numeric spoken-input normalization.

**Files Touched:**

- `apps/runtime/src/services/execution/input-normalization.ts`
- `apps/runtime/src/services/execution/value-resolution.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/input-normalization.test.ts`
- `apps/runtime/src/__tests__/execution/value-resolution.test.ts`

**Exit Criteria:**

- [x] Step-entry `SET` updates session data for `SetAssignmentIR[]` steps
- [x] CEL expressions such as `count + 1` resolve through `resolveSetValue()`
- [x] Quoted strings and templates still keep legacy behavior
- [x] Numeric spoken phrases normalize only when active field types are numeric/phone-like
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds
- [x] Targeted runtime tests for value resolution and normalization pass

**Test Strategy:**

- Unit: normalization helper, CEL/literal `SET` resolution
- Integration: flow-step execution path for step-entry `SET`

**Rollback:** revert helper integration and keep legacy literal parsing only

---

### Phase 2: Realtime Voice Tool Parity

**Goal:** ensure realtime voice sessions dispatch tools through the same runtime execution path as chat.

**Tasks:**

2.1. Extend `resolveVoiceSession()` to accept an optional realtime tool executor callback.
2.2. Retrieve the active runtime session from `state.runtimeSession` or `getRuntimeExecutor().getSession(...)` in SDK/Twilio handlers, then pass a `RuntimeExecutor.executeRealtimeToolCall()` wrapper only when the runtime session is present.
2.3. Preserve the current pipeline fallback when `agentIR` is unavailable or voice entry starts before runtime session initialization completes.
2.4. Add resolver tests verifying the callback is wired into `RealtimeVoiceExecutor` and not silently dropped.

**Files Touched:**

- `apps/runtime/src/services/voice/voice-session-resolver.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `apps/runtime/src/__tests__/services/voice-session-resolver.test.ts`

**Exit Criteria:**

- [x] Realtime voice executors receive a `toolExecutor`
- [x] Tool calls from realtime voice use `RuntimeExecutor.executeRealtimeToolCall()`
- [x] Existing realtime voice executor tests continue to pass
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds

**Test Strategy:**

- Unit: resolver wiring
- Integration: reuse existing realtime tool call coverage plus resolver-specific tests

**Rollback:** remove injected callback and restore current no-op tool fallback

---

### Phase 3: Eval Scenario DTO Fidelity

**Goal:** make eval scenarios lossless across list/edit/save in Studio.

**Tasks:**

3.1. Update `findScenariosByProject()` to return the scenario fields needed for edit hydration: `initialMessage`, `expectedOutcome`, `agentPath`, and `expectedMilestones`.
3.2. Update `EvalScenario` client types to include those fields.
3.3. Hydrate all editable fields in `CreateScenarioDialog` when editing.
3.4. Add component coverage proving edit mode preserves these fields.

**Files Touched:**

- `apps/studio/src/repos/eval-repo.ts`
- `apps/studio/src/hooks/useEvalData.ts`
- `apps/studio/src/components/evals/dialogs/CreateScenarioDialog.tsx`
- `apps/studio/src/__tests__/components/evals/create-scenario-dialog.test.tsx`

**Exit Criteria:**

- [x] Scenario list responses include the fields needed for edit hydration
- [x] Opening an existing scenario hydrates `initialMessage`, `expectedOutcome`, `agentPath`, and `expectedMilestones`
- [x] Saving without touching those fields preserves them in the payload
- [x] `pnpm build --filter=@agent-platform/studio` succeeds
- [x] Targeted Studio component tests pass

**Test Strategy:**

- Unit/component: dialog edit hydration and submit payload

**Rollback:** revert DTO additions and dialog hydration changes

---

### Phase 4: Shared Transfer Settings Contract

**Goal:** replace env-driven SmartAssist-only assumptions with project-scoped intent plus auth-profile references.

**Tasks:**

4.1. Define a shared transfer settings DTO with explicit `authProfileId`/connection references.
4.2. Update Studio settings types and Runtime route/config readers to consume the DTO.
4.3. Add validation and compatibility shims for legacy env-backed config.

**Files Touched (planned):**

- `apps/studio/src/api/agent-transfer.ts`
- `apps/runtime/src/routes/agent-transfer-settings.ts`
- `apps/runtime/src/config/agent-transfer.ts`
- `packages/agent-transfer/...`

**Exit Criteria:**

- [x] Studio can save project-scoped SmartAssist intent without platform secrets in the payload
- [x] Runtime consumes the same DTO
- [x] Legacy env-based deployments continue to function during rollout

**Test Strategy:**

- Contract tests for route payloads
- Integration coverage for project-scoped settings resolution

**Rollback:** fall back to current runtime config loader and Studio DTO

---

### Phase 4.5: Voice Coordinator Contract Completion

**Goal:** finish the shared realtime voice control path so handoffs and parent returns mutate the live agent context instead of only the tool result text.

**Tasks:**

4.5.1. Extend the realtime voice tool executor contract to return structured active-agent state alongside the serialized tool result.
4.5.2. Update SDK and Twilio voice entry points to propagate the richer runtime tool result into `RealtimeVoiceExecutor`.
4.5.3. Reuse the shared `handleReturnToParentResult()` helper from realtime tool execution so `__return_to_parent__` behaves like the chat/runtime path.
4.5.4. Add targeted regressions for canonical transfer-state propagation and parent restoration.

**Files Touched (planned):**

- `apps/runtime/src/services/voice/realtime-voice-executor.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `apps/runtime/src/__tests__/execution/realtime-tool-call.test.ts`
- `apps/runtime/src/__tests__/realtime-voice-executor.test.ts`

**Exit Criteria:**

- [x] Realtime voice tool calls can update the active agent prompt/tool set without reconnecting the session
- [x] `__return_to_parent__` is supported in realtime voice sessions through the shared reroute helper
- [x] Runtime and realtime voice regressions cover active-agent refresh and parent restoration

**Test Strategy:**

- Unit: `RealtimeVoiceExecutor` structured tool-result handling
- Integration: `RuntimeExecutor.executeRealtimeToolCall()` parent restoration path

**Rollback:** restore string-only realtime tool results and the previous realtime `__return_to_parent__` block

---

### Phase 5: Lossless Response Envelope and Localization Ownership

**Goal:** preserve rich response fidelity and ownership metadata across live, persisted, and resumed sessions.

**Tasks:**

5.1. Define a canonical persisted response envelope for text, rich content, actions, voice config, and localization metadata.
5.2. Keep additive read-compatibility for legacy `content: string` history, then cut readers and writers to the canonical envelope with the shortest viable compatibility lane. Dual-write is only required if QA history must survive mixed-version deployments.
5.3. Introduce ownership-domain markers for project vs platform localization resolution.
5.4. Reuse the same envelope for hosted SDK hydration/resume.

**Exit Criteria:**

- [x] Persisted messages retain the fields needed for resume/replay
- [x] Localization resolution chooses the correct ownership-domain catalog
- [x] Hosted SDK resume consumes the same durable payload format

**Current status (2026-04-19, Slice 5):**

- Added a canonical read-side decoder for persisted message content so legacy JSON-string `ContentBlock[]` payloads can be normalized into `content + rawContent` without breaking string-only readers.
- DB-backed session detail and DB-backed runtime rebuild now preserve recovered `rawContent` when it exists, which improves resume fidelity without a schema migration.
- Added a canonical write-side `contentEnvelope` field for persisted messages, encrypted alongside the flattened `content` preview so rich content, actions, and voice config survive persistence without re-encoding them back into the legacy string field.
- Runtime persistence now writes the canonical envelope from the main assistant-response paths (`api`, `web_debug`, and SDK chat/interrupt flows) while keeping the Dev/QA-first single-write cutover posture.
- DB-backed session detail, cursor pagination, and Studio historical-session hydration now surface the canonical envelope so replay/resume readers can preserve the richer payload instead of dropping it on load.
- Runtime localization resolution now stamps durable ownership metadata for project-authored vs platform-authored fallback content, including locale and fallback-catalog provenance when localization assets are involved.
- Web debug `session_resumed` hydration now preserves `rawContent` and the durable `contentEnvelope`, so Studio replay/debug surfaces can restore the same structured payload shape used by persisted history readers.
- Hosted SDK bootstrap permissions now include `session:read` for interactive widgets, the shared session-messages route is browser-SDK CORS-safe, and the web SDK hydrates persisted history from that shared route instead of relying on a separate SDK-only replay contract.
- Studio now blocks saves when transfer-routing references are missing, incompatible, or inactive, which matches the Dev/QA-first fail-fast posture for project configuration drift instead of silently carrying stale settings forward.
- Dev/QA cutover assumption: pre-cutover sessions can be recreated after deploy, so the durable envelope rollout stays on the shorter single-write compatibility lane. Promote that to dual-write only if QA history must survive mixed-version runtime or Studio bundles.
- Phase 5 future-ready objective is now implemented for the current Dev/QA posture; remaining program work moves to Phase 6 and broader rollout/reporting cleanup.

**Test Strategy:**

- Integration tests for persistence/resume
- Integration tests for hosted SDK bootstrap/auth continuity
- Web SDK hydration tests

**Rollback:** keep the read-side decoder, revert the write-side envelope/localization path and hosted-SDK history hydration to the legacy compatibility lane, and require QA session recreation if the cutover needs to be rolled back

---

### Phase 6: Observability and Reporting Scope Hardening

**Goal:** keep pipeline/reporting surfaces accurate about what ABL owns and what external systems own.

**Tasks:**

6.1. Verify `ABLP-280` alpha surfaces remain wired and regression covered.
6.2. Separate ABL-owned metrics from external contact-center reporting asks for `ABLP-288`.
6.3. Add explicit deferred scope markers where UI/API would otherwise imply unsupported metrics.

**Exit Criteria:**

- [x] Pipeline health/runs/preview remain reachable from production surfaces
- [x] Unsupported contact-center metrics are not represented as implemented

**Test Strategy:**

- Route and wiring verification
- UI regression coverage where applicable

**Current status (2026-04-20, Slice 6):**

- Added a shared canonical pipeline-observability contract in `@agent-platform/shared` so Runtime and Studio expose the same support-level, metric-ownership, and deferred-capability metadata.
- Runtime pipeline-observability routes now return `meta.contract` on runs, health, previewable-pipelines, output-schema, and query responses.
- Studio runs/data surfaces now render the alpha scope notice directly in the UI, instead of implying unsupported manual rerun or external reporting coverage.
- Realtime voice sessions now advertise explicit voice capabilities, route `return_to_parent` through the shared runtime reroute helper, and share a cross-adapter interruption coordinator so SDK, Twilio, and KoreVG realtime owners all discard/switch from the same contract.
- Validation artifacts for this phase live in `projects/runtime-studio-convergence-validation/report.html` and the sibling `screenshots/` directory.

**Future-ready TODOs (intentionally deferred):**

- Unify positive DTMF support semantics across realtime providers instead of advertising `dtmf: false` only for the SDK realtime contract.
- Keep external contact-center reporting/export metrics on a separate owned contract rather than widening the alpha ABL-owned observability surface implicitly.
- Add earlier compile/deploy-time validation for invalid routing references so project drift is caught before runtime.

**Rollback:** revert nonessential UI scope changes and the canonical observability metadata if the alpha disclosure copy needs to be withdrawn

---

## 6. First Shipping Slice

The first implementation slice for this change is **Phase 1 + Phase 2 + Phase 3**. Those phases are the highest-leverage, lowest-migration foundations:

- they close concrete open gaps (`ABLP-376`, `ABLP-320`, `ABLP-231`, `ABLP-326`)
- they reduce future divergence by introducing shared primitives instead of one-off patches
- they do not require a schema migration or cross-repo rollout

Phases 4-6 stay in this plan as the next batched work, but they are not required to land the first durable slice safely.

---

## 7. Wiring Checklist

- [ ] Shared execution helpers are imported by `flow-step-executor.ts`
- [ ] Realtime tool executor callback is passed from both SDK and Twilio voice entry points
- [ ] New tests are added to the correct runtime and Studio test suites
- [ ] No new helper is left unused or unexported where callers need it
- [ ] Backward compatibility is preserved for legacy literal `SET` expressions and existing voice flows

---

## 8. Acceptance Criteria

- [ ] Step-entry `SET` is no longer ignored and supports CEL-backed arithmetic
- [ ] Numeric spoken input can be normalized for numeric/phone gather fields without changing raw transcript storage
- [ ] Realtime voice tool calls use the shared runtime tool execution path
- [ ] Eval scenarios no longer lose `initialMessage` or `expectedOutcome` during edit/save
- [ ] Runtime and Studio affected-package builds pass
- [ ] Targeted tests for the new behavior pass
- [ ] Remaining non-implemented workstreams are documented as planned follow-up, not silently implied as complete

---

## 9. Open Questions and Explicit Deferrals

1. `ABLP-245` and `ABLP-289` require a persistence/resume contract rollout and should not be forced into this first change.
2. `ABLP-334` needs a shared transfer settings DTO and project/platform ownership split; that should land as a dedicated follow-up phase rather than an unsafe local patch.
3. A later compiler/core phase should emit a canonical validation-plan IR instead of relying on runtime interpretation of existing `type`/`validation`/`semantics` fields.
