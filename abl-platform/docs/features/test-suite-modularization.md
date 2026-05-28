# Feature: Test Suite Modularization for Incremental Execution

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `governance`
**Package(s)**: `apps/runtime`, `apps/studio`
**Owner(s)**: `platform-engineering`
**Testing Guide**: `../testing/test-suite-modularization.md`
**Last Updated**: 2026-03-28

---

## 1. Introduction / Overview

### Problem Statement

Studio (~298 test files, ~5,552 cases) and Runtime (~821 test files, ~12,655 cases) have monolithic test suites where ~80% of tests live in a flat `src/__tests__/` directory with no domain organization. A developer who changes a single KMS file must run the entire Runtime test suite or manually specify individual test paths. Runtime's `vitest.config.ts` has 82 exclude entries and `vitest.fast.config.ts` has 56 exclude entries, with similar lists duplicated across 9 separate configs. Adding a single test file requires updating 2-5 config files.

### Goal Statement

Restructure Studio and Runtime test suites into domain-aligned modules so that changes to a specific area (e.g., import/export, KMS, channels) can trigger only the relevant test subset. This enables faster developer feedback loops (<30s for domain unit tests), reduces CI waste, and eliminates the per-file config maintenance burden.

### Summary

This feature reorganizes the flat `src/__tests__/` directories in Runtime and Studio into domain-aligned subdirectories (e.g., `execution/`, `channels/`, `auth/`, `stores/`). It replaces per-file include/exclude lists in vitest configs with convention-based glob patterns and naming conventions (`.e2e.test.ts`, `.integration.test.ts`). The result is a two-dimensional test matrix: domain (directory) x tier (naming convention), composable via standard glob patterns. Runtime now uses 5 primary Vitest configs, and Studio's existing 4-config split is preserved but simplified through positional path forwarding. No test content, assertions, or framework changes are in scope.

---

## 2. Scope

### Goals

- Restructure flat `src/__tests__/` directories into domain-aligned subdirectories for Runtime (~565 flat files) and Studio (235 flat files: 154 `.test.ts` + 81 `.test.tsx`)
- Replace per-file include/exclude lists in vitest configs with convention-based glob patterns
- Consolidate Runtime from 9 vitest configs to 5 primary configs (default, fast, smoke, e2e, integration)
- Enable domain-scoped test execution via `vitest run src/__tests__/<domain>/`
- Preserve existing co-located tests (Runtime has 50 files already in `src/services/*/__tests__/`)
- Ensure backward compatibility of all `pnpm test*` scripts
- Zero test loss during migration — every test that runs today must still run after restructuring

### Non-Goals (Out of Scope)

- Refactoring test content, assertions, or mock patterns (test quality is a separate initiative)
- Rewriting tests to remove mocks (enforced by `e2e-test-quality-lint.sh` hook)
- Changing the test framework (staying on vitest)
- Adding new test infrastructure (MongoMemoryServer, harnesses, etc.)
- Restructuring CI pipeline YAML (Harness pipeline changes are tracked in `cicd-pipeline.md`)
- Restructuring shared package tests (`database`, `compiler`, `project-io`, etc. are already manageable at package level)
- Affected-test detection automation (nice-to-have, can layer on later)

---

## 3. User Stories

1. As a **developer**, I want to run only the tests related to the domain I changed so that I get feedback in <30s instead of waiting for the full suite.
2. As a **developer adding a new test**, I want to place it in the appropriate domain directory and have it automatically picked up by the correct tier config so that I don't have to edit 2-5 vitest config exclude lists.
3. As a **CI pipeline**, I want to run domain-scoped test groups in parallel so that PR validation completes faster and unrelated test failures don't block merges.
4. As a **pre-push hook**, I want to target smoke + affected domain tests based on changed files so that I catch regressions without running the entire suite.
5. As a **PR reviewer**, I want to see domain-scoped test results so that I can verify the right tests ran for the changes in the PR.

---

## 4. Functional Requirements

