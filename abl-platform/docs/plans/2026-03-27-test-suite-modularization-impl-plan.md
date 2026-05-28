# LLD: Test Suite Modularization for Incremental Execution

**Feature Spec**: `docs/features/test-suite-modularization.md`
**HLD**: `docs/specs/test-suite-modularization.hld.md`
**Test Spec**: `docs/testing/test-suite-modularization.md`
**Status**: DONE
**Date**: 2026-03-27

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                                         | Rationale                                                                                                                                                               | Alternatives Rejected                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Keep five primary Runtime configs: `vitest.config.ts`, `vitest.fast.config.ts`, `vitest.smoke.config.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts` | Satisfies FR-5 while preserving the default `pnpm test` entrypoint and the existing smoke lane                                                                          | Keeping `vitest.flaky.config.ts`, `vitest.sdk-auth.config.ts`, `vitest.connector-e2e.config.ts`, and `vitest.afg-e2e.config.ts` as separate config files would leave Runtime above the FR-5 cap |
| D-2 | Preserve specialty Runtime scripts by converting them to path-filtered aliases over the five primary configs                                                     | Keeps developer workflows (`test:flaky`, `test:sdk-auth`) without keeping dedicated configs on disk                                                                     | Removing the scripts entirely would create unnecessary workflow regression                                                                                                                      |
| D-3 | Use a command-lane inventory tool (`tools/verify-test-inventory.ts`) instead of comparing only raw config files                                                  | Runtime lanes will be implemented by a mix of primary configs and path filters after consolidation; comparing lanes preserves parity even when config files are removed | Comparing only config filenames would make it impossible to prove parity for merged lanes                                                                                                       |
| D-4 | Perform test moves with scripted relative-path rewriting                                                                                                         | `apps/runtime/src/__tests__` currently has 570 top-level tests and 741 files with relative imports; manual moves would be error-prone and slow                          | Manual `git mv` plus ad-hoc fixes would not scale to the actual move surface                                                                                                                    |
| D-5 | Standardize tier names to dotted conventions where needed: `*.e2e.test.ts` and `*.integration.test.ts`                                                           | Lets Runtime and Studio tier configs rely on convention-based globs instead of enumerating file paths                                                                   | Supporting only mixed hyphenated names would keep complex include/exclude rules                                                                                                                 |
| D-6 | Keep `helpers/`, `fixtures/`, `stress/`, and cross-domain `e2e/` as top-level support buckets                                                                    | These directories are orthogonal to domain ownership and are already referenced heavily by tests                                                                        | Forcing them into domain trees would increase churn without improving discoverability                                                                                                           |
| D-7 | Extend Studio’s split runner by forwarding a positional domain path, not by inventing a new runner mode                                                          | Keeps `run-tests.ts` and `run-tests-plan.ts` aligned with current CLI semantics and Vitest behavior                                                                     | A bespoke Studio-only `--domain=<name>` execution engine would duplicate Vitest filtering logic                                                                                                 |

### Key Interfaces & Types

```typescript
type TargetApp = 'runtime' | 'studio';

interface InventoryLane {
  app: TargetApp;
  label: string;
  cwd: string;
  args: string[];
  kind: 'config' | 'script-alias';
}

interface InventorySnapshot {
  app: TargetApp;
  capturedAt: string;
  lanes: Array<{
    label: string;
    basenames: string[];
    count: number;
    paths: string[];
  }>;
}

interface ForwardedDomainArgs {
  passthroughArgs: string[];
  pathFilters: string[];
}
```

### Module Boundaries

