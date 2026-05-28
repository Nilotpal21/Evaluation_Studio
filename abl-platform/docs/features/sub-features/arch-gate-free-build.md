# Feature: Arch Conversational Flow — Gate-Free Onboarding

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Arch AI Assistant](../arch-ai-assistant.md)
**Status**: PLANNED
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`
**Package(s)**: `packages/arch-ai`, `apps/studio`
**Owner(s)**: Arch AI team
**Testing Guide**: `../../testing/sub-features/arch-gate-free-build.md`
**Last Updated**: 2026-04-10

---

## 1. Introduction / Overview

### Problem Statement

The Arch AI onboarding flow uses blocking gates across all phases — `topology_approval` in BLUEPRINT, `agent_review` / `tool_generation` / `quality_floor` in BUILD. These gates transition the session to `GATE_PENDING`, creating a distributed state machine across `session-state-machine.ts`, `build-gate-queue.ts`, `gate-manager.ts`, and `route.ts`. Five documented failure modes in BUILD alone (approvedAgents DTO mapping loops, GATE_PENDING races, buildSubPhase stuck, empty gate emissions, quality_floor blocking). The same fragility affects BLUEPRINT (topology gate pending after browser close).

### Goal Statement

Remove gate-blocking UX from all onboarding phases. Replace per-agent review with auto-generation + rich chat narration. Replace the topology approval gate with a conversational confirmation that preserves the same durable backend checkpoint. Remove `GATE_PENDING` from the session state machine. Collapse the 7-screen onboarding UI into 4 stages while keeping backend phases unchanged for durability and resume.

### Summary

Gates are removed as a **UI and session-state concept**. The backend phases (`INTERVIEW | BLUEPRINT | BUILD | CREATE`) remain unchanged — they are the durable anchors for resume, journal, and progress tracking. The `GATE_PENDING` session state is removed; sessions alternate between `IDLE` and `ACTIVE` only. Phase transitions use existing deterministic `continue`/`create` message types for button clicks, plus a new `proceed_to_next_phase` tool for typed natural-language intent. The `ask_user` widget server contract is unchanged — `pendingInteraction` persists widgets, `tool_answer` resumes, freeform message clears the widget. BUILD auto-generates agents then runs tool config generation as an internal second stage, replacing `buildSubPhase` / `approvedAgents` / `selectedTools` with a new durable `buildProgress` model.

---

## 2. Architectural Decisions (Codex Review Resolution)

These decisions resolve the findings from the [Codex review](../../arch/reviews/2026-04-10-codex-gate-less-build-review.md):

### AD-1: Backend phases are unchanged. UI stages change.

```
Backend phases (persisted): INTERVIEW | BLUEPRINT | BUILD | CREATE  — NO CHANGE
Session states (persisted): IDLE | ACTIVE | COMPLETE | ARCHIVED    — GATE_PENDING removed

UI stages (client-only):    welcome | discover | build.topology_reveal
                            | build.generating | build.complete | create

Mapping:
  welcome               → no session yet (or fresh INTERVIEW)
  discover              → INTERVIEW phase
  build.topology_reveal → BLUEPRINT phase (topology generated, not yet committed)
  build.generating      → BUILD phase (generation in progress)
  build.complete        → BUILD phase (all files exist)
  create                → CREATE phase