1. **FR-1**: The system must organize Runtime test files into domain-aligned subdirectories under `src/__tests__/` with a minimum of 8 domains: `execution`, `channels`, `auth`, `extraction`, `routing`, `sessions`, `tools-deployment`, and `observability`.
2. **FR-2**: The system must organize Studio test files into domain-aligned subdirectories under `src/__tests__/` with a minimum of 6 domains: `api-routes`, `components`, `stores`, `hooks`, `arch-ai`, `search-ai`, and `docs`.
3. **FR-3**: The system must use filename conventions to determine test tier: `*.test.ts` = unit/fast, `*.e2e.test.ts` = E2E, `*.integration.test.ts` = integration, with glob-based tier configs replacing per-file exclude lists.
4. **FR-4**: The system must preserve all existing `pnpm test*` scripts (`test`, `test:fast`, `test:smoke`, `test:e2e`, `test:integration`, `test:coverage`, `test:watch`) with identical behavior — same tests run, same pass/fail outcomes.
5. **FR-5**: The system must reduce Runtime vitest configs from 9 to no more than 5, using convention-based glob patterns instead of per-file exclude lists.
6. **FR-6**: The system must enable domain-scoped execution via vitest CLI: `npx vitest run --config vitest.fast.config.ts src/__tests__/<domain>/` must run only that domain's fast-tier tests.
7. **FR-7**: The system must preserve Runtime's existing co-located tests (50 files in `src/services/*/__tests__/`, `src/routes/__tests__/`, etc.) in their current locations.
8. **FR-8**: The system must update Runtime's `TEST_INDEX.md` to reflect the new directory structure with domain-to-directory mapping.
9. **FR-9**: The system must ensure zero test loss during migration — the set of test files executed by `pnpm test` before and after must be identical.
10. **FR-10**: After all migrations complete, running `vitest --listTests` in each package must produce the same set of test file basenames as before migration (order-independent), verifiable by a diff script included in the repo.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                |
| -------------------------- | ------------ | ---------------------------------------------------- |
| Project lifecycle          | NONE         |                                                      |
| Agent lifecycle            | NONE         |                                                      |
| Customer experience        | NONE         |                                                      |
| Integrations / channels    | NONE         |                                                      |
| Observability / tracing    | NONE         |                                                      |
| Governance / controls      | SECONDARY    | Enables better test governance and coverage tracking |
| Enterprise / compliance    | NONE         |                                                      |
| Admin / operator workflows | PRIMARY      | Developer workflow: test execution, CI feedback loop |

### Related Feature Integration Matrix

| Related Feature                             | Relationship Type | Why It Matters                                                                                | Key Touchpoints                          | Current State |
| ------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------- |
| [CI/CD Pipeline](cicd-pipeline.md)          | configured by     | Domain-aligned tests enable finer-grained CI stages                                           | `tools/detect-affected.sh`, Harness YAML | PLANNED       |
| Test Capture Tool (`tools/test-capture.ts`) | extends           | `--filter` and `--tier` flags can leverage domain directory paths for domain-scoped reporting | `tools/test-capture.ts`                  | STABLE        |

---

## 6. Design Considerations (Optional)

N/A — This feature is infrastructure-only with no UI component.

---

## 7. Technical Considerations (Optional)

### Current State Inventory

**Runtime `src/__tests__/` — 19 existing subdirectories:**

