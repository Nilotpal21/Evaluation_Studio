# Test Specification: Arch Conversational Flow — Gate-Free Onboarding

**Feature Spec**: `docs/features/sub-features/arch-gate-free-build.md`
**HLD**: N/A (sub-feature of Arch AI Assistant)
**LLD**: N/A (pending)
**Status**: PLANNED
**Last Updated**: 2026-04-10

---

## 1. Coverage Matrix

| FR      | Description                                                                       | Unit     | Integration | E2E      | Manual | Status     |
| ------- | --------------------------------------------------------------------------------- | -------- | ----------- | -------- | ------ | ---------- |
| FR-1.1  | No `gate_request` SSE in any onboarding phase                                     | -        | Required    | Required | -      | NOT TESTED |
| FR-1.2  | `GATE_PENDING` removed from state machine                                         | Required | Required    | -        | -      | NOT TESTED |
| FR-1.3  | `PendingGateInteraction` removed, `PendingInteraction = PendingWidgetInteraction` | Required | -           | -        | -      | NOT TESTED |
| FR-1.4  | `gate_response` removed from `MessageRequestSchema`                               | Required | Required    | -        | -      | NOT TESTED |
| FR-1.5  | `GateManager` deleted                                                             | Required | -           | -        | -      | NOT TESTED |
| FR-1.6  | Gate rendering removed from `useArchChat`, `ApprovalGate` deleted                 | -        | -           | -        | Manual | NOT TESTED |
| FR-2.1  | Widget `pendingInteraction` preserved, session stays `ACTIVE`                     | Required | Required    | -        | -      | NOT TESTED |
| FR-2.2  | Freeform text bypasses pending widget                                             | -        | Required    | Required | -      | NOT TESTED |
| FR-3.1  | `buildProgress` persisted with stage + agentStatuses + toolStatuses               | Required | Required    | -        | -      | NOT TESTED |
| FR-3.2  | `buildProgress` updated atomically on `file_changed` / `compile_result`           | -        | Required    | -        | -      | NOT TESTED |
| FR-3.3  | Resume derives UI stage from `buildProgress`                                      | Required | -           | -        | -      | NOT TESTED |
| FR-4.1  | `continue` button triggers deterministic phase transition                         | -        | Required    | Required | -      | NOT TESTED |
| FR-4.2  | `proceed_to_next_phase` tool handles typed NL intent                              | -        | Required    | Required | -      | NOT TESTED |
| FR-4.4  | Shared transition logic between `continue` and `proceed_to_next_phase`            | -        | Required    | -        | -      | NOT TESTED |
| FR-4.5  | BLUEPRINT→BUILD sets `topologyApproved`, runs diff, prunes files                  | -        | Required    | -        | -      | NOT TESTED |
| FR-4.6  | Exit criteria not met → error returned to LLM / client                            | Required | Required    | -        | -      | NOT TESTED |
| FR-5.1  | All agents generated in single multi-tool turn                                    | -        | Required    | -        | -      | NOT TESTED |
| FR-5.2  | Tool config auto-generation as second BUILD stage                                 | -        | Required    | -        | -      | NOT TESTED |
| FR-5.5  | `toolDsls` write path (deterministic template generation)                         | -        | Required    | -        | -      | NOT TESTED |
| FR-6.1  | Chat narration per agent (name, mode, tools, quality)                             | -        | Required    | -        | Manual | NOT TESTED |
| FR-7.1  | Conversational modification updates specific agent only                           | -        | -           | Required | -      | NOT TESTED |
| FR-8.1  | UI derives 4 stages from backend phase + `buildProgress`                          | Required | -           | -        | -      | NOT TESTED |
| FR-9.1  | Template picker pre-fills specification                                           | Required | -           | Required | -      | NOT TESTED |
| FR-10.3 | `TopologyGraphView` renders `buildStatus` from `buildProgress.agentStatuses`      | Required | -           | -        | Manual | NOT TESTED |
| FR-11.1 | Two-column `BuildProgressCard` from `buildProgress`                               | Required | -           | -        | Manual | NOT TESTED |
| FR-12.1 | "Create Project" appears when `buildProgress.stage === 'complete'`                | Required | -           | Required | -      | NOT TESTED |
| FR-13.1 | Resume restores chat, artifacts, and correct UI stage                             | -        | Required    | -        | -      | NOT TESTED |
| FR-13.2 | Proceed CTA from `resume.nextAction`, not ephemeral suggestions                   | Required | Required    | -        | -      | NOT TESTED |
| FR-13.4 | Mid-BUILD partial files → "Continue generating" from `buildProgress`              | -        | Required    | -        | -      | NOT TESTED |
| FR-13.5 | Mid-BLUEPRINT with topology → topology_reveal sub-stage                           | -        | Required    | -        | -      | NOT TESTED |
| FR-14.1 | Old `GATE_PENDING` session archived on `GET /sessions/current`                    | -        | Required    | Required | -      | NOT TESTED |
| FR-14.2 | Old `GATE_PENDING` session on `POST /message` → HTTP 409                          | -        | Required    | -        | -      | NOT TESTED |
| FR-15.2 | Side-effecting tool configs include `confirmation: true`                          | Required | -           | -        | -      | NOT TESTED |
| FR-15.5 | Invalid tools don't silently mark BUILD complete                                  | -        | Required    | -        | -      | NOT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through HTTP route handlers with a real MongoDB instance (MongoMemoryServer). No mocks of codebase components. LLM responses are the only external dependency and are stubbed via a test `LLMStreamClient`.

