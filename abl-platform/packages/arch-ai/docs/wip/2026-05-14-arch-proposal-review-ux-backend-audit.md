# Arch Proposal Review UX and Backend Audit

Date: 2026-05-14
Scope: Arch IN_PROJECT proposal, plan, health-check, approval, artifact, and streaming experience.

## Executive Summary

Arch has the right architectural pieces for a high-trust review loop: structured plans, diff artifacts, pending plan and pending mutation persistence, deterministic approval handlers, activity events, health artifacts, journal entries, and reconnectable session snapshots.

The current user experience is not yet coherent enough for agent and tool management work. The same user decision can appear in chat and artifacts, artifact focus can be stolen by unrelated updates, "Approve" can be clicked during in-flight streaming, and final proposal readiness is not always visually tied to runtime evidence. The result is a product that looks powerful but can make users hunt between chat and artifacts to understand what they are approving.

The product direction should be:

1. One canonical review surface per pending decision.
2. Chat explains and mirrors, artifacts approve and inspect.
3. Runtime-readiness evidence is visible beside the proposal.
4. Stream progress shows a sanitized work trail, not hidden reasoning.
5. Approval actions are idempotent and disable immediately across all surfaces.

## Personas

### End User Persona

The user wants to fix or improve a project quickly. They do not know whether "Plan", "Changes", "Health", and chat are separate sources of truth. If Arch asks for approval twice, they assume the system is unsure or broken. If a Plan tab jumps back to Topology, they lose trust. If fast clicks produce "already streaming", they interpret it as the app not accepting their decision.

User expectation:

- Tell me what you checked.
- Show me the proposed change.
- Tell me whether it will work at runtime.
- Let me approve once.
- Show me exactly what happened after I approved.

### UX/UI Persona

The interface currently has too many competing centers of gravity. Chat owns the narrative, artifacts own review detail, and widgets own decisions. That can work only if each surface has a strict role:

- Chat: natural-language summary, activity trail, lightweight mirror.
- Artifact panel: canonical plan, diff, health, runtime evidence, approval controls.
- Status system: current operation and whether the user can act.
- Journal: durable history after actions are taken.

The biggest UX issue is not visual polish. It is information architecture.

### Product Manager Persona

The proposal experience must be designed around trust gates:

- Is this just a plan?
- Is there a concrete diff?
- Did it compile in project context?
- Did it check neighboring agents?
- Did it check tools, auth, variables, model config?
- Is runtime smoke evidence available?
- What exactly will happen if I approve?

No proposal should be presented as ready unless these questions are either passed or explicitly marked missing.

## Current Data Flow

### 1. User Input

Layer: UI

- `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`
- `apps/studio/src/lib/arch-ai/ui/hook.ts`
- `apps/studio/src/lib/arch-ai/ui/session-api.ts`

Flow:

1. User sends a message or clicks a widget/action.
2. `useArchChatController.streamPost()` posts to `/api/arch-ai/message`.
3. Local UI sets `state: "streaming"` and optimistically appends user messages.
4. `inFlightPostRef` ignores additional local sends while a request is active.

Observed gap:

- `inFlightPostRef` only protects the current React hook instance. It does not fully protect multiple UI surfaces, restored widgets, or rapid duplicate server requests.
- Ignored local sends are only logged, not surfaced as a calm "Already applying" UI state.

### 2. API Message Route

Layer: backend route

- `apps/studio/src/app/api/arch-ai/message/route.ts`

Flow:

1. Auth and project access are checked.
2. Session is loaded.
3. Busy state and pending interaction logic decide whether the request can proceed.
4. Redis turn lock is acquired.
5. IN_PROJECT routes to `processInProjectMessage()`.

Observed gap:

- Fast duplicate clicks can still hit the backend and return `SESSION_BUSY` with "A response is already streaming for this session. Please wait."
- That is technically correct but product-hostile during approval. The user already clicked the right button; the UI should show "Applying approved change..." rather than an error.

### 3. IN_PROJECT Processor

Layer: backend orchestration

- `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`

Flow:

1. `proposal_response` with `pendingMutation` resolves deterministically via `apply_modification` or `dismiss_proposal`.
2. `proposal_response` with `pendingPlan.status === "proposed"` resolves deterministically via `setPendingPlan`.
3. Plain text messages like "approve plan" can also resolve pending plans.
4. Tool answers can resolve pending mutation confirmations.
5. Otherwise the turn enters the LLM TurnEngine.