| Existing Directory | Proposed Domain           | Notes                                                                                 |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| `adapters/`        | `channels/adapters/`      | Channel adapter tests                                                                 |
| `auth-profile/`    | `auth/`                   | Auth profile tests                                                                    |
| `contexts/`        | `execution/`              | Execution context tests                                                               |
| `email/`           | `channels/`               | Email channel tests                                                                   |
| `event-bus/`       | `execution/`              | Event bus infrastructure                                                              |
| `fixtures/`        | `fixtures/` (keep)        | Shared test fixtures, not a domain                                                    |
| `guardrails/`      | `execution/`              | Guardrail pipeline tests                                                              |
| `helpers/`         | `helpers/` (keep)         | Shared test helpers, not a domain                                                     |
| `integration/`     | Distribute by domain      | Split into domain-specific `*.integration.test.ts` files                              |
| `middleware/`      | `auth/`                   | Auth/middleware tests                                                                 |
| `migrations/`      | `sessions/`               | Data migration tests                                                                  |
| `observability/`   | `observability/` (keep)   | Already matches proposed domain                                                       |
| `pre-refactor/`    | TBD (see Open Question 1) | Legacy tests, 23 files                                                                |
| `routes/`          | Distribute by domain      | Route tests map to their domain (auth routes → `auth/`, session routes → `sessions/`) |
| `services/`        | Distribute by domain      | Service tests map to their domain                                                     |
| `stress/`          | `stress/` (keep)          | Stress tests, orthogonal to domain                                                    |
| `tracing/`         | `observability/`          | Tracing tests                                                                         |
| `webhooks/`        | `channels/`               | Webhook channel tests                                                                 |
| `websocket/`       | `channels/`               | WebSocket channel tests                                                               |

**Studio `src/__tests__/` — 11 directories after migration:**

| Directory      | Domain Type           | Notes                                                           |
| -------------- | --------------------- | --------------------------------------------------------------- |
| `api-routes/`  | Domain                | Auth profile + API route tests (absorbed from `auth-profiles/`) |
| `arch-ai/`     | Domain                | Arch AI tests                                                   |
| `components/`  | Domain                | Component `.test.tsx` files                                     |
| `docs/`        | Domain                | Docs content, config, bundle, and MDX tests                     |
| `e2e/`         | Support bucket (keep) | E2E tests, orthogonal to domain                                 |
| `fixtures/`    | Support bucket (keep) | Shared test fixtures                                            |
| `helpers/`     | Support bucket (keep) | Shared test helpers                                             |
| `hooks/`       | Domain                | Hook tests spanning light and unit lanes                        |
| `integration/` | Support bucket (keep) | Cross-domain integration coverage                               |
| `search-ai/`   | Domain                | Search AI UI + orchestration suites                             |
| `stores/`      | Domain                | Store/serializer/logic-heavy tests (absorbed `lib/`)            |

**Co-located tests (outside `src/__tests__/`):**

- Runtime: 50 files across `src/services/*/__tests__/`, `src/routes/__tests__/`, `src/attachments/__tests__/`, `src/tools/__tests__/`, `src/middleware/__tests__/`
- Studio: 23 files across `src/components/*/__tests__/`, `src/hooks/__tests__/`, `src/lib/__tests__/`, `src/store/__tests__/`

### Two-Dimensional Test Matrix

Tests are organized along two orthogonal dimensions that compose via glob patterns:

**Dimension 1: Domain (directory)**

```
src/__tests__/
  execution/        # flow-*, reasoning-*, runtime-executor*, handoff-*
  channels/         # channel-*, omnichannel-*, voice-*, livekit-*, adapter-*
  auth/             # auth-profile-*, kms-*, sdk-*, user-isolation*
  extraction/       # extraction-*, constraint-*, gather-*, field-*
  routing/          # routing-*, delegate-*, fan-out-*, multi-intent-*
  sessions/         # session-*, stores*, repos-*
  tools-deployment/ # deployment-*, tool-*, attachment-*
  observability/    # trace-*, clickhouse-*, observatory-*
```

**Dimension 2: Tier (naming convention)**

```
*.test.ts           → fast/unit tier (threads pool, no infra)
*.e2e.test.ts       → E2E tier (forks pool, sequential, MongoMemoryServer)
*.integration.test.ts → integration tier (forks pool, MongoDB/Redis)
```

**Composition**: `vitest.fast.config.ts` includes `src/__tests__/**/*.test.ts` and excludes `**/*.e2e.*` and `**/*.integration.*`. Running a specific domain + tier: `npx vitest run --config vitest.fast.config.ts src/__tests__/execution/`.

