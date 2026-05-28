# Test Specification: Arch Agent Architecture Planner

**Feature Spec**: `docs/features/arch-agent-architecture-planner.md`
**HLD**: `docs/specs/arch-agent-architecture-planner.hld.md`
**LLD**: `docs/superpowers/plans/2026-04-16-arch-agent-architecture-planner.md`
**Status**: PARTIAL (unit coverage complete; integration + E2E coverage outstanding)
**Last Updated**: 2026-04-16
**Implementation**: Landed on `arch/promptrefine` under ABLP-162 (commits `aae8e9176`, `f2e48bdcf`, `72e01be01`).

---

## 1. Coverage Matrix

| FR    | Description                                            | Unit | Integration | E2E | Manual | Status     |
| ----- | ------------------------------------------------------ | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Compute plan for every topology agent                  | ✅   | ✅          | ✅  | ❌     | PARTIAL    |
| FR-2  | GATHER required for delegate targets with RETURN: true | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-3  | COMPLETE required for return-contract agents           | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-4  | SUPERVISOR keyword for entry-point with routing edges  | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-5  | Valid HANDOFF targets excluding self-handoffs          | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-6  | needsCatchAll only for supervisor archetype            | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-7  | Self-handoff detection                                 | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-8  | Circular handoff detection via DFS                     | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-9  | Orphan agent detection via BFS                         | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-10 | Plan rendered in prompt when present                   | ✅   | ✅          | ✅  | ❌     | NOT TESTED |
| FR-11 | Old sections guarded behind !plan                      | ✅   | ✅          | ❌  | ❌     | NOT TESTED |
| FR-12 | Planner completes in <100ms                            | ✅   | ❌          | ❌  | ❌     | TESTED     |
| FR-13 | In-project isNew gets planner hints                    | ❌   | ✅          | ✅  | ❌     | NOT TESTED |

Legend:

- **TESTED** — covered by existing test suite
- **PARTIAL** — unit coverage done; integration/E2E outstanding
- **NOT TESTED** — no automated coverage yet (follow-up required)

---

## 2. E2E Test Scenarios (MANDATORY)

These scenarios exercise the planner through the actual BUILD pipeline — from topology input through agent generation output. Since the planner is pure functions called inside `runParallelGeneration()`, E2E coverage means testing the full generation flow and verifying the planner's output manifests in generated agent DSL.

> Note: The planner itself has no HTTP API. E2E scenarios test it through the Arch AI message API (`POST /api/arch-ai/message`) which triggers BUILD generation.

### E2E-1: Triage topology generates correct GATHER/COMPLETE on delegates

- **Preconditions**: Arch session in BUILD phase with topology: Triage (entry, supervisor) → Billing (delegate, RETURN: true) → Support (delegate, RETURN: true) → Escalation (escalate)
- **Steps**:
  1. `POST /api/arch-ai/message` with session in BUILD phase, topology approved
  2. Wait for `build_reconciled` SSE event
  3. Read generated agent files from session metadata
  4. Parse Billing agent DSL
  5. Parse Escalation agent DSL
- **Expected Result**:
  - Billing agent DSL contains `GATHER:` section with at least one field
  - Billing agent DSL contains `COMPLETE:` section with at least one condition
  - Escalation agent DSL does NOT contain `GATHER:` (escalation target, no return expected)
  - Triage agent DSL uses `SUPERVISOR:` keyword (not `AGENT:`)
- **Auth Context**: Valid tenant + user with Arch session access
- **Isolation Check**: Session scoped to `tenantId` + `userId`

### E2E-2: Self-handoff topology is blocked before generation

- **Preconditions**: Arch session in BUILD phase with topology containing edge: A → A (self-loop)
- **Steps**:
  1. `POST /api/arch-ai/message` to trigger BUILD
  2. Wait for `build_agent_error` or `build_reconciled` SSE event
  3. Inspect the generated agent A's HANDOFF targets
- **Expected Result**:
  - Agent A's HANDOFF section does NOT contain `TO: A`
  - The planner's blocked pattern is logged (observable via build logs)
- **Auth Context**: Valid tenant + user
- **Isolation Check**: Session scoped to `tenantId` + `userId`