```

Backend phase names, constants, and the `ARCH_PHASES` array are NOT renamed. The `ArchPhase` type stays `'INTERVIEW' | 'BLUEPRINT' | 'BUILD' | 'CREATE'`. The UI derives display stages from the persisted phase + session metadata.

### AD-2: Buttons use deterministic transitions. LLM tool for typed intent only.

- Proceed buttons (`sendContinue`, `sendCreate`) send deterministic `{ type: 'continue' }` / `{ type: 'create' }` messages. These are faster, cheaper, and less failure-prone than LLM tool calls.
- A new `proceed_to_next_phase` tool is added ONLY for freeform typed intent ("build it", "looks good"). The LLM calls this tool when it detects proceed intent from natural language.
- The existing post-transition auto-send (`phaseAutoSendRef` in `useArchChat.ts:1082-1084`) continues to work — it fires "Continue with the next phase." after a `phase_transition` event to kick off the LLM in the new phase.

### AD-3: Widget server contract is unchanged.

- `ask_user` → executor returns `awaiting_tool_result` → route persists `pendingInteraction({ kind: 'widget' })` → session stays `ACTIVE`
- User answers via `tool_answer` OR types freeform (clears pending widget via existing bypass at route.ts:556-558)
- `PendingWidgetInteraction` type and `pendingInteraction` field remain. Only `PendingGateInteraction` is removed.

### AD-4: Gate-era fields replaced by durable `buildProgress`, not deleted without replacement.

```typescript
// NEW: replaces buildSubPhase, approvedAgents, selectedTools
interface BuildProgress {
  stage: 'generating' | 'tools' | 'complete';
  agentStatuses: Record<string, 'pending' | 'generated' | 'compiled' | 'warning' | 'error'>;
  toolStatuses: Record<string, 'pending' | 'generated' | 'warning' | 'error'>;
}
```

Resume derives UI state from `buildProgress` + `files` + `topology`. The old fields (`buildSubPhase`, `approvedAgents`, `selectedTools`) become dead data in existing sessions.

### AD-5: Topology approval is de-gated but keeps a durable backend checkpoint.

The `topology_approval` gate UI is removed. But the coordinator still performs the same atomic work when transitioning BLUEPRINT → BUILD:

1. Verify topology exists (exit criteria)
2. Set `topologyApproved = true` (durable flag)
3. Diff new topology against existing build state (`diffTopologyAgainstBuildState`)
4. Preserve reusable agent files, prune stale files/approvals
5. Transition phase: BLUEPRINT → BUILD
6. Emit `phase_transition` SSE event

This work happens inside the `continue` message handler (for button clicks) or the `proceed_to_next_phase` tool handler (for typed intent). It is NOT a soft conversational inference — it is an atomic coordinator operation.

### AD-6: Tool generation stays as a second internal BUILD stage.

Agent generation and tool config generation are NOT forced into one LLM turn. The flow:

1. Turn 1: LLM generates all agents via `generate_agent` + `compile_abl` (existing)
2. Coordinator detects all agents compiled → auto-triggers tool config generation
3. Tool config generation runs as a deterministic or LLM-assisted second stage
4. `buildProgress.stage` moves from `generating` → `tools` → `complete`

This avoids the token-budget risk of cramming everything into one turn.

### AD-7: GATE_PENDING cleanup runs on load, not just on create.

Add cleanup to:

- `GET /api/arch-ai/sessions/current`: if returned session is `GATE_PENDING`, auto-archive and return null (client does not auto-create; fresh session is created when user sends first message or clicks "Start")
- `POST /api/arch-ai/message`: if session is `GATE_PENDING`, archive and return error with `retryable: true`

Keep `GATE_PENDING` in `RESUMABLE_STATES` for one release cycle so `getCurrent()` still finds these sessions for cleanup.

### AD-8: Implementation target is `/arch/page.tsx` + `useArchChat`, not `ArchOnboarding`.

The live onboarding surface is `apps/studio/src/app/arch/page.tsx` which uses `useArchChat` and the v3 panel/chat components. `ArchOnboarding` and `lifecycle-store` are the OLD overlay system — they are either migrated into the `/arch` page flow or cleaned up as follow-up.

---

## 3. Scope

### Goals

- G-1: Remove `GATE_PENDING` session state and all gate-request/gate-response SSE patterns from onboarding
- G-2: Replace per-agent review gates with auto-generation + rich chat narration
- G-3: Replace topology approval gate with conversational confirm + durable backend checkpoint (AD-5)
- G-4: Add `proceed_to_next_phase` tool for typed natural-language phase advance (AD-2)
- G-5: Replace `buildSubPhase` / `approvedAgents` / `selectedTools` with durable `buildProgress` model (AD-4)
- G-6: Collapse UI into 4 stages: welcome, discover, build (3 sub-stages), create (AD-1)
- G-7: Add template picker to welcome
- G-8: Parallel agent generation with topology-aware progress visualization
- G-9: Two-column build dashboard (agents + tools)
- G-10: GATE_PENDING cleanup on session load, not just session create (AD-7)

### Non-Goals

- NG-1: Changes to IN_PROJECT mode (unchanged — uses `proposal_response`, not `gate_response`)
- NG-2: Renaming backend phases (INTERVIEW/BLUEPRINT/BUILD/CREATE stay as-is)
- NG-3: Changes to `ask_user` widget server contract (pendingInteraction, tool_answer, freeform bypass all unchanged)
- NG-4: Single-turn agent + tool generation (tool gen stays as second internal stage)
- NG-5: Multi-user collaborative sessions, voice, undo/redo

---

## 4. User Stories

1. As a **new user**, I want to answer Arch's questions by typing freely OR clicking widget options, so the conversation feels natural.
2. As a **user reviewing topology**, I want to say "looks good, build it" or click "Build This" — no Accept/Modify/Reject gate.
3. As a **user**, I want topology changes via chat ("add a fraud agent") without clicking gate buttons.
4. As a **new user**, I want all agents and tools to auto-generate after I confirm the topology.
5. As a **new user**, I want rich explanations of each generated agent in chat (role, tools, handoffs, quality).
6. As a **user**, I want to modify generated agents via chat ("make billing scripted").
7. As a **user**, I want a two-column agents + tools progress dashboard during generation.
8. As a **user**, I want topology nodes to animate as agents compile.
9. As a **new user**, I want to pick a domain template on the welcome screen.
10. As a **returning user**, I want to resume any interrupted phase without being stuck on a gate.
11. As a **user**, I want interview + upload in a single "Discover" screen.
12. As a **user**, I want "Create Project" as an explicit button — never auto-created.

---

## 5. Functional Requirements

### FR-1: Gate and GATE_PENDING Elimination

- FR-1.1: The system must NOT emit `gate_request` SSE events during any onboarding phase.
- FR-1.2: `GATE_PENDING` must be removed from the session state machine. Valid states: `IDLE`, `ACTIVE`, `COMPLETE`, `ARCHIVED`.
- FR-1.3: `PendingGateInteraction` and all gate payload types must be removed from session types. `PendingInteraction` simplifies to `PendingWidgetInteraction` only.
- FR-1.4: `gate_response` must be removed from `MessageRequestSchema`. Once removed, any old client still sending `gate_response` will fail at Zod schema validation (HTTP 400) before the route handler runs — this is the intended behavior. There is no soft fallback to the old `GATE_NOT_PENDING` error path. IN_PROJECT uses `proposal_response` (separate schema variant), confirmed unaffected.
- FR-1.5: `GateManager` class and `gate-manager.ts` must be deleted.
- FR-1.6: Gate-related rendering in `useArchChat` (`gate_request` handler, `gate_pending` state, `sendGateResponse`) must be removed. `ApprovalGate.tsx` must be deleted.

### FR-2: Widget Contract Preserved (AD-3)

- FR-2.1: `ask_user` widget behavior is UNCHANGED: executor returns `awaiting_tool_result`, route persists `pendingInteraction({ kind: 'widget' })`, session stays `ACTIVE`.
- FR-2.2: User can answer via `tool_answer` OR type freeform text (existing bypass at route.ts:556-558 clears pending widget).
- FR-2.3: `useArchChat` continues to track `widget_pending` in client-side `ChatState`.

### FR-3: Durable Build Progress Model (AD-4)

- FR-3.1: A new `buildProgress` field must be added to `SessionMetadata`:
  ```typescript
  buildProgress?: {
    stage: 'generating' | 'tools' | 'complete';
    agentStatuses: Record<string, 'pending' | 'generated' | 'compiled' | 'warning' | 'error'>;
    toolStatuses: Record<string, 'pending' | 'generated' | 'warning' | 'error'>;
  }
  ```
- FR-3.2: `buildProgress` must be updated atomically by the route handler as `file_changed` and `compile_result` events are processed.
- FR-3.3: Resume must derive UI stage from `buildProgress.stage` + `files` + `topology`.
- FR-3.4: The old fields (`buildSubPhase`, `approvedAgents`, `selectedTools`) become dead data — not read, not written.

### FR-4: Phase Transitions (AD-2)

- FR-4.1: Button clicks use deterministic `{ type: 'continue' }` and `{ type: 'create' }` messages (existing, preserved).
- FR-4.2: A new `proceed_to_next_phase` tool is available in INTERVIEW, BLUEPRINT, BUILD for typed natural-language intent.
- FR-4.3: The LLM calls `proceed_to_next_phase` when it detects user proceed intent from conversation context (not pattern matching).
- FR-4.4: The `continue` handler and `proceed_to_next_phase` handler share the same atomic transition logic: check exit criteria → update metadata → transition phase → emit `phase_transition`.
- FR-4.5: BLUEPRINT → BUILD transition logic must: set `topologyApproved = true`, run `diffTopologyAgainstBuildState`, preserve/prune files. All DB operations scoped by `{ _id, tenantId, userId }`.
- FR-4.6: If exit criteria are not met, the handler returns an error (for `continue`) or a tool error result (for `proceed_to_next_phase`) explaining what's missing.
- FR-4.7: Post-transition auto-send (`phaseAutoSendRef`) continues to fire "Continue with the next phase." to kick off the LLM in the new phase.
- FR-4.8: The base prompt must be updated so "build it" / "looks good" is allowed when exit criteria are met.

### FR-5: Auto-Generation Flow (BUILD)

- FR-5.1: On entering BUILD, the LLM generates all agents in a single multi-tool-call turn.
- FR-5.2: After all agents compile, the coordinator auto-triggers tool config generation as a second internal stage. `buildProgress.stage` transitions `generating → tools → complete`.
- FR-5.3: Quality floor issues are auto-fixed by the LLM during generation (max 2 retry cycles per agent).
- FR-5.4: `file_changed`, `compile_result`, and `activity` SSE events are emitted as agents and tools generate.
- FR-5.5: **toolDsls write path** (implementation blocker resolved): The current code initializes `metadata.toolDsls` as `{}` (route.ts:4333) and reads it for completion checks (route.ts:5158-5177), but has no live write path. The new flow must implement one of: (a) a `generate_tool_config` server-side tool that writes `metadata.toolDsls.{toolName}` via `$set` on each LLM tool call during the `tools` stage, or (b) the route handler's post-agent-generation step extracts tools, generates HTTP configs deterministically (template-based, no LLM), and writes them directly to `metadata.toolDsls`. Option (b) is preferred for v1 — it is faster, cheaper, and deterministic. The integration-methodologist LLM path can be added later if richer tool configs are needed.

### FR-6: Chat Narration

- FR-6.1: After each agent generates, chat displays: agent name, mode, role, tools, handoffs, quality pills.
- FR-6.2: After all agents + tools generate, chat displays a build summary with contextual suggestions.
- FR-6.3: Agent names are clickable → navigate to file tree + code viewer.
- FR-6.4: Narration sections use ActivitySteps pattern, auto-collapse 3s after completion.

### FR-7: Conversational Modification (BUILD)

- FR-7.1: User types modification requests in chat; LLM modifies the specific agent, recompiles, emits updated SSE events.
- FR-7.2: Chat narrates the modification. Topology graph and file tree update.

### FR-8: UI Stage Collapse

- FR-8.1: UI presents 4 stages: welcome, discover, build, create. Derived from backend phase + metadata.
- FR-8.2: `discover` maps to INTERVIEW phase — SpecificationCard (60%) + chat (40%).
- FR-8.3: `build` maps to BLUEPRINT + BUILD phases with 3 sub-stages: topology_reveal, generating, complete.
- FR-8.4: Implementation target: `/app/arch/page.tsx` + `useArchChat`. `ArchOnboarding` / `lifecycle-store` are legacy cleanup.

### FR-9: Template Picker (Welcome)

- FR-9.1: Welcome screen shows 5 domain templates from `PROJECT_TEMPLATES`.
- FR-9.2: Template selection pre-fills the specification and starts the session.

### FR-10: Topology-Aware Build Progress

- FR-10.1: Topology nodes show build status: pending / generating / compiled / warning / error.
- FR-10.2: Edges animate when both endpoints compile. Entry point has pulse ring.
- FR-10.3: `TopologyGraphView` receives `buildStatus: Record<string, status>` prop, derived from `buildProgress.agentStatuses`.

### FR-11: Two-Column Build Dashboard

- FR-11.1: `BuildProgressCard` shows agents (left) + tools (right), derived from `buildProgress`.
- FR-11.2: Progress bar: completed / total. Items animate in on `file_changed`.

### FR-12: Build-to-Create Transition

- FR-12.1: "Create Project" button appears when `buildProgress.stage === 'complete'`.
- FR-12.2: Button sends `{ type: 'create' }` (deterministic). Pre-flight quality check runs inline.
- FR-12.3: `create_project` is an explicit user action — never auto-created.

### FR-13: Session Resume

- FR-13.1: Resume restores chat history, artifacts, and correct UI stage from `phase` + `buildProgress` + `pendingInteraction` + `files` + `topology`.
- FR-13.2: Proceed CTA derives from `resume.nextAction`, not ephemeral `done` suggestions.
- FR-13.3: Widget pending on resume: re-render widget from `pendingInteraction` (existing behavior, unchanged).
- FR-13.4: Mid-BUILD partial files: detect from `buildProgress`, offer "Continue generating".
- FR-13.5: Mid-BLUEPRINT with topology: show topology_reveal sub-stage with proceed button.

### FR-14: Backward Compatibility (AD-7)

- FR-14.1: `GET /api/arch-ai/sessions/current`: if session is `GATE_PENDING`, auto-archive and return null (triggers fresh session creation).
- FR-14.2: `POST /api/arch-ai/message`: if session is `GATE_PENDING`, auto-archive the session and return HTTP 409 with `{ error: 'SESSION_STALE', retryable: true }`. The current `useArchChat` surfaces non-OK responses as an error string and returns to `idle` state — it does NOT auto-refresh. The user sees the error and manually refreshes or sends another message. A follow-up enhancement could add auto-refresh in the client's error handler, but this is not required for v1.
- FR-14.3: Keep `GATE_PENDING` in `RESUMABLE_STATES` for one release cycle so `getCurrent()` finds these sessions for cleanup.
- FR-14.4: After one release, remove `GATE_PENDING` from `RESUMABLE_STATES` and the state machine entirely.

### FR-15: Governance (Auto-Generation Safety)

- FR-15.1: `create_project` remains an explicit user click — never auto-executed.
- FR-15.2: Generated tool configs with side-effecting HTTP methods must include `confirmation: true`.
- FR-15.3: Generated auth configs must never embed secrets.
- FR-15.4: Quality auto-fix results must be surfaced in the build summary even when automatically resolved.
- FR-15.5: Invalid tools (compile error) must not silently mark BUILD complete — `buildProgress.stage` stays `tools` until resolved.

---

## 6. Design Considerations

### Visual Stages within BUILD Phase

**Stage A — Topology Reveal** (BLUEPRINT phase):

- Centered layout with topology graph, staggered node entrance animation
- Stat pills: agents, tools, handoffs
- Actions: "Build This" (sends `continue`) and "Adjust" (opens chat)

**Stage B — Parallel Generation** (BUILD phase, `buildProgress.stage = generating | tools`):

- 3-panel: file tree (20%) | live topology (40%) | chat (40%)
- Topology nodes animate through build statuses
- Two-column BuildProgressCard
- Chat narrates per-agent

**Stage C — Converge** (BUILD phase, `buildProgress.stage = complete`):

- Same 3-panel, settled. Topology/Code tab selector.
- "Create Project" button. Modification via chat.

### Topology Node Visual States

| State      | Border      | Fill                   | Animation                             |
| ---------- | ----------- | ---------------------- | ------------------------------------- |
| pending    | `border/30` | `surface-secondary/30` | opacity: 0.4                          |
| generating | `accent`    | `surface-secondary`    | Conic-gradient rotation + scale pulse |
| compiled   | `success`   | `surface-secondary`    | Fill wipe (300ms)                     |
| warning    | `warning`   | `warning/5`            | None                                  |
| error      | `error`     | `error/5`              | Shake (150ms)                         |

---

## 7. Technical Considerations

### State Machine

```
BEFORE: IDLE | ACTIVE | GATE_PENDING | COMPLETE | ARCHIVED
AFTER:  IDLE | ACTIVE | COMPLETE | ARCHIVED

