# Feature: Arch Agent Architecture Planner

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: IMPLEMENTED
**Feature Area(s)**: `agent lifecycle`, `project lifecycle`
**Package(s)**: `@agent-platform/arch-ai`, `apps/studio`
**Owner(s)**: `arch-ai`
**Testing Guide**: `../testing/arch-agent-architecture-planner.md`
**Last Updated**: 2026-04-16
**Implementation**: Landed on `arch/promptrefine` under ABLP-162 (commits `aae8e9176`, `f2e48bdcf`, `72e01be01`). Unit coverage complete; E2E and integration coverage outstanding.

---

## 1. Introduction / Overview

### Problem Statement

Arch AI's BUILD phase generates agents by giving an LLM ~30 prose rules about when GATHER, COMPLETE, HANDOFF, FLOW, and SUPERVISOR keyword are required. The LLM routinely ignores these rules, producing agents that fail compilation. Post-generation, 15 semantic validators (CO-04, SV-13, H-02, H-04, QG-01-05) catch the violations, triggering 1-3 compile-fix repair loops per agent (15-45 seconds each). These loops frequently fail to converge, resulting in agents stuck in `error` status.

The same architectural rules are duplicated across 5 locations:

1. `ABL_CONSTRUCT_EXPERT_SYNTAX` (specialist prompt syntax reference)
2. `buildAgentSystemPrompt()` (handbook-reference.ts — ad-hoc topology context)
3. `BUILD_PHASE_PROMPT` (build.ts — quality floor rules)
4. `abl-pipeline.ts` (`buildSkeleton()` — placeholder GATHER/COMPLETE for delegates)
5. Semantic validators (diagnostics/semantic-validators.ts — post-compile checks)

When one location is updated, the others drift, creating contradictory or redundant instructions that further confuse the LLM.

### Goal Statement

Replace the generate-then-fix approach with a plan-then-generate approach. A deterministic planner computes per-agent structural requirements from topology truth before the LLM generates any DSL. The LLM receives concrete specifications ("GATHER: REQUIRED, reason: delegate target from Triage with RETURN: true") instead of prose rules it may or may not follow. Validation confirms the plan was followed, not discovers the architecture.

### Summary

The planner is a set of pure functions in `packages/arch-ai/src/planning/` that take a topology (agents + edges + entry point) as input and produce an `AgentArchitecturePlan` per agent. Each plan specifies whether GATHER, COMPLETE, FLOW are required and why, lists valid HANDOFF targets, identifies the correct DSL keyword (SUPERVISOR vs AGENT), and detects blocked patterns (self-handoffs, cycles, orphans). The existing prompt builder (`buildAgentSystemPrompt()`) renders the plan as a structured specification section. The parallel build pipeline calls the planner once before spawning workers.

---

## 2. Scope

### Goals

- Compute GATHER/COMPLETE return-path contract from topology edges (replaces CO-04/SV-13 post-hoc detection)
- Compute valid HANDOFF targets per agent (replaces cross-agent validator post-hoc checks)
- Determine SUPERVISOR vs AGENT keyword from entry-point flag (replaces QG-05 post-hoc detection)
- Block self-handoffs and detect circular handoff paths before generation
- Detect orphan agents unreachable from entry point
- Recommend FLOW for scripted/hybrid agents
- Guard old ad-hoc prompt sections behind `!plan` to avoid duplication and save ~800 prompt tokens
- Provide in-project `isNew` agent creation with structural guidance

### Non-Goals (Out of Scope)

- No changes to the ABL compiler or runtime execution
- No new DSL syntax or constructs
- No UI/frontend changes in Studio
- No changes to the diagnostic engine rules (safety nets stay)
- No changes to knowledge cards or specialist prompt content (syntax reference stays)
- No persistent storage of plans (computed in-memory per build)
- No changes to BLUEPRINT phase topology synthesis

---

## 3. User Stories

