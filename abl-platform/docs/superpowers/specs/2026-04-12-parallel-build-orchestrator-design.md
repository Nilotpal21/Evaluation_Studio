# Parallel BUILD Orchestrator — Design Spec

**Date:** 2026-04-12
**Status:** REVIEWED
**Scope:** Arch AI BUILD phase — parallel agent generation, deterministic completion, conversational modification
**Review:** 2026-04-12 — 6 areas reviewed, 7+5 findings incorporated (see Review Findings section)

## Problem

The BUILD phase uses a single `streamText` call with `MAX_ONBOARDING_STEPS=16` to generate all agents sequentially. This fails when:

- 6 agents × ~3 steps each = 18 steps → exceeds the 16-step limit
- LLM behavior varies — sometimes 2 steps/agent, sometimes 5
- A single failure blocks all remaining agents
- The LLM decides completion state (inconsistent — sometimes loops, sometimes forgets options)
- No auto-continue mechanism when the step limit is exhausted mid-generation

The gate-based review flow (`agent_review` gates) was removed from the frontend (`useArchChat.ts:629`) but the backend still emitted gates, causing sessions to get stuck in `GATE_PENDING`.

## Solution

Replace the single `streamText` approach with a **parallel orchestrator-workers pattern**:

1. **Parallel workers** — one `streamText` per agent, running concurrently
2. **Deterministic completion** — code (not LLM) generates the completion widget
3. **Conversational modification** — full LLM chat for user-driven changes after initial generation

## Architecture

```
POST /message (BUILD phase, missing agents detected)
│
├─ PARALLEL GENERATION (automatic)
│  1. clearStaleArtifacts()
│  2. Resolve LLM model once (shared across all workers)
│  3. Build shared context (topology, spec, sibling agent names)
│  4. For each missing agent:
│     spawn streamText() with BUILD_AGENT_PROMPT + agent spec
│     Tools: generate_agent + compile_abl ONLY
│     stopWhen: stepCountIs(8)
│     Max 2 auto-retries on failure (3 total attempts)
│  5. Promise.allSettled(workers)
│  6. normalizeBuildAgentSource() per agent
│  7. reconcileBuildResults()
│  8. Emit file_changed + compile_result per agent (live UI updates)
│  9. buildCompletionWidgetPayload()
│  10. Emit tool_call: BuildComplete widget
│  11. Persist pendingInteraction, transition to IDLE
│
├─ USER ANSWERS WIDGET (deterministic — never reaches the LLM)
│  processMessage detects: msg.type === 'tool_answer' && pendingInteraction
│    has widgetType === 'BuildComplete'
│  → INTERCEPT: do NOT fall through to LLM streamText
│  → call handleBuildAction(answer, ctx, session, results, emit, close, deps)
│    deps.runParallelGeneration = runParallelGeneration (injected)
│    deps.generateToolConfigs = generateToolConfigs (injected, wires TOOLS sub-phase)
│  → handleBuildAction routes deterministically:
│    create       → set buildProgress.stage='complete', proceed_to_next_phase → CREATE
│    retry        → re-run orchestrator for failed agents only → re-emit widget
│    retry_all    → re-run orchestrator for ALL agents → re-emit widget
│    tools        → enter TOOLS sub-phase (generateToolConfigs)
│    fix_warnings → re-run orchestrator for warning agents → re-emit widget
│    modify       → emit SingleSelect of agent names → enter CONVERSATIONAL MODE
│    review       → emit SingleSelect of agent names → show code
│    back         → BUILD→BLUEPRINT backtrack
│    (default)    → enter CONVERSATIONAL MODE with user text
│
└─ CONVERSATIONAL MODE (user-driven)
   Full LLM chat with all BUILD tools:
     generate_agent, compile_abl, propose_modification, ask_user, proceed_to_next_phase
   After each LLM turn that modifies agents:
     → reconcileBuildResults()
     → re-emit BuildComplete widget
   User iterates until "Create Project"
```