Transitions:
  IDLE -> ACTIVE (user sends message or continue)
  ACTIVE -> IDLE (LLM turn completes, or widget pending)
  ACTIVE -> COMPLETE (create_project succeeds)
  COMPLETE -> ARCHIVED (auto-archive)
  IDLE -> ARCHIVED (manual archive)
  ACTIVE -> ARCHIVED (manual archive)
```

`ACTIVE` acts as a mutex: the session stays `ACTIVE` during LLM processing AND during widget-pending (prevents concurrent turns). Note: this is NOT a strict turn lock — the route allows new user messages while `ACTIVE` (clearing pending widget). If strict mutual exclusion is needed later, add an explicit request lock.

### Backend Phases Unchanged

`INTERVIEW | BLUEPRINT | BUILD | CREATE` remain as persisted phases. They are NOT renamed to match UI stages. The phase machine, phase prompts, specialist routing, journal entries, and exit criteria all continue to use these names.

### Backward Compatibility

1. Old `GATE_PENDING` sessions: cleaned up on `GET /sessions/current` and `POST /message` (FR-14)
2. Old gate-era metadata fields: ignored by DTO mapper. Dead data, no migration.
3. Old `gate_response` in client: client stops sending it. If an old client sends it, the request fails at Zod schema validation (HTTP 400) since `gate_response` is removed from `MessageRequestSchema`. There is no soft fallback to the old `GATE_NOT_PENDING` handler.

---

## 8. How to Consume

### Studio UI

| Screen   | Route   | Backend Phase     | Description                             |
| -------- | ------- | ----------------- | --------------------------------------- |
| Welcome  | `/arch` | (pre-session)     | Template picker + start conversation    |
| Discover | `/arch` | INTERVIEW         | Chat + SpecificationCard                |
| Build    | `/arch` | BLUEPRINT / BUILD | Topology reveal → generation → converge |
| Create   | `/arch` | CREATE            | Summary card + create button            |

Implementation surface: `apps/studio/src/app/arch/page.tsx` + `useArchChat` + v3 components. NOT `ArchOnboarding` / `lifecycle-store` (legacy overlay, follow-up cleanup).

### API (Studio)

| Method | Path                                | Purpose                          | Change                                 |
| ------ | ----------------------------------- | -------------------------------- | -------------------------------------- |
| POST   | `/api/arch-ai/sessions`             | Create or resume                 | Unchanged                              |
| POST   | `/api/arch-ai/message`              | Send message / continue / create | Remove gate handlers, add proceed tool |
| GET    | `/api/arch-ai/sessions/current`     | Get session + resume             | Add GATE_PENDING cleanup               |
| POST   | `/api/arch-ai/sessions/:id/archive` | Archive                          | Unchanged                              |

No new endpoints.

---

## 9. Data Model

```
Collection: arch_sessions
Changes:
  ADDED to metadata:
    - buildProgress: { stage, agentStatuses, toolStatuses }  (replaces buildSubPhase/approvedAgents/selectedTools)

  DEPRECATED (dead data, not read or written):
    - buildSubPhase
    - approvedAgents
    - selectedTools

  STATE CHANGE:
    - state: GATE_PENDING no longer written. Old GATE_PENDING sessions cleaned up on load.
    - pendingInteraction: PendingWidgetInteraction only (PendingGateInteraction removed from union)

  KEPT (unchanged):
    - files, toolDsls, topology, topologyApproved, specification, messages, mockServer
