# Test Specification: Test Suite Modularization

**Feature Spec**: `docs/features/test-suite-modularization.md`
**HLD**: `docs/specs/test-suite-modularization.hld.md`
**LLD**: `docs/plans/2026-03-27-test-suite-modularization-impl-plan.md`
**Status**: ALPHA
**Last Updated**: 2026-03-28

---

## 1. Coverage Matrix

| FR    | Description                             | Unit | Integration | E2E (Validation) | Manual | Status  |
| ----- | --------------------------------------- | ---- | ----------- | ---------------- | ------ | ------- |
| FR-1  | Runtime domain directories (8 domains)  | N/A  | ✅          | ✅               | ✅     | COVERED |
| FR-2  | Studio domain directories (7 domains)   | N/A  | ✅          | ✅               | ✅     | COVERED |
| FR-3  | Naming convention tier detection        | ✅   | ✅          | ✅               | ✅     | COVERED |
| FR-4  | Backward-compatible pnpm test scripts   | N/A  | ✅          | ✅               | ✅     | COVERED |
| FR-5  | Runtime config consolidation (9 -> <=5) | ✅   | ✅          | ✅               | ✅     | COVERED |
| FR-6  | Domain-scoped vitest execution          | N/A  | ✅          | ✅               | ✅     | COVERED |
| FR-7  | Co-located tests preserved              | N/A  | ✅          | ✅               | ✅     | COVERED |
| FR-8  | TEST_INDEX.md updated                   | N/A  | N/A         | N/A              | ✅     | COVERED |
| FR-9  | Zero test loss verification             | ✅   | ✅          | ✅               | ✅     | COVERED |
| FR-10 | Test file basename parity (diff script) | ✅   | ✅          | ✅               | ✅     | COVERED |

---

## 2. E2E Validation Scenarios

> **Note**: This is an infrastructure-only feature with no HTTP APIs or runtime code changes.
> "E2E" scenarios here are **full-pipeline validation journeys** that exercise the complete
> migration workflow from file move through verification. They are not traditional HTTP E2E tests.

### Execution Status Summary

| Scenario | Status | Evidence                                                                                                                                                                         |
| -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-1    | PASS   | `npx tsx tools/verify-test-inventory.ts --verify --app runtime` after Runtime phases 1-3                                                                                         |
| VAL-2    | PASS   | Studio baseline refreshed with `--capture`, then `--verify --app studio` passed with 0 uncovered files                                                                           |
| VAL-3    | PASS   | Runtime primary configs + inventory verify confirmed tier separation after consolidation. INT-1 probe found and fixed missing `**/*.integration.test.ts` exclude in fast config. |
| VAL-4    | PASS   | Runtime smoke (18 files/600 tests), fast (580 files/8816 tests), Studio default (54 files/696 tests), light, and node (exit 0) all pass                                          |
| VAL-5    | PASS   | Runtime `execution/` and Studio `stores/` domain-scoped runs succeeded                                                                                                           |
| VAL-6    | PASS   | Full 7-step pre-push hook completed in ~73s (well under 5min target), all steps passed, domain mapping logic validated                                                           |
| VAL-7    | PASS   | Revert of `6772da7fa` (Studio docs domain) was clean, tsc passed, parity verified, revert-of-revert restored state cleanly                                                       |

### VAL-1: Full Inventory Parity — Runtime

- **Preconditions**:
  - Golden baseline captured via `tools/verify-test-inventory.ts --capture --app runtime` before any file moves
  - Baseline stored in gitignored `tools/test-baselines/runtime/` with one sorted file list per config
- **Steps**:
  1. Run `vitest --listTests --config <config>` for each of the 9 Runtime vitest configs and save output
  2. Extract basenames from each config's test file list, sort alphabetically
  3. Move files for one Runtime domain (e.g., `execution/`) per the delivery plan
  4. Re-run `vitest --listTests --config <config>` for each of the 9 configs
  5. Extract basenames from post-migration lists, sort alphabetically
  6. Diff pre-migration vs post-migration basename sets (order-independent)
  7. Diff per-config counts: each config must discover the same number of files