1. As a **platform architect**, I want agents generated from my topology to have the correct GATHER/COMPLETE structure on the first compile pass so that I don't wait through repair loops.
2. As a **platform architect**, I want the BUILD phase to catch topology errors (self-handoffs, orphan agents, circular routing) before generation starts so that I get clear error messages instead of cryptic compile failures.
3. As a **platform architect**, I want newly created agents in-project to receive topology-aware structural guidance so that they comply with return-path contracts from the start.
4. As an **Arch AI maintainer**, I want architectural rules computed from topology instead of duplicated in 5 prose locations so that I can update the rules in one place without drift.

---

## 4. Functional Requirements

1. **FR-1**: The system must compute an `AgentArchitecturePlan` for every agent in the topology before parallel BUILD workers are spawned.
2. **FR-2**: The plan must mark GATHER as `required: true` for any agent that is a delegate target with `expectReturn: true` on at least one incoming edge.
3. **FR-3**: The plan must mark COMPLETE as `required: true` for any agent where FR-2 applies (return contract requires completion path).
4. **FR-4**: The plan must set `keyword: 'SUPERVISOR'` for the topology entry-point agent when it has outgoing routing edges.
5. **FR-5**: The plan must list all valid HANDOFF targets per agent derived from topology edges, excluding self-handoffs.
6. **FR-6**: The plan must set `needsCatchAll: true` only for agents with `archetype: 'supervisor'`.
7. **FR-7**: The planner must detect self-handoff edges (from === to) and include them as `BlockedPattern` entries.
8. **FR-8**: The planner must detect circular handoff paths (non-trivial cycles without `allowCycle`) via DFS.
9. **FR-9**: The planner must detect orphan agents unreachable from the entry point via BFS reachability.
10. **FR-10**: The prompt builder must render the plan as a structured "Architecture Plan" section when `context.plan` is present.
11. **FR-11**: The prompt builder must skip old ad-hoc sections (Return-Path Contract, Entry-Point Routing, Routing Contract) when `context.plan` is present to avoid duplication and save tokens.
12. **FR-12**: The planner must complete in <100ms for topologies up to 10 agents.
13. **FR-13**: In-project `propose_modification(isNew: true)` must call the planner when the project has existing topology and include structural hints in the proposal flow.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                    |
| -------------------------- | ------------ | -------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Improves BUILD phase quality during project creation     |
| Agent lifecycle            | PRIMARY      | Directly affects agent code generation quality           |
| Customer experience        | SECONDARY    | End users experience better-structured agents indirectly |
| Integrations / channels    | NONE         | No integration surface changes                           |
| Observability / tracing    | NONE         | No trace event changes                                   |
| Governance / controls      | SECONDARY    | Planner enforces structural governance pre-generation    |
| Enterprise / compliance    | NONE         | No compliance impact                                     |
| Admin / operator workflows | NONE         | No admin UI changes                                      |

### Related Feature Integration Matrix

| Related Feature        | Relationship Type | Why It Matters                                           | Key Touchpoints                                  | Current State                                 |
| ---------------------- | ----------------- | -------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Arch BUILD Phase       | extends           | Planner is a pre-generation step in the BUILD pipeline   | `build-parallel-gen.ts`, `handbook-reference.ts` | Build pipeline exists, planner is new         |
| Arch Diagnostic Engine | shares data with  | Planner pre-computes what diagnostics detect post-hoc    | `semantic-validators.ts` (CO-04, SV-13, QG-05)   | Diagnostics stay as safety nets               |
| Arch In-Project Mode   | extends           | Planner provides structural hints for new agent creation | `in-project-tools.ts` (propose_modification)     | In-project exists, planner integration is new |
| Topology Synthesis     | depends on        | Planner consumes the topology produced by BLUEPRINT      | `topology-synthesis.ts`, `blueprint.ts`          | Topology types exist as input contract        |

---

## 6. Design Considerations (Optional)

N/A — no UI changes. The planner is entirely backend/prompt-pipeline.

---

## 7. Technical Considerations (Optional)

