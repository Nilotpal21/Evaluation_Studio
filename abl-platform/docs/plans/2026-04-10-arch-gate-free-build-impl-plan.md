# LLD: Arch Conversational Flow — Gate-Free Onboarding

**Feature Spec**: `docs/features/sub-features/arch-gate-free-build.md`
**HLD**: `docs/specs/arch-gate-free-build.hld.md`
**Test Spec**: `docs/testing/sub-features/arch-gate-free-build.md`
**Status**: DRAFT
**Date**: 2026-04-10

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                             | Rationale                                                                                                                                                                      | Alternatives Rejected                                       |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| D-1 | Types + state machine first, route handler later                                     | Type changes cascade everywhere — fixing types first catches compile errors early                                                                                              | Route-first: too large a blast radius without type safety   |
| D-2 | Extract BLUEPRINT→BUILD transition into shared function before deleting gate handler | The gate handler has ~130 lines of topology diff + metadata work. Moving it to a shared function preserves behavior, then both `continue` and `proceed_to_next_phase` call it. | Inline duplication: two copies of the same logic            |
| D-3 | Deterministic tool config generation (template-based, no LLM) for v1                 | Faster, cheaper, no token budget risk. LLM-assisted tool gen is a follow-up.                                                                                                   | LLM-generated tool configs: slower, may exceed token budget |
| D-4 | `buildProgress` written via atomic `$set` per-agent, not bulk-written at end         | Enables mid-build resume. If browser closes after 3/5 agents, progress is persisted.                                                                                           | Bulk write at end: loses progress on interruption           |
| D-5 | Keep `GATE_PENDING` in `RESUMABLE_STATES` for one release, then remove               | Allows `getCurrent()` to find old GATE_PENDING sessions for cleanup. Removing immediately would orphan them.                                                                   | Remove immediately: old sessions become invisible           |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/types/session.ts — NEW
interface BuildProgress {
  stage: 'generating' | 'tools' | 'complete';
  agentStatuses: Record<string, 'pending' | 'generated' | 'compiled' | 'warning' | 'error'>;
  toolStatuses: Record<string, 'pending' | 'generated' | 'warning' | 'error'>;
}

// packages/arch-ai/src/types/session.ts — MODIFIED
// PendingInteraction simplifies from union to single type:
// BEFORE: PendingWidgetInteraction | PendingGateInteraction
// AFTER:  PendingWidgetInteraction
type PendingInteraction = PendingWidgetInteraction;

// packages/arch-ai/src/types/session.ts — REMOVED
// BuildSubPhase, AgentReviewGatePayload, ToolGenerationGatePayload,
// QualityFloorGatePayload, TopologyApprovalGatePayload, PendingGateInteraction