- **Expected Result**:
  - Zero-delta on aggregate basename set (no test file lost or gained)
  - Zero-delta on per-config counts (no file shifted between configs)
  - Exit code 0 from `tools/verify-test-inventory.ts --verify --app runtime`
- **Validation Context**: Automated script, run after each Phase 1 domain commit
- **Covers**: FR-1, FR-9, FR-10

### VAL-2: Full Inventory Parity — Studio

- **Preconditions**:
  - Golden baseline captured via `tools/verify-test-inventory.ts --capture --app studio` before any file moves
  - Baseline stored in gitignored `tools/test-baselines/studio/`
- **Steps**:
  1. Run `vitest --listTests --config <config>` for each of the 4 Studio vitest configs
  2. Extract basenames, sort
  3. Move files for one Studio domain (e.g., `api-routes/`) per the delivery plan
  4. Re-run `vitest --listTests --config <config>` for each of the 4 configs
  5. Extract basenames, sort
  6. Diff pre vs post basename sets
  7. Diff per-config counts
  8. Also verify co-located tests (23 files in `src/components/*/__tests__/`, etc.) are still discovered
- **Expected Result**:
  - Zero-delta on aggregate basename set
  - Zero-delta on per-config counts
  - Co-located tests unaffected (same discovery before and after)
- **Validation Context**: Automated script, run after each Phase 3 domain commit
- **Covers**: FR-2, FR-7, FR-9

### VAL-3: Per-Config Pool Type Correctness After Config Consolidation

- **Preconditions**:
  - Phase 2 (Runtime config consolidation) complete
  - New glob-based configs in place
- **Steps**:
  1. Run `vitest --listTests --config vitest.fast.config.ts` and capture file list
  2. Assert no file with `.e2e.` or `.integration.` in its name appears in the fast config list
  3. Assert no MongoDB-dependent test (e.g., `stores.test.ts`, `repos-session.test.ts`) appears in the fast config list — these must have been renamed to `*.integration.test.ts` or excluded by another mechanism
  4. Run `vitest --listTests --config vitest.e2e.config.ts` and capture file list
  5. Assert ALL files with `.e2e.test.ts` naming appear in the E2E config
  6. Assert files that previously used hyphenated E2E naming have been normalized and are still captured after the rename
  7. Run `vitest --listTests --config vitest.integration.config.ts` and capture file list
  8. Assert ALL files with `.integration.test.ts` naming appear
  9. Compute union of all config file lists — assert it equals the on-disk test file set (no orphans)
- **Expected Result**:
  - Fast config: 0 E2E files, 0 integration files, 0 MongoDB-dependent files
  - E2E config: all E2E-tier files including inconsistently named ones
  - Integration config: all integration-tier files
  - Union of all configs = all test files on disk (no orphans)
- **Validation Context**: Automated script, run once after Phase 2 completes
- **Covers**: FR-3, FR-5

### VAL-4: pnpm test\* Script Parity

- **Preconditions**:
  - Baseline test counts captured per command before migration
  - Migration complete (all phases for the target app)
- **Steps**:
  1. Run each Runtime test command and capture test count from vitest output:
     - `pnpm test` (default)
     - `pnpm test:fast`
     - `pnpm test:smoke`
     - `pnpm test:e2e`
     - `pnpm test:integration`
  2. Run each Studio test command and capture test count:
     - `pnpm test` (orchestrated via `run-tests.ts`)
     - `pnpm test:fast` (light config)
     - `pnpm test:node` (node config)
       **Note**: Studio's `vitest-force-exit.ts` kills the process before reporters flush, so test counts must be captured via `vitest --listTests` (file-level count) + exit code verification, not by parsing reporter output.
  3. Compare each count against the baseline
  4. Compare exit codes (pass/fail) against baseline
- **Expected Result**:
  - Every `pnpm test*` command produces the same test count as baseline
  - Every command produces the same pass/fail exit code as baseline
  - No new failures introduced by the migration
- **Validation Context**: Manual execution with scripted count comparison, run after each major phase
- **Covers**: FR-4, FR-5