### Constraints

- MongoMemoryServer requires `pool: 'forks'` — any test using MongoDB must run in the forks pool
- Studio has 3 setup files (`setup.tsx` for happy-dom, `setup-light.ts` for pure-logic, `setup-node.ts` for API/integration) — domain directories must be covered by the correct config's include pattern to inherit the right setup
- Runtime vitest configs reference no `setupFiles` — domain migration only requires updating `include`/`exclude` patterns
- Runtime's smoke config remains a curated list (represents "minimum viable confidence", not a systematic domain)
- File moves show as add+delete — use `refactor()` commit type to avoid deletion ratio guard

---

## 8. How to Consume

### Studio UI

N/A — This feature has no Studio UI surface.

### API (Runtime)

N/A — This feature has no API surface.

### API (Studio)

N/A — This feature has no API surface.

### Admin Portal

N/A — This feature has no admin surface.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — This feature is not channel-aware.

---

## 9. Data Model

N/A — This feature does not modify data models. It restructures test file organization and vitest configuration only.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                        | Purpose                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `tools/migrate-test-files.ts`               | Scripted move engine for Runtime/Studio domain migrations and path fixes |
| `tools/verify-test-inventory.ts`            | Lane-aware parity verifier for Runtime and Studio test discovery         |
| `apps/runtime/package.json`                 | Runtime script aliases over the five primary configs                     |
| `apps/runtime/vitest.config.ts`             | Default Runtime lane over recursive domain globs                         |
| `apps/runtime/vitest.fast.config.ts`        | Fast Runtime lane for `*.test.ts` domain runs                            |
| `apps/runtime/vitest.smoke.config.ts`       | Curated Runtime smoke lane                                               |
| `apps/runtime/vitest.e2e.config.ts`         | Unified Runtime E2E lane                                                 |
| `apps/runtime/vitest.integration.config.ts` | Unified Runtime integration lane                                         |
| `apps/runtime/vitest.path-filters.ts`       | Runtime path-filter registry backing specialty aliases                   |
| `apps/studio/vitest.config.ts`              | Default Studio split-runner entry config                                 |
| `apps/studio/vitest.light.config.ts`        | Pure-logic Studio lane over recursive domain globs                       |
| `apps/studio/vitest.unit.config.ts`         | Happy-dom component lane over domain directories                         |
| `apps/studio/vitest.node.config.ts`         | Node/API/integration Studio lane with long-lived resource watchdog       |
| `apps/studio/run-tests.ts`                  | Studio test orchestrator preserving split/delegate behavior              |
| `apps/studio/run-tests-plan.ts`             | Split-plan builder with positional path-filter forwarding                |
| `apps/studio/run-coverage.ts`               | Coverage runner with per-lane collection and merged istanbul reports     |
| `apps/studio/vitest.coverage.config.ts`     | Coverage configuration with istanbul provider and threshold settings     |
| `apps/studio/src/__tests__/TEST_INDEX.md`   | Studio domain-to-directory map and domain command quick reference        |
| `.husky/pre-push`                           | Domain-aware Runtime/Studio pre-push targeting with fallback behavior    |

### Routes / Handlers

N/A

### UI Components

N/A

### Jobs / Workers / Background Processes

N/A

### Tests

| File                                               | Type        | Coverage Focus                                                                        |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `tools/verify-test-inventory.test.ts`              | unit        | Basename parity, duplicate detection, lane resolution                                 |
| `tools/migrate-test-files.test.ts`                 | unit        | Scripted move planning, path rewriting, plan application                              |
| `apps/runtime/src/__tests__/TEST_INDEX.md`         | reference   | Runtime domain-to-directory map after migration                                       |
| `apps/studio/src/__tests__/run-tests-plan.test.ts` | unit        | Studio repo-root path forwarding and `--passWithNoTests` dedupe                       |
| `apps/studio/src/__tests__/setup.tsx`              | setup       | happy-dom + React Testing Library setup (`vitest.config.ts`, `vitest.unit.config.ts`) |
| `apps/studio/src/__tests__/setup-light.ts`         | setup       | Minimal node setup (`vitest.light.config.ts`)                                         |
| `apps/studio/src/__tests__/setup-node.ts`          | setup       | API/integration node setup with native fetch + storage shims                          |
| `apps/studio/src/__tests__/server-only.stub.ts`    | stub        | `server-only` module stub (`vitest.light.config.ts`, `vitest.node.config.ts`)         |
| `apps/studio/vitest-force-exit.ts`                 | globalSetup | Configurable watchdog for long-lived Studio node/test runs                            |