## Two Modes in BUILD

| Mode                        | Trigger                          | LLM involved?                    | Tools available                         |
| --------------------------- | -------------------------------- | -------------------------------- | --------------------------------------- |
| Parallel generation         | First BUILD entry, retry action  | Per-agent workers only (no chat) | generate_agent + compile_abl per worker |
| Conversational modification | User picks modify/add/text input | Full LLM with chat               | All BUILD tools                         |

## Parallel Worker Design

### Per-Worker Inputs

- **System prompt:** `BUILD_AGENT_PROMPT` (existing, ~20 lines, focused on single-agent generation)
- **User message:** Injected context:

  ```
  Generate the agent: {name}
  Role: {role}
  Execution mode: {executionMode}
  Description: {description}

  Sibling agents (for HANDOFF targets): {siblingNames}

  Project context:
  - Name: {projectName}
  - Description: {projectDescription}
  - Channels: {channels}
  - Compliance: {complianceNotes}
  ```

- **Tools:** `generate_agent` + `compile_abl` (2 tools only — no ask_user, no proceed)
- **Limits:** `stopWhen: stepCountIs(8)`, same `maxOutputTokens` and `temperature` as main flow
- **Abort:** Each worker gets its own `AbortSignal.timeout(60_000)` — independent of the parent request's abort signal. If one worker times out, others continue. The parent request signal is also monitored for browser close.
- **Elapsed tracking:** Each worker records `Date.now()` at start and end. The delta is passed as `elapsed` in the worker result so `buildCompletionWidgetPayload` can populate `stats.elapsedMs`.

### Worker Lifecycle

```
Attempt 1:
  streamText → generate_agent(name, code) → compile_abl(name, code)
  If compile passes → status: compiled
  If compile fails → LLM self-corrects within remaining steps
  If still fails after 8 steps → mark error, auto-retry

Attempt 2 (auto-retry):
  clearStaleArtifacts(agentName) → wipe previous file
  streamText → same flow, fresh AbortSignal.timeout(60_000)
  If fails → auto-retry

Attempt 3 (final auto-retry):
  clearStaleArtifacts(agentName) → wipe previous file
  streamText → same flow, fresh AbortSignal.timeout(60_000)
  If fails → mark as error, surface in widget
```

Note: `BUILD_AGENT_PROMPT` says "max 1 retry" — update it to say "max 2 retries" to align with the orchestrator's 3-attempt budget.

### SSE During Parallel Execution

Workers share the parent request's `emit` function. All workers write to the same SSE stream:

- **Start:** `emit({ type: 'activity', id: 'build-start', label: 'Building 6 agents...' })`
- **Per-agent completion:** `emit({ type: 'compile_result', agent, status, errors, warnings })`
- **Per-agent file:** `emit({ type: 'file_changed', path, action: 'create', content })`
- **Activity update:** `emit({ type: 'activity', id: 'build:AgentName', label: 'AgentName compiled (3/6)' })`

Concurrent writes to the SSE stream: the `emit` function calls `controller.enqueue()` on a Web Streams API `ReadableStream` (`packages/arch-ai/src/streaming/sse-serializer.ts:52-104`). JavaScript is single-threaded — `enqueue()` is synchronous, and `Promise.allSettled` workers interleave microtask callbacks on the same event loop. **No mutex needed.** The JS event loop already serializes all `enqueue` calls. Workers run in parallel; SSE events are naturally serialized by the runtime.

### Failure Isolation

- `Promise.allSettled` — never rejects, always returns all results
- Each worker is independent: if `OrderTrackingAgent` fails 3 times, `ReturnsAgent` is unaffected
- Failed agents: `buildProgress.agentStatuses.{name} = 'error'`
- Successful agents: preserved across retries (only failed agents re-run)

### Return Contract: Full Reconciled Results