### VAL-5: Domain-Scoped Execution

- **Preconditions**:
  - At least one Runtime domain migration complete (e.g., `execution/`)
  - All tests in the domain are passing
- **Steps**:
  1. Run `npx vitest run --config vitest.fast.config.ts src/__tests__/execution/` and capture output
  2. Assert only tests from `src/__tests__/execution/` appear in the run
  3. Assert test count matches the number of `*.test.ts` files in `src/__tests__/execution/`
  4. Run `npx vitest run --config vitest.fast.config.ts src/__tests__/channels/` (different domain)
  5. Assert no `execution/` tests appear
  6. Run domain-scoped execution with E2E config: `npx vitest run --config vitest.e2e.config.ts src/__tests__/execution/`
  7. Assert only E2E-tier execution tests run (if any exist in this domain)
  8. Run `time npx vitest run --config vitest.fast.config.ts src/__tests__/execution/` three times, average
  9. Assert average < 30s (performance target from feature spec)
- **Expected Result**:
  - Domain isolation: only the specified domain's tests execute
  - Cross-domain exclusion: tests from other domains do not appear
  - Tier respect: domain + config combination produces correct tier subset
  - Performance: domain unit tests complete in < 30s
- **Validation Context**: Manual execution after Phase 1 domains 1-2, automated in verification script
- **Covers**: FR-6

### VAL-6: Pre-push Hook Regression

- **Preconditions**:
  - Phase 5 (pre-push hook integration) complete
  - Baseline pre-push timing captured on a clean branch with a small source change
- **Steps**:
  1. Create a small source change (e.g., add a comment to one Runtime service file)
  2. Run `time .husky/pre-push` (full 7-step hook) and record wall-clock time
  3. Repeat 3 times on an idle machine, compute average
  4. Compare against baseline average
  5. Verify domain-aware targeting in Step 5 output: changed file should map to a domain, and only that domain's smoke tests should run (not full suite)
- **Expected Result**:
  - Average pre-push time <= baseline + 10% tolerance (feature spec: "no increase from current ~5min")
  - Domain-aware targeting correctly maps changed source files to test domains
  - All 7 hook steps pass
- **Validation Context**: Manual execution, 3 runs averaged
- **Covers**: FR-4 (backward compatibility)

### VAL-7: Rollback Safety — Representative Domain

- **Preconditions**:
  - One Runtime domain migration committed (e.g., `execution/`)
  - All tests passing after migration
- **Steps**:
  1. Record the migration commit hash
  2. Run `tools/verify-test-inventory.ts --verify --app runtime` — assert PASS
  3. Run `git revert <migration-commit-hash>` — assert clean revert (no merge conflicts)
  4. Run `tsc --noEmit --project apps/runtime/tsconfig.json` — assert no broken imports
  5. Run `tools/verify-test-inventory.ts --verify --app runtime` — assert PASS (original layout restored)
  6. Run `pnpm test:fast --filter=runtime` — assert all tests pass
  7. Run `git revert HEAD` (revert the revert) to restore migration
  8. Run `tools/verify-test-inventory.ts --verify --app runtime` — assert PASS (migration restored)
- **Expected Result**:
  - Domain migration commit is cleanly revertable
  - No broken import paths after revert
  - Full test parity both after revert and after re-application
  - `tsc --noEmit` passes in both states
- **Validation Context**: Manual execution, once after the first domain migration
- **Covers**: FR-9 (zero test loss — bidirectional)

---

## 3. Integration Test Scenarios

> These scenarios test the boundaries between vitest configuration, file discovery,
> setup file inheritance, the Studio orchestrator, and Turbo caching. They verify
> that the infrastructure components integrate correctly after restructuring.

### Execution Status Summary

