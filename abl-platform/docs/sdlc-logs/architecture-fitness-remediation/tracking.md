# Architecture Fitness Remediation — Tracking

> **Created**: 2026-03-30
> **Last Updated**: 2026-03-30
> **Last Measured**: 2026-03-30 (live run on rebased branch)
> **Backlog Source**: [`docs/2026-03-25-architecture-fitness-remediation-backlog.md`](../../2026-03-25-architecture-fitness-remediation-backlog.md)
> **Completion Log (Phase 0)**: [`phase-0-completion.md`](phase-0-completion.md)

---

## At a Glance

| Phase | Name                        | Items  | Done  | Target       | Status      | Branch / PR                                                                                                              |
| ----- | --------------------------- | ------ | ----- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | Trust the Gate              | 7      | 7     | 3-5 days     | **DONE**    | `feature/phase-0a-architecture-fitness-gate` / [PR #560](https://bitbucket.org/koreteam1/abl-platform/pull-requests/560) |
| 1     | Close Isolation Gaps        | 4      | 0     | 1 week       | NOT STARTED | —                                                                                                                        |
| 2     | Remove Worst Route Hotspots | 5      | 0     | 2-4 weeks    | NOT STARTED | —                                                                                                                        |
| 3     | Decompose `packages/shared` | 5      | 0     | 1-2 weeks    | NOT STARTED | —                                                                                                                        |
| 4     | Simplify Runtime Core       | 8      | 0     | Multi-sprint | NOT STARTED | —                                                                                                                        |
| **∑** |                             | **29** | **7** |              |             |                                                                                                                          |

**Next up**: Phase 1 → AF-101 (tenantId for LLM resolution repo)

### Current Gate Health (2026-03-30)

| Check                      | Result                     | Detail                                                                              |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| Architecture fitness tests | **28/29 PASS, 1 FAIL**     | `shared/src/ impl files` = 66 (ceiling 65) — new file added on `develop`            |
| Boundary check (prod)      | **0 errors, 143 warnings** | `no-db-in-routes`: 143, `no-shared-to-database`: 11                                 |
| Boundary check (test)      | **33 info**                | `no-app-to-app-runtime`: 33 (test-only, non-blocking)                               |
| CI gate                    | **Active**                 | Harness `ci-build` + `ci-pr-auto` pipelines                                         |
| Runtime core LOC           | **Growing**                | `runtime-executor`: 3,361 (+447), `flow-step-executor`: 5,234 (+601) since baseline |
| Shared coupling            | **Growing**                | Runtime: 631 imports (+58), Studio: 227 (+17) since baseline                        |

> **Action needed before Phase 1**: Fix the `shared/src/` ceiling (bump to 66 or move the new file). This blocks the fitness gate in CI.

---

## Status Legend

| Symbol | Meaning               |
| ------ | --------------------- |
| `-`    | Not started           |
| `R`    | Running now           |
| `D`    | Done (with date)      |
| `S`    | Skipped (with reason) |
| `B`    | Blocked (with reason) |

---

## Phase 0 — Trust the Gate ✅

> **Objective**: Make the existing architecture suite accurate enough to be used as a CI gate.

**Status**: DONE (2026-03-30) | **Branch**: `feature/phase-0a-architecture-fitness-gate` | **PR**: [#560](https://bitbucket.org/koreteam1/abl-platform/pull-requests/560)

| ID     | Item                                 | Priority | Status | Commit    |
| ------ | ------------------------------------ | -------- | ------ | --------- |
| AF-001 | Fix scorecard route listing output   | P0       | D      | `268b6f2` |
| AF-002 | Align fitness docs with assertions   | P0       | D      | `268b6f2` |
| AF-003 | Split prod/test boundary signals     | P0       | D      | `d50bee0` |
| AF-004 | Dockerfile coverage as real gate     | P0       | D      | `c7fe7dc` |
| AF-005 | Repair TraceEvent duplication metric | P0       | D      | `c7fe7dc` |
| AF-006 | Resolve STI floor mismatch           | P0       | D      | `c7fe7dc` |
| AF-601 | CI wiring for existing checks        | P0       | D      | `d7733c9` |

**Exit Criteria** (all met at time of delivery):

- [x] Fitness suite passes for valid reasons — was 29/29 at delivery; now 28/29 due to `develop` drift (shared/src ceiling)
- [x] Production boundary-check output is readable and actionable
- [x] Scorecard output is trustworthy for review threads
- [x] Dockerfile coverage is truly blocking
- [x] CI pipeline enforces architecture gate

> **Post-delivery drift**: `develop` added a file to `packages/shared/src/` pushing impl count to 66 (ceiling 65). This is expected — the gate is catching new debt. Fix: bump ceiling to 66 or move the file.

See [`phase-0-completion.md`](phase-0-completion.md) for full delivery details.

---

## Phase 1 — Close Isolation Gaps ⬜ NEXT

> **Objective**: Remove fail-open project-scoped data access patterns and add regression gates to prevent reintroduction.

**Status**: NOT STARTED | **Target**: 1 week | **Branch**: TBD

### AF-101 — Require `tenantId` for project-scoped LLM resolution repo (P0)

|                         |                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**             | `apps/runtime/src/repos/llm-resolution-repo.ts` has 7 functions that query by `projectId` without including `tenantId`. A malicious or confused caller could read another tenant's model config by guessing a `projectId`. |
| **Files**               | `apps/runtime/src/repos/llm-resolution-repo.ts`, `apps/runtime/src/services/llm/model-resolution.ts`, related tests                                                                                                        |
| **Functions to harden** | `findAgentModelConfig`, `findAgentModelConfigByDslName`, `findModelConfigByModelId`, `findModelConfigForTier`, `findAnyModelConfig`, `findProjectOperationTierOverrides`, `findProjectEnableThinking`                      |
| **Action**              | 1. Make `tenantId` a required parameter in all 7 functions. 2. Add `tenantId` to every Mongo filter. 3. Update all callers to pass `tenantId`. 4. Remove or replace any tenantless fallback tests.                         |
| **Acceptance**          | No project-scoped function performs `findOne({ projectId })` without `tenantId`. Tenantless fallback tests removed.                                                                                                        |
| **Status**              | `-`                                                                                                                                                                                                                        |
| **SDLC**                | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                                                           |

### AF-102 — Lint/gate for project-scoped repo signatures (P0)

|                |                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Route-level isolation hooks don't prevent repo helpers from silently omitting `tenantId`. New unscoped functions can land unnoticed.                                   |
| **Files**      | New script under `tools/`, `package.json`, CI pipeline wiring                                                                                                          |
| **Action**     | 1. Create a lint script that flags project-scoped repo functions whose signatures or Mongo queries omit `tenantId`. 2. Wire into CI (warn mode initially, then error). |
| **Acceptance** | New unscoped project-level repo reads cannot land without CI flagging them.                                                                                            |
| **Status**     | `-`                                                                                                                                                                    |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                       |

> **Grouping note**: AF-101 + AF-102 are tightly coupled. Run as a single SDLC pipeline — one feature spec, one LLD.

### AF-103 — Tighten archive-store interfaces to tenant-safe methods (P1)

|                |                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | `getDownloadUrl()` and `delete()` remain as raw path-based methods in archive-store interfaces. Routes already use tenant-safe wrappers, but the raw methods are still callable.                                                |
| **Files**      | `apps/studio/src/services/archive/archive-types.ts`, `s3-archive-store.ts`, `local-archive-store.ts`, call sites under `apps/studio/src/app/api/archives/`                                                                      |
| **Action**     | 1. Deprecate or narrow raw path-based methods for server-side callers. 2. Make `getDownloadUrlForTenant()` and `deleteForTenant()` the only public interface. 3. Add guard tests ensuring server routes never call raw methods. |
| **Acceptance** | Archive HTTP handlers can only use tenant-scoped download/delete APIs.                                                                                                                                                          |
| **Status**     | `-`                                                                                                                                                                                                                             |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                                                                |

### AF-104 — Regression gate for trusted-header bypasses (P1)

|                |                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | No repo-level gate prevents future code from directly trusting `req.headers['x-tenant-id']` instead of going through auth middleware. |
| **Files**      | New lint script under `tools/`, `package.json`                                                                                        |
| **Action**     | 1. Add a grep/AST-based lint to block direct trust of `x-tenant-id` in server code outside an explicit allowlist. 2. Wire into CI.    |
| **Acceptance** | New server code cannot read tenant context directly from request headers without review.                                              |
| **Status**     | `-`                                                                                                                                   |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                      |

> **Grouping note**: AF-103 + AF-104 can be a second batch (Studio + lint gates).

**Phase 1 Exit Criteria**:

- [ ] All project-scoped LLM resolution queries include `tenantId`
- [ ] No tenantless fallback for project settings/model resolution
- [ ] New lint gates wired into CI (repo signature lint + header trust lint)
- [ ] Archive HTTP handlers use only tenant-scoped APIs

**Ratchet updates unlocked**: Add fitness/CI rule for project-scoped repo scoping.

---

## Phase 2 — Remove Worst Route Hotspots ⬜

> **Objective**: Vertically slice the worst route files so they follow route → service → repo layering with zero direct DB access.

**Status**: NOT STARTED | **Target**: 2-4 weeks | **Branch**: TBD

### AF-201 — Establish route extraction template (P1)

|                |                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | No standard extraction shape exists, so every refactor invents a different layering pattern.                                                                                             |
| **Action**     | Standardize on: **route** (auth → validate → service → response) → **service** (orchestration/business rules) → **repo** (persistence only). Add a short reference doc or code template. |
| **Acceptance** | New extractions follow one repeatable pattern.                                                                                                                                           |
| **Status**     | `-`                                                                                                                                                                                      |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                         |

### AF-202 — Search AI hotspot slice (P1)

|                |                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | `crawl.ts` (2,812 LOC, 17 DB calls), `kg-taxonomy.ts` (2,123 LOC, 30 DB calls) — highest concentration of both size and DB-in-route debt in the monorepo.                  |
| **Files**      | `apps/search-ai/src/routes/crawl.ts`, `apps/search-ai/src/routes/kg-taxonomy.ts`, `indexes.ts`, `mappings.ts`, `pipelines.ts`                                              |
| **Action**     | 1. Extract service/repo layers for `crawl.ts` and `kg-taxonomy.ts` first. 2. Move all direct model usage out of route files. 3. Add slice-specific tests before moving on. |
| **Acceptance** | `crawl.ts` and `kg-taxonomy.ts` each drop materially in LOC. Direct DB access in those files becomes zero.                                                                 |
| **Status**     | `-`                                                                                                                                                                        |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                           |

### AF-203 — Runtime hotspot slice (P1)

|                |                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | `channel-connections.ts` (1,462 LOC, 13 DB calls), `platform-admin-tenants.ts` (21 DB calls), `platform-admin-deals.ts` (17 DB calls) — high DB-in-route counts plus sensitive platform/admin behavior. |
| **Files**      | `apps/runtime/src/routes/channel-connections.ts`, `platform-admin-tenants.ts`, `platform-admin-deals.ts`, `http-async-channel.ts`                                                                       |
| **Action**     | 1. Extract services and repos. 2. Normalize auth, validation, response shaping, and logging.                                                                                                            |
| **Acceptance** | At least the first two files no longer access models directly. Project/tenant scoping is explicit in extracted repos.                                                                                   |
| **Status**     | `-`                                                                                                                                                                                                     |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                                        |

### AF-204 — Studio proxy and project-settings slice (P1)

|                |                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Studio carries the largest count of DB-in-route violations (83 total). Many routes directly query MongoDB instead of proxying to Runtime.     |
| **Files**      | `apps/studio/src/app/api/projects/[id]/git/push/route.ts`, `git/route.ts`, `auth-profiles/**/route.ts`, `module*/**/route.ts`                 |
| **Action**     | 1. Push DB access behind repos/services. 2. Where Runtime should be source of truth, convert Studio to proxy mode instead of direct DB reads. |
| **Acceptance** | Selected route cluster has zero direct model imports.                                                                                         |
| **Status**     | `-`                                                                                                                                           |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                              |

### AF-205 — Ratchet the route gate by slice (P1)

|                |                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Moving `no-db-in-routes` to hard-error repo-wide immediately would be too disruptive (140 violations).                              |
| **Action**     | Promote incrementally: pilot directories → `error`, remaining → `warn`. Each refactored slice immediately becomes regression-proof. |
| **Acceptance** | Refactored slices are regression-proof without blocking the entire monorepo.                                                        |
| **Status**     | `-`                                                                                                                                 |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                    |

> **Grouping note**: AF-202 + AF-205(search-ai), AF-203 + AF-205(runtime), AF-204 + AF-205(studio) — each app's slice + its ratchet as one SDLC pipeline.

**Phase 2 Exit Criteria**:

- [ ] At least one major hotspot per app family is vertically sliced
- [ ] Refactored slices have zero direct DB access in route files
- [ ] `no-db-in-routes` promoted to `error` for cleaned slices

**Ratchet updates unlocked**: `no-db-in-routes` from warn → error for cleaned slices.

---

## Phase 3 — Decompose `packages/shared` ⬜

> **Objective**: Turn `packages/shared` from a coupling hub into a thin compatibility layer by moving DB-backed code to focused packages.

**Status**: NOT STARTED | **Target**: 1-2 weeks | **Branch**: TBD

### AF-301 — Move DB-backed repos out of `packages/shared` (P1)

|                |                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | `packages/shared` contains repo implementations that import `@agent-platform/database`, making it a coupling hub for every consumer.               |
| **Files**      | `packages/shared/src/repos/mcp-server-config-repo.ts`, `project-tool-repo.ts`, `security-repo.ts`                                                  |
| **Action**     | Relocate DB-backed repos to a more appropriate package (e.g., domain-specific packages). Re-export temporarily only if needed to avoid a flag day. |
| **Acceptance** | No repo implementation in `packages/shared` imports `@agent-platform/database`.                                                                    |
| **Status**     | `-`                                                                                                                                                |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                   |

### AF-302 — Move DB-coupled services out of `packages/shared` (P1)

|                |                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Service implementations with DB dependencies live in `shared`, forcing all consumers to transitively depend on database models.                                                              |
| **Files**      | `packages/shared/src/services/auth-profile/linked-app-validator.ts`, `oauth2-app-resolver.ts`, `token-refresh-service.ts`, `mcp-server-registry.ts`, `tools/resolve-tool-implementations.ts` |
| **Action**     | Split by concern: auth-profile, MCP, tool-resolution, security — each into its own package or the consuming app.                                                                             |
| **Acceptance** | `packages/shared` no longer contains service implementations requiring DB models.                                                                                                            |
| **Status**     | `-`                                                                                                                                                                                          |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                             |

### AF-303 — Remove DB-coupled types from `packages/shared` (P1)

|                |                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Domain-specific types in `shared` transitively pull in database model imports.                                  |
| **Files**      | `packages/shared/src/types/mcp-server.ts`, `packages/shared/src/types/tools.ts`, `packages/shared/src/index.ts` |
| **Action**     | Move domain-specific types to owning packages. Keep `shared-kernel` for zero-dependency types and utilities.    |
| **Acceptance** | Type-only modules under `packages/shared` don't drag in database model imports transitively.                    |
| **Status**     | `-`                                                                                                             |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                |

### AF-304 — Reduce `@agent-platform/shared` import volume in apps (P2)

|                |                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Runtime has 573 imports from `@agent-platform/shared`, Studio has 210. This coupling makes `shared` impossible to refactor safely.           |
| **Action**     | Replace broad `@agent-platform/shared` imports with narrower package imports during normal feature work. Track as a metric, not a hard gate. |
| **Acceptance** | Runtime and Studio import counts trend down release over release.                                                                            |
| **Status**     | `-`                                                                                                                                          |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                             |

### AF-305 — Ratchet `no-shared-to-database-direct` (P1)

|                |                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Currently 11 violations at `info` severity — not blocking. Once AF-301/302/303 remove the violations, the rule should prevent reintroduction. |
| **Action**     | After violating files are moved: promote `info` → `warn` → `error`.                                                                           |
| **Acceptance** | `packages/shared` cannot re-acquire a database dependency.                                                                                    |
| **Status**     | `-`                                                                                                                                           |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                              |

> **Grouping note**: AF-301 + AF-302 + AF-303 + AF-305 as one SDLC pipeline (sequential dependency). AF-304 is ongoing metric tracking.

**Phase 3 Exit Criteria**:

- [ ] `packages/shared` no longer depends on `@agent-platform/database`
- [ ] App import counts begin shifting to narrower packages
- [ ] `no-shared-to-database-direct` promoted to `error`

**Ratchet updates unlocked**: `no-shared-to-database-direct` from info → error.

---

## Phase 4 — Simplify Runtime Core ⬜

> **Objective**: Break the runtime core into a true orchestration shell plus composable executors, and canonicalize trace schema ownership.

**Status**: NOT STARTED | **Target**: Multi-sprint | **Branch**: TBD

### WS4: Runtime Execution Core

### AF-401 — Define runtime/core decomposition target (P1)

|                |                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | `runtime-executor.ts` (2,914 LOC) and `flow-step-executor.ts` (4,633 LOC) are oversized with no agreed extraction map.                                                                               |
| **Files**      | `apps/runtime/src/services/runtime-executor.ts`, `apps/runtime/src/services/execution/flow-step-executor.ts`, existing construct executors in `packages/compiler/src/platform/constructs/executors/` |
| **Action**     | Produce an extraction map aligned with existing construct-layer executors. Define which logic stays orchestration-only and which moves into sub-executors.                                           |
| **Acceptance** | Written extraction plan tied to concrete modules, agreed by team.                                                                                                                                    |
| **Status**     | `-`                                                                                                                                                                                                  |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                                     |

### AF-402 — Extract completion/routing boundaries first (P1)

|                       |                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Problem**           | Completion detection, handoff/delegate routing, and flow transition decisions are tangled in the oversized core files. |
| **Why first**         | High control-flow value — good leverage for tracing and parity checks.                                                 |
| **Candidate targets** | Completion detection, handoff/delegate routing, flow transition decisions.                                             |
| **Acceptance**        | At least one meaningful chunk removed from both oversized core files.                                                  |
| **Status**            | `-`                                                                                                                    |
| **SDLC**              | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                       |

### AF-403 — Parity/contract tests for extracted execution (P1)

|                |                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **Problem**    | Refactors in the execution core are risky without observable-behavior coverage.                |
| **Action**     | Capture behavior around: responses, state mutation, trace emission, handoff/delegate outcomes. |
| **Acceptance** | Refactors are backed by contract-style tests, not only internal unit tests.                    |
| **Status**     | `-`                                                                                            |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`               |

### AF-404 — Staged LOC budgets (P2)

|                   |                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **Problem**       | Without explicit targets, LOC drift reoccurs after extractions.                                       |
| **Stage targets** | `runtime-executor.ts`: 2914 → 2500 → 2000 → 1500. `flow-step-executor.ts`: 4633 → 4000 → 3500 → 3000. |
| **Acceptance**    | Each stage corresponds to a merged extraction, not formatting-only churn.                             |
| **Status**        | `-`                                                                                                   |
| **SDLC**          | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                      |

### WS5: Trace Schema and STI Canonicalization

### AF-501 — Rename local trace wrappers (P1)

|                |                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | 6+ files define local types named `TraceEvent` that masquerade as the canonical definition, creating confusion about schema ownership.                                                                                                       |
| **Files**      | `apps/runtime/src/services/trace-store.ts`, `adapters/trace-manager-adapter.ts`, `apps/runtime/src/types/index.ts`, `apps/studio/src/types/index.ts`, `packages/eventstore/src/migration/trace-bridge.ts`, `packages/mcp-debug/src/types.ts` |
| **Action**     | Rename local types to `StoredTraceEvent`, `StudioTraceEvent`, `TraceBridgeEvent`, `McpDebugTraceEvent` etc. Keep canonical `TraceEvent` only in `@agent-platform/shared-kernel`.                                                             |
| **Acceptance** | Local wrappers no longer masquerade as canonical definitions.                                                                                                                                                                                |
| **Status**     | `-`                                                                                                                                                                                                                                          |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                                                                             |

### AF-502 — Preserve typed re-exports where they add value (P1)

|                |                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**    | Not all mentions of `TraceEvent` outside `shared-kernel` are harmful — honest re-exports (e.g., in `compiler/platform/core/types.ts`) are fine if they don't create schema drift. |
| **Action**     | Keep harmless aliases. Remove or rename only cases that create confusion or duplicate schemas.                                                                                    |
| **Acceptance** | Architecture metric reflects semantic duplication, not all mention sites.                                                                                                         |
| **Status**     | `-`                                                                                                                                                                               |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                                                                  |

### AF-503 — Add missing STI boundaries (P1)

|                          |                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Problem**              | Current STI coverage has gaps — agent-enter, flow-step-enter, completion-check, and escalation boundaries are not instrumented. |
| **Candidate boundaries** | Agent enter, flow step enter, completion check, escalation.                                                                     |
| **Acceptance**           | Total `tracePath()` coverage exceeds the new floor. Added wrappers correspond to actual debugging value, not filler.            |
| **Status**               | `-`                                                                                                                             |
| **SDLC**                 | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                                |

### AF-504 — Ratchet STI by event family (P2)

|                |                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Problem**    | Current STI ratchet is a single total count. Coverage could grow unevenly (e.g., all LLM boundaries, no lifecycle boundaries). |
| **Action**     | Add separate floors for: LLM/tool boundaries, flow/routing boundaries, agent lifecycle boundaries.                             |
| **Acceptance** | STI coverage grows in meaningful categories, not just via arbitrary wrapper count.                                             |
| **Status**     | `-`                                                                                                                            |
| **SDLC**       | Feature Spec: `-` · Test Spec: `-` · HLD: `-` · LLD: `-` · Impl: `-` · Sync: `-`                                               |

> **Grouping note**: AF-401 + AF-402 + AF-403 + AF-404 as one SDLC pipeline (runtime core). AF-501 + AF-502 + AF-503 + AF-504 as another (trace canonicalization). Can run in parallel.

**Phase 4 Exit Criteria**:

- [ ] Runtime core files shrink meaningfully (LOC budgets met)
- [ ] Execution refactors protected by parity/contract coverage
- [ ] LOC ceilings lowered per extraction
- [ ] STI floors raised per real boundary
- [ ] Local trace wrappers renamed, canonical `TraceEvent` only in `shared-kernel`

**Ratchet updates unlocked**: Lower LOC ceilings per extraction. Raise STI floors per real boundary.

---

## Baseline Metrics

Snapshot from the remediation backlog (2026-03-25). Update after each phase.

> **Last measured**: 2026-03-30 (live on `feature/phase-0a-architecture-fitness-gate` rebased onto `develop`)

| Metric                              | Baseline (03-25) | Current (03-30)                     | Trend | After Phase 1 | After Phase 2 | After Phase 3 | After Phase 4 |
| ----------------------------------- | ---------------- | ----------------------------------- | ----- | ------------- | ------------- | ------------- | ------------- |
| Architecture fitness tests          | 18/20 pass       | **28/29 pass** (1 new fail)         | ⚠️    | —             | —             | —             | —             |
| Boundary violations (total)         | 183              | 187 (143W, 33info, 0E)              | →     | —             | —             | —             | —             |
| `no-db-in-routes` violations        | 140              | 143                                 | ↑3    | —             | —             | —             | —             |
| `no-app-to-app-runtime` (prod+test) | 32 (all test)    | 33 (test-only, split from prod)     | →     | —             | —             | —             | —             |
| `no-shared-to-database-direct`      | 11               | 11                                  | →     | —             | —             | —             | —             |
| `findById()` usage (non-test files) | 7 files          | 23 files                            | ↑     | —             | —             | —             | —             |
| `packages/shared` imports (runtime) | 573              | 631                                 | ↑     | —             | —             | —             | —             |
| `packages/shared` imports (studio)  | 210              | 227                                 | ↑     | —             | —             | —             | —             |
| `packages/shared/src` impl files    | 108              | 110 (ceiling 65 → **66 FAIL**)      | ↑     | —             | —             | —             | —             |
| `runtime-executor.ts` LOC           | 2914             | 3361                                | ↑447  | —             | —             | —             | —             |
| `flow-step-executor.ts` LOC         | 4633             | 5234                                | ↑601  | —             | —             | —             | —             |
| TraceEvent non-canonical defs       | 11               | classified (ceiling 8)              | ✅    | —             | —             | —             | —             |
| STI `tracePath()` coverage          | 9                | validated (4 families, 11 critical) | ✅    | —             | —             | —             | —             |

### Current Health Issues

1. **FAILING TEST**: `shared/src/ implementation files <= 65` — actual count is **66** (ceiling 65). Likely a new file was added to `packages/shared/src/` on `develop` after the baseline was set. Needs either: bump ceiling to 66, or identify and move the new file out.
2. **Runtime core LOC grew**: `runtime-executor.ts` +447 LOC (2914→3361), `flow-step-executor.ts` +601 LOC (4633→5234) since baseline. Feature work added code faster than extraction. Phase 4 targets need recalibration.
3. **`no-db-in-routes` grew by 3**: New route files with direct DB access landed on `develop` since baseline. Phase 2 ratchet work will need to account for the higher starting point.
4. **`findById()` count higher than baseline**: Baseline may have used a different measurement method (7 files vs 23 files now). Need to reconcile measurement approach.
5. **Shared import counts grew**: Runtime 573→631 (+58), Studio 210→227 (+17). Feature work is adding `@agent-platform/shared` imports faster than decomposition can remove them. Validates urgency of Phase 3.

---

## SDLC Log Index

All per-item SDLC logs live under `docs/sdlc-logs/architecture-fitness-remediation/`.

| Item            | Feature Spec          | Test Spec | HLD | LLD                                                                                     | Implementation                                                            | Post-Impl |
| --------------- | --------------------- | --------- | --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| Phase 0 (WS0)   | N/A (spec-level work) | N/A       | N/A | [`gate-spec`](../../plans/2026-03-29-phase-0a-traceevent-sti-architecture-gate-spec.md) | [PR #560](https://bitbucket.org/koreteam1/abl-platform/pull-requests/560) | —         |
| AF-101 + AF-102 | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-103          | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-104          | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-201          | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-202 + AF-205 | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-203 + AF-205 | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-204 + AF-205 | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-301–305      | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-401–404      | —                     | —         | —   | —                                                                                       | —                                                                         | —         |
| AF-501–504      | —                     | —         | —   | —                                                                                       | —                                                                         | —         |

> SDLC log index uses grouped rows matching the recommended pipeline groupings below.

---

## Recommended SDLC Pipeline Groupings

Not every backlog item needs a full independent SDLC pipeline. Items are grouped when they share scope, files, or sequential dependency.

| #   | SDLC Pipeline Group            | Items                            | App/Package              | Rationale                                            |
| --- | ------------------------------ | -------------------------------- | ------------------------ | ---------------------------------------------------- |
| 1   | **Isolation Hardening**        | AF-101, AF-102                   | `apps/runtime`           | Same domain (project-scoped repos), same package     |
| 2   | **Archive Tenant Safety**      | AF-103                           | `apps/studio`            | Studio-only, independent from runtime isolation      |
| 3   | **Regression Gates**           | AF-104                           | `tools/`                 | Standalone lint — small scope, single LLD sufficient |
| 4   | **Route Extraction Framework** | AF-201                           | Cross-cutting            | Template/pattern doc — no code, just HLD             |
| 5   | **Search AI Verticalization**  | AF-202, AF-205 (search-ai slice) | `apps/search-ai`         | Same app, same pattern                               |
| 6   | **Runtime Verticalization**    | AF-203, AF-205 (runtime slice)   | `apps/runtime`           | Same app, same pattern                               |
| 7   | **Studio Verticalization**     | AF-204, AF-205 (studio slice)    | `apps/studio`            | Same app, same pattern                               |
| 8   | **Shared Decomposition**       | AF-301, AF-302, AF-303, AF-305   | `packages/shared`        | All target same package, sequential dependency       |
| 9   | **Shared Import Reduction**    | AF-304                           | `apps/runtime`, `studio` | Ongoing, no hard gate — track as metric              |
| 10  | **Runtime Core Decomposition** | AF-401, AF-402, AF-403, AF-404   | `apps/runtime`           | Sequential extraction plan                           |
| 11  | **Trace Canonicalization**     | AF-501, AF-502, AF-503, AF-504   | Cross-cutting            | All trace/STI, can run parallel with group 10        |

**Recommended execution order**: 1 → 2 → 3 → 4 → 5/6/7 (parallel) → 8 → 9 (ongoing) → 10/11 (parallel)

---

## Decision Log

| Date       | Decision                                                    | Context                                                        | Made By |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| 2026-03-29 | Dockerfile coverage assertions added despite spec exclusion | Beneficial deviation — checks real `package.json` deps per app | Impl    |
| 2026-03-29 | Phase 0 delivered as single branch with 5 focused commits   | All items tightly coupled; splitting PRs would add overhead    | Impl    |
| 2026-03-30 | Phase 0 rebased onto develop, PR #560 updated               | Clean history for merge                                        | Sai     |
