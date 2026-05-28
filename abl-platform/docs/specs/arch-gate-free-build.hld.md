# HLD: Arch Conversational Flow — Gate-Free Onboarding

**Feature Spec**: `docs/features/sub-features/arch-gate-free-build.md`
**Test Spec**: `docs/testing/sub-features/arch-gate-free-build.md`
**Parent HLD**: `docs/specs/arch-ai-v03.hld.md`
**Status**: DRAFT
**Author**: Sri Harsha
**Date**: 2026-04-10

---

## 1. Problem Statement

The Arch AI onboarding flow uses blocking gates (`topology_approval`, `agent_review`, `tool_generation`, `quality_floor`) that transition sessions to `GATE_PENDING`. This creates a distributed state machine across 4 files with 5 documented failure modes in BUILD alone: DTO mapping loops, state race deadlocks, stuck sub-phases, empty gate emissions, and quality gate blocking. The same fragility affects BLUEPRINT (topology gate pending after browser close).

This HLD describes the architecture for removing all gate-blocking mechanisms from the onboarding flow, replacing them with auto-generation + conversational narration + durable backend checkpoints, while preserving the backend phase model (`INTERVIEW | BLUEPRINT | BUILD | CREATE`) for resume and durability.

### FR Traceability

| FR       | Name                          | HLD Section         | Notes                                |
| -------- | ----------------------------- | ------------------- | ------------------------------------ |
| FR-1     | Gate/GATE_PENDING Elimination | S3, S4 (concern 10) | Core state machine change            |
| FR-2     | Widget Contract Preserved     | S3.2                | No change to widget handling         |
| FR-3     | Durable Build Progress        | S5 (data model)     | New `buildProgress` field            |
| FR-4     | Phase Transitions             | S3.3, S6            | `continue` + `proceed_to_next_phase` |
| FR-5     | Auto-Generation (BUILD)       | S3.4                | Two-stage: agents then tools         |
| FR-6     | Chat Narration                | S3.4                | SSE text_delta emissions             |
| FR-7     | Conversational Modification   | S3.4                | Existing LLM tool pattern            |
| FR-8     | UI Stage Collapse             | S3.1                | Client-side derivation               |
| FR-9     | Template Picker               | UI-only             | No engine architecture               |
| FR-10-11 | Topology/Build Visualization  | UI-only             | Client reads `buildProgress`         |
| FR-12    | Build-to-Create Transition    | S3.3                | `create` deterministic path          |
| FR-13    | Session Resume                | S3.5                | Resume from `buildProgress`          |
| FR-14    | Backward Compatibility        | S4 (concern 10)     | GATE_PENDING cleanup on load         |
| FR-15    | Governance                    | S4 (concern 4)      | Tool config safety rules             |

---

## 2. Alternatives Considered

### Option A: Non-Blocking Gates (Keep Gates, Remove Blocking)

**Description**: Keep the gate UI (Accept/Modify/Reject buttons) but make them non-blocking. The session stays `ACTIVE` during gates instead of `GATE_PENDING`. Users can skip ahead, and gates auto-accept after a timeout.

- **Pros**: Minimal code change. Gate UI is familiar. Preserves explicit review points.
- **Cons**: Still maintains the distributed gate state machine (gate queue, gate payloads, gate response handlers). Adds complexity (timeout logic, skip logic) without removing the root cause. The `pickNextGate` / `diffTopologyAgainstBuildState` / `GateManager` code all remain.
- **Effort**: M

### Option B: Remove Gates, Replace with Conversational Flow + Durable Checkpoints (CHOSEN)

**Description**: Eliminate gates as a UI and session-state concept. Remove `GATE_PENDING` from the state machine. Replace with: (1) auto-generation with rich narration, (2) deterministic `continue`/`create` buttons for phase transitions, (3) `proceed_to_next_phase` LLM tool for typed intent, (4) durable `buildProgress` model for resume, (5) same atomic backend work at transition points (topology diff, topologyApproved flag).

