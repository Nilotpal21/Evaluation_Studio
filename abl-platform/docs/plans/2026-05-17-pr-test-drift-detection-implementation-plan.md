# PR Test Drift Detection Implementation Plan

**Status**: Implementation guidance captured
**Date**: 2026-05-17
**Scope**: Fast PR detection for test drift caused by changed production code, stale assertions, and internal module mock export gaps.

## 1. Goals

- Add a fast PR gate, `pnpm test:changed:pr`, that catches affected tests without running the full deterministic runtime lane.
- Detect mock export drift only when the PR diff creates real risk, avoiding full-repo false positives.
- Preserve the repo's existing testing architecture: prefer dependency injection and pure-function extraction over adding internal module mocks.
- Keep timing and WebSocket handler regressions classified as runtime investigation work, not static lint findings.

## 2. Non-Goals

- Do not hard-code `origin/main`; this repo tracks `origin/develop` and existing scripts resolve upstream first.
- Do not add a blanket `importOriginal()` requirement for every internal mock.
- Do not run full deterministic, integration, or E2E lanes as part of this fast detector unless the existing changed-test planner selects them.
- Do not treat static detection as a replacement for diagnosing timing, async, or handler-state regressions.

## 3. Design Decisions

| #   | Decision                                                                    | Rationale                                                                                                                           |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Use upstream-or-`origin/develop` as the changed-test base.                  | Matches `.husky/pre-push.bash` and `tools/local-verify.sh`; avoids incorrect `origin/main` assumptions.                             |
| D-2 | Run affected build before changed tests.                                    | Required by `AGENTS.md`: Turbo tests can fail against stale compiled output.                                                        |
| D-3 | Wire the PR command as `pnpm test:changed:pr`.                              | Reuses package/domain mapping, runtime smoke fallback, and heavy package handling already maintained in the repo.                   |
| D-4 | Add a diff-scoped mock drift checker, not a full-repo export snapshot lint. | Full-repo checking flags intentionally unmocked exports and creates noise.                                                          |
| D-5 | Compare runtime value exports only.                                         | Type-only exports do not need to be present in Vitest mock factories.                                                               |
| D-6 | Treat internal mock drift as a refactor signal first.                       | Aligns with `CLAUDE.md` and `.claude/hooks/platform-mock-lint.sh`: fix code testability with DI or pure extraction where practical. |

## 4. File-Level Change Map

### New Files