// packages/arch-ai/src/tools/definitions.ts — NEW
const PROCEED_TO_NEXT_PHASE_TOOL: LLMToolDefinition = {
  name: 'proceed_to_next_phase',
  description: 'Advance to the next onboarding phase when the user confirms readiness.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the user is ready' },
    },
    required: ['reason'],
  },
};
```

### Module Boundaries

| Module                                 | Responsibility                                                          | Depends On                         |
| -------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| `types/session.ts`                     | Session type definitions (BuildProgress, simplified PendingInteraction) | None                               |
| `types/constants.ts`                   | SESSION_STATES (without GATE_PENDING)                                   | None                               |
| `coordinator/session-state-machine.ts` | State transition validation (no GATE_PENDING transitions)               | `types/constants.ts`               |
| `coordinator/phase-machine.ts`         | Phase exit criteria (simplified BUILD)                                  | `types/session.ts`                 |
| `tools/definitions.ts`                 | Tool schemas (add proceed_to_next_phase)                                | None                               |
| `session/session-service.ts`           | DTO mapping (add buildProgress, drop gate fields)                       | `types/session.ts`                 |
| `session/resume-snapshot.ts`           | Resume derivation (from buildProgress)                                  | `types/session.ts`, `coordinator/` |
| Route handler (message)                | Gate removal, proceed tool handler, buildProgress writes, auto tool gen | All above                          |
| Route handler (sessions/current)       | GATE_PENDING cleanup on load                                            | `session/session-service.ts`       |
| `useArchChat` hook                     | Remove gate handling, keep widget handling                              | SSE types                          |
| UI components                          | BuildProgressCard, TopologyGraphView, BuildSummaryCard                  | `buildProgress`                    |

---

## 2. File-Level Change Map

### New Files

| File                                                           | Purpose                                                | LOC Estimate |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| `apps/studio/src/components/arch-v3/chat/BuildSummaryCard.tsx` | Rich build completion summary in chat                  | ~120         |
| `apps/studio/src/lib/arch-ai/phase-transition.ts`              | Shared transition logic (extracted from route handler) | ~150         |

### Modified Files

| File                                                                    | Change Description                                                                                | Risk     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `packages/arch-ai/src/types/session.ts`                                 | Add BuildProgress, remove gate types, simplify PendingInteraction                                 | Med      |
| `packages/arch-ai/src/types/constants.ts`                               | Remove GATE_PENDING from SESSION_STATES                                                           | Low      |
| `packages/arch-ai/src/types/tools.ts`                                   | Add proceed_to_next_phase to PHASE_TOOL_MAP                                                       | Low      |
| `packages/arch-ai/src/coordinator/session-state-machine.ts`             | Remove GATE_PENDING transitions                                                                   | Low      |
| `packages/arch-ai/src/coordinator/phase-machine.ts`                     | Simplify BUILD exitCriteria                                                                       | Low      |
| `packages/arch-ai/src/coordinator/index.ts`                             | Remove gate queue exports                                                                         | Low      |
| `packages/arch-ai/src/tools/definitions.ts`                             | Add PROCEED_TO_NEXT_PHASE_TOOL                                                                    | Low      |
| `packages/arch-ai/src/session/session-service.ts`                       | Add buildProgress to toArchSession, drop gate-era fields                                          | Med      |
| `packages/arch-ai/src/session/resume-snapshot.ts`                       | Rewrite to derive from buildProgress, remove gate builders                                        | High     |
| `packages/arch-ai/src/prompts/phases/build.ts`                          | Remove gate references, add narration instructions                                                | Low      |
| `packages/arch-ai/src/prompts/phases/blueprint.ts`                      | Remove "coordinator presents for approval"                                                        | Low      |
| `packages/arch-ai/src/prompts/base.ts`                                  | Allow "build it" when exit criteria met                                                           | Low      |
| `packages/arch-ai/src/index.ts`                                         | Update exports (remove gate builders, add BuildProgress)                                          | Low      |
| `packages/arch-ai/src/types/message-request.ts`                         | Remove gate_response variant                                                                      | Low      |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | Remove ~400 lines of gate handlers, add proceed tool handler, buildProgress writes, auto tool gen | **High** |
| `apps/studio/src/app/api/arch-ai/sessions/current/route.ts`             | Add GATE_PENDING cleanup                                                                          | Low      |
| `apps/studio/src/hooks/useArchChat.ts`                                  | Remove gate_request handler, gate_pending state, sendGateResponse                                 | Med      |
| `apps/studio/src/store/arch-ai-store.ts`                                | Remove approvedAgents/currentReviewAgent                                                          | Low      |
| `apps/studio/src/app/arch/page.tsx`                                     | Derive UI stages from phase + buildProgress                                                       | Med      |
| `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`         | Two-column layout from buildProgress                                                              | Med      |
| `apps/studio/src/components/arch-v3/panels/TopologyGraphView.tsx`       | Add buildStatus prop                                                                              | Med      |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | Derive proceed CTA from resume.nextAction                                                         | Low      |

### Deleted Files

| File                                                       | Reason             |
| ---------------------------------------------------------- | ------------------ |
| `apps/studio/src/lib/arch-ai/gate-manager.ts`              | No gates remain    |
| `apps/studio/src/components/arch-v3/chat/ApprovalGate.tsx` | No gates remain    |
| `packages/arch-ai/src/coordinator/build-gate-queue.ts`     | Gate queue removed |

---

## 3. Implementation Phases

### Phase 1: Backend Types & State Machine (`packages/arch-ai`)

**Goal**: Remove GATE_PENDING from the type system and state machine, add BuildProgress type.

**Tasks**:

1.1. Add `BuildProgress` interface to `types/session.ts`. Add `buildProgress?: BuildProgress` to `SessionMetadata`.

1.2. Remove from `types/session.ts`: `BuildSubPhase`, `AgentReviewGatePayload`, `ToolGenerationGatePayload`, `QualityFloorGatePayload`, `TopologyApprovalGatePayload`, `PendingGateInteraction`. Simplify `PendingInteraction = PendingWidgetInteraction`. Remove `PendingGatePayload` union. Remove `buildSubPhase`, `approvedAgents`, `selectedTools` from `SessionMetadata`.

1.3. Remove `'GATE_PENDING'` from `SESSION_STATES` in `types/constants.ts`.

1.4. Remove `'ACTIVE->GATE_PENDING'` and `'GATE_PENDING->ACTIVE'` from `VALID_STATE_TRANSITIONS` in `coordinator/session-state-machine.ts`. Add `'GATE_PENDING'` to `RESUMABLE_STATES` (keep for compat cleanup — D-5).

1.5. Simplify BUILD `exitCriteria` in `coordinator/phase-machine.ts`: check `topology.agents.every(a => a.name in files)` instead of the buildSubPhase + approvedAgents logic.

1.6. Remove `pickNextGate`, `diffTopologyAgainstBuildState` exports from `coordinator/index.ts`. Keep `build-gate-queue.ts` file but stop exporting it (can delete in follow-up).

1.7. Add `PROCEED_TO_NEXT_PHASE_TOOL` to `tools/definitions.ts`. Add `'proceed_to_next_phase'` to `PHASE_TOOL_MAP` for INTERVIEW, BLUEPRINT, BUILD in `types/tools.ts`.

1.8. Remove `gate_response` variant from `MessageRequestSchema` in `types/message-request.ts`.

1.9. Update `packages/arch-ai/src/index.ts` exports: remove gate builder functions, add `BuildProgress` type export.

**Files Touched**:

- `packages/arch-ai/src/types/session.ts`
- `packages/arch-ai/src/types/constants.ts`
- `packages/arch-ai/src/types/tools.ts`
- `packages/arch-ai/src/types/message-request.ts`
- `packages/arch-ai/src/coordinator/session-state-machine.ts`
- `packages/arch-ai/src/coordinator/phase-machine.ts`
- `packages/arch-ai/src/coordinator/index.ts`
- `packages/arch-ai/src/tools/definitions.ts`
- `packages/arch-ai/src/index.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` compiles with 0 type errors
- [ ] `validateStateTransition('ACTIVE', 'GATE_PENDING')` throws `InvalidTransitionError`
- [ ] `PHASE_TOOL_MAP.BUILD` includes `'proceed_to_next_phase'`
- [ ] `MessageRequestSchema.safeParse({ type: 'gate_response', ... })` returns `success: false`
- [ ] `BuildProgress` type is exported from package index
- [ ] BUILD exit criteria returns true when all topology agents have files, false otherwise

**Test Strategy**:

- Unit: Rewrite `session-state-machine.test.ts` (remove GATE_PENDING valid cases, add invalid case). Rewrite `phase-machine.test.ts` (simplified BUILD criteria). Add `message-request.test.ts` case for gate_response rejection.

**Rollback**: Revert this commit. Re-add GATE_PENDING and gate types.

---

### Phase 2: Backend Session Service & Resume (`packages/arch-ai`)

**Goal**: Update DTO mapping and resume snapshot to use buildProgress, remove gate artifacts.

**Tasks**:

2.1. Update `toArchSession()` in `session-service.ts`: add `buildProgress` mapping from Mongo doc. Stop mapping `buildSubPhase`, `approvedAgents`, `selectedTools` (leave them in Mongo, just don't read).

2.2. Rewrite `buildResumeSnapshot()` in `resume-snapshot.ts`: derive `nextAction` from `phase + buildProgress + topology + files + pendingInteraction`. Remove all gate-based derivation (pickNextGate calls, gate builder calls, tool generation gate logic). Remove `normalizeApprovedAgents`, `normalizeSelectedTools`, `buildToolEntries` helper functions. Remove gate builder functions (`buildAgentReviewGateInteraction`, `buildToolGenerationGateInteraction`, `buildQualityFloorGateInteraction`, `buildTopologyApprovalGateInteraction`).

2.3. Update `ResumeArtifacts` type: replace `build.subPhase` / `build.selectedTools` / `build.pendingToolNames` with `buildProgress`. Remove `approvedAgents` from artifacts.

**Files Touched**:

- `packages/arch-ai/src/session/session-service.ts`
- `packages/arch-ai/src/session/resume-snapshot.ts`
- `packages/arch-ai/src/types/session.ts` (ResumeArtifacts type only)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` compiles clean
- [ ] `toArchSession()` maps `buildProgress` from Mongo doc
- [ ] `buildResumeSnapshot()` returns `nextAction: 'continue_phase'` for partial BUILD (2/4 agents)
- [ ] `buildResumeSnapshot()` returns `nextAction: 'create_project'` for complete BUILD
- [ ] `buildResumeSnapshot()` returns `nextAction: 'continue_phase'` for BLUEPRINT with topology
- [ ] No references to `pickNextGate` or gate builder functions in resume-snapshot.ts
- [ ] Resume snapshot unit tests pass (rewritten for buildProgress)