- **Pros**: Eliminates the root cause of all 5 failure modes. Removes ~400 lines of gate queue/manager/handler code. Simpler state machine (4 states vs 5). Better UX — conversational, not form-like. Resume is driven by durable `buildProgress` instead of fragile gate queue state.
- **Cons**: Loses explicit per-agent review (mitigated: user can review in IDE panel and request changes via chat). Requires new `buildProgress` persistence. Requires refactoring BLUEPRINT→BUILD transition out of gate handler into shared function.
- **Effort**: L

### Option C: Full Phase Collapse (4 Backend Phases → 2)

**Description**: Collapse `INTERVIEW | BLUEPRINT | BUILD | CREATE` into just `COLLECTING | BUILDING`. Merge spec gathering, topology design, and agent generation into a single fluid conversation.

- **Pros**: Maximum simplicity. Matches the 4-stage UI model at the backend level.
- **Cons**: Breaks resume (no durable phase to restore to). Breaks journal (phase-tagged entries become meaningless). Breaks specialist routing (each phase routes to a different specialist). Requires rewriting the entire coordinator. Massive blast radius.
- **Effort**: XL

### Recommendation: Option B

**Rationale**: Option B surgically removes the failure-prone gate layer while preserving the durable backend phase model that resume, journals, and specialist routing depend on. It's the right trade-off between simplification and stability. Option A doesn't fix the root cause. Option C is a full rewrite with unacceptable blast radius.

---

## 3. Architecture

### 3.1 System Context — Before vs After

```
BEFORE:
  Client ──POST /message──→ Route Handler ──→ Session (IDLE→ACTIVE)
                                            ──→ Specialist Executor (LLM)
                                            ──→ Gate Emission (ACTIVE→GATE_PENDING)
                                            ──→ SSE: gate_request
  Client ──POST /message──→ Route Handler ──→ Gate Response Handler
    (gate_response)                         ──→ (GATE_PENDING→ACTIVE)
                                            ──→ Next Gate or LLM Turn
                                            ──→ (ACTIVE→GATE_PENDING) again...

AFTER:
  Client ──POST /message──→ Route Handler ──→ Session (IDLE→ACTIVE)
    (message/continue/                      ──→ Specialist Executor (LLM)
     create)                                ──→ SSE: text_delta, file_changed,
                                                 compile_result, activity, done
                                            ──→ Session (ACTIVE→IDLE)
  No GATE_PENDING. No gate_request. No gate_response.
```

### 3.2 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ POST /api/arch-ai/message (route.ts)                            │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │ Message       │    │ Phase Transition  │    │ Specialist    │ │
│  │ Dispatcher    │───→│ Handler           │───→│ Executor      │ │
│  │               │    │                   │    │ (LLM loop)    │ │
│  │ message       │    │ continue: check   │    │               │ │
│  │ tool_answer   │    │   exit criteria,  │    │ Emits SSE:    │ │
│  │ continue      │    │   atomic metadata │    │ text_delta    │ │
│  │ create        │    │   update, emit    │    │ file_changed  │ │
│  │               │    │   phase_transition│    │ compile_result│ │
│  │ [REMOVED:     │    │                   │    │ activity      │ │
│  │  gate_response│    │ proceed_to_next_  │    │ tool_call     │ │
│  │ ]             │    │ phase: same logic  │    │ done          │ │
│  └──────────────┘    │   via LLM tool    │    └───────────────┘ │
│                       └──────────────────┘                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Build Progress Writer (NEW)                               │   │
│  │ After file_changed/compile_result:                        │   │
│  │   $set metadata.buildProgress.agentStatuses.{name}        │   │
│  │ After tool config generated:                              │   │
│  │   $set metadata.buildProgress.toolStatuses.{name}         │   │
│  │   $set metadata.toolDsls.{name}                           │   │
│  │ After all complete:                                       │   │
│  │   $set metadata.buildProgress.stage = 'complete'          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ GATE_PENDING Cleanup (NEW, on load paths)                 │   │
│  │ GET /sessions/current: if GATE_PENDING → archive, null    │   │
│  │ POST /message: if GATE_PENDING → archive, 409             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [REMOVED: GateManager, gate emission, gate response handlers,  │
│   pickNextGate, buildAgentReviewGateInteraction,                │
│   buildToolGenerationGateInteraction,                           │
│   buildQualityFloorGateInteraction,                             │
│   buildTopologyApprovalGateInteraction]                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Client (/arch/page.tsx + useArchChat)                           │
│                                                                 │
│  UI Stage = f(session.phase, session.buildProgress, topology)   │
│                                                                 │
│  welcome               → no session                             │
│  discover              → INTERVIEW phase                        │
│  build.topology_reveal → BLUEPRINT, topology exists              │
│  build.generating      → BUILD, buildProgress.stage=generating  │
│  build.complete        → BUILD, buildProgress.stage=complete    │
│  create                → CREATE phase                           │
│                                                                 │
│  Proceed CTA = f(resume.nextAction)                             │
│  BuildProgressCard = f(buildProgress.agentStatuses/toolStatuses)│
│  TopologyGraphView buildStatus = f(buildProgress.agentStatuses) │
│                                                                 │
│  [REMOVED: gate_request handler, gate_pending state,            │
│   sendGateResponse, ApprovalGate component]                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Phase Transition Flow