```

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/arch-ai/src/types/session.ts`                     | Add `BuildProgress`, remove gate types, simplify `PendingInteraction` |
| `packages/arch-ai/src/types/constants.ts`                   | Remove `GATE_PENDING` from `SESSION_STATES`                           |
| `packages/arch-ai/src/coordinator/phase-machine.ts`         | Simplify BUILD exit criteria                                          |
| `packages/arch-ai/src/coordinator/session-state-machine.ts` | Remove GATE_PENDING transitions                                       |
| `packages/arch-ai/src/coordinator/build-gate-queue.ts`      | Deprecate / remove                                                    |
| `packages/arch-ai/src/prompts/phases/build.ts`              | Remove gate references, add narration instructions                    |
| `packages/arch-ai/src/prompts/phases/blueprint.ts`          | Remove "coordinator will present for approval"                        |
| `packages/arch-ai/src/session/session-service.ts`           | DTO mapper: add buildProgress, remove gate-era fields                 |
| `packages/arch-ai/src/session/resume-snapshot.ts`           | Derive UI stage from buildProgress, remove gate artifacts             |
| `packages/arch-ai/src/tools/definitions.ts`                 | Add `proceed_to_next_phase` tool definition                           |

### Routes / Handlers

| File                                                        | Purpose                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/message/route.ts`          | Remove all gate handlers, add proceed tool handler, add auto tool gen |
| `apps/studio/src/app/api/arch-ai/sessions/current/route.ts` | Add GATE_PENDING cleanup on load                                      |
| `apps/studio/src/lib/arch-ai/gate-manager.ts`               | DELETE entirely                                                       |

### UI Components

| File                                                                    | Purpose                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/studio/src/app/arch/page.tsx`                                     | PRIMARY target — derive UI stages from phase + buildProgress |
| `apps/studio/src/hooks/useArchChat.ts`                                  | Remove gate handling, keep widget handling                   |
| `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`         | Two-column, derive from buildProgress                        |
| `apps/studio/src/components/arch-v3/chat/BuildSummaryCard.tsx`          | NEW — rich build summary                                     |
| `apps/studio/src/components/arch-v3/chat/ApprovalGate.tsx`              | DELETE entirely                                              |
| `apps/studio/src/components/arch-v3/panels/TopologyGraphView.tsx`       | Add buildStatus prop                                         |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | Derive proceed CTA from resume.nextAction                    |
| `apps/studio/src/store/arch-ai-store.ts`                                | Remove approvedAgents, add buildProgress mirror              |