---

## 11. Configuration

### Environment Variables

- `VITEST_WATCHDOG_MS` (optional, local/CI test env): overrides the Studio node-lane force-exit watchdog. The implementation defaults it to 5 minutes for `vitest.node.config.ts`.

### Runtime Configuration

- Runtime now uses five primary Vitest configs plus `vitest.path-filters.ts` for specialty aliases (`test:flaky`, `test:sdk-auth`, connector/AFG lanes).
- Studio now uses five Vitest configs: `vitest.config.ts` (split-runner entry), `vitest.light.config.ts`, `vitest.unit.config.ts`, `vitest.node.config.ts`, `vitest.coverage.config.ts`.
- Deprecated dedicated Runtime configs (`vitest.flaky.config.ts`, `vitest.sdk-auth.config.ts`, `vitest.connector-e2e.config.ts`, `vitest.afg-e2e.config.ts`) were removed.
- Local discovery baselines live under gitignored `tools/test-baselines/<app>/`.

### DSL / Agent IR / Schema

N/A

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation         |
| ----------------- | --------------------------------- |
| Project isolation | N/A — infrastructure-only feature |
| Tenant isolation  | N/A — infrastructure-only feature |
| User isolation    | N/A — infrastructure-only feature |

### Security & Compliance

N/A — No security impact. Test files are not deployed.

### Performance & Scalability

| Metric                          | Target                         | Rationale                                   |
| ------------------------------- | ------------------------------ | ------------------------------------------- |
| Single domain unit tests        | <30s                           | Matches Runtime `test:fast` target          |
| Single domain integration tests | <60s                           | Matches existing integration config timeout |
| Runtime smoke tests             | <15s                           | Preserve existing target                    |
| Pre-push total time             | No increase from current ~5min | Must not regress                            |
| Full suite execution time       | No increase                    | File moves don't change test content        |

### Reliability & Failure Modes

- **Migration risk**: If a test file import path changes during the move, it will fail at runtime. Mitigated by running the full test suite after each domain migration commit.
- **Config regression**: If a test is accidentally excluded from all tier configs after restructuring, it becomes dead. Mitigated by FR-9 (zero test loss verification) — compare the set of test files before and after.
- **Rollback strategy**: Each domain migration is a separate `refactor()` commit. Any commit can be reverted independently.

### Observability

- `TEST_INDEX.md` updated after each domain migration
- `test-capture.ts` reports can be filtered by domain path
- Pre-push hook output shows which domains were tested

### Data Lifecycle

N/A — Test files have no data lifecycle concerns.

---

## 13. Delivery Plan / Work Breakdown

### Phase 0: Verification Tooling

0. Create verification script
   0.1 Create `tools/verify-test-inventory.ts` that captures the set of test files discovered by each `pnpm test*` command (via `vitest --listTests`)
   0.2 Script outputs a sorted file list and test count per config for before/after comparison
   0.3 Script exits non-zero if before/after sets differ (for CI gating)

### Phase 1: Runtime Domain Migration (8 domains, 1 commit per domain)

**Pre-migration**: Run `tools/verify-test-inventory.ts` to capture baseline test file list and counts.

**Existing subdirectory handling**: Runtime already has 19 subdirectories under `src/__tests__/`. Directories that already align with proposed domains (`observability/`) are kept in place. Others are absorbed into the appropriate domain (see Current State Inventory in §7). `fixtures/`, `helpers/`, and `stress/` are non-domain directories and remain as-is.