**Test Strategy**:

- Unit: Rewrite `resume-snapshot.test.ts` — 5 test cases (mid-generating, tools stage, complete, BLUEPRINT with topology, no buildProgress fallback).

**Rollback**: Revert. Old toArchSession and resume still work with old session data.

---

### Phase 3: Backend Route Handler — Phase Transitions & Gate Removal (`apps/studio`)

**Goal**: Remove all gate handlers from the message route, extract shared transition logic, add proceed_to_next_phase tool handler, add GATE_PENDING cleanup.

**Tasks**:

3.1. **Extract shared transition function** into `apps/studio/src/lib/arch-ai/phase-transition.ts`:

```typescript
async function executePhaseTransition(
  ctx: { tenantId: string; userId: string },
  session: ArchSession,
  emit: EmitFn,
  journalAppend: JournalFn,
): Promise<{ transitioned: boolean; error?: string }>;
```

This function: checks exit criteria → runs phase-specific metadata updates (topologyApproved for BLUEPRINT, buildProgress init for BUILD) → runs `diffTopologyAgainstBuildState` for BLUEPRINT→BUILD → calls `sessionService.updatePhase()` → emits `phase_transition` SSE. All DB operations use `{ _id, tenantId, userId }` triple-filter.

3.2. **Refactor the `continue` handler** (route.ts:3284-3455): replace the gate-dependent transition paths with a call to the shared `executePhaseTransition()`. Remove the BLUEPRINT-specific gate emission. Remove the BUILD recovery code for stuck buildSubPhase.