### E2E-1: Full Onboarding Flow — No Gates

- **Preconditions**: Fresh tenant + user via dev-login. No existing session.
- **Steps**:

  ```
  NOTE: The route ends each `continue` after phase_transition + done.
  The next-phase LLM turn is triggered by a follow-up message.

  1. POST /api/arch-ai/sessions → 200, session phase=INTERVIEW
  2. POST /api/arch-ai/message { type: 'message', text: 'Build a healthcare claims system' }
     → SSE: specialist, text_delta, tool_call (ask_user/update_specification), done
     → Assert: NO gate_request in stream
  3. POST /api/arch-ai/message { type: 'tool_answer', toolCallId: '<id>', answer: 'Claims Pro' }
     → SSE: text_delta (confirming name), update_specification tool_call, done
  4. POST /api/arch-ai/message { type: 'continue' }
     → SSE: phase_transition INTERVIEW→BLUEPRINT, done
  5. POST /api/arch-ai/message { type: 'message', text: 'Continue with the next phase.' }
     → SSE: specialist, generate_topology tool_call, topology data, text_delta (narration)
     → Assert: NO topology_approval gate_request
  6. POST /api/arch-ai/message { type: 'continue' }
     → SSE: phase_transition BLUEPRINT→BUILD, done
     → Assert: session.metadata.topologyApproved === true
  7. POST /api/arch-ai/message { type: 'message', text: 'Continue with the next phase.' }
     → SSE: specialist, activity (generating...), file_changed (per agent),
       compile_result (per agent), text_delta (narration), done
     → Assert: NO agent_review/tool_generation/quality_floor gate_request
     → Assert: session.metadata.buildProgress.stage reached 'complete'
  8. POST /api/arch-ai/message { type: 'create' }
     → SSE: phase_transition BUILD→CREATE, tool_result with projectId
     → Assert: session.state === 'COMPLETE'
  ```

- **Expected Result**: Full onboarding completes with ZERO `gate_request` SSE events.
- **Auth Context**: Tenant A, User 1.
- **Isolation Check**: N/A (single-user flow).

### E2E-2: Typed Natural-Language Proceed