1. Runtime execution domain
   1.1 Move flat files: `flow-*`, `reasoning-*`, `runtime-executor*`, `execution-*`, `handoff-*` into `src/__tests__/execution/`
   1.2 Absorb existing `contexts/`, `event-bus/`, `guardrails/` subdirectories into `src/__tests__/execution/`
   1.3 Verify all moved tests pass via `npx vitest run src/__tests__/execution/`
   1.4 Update `TEST_INDEX.md`

2. Runtime channels domain
   2.1 Move flat files: `channel-*`, `omnichannel-*`, `voice-*`, `livekit-*`, `ws-*` into `src/__tests__/channels/`
   2.2 Absorb existing `adapters/`, `email/`, `webhooks/`, `websocket/` subdirectories into `src/__tests__/channels/`
   2.3 Verify all moved tests pass

3. Runtime auth domain
   3.1 Move flat files: `auth-profile-*`, `kms-*`, `encryption-*`, `sdk-*`, `user-isolation*`, `*-authz*` into `src/__tests__/auth/`
   3.2 Absorb existing `auth-profile/`, `middleware/` subdirectories into `src/__tests__/auth/`
   3.3 Verify all moved tests pass

4. Runtime extraction domain
   4.1 Move flat files: `extraction-*`, `constraint-*`, `gather-*`, `field-*`, `filler-*` into `src/__tests__/extraction/`
   4.2 Verify all moved tests pass

5. Runtime routing domain
   5.1 Move flat files: `routing-*`, `delegate-*`, `fan-out-*`, `multi-intent-*`, `prompt-*` into `src/__tests__/routing/`
   5.2 Verify all moved tests pass

6. Runtime sessions domain
   6.1 Move flat files: `session-*`, `stores*`, `repos-*`, `chat-*` into `src/__tests__/sessions/`
   6.2 Absorb existing `migrations/` subdirectory into `src/__tests__/sessions/`
   6.3 Distribute `routes/` tests: session routes → `sessions/`, auth routes → `auth/`, other routes → appropriate domain
   6.4 Verify all moved tests pass

7. Runtime tools-deployment domain
   7.1 Move flat files: `deployment-*`, `tool-*`, `attachment-*`, `module-*` into `src/__tests__/tools-deployment/`
   7.2 Verify all moved tests pass

8. Runtime observability domain (minimal — already exists)
   8.1 Move flat files: `trace-*`, `clickhouse-*`, `observatory-*`, `circuit-breaker-*` into `src/__tests__/observability/`
   8.2 Absorb existing `tracing/` subdirectory into `src/__tests__/observability/`
   8.3 Verify all moved tests pass

### Phase 2: Runtime Config Consolidation

9. Consolidate vitest configs
   9.1 Rewrite `vitest.config.ts` to use glob patterns instead of per-file excludes
   9.2 Rewrite `vitest.fast.config.ts` to use naming convention excludes (`**/*.e2e.*`, `**/*.integration.*`)
   9.3 Merge `vitest.connector-e2e.config.ts`, `vitest.afg-e2e.config.ts`, `vitest.sdk-auth.config.ts` into `vitest.e2e.config.ts` with per-domain overrides
   9.4 Verify `pnpm test`, `pnpm test:fast`, `pnpm test:smoke`, `pnpm test:e2e`, `pnpm test:integration` produce identical results
   9.5 Remove deprecated config files

### Phase 3: Studio Domain Migration (6 domains)

**Existing subdirectory handling**: Studio already has 7 subdirectories. `hooks/` and `search-ai/` already match proposed domains. `e2e/`, `fixtures/`, `helpers/` are non-domain directories and remain as-is. `auth-profiles/` is absorbed into `api-routes/`. `lib/` is distributed or absorbed into `stores/`.

