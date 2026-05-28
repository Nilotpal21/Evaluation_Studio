# HLD: Test Suite Modularization for Incremental Execution

**Feature Spec**: `docs/features/test-suite-modularization.md`
**Test Spec**: `docs/testing/test-suite-modularization.md`
**Status**: APPROVED
**Author**: platform-engineering
**Date**: 2026-03-27
**Last Updated**: 2026-03-28

---

## 1. Problem Statement

Runtime (~821 test files, 9 vitest configs, 82+56 exclude entries) and Studio (~298 test files, 4 vitest configs) have monolithic test suites where ~80% of tests live in a flat `src/__tests__/` directory. Developers must run the full suite or manually specify paths. Adding a test requires editing 2-5 config exclude lists. The goal is domain-aligned directory organization + convention-based vitest configs, enabling `vitest run src/__tests__/<domain>/` for fast domain-scoped feedback.

---

## 2. Alternatives Considered

### Option A: Domain Directories + Convention-Based Naming (Recommended)

- **Description**: Organize test files into domain subdirectories (e.g., `execution/`, `channels/`, `auth/`). Use filename conventions (`.e2e.test.ts`, `.integration.test.ts`) for tier detection. Replace per-file exclude lists with glob patterns. Consolidate Runtime from 9 to 5 configs.
- **Pros**:
  - Directory structure is self-documenting — `ls src/__tests__/` shows all domains
  - Convention-based globs are zero-maintenance — new tests are auto-discovered
  - Domain-scoped execution is a vitest CLI feature: positional path arg filters to a directory
  - Incremental migration possible (1 domain per commit)
  - Two-dimensional matrix (domain x tier) composes naturally via globs
- **Cons**:
  - ~565 + ~235 file moves needed (mechanical risk with relative imports)
  - 24 E2E files need renaming from hyphenated to dotted convention
  - Requires upfront verification tooling (Phase 0)
- **Effort**: M (5-6 phases, 2-3 weeks of domain commits + config consolidation)

### Option B: Vitest Workspace Configuration

- **Description**: Use vitest's native workspace feature (`vitest.workspace.ts`) to define domain-scoped projects. Each domain becomes a vitest project with its own include patterns, pool settings, and setup files. No file moves needed.
- **Pros**:
  - Zero file moves — avoids all import path breakage risk
  - vitest workspace is a first-class feature with IDE support
  - Each project can have independent pool/timeout/setup config