3.3. **Add `proceed_to_next_phase` tool handler**: when the multi-turn executor processes this tool call, the route calls `executePhaseTransition()`. If exit criteria not met, return tool error result to LLM. If met, transition phase and return success.

3.4. **Remove gate_response handling** (route.ts:3677-4437): delete the entire `if (msg.type === 'gate_response')` block including all sub-handlers (topology_approval, agent_review, tool_generation, quality_floor).

3.5. **Remove gate emission calls**: delete all `emitGateAndPersist()` calls, all `buildTopologyApprovalGateInteraction()` calls, all `buildAgentReviewGateInteraction()` calls. Remove `GateManager` import and usage.

3.6. **Delete `apps/studio/src/lib/arch-ai/gate-manager.ts`**.

3.7. **Add GATE_PENDING cleanup** to `apps/studio/src/app/api/arch-ai/sessions/current/route.ts`: if loaded session has `state: 'GATE_PENDING'`, auto-archive it and return null.

3.8. **Add GATE_PENDING check** to `POST /message`: if session state is `GATE_PENDING`, archive and return HTTP 409.

3.9. **Update prompts**: remove gate references from `build.ts`, `blueprint.ts`, and `base.ts`. Add narration instructions to build prompt. Allow proceed intent in base prompt.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` (major changes)
- `apps/studio/src/lib/arch-ai/phase-transition.ts` (NEW)
- `apps/studio/src/lib/arch-ai/gate-manager.ts` (DELETE)
- `apps/studio/src/app/api/arch-ai/sessions/current/route.ts`
- `packages/arch-ai/src/prompts/phases/build.ts`
- `packages/arch-ai/src/prompts/phases/blueprint.ts`
- `packages/arch-ai/src/prompts/base.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` compiles clean
- [ ] No `gate_request` SSE event in route output for any onboarding phase
- [ ] `continue` handler for BLUEPRINT→BUILD sets `topologyApproved = true` and runs diff
- [ ] `proceed_to_next_phase` tool transitions INTERVIEW→BLUEPRINT when exit criteria met
- [ ] `proceed_to_next_phase` returns error when exit criteria not met
- [ ] Old GATE_PENDING session on GET /sessions/current → archived, null returned
- [ ] POST /message with GATE_PENDING session → 409
- [ ] `gate-manager.ts` file deleted
- [ ] No references to `GateManager`, `emitGateAndPersist`, or gate builder functions in route handler

**Test Strategy**:

- Integration: INT-3 (BLUEPRINT→BUILD transition), INT-4 (proceed tool all transitions), INT-5 (gate_response schema rejection), INT-7 (GATE_PENDING cleanup), INT-8 (mixed intent).

**Rollback**: Revert. Re-add gate handlers and GateManager. The shared transition function is additive — can be kept even on revert.

---

### Phase 4: Backend BUILD Auto-Generation & buildProgress Writes (`apps/studio`)

**Goal**: Add buildProgress persistence during BUILD, auto tool config generation, and chat narration.

**Tasks**:

4.1. **Add buildProgress initialization**: when phase transitions to BUILD, initialize `buildProgress: { stage: 'generating', agentStatuses: { [name]: 'pending' for each topology agent }, toolStatuses: {} }`.

4.2. **Add per-agent buildProgress writes**: after each `file_changed` SSE for an agent, `$set metadata.buildProgress.agentStatuses.{name} = 'generated'`. After each `compile_result` pass, set to `'compiled'`. On compile warning, set to `'warning'`. On compile error, set to `'error'`.

4.3. **Add auto tool config generation**: after all agents compile (detected by checking `buildProgress.agentStatuses` — all `compiled` or `warning`), extract tools via `extractAllTools(files)`, generate HTTP configs deterministically (template-based per FR-5.5), write each to `metadata.toolDsls.{toolName}` and `metadata.buildProgress.toolStatuses.{toolName}`, emit `file_changed` SSE per tool config. After all tools: `$set metadata.buildProgress.stage = 'complete'`.

4.4. **Add chat narration**: emit `text_delta` SSE events during BUILD summarizing each agent (name, mode, tools, quality pills) and a final build summary when complete.

4.5. **Remove buildSubPhase/approvedAgents mutations**: delete all `$set: { 'metadata.buildSubPhase': ... }` and `$addToSet: { 'metadata.approvedAgents': ... }` operations.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` (BUILD section)