`runParallelGeneration` ALWAYS returns `AgentGenResult[]` for **every topology agent**, not just the agents it ran workers for. Contract:

1. Run workers for the requested agent names (may be a subset on retry)
2. After `allSettled`, call `reconcileBuildResults` with:
   - `rawResults`: worker outputs for the agents just generated
   - `persistedStatuses`: current `buildProgress.agentStatuses` from DB (includes previously-successful agents)
   - `agentFiles`: full `metadata.files` from DB (includes preserved files)
3. `reconcileBuildResults` merges the raw worker results with the persisted state, producing a complete `AgentGenResult[]` covering every topology agent
4. Return the merged result

This ensures `handleBuildAction('retry')` always receives the full picture. The widget shows all agents — not just the retried subset. The `create` completeness check in `handleBuildAction` sees every agent status.

## Completion Widget

Generated by `buildCompletionWidgetPayload()` (existing, deterministic):

| Aggregate State | Widget Question                                              | Primary Options                                |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| All compiled    | "All N agents compiled successfully. Your project is ready!" | Create Project, Generate tools, Modify, Review |
| Some warnings   | "N agents compiled (W warnings). Your project is ready!"     | Create Project, Fix warnings, Modify           |
| Some errors     | "X/N agents compiled. Y have errors."                        | Retry failed, Create anyway, Modify, Back      |
| All errors      | "Build failed — 0/N agents compiled."                        | Retry all, Back to Blueprint                   |

Per-agent details in the widget payload:

```json
{
  "agents": [
    {
      "name": "CustomerTriage",
      "status": "compiled",
      "mode": "reasoning",
      "agentType": "SUPERVISOR",
      "toolCount": 0,
      "handoffCount": 3,
      "quality": { "guardrails": true, "memory": true, "catchAllHandoff": true }
    }
  ]
}
```

## Conversational Modification Mode

After the initial parallel generation, the user can modify agents through natural chat. This uses the existing single-`streamText` approach (the current `processMessage` flow) with all BUILD tools available.

### What Users Can Do

- **Modify agent code:** "Change the persona of OrderAgent" → LLM calls `propose_modification`
- **Add new agent:** "Add a security audit agent" → LLM calls `generate_agent` + updates topology
- **Full rewrite:** "Rewrite CustomerTriage from scratch" → LLM calls `generate_agent` (overwrites)
- **Ask questions:** "Show me the code for ReturnsAgent" → LLM reads from session files
- **Review quality:** "What warnings does BillingAgent have?" → LLM reads compile results
- **Finish:** "Create my project" or clicks Create CTA → `proceed_to_next_phase`

### Post-Modification Widget Re-Emission

After any LLM turn that calls `generate_agent`, `compile_abl`, or `propose_modification`:

1. `reconcileBuildResults()` — recompute all statuses
2. `buildCompletionWidgetPayload()` — regenerate widget
3. Emit the updated widget so the user always sees current state

### Topology Changes — Explicit Boundary

The BUILD phase operates on a **fixed topology**. `metadata.topology` is the source of truth for which agents exist and how they connect. The file set (`metadata.files`) must stay in sync with the topology.

| User Request                                 | Classification | What Happens                                                                                                                                                                                                                                      |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Change persona/constraints/tools on AgentX" | SMALL          | Stays in BUILD. LLM calls `propose_modification`. Topology unchanged.                                                                                                                                                                             |
| "Add a new agent"                            | LARGE          | **Always backtracks to BLUEPRINT.** `classifyMutationScope` returns LARGE. The architect redesigns the topology with the new agent. On BUILD re-entry, `diffTopologyAgainstBuildState` preserves existing files and only generates the new agent. |
| "Remove AgentX"                              | LARGE          | Same as add — backtracks to BLUEPRINT. Architect removes from topology. On re-entry, diff removes the file and preserves the rest.                                                                                                                |
| "Redesign the routing"                       | LARGE          | BLUEPRINT backtrack. Full topology redesign.                                                                                                                                                                                                      |

