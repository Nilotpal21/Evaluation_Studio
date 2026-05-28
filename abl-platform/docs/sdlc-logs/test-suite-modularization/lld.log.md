# SDLC Log: Test Suite Modularization — LLD Phase

**Feature**: test-suite-modularization
**Phase**: LLD
**Feature Spec**: `docs/features/test-suite-modularization.md`
**HLD**: `docs/specs/test-suite-modularization.hld.md`
**Test Spec**: `docs/testing/test-suite-modularization.md`
**LLD**: `docs/plans/2026-03-27-test-suite-modularization-impl-plan.md`
**Date**: 2026-03-27

---

## Prerequisite Read

- [x] Feature spec read fresh from disk
- [x] HLD read fresh from disk
- [x] Test spec read fresh from disk
- [x] Runtime Vitest configs, Runtime package scripts, Studio Vitest configs, Studio runner, pre-push hook, and Runtime `TEST_INDEX.md` read fresh from disk
- [x] Current test directory inventories for Runtime and Studio captured from disk

## Clarifying Questions & Classifications

### Implementation Strategy

1. **What implementation order is safest?**
   - **DECIDED**: Verification tooling first, then Runtime migration, then Studio migration, then pre-push wiring.
2. **Should we preserve the default `vitest.config.ts` entrypoint?**
   - **ANSWERED**: Yes. Both the feature spec and current package scripts depend on `pnpm test`.
3. **Should specialty Runtime lanes stay as dedicated config files?**
   - **DECIDED**: No. Keep the scripts, but collapse the configs to the FR-5 target.
4. **Should support directories (`helpers`, `fixtures`, `stress`, `e2e`) become domains?**
   - **DECIDED**: No. Keep them as top-level non-domain support buckets.
5. **Should Studio get a new bespoke domain-runner mode?**
   - **DECIDED**: No. Forward path filters through the existing split runner.

### Technical Details

1. **Which files definitely change?**
   - **ANSWERED**: Runtime and Studio Vitest configs, both package manifests, Studio runner files, pre-push hook, Runtime `TEST_INDEX.md`, new verification tool/tests, and the moved test files.
2. **How large is the migration surface?**
   - **ANSWERED**: Runtime has 570 top-level tests out of 776 total; Studio has 232 top-level tests out of 271 total.
3. **Can this be done with manual moves?**
   - **ANSWERED**: No. Runtime alone has 741 files with relative imports; path rewriting must be scripted.
4. **Do baselines already exist?**
   - **ANSWERED**: No. `tools/verify-test-inventory.ts` and `docs/sdlc-logs/test-suite-modularization/implementation.log.md` are both missing today.
5. **Is Runtime `TEST_INDEX.md` real or just spec text?**
   - **ANSWERED**: Real. It currently lives at `apps/runtime/src/__tests__/TEST_INDEX.md`.

### Risk & Dependencies

1. **Are there unrelated worktree changes?**
   - **ANSWERED**: Yes. The repo is already dirty, including one Studio test file inside this feature area.
2. **What is the biggest technical risk?**
   - **DECIDED**: Broken relative paths after file moves.
3. **What is the biggest behavioral risk?**
   - **DECIDED**: Silent test loss caused by overly broad or overly narrow post-migration globs.
4. **What must stay stable for developers?**
   - **ANSWERED**: `pnpm test`, `pnpm test:fast`, `pnpm test:smoke`, `pnpm test:e2e`, `pnpm test:integration`, Studio split-run behavior, and smoke/pre-push ergonomics.
5. **What is the definition of done?**
   - **DECIDED**: Both apps pass lane-parity verification, Runtime is at 5 or fewer configs, and domain-scoped runs work without manual path surgery.

## Review Rounds

| Round | Focus                   | Verdict | Notes                                                                                         |
| ----- | ----------------------- | ------- | --------------------------------------------------------------------------------------------- |
| 1     | Architecture compliance | PASS    | Adjusted plan to keep five Runtime configs while preserving script aliases                    |
| 2     | Pattern consistency     | PASS    | Matched Studio split-runner pattern instead of inventing a second runner                      |
| 3     | Completeness            | PASS    | Added dirty-worktree handling and explicit delete list for deprecated Runtime configs         |
| 4     | Cross-phase consistency | PASS    | LLD phases aligned with feature-spec delivery plan and HLD lane model                         |
| 5     | Final sweep             | PASS    | Added scripted-path-rewrite decision and explicit acceptance criteria for parity verification |

## Findings & Resolutions

- **Finding**: The feature spec assumed a missing `TEST_INDEX.md` path was ambiguous.
  - **Resolution**: Verified the file exists at `apps/runtime/src/__tests__/TEST_INDEX.md` and updated the LLD around that real location.
- **Finding**: Runtime config-count reduction conflicts with preserving specialty scripts.
  - **Resolution**: Keep scripts, remove config files, and back the scripts with primary-config path filters.
- **Finding**: The migration surface is much larger than the feature summary suggests because relative imports are pervasive.
  - **Resolution**: Make scripted relative-path rewriting a first-class implementation decision and phase prerequisite.

## Commit Target

- Planned commit message: `[ABLP-2] docs(testing): add test-suite-modularization LLD + execution logs`