```
                    ┌──────────┐
                    │ INTERVIEW│
                    └─────┬────┘
                          │
           ┌──────────────┼───────────────┐
           │ continue btn  │ proceed_to_   │
           │ (deterministic│ next_phase    │
           │  message)     │ (LLM tool)    │
           └──────┬───────┘└──────┬───────┘
                  │               │
                  ▼               ▼
           ┌──────────────────────────┐
           │ Shared Transition Logic:  │
           │ 1. Check exit criteria    │
           │ 2. Update phase metadata  │
           │ 3. Emit phase_transition  │
           │ 4. Session stays ACTIVE   │
           └────────────┬─────────────┘
                        │
                        ▼
                  ┌───────────┐     Client auto-send:
                  │ BLUEPRINT │ ←── "Continue with the next phase."
                  └─────┬─────┘     (phaseAutoSendRef triggers LLM)
                        │
           ┌────────────┼────────────────┐
           │ continue    │ proceed_to_    │
           └──────┬─────┘ next_phase     │
                  │       └──────┬───────┘
                  ▼              ▼
           ┌──────────────────────────┐
           │ BLUEPRINT→BUILD Transition│
           │ 1. Check topology exists  │
           │ 2. topologyApproved=true  │
           │ 3. diffTopologyAgainst    │
           │    BuildState()           │
           │ 4. Preserve/prune files   │
           │ 5. Phase → BUILD          │
           │ 6. Emit phase_transition  │
           │ All $set with {_id,       │
           │  tenantId, userId} filter │
           └────────────┬─────────────┘
                        │
                        ▼
                  ┌───────────┐     Client auto-send triggers BUILD LLM turn:
                  │   BUILD   │     → generate_agent (all) → compile_abl
                  └─────┬─────┘     → auto tool config gen
                        │           → buildProgress: generating→tools→complete
                        ▼
                  ┌───────────┐
                  │  CREATE   │ ←── { type: 'create' } button
                  └───────────┘     → create_project tool → project saved
```

### 3.4 BUILD Auto-Generation Flow

```
BUILD Phase Entry (LLM Turn 1):
  ┌─────────────────────────────────────────────────────┐
  │ LLM calls generate_agent(AgentA)                     │
  │ LLM calls generate_agent(AgentB)                     │
  │ LLM calls generate_agent(AgentC)                     │
  │ (parallel tool calls in single turn)                 │
  │                                                      │
  │ For each generate_agent:                             │
  │   → Route executes tool → writes metadata.files[name]│
  │   → Emits file_changed SSE                           │
  │   → Calls compile_abl → emits compile_result SSE     │
  │   → Updates buildProgress.agentStatuses[name]        │
  │                                                      │
  │ LLM emits narration text_delta for each agent        │
  └─────────────────────┬───────────────────────────────┘
                        │ All agents compiled
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │ Coordinator: Auto Tool Config Generation             │
  │ (deterministic, no LLM — FR-5.5 option b)           │
  │                                                      │
  │ 1. extractAllTools(files) → tool list                │
  │ 2. For each tool:                                    │
  │    → Generate HTTP config from template              │
  │    → $set metadata.toolDsls[toolName]                │
  │    → $set buildProgress.toolStatuses[toolName]       │
  │    → Emit file_changed SSE for tool config           │
  │ 3. All tools done:                                   │
  │    → $set buildProgress.stage = 'complete'           │
  │    → Emit narration summary text_delta               │
  └─────────────────────────────────────────────────────┘
```