| Scenario | Status | Evidence                                                                                                                                                                                                                              |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INT-1    | PASS   | Synthetic `_test-domain/` probe created with 3 tier files. Fast config correctly discovered only `sample.test.ts`. Found and fixed missing `**/*.integration.test.ts` exclude. E2E/integration configs correctly excluded unit files. |
| INT-2    | PASS   | Runtime/Studio inventory verification proved moved files are discovered at their new paths                                                                                                                                            |
| INT-3    | PASS   | Scripted relative-path rewrites plus follow-up import fixes were validated by package builds and targeted test runs                                                                                                                   |
| INT-4    | PASS   | `pnpm --dir apps/studio test -- --passWithNoTests` and path-filtered `stores/` run succeeded                                                                                                                                          |
| INT-5    | PASS   | `tools/verify-test-inventory.test.ts` and live `--verify` runs exercised orphan/missing-file detection                                                                                                                                |
| INT-6    | PASS   | `vitest.light.config.ts`, `vitest.unit.config.ts`, and `vitest.node.config.ts` all discovered the migrated Studio domains with the expected setup files                                                                               |
| INT-7    | PASS   | Turbo `inputs: ["src/**/*.ts"]` confirmed to recurse into domain subdirectories. Cache hit/miss behavior verified: unchanged committed state = cache hit, `--force` = cache bypass.                                                   |

### INT-1: Vitest Config File Discovery — Tier Separation in Domain Subdirectories

- **Boundary**: vitest glob patterns → file discovery engine → test file set
- **Setup**:
  - Create a temporary domain directory `src/__tests__/_test-domain/` with 3 files:
    - `sample.test.ts` (unit tier)
    - `sample.e2e.test.ts` (E2E tier)
    - `sample.integration.test.ts` (integration tier)
- **Steps**:
  1. Run `vitest --listTests --config vitest.fast.config.ts` — assert `sample.test.ts` appears, `sample.e2e.test.ts` and `sample.integration.test.ts` do NOT
  2. Run `vitest --listTests --config vitest.e2e.config.ts` — assert `sample.e2e.test.ts` appears (if config uses glob pattern), `sample.test.ts` does NOT
  3. Run `vitest --listTests --config vitest.integration.config.ts` — assert `sample.integration.test.ts` appears, `sample.test.ts` does NOT
  4. Remove `src/__tests__/_test-domain/`
- **Expected Result**:
  - Each config discovers only the files matching its tier convention
  - Files in domain subdirectories are correctly discovered by recursive glob patterns
- **Failure Mode**: If glob patterns don't recurse into subdirectories, domain files become invisible to the config
- **Covers**: FR-3, FR-5

### INT-2: Domain Directory Discovery — Vitest Finds All Moved Files

- **Boundary**: vitest config include patterns → directory traversal → test runner
- **Setup**:
  - Complete one domain migration (e.g., move `flow-*` files into `src/__tests__/execution/`)
- **Steps**:
  1. Run `vitest --listTests --config vitest.config.ts` (default Runtime config)
  2. Assert all moved files appear in the list at their new paths
  3. Assert no files appear at their old flat paths
  4. Run `npx vitest run src/__tests__/execution/` — assert all moved tests execute
  5. Assert test count matches the number of moved files
- **Expected Result**:
  - vitest discovers moved files at new paths via recursive glob
  - Old flat paths no longer appear (files moved, not copied)
  - Domain-scoped execution runs exactly the domain's files
- **Failure Mode**: Config include pattern does not recurse (`src/__tests__/*.test.ts` instead of `src/__tests__/**/*.test.ts`) — would miss files in subdirectories
- **Covers**: FR-1, FR-6

### INT-3: Cross-Directory Import Path Resolution

- **Boundary**: test file imports → TypeScript module resolution → shared fixtures/helpers
- **Setup**:
  - Identify a test file that imports from `./helpers/` or `./fixtures/` (~93 flat Runtime test files import from these shared directories; ~39 more in existing subdirectories use `../helpers/`)
  - Move it one level deeper into a domain directory
- **Steps**:
  1. Before move: run `tsc --noEmit --project apps/runtime/tsconfig.json` — assert passes
  2. Move test file from `src/__tests__/my-test.test.ts` to `src/__tests__/execution/my-test.test.ts`
  3. Update relative import paths (e.g., `./helpers/` → `../helpers/`, `./fixtures/` → `../fixtures/`)
  4. Run `tsc --noEmit --project apps/runtime/tsconfig.json` — assert passes
  5. Run the moved test file: `npx vitest run src/__tests__/execution/my-test.test.ts` — assert passes
  6. Verify ALL moved files with `./helpers/` or `./fixtures/` imports have been updated to `../helpers/` or `../fixtures/`