Strength:

- Approval of pending mutations is deterministic and does not need another LLM turn.
- The processor emits artifact updates for journal, diff status, topology refresh, text summary, and turn end.

Observed gaps:

- Plans and mutations are different state machines but share the same `proposal_response` API. The UI does not clearly distinguish "approve plan" from "apply changes".
- Plan approval only changes plan state. It does not automatically advance to a concrete diff. That is correct technically, but the UI needs to say "Plan approved. Next: generating the proposed change."
- Modify/refine clears or changes pending state, then routes back through LLM. If the user gives an odd direction, the UI has no explicit "re-scoping" state or stale-plan warning.

### 4. Event Dispatch and Artifact Sync

Layer: client event dispatcher and store

- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`
- `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`
- `apps/studio/src/lib/arch-ai/ui/proposal-artifacts.ts`

Flow:

1. `artifact_updated: plan` upserts a Plan tab and sets it active.
2. `artifact_updated: diff` upserts a Changes tab and sets it active.
3. `artifact_updated: topology` upserts Topology and Blueprint tabs, then sets active tab to topology or blueprint depending on phase.
4. `artifact_updated: health` upserts Health tab and sets it active.

Observed gap:

- Topology and health updates can steal focus from a user-selected Plan or Changes tab.
- This matches the reported "Plan tab switches back to Topology" symptom. The dispatcher makes topology updates active unconditionally.

### 5. Review UI

Layer: artifact panel and chat widgets

- `apps/studio/src/lib/arch-ai/components/arch/panels/PlanPanel.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectDiffCard.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/widgets/Confirmation.tsx`

Flow:

1. PlanPanel has Approve, Refine, Cancel.
2. Diff card is read-only and expects confirmation to flow through chat.
3. WidgetRenderer can replace a proposal confirmation with a status mirror, but only when a pending diff tab exists.

Observed gap:

- Plan approval can appear twice: PlanPanel controls plus chat Confirmation buttons.
- WidgetRenderer only detects pending diff proposals, not pending plan proposals.
- Diff review is read-only while Plan review is actionable. The difference is not obvious to users.

## UI State Possibilities Today

### State A: No Artifact Yet

User sees chat only. Good for exploration.

Risk:

- Arch may describe a proposal in text without a durable artifact if it fails to call `propose_plan` or `propose_modification`.

Needed:

- If Arch says "I propose", the UI should require a Plan or Changes artifact, or mark the response as "no review artifact created".

### State B: Plan Proposed

Current surfaces:

- Plan tab appears.
- Chat may also show a Confirmation widget.
- PlanPanel has approval buttons.

Risk:

- Duplicate approval controls.
- User does not know approval means "permission to prepare concrete diffs", not "apply code".

Needed:

- Plan tab is canonical.
- Chat shows a mirror: "Plan ready for review" with "Open plan", not another approval.
- Plan panel should show "Approves scope only. No project files change yet."

### State C: Plan Approved

Current behavior:

- Backend marks pending plan approved.
- Chat emits "Plan approved..."

Risk:

- User expects changes to happen immediately.
- Arch may then fail to generate a diff or may continue with no visible next step.

Needed:

- Show a next-step status rail: "Approved scope -> Preparing diff -> Validating runtime -> Ready to apply".

### State D: Diff Proposed

Current surfaces:

- Changes tab appears.
- Diff card shows status and validation.
- Chat Confirmation may appear.

Risk:

- Diff card lacks primary action, while chat has it. Users looking at the diff must go back to chat to approve.

Needed:

- Diff tab should be canonical for approval.
- Chat should show "Changes ready in review panel" with an Open review button.

### State E: Diff Blocked

Current behavior:

- Diff tab can show blocked compiler errors.

Risk:

- Blocked vs ready is visually present but not elevated enough as a gate.
- Runtime-readiness gaps such as missing ProjectTool, auth variables, or model config are not first-class in the diff header.

Needed:

- A readiness checklist above the diff:
  - Project compile
  - Cross-agent references
  - Tool bindings
  - Auth and variables
  - Model config
  - Diagnostics
  - Runtime smoke

### State F: Applying

Current behavior:

- UI marks diff as applying via `markDiffResolutionInFlight()`.
- Backend may reject duplicate clicks with `SESSION_BUSY`.

Risk:

- Fast clicking can surface an error even though the first click is working.

Needed:

- A client-side and server-side idempotency key per review action.
- Disable all matching approval surfaces immediately.
- Treat duplicate approval for the same pending plan or mutation as "already accepted/applying", not error.

### State G: Applied

Current behavior:

- Diff status becomes applied.
- Journal entry is emitted.
- Topology refresh may run.

Risk:

- Success message may not include post-apply health or runtime smoke.
- If topology refresh emits after apply, it may steal focus from the applied diff.

Needed:

- Applied state should show "Post-checks not run" or "Post-checks passed".
- Topology refresh should update background tabs without changing focus unless the user asks.

### State H: Rejected or Cancelled

Current behavior:

- Diff rejected auto-dismisses after a delay.
- Plan cancelled remains visible with status.

Risk:

- The audit trail can become hard to recover if a rejected diff disappears too fast.

Needed:

- Keep a small Review History section in Journal or artifact panel.

### State I: User Gives Odd Direction

Examples:

- User types "fix this but do not change routing" after a plan is pending.
- User asks a new unrelated request while a plan is awaiting approval.
- User asks "approve" while active tab is Health, not Plan.

Current behavior:

- Some plain text approval is interpreted deterministically.
- Other messages go to LLM with pending action context.

Risk:

- Arch can accidentally treat feedback as a new request, or use an approved plan after the user's scope changed.

Needed:

- Pending-review guard:
  - "You have a pending plan. Should I refine it, cancel it, or start a new request?"
  - Do not continue with the old approved plan if user intent changes affected agents, topology, tools, auth, or model config.

## Runtime and PM2 Findings

Recent PM2 logs from local battle runs show useful runtime issues that should feed the UX:

- Repeated reasoning-model warnings from OpenAI provider: `temperature` is not supported for reasoning models.
- Runtime smoke logs show missing `AgentModelConfig` falling back through model resolution.
- Runtime smoke encountered tool binding failures such as `create_support_case` and `notify_staff` missing required parameter `input`.
- Audit transport skipped `arch_payload` records as unsupported stream.

Product implication:

- Proposal readiness cannot stop at ABL syntax. Users need to see that tool bindings and model config were checked in the same review flow.

## Visible Work Trail Without Exposing Hidden Reasoning

Do not show private chain-of-thought. Show a structured work trail derived from tool calls, lifecycle events, and validation outputs.

Recommended UI labels:

- Reading project context
- Reading topology
- Reading agent `SupportRouter`
- Checking references
- Drafting plan
- Waiting for plan approval
- Compiling proposed agent
- Checking neighboring agents
- Checking tool bindings
- Checking auth and variables
- Checking model config
- Running health check
- Running runtime smoke
- Proposal ready for review
- Applying approved change
- Refreshing topology
- Writing journal entry

Implementation source:

- Use existing `activity` events where possible.
- Add deterministic activity events around important backend operations in `processInProjectMessage()`.
- For tool calls, derive labels from `toolName` and target entity, never from hidden model reasoning.
- For validation gates, derive labels from actual result payloads.

UI placement:

- Compact live rail above the assistant response.
- Collapsed summary after completion: "Checked topology, 2 agents, compile, health, runtime smoke."
- Artifact header should mirror the same state: "Ready after 6/7 checks" or "Blocked: tool binding missing."

## Gap Matrix

| Area                | Gap                                                                    | Severity | Evidence                                                                          | Recommended Fix                                                                     |
| ------------------- | ---------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Duplicate approvals | Plan approval can appear in PlanPanel and chat Confirmation            |       P0 | WidgetRenderer mirrors only pending diff tabs                                     | Make artifact panel canonical for plan and diff approvals; chat renders mirror-only |
| Fast click          | Duplicate approval can surface `SESSION_BUSY`                          |       P0 | Route returns busy during lock contention                                         | Add review action idempotency key and global pending action lock in UI              |
| Focus stealing      | Topology and health artifacts set active tab unconditionally           |       P0 | `syncArtifactPanelState()` calls `setActiveTab()` for topology/health             | Add focus policy: only auto-focus user-initiated primary artifact or first artifact |
| Plan semantics      | User cannot tell plan approval from applying changes                   |       P0 | Plan approval text says "I will..." but no concrete diff yet                      | Rename button to "Approve scope"; next-step rail says "Next: prepare diff"          |
| Readiness evidence  | Proposal readiness not presented as gate checklist                     |       P0 | Diff shows validation but not full runtime ladder                                 | Add ProposalReadinessPanel                                                          |
| Odd direction       | Pending plan/mutation can be bypassed by ambiguous new message         |       P1 | Processor falls through to LLM unless text matches approval keywords              | Add pending-review intent resolver before LLM                                       |
| Artifact/chat split | Diff approval is in chat while details are in artifact                 |       P1 | InProjectDiffCard is read-only                                                    | Put approve/refine/cancel in artifact; chat mirror opens artifact                   |
| Activity visibility | Existing activity panel is available but not consistently fed          |       P1 | `ActivityEmitter` exists; process-in-project deterministic path emits status only | Emit structured activity for read, validate, apply, post-check                      |
| Health quality      | Health fix proposals may stop at plan or text                          |       P1 | Battle audit found tool_add/health turns with no tool evidence                    | Add UI guard for "no artifact generated" and backend gate for ready claims          |
| Runtime logs        | Runtime smoke exposes tool/model config issues outside proposal review |       P1 | PM2 logs show missing input and model config fallback                             | Attach runtime smoke evidence to proposal                                           |
| Review history      | Rejected diffs auto-dismiss                                            |       P2 | `InProjectArtifactPanel` removes rejected diff after 2.5s                         | Preserve review history in Journal/Review tab                                       |
| Status copy         | "A response is already streaming" is accurate but unfriendly           |       P2 | API error message                                                                 | Map approval duplicate to "Already applying" UI message                             |

## Target Experience

### For Plan

Chat:

- "I prepared a plan. Review it in the panel."
- Button: Open plan
- No second approve button.

Artifact:

- Header: Plan proposed
- Clear copy: "Approving this plan allows Arch to prepare a concrete diff. It will not change the project yet."
- Actions: Approve scope, Refine, Cancel
- Evidence sections are collapsible.

After approval:

- Status rail: Plan approved -> Preparing diff
- Plan becomes read-only.

### For Changes

Chat:

- "Changes are ready for review."
- Button: Open changes
- No duplicate apply button.

Artifact:

- Header: Ready to apply or Blocked
- Runtime checklist before diff
- Diff viewer
- Actions: Apply changes, Request revision, Reject

After apply:

- Applied banner.
- Post-check summary.
- Journal entry link.
- Undo where available.

### For Health Check Fixes

Flow:

1. User runs health check.
2. Health tab shows findings.
3. User asks "fix it".
4. Arch creates plan with exact finding references.
5. Plan approval only approves scope.
6. Diff proposal includes before/after plus readiness checklist.
7. Apply runs mutation.
8. Post-apply health check runs and updates Health tab.

## Backend Design Recommendations

### 1. Review Action Idempotency

Add a `reviewActionId` to `proposal_response` requests.

Store last accepted action per pending plan or mutation:

- `pendingPlan.lastResolutionActionId`
- `pendingMutation.lastResolutionActionId`

If the same action arrives again:

- Return a deterministic SSE stream with current status.
- Do not return `SESSION_BUSY`.

### 2. Unified Review State

Create a single client/server review model:

```ts
type ReviewKind = 'plan' | 'mutation';
type ReviewStatus =
  | 'drafting'
  | 'proposed'
  | 'approved'
  | 'preparing_diff'
  | 'ready'
  | 'blocked'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'stale';
