# Feature Spec Log: Test Suite Modularization

**Date**: 2026-03-27
**Phase**: Feature Spec Generation
**Oracle**: product-oracle

## Questions & Decisions

### Scope & Problem (Q1-Q5)

- Q1: INFERRED — Three problems: slow local feedback, coarse CI, unsustainable config maintenance
- Q2: DECIDED — Only file organization + config restructuring; NOT test content refactoring, CI YAML changes, or shared package restructuring
- Q3: ANSWERED — Enhancement to existing infrastructure (4+9 vitest configs, Turbo, run-tests orchestrator already exist)
- Q4: DECIDED — P2 Standard priority, no hard timeline; config rot and OOM issues are growing pains
- Q5: INFERRED — Three approaches: domain directories (recommended), vitest workspace, Turbo sub-tasks

### User Stories & Requirements (Q6-Q10)

- Q6: INFERRED — Developer local, pre-push hook, CI pipeline, PR reviewer
- Q7: INFERRED — Five journeys: changed-file-to-tests, add-new-test, pre-push targeting, CI timeout diagnosis, flaky test isolation
- Q8: DECIDED — P0: domain dirs + convention-based config; P1: domain-scoped execution; P2: affected-test detection
- Q9: INFERRED — Preserve existing targets: smoke <15s, fast <30s, domain unit <30s, domain integration <60s
- Q10: ANSWERED — MongoMemoryServer singleton, happy-dom setup, pool constraints, sharding, co-located tests, timeout hierarchies

### Technical & Architecture (Q11-Q15)

- Q11: INFERRED — Runtime and Studio only; shared packages already manageable at package level
- Q12: DECIDED — Incremental domain-by-domain; refactor() commits, max 40 files each
- Q13: INFERRED — Studio orchestrator preserved with domain enhancement; Runtime collapses from 9 to ~4 configs
- Q14: DECIDED — Turbo at package level only; domain targeting via vitest include patterns
- Q15: DECIDED — Domain (directory) x Tier (naming convention) orthogonal matrix; compose via glob patterns

## Key Decisions (for traceability)

| ID  | Decision                                            | Rationale                             |
| --- | --------------------------------------------------- | ------------------------------------- |
| D-1 | Scope: file org + config only                       | Focused scope, CI is separate feature |
| D-2 | Priority: P2 Standard                               | No external deadline                  |
| D-3 | P0: domain dirs + convention-based config           | Foundation for all other improvements |
| D-4 | Incremental migration, refactor() commits           | CLAUDE.md commit guards enforce this  |
| D-5 | Turbo at package level, vitest for domain targeting | Avoids turbo.json bloat               |
| D-6 | Domain x Tier orthogonal via glob patterns          | Eliminates per-file exclude lists     |

## Audit Round 1 (phase-auditor)

**Verdict**: NEEDS_REVISION
**Findings**: 3 CRITICAL, 5 HIGH, 2 MEDIUM

**CRITICAL (all resolved)**:

- Inaccurate exclude entry counts → fixed to 82/56 (verified on disk)
- Missing existing subdirectory inventory → added full mapping (19 Runtime, 7 Studio)
- Phantom `setup.ts` reference → removed; Runtime has no setupFiles

**HIGH (all resolved)**:

- Studio flat file .ts/.tsx breakdown → added (154 + 81)
- Missing Studio setup-node.ts → added all 5 setup/support files
- FR-10 not testable → replaced with basename parity diff script requirement
- Delivery plan ignores existing subdirectories → added absorption steps
- Integration matrix broken link → fixed reference

**MEDIUM (all resolved)**:

- E2E → Validation Scenarios → renamed in testing guide
- Verification script as Phase 0 → added

## Audit Round 2 (phase-auditor)

**Verdict**: APPROVED
**Remaining findings** (corrected post-approval):

- HIGH: Runtime flat count 562→~565, headline totals marked approximate
- MEDIUM: Unreferenced `setup.ts` added to Open Questions
- MEDIUM: Testing guide setup file list aligned with feature spec

## Files Created

- `docs/features/test-suite-modularization.md`
- `docs/testing/test-suite-modularization.md`
- `docs/sdlc-logs/test-suite-modularization/feature-spec.log.md`