- **Token budget**: Adding the Architecture Plan section (~500 tokens) while removing 3 old ad-hoc sections (~800 tokens) yields a net savings of ~300 tokens per worker prompt. This helps with the existing 60s worker timeout.
- **Safety net strategy**: Post-generation validators (diagnostic engine, quality-enrichment, compile-fix loop) are intentionally kept. They catch what the LLM ignores even with the plan. Remove only when data shows they fire <1% of builds.
- **Edge type coercion**: Session metadata stores edge types as `string | undefined`. The planner uses a strict `'delegate' | 'escalate' | 'transfer'` union. A safe coercion function defaults unknown types to `'delegate'`.
- **Backward compatibility**: The `plan` field is optional (`plan?: AgentArchitecturePlan`). All existing code paths work unchanged when no plan is present. Old prompt sections are guarded behind `!context.plan`.

---

## 8. How to Consume

### Studio UI

No direct UI surface. The planner runs transparently inside the BUILD pipeline. Users see the effect as faster, more reliable agent generation with fewer compile errors.

### Surface Semantics Matrix

N/A — no cross-boundary asset semantics. The planner operates entirely within the BUILD pipeline's in-memory context.

### Design-Time vs Runtime Behavior

The planner is design-time only. Plans are computed in-memory during BUILD, passed to workers, and discarded after generation. Nothing persists to runtime.

### API (Runtime)

N/A — no runtime API changes.

### API (Studio)

N/A — no new API routes. The planner is called internally by `runParallelGeneration()`.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — the planner is not channel-aware. It operates on topology structure only.

---

## 9. Data Model

No new collections or persistent data. Plans are computed in-memory and passed to workers via the existing `SharedBuildContext` interface in `build-parallel-gen.ts`. Plans are not persisted to MongoDB.

The only structural change is adding `architecturePlans: Map<string, AgentArchitecturePlan>` to the existing `SharedBuildContext` interface (in-memory only, scoped to a single build request).

### Key Relationships

