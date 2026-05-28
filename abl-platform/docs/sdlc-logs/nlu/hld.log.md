# NLU HLD — SDLC Log

**Phase**: 3 — High-Level Design
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                   | Classification | Answer                                                                                                                                      |
| --- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What's the preferred architecture pattern? | ANSWERED       | Fast pipeline classifier + optional ML sidecar (Alternative C). Already implemented.                                                        |
| 2   | How does data flow?                        | ANSWERED       | Request path: user message -> pipeline orchestrator -> classifier LLM -> short-circuit or reasoning loop. Sidecar used in gather mode only. |
| 3   | What's the deployment topology?            | ANSWERED       | Pipeline runs in-process in the runtime. Sidecar is an external Python service. nl-parser runs in Studio backend.                           |
| 4   | Breaking changes?                          | ANSWERED       | None. Pipeline is disabled by default. All features are additive and config-driven.                                                         |
| 5   | Rollback strategy?                         | DECIDED        | Config-driven rollback: disable pipeline, switch NLU provider to standard, disable multi-intent. No code deployment needed.                 |

## Key Corrections from Previous HLD

1. ~~**Removed phantom modules**: Previous HLD referenced `intent-bridge.ts` (Module T-2) and `tiered-resolver.ts` (Module T-3) which do not exist.~~ **CORRECTION (2026-03-26)**: Both files DO exist. `intent-bridge.ts` (188 LOC) and `tiered-resolver.ts` (180 LOC) are fully implemented with unit tests. The original HLD was correct; the "correction" was the error. Module T-2 and T-3 in the LLD are accurate.
2. **Added pipeline circuit breaker**: Previous HLD did not mention the per-tenant pipeline circuit breaker (`circuit-breaker.ts`).
3. **Added merge module**: Previous HLD did not document the response synthesis module (`merge.ts`) for multi-intent fan-out.
4. **Added tool filter**: Previous HLD mentioned tool filtering but did not describe its architecture.
5. **Expanded all 12 concerns**: Previous HLD had 5 sections. New HLD addresses all 12 architectural concerns per the playbook.
6. **Added alternatives considered**: Previous HLD had no alternatives section.
7. **Added data flow diagrams**: System context, component, and step-by-step data flows.
8. **Added error model table**: All failure scenarios with behavior and user experience impact.

## Review Findings

### Round 1 — Full Audit

- [x] All 12 architectural concerns addressed
- [x] 3 alternatives with trade-offs (A: LLM-only, B: dedicated microservice, C: pipeline + sidecar)
- [x] Architecture diagrams present (system context, component, data flow)
- [x] Data model complete (in-memory + MongoDB)
- [x] API design complete (runtime config + sidecar)
- [x] Open questions listed (5 items)

### Round 2 — Deep Dive

- [x] Data model/API design reviewed for correctness
- [x] Error model covers real failure scenarios (7 scenarios with behavior + UX impact)
- [x] Performance budget is realistic (based on actual code: 10s classifier timeout, 3s sidecar timeout, 15s merge timeout)
- [x] Circuit breaker state machines documented for both pipeline and sidecar

### Round 3 — Cross-Phase Consistency

- [x] HLD implements all 12 FRs from feature spec
- [x] Test strategy aligns with test spec scenarios (7 E2E, 7 integration, 35+ unit)
- [x] No contradictions between feature spec and HLD
- [x] Dependencies match actual code imports

---

## Post-Impl Sync (2026-03-26)

### Changes Made

- Changed HLD status from STABLE to BETA (E2E tests not yet implemented, sidecar server is a stub)
- Added Implementation Status section documenting all components and their completion status
- Added `intent-bridge.ts` and `tiered-resolver.ts` to component diagram
- Added both files to References section
- Updated test strategy to include intent bridge and tiered resolver in unit test coverage list
- Updated migration path to mention intent bridge, tiered resolver, compiler NLU engine, and sidecar stub status
- Corrected item 1 in "Key Corrections" — both modules exist and were wrongly classified as phantom