**Exit Criteria**:

- [ ] After BUILD generation, `session.metadata.buildProgress.stage === 'complete'`
- [ ] `session.metadata.buildProgress.agentStatuses` has entries for every topology agent
- [ ] `session.metadata.toolDsls` has entries for every extracted tool (FR-5.5 write path works)
- [ ] `session.metadata.buildProgress.toolStatuses` has entries for every tool
- [ ] SSE stream includes `file_changed` events for tool configs
- [ ] SSE stream includes `text_delta` narration for each agent
- [ ] No `buildSubPhase` or `approvedAgents` writes in the route handler

**Test Strategy**:

- Integration: INT-2 (buildProgress persistence), INT-6 (toolDsls write path), INT-10 (toolDsls verification).

**Rollback**: Revert BUILD-specific route changes. Phase 3's transition logic still works without buildProgress writes.

---

### Phase 5: Frontend — Gate Removal & UI Stage Derivation (`apps/studio`)

**Goal**: Remove all gate UI, derive UI stages from backend phase + buildProgress.

**Tasks**:

5.1. **Remove gate handling from `useArchChat.ts`**: delete `gate_request` case in SSE handler (line ~618-673), remove `gate_pending` from `ChatState`, delete `sendGateResponse` method, remove `gateRequest` field from `ChatMessage` type, remove gate restoration in `loadSession` (line ~400-425).