- **Preconditions**: Session in INTERVIEW with `projectName` filled (exit criteria met).
- **Steps**:
  ```
  1. POST /api/arch-ai/message { type: 'message', text: 'Looks good, design the topology' }
     → SSE stream: LLM calls proceed_to_next_phase tool
     → SSE: phase_transition INTERVIEW→BLUEPRINT
  2. POST /api/arch-ai/message { type: 'message', text: 'Continue with the next phase.' }
     → SSE: LLM calls generate_topology
     → Assert: topology SSE events, NO gate_request
  ```
- **Expected Result**: LLM detects proceed intent, calls tool, phase transitions.
- **Auth Context**: Tenant A, User 1.

### E2E-3: Conversational Modification After BUILD

- **Preconditions**: Session in BUILD with all agents generated (`buildProgress.stage = 'complete'`).
- **Steps**:
  ```
  1. POST /api/arch-ai/message { type: 'message', text: 'Make the billing agent use scripted mode' }
     → SSE: file_changed for billing agent (updated content)
     → SSE: compile_result for billing agent
     → SSE: text_delta (narration of what changed)
     → Assert: NO gate_request events
     → Assert: buildProgress.agentStatuses['Billing'] updated
  ```
- **Expected Result**: Only the requested agent is modified. Other agents untouched.
- **Auth Context**: Tenant A, User 1.

### E2E-4: Session Resume Mid-BUILD

- **Preconditions**: Session in BUILD with 2 of 4 agents generated. Browser closed.
- **Steps**:
  ```
  1. GET /api/arch-ai/sessions/current?mode=ONBOARDING
     → 200, session phase=BUILD
     → Assert: resume.artifacts includes buildProgress with 2 compiled, 2 pending
     → Assert: resume.nextAction.type === 'continue_phase'
     → Assert: NO approvedAgents or buildSubPhase in response
  2. POST /api/arch-ai/message { type: 'continue' }
     → LLM generates remaining 2 agents
     → SSE: file_changed + compile_result for each
     → Assert: buildProgress.stage reaches 'complete'
  ```
- **Expected Result**: Resume correctly detects partial build, generates remaining agents.
- **Auth Context**: Tenant A, User 1.

### E2E-5: Old GATE_PENDING Session Cleanup on Load

- **Preconditions**: Old session in DB with `state: 'GATE_PENDING'`, `phase: 'BUILD'`, `metadata.approvedAgents: ['AgentA']`, `metadata.buildSubPhase: 'AGENTS'`.
- **Steps**:
  ```
  1. GET /api/arch-ai/sessions/current?mode=ONBOARDING
     → Assert: old session is archived (state changed to 'ARCHIVED')
     → Assert: response has no active session (null or empty)
  2. POST /api/arch-ai/sessions (create fresh)
     → 200, new session with phase=INTERVIEW
     → Assert: no stale gate artifacts in new session
  ```
- **Expected Result**: Stale session auto-archived. User gets fresh start.
- **Auth Context**: Tenant A, User 1 (same as old session).

### E2E-6: Cross-Tenant Isolation

- **Preconditions**: Tenant A, User 1 has an active BUILD session.
- **Steps**:
  ```
  1. GET /api/arch-ai/sessions/current?mode=ONBOARDING (as Tenant B, User 2)
     → Assert: no session returned (null)
  2. POST /api/arch-ai/message { sessionId: '<tenant-A-session-id>', type: 'message', text: 'hi' }
     (as Tenant B, User 2)
     → Assert: 404 (session not found, not 403)
  ```
- **Expected Result**: Cross-tenant access returns 404.
- **Auth Context**: Tenant B, User 2 (different from session owner).

### E2E-7: Widget Freeform Bypass

- **Preconditions**: Session in INTERVIEW, LLM has called `ask_user` with a MultiSelect widget. Session is `ACTIVE` with `pendingInteraction: { kind: 'widget' }`.
- **Steps**:
  ```
  1. POST /api/arch-ai/message { type: 'message', text: 'web and voice channels' }
     (sends freeform text instead of tool_answer)
     → Assert: pendingInteraction cleared (null)
     → SSE: LLM processes the text, calls update_specification
     → Assert: session stays ACTIVE during processing, then IDLE
  ```
