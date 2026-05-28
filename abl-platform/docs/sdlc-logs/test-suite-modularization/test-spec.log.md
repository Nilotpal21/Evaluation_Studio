# Test Spec Log: Test Suite Modularization

**Date**: 2026-03-27
**Phase**: Test Spec Generation
**Oracle**: product-oracle

## Questions & Decisions

### Test Scope & Priorities (Q1-Q5)

- Q1: INFERRED — Highest risk: FR-9 (zero test loss), FR-5 (config consolidation), FR-4 (backward compat), FR-3 (naming convention), FR-6 (domain-scoped execution)
- Q2: ANSWERED — Known issues: silent exclusion via config omission, flaky tests from MongoMemoryServer contention, Studio happy-dom/force-exit hangs, duplicate file inclusion across configs, 6 special `.test.ts` files needing happy-dom in Studio
- Q3: ANSWERED — No existing verification mechanism. `tools/test-capture.ts` captures results but not file discovery sets. Phase 0 verification script must be created from scratch.
- Q4: INFERRED — Fragility ranking: MongoMemoryServer (highest), happy-dom, Studio run-tests.ts orchestrator, vitest glob resolution, Turbo cache (lowest)
- Q5: INFERRED — Verification scripts must work locally (macOS) and CI (node:24-bookworm). `vitest --listTests` needs no infra (no MongoDB/Redis). Harness YAML wiring is out of scope.

### Validation Scenarios (Q6-Q10)

- Q6: DECIDED — 7 critical validation journeys: full inventory parity (Runtime + Studio), per-config pool correctness, pnpm test\* parity, domain-scoped execution, pre-push regression, rollback safety
- Q7: ANSWERED — All 13 configs (9 Runtime + 4 Studio) need validation. Key cross-config checks: no E2E files in fast config, no orphaned files, 6 RTL .test.ts files stay in Studio unit config
- Q8: INFERRED — Three categories: shared fixtures/helpers relative imports (24 files use `../fixtures/`, 46 use `./fixtures/`), cross-subdirectory imports (6 files), fixture directory sub-structure preservation
- Q9: DECIDED — Golden baseline stored in gitignored `tools/test-baselines/`, one sorted basename file per config, script accepts `--capture` and `--verify` flags
- Q10: ANSWERED — 5 performance targets with specific measurement methods (3 runs averaged on idle machine). Caveats: first run uncached, pre-push timing requires small unrelated change

### Integration Boundaries (Q11-Q15)

- Q11: INFERRED — 6 critical boundaries: fast-excludes-E2E, MongoDB-dependent non-E2E files, Studio light-vs-unit routing, unit config .test.tsx discovery, smoke curated list path updates, E2E inconsistent naming
- Q12: ANSWERED — 4 orchestrator scenarios: split mode phases, delegation mode, passWithNoTests handling, COMMAND_TIMEOUT_MS (3 min) per phase
- Q13: INFERRED — Low risk: Turbo inputs `src/**/*.ts` already recurse, cache correctly invalidates on file moves, first post-migration run uncached by design
- Q14: INFERRED — No real race conditions. Naming inconsistency (hyphenated vs dotted E2E) is a config-discovery concern, not a race. E2E sequential ordering may change but tests should be independent.
- Q15: DECIDED — Test one representative domain revert (execution). Pattern: commit → verify → revert → tsc+verify → revert-revert → verify. Sufficient to validate the pattern.

## Key Decisions (for traceability)

| ID  | Decision                                                         | Rationale                                                      |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| D-1 | Golden baselines in gitignored `tools/test-baselines/`           | Matches `test-reports/` pattern, baselines are ephemeral       |
| D-2 | Rollback test: one representative domain (execution), not all 14 | Same pattern repeated — testing one proves the pattern         |
| D-3 | Verification script in TypeScript (not shell) via `npx tsx`      | Matches `tools/test-capture.ts` pattern, better error handling |

## Audit Round 1 (phase-auditor)

**Verdict**: NEEDS_REVISION
**Findings**: 1 CRITICAL, 3 HIGH, 2 MEDIUM

**CRITICAL (resolved)**:

- INT-4 listed 3 fabricated filenames for Studio light-config excludes → replaced with actual 8 files from `vitest.light.config.ts:27-36`

**HIGH (all resolved)**:

- Coverage matrix FR-1/FR-2 mapped to wrong VAL scenarios → FR-1→VAL-1, FR-2→VAL-2
- INT-3 fabricated import counts (24/46) → replaced with verified ~93 flat + ~39 subdirectory
- `.sh` vs `.ts` naming inconsistency → aligned on `.ts` in both feature spec and test spec

**MEDIUM (all resolved)**:

- VAL-4 missing Studio vitest-force-exit caveat → added note about `--listTests` workaround
- Test file mapping missing INT scenarios → added INT-1 through INT-7

## Audit Round 2 (phase-auditor)

**Verdict**: APPROVED
**Remaining MEDIUM findings** (fixed post-approval):

- INT-3 "~131 flat" was slightly inflated → corrected to "~93 flat + ~39 in subdirectories"
- Coverage matrix FR-4 missing VAL-6, FR-9 missing VAL-7 → added
- INT-4 failure mode said "6 RTL files" but should be "8 excluded files" → corrected

## Files Updated

- `docs/testing/test-suite-modularization.md` (full rewrite from stub)
- `docs/features/test-suite-modularization.md` (aligned verify-test-inventory.sh → .ts)
- `docs/sdlc-logs/test-suite-modularization/test-spec.log.md` (this file)