### E2E-3: Orphan agent reported in build reconciliation

- **Preconditions**: Arch session with topology: Entry → Connected, plus OrphanAgent with no incoming edges
- **Steps**:
  1. `POST /api/arch-ai/message` to trigger BUILD
  2. Wait for `build_reconciled` SSE event
  3. Inspect reconciliation output for OrphanAgent status
- **Expected Result**:
  - OrphanAgent appears in `build_reconciled` event
  - OrphanAgent either gets error status or warning about unreachability
- **Auth Context**: Valid tenant + user
- **Isolation Check**: Session scoped to `tenantId` + `userId`

### E2E-4: Pipeline topology produces GATHER + COMPLETE on middle stages

- **Preconditions**: Arch session with pipeline topology: Intake → Processor (delegate, RETURN: true) → Reviewer (delegate, RETURN: true)
- **Steps**:
  1. `POST /api/arch-ai/message` to trigger BUILD
  2. Wait for `build_reconciled` SSE event
  3. Read Processor agent DSL from session
- **Expected Result**:
  - Processor agent has `GATHER:` section (delegate target with return)
  - Processor agent has `COMPLETE:` section
  - Intake agent uses `SUPERVISOR:` or `AGENT:` keyword depending on entry-point
- **Auth Context**: Valid tenant + user
- **Isolation Check**: Session scoped to `tenantId` + `userId`

### E2E-5: Single-agent topology generates cleanly without HANDOFF

- **Preconditions**: Arch session with topology: single MainAgent, 0 edges
- **Steps**:
  1. `POST /api/arch-ai/message` to trigger BUILD
  2. Wait for `build_reconciled` SSE event
  3. Read MainAgent DSL from session
- **Expected Result**:
  - MainAgent uses `AGENT:` keyword (not `SUPERVISOR:`)
  - MainAgent DSL does NOT contain `HANDOFF:` section (no outgoing edges)
  - Build completes without errors
- **Auth Context**: Valid tenant + user
- **Isolation Check**: Session scoped to `tenantId` + `userId`

### E2E-6: In-project new agent creation receives planner hints

- **Preconditions**: Existing project with 3 agents (Triage → Billing, Support). User in IN_PROJECT mode.
- **Steps**:
  1. `POST /api/arch-ai/message` in IN_PROJECT mode with message "Add a new agent called RefundAgent that handles refund requests"
  2. Wait for LLM to call `propose_modification` with `isNew: true`
  3. Inspect the proposed agent DSL
- **Expected Result**:
  - Proposed agent has structurally sound DSL (GUARDRAILS, MEMORY present)
  - Planner hints were computed (observable via logs: "Architecture planner provided hints")
- **Auth Context**: Valid tenant + user with project access
- **Isolation Check**: Project scoped to `tenantId` + `projectId`

---

## 3. Integration Test Scenarios (MANDATORY)

These test the boundaries between the planner module and its consumers.

### INT-1: computeArchitecturePlans → buildAgentSystemPrompt integration

- **Boundary**: `packages/arch-ai` planning module → `apps/studio` prompt builder
- **Setup**: Construct a triage topology with 4 agents (Triage, Billing, Support, Escalation)
- **Steps**:
  1. Call `computeArchitecturePlans(topology)` to get plans
  2. Construct `AgentGenerationContext` with plan for Billing agent
  3. Call `buildAgentSystemPrompt(context)`
  4. Assert prompt structure
- **Expected Result**:
  - Prompt contains `## Architecture Plan`
  - Prompt contains `### GATHER: REQUIRED`
  - Prompt contains `### COMPLETE: REQUIRED`
  - Prompt does NOT contain `## Return-Path Contract` (guarded by !plan)
  - Prompt does NOT contain `## Entry-Point Routing` (not entry agent)
- **Failure Mode**: If plan types don't match context types → TypeScript build error

### INT-2: computeArchitecturePlans → SharedBuildContext integration