- **Expected Result**:
  - TypeScript compilation succeeds after import path updates
  - Test execution succeeds — fixtures/helpers resolve correctly at runtime
  - No broken `Cannot find module` errors
- **Failure Mode**: Relative import paths not updated during move — `tsc --noEmit` catches at compile time, vitest catches at runtime with `Cannot find module` error
- **Covers**: FR-7 (co-located tests use relative imports too)

### INT-4: Studio Orchestrator Sharding After Domain Restructuring

- **Boundary**: `run-tests-plan.ts` → vitest config include patterns → shard distribution
- **Setup**:
  - Complete Studio domain migration (Phase 3)
  - Studio test orchestrator (`run-tests.ts`) configured
- **Steps**:
  1. Run `pnpm test` on Studio (invokes `run-tests.ts`)
  2. Capture the execution plan output — should show:
     - 1 "Pure logic tests" phase (vitest.light.config.ts)
     - 2 "Component tests (shard N/2)" phases (vitest.unit.config.ts)
  3. Sum test counts across all 3 phases
  4. Compare against pre-migration total
  5. Verify that the 8 `.test.ts` files excluded from `vitest.light.config.ts` are still excluded after domain restructuring (they run in `vitest.unit.config.ts` or are skipped):
     - `agent-hooks.test.ts` (RTL — needs happy-dom)
     - `agent-ir-hook.test.ts` (RTL — needs happy-dom)
     - `behavior-section.test.ts` (RTL — needs happy-dom)
     - `data-hooks.test.ts` (RTL — needs happy-dom)
     - `section-edit-hook.test.ts` (RTL — needs happy-dom)
     - `session-hooks.test.ts` (RTL — needs happy-dom)
     - `channel-registry.test.ts` (dynamic import() hangs under forks pool)
     - `hooks/use-multi-page-progress.test.ts` (renderHook needs DOM)
  6. Verify sharding distributes files evenly (each shard within ±10% of other)
- **Expected Result**:
  - Same 3-phase execution plan
  - Same total test count across all phases
  - 6 RTL `.test.ts` files remain in component shards, not in pure-logic phase
  - Even shard distribution maintained
- **Failure Mode**: After domain restructuring, the light config's exclude patterns reference old flat paths — the 8 excluded files (6 RTL + channel-registry + use-multi-page-progress) would incorrectly run in the pure-logic (node) phase and fail because `React`/DOM is not available or dynamic imports hang
- **Covers**: FR-2, FR-4

### INT-5: Verification Script Correctness — Detects Orphaned and Missing Tests

- **Boundary**: `tools/verify-test-inventory.ts` → vitest --listTests → file system → diff logic
- **Setup**:
  - Capture a golden baseline with `--capture` flag
  - Artificially introduce a defect: remove one test file from all config include patterns (simulating an orphan)
- **Steps**:
  1. Run `tools/verify-test-inventory.ts --capture --app runtime` — assert creates baseline files
  2. Verify baseline directory structure:
     - `tools/test-baselines/runtime/vitest.config.txt` (sorted basenames)
     - `tools/test-baselines/runtime/vitest.fast.config.txt`
     - etc. for each config
  3. Introduce a defect: add a test file to disk that is excluded from all configs
  4. Run `tools/verify-test-inventory.ts --verify --app runtime`
  5. Assert exit code is non-zero
  6. Assert output identifies the orphaned file by name
  7. Fix the defect (add file to correct config)
  8. Re-run `--verify` — assert exit code 0
  9. Introduce a second defect: delete a test file that is still referenced in baseline
  10. Run `--verify` — assert exit code non-zero, identifies the missing file
- **Expected Result**:
  - Verification script detects orphaned files (on disk but not in any config)
  - Verification script detects missing files (in baseline but not on disk)
  - Clear error messages identifying problematic files
  - Exit code 0 only when all files are accounted for
