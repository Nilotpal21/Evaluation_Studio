# SDLC Log: ABL Language -- LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: Low-Level Design + Implementation Plan
**Feature**: ABL Language
**Slug**: abl-language

---

## Decision Log

| #   | Question                                           | Classification | Answer                                                                                                                                                         |
| --- | -------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should the LLD plan structural changes?            | DECIDED        | No. Feature is STABLE with 200+ passing tests. LLD focuses on targeted improvements: CEL hardening, E2E coverage gaps, metrics, and coverage gates.            |
| 2   | What is the implementation order?                  | DECIDED        | Phase 1 (CEL hardening) -> Phase 2 (E2E coverage) -> Phase 3 (metrics/diagnostics) -> Phase 4 (coverage gates). Risk-first, then coverage, then observability. |
| 3   | Should CompilationMetrics be required or optional? | DECIDED        | Optional. Added as opt-in field to avoid performance overhead for callers that do not need timing data. Backward-compatible.                                   |
| 4   | What CEL nesting depth limit?                      | DECIDED        | 32 levels. Matches common expression language limits. Configurable via `CEL_MAX_NESTING_DEPTH` constant.                                                       |
| 5   | Should coverage thresholds block CI?               | OPEN           | Start with warn-only. Promote to blocking after baseline is established and all packages pass consistently.                                                    |

## Files Created

- `docs/plans/2026-03-22-abl-language-impl-plan.md` -- LLD with 4 implementation phases
- `docs/sdlc-logs/abl-language/lld.log.md` -- This log file

## Implementation Plan Summary

| Phase | Name                              | New Files | Modified Files | New Tests | Risk |
| ----- | --------------------------------- | --------- | -------------- | --------- | ---- |
| 1     | CEL Evaluator Hardening           | 1         | 3              | ~10 cases | Low  |
| 2     | Multi-Agent E2E Coverage          | 2         | 0              | ~13 cases | Low  |
| 3     | Compilation Metrics & Diagnostics | 1         | 4              | ~8 cases  | Low  |
| 4     | Coverage Gates & Documentation    | 0         | 2              | 0 (audit) | Low  |

Total: 4 new files, 9 modified files, ~31 new test cases.

## Review Summary

### Round 1 -- Architecture Compliance

- [x] No direct database access (compiler is pure function library)
- [x] Tenant-agnostic compilation (isolation at route level)
- [x] Stateless design (no shared mutable state)
- [x] Error handling follows platform patterns (structured CompilationError)
- [x] No inline magic numbers (all values use named constants)

### Round 2 -- Pattern Consistency

- [x] New constants follow existing pattern in `constants.ts`
- [x] New validation codes follow existing pattern in `validation-types.ts`
- [x] New test files follow existing E2E pattern in `__tests__/e2e/`
- [x] Optional metrics field follows existing CompilationOutput extension pattern
- [x] No reinvention of existing patterns

### Round 3 -- Completeness

- [x] All 15 FRs from feature spec are covered or already implemented
- [x] File paths are exact (verified against codebase)
- [x] All phases have measurable exit criteria
- [x] Wiring checklist documents both existing and new wiring
- [x] Acceptance criteria are measurable

### Round 4 -- Cross-Phase Consistency

- [x] LLD implements HLD recommendations (Alternative C: maintain current architecture)
- [x] LLD covers test spec scenarios (7 E2E + 7 integration already exist; phases add 31+ new tests)
- [x] No contradictions between feature spec, HLD, and LLD
- [x] Phase ordering follows risk-first approach (CEL hardening before coverage expansion)

### Round 5 -- Final Sweep

- [x] Each phase is independently deployable (additive changes only)
- [x] Each phase has a rollback strategy
- [x] Task granularity allows single-session completion
- [x] Wiring checklist includes all new exports
- [x] No TODO stubs in the plan