```

This should wrap `pendingPlan` and `pendingMutation` rather than replacing them immediately.

### 3. Runtime Readiness Artifact

Add `runtimeReadiness` to pending mutation payloads:

```ts
interface ProposalRuntimeReadiness {
  agentIRResolved: GateResult;
  projectCompilePassed: GateResult;
  topologyConsistent: GateResult;
  toolBindingsResolved: GateResult;
  authVariablesResolved: GateResult;
  modelConfigResolved: GateResult;
  diagnosticsCleanOrExplained: GateResult;
  runtimeFlowSmokePassed: GateResult;
}
```

UI should show this above the diff.

### 4. Artifact Focus Policy

Add an artifact event hint:

```ts
focusPolicy: 'auto' | 'background' | 'preserve-user-focus';
```

Default:

- Plan and diff: `auto`
- Health from explicit user health command: `auto`
- Topology refresh after apply: `background`
- Topology read during validation: `background`
- Journal: `background`

### 5. Pending Review Intent Resolver

Before routing a plain message to LLM, classify against pending review:

- approve current plan
- reject current plan
- refine current plan
- approve current diff
- reject current diff
- start unrelated request
- ambiguous

Ambiguous should ask a focused clarification instead of continuing.

## UI Design Recommendations

### 1. Canonical Review Panel

Build one `ReviewPanel` wrapper used by Plan and Changes:

- Title and status
- What changes if approved
- Evidence/readiness checklist
- Impact summary
- Main content
- Primary/secondary actions
- Review history

### 2. Chat Mirror Cards

Replace duplicate Confirmation widgets for plans and diffs with compact mirror cards when artifact exists:

- "Plan ready for review"
- "Changes ready for review"
- "Open review"
- "Waiting for your decision"

### 3. Subtle Work Trail

Use the existing ThinkingPanel, but feed it deterministic activity:

- Tool start and done
- Artifact creation
- Validation gate start and result
- Approval/apply lifecycle

Do not include raw model reasoning. Show observable steps and outputs only.

### 4. Approval Button States

All review buttons across all surfaces should share the same pending state:

- enabled
- submitting
- already applying
- applied
- stale
- blocked

The state should be keyed by review id, not component instance.

### 5. Runtime Evidence Copy

Proposal header should use plain language:

- "Ready to apply: compile and diagnostics passed. Runtime smoke not run."
- "Blocked: tool `lookup_user_history` has no project tool binding."
- "Needs review: model config inherits from tenant default."

## Test Coverage Needed

### Unit Tests

- Plan artifact exists -> chat Confirmation renders mirror only.
- Diff artifact exists -> chat Confirmation renders mirror only.
- Topology artifact update does not steal focus from active Plan or Changes tab.
- Duplicate `sendProposal()` calls share pending state and do not produce duplicate user-visible errors.
- Pending review plus odd free-text message triggers clarification.

### Integration Tests

- `proposal_response` accept for pending plan emits plan approved, no mutation applied.
- `proposal_response` accept for pending mutation applies exactly once.
- Duplicate accept with same review action id is idempotent.
- Post-apply topology refresh uses background focus policy.

### E2E Tests

- Health check -> fix it -> one Plan review surface only.
- Approve Plan rapidly twice -> no `SESSION_BUSY` visible error.
- Click Plan tab while topology refresh arrives -> stays on Plan.
- Approve scope -> diff generated -> apply changes -> post-health evidence appears.
- Refine plan with odd direction -> old plan becomes refining/stale, no mutation can use it.

## Prioritized Implementation Plan

### Phase 1: Trust and Bug Fixes

1. Mirror plan confirmations in chat instead of rendering duplicate approval buttons.
2. Preserve active artifact tab when background topology or health updates arrive.
3. Add global review-action pending state in UI and disable duplicate clicks.
4. Map duplicate approval `SESSION_BUSY` to a non-error "Already applying" state.

### Phase 2: Review Model

1. Add unified review state wrapper.
2. Add canonical ReviewPanel.
3. Move diff approval actions into the artifact panel.
4. Make chat cards mirror-only for review actions.

### Phase 3: Runtime Readiness

1. Persist runtime readiness on proposals.
2. Display readiness checklist above diffs.
3. Run post-apply health check and optional runtime smoke.
4. Mark proposal ready only when required gates pass or are explicitly waived.

### Phase 4: Visible Work Trail

1. Emit deterministic activity events in the IN_PROJECT processor.
2. Add tool target labels to activity events.
3. Show collapsed summary after completion.
4. Add audit-log links for advanced users.

## Product Principles

1. Users approve one thing in one place.
2. Plans approve scope; diffs apply project changes.
3. A proposal is not ready unless runtime context is checked.
4. Artifacts should not steal focus unless the user asked for that artifact.
5. Chat should never be the only place to approve a detailed code change.
6. Visible work trail should show what Arch did, not private hidden reasoning.