- **Input**: `session.metadata.topology` (agents, edges, entryPoint) — produced by BLUEPRINT phase, stored in `arch_sessions` collection
- **Output**: `AgentArchitecturePlan` per agent — consumed by `buildAgentSystemPrompt()` in `handbook-reference.ts`
- **Integration point**: `SharedBuildContext.architecturePlans` (new field on existing interface)
- **Fallback**: When plan is absent (`plan?: undefined`), all consumers fall back to existing behavior

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                          | Purpose                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/arch-ai/src/planning/types.ts`                      | Type definitions for AgentArchitecturePlan and related                     |
| `packages/arch-ai/src/planning/topology-analyzer.ts`          | Graph analysis: cycles, reachability, self-handoffs, orphans, return-paths |
| `packages/arch-ai/src/planning/agent-architecture-planner.ts` | Core planner: computeArchitecturePlans()                                   |
| `packages/arch-ai/src/planning/index.ts`                      | Barrel export                                                              |

### Routes / Handlers

| File                                                    | Purpose                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`     | Calls planner in runParallelGeneration(), passes plans to workers |
| `apps/studio/src/lib/arch-ai/handbook-reference.ts`     | Renders plan as structured prompt section, guards old sections    |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` | Calls planner for isNew agent proposals                           |

### UI Components

N/A — no UI changes.

### Jobs / Workers / Background Processes

N/A — planner runs synchronously in the BUILD request path.

### Tests

| File                                                                | Type | Coverage Focus                                             |
| ------------------------------------------------------------------- | ---- | ---------------------------------------------------------- |
| `packages/arch-ai/src/__tests__/topology-analyzer.test.ts`          | unit | Cycles, reachability, self-handoffs, orphans, return-paths |
| `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts` | unit | All 5 topology patterns, edge cases, archetype inference   |
| `apps/studio/src/__tests__/arch-ai/handbook-reference.test.ts`      | unit | Plan rendering, old section guarding, backward compat      |

---

## 11. Configuration

### Environment Variables

None — no new configuration.

### Runtime Configuration

None — the planner is always active when the plan field is present. No feature flags needed because the `plan?` field is optional (backward compatible by design).

### DSL / Agent IR / Schema

No DSL or IR changes. The planner operates on topology metadata (pre-DSL) and influences prompt construction (pre-compile).

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Project isolation | Planner operates on topology already scoped to the session's project. No cross-project data access.              |
| Tenant isolation  | Planner is pure functions operating on in-memory topology. No database queries. Inherits session's tenant scope. |
| User isolation    | Planner runs within the user's Arch session context. No cross-user data access.                                  |

### Security & Compliance

No security implications. The planner is pure functions with no I/O, no database access, no network calls. It operates on topology data already present in the Arch session.

### Performance & Scalability

- **Latency**: Planner must complete in <100ms for topologies up to 10 agents. Graph analysis (cycle detection, BFS reachability) is O(V+E) — negligible for typical topologies (3-5 agents, 5-10 edges).
- **Memory**: Plans are Map<string, AgentArchitecturePlan> — one entry per agent. Negligible memory footprint.
- **No caching needed**: Plans are computed once per build invocation. No cross-request state.

### Reliability & Failure Modes

- **Planner failure**: If `computeArchitecturePlans()` throws, the BUILD pipeline falls back to the old behavior (no plan field, old prompt sections render). Logged as warning.
- **Idempotency**: Planner is deterministic pure functions. Same topology always produces same plans.
- **No retry needed**: Planner is synchronous and fast. Failure is a code bug, not a transient error.

### Observability

- **Logging**: `parallelLog.info('Architecture plans computed', { planCount, agentsWithRequiredGather, agentsWithRequiredComplete })` in `runParallelGeneration()`.
- **No trace events**: Planner is internal to the BUILD pipeline. No user-facing trace surface.
- **Future**: Could emit plan metadata to the build journal for debugging generation quality regressions.

### Data Lifecycle

No persisted data. Plans are computed in-memory and garbage collected after the build request completes.

---

## 13. Delivery Plan / Work Breakdown

1. **Planning module (packages/arch-ai)**
   1.1 Type definitions (`planning/types.ts`)
   1.2 Topology analyzer + tests (`planning/topology-analyzer.ts`)
   1.3 Architecture planner + tests (`planning/agent-architecture-planner.ts`)
   1.4 Barrel export and package wiring (`planning/index.ts`, `index.ts`)

2. **Prompt builder integration (apps/studio)**
   2.1 Add plan field to `AgentGenerationContext`, render plan section (`handbook-reference.ts`)
   2.2 Guard old ad-hoc sections behind `!context.plan` (cleanup + token savings)
   2.3 Add tests for plan rendering path (`handbook-reference.test.ts`)

3. **Build pipeline integration (apps/studio)**
   3.1 Call planner in `runParallelGeneration()`, pass plans to workers (`build-parallel-gen.ts`)
   3.2 Add safe edge type coercion helper

4. **In-project integration (apps/studio)**
   4.1 Add planner call for `propose_modification(isNew: true)` (`in-project-tools.ts`)

5. **Verification**
   5.1 Full monorepo build
   5.2 All planner tests pass
   5.3 All existing handbook-reference tests pass
   5.4 Broader studio arch-ai test suite passes

---

## 14. Success Metrics

| Metric                              | Baseline                                                  | Target         | How Measured                                                 |
| ----------------------------------- | --------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| Compile-fix loops per agent         | 1-3 per agent                                             | <0.5 per agent | Log `compile-fix loop` events in build workers               |
| First-pass compile success rate     | ~40% (observed: 40% of workers don't call generate_agent) | >80%           | Count workers where compile_abl returns `pass` on first call |
| BUILD total time (5-agent topology) | 45-90s                                                    | 20-40s         | Log `totalElapsedMs` in runParallelGeneration                |
| SV-13 diagnostic frequency          | Fires on ~30% of delegate targets                         | <5%            | Count SV-13 findings in diagnostic engine output             |
| CO-04 diagnostic frequency          | Fires on ~20% of return-path agents                       | <5%            | Count CO-04 findings in diagnostic engine output             |

---

## 15. Open Questions

1. Should the planner's `ArchitecturePlanResult.globalBlocked` (cycles, orphans) emit SSE events to the UI so users see topology errors before generation starts? Currently they're only logged.
2. Should the plan be persisted to the Arch session's `metadata.buildProgress` for debugging? Currently it's in-memory only.
3. Should the planner eventually replace the post-generation diagnostic rules (CO-04, SV-13, QG-05) entirely, or should they always remain as safety nets?
4. Should the in-project planner integration (Task 8) read topology from the live project or from the Arch session metadata?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                              | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Cycle detection is over-aggressive — marks all nodes on path to cycle, not just cycle members                                            | Low      | Open   |
| GAP-002 | In-project integration passes empty edges for new agents (no topology edges exist yet) — plan gives baseline but no return-path analysis | Medium   | Open   |
| GAP-003 | No test coverage for peer mesh topology (transfer edges with allowCycle)                                                                 | Medium   | Open   |
| GAP-004 | CONTEXT.pass field validation not included in planner (deferred — existing H-02/H-04 validators cover this post-compile)                 | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                     | Coverage Type | Status     | Test File / Note                                                                  |
| --- | ---------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------------- |
| 1   | Triage → Specialists topology: supervisor gets SUPERVISOR keyword, catch-all | unit          | TESTED     | `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts` (19 cases)    |
| 2   | Delegate targets with RETURN: true get GATHER + COMPLETE required            | unit          | TESTED     | `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts`               |
| 3   | Escalation agents don't get GATHER/COMPLETE                                  | unit          | TESTED     | `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts`               |
| 4   | Single-agent topology: no edges, no handoffs, AGENT keyword                  | unit          | TESTED     | `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts`               |
| 5   | Pipeline topology: middle stages get GATHER + COMPLETE                       | unit          | TESTED     | `packages/arch-ai/src/__tests__/agent-architecture-planner.test.ts`               |
| 6   | Self-handoff detection and exclusion from targets                            | unit          | TESTED     | `packages/arch-ai/src/__tests__/topology-analyzer.test.ts` (13 cases)             |
| 7   | Circular handoff detection (DFS)                                             | unit          | TESTED     | `packages/arch-ai/src/__tests__/topology-analyzer.test.ts`                        |
| 8   | Orphan agent detection (BFS reachability)                                    | unit          | TESTED     | `packages/arch-ai/src/__tests__/topology-analyzer.test.ts`                        |
| 9   | Return-path inference: multiple sources to same target                       | unit          | TESTED     | `packages/arch-ai/src/__tests__/topology-analyzer.test.ts`                        |
| 10  | Plan rendering in prompt: plan present, old sections guarded                 | unit          | NOT TESTED | `apps/studio/src/__tests__/arch-ai/handbook-reference.test.ts` — follow-up needed |
| 11  | Backward compat: no plan → old sections render                               | unit          | NOT TESTED | `apps/studio/src/__tests__/arch-ai/handbook-reference.test.ts` — follow-up needed |
| 12  | GATHER/COMPLETE required rendering for delegate targets                      | unit          | NOT TESTED | `apps/studio/src/__tests__/arch-ai/handbook-reference.test.ts` — follow-up needed |

### Testing Notes

All tests are unit tests on pure functions — no mocks, no I/O, no database. The planner module has zero external dependencies. Integration testing is covered by the existing BUILD pipeline E2E tests which exercise the full generation path.

> Full testing details: `../testing/arch-agent-architecture-planner.md`

---

## 18. References

- Implementation plan: `docs/superpowers/plans/2026-04-16-arch-agent-architecture-planner.md`
- Arch generation intelligence skill: `~/.claude/skills/arch-generation-intelligence.md`
- Compiler IR schema: `packages/compiler/src/platform/ir/schema.ts`
- Semantic validators: `packages/arch-ai/src/diagnostics/semantic-validators.ts`
- Topology synthesis: `packages/arch-ai/src/coordinator/topology-synthesis.ts`