- **Boundary**: `packages/arch-ai` planning module → `apps/studio` build pipeline
- **Setup**: Construct topology matching `build-parallel-gen.ts` TopologyAgent/TopologyEdge shapes
- **Steps**:
  1. Coerce topology edges using `coerceEdgeType()` helper
  2. Call `computeArchitecturePlans()` with coerced topology
  3. Verify plan is stored in SharedBuildContext
  4. Verify each agent worker receives its plan via `genContext.plan`
- **Expected Result**:
  - `sharedContext.architecturePlans.size` equals agent count
  - Each plan has `agentName`, `archetype`, `keyword` populated
  - Plans survive passage through the worker context
- **Failure Mode**: Edge type coercion fails → planner receives invalid types

### INT-3: Planner with edge type coercion (unknown types)

- **Boundary**: Session metadata (string types) → planner (strict union types)
- **Setup**: Topology edges with types: `'delegate'`, `'escalate'`, `'handoff'` (invalid), `undefined`
- **Steps**:
  1. Apply `coerceEdgeType()` to each edge type
  2. Pass coerced edges to `computeArchitecturePlans()`
- **Expected Result**:
  - `'delegate'` → `'delegate'` (pass-through)
  - `'escalate'` → `'escalate'` (pass-through)
  - `'handoff'` → `'delegate'` (unknown → default)
  - `undefined` → `'delegate'` (missing → default)
  - Planner produces valid plans without throwing
- **Failure Mode**: Unknown type passed through → planner type error

### INT-4: Planner output backward compatibility (no plan → old sections)

- **Boundary**: Prompt builder with/without plan
- **Setup**: Same `AgentGenerationContext` — one call with `plan`, one without
- **Steps**:
  1. Call `buildAgentSystemPrompt(contextWithPlan)` — assert Architecture Plan present
  2. Call `buildAgentSystemPrompt(contextWithoutPlan)` — assert old sections present
- **Expected Result**:
  - With plan: `## Architecture Plan` present, `## Return-Path Contract` absent
  - Without plan: `## Return-Path Contract` present, `## Architecture Plan` absent
  - Both produce valid, non-empty prompt strings
- **Failure Mode**: Guard logic inverted → both sections appear or both absent

### INT-5: Planner handles all 5 topology patterns

- **Boundary**: Planner module with diverse inputs
- **Setup**: 5 topologies from `topology-synthesis.ts`: single_agent, triage_specialists, pipeline, hub_spoke, peer_mesh
- **Steps**:
  1. Call `computeArchitecturePlans()` for each topology
  2. Verify structural correctness per pattern
- **Expected Result**:
  - single_agent: 1 plan, keyword=AGENT, no handoffs, no GATHER required
  - triage_specialists: supervisor with catch-all, specialists with GATHER+COMPLETE
  - pipeline: stages with GATHER+COMPLETE, linear handoff chain
  - hub_spoke: coordinator with catch-all, workers with GATHER+COMPLETE
  - peer_mesh: all peers, no catch-all required (transfer edges), no GATHER required (no return contract from transfer)
- **Failure Mode**: Pattern-specific logic wrong → incorrect archetype or missing requirements

### INT-6: Planner graceful degradation on malformed topology

- **Boundary**: Planner with edge cases
- **Setup**: Empty topology (0 agents), topology with empty entryPoint, topology with duplicate agent names
- **Steps**:
  1. Call `computeArchitecturePlans({ agents: [], edges: [], entryPoint: '' })`
  2. Call `computeArchitecturePlans({ agents: [{name:'A',...}], edges: [], entryPoint: 'NonExistent' })`
- **Expected Result**:
  - Empty topology: returns empty plans Map, no crash
  - Non-existent entry point: plans still computed for all agents, orphan detection may fire
  - No uncaught exceptions in any case
- **Failure Mode**: Null reference on empty topology → crash

---

## 4. Unit Test Scenarios

### UT-1: detectSelfHandoffs — basic detection

- **Module**: `topology-analyzer.ts`
- **Input**: `[{ from: 'A', to: 'A', type: 'delegate' }]`
- **Expected Output**: `[{ pattern: 'self_handoff', agentName: 'A', detail: 'Agent "A" has a handoff edge to itself' }]`

### UT-2: detectSelfHandoffs — no false positives