5.2. **Delete `ApprovalGate.tsx`** entirely. Remove its import from `chat/index.ts` barrel export.

5.3. **Update `arch-ai-store.ts`**: remove `approvedAgents`, `currentReviewAgent`, and their actions (`setApprovedAgents`, `approveAgent`, `unapproveAgent`, `setCurrentReviewAgent`). Add `buildProgress` mirror field if needed for non-SSE components.

5.4. **Update `/arch/page.tsx`**: derive UI stage from `session.metadata.phase` + `session.metadata.buildProgress` + `session.metadata.topology`. Map to visual layout: discover (INTERVIEW), build.topology_reveal (BLUEPRINT + topology), build.generating (BUILD + generating), build.complete (BUILD + complete), create (CREATE). Remove gate-related rendering.

5.5. **Update `OnboardingArtifactPanel.tsx`**: derive proceed CTA from `resume.nextAction` instead of ephemeral suggestions. "Build This" button when phase=BLUEPRINT, "Create Project" when buildProgress.stage=complete.

**Files Touched**:

- `apps/studio/src/hooks/useArchChat.ts`
- `apps/studio/src/components/arch-v3/chat/ApprovalGate.tsx` (DELETE)
- `apps/studio/src/store/arch-ai-store.ts`
- `apps/studio/src/app/arch/page.tsx`
- `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` compiles clean
- [ ] No imports of `ApprovalGate` anywhere in the codebase
- [ ] No references to `gate_pending`, `sendGateResponse`, `gateRequest` in `useArchChat`
- [ ] `/arch` page renders correct UI stage for each backend phase
- [ ] "Build This" button appears in BLUEPRINT, "Create Project" in BUILD complete
- [ ] IN_PROJECT overlay still works (`proposal_response` handling intact)

**Test Strategy**:

- Unit: UT-5 (UI stage derivation). Manual: verify IN_PROJECT overlay.
- Integration: INT-9 (IN_PROJECT compat smoke test).

**Rollback**: Revert frontend changes. Backend changes from Phase 1-4 still work — the frontend just won't render the new UI.

---

### Phase 6: Frontend — Build Visualization & Narration (`apps/studio`)

**Goal**: Two-column build dashboard, topology node animations, build summary card.

**Tasks**:

6.1. **Rewrite `BuildProgressCard.tsx`**: two-column layout (agents left, tools right). Derive status from `buildProgress.agentStatuses` and `buildProgress.toolStatuses`. Remove all references to `approvedAgents`, `currentReviewAgent`. Add progress bar. Add slide-in animation for new items.