**Why always backtrack for add/remove:** A new agent needs topology edges (HANDOFFs from/to it), an updated entry point, and potentially modified sibling agents. Writing a file without updating `metadata.topology` causes divergence — the widget shows wrong counts, `reconcileBuildResults` reports phantom agents, and `proceed_to_next_phase` exit criteria check topology agents vs files. The BLUEPRINT architect handles all of this atomically via `generate_topology`.

**No `add_agent_to_topology` tool in BUILD.** The complexity of maintaining topology consistency (edges, entry point, sibling HANDOFF references) is already solved in BLUEPRINT's `generate_topology`. Duplicating it in BUILD creates a maintenance burden and divergence risk. The backtrack path is fast — existing files are preserved via `diffTopologyAgainstBuildState`.

## Existing Modules to Wire

| Module                           | What It Does                                                                           | Wiring Point                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `build-orchestrator.ts`          | `clearStaleArtifacts`, `validateSingleBuildAgentAgainstTopology`, `recoverFalseErrors` | Called before parallel gen (cleanup), after gen (validation)            |
| `build-completion.ts`            | `buildCompletionSummary`, `buildCompletionWidgetPayload`, `handleBuildAction`          | Called after reconciliation (widget), on widget answer (action routing) |
| `build-result-reconciliation.ts` | `reconcileBuildResults` — merges raw results + DB state + compiler re-validation       | Called after parallel gen and after each conversational modification    |
| `build-source-normalization.ts`  | `normalizeBuildAgentSource` — repairs REMEMBER targets, MEMORY declarations            | Called on each worker's output before storing                           |

## Existing Module Wiring Notes

Review findings on the existing modules:

1. **`retry`/`retry_all` in `handleBuildAction`** are already functional (not stubs). They call `deps.runParallelGeneration` which is the injection point we fill. **`tools`/`fix_warnings` remain stubs** — they log a warning and re-emit the widget. These are out of scope for this spec (TOOLS sub-phase is a separate feature).

2. **`reconcileBuildResults` passes `edges: []`** to the compiler re-validation internally. This means cross-agent HANDOFF routing errors won't be caught during parallel gen. Fix: after `Promise.allSettled`, run `validateGeneratedBuildSession` with the real topology edges as a final cross-agent validation pass. Individual worker validation uses placeholder siblings (correct for parallel gen); the post-gen full validation catches routing errors.

## New Code to Write

