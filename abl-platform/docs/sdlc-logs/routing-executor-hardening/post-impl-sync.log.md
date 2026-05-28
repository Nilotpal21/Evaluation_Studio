# Post-Impl-Sync Log: Routing Executor Hardening

**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-01
**Status**: Complete

---

## Scope

This sync reconciles the shipped Phase 1-5 routing hardening work with the SDLC artifacts that still described pre-hardening orchestration and NLU behavior. The code was already implemented and committed before this pass; this sync updates the feature specs, HLDs, LLD status, testing index, and learning journals to match the runtime that is now on `develop`.

## Shipped Phase Map

| Phase | Commit      | Outcome                                                                  |
| ----- | ----------- | ------------------------------------------------------------------------ |
| 1     | `d5bd6f13f` | Removed stale routing authority inheritance and sanitized child sessions |
| 2     | `fa42dfae6` | Centralized child activation, tool wiring, and auth propagation          |
| 3a    | `01485b222` | Added async fan-out continuation and branch-state contract               |
| 3b    | `19116dc44` | Wired mixed local/remote async fan-out execution and parent resume       |
| 4     | `9b4dd1bcd` | Canonicalized multi-intent planning across pipeline, reasoning, and flow |
| 5     | `92f62414b` | Added deterministic HTTP regressions and aligned runtime/testing docs    |

## Documents Updated

- `docs/features/multi-agent-orchestration.md`
- `docs/features/nlu.md`
- `docs/specs/multi-agent-orchestration.hld.md`
- `docs/specs/nlu.hld.md`
- `docs/plans/2026-03-31-routing-executor-hardening-plan.md`
- `docs/testing/README.md`
- `apps/runtime/agents.md`
- `docs/sdlc-logs/agents.md`
- `docs/sdlc-logs/routing-executor-hardening/post-impl-sync.log.md`

## Accuracy Corrections

### Multi-Agent Orchestration

- Replaced stale references to mutable `handoffReturnInfo` authority with the shipped `routing-capabilities.ts` model.
- Replaced the old generic orchestration tool narrative with the canonical per-target routing tool surface.
- Updated public API references to the real wired chat entry point: `POST /api/v1/chat/agent`.
- Reflected the extracted module seams: `agent-activation-context.ts`, `fanout/`, and `multi-intent/`.
- Updated testing coverage from "planned-only" to shipped deterministic HTTP regressions for child routing authority, `RETURN:true` handoff, guided multi-intent, and mixed async fan-out callback/resume.

### NLU

- Removed the stale claim that reasoning-mode multi-intent was still flow-only.
- Documented the shipped shared multi-intent router and target-preserving bridge.
- Updated project runtime config documentation to include the live `pipeline.intentBridge` mapping.
- Corrected the E2E story from "zero" to "one targeted public-HTTP regression", while keeping the feature BETA because the broader matrix is still partial and the sidecar remains a stub.

### Hardening Plan

- Marked the LLD `DONE`.
- Recorded the six implementation commits.
- Checked off the shipped phase exit criteria, wiring checklist, and acceptance criteria against the implementation log.
- Aligned Phase 5 verification wording with the focused runtime/execution package regressions that were actually run during implementation.

## Coverage Delta

| Area                        | Before                                            | After                                                      |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Orchestration live coverage | Env-gated provider smoke only                     | Deterministic public-HTTP regressions plus env-gated smoke |
| NLU public-API E2E          | Documented as zero                                | Guided multi-intent HTTP regression documented as partial  |
| Feature/HLD API references  | Mixed stale `/api/projects/.../chat` references   | Wired `/api/v1/chat/agent` and session trace endpoints     |
| Multi-intent architecture   | Split narratives across classifier/flow/reasoning | One canonical shared planner/router                        |

## Remaining Open Gaps

- Orchestration still needs broader live coverage for `primary_queue`, `sequential`, `disambiguate`, and explicit history-strategy scenarios.
- NLU still needs additional public-API E2Es for single-intent short-circuit, keyword veto, fallback, and circuit-breaker paths.
- The Python sidecar remains a stub, so real ML-service coverage is still blocked.
- Classifier integration remains mocked at the LLM boundary in tests.

## Verification

- Cross-checked the doc changes against the shipped runtime modules and regression test files on disk.
- `npx prettier --write` was run on all changed documentation/journal files.
- No build or test commands were rerun in this sync pass because this was a docs-only reconciliation pass; the implementation-phase verification recorded in `implementation.log.md` remains the source of truth for the shipped code.