- **Module**: `topology-analyzer.ts`
- **Input**: `[{ from: 'A', to: 'B', type: 'delegate' }]`
- **Expected Output**: `[]`

### UT-3: detectCycles — acyclic topology returns empty

- **Module**: `topology-analyzer.ts`
- **Input**: Triage → Billing, Triage → Support (star topology)
- **Expected Output**: `[]`

### UT-4: detectCycles — A↔B cycle detected

- **Module**: `topology-analyzer.ts`
- **Input**: A → B (delegate), B → A (delegate)
- **Expected Output**: Array with entries for both A and B

### UT-5: detectCycles — allowCycle edges excluded

- **Module**: `topology-analyzer.ts`
- **Input**: A → B (transfer, allowCycle: true), B → A (transfer, allowCycle: true)
- **Expected Output**: `[]` (peer mesh cycles are intentional)

### UT-6: computeReachability — star topology all reachable

- **Module**: `topology-analyzer.ts`
- **Input**: Hub → A, Hub → B, entryPoint: 'Hub'
- **Expected Output**: Set containing 'Hub', 'A', 'B'

### UT-7: findOrphanAgents — detects unreachable agent

- **Module**: `topology-analyzer.ts`
- **Input**: Hub → A, orphan agent C not connected
- **Expected Output**: `[{ pattern: 'orphan_agent', agentName: 'C', ... }]`

### UT-8: inferReturnPaths — delegate with return sets needsGather + needsComplete

- **Module**: `topology-analyzer.ts`
- **Input**: `[{ from: 'Triage', to: 'Billing', type: 'delegate', expectReturn: true }]`
- **Expected Output**: Map with Billing → `{ needsGather: true, needsComplete: true, returnSources: ['Triage'] }`

### UT-9: inferReturnPaths — escalate edges excluded

- **Module**: `topology-analyzer.ts`
- **Input**: `[{ from: 'Triage', to: 'Human', type: 'escalate', expectReturn: false }]`
- **Expected Output**: Empty Map (escalate never requires return)

### UT-10: inferReturnPaths — multiple sources to same target

- **Module**: `topology-analyzer.ts`
- **Input**: A → Worker (delegate, return: true), B → Worker (delegate, return: true)
- **Expected Output**: Worker → `{ returnSources: ['A', 'B'] }`

### UT-11: inferArchetype — entry + outgoing = supervisor

- **Module**: `agent-architecture-planner.ts`
- **Input**: Agent is entry point, has 3 outgoing edges
- **Expected Output**: `'supervisor'`

### UT-12: inferArchetype — entry + zero edges = specialist

- **Module**: `agent-architecture-planner.ts`
- **Input**: Single-agent topology, entry point, 0 edges
- **Expected Output**: `'specialist'` (not supervisor — no routing to do)

### UT-13: inferArchetype — incoming + outgoing delegates = pipeline_stage

- **Module**: `agent-architecture-planner.ts`
- **Input**: Agent with incoming delegate AND outgoing delegate
- **Expected Output**: `'pipeline_stage'`

### UT-14: computeHandoffPlan — needsCatchAll only for supervisor

- **Module**: `agent-architecture-planner.ts`
- **Input**: Specialist with 2 outgoing edges (1 delegate + 1 escalate)
- **Expected Output**: `needsCatchAll: false`

### UT-15: computeHandoffPlan — supervisor gets needsCatchAll true

- **Module**: `agent-architecture-planner.ts`
- **Input**: Supervisor with 3 outgoing edges
- **Expected Output**: `needsCatchAll: true`, `catchAllTarget` is non-escalate target

### UT-16: computeGatherPlan — supervisor never requires GATHER

- **Module**: `agent-architecture-planner.ts`
- **Input**: Supervisor archetype, even with return expectations
- **Expected Output**: `required: false`

### UT-17: computeFlowPlan — scripted mode recommends FLOW

- **Module**: `agent-architecture-planner.ts`
- **Input**: Agent with `executionMode: 'scripted'`
- **Expected Output**: `recommended: true`, reason mentions FLOW

### UT-18: computeFlowPlan — reasoning mode does not recommend FLOW