10. Studio api-routes domain
    10.1 Move flat files: `api-*`, `admin-*`, `route-*` into `src/__tests__/api-routes/`
    10.2 Absorb existing `auth-profiles/` subdirectory into `src/__tests__/api-routes/`
    10.3 Verify all moved tests pass

11. Studio components domain
    11.1 Move component `.test.tsx` files into `src/__tests__/components/` with sub-groupings
    11.2 Verify all moved tests pass

12. Studio stores domain
    12.1 Move `*-store*`, `remaining-stores*` into `src/__tests__/stores/`
    12.2 Absorb existing `lib/` subdirectory into `src/__tests__/stores/` (utility/logic tests)
    12.3 Verify all moved tests pass

13. Studio hooks domain (minimal — already exists)
    13.1 Move flat `*-hooks*`, `*-hook*` files into existing `src/__tests__/hooks/`
    13.2 Verify all moved tests pass

14. Studio arch-ai domain
    14.1 Move `arch-*` into `src/__tests__/arch-ai/`
    14.2 Verify all moved tests pass

15. Studio search-ai domain (already organized)
    15.1 Verify existing `src/__tests__/search-ai/` structure is complete
    15.2 Move any stray search-ai tests into the directory

### Phase 4: Studio Config Simplification

16. Simplify vitest configs
    16.1 Update `vitest.light.config.ts` to use domain directory patterns
    16.2 Update `vitest.unit.config.ts` to use domain directory patterns
    16.3 Update `run-tests-plan.ts` to forward positional path filters through the split runner
    16.4 Verify all `pnpm test*` scripts produce identical results

### Phase 5: Pre-push Hook Integration

17. Domain-aware pre-push testing
    17.1 Add path-to-domain mapping in pre-push hook
    17.2 Run affected domain tests + smoke in pre-push Step 5
    17.3 Verify pre-push time does not regress

---

## 14. Success Metrics

| Metric                                      | Baseline                              | Target          | How Measured                                                                      |
| ------------------------------------------- | ------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| Runtime vitest configs                      | 9                                     | <=5             | File count                                                                        |
| Per-file exclude entries across all configs | ~138 (82 + 56 in top 2 configs alone) | <20             | `grep` count of exclude entries                                                   |
| Time to run domain-scoped unit tests        | N/A (not possible today)              | <30s            | `time npx vitest run src/__tests__/<domain>/`                                     |
| Files in flat `src/__tests__/` (Runtime)    | ~565                                  | <30 (misc only) | `ls src/__tests__/*.test.ts \| wc -l` — currently 291 (further migration planned) |
| Files in flat `src/__tests__/` (Studio)     | 235                                   | <20 (misc only) | `ls src/__tests__/*.test.* \| wc -l` — currently 74 (further migration planned)   |
| Config files to edit when adding a new test | 2-5                                   | 0               | Developer experience                                                              |

---

## 15. Post-Implementation Decisions & Follow-Ups