---

## 11. Configuration

No new environment variables. No feature flags — `GATE_PENDING` cleanup is the backward-compat strategy.

---

## 12. Non-Functional Concerns

### Isolation

Unchanged. All DB operations scoped by `(tenantId, userId)`. The `proceed_to_next_phase` handler and BLUEPRINT→BUILD transition MUST use `{ _id, tenantId, userId }` triple-filter on every `updateOne` (same as the topology_approval handler it replaces).

### Security

- `create_project` remains explicit user action (FR-15.1)
- Generated tool configs validated for side-effect safety (FR-15.2-15.3)
- Quality issues surfaced even when auto-fixed (FR-15.4)

### Performance

- Agent generation: ~15-30s for 4-8 agents (unchanged)
- Tool config generation: ~5-10s as second stage (unchanged)
- Fewer LLM turns overall (no gate-response → LLM re-invocation cycles)

### Reliability

- No new stuck states. `ACTIVE` timeout handled by existing `forceArchiveStuck`.
- Partial generation: detected by `buildProgress.agentStatuses`, user prompted to continue.
- Old sessions: cleaned up on load (FR-14).

---

## 13. Delivery Plan

1. **Backend: Types & State Machine** (`packages/arch-ai`)
   1.1. Add `BuildProgress` type to `session.ts`
   1.2. Remove `GATE_PENDING` from state machine
   1.3. Remove gate payload types, simplify `PendingInteraction`
   1.4. Add `proceed_to_next_phase` to tool definitions and `PHASE_TOOL_MAP`
   1.5. Simplify BUILD exit criteria
   1.6. Deprecate `build-gate-queue.ts`