- **Failure Mode**: Verification script uses full paths instead of basenames — would always fail because paths change during migration
- **Covers**: FR-9, FR-10

### INT-6: Studio Config Setup File Inheritance in Domain Subdirectories

- **Boundary**: vitest config `setupFiles` → test environment initialization → domain subdirectories
- **Setup**:
  - Move a `.test.tsx` file (component test) from flat `src/__tests__/` into a domain subdirectory (e.g., `src/__tests__/components/`)
  - Move a `.test.ts` file (pure logic) into a different domain subdirectory (e.g., `src/__tests__/stores/`)
- **Steps**:
  1. After move: run the component test via `npx vitest run --config vitest.unit.config.ts src/__tests__/components/<file>`
  2. Assert setup.tsx was loaded (happy-dom environment, React Testing Library available)
  3. Run the pure-logic test via `npx vitest run --config vitest.light.config.ts src/__tests__/stores/<file>`
  4. Assert setup-light.ts was loaded (node environment, no DOM APIs)
  5. Run an API test via `npx vitest run --config vitest.node.config.ts src/__tests__/api-routes/<file>`
  6. Assert setup-node.ts was loaded (node environment, server-only stub active)
  7. Verify `vitest-force-exit.ts` globalSetup still triggers for all configs that reference it
- **Expected Result**:
  - Each config's `setupFiles` applies to tests in domain subdirectories (vitest resolves setupFiles relative to config root, not test file location)
  - Tests behave identically before and after move
  - No `ReferenceError: React is not defined` or `ReferenceError: document is not defined` errors
- **Failure Mode**: `setupFiles` resolution is path-dependent — if vitest resolves relative to test file, subdirectory tests wouldn't find setup files (vitest actually resolves relative to config root, so this should work — but must be verified)
- **Covers**: FR-2

### INT-7: Turbo Cache Invalidation After Domain Migration

- **Boundary**: Turbo file hashing → `inputs: ["src/**/*.ts"]` → cache key → test task execution
- **Setup**:
  - Complete one full domain migration
  - Run `pnpm turbo test:fast --filter=runtime` twice to populate cache
- **Steps**:
  1. Run `pnpm turbo test:fast --filter=runtime` — should be a cache HIT (second run)
  2. Make a small source change in `apps/runtime/src/services/execution/` (e.g., add a comment)
  3. Run `pnpm turbo test:fast --filter=runtime` — should be a cache MISS (input changed)
  4. Assert tests execute (not served from cache)
  5. Run again — should be a cache HIT (same inputs now)
  6. Verify that changes to `apps/studio/src/` do NOT invalidate Runtime's test cache