6.2. **Enhance `TopologyGraphView.tsx`**: add `buildStatus?: Record<string, string>` prop. Apply node styles based on build status (pending=dim, generating=accent-animated, compiled=green, warning=yellow, error=red+shake). Add edge animation when both endpoints compiled. Add entry point pulse ring.

6.3. **Create `BuildSummaryCard.tsx`**: renders in chat when `buildProgress.stage === 'complete'`. Shows each agent as a mini-card (name, mode, tool count, quality pills). Shows tool configs section. "Create Project" button at bottom. Clickable agent names → file tree navigation.

6.4. **Add CSS animations**: `rotate-border` (conic-gradient), `pulse-ring`, `shake` keyframes in globals.css or a build-animations.css.

**Files Touched**:

- `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`
- `apps/studio/src/components/arch-v3/chat/BuildSummaryCard.tsx` (NEW)
- `apps/studio/src/components/arch-v3/panels/TopologyGraphView.tsx`
- `apps/studio/src/styles/globals.css` (or new animation file)

**Exit Criteria**:

- [ ] BuildProgressCard renders two columns with correct statuses
- [ ] TopologyGraphView nodes reflect build status visually
- [ ] BuildSummaryCard renders after build completion
- [ ] CSS animations work: rotating border, pulse ring, shake
- [ ] No references to `approvedAgents` in BuildProgressCard

**Test Strategy**:

- Unit: UT-6 (BuildProgressCard), UT-7 (TopologyGraphView buildStatus).
- Manual: visual verification of animations.

**Rollback**: Revert. Old BuildProgressCard still works (reads from filePanelFiles).

---

### Phase 7: Frontend — Welcome Templates & Discover Layout (`apps/studio`)

**Goal**: Add template picker to welcome screen, create discover stage layout.

**Tasks**:

7.1. **Update welcome UI** in `/arch/page.tsx` (or extracted WelcomeView component): render `PROJECT_TEMPLATES` as selectable cards below the primary CTA. Each card shows icon, name, description, agent count, tags. On selection: pre-fill specification via `update_specification` and start session.

7.2. **Create discover stage layout**: when phase=INTERVIEW, render split-panel layout — SpecificationCard (60%) + chat (40%) using existing ArchShell. Wire `update_specification` tool call updates to live-update the spec card.

**Files Touched**:

- `apps/studio/src/app/arch/page.tsx`
- `apps/studio/src/types/arch.ts` (import PROJECT_TEMPLATES if not already available)

**Exit Criteria**:

- [ ] Welcome screen shows 5 template cards
- [ ] Clicking a template starts a session with pre-filled specification
- [ ] Discover stage shows spec card + chat split-panel
- [ ] Spec card updates live as update_specification tool calls arrive

**Test Strategy**:

- E2E: E2E-1 (full flow includes template selection path).
- Manual: visual verification of template cards and spec card.

**Rollback**: Revert. Welcome screen returns to logo + buttons only.

---

### Phase 8: Tests & Cleanup

**Goal**: Full E2E and integration test suite, deprecate legacy components.

**Tasks**:

8.1. **Create E2E test file** `apps/studio/src/__tests__/e2e/arch-ai-gate-free-onboarding.e2e.test.ts`: implement E2E-1 through E2E-7 from test spec. Uses MongoMemoryServer + dev-login + LLM stub.

8.2. **Update existing unit tests**: rewrite `session-state-machine.test.ts`, `phase-machine.test.ts`, `message-request.test.ts`, `resume-snapshot.test.ts`. Deprecate `build-gate-queue.test.ts`, `build-exit-criteria-subphase.test.ts`.

8.3. **Verify `pnpm build && pnpm test`** passes across all packages. Fix any regressions.

