# SDLC Log: Guardrails LLD

**Phase**: 4 - Low-Level Design
**Date**: 2026-03-22
**Status**: Complete

---

## Clarifying Questions & Resolutions

### Implementation Strategy

1. **Q: What is the current implementation state?**
   - Classification: ANSWERED
   - Source: Full codebase search of `apps/runtime/src/services/guardrails/`, `packages/compiler/src/platform/guardrails/`
   - Answer: Core feature is fully implemented (BETA). All 25 domain files, 5 route files, 10 UI files, 2 DB models exist and pass tests. Remaining work is E2E test coverage.

2. **Q: Should remaining work be behind a feature flag?**
   - Classification: DECIDED
   - Answer: No. The feature is already behind `requireFeature('guardrails')` gate. Remaining work is E2E tests, not new runtime behavior.

3. **Q: What is the preferred implementation order for remaining work?**
   - Classification: DECIDED
   - Answer: P0: E2E test infrastructure + provider x kind matrix + multi-tier cascade. P1: policy scoping + streaming + action coverage. P2: infrastructure (circuit breaker, budget, cache) + isolation.

### Technical Details

4. **Q: Which specific files need creation for E2E tests?**
   - Classification: DECIDED
   - Answer: 8 phases of E2E test files under `apps/runtime/src/__tests__/guardrails/e2e/`. All NEW files -- no modifications to existing code.

5. **Q: What is the biggest implementation risk?**
   - Classification: DECIDED
   - Answer: E2E test infrastructure setup. Starting Express on random port with full middleware chain (auth, rate limiting, feature gate, guardrails) plus seeding via API requires careful bootstrapping.

6. **Q: Is there a GAP-1 (projectId hardcoded to 'default') that should be fixed?**
   - Classification: ANSWERED
   - Source: `pipeline-factory.ts` `createGuardrailPipeline()` function
   - Answer: Yes, the pipeline factory's port adapter auto-wiring uses a hardcoded `'default'` projectId when the actual projectId is not available in the call context. This affects cache key and cost tracking key accuracy.

## Key Decisions

- 7 design decisions documented with rationale and rejected alternatives
- 8-phase implementation plan for remaining E2E work
- 10 gaps documented with severity and phase mapping
- Wiring checklist verified (compiler->runtime, runtime->DB, runtime->studio, execution->guardrails)
- Rollback strategy: 5 levels of granularity

## Output Verification

- [x] Design decisions log (7 entries)
- [x] Key interfaces and types documented
- [x] Module boundaries mapped
- [x] Implementation structure (as-built) for all layers
- [x] Phased implementation plan (8 phases with exit criteria)
- [x] File-level change map per phase
- [x] Known gaps table (10 items)
- [x] Wiring checklist (4 sections, all verified)
- [x] Rollback strategy (5 levels)
- [x] Key files reference table