- **Module**: `agent-architecture-planner.ts`
- **Input**: Agent with `executionMode: 'reasoning'`
- **Expected Output**: `recommended: false`

### UT-19: Full plan — triage topology

- **Module**: `agent-architecture-planner.ts`
- **Input**: 4-agent triage topology (Triage entry → Billing, Support delegates → Escalation escalate)
- **Expected Output**: 4 plans, Triage=supervisor/SUPERVISOR, Billing=specialist/AGENT with GATHER+COMPLETE required, Escalation=specialist without GATHER/COMPLETE

### UT-20: Performance — 10-agent topology under 100ms

- **Module**: `agent-architecture-planner.ts`
- **Input**: Synthetic 10-agent topology with 15 edges
- **Expected Output**: `computeArchitecturePlans()` completes in <100ms (measured via `performance.now()`)

---

## 5. Security & Isolation Tests

The planner is pure functions with no I/O, no database, no network. Security is inherited from the Arch session context.

- [x] N/A — Cross-tenant access: planner operates on in-memory topology, no DB queries
- [x] N/A — Cross-project access: planner operates on in-memory topology, no DB queries
- [x] N/A — Cross-user access: planner operates on in-memory topology, no DB queries
- [ ] Input validation: planner handles empty topology without crash (covered by INT-6)
- [ ] Input validation: planner handles unknown edge types via coercion (covered by INT-3)
- [x] N/A — Auth: planner is called inside already-authenticated BUILD request

---

## 6. Performance & Load Tests

### PERF-1: Planner throughput

- **Input**: 10-agent topology with 15 edges
- **Expected**: <100ms execution time (FR-12)
- **Measurement**: `performance.now()` bracketing `computeArchitecturePlans()`

### PERF-2: Token budget validation

- **Input**: 4-agent triage topology plan rendered via `renderArchitecturePlan()`
- **Expected**: Plan section <600 tokens (~2400 chars). Old guarded sections save ~800 tokens. Net: -200 tokens.
- **Measurement**: `planSection.length / 4` (chars per token estimate)

---

## 7. Test Infrastructure

- **Required services**: None — all tests are pure function unit tests
- **Data seeding**: Topology fixtures constructed in-test (no DB seeding)
- **Environment variables**: None
- **CI configuration**: Standard `pnpm vitest run` — no special setup
- **Test framework**: Vitest (existing in both packages)
- **Mocking policy**: ZERO mocks. All functions are pure (input → output). No external deps to mock.

---

## 8. Test File Mapping

| Test File                                                                        | Type               | Covers                                        | Status                                                             |
| -------------------------------------------------------------------------------- | ------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| `packages/arch-ai/src/__tests__/topology-analyzer.test.ts`                       | unit               | FR-7, FR-8, FR-9, UT-1 through UT-10          | EXISTS (13 cases)                                                  |
| `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts`              | unit               | FR-1 through FR-6, FR-12, UT-11 through UT-20 | EXISTS (19 cases)                                                  |
| `apps/studio/src/__tests__/arch-ai/handbook-reference.test.ts`                   | unit + integration | FR-10, FR-11, INT-1, INT-4                    | EXISTS (16 cases) — planner-specific rendering tests not yet added |
| `apps/studio/src/__tests__/arch-ai/build-parallel-gen-planner.test.ts` (planned) | integration        | INT-2, INT-3                                  | NOT CREATED                                                        |
| `apps/studio/e2e/workflows/arch-build-planner.e2e.test.ts` (planned)             | e2e                | E2E-1 through E2E-6                           | NOT CREATED                                                        |

---

## 9. Open Testing Questions

1. Should E2E tests verify the planner's effect by counting compile-fix loops (requires parsing build logs) or by inspecting generated DSL sections?
2. Should the peer mesh topology (transfer edges with allowCycle) be a separate E2E test or just unit coverage?
3. Should INT-2 (SharedBuildContext integration) test the actual `runParallelGeneration()` function or a focused unit that constructs SharedBuildContext?
4. Is there a test fixture for creating Arch sessions in BUILD phase that can be reused? Check `apps/studio/src/lib/arch-ai/__tests__/build-e2e-harness.ts`.