8.4. **Mark legacy components deprecated**: add `@deprecated` JSDoc to `ArchOnboarding.tsx`, old phase components in `components/onboarding/`, and `lifecycle-store.ts` old onboarding state. These are follow-up cleanup, not deleted in this feature.

**Files Touched**:

- `apps/studio/src/__tests__/e2e/arch-ai-gate-free-onboarding.e2e.test.ts` (NEW)
- `packages/arch-ai/src/__tests__/session-state-machine.test.ts`
- `packages/arch-ai/src/__tests__/phase-machine.test.ts`
- `packages/arch-ai/src/__tests__/message-request.test.ts`
- `packages/arch-ai/src/__tests__/resume-snapshot.test.ts`
- `packages/arch-ai/src/__tests__/build-gate-queue.test.ts` (deprecate)
- `packages/arch-ai/src/__tests__/build-exit-criteria-subphase.test.ts` (deprecate)

**Exit Criteria**:

- [ ] All 7 E2E scenarios pass
- [ ] All rewritten unit tests pass
- [ ] `pnpm build` succeeds across all packages
- [ ] `pnpm test` passes with 0 failures
- [ ] No gate_request SSE events in any E2E flow
- [ ] Old GATE_PENDING session cleanup verified in E2E-5

**Test Strategy**: This IS the test phase.

**Rollback**: Tests are additive — no rollback needed.

---

## 4. Wiring Checklist

- [ ] `BuildProgress` type exported from `packages/arch-ai/src/index.ts`
- [ ] `PROCEED_TO_NEXT_PHASE_TOOL` exported from `packages/arch-ai/src/tools/index.ts`
- [ ] `proceed_to_next_phase` added to `PHASE_TOOL_MAP` for INTERVIEW, BLUEPRINT, BUILD
- [ ] `proceed_to_next_phase` tool registered in route handler's Vercel tool objects (same pattern as `generate_topology`, `generate_agent`)
- [ ] `proceed_to_next_phase` tool execute function wired in route handler tool executors map
- [ ] `phase-transition.ts` imported and called from both `continue` handler and `proceed_to_next_phase` handler
- [ ] `buildProgress` mapped in `toArchSession()` DTO function
- [ ] `buildProgress` read in `buildResumeSnapshot()` for nextAction derivation
- [ ] `buildProgress` read in `/arch/page.tsx` for UI stage derivation
- [ ] `buildProgress` read in `BuildProgressCard` for two-column rendering
- [ ] `buildProgress.agentStatuses` read in `TopologyGraphView` for node build status
- [ ] `BuildSummaryCard` imported and rendered in chat message list when phase=BUILD + stage=complete
- [ ] `ApprovalGate` import removed from all barrel exports and parent components
- [ ] `gate-manager.ts` deleted and import removed from route handler
- [ ] Template cards wired to session creation + spec pre-fill in `/arch/page.tsx`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. `buildProgress` is added additively. Old fields are dead data. No MongoDB migration script needed.

### Feature Flags

None. Hard cutover per HLD.

### Configuration Changes

No new env vars. No new config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 8 implementation phases complete with exit criteria met
- [ ] All 7 E2E test scenarios pass
- [ ] All 10 integration test scenarios pass
- [ ] `pnpm build && pnpm test` clean across all packages
- [ ] Zero `gate_request` SSE events during any onboarding flow
- [ ] Zero sessions in `GATE_PENDING` state after one release cycle
- [ ] IN_PROJECT overlay confirmed working (proposal_response, pendingMutation)
- [ ] Feature spec updated with implementation status
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. **ActivityEmitter group labels for BUILD narration**: should each agent get its own ActivityGroup (collapsible per-agent), or one group for the entire generation? Recommendation: one group per agent (matches existing pattern where each tool call gets a group).

2. **Template pre-fill API**: should template selection create the session AND pre-fill the spec in one request, or create first then send a message with the template data? Recommendation: create session, then send a `message` with the template content — the LLM processes it naturally.