| Module                                     | Responsibility                                                        | Depends On                                          |
| ------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `tools/verify-test-inventory.ts`           | Capture and verify test discovery parity per app/lane                 | `child_process`, filesystem, Vitest CLI             |
| `apps/runtime/vitest*.config.ts`           | Convention-based Runtime tier selection                               | standardized filenames, Runtime domain directories  |
| `apps/runtime/package.json`                | Runtime script aliases for specialty lanes after config consolidation | primary Runtime configs                             |
| `apps/runtime/src/__tests__/TEST_INDEX.md` | Human-readable domain-to-file map after Runtime moves                 | new Runtime directory layout                        |
| `apps/studio/vitest*.config.ts`            | Domain-aware Studio tier selection by directory and suffix            | standardized filenames, Studio domain directories   |
| `apps/studio/run-tests-plan.ts`            | Path/domain forwarding into light + unit split execution              | Studio configs, forwarded CLI args                  |
| `apps/studio/run-tests.ts`                 | Execution of the updated Studio plan                                  | `run-tests-plan.ts`                                 |
| `.husky/pre-push`                          | Domain-aware Runtime/Studio pre-push targeting                        | new directory conventions, existing diff-aware gate |

---

## 2. File-Level Change Map

### New Files

| File                                                             | Purpose                                                               | LOC Estimate |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| `docs/plans/2026-03-27-test-suite-modularization-impl-plan.md`   | LLD and phased execution plan                                         | ~260         |
| `docs/sdlc-logs/test-suite-modularization/lld.log.md`            | LLD decision + review log                                             | ~120         |
| `docs/sdlc-logs/test-suite-modularization/implementation.log.md` | Implementation execution log                                          | ~220         |
| `tools/verify-test-inventory.ts`                                 | Lane-based test inventory capture/verify CLI                          | ~300         |
| `tools/verify-test-inventory.test.ts`                            | Unit coverage for basename extraction, lane resolution, parity checks | ~180         |
| `apps/runtime/src/__tests__/execution/**`                        | Runtime execution-domain homes for moved tests                        | mechanical   |
| `apps/runtime/src/__tests__/channels/**`                         | Runtime channels-domain homes for moved tests                         | mechanical   |
| `apps/runtime/src/__tests__/auth/**`                             | Runtime auth-domain homes for moved tests                             | mechanical   |
| `apps/runtime/src/__tests__/extraction/**`                       | Runtime extraction-domain homes for moved tests                       | mechanical   |
| `apps/runtime/src/__tests__/routing/**`                          | Runtime routing-domain homes for moved tests                          | mechanical   |
| `apps/runtime/src/__tests__/sessions/**`                         | Runtime sessions-domain homes for moved tests                         | mechanical   |
| `apps/runtime/src/__tests__/tools-deployment/**`                 | Runtime tools/deployment-domain homes for moved tests                 | mechanical   |
| `apps/studio/src/__tests__/api-routes/**`                        | Studio API route domain                                               | mechanical   |
| `apps/studio/src/__tests__/components/**`                        | Studio component domain                                               | mechanical   |
| `apps/studio/src/__tests__/stores/**`                            | Studio stores/logic domain                                            | mechanical   |
| `apps/studio/src/__tests__/arch-ai/**`                           | Studio Arch AI domain                                                 | mechanical   |

### Modified Files