2. **Backend: Phase Transition Handlers** (`apps/studio`)
   2.1. Implement `proceed_to_next_phase` tool handler in route.ts
   2.2. Refactor BLUEPRINT→BUILD transition from gate handler into shared function
   2.3. Both `continue` and `proceed_to_next_phase` call the shared transition function
   2.4. Update base prompt to allow "build it" when exit criteria met

3. **Backend: BUILD Route Rewrite** (`apps/studio`)
   3.1. Remove agent_review, tool_generation, quality_floor gate handlers
   3.2. Add auto tool config generation as second BUILD stage
   3.3. Add `buildProgress` writes after file_changed / compile_result
   3.4. Add narration text_delta emissions
   3.5. Delete `GateManager` and `gate-manager.ts`

4. **Backend: Session Service, Resume & Compat** (`packages/arch-ai`)
   4.1. Update `toArchSession()` — add buildProgress, stop reading gate-era fields
   4.2. Update `ResumeSnapshot` — derive from buildProgress, no gate artifacts
   4.3. Remove gate builder helpers
   4.4. Add GATE_PENDING cleanup on `GET /sessions/current`
   4.5. Remove `gate_response` from `MessageRequestSchema`

5. **Frontend: UI Stage Derivation** (`apps/studio`)
   5.1. In `/arch/page.tsx`: derive UI stage from `phase` + `buildProgress` + `topology`
   5.2. Remove gate rendering from `useArchChat` (gate_request handler, gate_pending state, sendGateResponse)
   5.3. Delete `ApprovalGate.tsx`
   5.4. Update `arch-ai-store.ts`: remove approvedAgents, add buildProgress mirror