1. Runtime `pre-refactor/` migrated as a unit into `apps/runtime/src/__tests__/execution/pre-refactor/`; deeper cleanup is deferred to a separate follow-up.
2. The smoke lane stayed curated. No `*.smoke.test.ts` convention was introduced in this implementation.
3. `apps/studio/src/__tests__/stores/remaining-stores.test.ts` moved into the `stores/` domain unchanged; splitting it by store/behavior remains out of scope.
4. `vitest.flaky.config.ts` was removed, but the `test:flaky` script remains available via path-filtered aliases over the primary Runtime configs.
5. Cross-domain E2E coverage stayed in retained top-level support buckets, while domain-specific E2E files stayed within their new domain directories.
6. The legacy `apps/studio/src/__tests__/setup.ts` file was left untouched. Active Studio setups remain `setup.tsx`, `setup-light.ts`, and `setup-node.ts`.
7. A 7th Studio domain `docs/` was added post-initial migration, moving 5 docs-related test files into `src/__tests__/docs/`.
8. Studio gained a `TEST_INDEX.md` (mirroring Runtime's) and domain-scoped `pnpm test:<domain>` scripts.
9. A coverage runner (`run-coverage.ts`) and `vitest.coverage.config.ts` were added for per-lane coverage collection with merged istanbul reports.
10. Runtime `routes/` (4 files), `services/` (7 files), and `integration/` (10+ files) were retained as partially-migrated directories. Cross-domain suites in these buckets were classified by dominant subject; truly cross-cutting suites remained in shared support buckets. Further domain distribution is a follow-up.
11. Studio `integration/` was retained as a cross-domain support bucket rather than being distributed.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                       | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Runtime/Studio source-to-domain mapping now exists in `.husky/pre-push`, but ambiguous or cross-cutting changes still fall back to broader package-level coverage | Medium   | Mitigated |
| GAP-002 | Studio's split runner still shards component tests by file count, not semantic domain, so large domains can remain imbalanced                                     | Low      | Open      |
| GAP-003 | The Runtime flaky lane now rides primary configs via path filters, but the underlying MongoMemoryServer/live-environment instability in those tests still exists  | Low      | Open      |
| GAP-004 | CI/Harness still operates at package level — domain-aware parallelism in CI remains a separate pipeline follow-up                                                 | Medium   | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                | Coverage Type | Status | Test File / Note                                                       |
| --- | ----------------------------------------------------------------------- | ------------- | ------ | ---------------------------------------------------------------------- |
| 1   | All Runtime tests pass after domain migration                           | manual        | PASS   | `test:smoke` (18/600), `test:fast` (580/8816) pass                     |
| 2   | All Studio tests pass after domain migration                            | manual        | PASS   | `pnpm --dir apps/studio test -- --passWithNoTests`, `test:node` exit 0 |
| 3   | `pnpm test:fast` produces identical test count before/after             | manual        | PASS   | Verified through lane-parity tool + targeted fast runs                 |
| 4   | `pnpm test:smoke` produces identical test count before/after            | manual        | PASS   | `pnpm --dir apps/runtime test:smoke` plus parity verify                |
| 5   | `pnpm test:e2e` produces identical test count before/after              | manual        | PASS   | Studio node lane exit 0; Runtime E2E lane composition verified         |
| 6   | Domain-scoped execution works: `vitest run src/__tests__/execution/`    | manual        | PASS   | Runtime `execution/` and Studio `stores/` path-filter runs verified    |
| 7   | Pre-push hook with domain targeting does not regress total time         | manual        | PASS   | Full 7-step hook: ~73s total, all steps pass                           |
| 8   | No test file is orphaned (exists on disk but excluded from all configs) | manual        | PASS   | `tools/verify-test-inventory.ts --verify --app runtime \| studio`      |

### Testing Notes

Validation completed during implementation and is recorded in `docs/sdlc-logs/test-suite-modularization/implementation.log.md`. The final implementation used the lane-aware verifier, migration-script unit tests, Studio split-runner tests, targeted domain runs, and sampled live/environment-sensitive lanes where full automation was impractical on the local machine.

**All deferred validations completed 2026-03-29:**

- VAL-4: PASS — Runtime smoke/fast, Studio default/light/node all pass
- VAL-6: PASS — Pre-push hook ~73s, all 7 steps pass
- VAL-7: PASS — Revert/revert-of-revert clean, parity maintained
- INT-1: PASS — Synthetic probe found+fixed missing integration exclude in fast config
- INT-7: PASS — Turbo `src/**/*.ts` recurses into domain dirs, cache behavior correct

> Full testing details: `../testing/test-suite-modularization.md`

---

## 18. References

- Runtime test index: `apps/runtime/src/__tests__/TEST_INDEX.md`
- Studio test orchestrator: `apps/studio/run-tests.ts`, `apps/studio/run-tests-plan.ts`
- Structured test capture: `tools/test-capture.ts`
- CI/CD pipeline spec: `docs/features/cicd-pipeline.md`
- Pre-push hook: `.husky/pre-push`
- Turbo task definitions: `turbo.json`