### 3.5 Resume Flow

```
GET /api/arch-ai/sessions/current
  │
  ├── Session state = GATE_PENDING?
  │     → Auto-archive, return null (FR-14.1)
  │
  ├── Build resume snapshot:
  │     phase + buildProgress + topology + files + pendingInteraction
  │
  └── Derive nextAction:
        INTERVIEW + no topology       → continue_phase (discover)
        BLUEPRINT + topology          → continue_phase (topology_reveal)
        BUILD + generating            → continue_phase (keep generating)
        BUILD + tools                 → continue_phase (tool gen in progress)
        BUILD + complete              → create_project
        CREATE                        → create_project
        pendingInteraction (widget)   → answer_widget
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Unchanged. Every `$set`/`updateOne` on `arch_sessions` includes `{ _id, tenantId, userId }` triple-filter. The `proceed_to_next_phase` handler and BLUEPRINT→BUILD shared transition function MUST replicate this pattern from the topology_approval gate handler it replaces. Verified in isolation review (`docs/sdlc-logs/arch-gate-free-build/isolation-api-review.md`). |
| 2   | **Data Access Pattern** | Same pattern: `SessionService` for typed operations, raw `db.collection('arch_sessions').updateOne()` for atomic metadata writes within the route handler. New `buildProgress` writes use the same raw pattern. No new repository layer.                                                                                                                                     |
| 3   | **API Contract**        | `gate_response` removed from `MessageRequestSchema` (breaking for old clients — HTTP 400). No new endpoints. `buildProgress` added to session metadata, visible via `GET /sessions/current` response. `proceed_to_next_phase` is an internal LLM tool, not an API endpoint.                                                                                                  |
| 4   | **Security Surface**    | Auth unchanged (`requireTenantAuth` on all routes). `create_project` remains explicit user action. New governance rules: generated tool configs with side-effecting methods include `confirmation: true`, auth configs never embed secrets, quality auto-fix results surfaced in build summary (FR-15).                                                                      |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                         |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Phase transition with unmet exit criteria: `continue` returns error SSE, `proceed_to_next_phase` returns tool error result to LLM. LLM narrates missing items to user. Compile errors during BUILD: LLM auto-retries (max 2 cycles), errors narrated in chat.                           |
| 6   | **Failure Modes** | LLM timeout during BUILD: `forceArchiveStuck` handles ACTIVE sessions past threshold. Partial generation: `buildProgress.agentStatuses` shows which agents are done, resume offers "Continue generating". Old GATE_PENDING on load: auto-archived + null return (FR-14).                |
| 7   | **Idempotency**   | `continue` is idempotent — calling it twice with same phase doesn't double-transition (exit criteria are re-checked). `proceed_to_next_phase` is idempotent — tool result is deterministic for same session state. `buildProgress` writes use `$set` (not `$inc`), so replays are safe. |
| 8   | **Observability** | Journal entries unchanged — emitted for every generation, compilation, and phase transition. Activity SSE events enhanced with build narration labels. `buildProgress` is queryable in MongoDB for operational dashboards (e.g., "how many sessions are stuck in generating?").         |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Agent generation: ~15-30s for 4-8 agents (unchanged — same LLM calls). Tool config generation: ~1-3s deterministic template (faster than LLM-assisted). Total BUILD: should decrease from ~90-120s (with gate interaction) to ~30-50s (auto-generation). SSE stream throughput unchanged.                                                                                                                 |
| 10  | **Migration Path**     | No MongoDB migration. Old fields (`buildSubPhase`, `approvedAgents`, `selectedTools`) become dead data — DTO mapper stops reading them. `GATE_PENDING` sessions cleaned up on load via `GET /sessions/current` and `POST /message` (FR-14). Keep `GATE_PENDING` in `RESUMABLE_STATES` for one release cycle so cleanup queries find them. Remove after one release.                                       |
| 11  | **Rollback Plan**      | Revert the commit set. Re-add `GATE_PENDING` to state machine. Re-add `gate_response` to schema. Old sessions still have gate-era fields. Only irreversible action: GATE_PENDING session archival on load — but those sessions were stuck anyway and would have been force-archived eventually.                                                                                                           |
| 12  | **Test Strategy**      | 35 FR coverage entries. 7 E2E scenarios against real MongoDB (MongoMemoryServer). 10 integration scenarios covering state machine, buildProgress persistence, phase transitions, schema rejection, resume, mixed intent, IN_PROJECT compat. 7 unit scenarios for types, exit criteria, UI derivation. LLM is the only stubbed dependency. Full spec: `docs/testing/sub-features/arch-gate-free-build.md`. |

---

## 5. Data Model

### New Fields

```typescript
// Added to SessionMetadata (packages/arch-ai/src/types/session.ts)
interface BuildProgress {
  stage: 'generating' | 'tools' | 'complete';
  agentStatuses: Record<string, 'pending' | 'generated' | 'compiled' | 'warning' | 'error'>;
  toolStatuses: Record<string, 'pending' | 'generated' | 'warning' | 'error'>;
}