- **Cons**:
  - Workspace projects still need include patterns that reference flat file paths — the 82-entry exclude list problem remains (entries move from configs to workspace definitions)
  - vitest workspace doesn't support positional path filtering (`vitest run src/__tests__/execution/` doesn't work — must use `--project execution`)
  - IDE "Run Test" integration breaks with workspace projects (vitest-vscode extension doesn't always resolve the correct project)
  - No directory-level self-documentation — `ls src/__tests__/` still shows 565 flat files
  - Adding a new test still requires editing workspace project config (which domain does it belong to?)
- **Effort**: M (similar config work, no file moves, but workspace patterns are harder to debug)

### Option C: Turbo Sub-Tasks per Domain

- **Description**: Define Turbo tasks per domain (e.g., `test:execution`, `test:channels`) in `turbo.json`. Each task invokes vitest with a path filter. Keep files flat.
- **Pros**:
  - No file moves
  - Turbo caching works at domain-task level
  - CI can parallelize by domain via Turbo
- **Cons**:
  - `turbo.json` bloat: 8+ new tasks per app, each with separate inputs/outputs
  - Doesn't solve the vitest config exclude list problem (still 82+ entries)
  - Adding a domain requires `turbo.json` changes + pipeline updates
  - No directory-level self-documentation
  - Turbo tasks are coarser than vitest's native path filtering
- **Effort**: S (config only, no moves), but does not solve the root problem (config maintenance burden)

### Recommendation: Option A — Domain Directories + Convention-Based Naming

**Rationale**: Only Option A solves all three problems: developer feedback speed (domain-scoped execution), config maintenance (convention-based globs eliminate exclude lists), and discoverability (directory structure is self-documenting). Options B and C avoid file moves but leave the exclude list problem intact. The mechanical risk of file moves is mitigated by the verification script (Phase 0), incremental migration (1 domain per commit), and `tsc --noEmit` after every change.

**Config count note**: The implemented design uses 5 primary Runtime configs because the default `vitest.config.ts` must be retained as the entrypoint for `pnpm test`, `pnpm test:coverage`, and `pnpm test:watch`. FR-5 requires "no more than 5", which is satisfied.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Developer Workflow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Developer changes src/services/kms/key-manager.ts              │
│       │                                                          │
│       ▼                                                          │
│   Pre-push hook                                                  │
│       │── maps changed path → domain: "auth"                     │
│       │── runs: vitest run --config vitest.fast.config.ts        │
│       │         src/__tests__/auth/                               │
│       │── runs: pnpm test:smoke (curated critical-path)          │
│       ▼                                                          │
│   CI (Harness)                                                   │
│       │── runs: pnpm turbo test:fast (full package, cached)      │
│       │── runs: pnpm turbo test:e2e (full package, cached)       │
│       ▼                                                          │
│   Merge to develop                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Directory count note**: The feature spec inventory lists 19 Runtime subdirectories (omits `e2e/`, 2 files) and 7 Studio subdirectories (omits `integration/`, 1 file). Actual counts are 20 and 8 respectively. Both omitted directories are addressed in the proposed structure below.

### Component Diagram — Runtime Test Structure (After)

```
apps/runtime/
├── vitest.config.ts          ← default (forks, convention excludes)
├── vitest.fast.config.ts     ← fast/unit (threads, *.test.ts only)
├── vitest.smoke.config.ts    ← smoke (curated ~20 tests)
├── vitest.e2e.config.ts      ← unified E2E (forks, sequential)
├── vitest.integration.config.ts ← integration (forks, MongoDB/Redis)
└── src/__tests__/
    ├── execution/            ← flow-*, reasoning-*, handoff-*, runtime-executor*
    │   └── pre-refactor/     ← legacy 23-file unit (migrated as unit)
    ├── channels/             ← channel-*, voice-*, livekit-*, adapters/
    │   └── adapters/
    ├── auth/                 ← auth-profile-*, kms-*, sdk-*, user-isolation*
    ├── extraction/           ← extraction-*, constraint-*, gather-*, field-*
    ├── routing/              ← routing-*, delegate-*, fan-out-*, multi-intent-*
    ├── sessions/             ← session-*, stores*, repos-*, migrations/
    ├── tools-deployment/     ← deployment-*, tool-*, attachment-*, module-*
    ├── observability/        ← trace-*, clickhouse-*, observatory-*, tracing/
    ├── e2e/                  ← cross-domain E2E (platform.e2e, integrated.e2e)
    ├── stress/               ← stress tests (kept as-is)
    ├── fixtures/             ← shared test fixtures (kept as-is)
    ├── helpers/              ← shared test helpers (kept as-is)
    └── *.test.ts             ← <30 residual uncategorizable files
```

### Component Diagram — Studio Test Structure (After)

```
apps/studio/
├── vitest.config.ts          ← default (happy-dom, full suite)
├── vitest.light.config.ts    ← pure-logic (node, *.test.ts minus 8 RTL files)
├── vitest.unit.config.ts     ← component (happy-dom, *.test.tsx + 8 RTL)
├── vitest.node.config.ts     ← API/integration (node, 120s timeout)
├── run-tests.ts              ← orchestrator (split vs delegate)
├── run-tests-plan.ts         ← plan builder (+ positional path forwarding)
├── run-coverage.ts           ← coverage runner with per-lane istanbul collection
├── vitest.coverage.config.ts ← coverage config with threshold settings
└── src/__tests__/
    ├── api-routes/           ← api-*, admin-*, route-*, auth-profiles/
    ├── arch-ai/              ← arch-*
    ├── components/           ← component *.test.tsx files
    ├── docs/                 ← docs content, config, bundle, and MDX tests
    ├── e2e/                  ← E2E tests (support bucket)
    ├── fixtures/             ← shared fixtures (support bucket)
    ├── helpers/              ← shared helpers (support bucket)
    ├── hooks/                ← *-hooks*, *-hook* (already exists)
    ├── integration/          ← cross-domain integration (support bucket)
    ├── search-ai/            ← search-ai tests (already exists)
    ├── stores/               ← *-store*, lib/ utility tests
    └── *.test.ts(x)          ← 74 residual (further migration planned)
```

### Data Flow — Vitest Config Resolution (After)

```
vitest --config vitest.fast.config.ts src/__tests__/auth/
    │
    ▼
1. Resolve include: src/__tests__/**/*.test.ts
2. Apply path filter: src/__tests__/auth/ (CLI positional arg)
3. Apply exclude: **/*.e2e.test.ts, **/*.integration.test.ts, **/stress/**
4. Result: only *.test.ts files in auth/ domain → threads pool
    │
    ▼
5. Execute tests (threads pool, no infra, <30s target)
```

**Co-located tests (FR-7)**: Runtime's 50 co-located test files in `src/services/*/__tests__/`, `src/routes/__tests__/`, etc. and Studio's 23 co-located files in `src/components/*/__tests__/`, `src/hooks/__tests__/`, etc. are explicitly **out of scope** for file moves. They remain in their current locations — domain migration only applies to the flat `src/__tests__/` directory.

### Migration Sequence (Phased)

```
Phase 0: Verification tooling
    tools/verify-test-inventory.ts (--capture, --verify)
    │
Phase 0.5: Naming standardization (HLD refinement of FR-3, not in feature spec delivery plan)
    Rename 24 hyphenated E2E files → dotted convention
    Re-capture baseline
    │
Phase 1: Runtime domain migration (8 domains, 1 commit each)
    For each domain:
      git mv files → domain dir
      Update relative imports (./helpers/ → ../helpers/)
      tsc --noEmit → vitest run → verify-test-inventory --verify
    │
Phase 2: Runtime config consolidation
    Rewrite configs with glob patterns
    Merge 3 specialty E2E configs → unified vitest.e2e.config.ts
    Remove deprecated configs (keep for 1 release cycle)
    verify-test-inventory --verify
    │
Phase 3: Studio domain migration (6 domains, 1 commit each)
    Same pattern as Phase 1
    │
Phase 4: Studio config simplification
    Update light/unit configs with domain patterns
    Forward positional path filters through run-tests.ts / run-tests-plan.ts
    │
Phase 5: Pre-push hook integration
    Add git-diff-to-domain mapping (bash case statement)
    Domain-aware smoke + fast in pre-push Step 5
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                               |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | N/A — infrastructure-only feature. Test files are not deployed. No tenant-scoped operations.                                                                                                                                  |
| 2   | **Data Access Pattern** | N/A — no data model changes. Vitest config files are the "data" — they use declarative include/exclude patterns with convention-based globs replacing per-file entries.                                                       |
| 3   | **API Contract**        | N/A — no HTTP API changes. The "contract" is the vitest CLI: `vitest run --config <config> [path]`. This is stable vitest API (v4.x). The `pnpm test*` scripts are the user-facing contract and must remain identical (FR-4). |
| 4   | **Security Surface**    | N/A — test files are not deployed to production. The verification script (`tools/verify-test-inventory.ts`) reads file paths only — no user input, no network access, no credential handling.                                 |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Loud failures preferred over silent ones.** A broken import path causes `tsc --noEmit` failure (caught by PostToolUse hook). A missing test file causes the verification script to exit non-zero. A config glob that misses files causes a per-config count mismatch. Silent test loss (a file exists but no config discovers it) is caught by the "on-disk vs discovered" diff in the verification script.                           |
| 6   | **Failure Modes** | Three failure modes: (1) **Broken import** — `tsc` catches immediately, test fails with `Cannot find module`. Recovery: fix the import path. (2) **Config excludes too much** — verification script detects per-config count change. Recovery: adjust glob pattern. (3) **Config excludes too little** (e.g., E2E test runs in fast tier) — pool mismatch causes timeout/OOM. Recovery: adjust glob or rename file to match convention. |
| 7   | **Idempotency**   | File moves are idempotent — moving a file to its current location is a no-op. The verification script is idempotent — running `--verify` multiple times produces the same result. `git mv` followed by `git mv` back restores original state (VAL-7 validates this).                                                                                                                                                                    |
| 8   | **Observability** | `TEST_INDEX.md` updated per domain migration. Verification script outputs per-config file counts (human-readable). Pre-push hook logs which domains were targeted. `test-capture.ts` reports can be filtered by domain path.                                                                                                                                                                                                            |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Domain unit tests: <30s. Domain integration: <60s. Smoke: <15s. Pre-push: no regression from ~5min. Full suite: no increase. `vitest --listTests`: <5s per config. All measured via 3-run average on idle machine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | **Migration Path**     | **6-phase incremental migration** (see Migration Sequence above). Phase 0 creates verification tooling. Phase 0.5 standardizes naming. Phases 1-2 are Runtime. Phases 3-4 are Studio. Phase 5 is pre-push integration. Each domain migration is a single `refactor()` commit (max 40 files). Config consolidation is a separate commit after all domain moves. Old specialty configs kept for 1 release cycle post-consolidation.                                                                                                                                                                                                                                                                             |
| 11  | **Rollback Plan**      | **Domain migration commits**: each is independently revertable via `git revert`. VAL-7 validates this for a representative domain. **Config consolidation**: old specialty config files kept (unused) for 1 release cycle. Reverting config consolidation restores the old configs. If old configs reference flat paths that no longer exist, the glob-based patterns in the old fast/default configs still work because `*` recurses. The explicit-path configs (smoke, old e2e) need manual fixup after revert — this is the one scenario requiring manual intervention. **Blast radius**: limited to the migrated app's test tiers. Cannot cascade to runtime behavior, data integrity, or other packages. |
| 12  | **Test Strategy**      | See test spec (`docs/testing/test-suite-modularization.md`): 7 validation scenarios (VAL-1 through VAL-7), 7 integration scenarios (INT-1 through INT-7), 3 unit tests (UT-1 through UT-3). Primary verification is automated: `tools/verify-test-inventory.ts` compares per-config file basenames before/after each migration. Secondary verification is manual: `tsc --noEmit` after every file change, `pnpm test` after each domain commit. No mocking — all validation uses real vitest CLI and file system operations.                                                                                                                                                                                  |

---

## 5. Data Model

No data model changes. This feature restructures test file organization and vitest configuration only. No database schemas, collections, indexes, or relationships are affected.

---

## 6. API Design

No API changes. This feature does not add, modify, or remove HTTP endpoints.

### Internal Tool API

The verification script (`tools/verify-test-inventory.ts`) exposes a CLI:

```
Usage:
  npx tsx tools/verify-test-inventory.ts --capture --app <runtime|studio>
  npx tsx tools/verify-test-inventory.ts --verify --app <runtime|studio>

Options:
  --capture   Save baseline (sorted basenames per config) to tools/test-baselines/<app>/
  --verify    Compare current state against saved baseline, exit non-zero on mismatch
  --app       Target app: "runtime" or "studio"

Exit codes:
  0  Verification passed (or capture succeeded)
  1  Mismatch found (orphaned files, missing files, count difference)
  2  Usage error (missing baseline, invalid args)
```

### Studio Orchestrator Extension

The implemented Studio flow forwards positional Vitest path filters through the split runner rather than introducing a bespoke `--domain` flag:

```
pnpm --dir apps/studio test -- apps/studio/src/__tests__/stores/ --passWithNoTests
  → Runs only the stores domain through the split plan (light + 2 component shards)

pnpm --dir apps/studio test -- --coverage
  → Delegates directly to vitest (bypasses the split plan for split-unsafe flags)
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: N/A — test infrastructure changes are tracked via git history, not application audit logs.
- **Rate Limiting**: N/A — no HTTP endpoints.
- **Caching**: Turbo caching continues to work. File moves invalidate cache (correct behavior). No new caching mechanisms needed.
- **Encryption**: N/A — test files are not encrypted or deployed.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                        | Type          | Risk                                            |
| --------------------------------- | ------------- | ----------------------------------------------- |
| vitest v4.x `--listTests` flag    | CLI feature   | Low — stable, well-documented                   |
| vitest glob pattern resolution    | Core behavior | Low — standard glob semantics                   |
| Turbo `inputs: ["src/**/*.ts"]`   | Cache config  | Low — `**` recurses into subdirs by design      |
| `tsc --noEmit` (PostToolUse hook) | Type checking | Low — catches broken imports during development |
| CLAUDE.md commit scope guard      | Process guard | Low — enforces max 40 files per commit          |

### Downstream (depends on this feature)

| Consumer                 | Impact                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| CI/CD Pipeline (Harness) | Future: can add domain-scoped CI stages. Not blocked — current package-level tasks work as-is.                  |
| `tools/test-capture.ts`  | Future: can add `--domain` flag to filter by domain path. Not blocked — current `--filter`/`--tier` still work. |
| Developer pre-push hook  | Phase 5: gains domain-aware targeting. Falls back to full smoke if domain mapping fails.                        |

---

## 9. Post-Implementation Notes & Remaining Follow-Ups

1. `vitest.flaky.config.ts` was removed. The `test:flaky` workflow remains via path-filtered aliases over the five primary Runtime configs.
2. The smoke lane stayed curated; the implementation did not introduce a `*.smoke.test.ts` convention.
3. The legacy Studio `setup.ts` file was left untouched. Active Studio setup files remain `setup.tsx`, `setup-light.ts`, and `setup-node.ts`.
4. Runtime `pre-refactor/` migrated as a unit into `execution/pre-refactor/`; whether to decompose those tests further is a separate cleanup decision.
5. `remaining-stores.test.ts` moved into `stores/` unchanged; splitting it remains out of scope for this structural migration.
6. The Studio node lane was intentionally narrowed to API/integration/E2E-style suites and paired with a configurable `VITEST_WATCHDOG_MS` watchdog so long-lived node tests exit cleanly.
7. Cross-domain E2E tests remain in retained top-level support buckets, while domain-specific E2E suites stay inside their domain directories.
8. A 7th Studio domain `docs/` was added post-initial migration (5 docs-related test files).
9. Studio gained a `TEST_INDEX.md`, domain-scoped `pnpm test:<domain>` scripts, and a coverage runner (`run-coverage.ts` + `vitest.coverage.config.ts`).

---

## 10. References

- Feature spec: `docs/features/test-suite-modularization.md`
- Test spec: `docs/testing/test-suite-modularization.md`
- Runtime vitest configs: `apps/runtime/vitest.*.config.ts` (5 files)
- Studio vitest configs: `apps/studio/vitest.*.config.ts` (5 files)
- Studio orchestrator: `apps/studio/run-tests.ts`, `apps/studio/run-tests-plan.ts`
- Pre-push hook: `.husky/pre-push`
- Turbo tasks: `turbo.json`
- Structured test capture: `tools/test-capture.ts`
- CLAUDE.md commit discipline: max 40 files, max 3 packages, `refactor()` for moves