| Component                                | Location                                                        | Purpose                                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runParallelGeneration()`                | `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`             | Spawns N `streamText` workers, per-worker abort signals, elapsed tracking, collects results, handles 2 auto-retries per agent. Returns full reconciled `AgentGenResult[]` for every topology agent.                         |
| Orchestrator entry in `processMessage`   | `apps/studio/src/app/api/arch-ai/message/route.ts`              | Detects "BUILD + missing agents" → calls orchestrator instead of single streamText                                                                                                                                          |
| BuildComplete tool_answer interception   | `apps/studio/src/app/api/arch-ai/message/route.ts`              | In the `tool_answer` handler: if `pendingInteraction.payload.widgetType === 'BuildComplete'`, call `handleBuildAction` with injected deps and RETURN — do not fall through to LLM                                           |
| `deps` injection for `handleBuildAction` | `apps/studio/src/app/api/arch-ai/message/route.ts`              | Wire both `deps.runParallelGeneration` and `deps.generateToolConfigs` so all widget actions are functional                                                                                                                  |
| Post-gen cross-agent validation          | In `runParallelGeneration` after `allSettled`                   | Runs `validateGeneratedBuildSession` with real topology edges to catch HANDOFF routing errors missed during parallel gen                                                                                                    |
| Post-modification widget re-emission     | In `processMessage` post-stream                                 | Track `agentsModifiedThisTurn` (from `generate_agent`/`compile_abl`/`propose_modification` tool calls). If non-empty after stream ends, call `reconcileBuildResults` + `buildCompletionWidgetPayload` + emit updated widget |
| Remove `tool_generation` gate            | `apps/studio/src/app/api/arch-ai/message/route.ts`              | Remove the `tool_generation` gate emission in the allDone handler — tools are handled by `handleBuildAction('tools')`                                                                                                       |
| Update `BUILD_AGENT_PROMPT`              | `packages/arch-ai/src/prompts/phases/build.ts`                  | Change "max 1 retry" to "max 2 retries" to align with orchestrator                                                                                                                                                          |
| Clean `BuildProgressCard` gate state     | `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx` | Remove `approvedAgents`/`currentReviewAgent` store subscriptions and `approved`/`reviewing` row states. Derive all status from `filePanelFiles[name].compileStatus`                                                         |

## Session State During Parallel Generation

During parallel generation, the session is in ACTIVE state. If the user sends a message while workers are running:

- The route handler checks `session.state === 'ACTIVE'` and the request has no pending interaction
- **Guard:** Before starting parallel gen, set a `buildProgress.stage = 'generating'` marker. The route handler checks this at the top of `processMessage`: if `phase === 'BUILD' && buildProgress.stage === 'generating'`, return a non-fatal error: `{ type: 'error', code: 'BUILD_IN_PROGRESS', message: 'Agents are being generated. Please wait...', retryable: true }`
- This is safe because `buildProgress.stage` is set to `'generating'` at parallel gen start and to `'agents_complete'` or `'complete'` when it finishes

## Abort and Cleanup

**Per-worker abort:** Each `streamText` call gets `AbortSignal.timeout(60_000)`. Workers are independent — one timeout doesn't kill others.

**Parent request abort (browser close):** The parent `request.signal` is monitored via `AbortSignal.any([workerTimeout, request.signal])` for each worker. When the parent aborts:

1. All workers receive abort → `streamText` stops
2. Files already written to MongoDB by completed workers are **preserved** (not rolled back)
3. `buildProgress.agentStatuses` reflects the actual state: completed agents as `'compiled'`, in-progress agents stay at `'pending'`
4. Session transitions to IDLE via existing `handleClientAbort`
5. On next user visit (session resume), `processMessage` detects missing agents and re-runs parallel gen for just the missing ones

**No rollback needed:** Partial state is valid. The orchestrator is idempotent — it only generates missing agents. Completed agents from a partial run are reused.

## Frontend Event/Store Contract

The parallel orchestrator emits SSE events that the frontend must handle. Here's the exact contract between backend events and frontend state:

### SSE Events Emitted by the Orchestrator

| Event                                                                               | When                                 | Frontend Handler                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `activity { id, label, group? }`                                                    | Worker starts/completes              | `useArchChat` updates activity steps UI                                                           |
| `file_changed { path, action, content }`                                            | Agent file stored in DB              | `useArchChat` calls `store.addFile()` → `BuildProgressCard` derives status from `filePanelFiles`  |
| `compile_result { agent, status, errors, warnings }`                                | Agent compiled                       | `useArchChat` calls `store.updateFileCompileStatus()` → `BuildProgressCard` updates per-agent row |
| `tool_call { toolCallId, toolName: 'ask_user', input: BuildCompleteWidgetPayload }` | All workers done                     | `useArchChat` sets `awaitingWidget`, `WidgetRenderer` dispatches to `BuildCompleteCard`           |
| `error { code: 'BUILD_IN_PROGRESS' }`                                               | User sends message during generation | `useArchChat` shows non-fatal error message                                                       |

### What Already Works

- `WidgetRenderer.tsx:60-63` dispatches `widgetType === 'BuildComplete'` to `BuildCompleteCard` — no change needed
- `BuildCompleteCard.tsx` accepts `BuildCompleteWidgetPayload` shape — no change needed
- `file_changed` and `compile_result` handlers in `useArchChat` already call the store — no change needed

### What Needs Cleanup

- `BuildProgressCard` currently renders `approved` / `reviewing` status rows using `store.approvedAgents` and `store.currentReviewAgent`. These are gate-era fields that are never populated in the gate-free flow. The component should derive all status from `filePanelFiles[name].compileStatus` only — remove the `approvedAgents`/`currentReviewAgent` dependencies and the `approved`/`reviewing` row states.
- `BuildProgressCard` currently subscribes to `buildStages` for a 4-stage pipeline (gen → comp → enrich → done). The parallel orchestrator does not emit `build_stage` events — it emits `compile_result` directly. The `buildStages` derivation should be removed or simplified to derive from `compileStatus`.
- The store fields `approvedAgents`, `currentReviewAgent`, `buildStages`, `agentElapsed` are gate-era state that should be deprecated. They can be removed in a follow-up cleanup — the parallel flow does not write to them.

## Risk Mitigations

| Risk                                     | Mitigation                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| One agent blocks all (timeout)           | Per-worker `AbortSignal.timeout(60_000)` + `Promise.allSettled`                                       |
| LLM generates invalid HANDOFF references | Placeholder siblings during parallel gen + post-gen full cross-agent validation with real edges       |
| Step limit hit within worker             | 8 steps per worker (generous). 2 auto-retries as buffer                                               |
| User sends message during generation     | `buildProgress.stage === 'generating'` guard returns `BUILD_IN_PROGRESS` error                        |
| Browser close mid-generation             | Partial results preserved. Next visit re-runs only missing agents (idempotent)                        |
| Cross-agent routing errors missed        | Post-gen `validateGeneratedBuildSession` with real topology edges catches what parallel workers can't |
| "Add agent" topology ambiguity           | Small changes stay in BUILD; `classifyMutationScope` routes large changes to BLUEPRINT                |

## Non-Functional Requirements

### Abort Propagation

Each worker's abort signal: `AbortSignal.any([AbortSignal.timeout(60_000), request.signal])`. This ensures:

- Individual workers time out independently (60s each)
- All workers abort immediately when the browser closes (parent `request.signal`)
- `handleClientAbort` in route.ts transitions session to IDLE — partial results preserved

### Provider Rate Limiting / Concurrency

Parallel workers make N concurrent LLM API calls. For provider rate limit safety:

- **Max concurrency:** Cap at `ARCH_AI_BUILD.MAX_PARALLEL_AGENTS` (default: 6, configurable). For topologies with >6 agents, batch workers in groups of 6.
- **Backoff:** If a worker receives a 429 (rate limited), that worker's retry uses exponential backoff (1s, 2s, 4s) before the next attempt. Other workers are unaffected.
- **Model resolution:** Resolve the model ONCE before spawning workers. All workers share the same resolved model instance — no per-worker credential checks.

### Test Coverage Required

| Test                                   | Type        | What It Verifies                                                                                                                        |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| BuildComplete tool_answer interception | Unit        | `processMessage` detects `widgetType === 'BuildComplete'` and calls `handleBuildAction` instead of falling through to LLM               |
| Merged retry results                   | Unit        | `runParallelGeneration(['A'])` on a 3-agent topology returns `AgentGenResult[]` for all 3 agents (A retried + B,C from persisted state) |
| Add-agent backtrack                    | Unit        | `classifyMutationScope('Add a security agent')` returns `'LARGE'` → triggers BLUEPRINT backtrack                                        |
| Remaining GATE_PENDING regressions     | Integration | After full INTERVIEW→BLUEPRINT→BUILD→CREATE flow, assert zero `gate_request` SSE events emitted and session never enters `GATE_PENDING` |
| Per-worker abort independence          | Unit        | One worker timing out doesn't abort siblings                                                                                            |
| Idempotent re-entry                    | Integration | Abort mid-generation → resume → only missing agents regenerated                                                                         |

## Review Findings

### Round 1 (2026-04-12 — code review agent)

1. **SSE mutex not needed** — JS event loop serializes `controller.enqueue()` calls. Mutex dropped.
2. **Per-worker abort signals** — each worker gets its own `AbortSignal.timeout(60_000)` combined with parent request signal via `AbortSignal.any()`.
3. **Elapsed tracking** — workers record wall time so `stats.elapsedMs` is populated in the widget.
4. **Session concurrency guard** — `buildProgress.stage === 'generating'` check prevents concurrent messages during parallel gen.
5. **Mid-abort cleanup** — partial results preserved, orchestrator is idempotent on re-entry.
6. **Cross-agent validation gap** — post-gen `validateGeneratedBuildSession` with real edges added.
7. **Post-conversational-modification trigger** — `agentsModifiedThisTurn` tracking added to detect when re-reconciliation is needed.

### Round 2 (2026-04-12 — P1/P2 findings)

8. **P1: Deterministic widget wiring** — BuildComplete `tool_answer` must be intercepted in `processMessage` before the LLM. Route to `handleBuildAction` with both `deps.runParallelGeneration` and `deps.generateToolConfigs` injected. Every action is deterministic code — the LLM never handles widget answers.
9. **P1: Retry merged result contract** — `runParallelGeneration` ALWAYS returns `AgentGenResult[]` for every topology agent (not just the retried subset). Merger happens via `reconcileBuildResults` combining raw worker results + persisted statuses + persisted files.
10. **P2: Frontend section rewritten** — Replaced "no changes needed" with explicit event/store contract table. Identified stale gate-era fields (`approvedAgents`, `currentReviewAgent`, `buildStages`) that need cleanup in `BuildProgressCard`.
11. **P2: Gate scope narrowed and expanded** — Identified remaining `tool_generation` gate in allDone handler. Added explicit removal to scope. Success criterion narrowed to "zero GATE_PENDING in ONBOARDING flow."
12. **P2: Add-agent topology mutation** — Made boundary explicit: add/remove agent ALWAYS backtracks to BLUEPRINT. No `add_agent_to_topology` tool in BUILD. Justified by topology consistency requirements (edges, entry point, sibling HANDOFFs).
13. **Non-functional section added** — abort propagation, provider rate limiting, max concurrency, required test coverage for all review findings.

## Remaining Gate Removals (in scope)

The prior fix commits removed `agent_review` and `topology_approval` gate emissions. One gate path remains:

- **`tool_generation` gate** (`route.ts` allDone handler): emitted when all agents are approved and tools are detected. This gate asks the user to approve tool DSL generation. In the parallel flow, tool generation is handled by `handleBuildAction('tools')` → `deps.generateToolConfigs`. The `tool_generation` gate emission must be removed from the allDone handler — it's dead code in the gate-free flow.

After this removal, zero `gate_request` events are emitted during ONBOARDING. The `GATE_PENDING` state is only reachable via `gate_response` messages, which the frontend never sends.

## Success Criteria

1. 6-agent project generates in <30s (parallel), not >90s (sequential)
2. Zero GATE_PENDING traps in the ONBOARDING flow — no `gate_request` events emitted, no sessions enter `GATE_PENDING` during INTERVIEW/BLUEPRINT/BUILD/CREATE
3. Partial failures don't block success — 4/6 compiled still shows widget
4. User can modify any agent after initial generation without restarting
5. "Create Project" works on first click every time (deterministic, no LLM luck)
6. BuildProgressCard shows live per-agent status during generation
7. Browser close mid-generation preserves completed agents (idempotent re-entry)
8. User message during generation returns friendly "please wait" (not stuck)
9. BuildComplete widget answer is always deterministic — never reaches the LLM