| File                                                        | Purpose                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tools/mock-export-drift-check.mjs`                         | Diff-scoped detector for risky internal mock export drift.                                |
| `tools/mock-export-drift-fixtures/` or inline fixture tests | Small self-check fixtures for the detector if a script-level test pattern already exists. |

### Modified Files

| File                                                                                           | Change                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                                                                 | Add `test:changed:pr` and `lint:mock-export-drift` scripts.                                                        |
| `tools/local-verify.sh`                                                                        | Optionally call mock drift checker during `test` / `all`, after changed-file collection and before running Vitest. |
| `.husky/pre-push.bash`                                                                         | Optionally add the mock drift checker as a fast independent check, gated by changed TS test/source files.          |
| `docs/testing/governance.md` or `docs/architecture/runtime-deterministic-test-architecture.md` | Document the changed-test lane and mock drift detector boundaries.                                                 |

## 5. Implementation Phases

### Phase 1: Changed-Test PR Gate

**Goal**: Establish the fast PR test lane using the repo's actual base-ref and build order.

**Tasks**:

1. Add a root script that resolves the base ref the same way existing tooling does:
   - `git rev-parse @{upstream}`
   - fallback to `origin/develop`
2. Ensure the script runs affected build before tests.
3. Delegate `pnpm test:changed:pr` to `bash tools/local-verify.sh test <base-ref>` unless direct Vitest `--changed` proves materially better.
4. If direct Vitest is used, run it with the relevant package config, for example runtime config when runtime is affected.

**Exit Criteria**:

- `pnpm test:changed:pr` resolves `origin/develop` on this branch.
- No references to `origin/main` are introduced.
- Build runs before tests.
- No tests found is handled intentionally only where the package/domain planner expects that behavior.

**Verification**:

- `bash tools/local-verify.sh plan origin/develop`
- `pnpm test:changed:pr` on a small source-only diff

### Phase 2: Diff-Scoped Mock Export Drift Checker

**Goal**: Catch the mock drift class without full-repo noise.

**Detector Inputs**:

- Base ref from upstream or `origin/develop`.
- Changed production files under `apps/*/src` and `packages/*/src`.
- Changed test files when relevant.
- Existing test files that mock changed modules.

**Signal A: Newly Added Value Export**

Flag when:

- A production module adds a new value export in the PR diff.
- At least one test mocks that exact module via `vi.mock('./relative-or-resolved-path', factory)`.
- The mock factory returns an object that omits the new value export.

**Signal B: Newly Introduced Named Import From Mocked Module**

Flag when:

- A changed production or test file adds a named import from an internal module.
- A test in the affected set mocks that module.
- The mock factory omits the newly imported runtime value.

**Implementation Notes**:

- Resolve `.js` ESM specifiers to `.ts` source files.
- Add test files explicitly; `apps/runtime/tsconfig.json` excludes `src/__tests__`.
- Use the TypeScript compiler API or `ts-morph`, but add any dependency at the root or implement without a new dependency. `ts-morph` currently appears only in `packages/helix`.
- Filter exports/imports to runtime values; ignore interfaces, type aliases, and `import type`.
- Only inspect internal relative imports for this detector. Platform package mocks are already blocked or warned by existing policy hooks.
- Print actionable output: test file, mock target, missing value export, and the diff line or nearest location.

**Exit Criteria**:

- No findings on current unchanged tree.
- A fixture with an added value export and stale mock fails.
- A fixture with only a new type export passes.
- A fixture with `importOriginal()` plus override passes.
- A fixture with a full mock exemption comment either passes or reports as warning, depending on chosen policy.

**Verification**:

- `pnpm lint:mock-export-drift -- --base origin/develop`
- Script-level fixture test or dry-run fixture command

### Phase 3: CI and Pre-Push Wiring

**Goal**: Make the checks visible before merge without lengthening local workflows unnecessarily.

**Tasks**:

1. Add `lint:mock-export-drift` root script.
2. Add `test:changed:pr` root script.
3. Wire the mock drift checker into `.husky/pre-push.bash` as a fast check only when changed files include TS/TSX source or test files.
4. Add CI job step:
   - affected build
   - changed-test PR lane
   - mock export drift checker
5. Keep existing skip controls consistent with current pre-push naming, for example `SKIP_TESTS=1` or a specific `SKIP_MOCK_DRIFT=1`.

**Exit Criteria**:

- Pre-push output identifies the mock drift step clearly.
- CI logs show the resolved base ref.
- The check completes quickly on a no-risk docs-only diff.
- The check fails with actionable output on a simulated stale mock.

### Phase 4: Documentation and Operating Guidance

**Goal**: Prevent future confusion about what each detector catches.

**Tasks**:

1. Document that the changed-test lane catches stale assertions and many mock-drift failures when the changed file is in the dependency graph.
2. Document that the mock drift checker catches residual static risk from newly added value exports or newly introduced imports.
3. Document that internal mock drift should usually trigger production refactoring for testability.
4. Document exclusions:
   - timing regressions
   - WebSocket handler state bugs
   - tests outside selected configs
   - dynamic imports that Vitest cannot relate

**Exit Criteria**:

- Documentation names upstream-base / `origin/develop` fallback behavior and avoids `origin/main` examples.
- Documentation does not claim these detectors catch every regression.
- Documentation points engineers to focused Vitest diagnosis for handler/timing failures.

## 6. Acceptance Criteria

- `pnpm build` or affected build runs before the changed-test lane.
- Fast PR lane runs without full deterministic runtime tests.
- Mock drift checker is diff-scoped and low-noise.
- Type-only exports do not fail the checker.
- Internal module mock failures are presented as testability/refactor signals, not just "patch the mock."
- WebSocket timing failures are explicitly outside the static detector claim.

## 7. Rollback Plan

- Remove CI/pre-push calls to the new scripts first.
- Keep the scripts in the repo for manual diagnosis if useful.
- If the mock drift checker is noisy, change it to warning-only while preserving the changed-test PR lane.

## 8. Resolved and Open Questions

**Resolved**: The known PR commands are `pnpm test:changed:pr` for the changed-test lane and `pnpm lint:mock-export-drift` for the mock-export drift detector.

**Open**:

1. Should full internal relative mocks be allowed with an explicit exemption comment, or should all new relative mocks remain warning-only under the existing policy?
2. Where should CI define the PR base ref for Bitbucket pipelines or the current CI provider?
3. Should `ts-morph` be promoted to a root dev dependency, or should the detector use the TypeScript compiler API directly?
