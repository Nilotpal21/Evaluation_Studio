# HLD Log: Test Suite Modularization

**Date**: 2026-03-27
**Phase**: High-Level Design
**Oracle**: product-oracle

## Questions & Decisions

### Architecture & Data Flow (Q1-Q5)

- Q1: ANSWERED — Incremental domain-by-domain, forced by commit scope guard (max 40 files), rollback granularity, and verification fidelity
- Q2: DECIDED — Target 5 configs: default (forks), fast (threads), smoke (curated), e2e (unified from 4), integration. Flaky config redundant (tests already in integration).
- Q3: DECIDED — Shell out to `vitest --listTests` per config. Correctness over speed — tests vitest's actual discovery. No programmatic API precedent in codebase.
- Q4: DECIDED — Add `--domain` flag to Studio orchestrator. Don't bypass it — orchestrator provides environment separation and sharding.
- Q5: DECIDED — `pre-refactor/` migrates as unit to `execution/pre-refactor/`. Cross-domain E2E tests go to `e2e/`. Uncategorizable files stay flat (<30 target).

### Integration & Dependencies (Q6-Q10)

- Q6: ANSWERED + DECIDED — 24 hyphenated E2E files must be renamed to dotted convention BEFORE moves. Separate `refactor()` commit. Enables clean convention-based globs.
- Q7: ANSWERED — No Turbo changes needed. `inputs: ["src/**/*.ts"]` already recurses.
- Q8: ANSWERED — `test-capture.ts` needs no changes. Domain filtering is out of scope (nice-to-have for future).
- Q9: DECIDED — Bash case-statement path-prefix mapping in pre-push hook. Unknown paths fall back to full smoke.
- Q10: ANSWERED — No cross-package test dependencies. Only intra-package relative imports (~93 flat files import from `./helpers/`).

### Risk & Migration (Q11-Q15)

- Q11: INFERRED — Biggest risk is config consolidation silently excluding tests (not file moves, which are loud failures). Mitigated by verification script (VAL-3).
- Q12: DECIDED — Runtime first, then Studio. Higher risk/complexity first. Avoid merge conflicts in shared tooling.
- Q13: DECIDED — Merge specialty E2E configs using most-restrictive defaults (sequential, 120s/180s timeouts). 10 total specialty files don't justify 3 separate configs.
- Q14: ANSWERED + DECIDED — Domain commits revertable independently. Config consolidation: keep old specialty configs for 1 release cycle post-consolidation for safe revert.
- Q15: INFERRED — Blast radius limited to migrated app's test tiers. Cannot cascade to runtime behavior or other packages.

## Key Decisions

| ID  | Decision                                                           | Rationale                                                                   |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| D-1 | 5 target configs (down from 9)                                     | Specialty E2E configs have <10 files total; maintenance burden not worth it |
| D-2 | `vitest --listTests` for verification (not programmatic API)       | Correctness — tests vitest's actual discovery, not a re-implementation      |
| D-3 | Studio orchestrator gets `--domain` flag                           | Don't bypass — provides env separation and sharding                         |
| D-4 | `pre-refactor/` migrates as unit into `execution/pre-refactor/`    | Internal fixtures/helpers would break if distributed                        |
| D-5 | Rename 24 hyphenated E2E files BEFORE moves                        | Enables clean globs, preserves git rename detection                         |
| D-6 | Bash case-statement for git-diff-to-domain in pre-push             | Fast, no Node dependency, conservative fallback                             |
| D-7 | Runtime first, then Studio                                         | Learn lessons on harder case first                                          |
| D-8 | Unified E2E config with most-restrictive defaults                  | 90s cost on 4 connector tests acceptable vs 3 config maintenance            |
| D-9 | Keep old specialty configs for 1 release cycle after consolidation | Makes config consolidation safely revertable                                |

## Audit Round 1 (phase-auditor)

**Verdict**: NEEDS_REVISION
**Findings**: 0 CRITICAL, 2 HIGH, 5 MEDIUM

**HIGH (all resolved)**:

- 5 vs ~4 config count → added justification (default vitest.config.ts must be retained for pnpm test)
- Subdirectory count 19/7 vs actual 20/8 → added directory count note with omitted dirs named

**MEDIUM (all resolved)**:

- Phase 0.5 not in feature spec → tagged as HLD refinement
- Studio integration/ dir unaddressed → added to residual note
- OQ5 cross-domain E2E not stated → explicitly resolved
- OQ3 remaining-stores.test.ts → noted as moves as-is, splitting out of scope
- Test spec HLD reference stale → updated

## Audit Round 2 (phase-auditor)

**Verdict**: APPROVED
**Remaining MEDIUM (fixed post-approval)**:

- FR-7 co-located tests not explicitly mentioned → added scope note in Architecture section

## Files Created

- `docs/specs/test-suite-modularization.hld.md`
- `docs/sdlc-logs/test-suite-modularization/hld.log.md` (this file)