6. **Frontend: Build Visualization**
   6.1. Two-column `BuildProgressCard` from `buildProgress`
   6.2. `TopologyGraphView` with `buildStatus` prop
   6.3. `BuildSummaryCard` for build-complete chat
   6.4. Proceed CTA from `resume.nextAction`

7. **Frontend: Welcome + Discover**
   7.1. Template picker on welcome
   7.2. Discover stage layout (spec card + chat)

8. **Tests & Cleanup**
   8.1. Gate-related tests: deprecate/rewrite
   8.2. Add: proceed_to_next_phase (all phases), buildProgress persistence, GATE_PENDING cleanup on load, widget freeform bypass, topology diff without gate, resume mid-build, tool DSL write path, mixed-intent messages
   8.3. Legacy cleanup: `ArchOnboarding`, `lifecycle-store` old phases

---

## 14. Success Metrics

| Metric                               | Baseline | Target | How Measured             |
| ------------------------------------ | -------- | ------ | ------------------------ |
| Stuck sessions (GATE_PENDING > 5min) | ~10-15%  | 0%     | DB query                 |
| BUILD completion rate                | Unknown  | >80%   | Sessions reaching CREATE |
| BUILD duration (topology to create)  | ~90-120s | <60s   | Journal timestamps       |
| Gate-related bugs                    | Ongoing  | 0      | Issue tracker            |