// On SessionMetadata:
buildProgress?: BuildProgress;  // NEW — replaces buildSubPhase/approvedAgents/selectedTools
```

### Modified Fields

```
SessionMetadata changes:
  REMOVED (dead data, not read):     buildSubPhase, approvedAgents, selectedTools
  REMOVED from PendingInteraction:   PendingGateInteraction (kind: 'gate')
  SIMPLIFIED:                        PendingInteraction = PendingWidgetInteraction

Session state changes:
  REMOVED:                           GATE_PENDING
  VALID:                             IDLE | ACTIVE | COMPLETE | ARCHIVED

Tool types:
  ADDED:                             proceed_to_next_phase
  REMOVED from onboarding gate UX:   topology_approval, agent_review, tool_generation, quality_floor
```

### MongoDB Write Patterns

All `buildProgress` writes are atomic `$set` operations:

```javascript
// After file_changed for agent 'Triage':
db.collection('arch_sessions').updateOne(
  { _id: sessionId, tenantId, userId },
  { $set: { 'metadata.buildProgress.agentStatuses.Triage': 'generated' } },
);

// After compile_result pass:
db.collection('arch_sessions').updateOne(
  { _id: sessionId, tenantId, userId },
  { $set: { 'metadata.buildProgress.agentStatuses.Triage': 'compiled' } },
);

// After deterministic tool config generation:
db.collection('arch_sessions').updateOne(
  { _id: sessionId, tenantId, userId },
  {
    $set: {
      'metadata.toolDsls.get_balance': '<http config>',
      'metadata.buildProgress.toolStatuses.get_balance': 'generated',
    },
  },
);