- **Expected Result**: Widget bypassed, text processed as normal message.
- **Auth Context**: Tenant A, User 1.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: GATE_PENDING Removed from State Machine

- **Boundary**: `session-state-machine.ts` pure functions
- **Setup**: Import `validateStateTransition`, `SESSION_STATES`, `RESUMABLE_STATES`
- **Steps**:
  ```
  1. Assert 'GATE_PENDING' is NOT in SESSION_STATES
  2. Assert validateStateTransition('ACTIVE', 'GATE_PENDING') throws InvalidTransitionError
  3. Assert validateStateTransition('GATE_PENDING', 'ACTIVE') throws InvalidTransitionError
  4. Assert 'GATE_PENDING' IS in RESUMABLE_STATES (transitional compat, one release)
  5. Assert valid transitions still work: IDLE→ACTIVE, ACTIVE→IDLE, ACTIVE→COMPLETE, etc.
  ```
- **Expected Result**: State machine has no GATE_PENDING transitions. RESUMABLE_STATES keeps it for cleanup.

### INT-2: buildProgress Persistence via Route Handler

- **Boundary**: Message route → SessionService → MongoDB
- **Setup**: Session in BUILD phase with topology of 3 agents. MongoMemoryServer.
- **Steps**:
  ```
  1. Simulate file_changed SSE for agent 'Triage'
     → Assert: metadata.buildProgress.agentStatuses['Triage'] === 'generated'
  2. Simulate compile_result pass for 'Triage'
     → Assert: metadata.buildProgress.agentStatuses['Triage'] === 'compiled'
  3. Repeat for all 3 agents
     → Assert: metadata.buildProgress.stage === 'tools' (auto-triggered)
  4. Simulate tool config generation for 2 tools
     → Assert: metadata.buildProgress.toolStatuses populated
     → Assert: metadata.toolDsls has entries (FR-5.5 write path)
  5. All tools complete
     → Assert: metadata.buildProgress.stage === 'complete'
  ```
- **Expected Result**: `buildProgress` atomically tracks every generation step.

### INT-3: BLUEPRINT→BUILD Transition (continue handler)

- **Boundary**: Message route `continue` handler → SessionService → MongoDB
- **Setup**: Session in BLUEPRINT with topology generated. Existing files from a prior build attempt.
- **Steps**:
  ```
  1. POST message { type: 'continue' } for BLUEPRINT session
  2. Assert: metadata.topologyApproved set to true
  3. Assert: diffTopologyAgainstBuildState called with old files
  4. Assert: preserved files kept, removed agents pruned
  5. Assert: phase_transition SSE emitted (BLUEPRINT→BUILD)
  6. Assert: session phase is now BUILD
  7. Assert: NO gate_request SSE event in stream
  ```
- **Expected Result**: Atomic transition with topology diff, same work as old gate handler.

### INT-4: proceed_to_next_phase Tool — All Transitions

- **Boundary**: Message route tool handler → phase machine → SessionService
- **Steps**:

  ```
  Test A: INTERVIEW → BLUEPRINT
    Setup: session with projectName filled
    Action: LLM calls proceed_to_next_phase({ reason: 'user ready' })
    Assert: phase transitions to BLUEPRINT
    Assert: phase_transition SSE emitted

  Test B: BLUEPRINT → BUILD
    Setup: session with topology
    Action: LLM calls proceed_to_next_phase({ reason: 'user approved topology' })
    Assert: topologyApproved set, diff runs, phase transitions to BUILD

  Test C: BUILD → CREATE
    Setup: session with all files and buildProgress.stage === 'complete'
    Action: LLM calls proceed_to_next_phase({ reason: 'user ready to create' })
    Assert: phase transitions to CREATE

  Test D: Exit criteria NOT met
    Setup: session in INTERVIEW with empty projectName
    Action: LLM calls proceed_to_next_phase
    Assert: tool returns error result "projectName required"
    Assert: NO phase transition
  ```