| File                                                  | Change Description                                                                           | Risk   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/package.json`                           | Replace specialty config-backed scripts with primary-config aliases and updated path filters | Medium |
| `apps/runtime/vitest.config.ts`                       | Recursive, convention-based default lane excludes                                            | High   |
| `apps/runtime/vitest.fast.config.ts`                  | Recursive domain globs; tier-only exclusions                                                 | High   |
| `apps/runtime/vitest.integration.config.ts`           | Recursive `*.integration.test.ts` selection plus retained special-case exclusions            | High   |
| `apps/runtime/vitest.e2e.config.ts`                   | Recursive `*.e2e.test.ts` selection plus single-worker semantics                             | High   |
| `apps/runtime/vitest.smoke.config.ts`                 | Update curated smoke file paths after moves/renames                                          | Medium |
| `apps/runtime/src/__tests__/TEST_INDEX.md`            | Replace flat index with domain-organized map and quick-reference sections                    | Medium |
| `apps/runtime/src/__tests__/**/*.test.ts`             | Runtime file moves and relative-path rewrites                                                | High   |
| `apps/runtime/src/__tests__/**/*.integration.test.ts` | Runtime moves/renames and relative-path rewrites                                             | High   |
| `apps/runtime/src/__tests__/**/*.e2e.test.ts`         | Runtime moves/renames and relative-path rewrites                                             | High   |
| `apps/studio/package.json`                            | Preserve current scripts while reflecting domain-aware runner behavior                       | Low    |
| `apps/studio/vitest.config.ts`                        | Recursive includes/excludes aligned to domain layout                                         | Medium |
| `apps/studio/vitest.light.config.ts`                  | Directory-aware light-tier selection                                                         | Medium |
| `apps/studio/vitest.unit.config.ts`                   | Directory-aware component/hook selection                                                     | Medium |
| `apps/studio/vitest.node.config.ts`                   | Directory-aware node-tier selection                                                          | Medium |
| `apps/studio/run-tests-plan.ts`                       | Forward domain/path filters into all split commands                                          | Medium |
| `apps/studio/run-tests.ts`                            | Preserve delegation/split behavior with forwarded args                                       | Low    |
| `apps/studio/src/__tests__/**/*.test.ts`              | Studio file moves and relative-path rewrites                                                 | High   |
| `apps/studio/src/__tests__/**/*.test.tsx`             | Studio file moves and relative-path rewrites                                                 | High   |
| `.husky/pre-push`                                     | Domain-aware mapping for Runtime/Studio changed paths                                        | Medium |
| `apps/runtime/agents.md`                              | Append package learnings from migration work                                                 | Low    |
| `apps/studio/agents.md`                               | Append package learnings from migration work                                                 | Low    |

### Deleted Files

| File                                          | Reason                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `apps/runtime/vitest.flaky.config.ts`         | Replaced by `test:flaky` script alias over primary Runtime configs    |
| `apps/runtime/vitest.sdk-auth.config.ts`      | Replaced by `test:sdk-auth` script alias over primary Runtime configs |
| `apps/runtime/vitest.connector-e2e.config.ts` | Merged into Runtime E2E lane selection                                |
| `apps/runtime/vitest.afg-e2e.config.ts`       | Merged into Runtime integration/E2E lane selection                    |

---

## 3. Implementation Phases

### Phase 1: Verification Foundation & Tier Normalization

**Goal**: Create the parity tooling and normalize tier naming so later config simplification can be validated instead of guessed.

**Tasks**:
1.1. Add `tools/verify-test-inventory.ts` with runtime/studio lane definitions, `--capture`, and `--verify`.
1.2. Add `tools/verify-test-inventory.test.ts` covering lane resolution, basename extraction, duplicate detection, and mismatch reporting.
1.3. Capture the current Runtime and Studio baselines into `tools/test-baselines/<app>/` (gitignored artifacts).
1.4. Rename non-conforming Runtime/Studio `-e2e.test.ts` and `-integration.test.ts` files to dotted suffixes where required for the new globs.
1.5. Update references/scripts that point at renamed files before any directory moves begin.

**Files Touched**:

- `tools/verify-test-inventory.ts` — new CLI
- `tools/verify-test-inventory.test.ts` — new tests
- `apps/runtime/package.json` — renamed file references if needed
- `apps/runtime/vitest*.config.ts` — renamed file references if needed
- `apps/studio/src/__tests__/**/*.e2e.test.ts` — normalization

**Exit Criteria**:

- [x] `npx tsx tools/verify-test-inventory.ts --capture --app runtime` succeeds
- [x] `npx tsx tools/verify-test-inventory.ts --capture --app studio` succeeds
- [x] `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio` succeeds
- [x] `pnpm test --filter=@agent-platform/runtime -- tools/verify-test-inventory.test.ts` or equivalent targeted verification test succeeds
- [x] All renamed tier files still appear in their expected baseline lanes

**Test Strategy**:

- Unit: `tools/verify-test-inventory.test.ts`
- Integration: `tools/verify-test-inventory.ts --capture/--verify` against the live repo

**Rollback**: Revert the tooling and filename normalization commit; restore baselines by re-running capture from the pre-change tree.

---

### Phase 2: Runtime Domain Migration A

**Goal**: Move the heaviest Runtime domain groups into their new homes with scripted path rewriting: execution, channels, auth, and observability.

**Tasks**:
2.1. Script-migrate Runtime execution files and directories into `src/__tests__/execution/` (`contexts/`, `event-bus/`, `guardrails/`, `pre-refactor/`, execution/flow/reasoning/handoff families).
2.2. Script-migrate Runtime channel files and directories into `src/__tests__/channels/` (`adapters/`, `email/`, `webhooks/`, `websocket/`, channel/voice/omnichannel/livekit/ws families).
2.3. Script-migrate Runtime auth files and directories into `src/__tests__/auth/` (`auth-profile/`, `middleware/`, auth/kms/encryption/sdk/authz families).
2.4. Script-migrate Runtime observability files and directories into `src/__tests__/observability/` (`tracing/`, trace/clickhouse/observatory/circuit-breaker families).
2.5. Re-run runtime parity verification after each domain batch and refresh `TEST_INDEX.md` sections that depend on those families.

**Files Touched**:

- `apps/runtime/src/__tests__/execution/**` — moved Runtime tests
- `apps/runtime/src/__tests__/channels/**` — moved Runtime tests
- `apps/runtime/src/__tests__/auth/**` — moved Runtime tests
- `apps/runtime/src/__tests__/observability/**` — moved Runtime tests
- `apps/runtime/src/__tests__/TEST_INDEX.md` — migrated sections for moved domains

**Exit Criteria**:

- [x] `pnpm build --filter=@agent-platform/runtime` succeeds after the moves
- [x] `npx tsx tools/verify-test-inventory.ts --verify --app runtime` succeeds
- [x] `npx vitest run --config apps/runtime/vitest.fast.config.ts apps/runtime/src/__tests__/execution/ --passWithNoTests` succeeds
- [x] `npx vitest run --config apps/runtime/vitest.fast.config.ts apps/runtime/src/__tests__/channels/ --passWithNoTests` succeeds
- [x] `npx vitest run --config apps/runtime/vitest.fast.config.ts apps/runtime/src/__tests__/auth/ --passWithNoTests` succeeds
- [x] `npx vitest run --config apps/runtime/vitest.fast.config.ts apps/runtime/src/__tests__/observability/ --passWithNoTests` succeeds

**Test Strategy**:

- Unit: targeted fast/domain runs for moved directories
- Integration: runtime lane parity verification via the inventory tool

**Rollback**: Revert the Runtime Domain Migration A commit(s); the inventory verify command must return to the captured baseline.

---

### Phase 3: Runtime Domain Migration B & Config Consolidation

**Goal**: Finish Runtime migration for extraction, routing, sessions, and tools/deployment; then collapse Runtime to five primary configs.

**Tasks**:
3.1. Script-migrate extraction, routing, sessions, and tools/deployment families into their domain directories, including `migrations/` and route/service tests that map cleanly to those domains.
3.2. Update `apps/runtime/src/__tests__/TEST_INDEX.md` to the new domain map and quick-reference sections.
3.3. Rewrite `vitest.config.ts`, `vitest.fast.config.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts`, and `vitest.smoke.config.ts` to recursive convention-based globs.
3.4. Replace `test:flaky`, `test:sdk-auth`, connector E2E, and AFG lanes with path-filtered aliases in `apps/runtime/package.json`.
3.5. Delete deprecated specialty config files after parity verification passes.

**Files Touched**:

- `apps/runtime/src/__tests__/extraction/**` — moved Runtime tests
- `apps/runtime/src/__tests__/routing/**` — moved Runtime tests
- `apps/runtime/src/__tests__/sessions/**` — moved Runtime tests
- `apps/runtime/src/__tests__/tools-deployment/**` — moved Runtime tests
- `apps/runtime/src/__tests__/TEST_INDEX.md` — full domain index refresh
- `apps/runtime/package.json` — consolidated scripts
- `apps/runtime/vitest.config.ts` — default lane
- `apps/runtime/vitest.fast.config.ts` — fast lane
- `apps/runtime/vitest.integration.config.ts` — integration lane
- `apps/runtime/vitest.e2e.config.ts` — E2E lane
- `apps/runtime/vitest.smoke.config.ts` — smoke lane

**Exit Criteria**:

- [x] Runtime top-level config file count is 5 or fewer
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds
- [x] `pnpm --dir apps/runtime test` succeeds or matches the pre-captured lane status
- [x] `pnpm --dir apps/runtime test:fast` succeeds or matches the pre-captured lane status
- [x] `pnpm --dir apps/runtime test:smoke` succeeds or matches the pre-captured lane status
- [x] `pnpm --dir apps/runtime test:e2e` succeeds or matches the pre-captured lane status
- [x] `pnpm --dir apps/runtime test:integration` succeeds or matches the pre-captured lane status
- [x] `npx tsx tools/verify-test-inventory.ts --verify --app runtime` succeeds

**Test Strategy**:

- Unit: targeted Runtime fast lane checks for moved directories
- Integration: all Runtime script lanes via inventory verify plus targeted script execution

**Rollback**: Revert the Runtime Domain Migration B / config consolidation commit(s); restore the deleted config files from git history.

---

### Phase 4: Studio Domain Migration

**Goal**: Move Studio’s flat test files into domain directories while preserving current light/unit/node behavior.

**Tasks**:
4.1. Script-migrate Studio API route tests into `src/__tests__/api-routes/`, absorbing `auth-profiles/`.
4.2. Script-migrate Studio store/logic tests into `src/__tests__/stores/`, absorbing `lib/` where appropriate.
4.3. Script-migrate Studio component tests into `src/__tests__/components/`.
4.4. Script-migrate Studio hook tests into `src/__tests__/hooks/` and Arch AI tests into `src/__tests__/arch-ai/`.
4.5. Verify `search-ai/`, `e2e/`, `fixtures/`, and `helpers/` remain correct top-level support buckets.

**Files Touched**:

- `apps/studio/src/__tests__/api-routes/**` — moved Studio tests
- `apps/studio/src/__tests__/stores/**` — moved Studio tests
- `apps/studio/src/__tests__/components/**` — moved Studio tests
- `apps/studio/src/__tests__/hooks/**` — moved/retained Studio tests
- `apps/studio/src/__tests__/arch-ai/**` — moved Studio tests

**Exit Criteria**:

- [x] `pnpm build --filter=@agent-platform/studio` succeeds
- [x] `npx tsx tools/verify-test-inventory.ts --verify --app studio` succeeds
- [x] `pnpm --dir apps/studio test:light -- --passWithNoTests` succeeds
- [x] `pnpm --dir apps/studio test:node -- --passWithNoTests` succeeds
- [x] `npx vitest run --config apps/studio/vitest.unit.config.ts apps/studio/src/__tests__/components/ --passWithNoTests` succeeds

**Test Strategy**:

- Unit: targeted light/unit/node runs by Studio domain
- Integration: studio lane parity verification via the inventory tool

**Rollback**: Revert the Studio migration commit(s); re-run studio inventory verify against the baseline.

---

### Phase 5: Studio Runner, Config Simplification, and Pre-Push Wiring

**Goal**: Finish Studio config simplification, add domain forwarding to the split runner, and wire domain-aware pre-push targeting.

**Tasks**:
5.1. Rewrite Studio Vitest configs to recursive domain-aware patterns while preserving setup-file behavior.
5.2. Update `run-tests-plan.ts` and `run-tests.ts` to forward positional path filters across the split plan.
5.3. Add Runtime/Studio path-to-domain mapping in `.husky/pre-push` and keep the existing fallback behavior when mapping is ambiguous.
5.4. Re-run both app parity verification and end-to-end script checks.
5.5. Append migration learnings to `apps/runtime/agents.md` and `apps/studio/agents.md`.

**Files Touched**:

- `apps/studio/vitest.config.ts`
- `apps/studio/vitest.light.config.ts`
- `apps/studio/vitest.unit.config.ts`
- `apps/studio/vitest.node.config.ts`
- `apps/studio/run-tests-plan.ts`
- `apps/studio/run-tests.ts`
- `.husky/pre-push`
- `apps/runtime/agents.md`
- `apps/studio/agents.md`
- `docs/sdlc-logs/test-suite-modularization/implementation.log.md`

**Exit Criteria**:

- [x] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/runtime` succeeds
- [x] `pnpm --dir apps/studio test -- --passWithNoTests` succeeds
- [x] `pnpm --dir apps/studio test -- apps/studio/src/__tests__/stores/ --passWithNoTests` succeeds
- [x] `npx tsx tools/verify-test-inventory.ts --verify --app runtime` succeeds
- [x] `npx tsx tools/verify-test-inventory.ts --verify --app studio` succeeds
- [x] `.husky/pre-push` still falls back cleanly when no domain mapping is found

**Test Strategy**:

- Unit: runner plan tests and inventory-tool tests
- Integration: live `pnpm test`/`pnpm test:fast`/pre-push dry runs on both apps

**Rollback**: Revert the Studio runner/pre-push commit(s); restore previous runner behavior and path mapping logic.

---

## 4. Wiring Checklist

- [x] `tools/verify-test-inventory.ts` is wired to concrete runtime/studio lane definitions, not hard-coded comments only
- [x] Runtime `package.json` specialty scripts point at the new primary config lanes or explicit path filters
- [x] Deleted Runtime specialty config files have no remaining references in package scripts or docs
- [x] Runtime domain directories are populated and recursive globs include them
- [x] `apps/runtime/src/__tests__/TEST_INDEX.md` reflects the new domain layout and retained top-level support buckets
- [x] Studio domain directories are populated and recursive globs include them
- [x] Studio `run-tests-plan.ts` forwards path/domain args into light and unit shard commands
- [x] Studio `run-tests.ts` preserves delegation for split-unsafe flags after the forwarding changes
- [x] `.husky/pre-push` maps changed paths to Runtime/Studio domains and logs the choice
- [x] Baseline inventory artifacts live under `tools/test-baselines/` and stay out of source control
- [x] Package learnings appended to `apps/runtime/agents.md` and `apps/studio/agents.md`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This feature only moves test files and rewrites test configuration.

### Feature Flags

None.

### Configuration Changes

- No runtime env vars are added.
- `tools/test-baselines/<app>/` is a local verification artifact directory and must remain gitignored.
- Runtime script aliases (`test:flaky`, `test:sdk-auth`) may change implementation details but must remain callable.

### Dirty Worktree Handling

- The repo already contains unrelated edits when this LLD starts.
- Test-suite-modularization commits must stage only the files touched by this feature and must not overwrite existing user edits.
- If a user-modified file is within the migration scope, preserve the content and move it as-is; do not revert or normalize unrelated changes.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All phases complete with exit criteria met
- [x] Runtime lane parity verification passes (`tools/verify-test-inventory.ts --verify --app runtime`)
- [x] Studio lane parity verification passes (`tools/verify-test-inventory.ts --verify --app studio`)
- [x] Runtime keeps 5 or fewer Vitest config files
- [x] `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio` succeeds
- [x] Domain-scoped execution works for at least one Runtime and one Studio domain using positional path filters
- [x] `apps/runtime/src/__tests__/TEST_INDEX.md` matches the new Runtime directory layout
- [x] Package learnings updated in `apps/runtime/agents.md` and `apps/studio/agents.md`
- [x] Post-implementation documentation sync can proceed without additional design gaps

---

## 7. Post-Implementation Notes

1. The dirty worktree requirement held throughout implementation: unrelated user changes stayed untouched, and the feature was delivered via scoped staging across Phase 3, Phase 4, Phase 5, and final documentation commits.
2. Runtime files under `routes/`, `services/`, and retained integration buckets were classified by dominant subject. Truly cross-domain suites remained in shared support buckets rather than being force-fit into a domain tree.
3. The Studio inventory tool treats lanes as commands, not just config files, and the post-implementation baseline was intentionally refreshed once after narrowing the node lane from 294 files to 114 files.
4. Studio runner forwarding shipped as positional path-filter support (`pnpm --dir apps/studio test -- apps/studio/src/__tests__/stores/ --passWithNoTests`) rather than as a bespoke `--domain` CLI.
5. The implementation introduced a configurable `VITEST_WATCHDOG_MS` override for the Studio node lane so long-lived workers exit cleanly during split-runner and `test:node` executions.
6. Post-implementation documentation sync completed on 2026-03-27; no additional design gaps remain before future follow-up work.