---

## 15. Open Questions

1. **toolDsls write path**: Resolved in FR-5.5. V1 uses deterministic template-based generation (option b). LLM-assisted generation (option a) deferred to follow-up.
2. **Token budget**: Can the LLM generate 4-8 agents in one turn within the current `MAX_OUTPUT_TOKENS`? Need load testing.
3. **Template pre-fill depth**: Brief only, or also topology?
4. **Proceed CTA persistence**: Should `resume.nextAction` be written to session metadata, or computed from phase + buildProgress on load?

---

## 16. Gaps & Limitations

| ID      | Description                                                                             | Severity | Status                                           |
| ------- | --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| GAP-001 | Dead fields in old sessions (buildSubPhase, approvedAgents)                             | Low      | Accepted                                         |
| GAP-002 | No auto-retry if LLM fails to generate all agents in one turn                           | Medium   | Open                                             |
| GAP-003 | toolDsls write path — resolved in FR-5.5, v1 uses deterministic template generation     | Low      | Resolved                                         |
| GAP-004 | Template picker i18n entries may not exist                                              | Low      | Open                                             |
| GAP-005 | Old GATE_PENDING sessions from inactive users persist until user returns                | Medium   | Accepted — per-user cleanup on load              |
| GAP-006 | `proceed_to_next_phase` relies on LLM judgment                                          | Medium   | Mitigated — buttons use deterministic `continue` |
| GAP-007 | Mixed intent ("looks good but add X first") — LLM must handle change first, not advance | Medium   | Spec'd in base prompt update (FR-4.8)            |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                | Type        | Priority |
| --- | ----------------------------------------------------------------------- | ----------- | -------- |
| 1   | No `gate_request` SSE in any onboarding phase                           | integration | P0       |
| 2   | No `GATE_PENDING` state transitions                                     | unit        | P0       |
| 3   | `continue` button BLUEPRINT→BUILD: sets topologyApproved, runs diff     | integration | P0       |
| 4   | `proceed_to_next_phase` tool: all 3 transitions                         | integration | P0       |
| 5   | Old GATE_PENDING session on `GET /sessions/current` → auto-archived     | integration | P0       |
| 6   | buildProgress persistence: stage, agentStatuses, toolStatuses           | unit        | P0       |
| 7   | Resume mid-BUILD: derives UI stage from buildProgress                   | unit        | P1       |
| 8   | Resume mid-BLUEPRINT: topology exists → topology_reveal                 | unit        | P1       |
| 9   | Widget freeform bypass: type text → clears pending → LLM processes      | integration | P1       |
| 10  | BUILD auto tool config generation after agents compile                  | integration | P1       |
| 11  | toolDsls write path verification                                        | integration | P1       |
| 12  | Mixed intent: "looks good but add X" → handles change, does not advance | integration | P1       |
| 13  | BUILD→BLUEPRINT backtrack + topology diff + file preserve               | integration | P1       |
| 14  | Proceed CTA restoration after refresh                                   | e2e         | P1       |
| 15  | Chat suggestion + proceed button persistence via resume.nextAction      | e2e         | P1       |
| 16  | `useArchChat` shared behavior in IN_PROJECT overlay after gate removal  | integration | P1       |
| 17  | Conversational modification updates specific agent only                 | e2e         | P2       |
| 18  | Two-column BuildProgressCard rendering from buildProgress               | unit        | P2       |
| 19  | TopologyGraphView with buildStatus prop                                 | unit        | P2       |
| 20  | Template selection pre-fills spec                                       | e2e         | P2       |

---

## 18. References

- Codex review: `docs/arch/reviews/2026-04-10-codex-gate-less-build-review.md`
- Deep review: `docs/sdlc-logs/arch-gate-free-build/deep-review.md`
- Isolation review: `docs/sdlc-logs/arch-gate-free-build/isolation-api-review.md`
- Parent spec: `docs/features/arch-ai-assistant.md`
- Session state machine: `packages/arch-ai/src/coordinator/session-state-machine.ts`
- Build gate queue (deprecated): `packages/arch-ai/src/coordinator/build-gate-queue.ts`
- Message route: `apps/studio/src/app/api/arch-ai/message/route.ts`
- Arch page: `apps/studio/src/app/arch/page.tsx`
- useArchChat: `apps/studio/src/hooks/useArchChat.ts`