### INT-5: gate_response Rejected by Schema

- **Boundary**: `MessageRequestSchema` Zod validation
- **Setup**: Valid session ID.
- **Steps**:
  ```
  1. Parse { type: 'gate_response', sessionId: 'xxx', gateId: 'g1', action: 'accept' }
     via MessageRequestSchema.safeParse()
  2. Assert: result.success === false
  3. Assert: error mentions unrecognized discriminator or invalid type
  ```
- **Expected Result**: `gate_response` is no longer a valid message type.

### INT-6: Resume Snapshot Derives from buildProgress

- **Boundary**: `buildResumeSnapshot()` pure function
- **Steps**:

  ```
  Test A: Mid-generating
    Input: phase=BUILD, buildProgress={ stage: 'generating', agentStatuses: { A: 'compiled', B: 'pending' } }
    Assert: nextAction.type === 'continue_phase'
    Assert: artifacts include buildProgress with correct statuses

  Test B: Tools stage
    Input: phase=BUILD, buildProgress={ stage: 'tools', agentStatuses: all compiled, toolStatuses: { t1: 'pending' } }
    Assert: nextAction.type === 'continue_phase'

  Test C: Complete
    Input: phase=BUILD, buildProgress={ stage: 'complete' }
    Assert: nextAction.type === 'create_project'

  Test D: BLUEPRINT with topology
    Input: phase=BLUEPRINT, topology exists, topologyApproved=false
    Assert: nextAction.type === 'continue_phase' (show topology_reveal)

  Test E: No buildProgress or approvedAgents
    Input: phase=BUILD, no buildProgress, no approvedAgents
    Assert: does not crash, returns sensible default
  ```

### INT-7: GATE_PENDING Cleanup on GET /sessions/current

- **Boundary**: Sessions current route → SessionService → MongoDB
- **Setup**: Insert session with `state: 'GATE_PENDING'` directly into MongoMemoryServer.
- **Steps**:
  ```
  1. GET /api/arch-ai/sessions/current?mode=ONBOARDING
  2. Assert: response has no active session (null / empty)
  3. Query DB directly: old session state === 'ARCHIVED'
  ```

### INT-8: Mixed Intent — Change Without Proceeding

- **Boundary**: LLM behavior (requires LLM stub that returns specific tool calls)
- **Setup**: Session in BLUEPRINT with topology generated.
- **Steps**:
  ```
  1. POST message { type: 'message', text: 'Looks good, but add a fraud detection agent first' }
  2. Assert: LLM does NOT call proceed_to_next_phase
  3. Assert: LLM calls generate_topology (to add the new agent)
  4. Assert: phase remains BLUEPRINT (not transitioned to BUILD)
  ```
- **Expected Result**: LLM handles the change request, does not advance phase.

### INT-9: useArchChat Shared Behavior — IN_PROJECT After Gate Removal

- **Boundary**: `useArchChat` hook, IN_PROJECT mode
- **Setup**: Existing project with IN_PROJECT session. `proposal_response` flow.
- **Steps**:
  ```
  1. Load IN_PROJECT session
  2. Send a modification message → LLM calls propose_modification → pendingMutation stored
  3. Send proposal_response { action: 'accept' }
  4. Assert: proposal applied, modification committed
  5. Assert: no regression from gate_request handler removal
  ```
- **Expected Result**: IN_PROJECT overlay is unaffected by onboarding gate removal.

### INT-10: toolDsls Write Path Verification