// All done:
db.collection('arch_sessions').updateOne(
  { _id: sessionId, tenantId, userId },
  { $set: { 'metadata.buildProgress.stage': 'complete' } },
);
```

---

## 6. API Design

### Modified Endpoints

| Method | Path                            | Change                                                                                                                                                      | Auth                |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| POST   | `/api/arch-ai/message`          | Remove gate_response handling. Add proceed_to_next_phase tool handler. Add buildProgress writes. Add auto tool config generation. Remove GateManager usage. | `requireTenantAuth` |
| GET    | `/api/arch-ai/sessions/current` | Add GATE_PENDING cleanup: if session is GATE_PENDING, auto-archive, return null.                                                                            | `requireTenantAuth` |

### Removed API Surface

| Item                         | Where                         | Notes                                      |
| ---------------------------- | ----------------------------- | ------------------------------------------ |
| `gate_response` message type | `MessageRequestSchema`        | Old clients get HTTP 400 at Zod validation |
| `gate_request` SSE event     | Route handler                 | No longer emitted during onboarding        |
| `GateManager` class          | `lib/arch-ai/gate-manager.ts` | File deleted                               |

### New Tool (Internal, Not API)

```typescript
const PROCEED_TO_NEXT_PHASE_TOOL: LLMToolDefinition = {
  name: 'proceed_to_next_phase',
  description: 'Advance to the next onboarding phase when the user confirms readiness.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the user is ready to proceed' },
    },
    required: ['reason'],
  },
};
// Added to PHASE_TOOL_MAP for INTERVIEW, BLUEPRINT, BUILD
```

### Error Responses

| Code | When                                      | Response                                                           |
| ---- | ----------------------------------------- | ------------------------------------------------------------------ |
| 400  | Old client sends `gate_response`          | Zod validation error (schema no longer accepts this type)          |
| 409  | `POST /message` with GATE_PENDING session | `{ error: 'SESSION_STALE', retryable: true }` after auto-archiving |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Journal entries unchanged. Phase transitions, agent generation, compilation, and modification all emit journal entries via `journalAppendAndEmit`. Build narration is chat-only (not journaled).
- **Rate Limiting**: Unchanged. Existing per-user rate limits on `/api/arch-ai/message` apply.
- **Caching**: No caching changes. Sessions are not cached (always fresh from MongoDB).
- **Encryption**: Unchanged. Session metadata encrypted at rest via platform encryption layer.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                          | Type       | Risk                                                                |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| `@agent-platform/arch-ai` types/coordinator/session | Package    | Medium — core type changes                                          |
| Vercel AI SDK `streamText`                          | External   | Low — no change to LLM interface                                    |
| MongoDB `arch_sessions` collection                  | Data store | Low — additive schema change                                        |
| `@abl/compiler` (compile_abl)                       | Package    | None — unchanged                                                    |
| `extractAllTools` from mock-server/tool-extractor   | Package    | Low — existing function, newly relied on for deterministic tool gen |

### Downstream (depends on this feature)

| Consumer                                 | Impact                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `/arch/page.tsx` (onboarding UI)         | Must derive UI stages from phase + buildProgress                    |
| `useArchChat` hook                       | Must remove gate handling, keep widget handling                     |
| `BuildProgressCard`, `TopologyGraphView` | Must read from `buildProgress` instead of `approvedAgents`          |
| IN_PROJECT overlay (`ArchOverlay`)       | Smoke test needed — gate branches removed from shared `useArchChat` |
| Resume snapshot (`buildResumeSnapshot`)  | Must derive from `buildProgress`, not gate-era fields               |

---

## 9. Open Questions & Decisions Needed

1. **Token budget validation**: Can the LLM reliably generate 4-8 agents in a single multi-tool-call turn within `MAX_OUTPUT_TOKENS` (currently 4096)? Need empirical testing before relying on this as a hard requirement. Fallback: multi-turn generation with `buildProgress` tracking partial completion.

2. **Proceed CTA persistence**: Should `resume.nextAction` be computed on-the-fly from `phase + buildProgress` (simpler, but requires computation on every load) or persisted as a field (faster reads, but another field to keep in sync)? Recommendation: compute on-the-fly — it's a pure function of existing state.

3. **`RESUMABLE_STATES` timeline**: How long to keep `GATE_PENDING` in `RESUMABLE_STATES` before the full cleanup release? Recommendation: one release cycle (~2 weeks), then remove.

---

## 10. References

- Feature spec: `docs/features/sub-features/arch-gate-free-build.md`
- Test spec: `docs/testing/sub-features/arch-gate-free-build.md`
- Parent HLD: `docs/specs/arch-ai-v03.hld.md`
- Codex review: `docs/arch/reviews/2026-04-10-codex-gate-less-build-review.md`
- Deep review: `docs/sdlc-logs/arch-gate-free-build/deep-review.md`
- Isolation review: `docs/sdlc-logs/arch-gate-free-build/isolation-api-review.md`
- Session state machine: `packages/arch-ai/src/coordinator/session-state-machine.ts`
- Message route: `apps/studio/src/app/api/arch-ai/message/route.ts`
- Arch page: `apps/studio/src/app/arch/page.tsx`
- useArchChat: `apps/studio/src/hooks/useArchChat.ts`
