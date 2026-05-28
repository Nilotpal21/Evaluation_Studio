# HLD: Arch Agent Architecture Planner

**Feature Spec**: `docs/features/arch-agent-architecture-planner.md`
**Test Spec**: `docs/testing/arch-agent-architecture-planner.md`
**LLD/Plan**: `docs/superpowers/plans/2026-04-16-arch-agent-architecture-planner.md`
**Status**: IMPLEMENTED
**Last Updated**: 2026-04-16
**Implementation**: Landed on `arch/promptrefine` under ABLP-162 (commits `aae8e9176`, `f2e48bdcf`, `72e01be01`). Integration + E2E coverage tracked as follow-up in the test spec.

---

## 1. System Context

The planner sits between BLUEPRINT topology approval and BUILD parallel worker dispatch:

```
BLUEPRINT ──topology──▸ PLANNER ──plans──▸ WORKERS ──DSL──▸ COMPILER
              (pure)       (pure)            (LLM)          (pure)
```

The planner is synchronous, deterministic, and in-memory. No new services, APIs, databases, or external dependencies.

## 2. Component Architecture

### New: `packages/arch-ai/src/planning/`

```
planning/
├── types.ts                      # AgentArchitecturePlan, PlannerTopologyInput
├── topology-analyzer.ts          # Graph: cycles, reachability, orphans, return-paths
├── agent-architecture-planner.ts # computeArchitecturePlans(): topology → plans
└── index.ts                      # Barrel export
```

All pure functions. No classes, no state, no I/O.

### Modified: `apps/studio/src/lib/arch-ai/`

| File                        | Change                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handbook-reference.ts`     | Add optional `plan?` field to `AgentGenerationContext`. Render plan as "Architecture Plan" section. Guard old ad-hoc sections behind `!plan`.                     |
| `build-parallel-gen.ts`     | Call planner once in `runParallelGeneration()`. Add `architecturePlans` to `SharedBuildContext`. Pass plan to each worker's `genContext`. Add `coerceEdgeType()`. |
| `tools/in-project-tools.ts` | Call planner for `propose_modification(isNew: true)` — best effort.                                                                                               |

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

**No impact.** Planner operates on in-memory topology already scoped to the user's Arch session. No database queries. No cross-tenant data access.

### 3.2 Project Isolation

**No impact.** Topology is per-session, sessions are per-project. Planner inherits isolation from the existing session model.

### 3.3 User Isolation

**No impact.** Plans are computed per-request and discarded. No persistence.

### 3.4 Authentication & Authorization

**No impact.** Planner runs inside already-authenticated BUILD request handlers. No new endpoints.

### 3.5 Data Model

**No changes.** Plans are `Map<string, AgentArchitecturePlan>` in-memory. Added to existing `SharedBuildContext` interface. Not persisted to MongoDB.

### 3.6 API Surface

**No new APIs.** Planner is internal to the BUILD pipeline. Consumed via TypeScript imports, not HTTP.

### 3.7 Performance

- **Planner cost**: O(V+E) graph analysis. <100ms for 10 agents (FR-12). Negligible vs 60s worker timeout.
- **Token impact**: New plan section ~500 tokens. Old guarded sections ~800 tokens. Net savings ~300 tokens per worker prompt.
- **Memory**: One `Map<string, Plan>` per build request. GC'd after request completes.

### 3.8 Reliability & Failure Modes

- **Planner throws**: Caught in `runParallelGeneration()`. Falls back to old behavior (no plan, old sections render). Logged as warning.
- **In-project planner throws**: Caught in `propose_modification`. Agent creation proceeds without hints. Logged.
- **Deterministic**: Same topology always produces same plans. No retry needed.

### 3.9 Observability

- **Logging**: `parallelLog.info('Architecture plans computed', { planCount, agentsWithRequiredGather, agentsWithRequiredComplete })`.
- **No trace events**: Internal to BUILD pipeline. Not user-visible.
- **Future**: Could add plan metadata to build journal for quality regression debugging.

### 3.10 Security

**No attack surface.** Pure functions, no user input parsing, no network access, no file I/O. Input is topology already validated by BLUEPRINT phase.

### 3.11 Compliance

**No impact.** No PII, no encryption, no audit logging requirements. Plans contain only structural metadata (agent names, required sections, edge types).

### 3.12 Backward Compatibility

- `plan?: AgentArchitecturePlan` is optional. All existing code works when plan is absent.
- `!context.plan` guard ensures old prompt sections render when planner is not active.
- No breaking changes to any existing interface or contract.
- No migration needed. No feature flag needed.

## 4. Alternatives Considered

| Alternative                                                          | Why Rejected                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Improve prose rules in prompt                                        | Already tried (5 locations, frequent drift). LLM still ignores rules ~60% of the time.                             |
| Make diagnostic engine generate fix hints at compile time            | Post-hoc — doesn't prevent the initial bad generation. Adds latency.                                               |
| Add LLM-based pre-planning step (chain-of-thought before generation) | Adds LLM call latency (~5-10s). Planner achieves the same result deterministically in <100ms.                      |
| Embed planner logic directly in `buildAgentSystemPrompt()`           | Mixes concerns. Keeps rules in the prompt layer instead of a reusable planning module. Not testable independently. |

## 5. Risks

| Risk                                                    | Severity | Mitigation                                                                                                                                                            |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM ignores plan just as it ignores prose rules         | MEDIUM   | Plan is structured specification ("GATHER: REQUIRED") not prose ("you should include GATHER"). More constrained format. Safety nets (diagnostics, enrichment) remain. |
| Rule duplication drift between plan and remaining prose | HIGH     | Task 5b guards old sections behind `!plan`. Only one source active at a time.                                                                                         |
| Token budget exceeded with plan + remaining prompt      | LOW      | Net savings ~300 tokens. Old sections removed when plan present.                                                                                                      |
| In-project planner gets stale topology                  | LOW      | Reads live project agents. New agent has no edges yet — plan gives baseline only.                                                                                     |

## 6. Decision Log

| #   | Decision                                                  | Rationale                                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| D1  | Pure functions in `packages/arch-ai/`, not `apps/studio/` | Reusable across BUILD and IN_PROJECT. Testable independently.      |
| D2  | Optional `plan?` field, not required                      | Backward compatible. Incremental rollout. Old code still works.    |
| D3  | Guard old sections with `!plan`, not delete them          | Safety net during transition. Data-driven removal later.           |
| D4  | `needsCatchAll` keyed on archetype, not edge count        | Specialists with escalate edges shouldn't get catch-all.           |
| D5  | Safety net validators (diagnostics, enrichment) kept      | Planner reduces frequency, not necessity. Remove at <1% fire rate. |
| D6  | In-project integration is best-effort                     | Failure doesn't block agent creation. Planner is bonus guidance.   |