- **Boundary**: Route handler → MongoDB `$set` on `metadata.toolDsls`
- **Setup**: Session in BUILD with all agents compiled. `buildProgress.stage = 'tools'`.
- **Steps**:
  ```
  1. Coordinator triggers tool config generation (deterministic template, FR-5.5)
  2. For each tool (e.g., get_balance, submit_claim):
     → Assert: metadata.toolDsls['get_balance'] written with HTTP config content
     → Assert: buildProgress.toolStatuses['get_balance'] === 'generated'
  3. All tools complete
     → Assert: buildProgress.stage === 'complete'
     → Assert: metadata.toolDsls has entry for every extracted tool
  ```
- **Expected Result**: `toolDsls` is populated by the deterministic generator.

---

## 4. Unit Test Scenarios

### UT-1: BuildProgress Type Validation

- **Module**: `packages/arch-ai/src/types/session.ts`
- **Input**: Various `BuildProgress` shapes (valid, missing fields, extra fields)
- **Expected Output**: Type-level correctness. Stage must be one of `generating | tools | complete`.

### UT-2: Simplified BUILD Exit Criteria

- **Module**: `packages/arch-ai/src/coordinator/phase-machine.ts`
- **Input A**: Topology with agents `['A', 'B']`, files `{ A: {...} }` → false (B missing)
- **Input B**: Files `{ A: {...}, B: {...} }` → true (all present)
- **Input C**: Empty topology → false

### UT-3: PendingInteraction Type Narrowing

- **Module**: `packages/arch-ai/src/types/session.ts`
- **Input**: `PendingInteraction` should only accept `{ kind: 'widget', ... }`. `{ kind: 'gate', ... }` should be a TypeScript error.

### UT-4: proceed_to_next_phase Tool Definition

- **Module**: `packages/arch-ai/src/tools/definitions.ts`
- **Input**: Tool schema must have `name: 'proceed_to_next_phase'`, `input_schema` with `reason: string` required.

### UT-5: UI Stage Derivation from Phase + buildProgress

- **Module**: Client-side helper (new, in `/arch/page.tsx` or extracted)
- **Cases**:
  - `phase=INTERVIEW, no topology` → `discover`
  - `phase=BLUEPRINT, topology exists, topologyApproved=false` → `build.topology_reveal`
  - `phase=BUILD, buildProgress.stage='generating'` → `build.generating`
  - `phase=BUILD, buildProgress.stage='complete'` → `build.complete`
  - `phase=CREATE` → `create`

### UT-6: BuildProgressCard Renders Two Columns

- **Module**: `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`
- **Input**: `buildProgress` with 3 agents + 4 tools
- **Expected**: Two columns rendered. Status icons match `agentStatuses` / `toolStatuses`.

### UT-7: TopologyGraphView Accepts buildStatus Prop

- **Module**: `apps/studio/src/components/arch-v3/panels/TopologyGraphView.tsx`
- **Input**: Topology data + `buildStatus: { 'Triage': 'compiled', 'Billing': 'generating' }`
- **Expected**: Triage node has success border. Billing node has accent animated border.

---

## 5. Security & Isolation Tests

- [x] Cross-tenant access returns 404 (E2E-6)
- [ ] Cross-user access returns 404 — user B in same tenant cannot access user A's session
- [x] Missing auth returns 401 — request without `Authorization` header
- [ ] `proceed_to_next_phase` tool handler uses `{ _id, tenantId, userId }` triple-filter on all `updateOne` calls
- [x] `gate_response` rejected by schema validation (INT-5) — old clients get HTTP 400
- [ ] Generated tool configs never embed secrets (FR-15.3) — inspect generated `toolDsls` for auth tokens
- [ ] Side-effecting tool configs (POST, PUT, DELETE) include `confirmation: true` (FR-15.2)

---

## 6. Performance & Load Tests

Deferred to follow-up. Key scenarios when ready:

- **Token budget**: Can the LLM generate 4-8 agents in a single multi-tool-call turn within `MAX_OUTPUT_TOKENS`?
- **Generation latency**: Measure wall time for full BUILD (topology → agents → tools → complete) with 4, 6, 8 agents.
- **SSE stream throughput**: Verify no event drops under rapid file_changed + compile_result emissions (8+ events in <5s).

---

## 7. Test Infrastructure

- **Required services**: MongoMemoryServer (v7.0.20), Node.js runtime
- **LLM stub**: Test `LLMStreamClient` implementation that returns deterministic tool calls (generate_topology, generate_agent, compile_abl, proceed_to_next_phase) without actual LLM API calls
- **Auth**: Dev-login route (`/api/dev-login`) for test tenant/user tokens
- **Data seeding**: Old `GATE_PENDING` sessions inserted directly via `mongoose.connection.db.collection('arch_sessions').insertOne()`
- **Environment variables**:
  ```
  MONGODB_URL=<memory-server-uri>
  MONGODB_DATABASE=arch_ai_e2e
  MONGODB_MANAGED=true
  ENABLE_DEV_LOGIN=true
  JWT_SECRET=arch-e2e-jwt-secret-0123456789-long-enough
  NEXTAUTH_SECRET=arch-e2e-nextauth-secret-0123456789
  ENCRYPTION_ENABLED=true
  ENCRYPTION_MASTER_KEY=<64-hex-chars>
  ```
- **CI**: Same as existing arch-ai E2E tests (`pnpm test --filter=studio -- --testPathPattern=e2e/arch-ai`)

---

## 8. Test File Mapping

| Test File                                                                  | Type | Covers                                           |
| -------------------------------------------------------------------------- | ---- | ------------------------------------------------ |
| `packages/arch-ai/src/__tests__/session-state-machine.test.ts`             | unit | FR-1.2 (rewrite — remove GATE_PENDING cases)     |
| `packages/arch-ai/src/__tests__/phase-machine.test.ts`                     | unit | UT-2 (rewrite — simplified BUILD exit criteria)  |
| `packages/arch-ai/src/__tests__/message-request.test.ts`                   | unit | INT-5 (add — gate_response schema rejection)     |
| `packages/arch-ai/src/__tests__/resume-snapshot.test.ts`                   | unit | INT-6 (rewrite — buildProgress-based derivation) |
| `packages/arch-ai/src/__tests__/build-gate-queue.test.ts`                  | unit | DEPRECATE — gate queue removed                   |
| `packages/arch-ai/src/__tests__/build-exit-criteria-subphase.test.ts`      | unit | DEPRECATE — buildSubPhase removed                |
| `packages/arch-ai/src/__tests__/tool-definitions.test.ts`                  | unit | UT-4 (add — proceed_to_next_phase tool)          |
| `apps/studio/src/__tests__/e2e/arch-ai-gate-free-onboarding.e2e.test.ts`   | e2e  | E2E-1 through E2E-7 (NEW)                        |
| `apps/studio/src/__tests__/arch-ai/arch-ai-build-progress.test.ts`         | unit | UT-1, UT-5, UT-6 (NEW)                           |
| `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts` | e2e  | INT-9 (verify no regression)                     |

---

## 9. Open Testing Questions

1. **LLM stub fidelity**: How closely should the test LLM stub mirror real multi-tool-call behavior? Should it return multiple `generate_agent` tool calls in one turn, or is sequential sufficient for correctness testing?
2. **SSE parsing in tests**: The existing `callRouteRaw` helper returns a raw `Response`. Should we add an SSE parser utility for asserting specific event sequences, or assert on the full body text?
3. **buildProgress write atomicity**: Should we test for race conditions where two concurrent `file_changed` events try to update `buildProgress` simultaneously? (Likely low risk since SSE events arrive sequentially within a single request.)
4. **Old session seeding**: For E2E-5, should we also seed sessions with `state: 'GATE_PENDING'` + `pendingInteraction: { kind: 'gate' }` to verify the full old-format cleanup?
