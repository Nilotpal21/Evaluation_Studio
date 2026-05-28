# NLU LLD — SDLC Log

**Phase**: 4 — Low-Level Design + Implementation Plan
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                | Classification | Answer                                                                                                                                             |
| --- | --------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Preferred implementation order?         | DECIDED        | Since all code is implemented, phases focus on E2E tests: infrastructure first, then core pipeline E2E, then sidecar/isolation E2E, then doc sync. |
| 2   | Which specific files need creation?     | ANSWERED       | Only E2E test files and test helpers need to be created. All implementation files exist and have passing unit tests.                               |
| 3   | Should E2E tests be behind a skip flag? | DECIDED        | LLM-dependent E2E tests should be skippable via `SKIP_LLM_E2E=true` env var. Sidecar/isolation tests always run.                                   |
| 4   | How to verify trace events in E2E?      | DECIDED        | Use a test trace store injected at runtime startup or a debug endpoint.                                                                            |
| 5   | Biggest implementation risk?            | DECIDED        | E2E test flakiness due to LLM non-determinism. Mitigated by using temperature 0 and generous confidence thresholds in tests.                       |

## Key Differences from Previous LLD

1. **Reframed as E2E gap closure**: Previous LLD documented the implementation modules as if they were being built. New LLD recognizes all modules are implemented and focuses on closing the E2E test gap.
2. ~~**Removed phantom modules**: Previous LLD had Module T-2 (Intent Bridge) and T-3 (Tiered Resolver) referencing non-existent files.~~ **CORRECTION (2026-03-26)**: Both Module T-2 (Intent Bridge, `intent-bridge.ts` 188 LOC) and Module T-3 (Tiered Resolver, `tiered-resolver.ts` 180 LOC) DO exist and are correctly documented in the LLD. The "removal" was an error.
3. **Added 4 implementation phases**: Infrastructure, core pipeline E2E, sidecar/isolation E2E, documentation sync. Each with measurable exit criteria.
4. **Added wiring checklist**: Verified all existing wiring is complete. New wiring needed only for E2E test infrastructure.
5. **Added acceptance criteria**: Clear definition of done for the whole feature.
6. **Corrected function signatures**: All function signatures match actual code (verified by reading source files).

## Review Findings

### Round 1 — Architecture Compliance

- [x] Tenant isolation verified in E2E test design (E2E-7)
- [x] Auth context specified in all E2E scenarios
- [x] Stateless pattern maintained (intent queue on session, no cross-pod state)
- [x] Traceability through trace events verified in E2E tests

### Round 2 — Pattern Consistency

- [x] E2E test approach matches existing runtime test patterns
- [x] Sidecar test double follows minimal HTTP server pattern
- [x] Config resolution follows existing cascade pattern (agent -> project -> defaults)
- [x] No reinvention of existing patterns

### Round 3 — Completeness

- [x] Every FR covered by at least one E2E test scenario
- [x] All file paths verified against actual codebase (ls + read)
- [x] Function signatures verified by reading source code
- [x] No phantom files referenced

### Round 4 — Cross-Phase Consistency

- [x] LLD implements HLD architecture (pipeline + sidecar + multi-intent)
- [x] LLD covers test spec scenarios (all 7 E2E + 7 integration)
- [x] Phase exit criteria are measurable
- [x] No contradictions between feature spec, HLD, and LLD

### Round 5 — Final Sweep

- [x] Each phase independently deployable (E2E tests are additive)
- [x] Wiring checklist complete (all existing wiring verified, new wiring for test infrastructure)
- [x] No domain-specific leakage in engine code
- [x] Open questions resolved with DECIDED classification

---

## Post-Impl Sync (2026-03-26)

### Changes Made

- Corrected item 2 in "Key Differences" — Module T-2 (Intent Bridge) and T-3 (Tiered Resolver) are real, not phantom
- LLD Core Files table and Module sections for T-2 and T-3 were already correct and remain unchanged
- Added GAP-007 to Known Gaps: NLU sidecar server is a stub (returns empty, TODO: wire ML models)
- Updated impl plan wiring checklist with intent bridge, tiered resolver, and PipelineConfig.intentBridge verification
- Updated impl plan file table with `intent-bridge.ts`, `tiered-resolver.ts`, and `apps/nlu-sidecar/app.py`