- **Expected Result**:
  - Turbo correctly detects source changes after domain restructuring
  - Cache invalidation is package-scoped (Runtime change doesn't invalidate Studio cache)
  - File moves (new paths under `src/`) are correctly hashed by Turbo
- **Failure Mode**: Turbo's input glob doesn't traverse new domain subdirectories — would cause stale cache hits after migration. Unlikely since `src/**/*.ts` already recurses, but must be verified.
- **Covers**: FR-1 (indirectly — ensures Turbo works with new layout)

---

## 4. Unit Test Scenarios

### Execution Status Summary

| Scenario | Status | Evidence                              |
| -------- | ------ | ------------------------------------- |
| UT-1     | PASS   | `tools/verify-test-inventory.test.ts` |
| UT-2     | PASS   | `tools/verify-test-inventory.test.ts` |
| UT-3     | PASS   | `tools/verify-test-inventory.test.ts` |

### Additional Automated Coverage

- `tools/migrate-test-files.test.ts` verifies migration plan application and relative-path rewriting.
- `apps/studio/src/__tests__/run-tests-plan.test.ts` verifies repo-root path normalization and `--passWithNoTests` deduplication in the split runner.

### UT-1: Verification Script — Basename Extraction Logic

- **Module**: `tools/verify-test-inventory.ts` — basename extraction and comparison functions
- **Input**:
  - Pre-migration path list: `['src/__tests__/flow-execution.test.ts', 'src/__tests__/channel-adapter.test.ts']`
  - Post-migration path list: `['src/__tests__/execution/flow-execution.test.ts', 'src/__tests__/channels/channel-adapter.test.ts']`
- **Expected Output**:
  - Extracted basenames: `['flow-execution.test.ts', 'channel-adapter.test.ts']` (both lists)
  - Comparison result: MATCH (same basenames, different paths — expected after migration)

### UT-2: Verification Script — Duplicate Basename Detection

- **Module**: `tools/verify-test-inventory.ts` — duplicate detection
- **Input**:
  - File list with duplicate basenames: `['src/__tests__/execution/auth.test.ts', 'src/__tests__/auth/auth.test.ts']`
- **Expected Output**:
  - WARNING: duplicate basename `auth.test.ts` found in multiple domains
  - Verification should still pass but log a warning (duplicates are valid if intentional)

### UT-3: Verification Script — Config File Parsing

- **Module**: `tools/verify-test-inventory.ts` — config discovery
- **Input**: App directory `apps/runtime/`
- **Expected Output**:
  - Discovers all 9 vitest config files matching `vitest*.config.ts`
  - Correctly invokes `vitest --listTests --config <config>` for each
  - Handles configs with no matching files gracefully (exit code 0, count 0)

---

## 5. Security & Isolation Tests

This feature is infrastructure-only (test file organization and vitest config changes). It does not modify runtime code, API endpoints, data models, or auth flows. Security and isolation tests are not applicable.

| Concern                                 | Applicability | Justification                                                                 |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| Cross-tenant access returns 404         | N/A           | No tenant-scoped operations — test files are not deployed                     |
| Cross-project access returns 404        | N/A           | No project-scoped operations                                                  |
| Cross-user access returns 404           | N/A           | No user-scoped resources                                                      |
| Missing auth returns 401                | N/A           | No HTTP endpoints added or modified                                           |
| Insufficient perms returns 403          | N/A           | No permission checks added or modified                                        |
| Input validation rejects malformed data | N/A           | Verification script inputs are file paths from vitest, not user-supplied data |

---

## 6. Performance & Load Tests

| Metric                          | Target                         | How Measured                                                                                           | When Verified             |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| Single domain unit tests        | <30s                           | `time npx vitest run --config vitest.fast.config.ts src/__tests__/<domain>/` (3 runs, averaged)        | After Phase 1 domains 1-2 |
| Single domain integration tests | <60s                           | `time npx vitest run --config vitest.integration.config.ts src/__tests__/<domain>/` (3 runs, averaged) | After Phase 2             |
| Runtime smoke tests             | <15s                           | `time pnpm test:smoke` (3 runs, averaged)                                                              | After Phase 2             |
| Pre-push total time             | No increase from current ~5min | `time .husky/pre-push` with a small source change (3 runs, averaged)                                   | After Phase 5             |
| Full suite execution time       | No increase                    | `time pnpm test` per app (3 runs, averaged)                                                            | After each major phase    |
| vitest --listTests overhead     | <5s per config                 | `time vitest --listTests --config <config>` (file discovery only)                                      | After Phase 0             |

**Important caveats:**

- Performance measurements should be run 3 times on an idle machine and averaged (vitest startup and glob resolution are noisy)
- The first run after a migration commit will be uncached (Turbo cache invalidated by file moves) — measure second-run performance for fair comparison
- Pre-push hook timing after a migration commit will naturally be longer (all files changed) — measure on a clean branch with a small unrelated change

---

## 7. Test Infrastructure

### Required Services

None. This feature restructures test file layout and vitest configuration. No external services (MongoDB, Redis, Docker) are required for validation scenarios. The verification script (`tools/verify-test-inventory.ts`) uses `vitest --listTests` which only discovers files without executing tests.

### Data Seeding / Golden Baseline

- **Baseline capture**: Run `tools/verify-test-inventory.ts --capture --app <runtime|studio>` before migration begins
- **Baseline storage**: `tools/test-baselines/<app>/<config-name>.txt` — gitignored (add to `.gitignore`)
- **Baseline format**: One test file basename per line, sorted alphabetically
- **Baseline refresh**: Re-capture after each phase to establish the new baseline for the next phase. During implementation, Studio was intentionally refreshed once more after narrowing the node lane from 294 files to 114 files.

### Environment Variables

None required. The verification script reads vitest config files and invokes `vitest --listTests` which inherits the existing test environment configuration.

### CI Configuration

The verification script should be CI-ready (non-interactive, exit codes for pass/fail) but wiring it into the Harness pipeline is out of scope for this feature (tracked separately in `docs/features/cicd-pipeline.md`). The script must work on:

- **Local**: macOS, Node 24+, pnpm 8.x
- **CI**: `node:24-bookworm` container, 12Gi memory, 4 CPUs

---

## 8. Test File Mapping

| Test File / Command                                                                               | Type               | Covers                                  |
| ------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------- |
| `tools/verify-test-inventory.ts`                                                                  | validation script  | FR-9, FR-10, VAL-1, VAL-2, VAL-3, INT-2 |
| `tools/verify-test-inventory.test.ts`                                                             | unit               | UT-1, UT-2, UT-3, INT-5                 |
| `tools/migrate-test-files.test.ts`                                                                | unit               | Migration-plan safety checks            |
| `apps/studio/src/__tests__/run-tests-plan.test.ts`                                                | unit               | FR-4, FR-6, INT-4                       |
| `pnpm --dir apps/runtime test:smoke`                                                              | manual validation  | VAL-4                                   |
| `pnpm --dir apps/runtime test:fast`                                                               | manual validation  | VAL-4, VAL-5                            |
| `pnpm --dir apps/runtime exec vitest run --config vitest.fast.config.ts src/__tests__/execution/` | manual validation  | VAL-5, INT-2                            |
| `pnpm --dir apps/studio test -- apps/studio/src/__tests__/stores/ --passWithNoTests`              | manual validation  | VAL-5, INT-4                            |
| `pnpm --dir apps/studio test -- --passWithNoTests`                                                | manual validation  | VAL-4, INT-4                            |
| `pnpm --dir apps/studio test:node -- --passWithNoTests --reporter=dot`                            | manual validation  | VAL-2, VAL-4, INT-6                     |
| `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio`                     | manual integration | INT-3, INT-6                            |
| `bash -n .husky/pre-push`                                                                         | manual validation  | VAL-6                                   |
| Manual: `git revert <phase-commit>` round-trip                                                    | manual rollback    | VAL-7 (deferred)                        |
| Manual: create temp `_test-domain/` with 3 tier files                                             | manual integration | INT-1 (deferred)                        |
| Manual: `pnpm turbo test:fast` cache hit/miss check                                               | manual integration | INT-7 (deferred)                        |

---

## 9. Open Testing Questions

1. Should the verification script compare test **case counts** (number of `test()` calls) in addition to test **file** basenames? File-level comparison catches dropped files but not dropped test cases within a file (e.g., if a move accidentally truncates a file).

2. The 6 duplicate test files that appear in multiple Runtime configs (e.g., `sdk-bootstrap-auth.integration.test.ts` in both `vitest.e2e.config.ts` and `vitest.sdk-auth.config.ts`) — how should the verification script handle these? Count them once (basename-based) or per-config?

3. Some test files previously used inconsistent naming (`attachment-advanced-e2e.test.ts` before normalization, `module-concurrency.e2e.test.ts` after normalization). Should the migration standardize these names, or should the glob patterns accommodate both? Standardizing names would change basenames and complicate FR-10 verification.

4. Runtime's `pre-refactor/` directory (23 legacy files) has its own `fixtures/` and `helpers/` subdirectories with internal relative imports. If these files are distributed to domain directories, their internal import structure breaks. Should they be migrated as a unit to a single domain, or distributed with import rewrites?

5. Should performance validation (§6) be formalized as a CI gate, or remain manual? Formalizing it risks flaky CI failures from measurement noise, but leaving it manual risks regressions going unnoticed.
