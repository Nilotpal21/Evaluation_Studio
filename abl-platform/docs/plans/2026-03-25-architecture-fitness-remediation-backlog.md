# Architecture Fitness Remediation Backlog

**Date:** 2026-03-25
**Status:** Proposed
**Scope:** Architecture fitness tests, boundary enforcement, layered-route remediation, shared-package decomposition, runtime-core simplification, and isolation hardening

## Goal

Turn the current architecture fitness suite into a trustworthy release gate, then use it to drive down the highest-value structural debt:

1. Fail-closed isolation for tenant- and project-scoped data access
2. Thin route handlers with service/repo layering
3. Reduced `packages/shared` coupling
4. Smaller, more composable runtime execution core
5. Stronger tracing/schema consistency
6. CI enforcement that blocks new debt instead of only reporting it

## Baseline (2026-03-25)

### Executable checks

- `pnpm --filter @agent-platform/shared-kernel test -- src/__tests__/architecture-fitness.test.ts`
  - 20 tests total
  - 18 passing
  - 2 failing
- `pnpm boundary-check`
  - 183 violations total
  - 172 warnings
  - 11 info
  - 0 hard errors

### Failing architecture-fitness checks

1. `TraceEvent definitions <= 10`
   - Current count: 11
   - Notable files:
     - `packages/compiler/src/platform/core/types.ts`
     - `packages/eventstore/src/migration/trace-bridge.ts`
     - `packages/mcp-debug/src/types.ts`
     - `apps/runtime/src/services/trace-store.ts`
     - `apps/runtime/src/types/index.ts`
     - `apps/studio/src/types/index.ts`

2. `total tracePath() coverage >= 11`
   - Current count: 9
   - Current instrumented paths:
     - `runtime/executor/agent-exit`
     - `runtime/executor/constraint-check`
     - `runtime/executor/decision`
     - `runtime/executor/delegate`
     - `runtime/executor/flow/step-exit`
     - `runtime/executor/flow/transition`
     - `runtime/executor/handoff`
     - `runtime/executor/llm-call`
     - `runtime/executor/tool-call`

### Scorecard snapshot

- Oversized route-like files (`tools/architecture-scorecard.sh` definition): 138 / 633
- Route-like files with direct DB access: 156
- `@agent-platform/shared` imports by app:
  - `apps/runtime`: 573
  - `apps/studio`: 210
  - `apps/search-ai`: 57
  - `apps/admin`: 0
- `packages/shared/src`: 108 TypeScript files
- `packages/shared-kernel/src`: 46 TypeScript files
- `apps/runtime/src/services/runtime-executor.ts`: 2914 LOC
- `apps/runtime/src/services/execution/flow-step-executor.ts`: 4633 LOC

### Boundary-check breakdown

- `no-db-in-routes`: 140
  - `apps/studio`: 83
  - `apps/runtime`: 31
  - `apps/search-ai`: 22
  - `apps/search-ai-runtime`: 4
- `no-app-to-app-runtime`: 32
  - All 32 are test-only imports
- `no-shared-to-database-direct`: 11

### Largest route-like hotspots

| File                                                 |  LOC |
| ---------------------------------------------------- | ---: |
| `apps/search-ai/src/routes/crawl.ts`                 | 2812 |
| `apps/runtime/src/routes/sessions.ts`                | 2566 |
| `apps/search-ai/src/routes/kg-taxonomy.ts`           | 2123 |
| `apps/runtime/src/routes/tenant-models.ts`           | 1617 |
| `apps/runtime/src/routes/channel-connections.ts`     | 1462 |
| `apps/runtime/src/routes/chat.ts`                    | 1434 |
| `apps/runtime/src/routes/deployments.ts`             | 1403 |
| `apps/studio/src/app/api/openapi/spec.json/route.ts` | 1323 |
| `apps/runtime/src/routes/environment-variables.ts`   | 1271 |
| `apps/search-ai/src/routes/intelligence.ts`          | 1120 |

### Highest DB-in-route hotspots

| File                                                | Direct DB Calls |
| --------------------------------------------------- | --------------: |
| `apps/search-ai/src/routes/kg-taxonomy.ts`          |              30 |
| `apps/runtime/src/routes/platform-admin-tenants.ts` |              21 |
| `apps/runtime/src/routes/platform-admin-deals.ts`   |              17 |
| `apps/search-ai/src/routes/crawl.ts`                |              17 |
| `apps/search-ai/src/routes/indexes.ts`              |              16 |
| `apps/search-ai/src/routes/kg-enrichment.ts`        |              16 |
| `apps/search-ai/src/routes/mappings.ts`             |              16 |
| `apps/search-ai/src/routes/knowledge-bases.ts`      |              15 |
| `apps/search-ai/src/routes/pipelines.ts`            |              15 |
| `apps/runtime/src/routes/channel-connections.ts`    |              13 |

### Current high-value positives

- No circular workspace package dependencies
- No dead workspace packages
- `findById()` usage is down to 7 files
- `console.*` in server packages is down to 86 total
- Workspace package count is stable at 43
- WebSocket session ownership is centralized through `validateSessionOwnership()`
- `agent-transfer-settings` already uses `req.tenantContext?.tenantId`
- `tenantIsolationPlugin` already rejects explicit cross-tenant writes on `validate` and `insertMany`

## Remediation Principles

1. Do not game the metrics.
   - Do not lower a failing ratchet unless the metric itself is wrong.
   - If the metric is wrong, fix the metric first and record the new baseline.

2. Trustworthiness before coverage.
   - A noisy or misleading check is worse than a missing check.
   - Fix harness drift before adding more gates.

3. Fix slices, then harden the gate for that slice.
   - Move a metric from `info` -> `warn` -> `error` only after the code is ready.

4. Separate production architecture from test convenience.
   - Test-only app-to-app imports should not hide production architectural drift.

5. Every remediation phase must tighten at least one ratchet.

## Open vs Stale Issue List

### Confirmed still open

- Project-scoped reads in `apps/runtime/src/repos/llm-resolution-repo.ts` still rely on `projectId` without `tenantId` for several queries
- `packages/shared` still depends on `@agent-platform/database`
- Route files still mix HTTP, validation, DB access, queueing, and orchestration concerns
- Runtime execution core remains oversized
- Architecture harness has drift between comments, thresholds, and actual code
- BullMQ LLM queue is still global (`llm-requests`)

### No longer backlog-worthy as primary fixes

- `apps/runtime/src/routes/agent-transfer-settings.ts` direct `x-tenant-id` trust
- `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts` explicit tenant override acceptance
- WebSocket soft ownership checks replaced by `validateSessionOwnership()`

These should still be covered by regression checks, but they should not consume top-of-backlog implementation time.

## Workstreams

### WS0 - Harness Trust and Signal Quality

Objective: make the existing architecture suite accurate enough to be used as a gate.

#### AF-001 - Fix scorecard route listing output

- Priority: P0
- Problem: `tools/architecture-scorecard.sh` prints LOC and path on separate lines, making the top-offender output unreadable.
- Files:
  - `tools/architecture-scorecard.sh`
- Action:
  - Emit `count path` on a single line before sorting.
  - Preserve current route selection semantics for now.
- Acceptance criteria:
  - `tools/architecture-scorecard.sh --all` shows both filename and line count for top offenders.
  - No empty filename rows remain.

#### AF-002 - Align architecture-fitness documentation with actual assertions

- Priority: P0
- Problem: the scorecard table in `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` no longer matches the live thresholds.
- Files:
  - `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- Action:
  - Update the header table to the real thresholds.
  - Fix mismatched text such as `ceiling 45` vs actual assertion `<= 45` / title `<= 48`.
- Acceptance criteria:
  - Every metric listed in the header matches the executable assertion beneath it.

#### AF-003 - Split production and test boundary signals

- Priority: P0
- Problem: all 32 `no-app-to-app-runtime` violations are test-only, which makes the production architecture signal noisy.
- Files:
  - `.dependency-cruiser.cjs`
  - `package.json`
  - optional new scripts under `tools/`
- Action:
  - Add separate depcruise modes for `src` and `__tests__`.
  - Keep the production gate focused on non-test code.
  - Optionally keep a softer test-architecture report.
- Acceptance criteria:
  - Production `boundary-check` reports only production architectural violations.
  - Test-only app-to-app imports are reported separately or explicitly allowlisted.

#### AF-004 - Make Dockerfile copy coverage a real gate

- Priority: P0
- Problem: the "Zero-Tolerance" Dockerfile test only logs with `console.warn`.
- Files:
  - `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- Action:
  - Convert the Dockerfile package coverage check into an actual assertion.
  - Scope the check clearly to direct runtime deps if full transitive coverage is too noisy.
- Acceptance criteria:
  - Missing required `COPY packages/<name>/package.json` lines fail the fitness suite.

#### AF-005 - Repair the TraceEvent duplication metric

- Priority: P0
- Problem: the current regex counts `.d.ts`, aliases, and local storage/view-model wrappers as equal forms of duplication.
- Files:
  - `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
  - candidate type files in runtime, studio, eventstore, mcp-debug
- Action:
  - Exclude `.d.ts` from the search.
  - Split the current metric into:
    - canonical `TraceEvent` schema definitions
    - local adapter/view/storage types that should be renamed rather than counted as canonical duplicates
  - Keep at least one strict ratchet for true duplicate definitions.
- Acceptance criteria:
  - The metric fails only on real canonical duplication, not on harmless adapters.
  - The resulting baseline is documented in the test header.

#### AF-006 - Resolve the STI floor mismatch

- Priority: P0
- Problem: critical-path coverage passes at 9/9, but the total floor is 11 while only 9 wrappers exist.
- Files:
  - `apps/runtime/src/services/execution/trace-forwarder.ts`
  - `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- Action:
  - Add at least two meaningful wrappers around missing execution boundaries, or
  - Reset the floor to the shipped baseline of 9 and ratchet back upward in the same PR that adds wrappers
- Preferred targets:
  - agent-enter equivalent boundary
  - flow-step-enter or completion-check equivalent boundary
- Acceptance criteria:
  - `architecture-fitness.test.ts` passes.
  - The floor and the actual instrumentation strategy are consistent.

### WS1 - Isolation Hardening for Project-Scoped Reads

Objective: remove fail-open project-scoped data access patterns and replace them with explicit tenant/project scoping.

#### AF-101 - Require tenantId for project-scoped LLM resolution repo functions

- Priority: P0
- Problem: `apps/runtime/src/repos/llm-resolution-repo.ts` contains multiple project-level queries without `tenantId`.
- Files:
  - `apps/runtime/src/repos/llm-resolution-repo.ts`
  - `apps/runtime/src/services/llm/model-resolution.ts`
  - related tests under `apps/runtime/src/__tests__/`
- Functions to harden:
  - `findAgentModelConfig(projectId, agentName)`
  - `findAgentModelConfigByDslName(projectId, dslAgentName)`
  - `findModelConfigByModelId(projectId, modelId)`
  - `findModelConfigForTier(projectId, tier)`
  - `findAnyModelConfig(projectId)`
  - `findProjectOperationTierOverrides(projectId)`
  - `findProjectEnableThinking(projectId, settingsVersionId?, tenantId?)`
- Action:
  - Make `tenantId` required for all project-scoped repo functions.
  - Add `tenantId` to every Mongo filter for project-owned documents.
  - Update all callers and tests to fail closed when `tenantId` is absent.
- Acceptance criteria:
  - No project-scoped function in this repo performs `findOne({ projectId })`.
  - Tenantless fallback tests are removed or replaced with explicit rejection behavior.

#### AF-102 - Add a lint/gate for project-scoped repo signatures

- Priority: P0
- Problem: route-level isolation hooks do not prevent repo helpers from silently omitting `tenantId`.
- Files:
  - new script under `tools/`
  - `package.json`
  - CI wiring
- Action:
  - Add a focused lint that flags project-scoped repo functions whose signatures or queries omit `tenantId`.
  - Start in warn mode if needed, but wire it into CI from day one.
- Acceptance criteria:
  - New unscoped project-level repo reads cannot land unnoticed.

#### AF-103 - Tighten archive-store interfaces to prefer tenant-safe methods only

- Priority: P1
- Problem: `getDownloadUrl()` and `delete()` remain available as raw methods in archive-store interfaces, even though routes already use tenant-safe wrappers.
- Files:
  - `apps/studio/src/services/archive/archive-types.ts`
  - `apps/studio/src/services/archive/s3-archive-store.ts`
  - `apps/studio/src/services/archive/local-archive-store.ts`
  - call sites under `apps/studio/src/app/api/archives/`
- Action:
  - Deprecate or narrow raw path-based methods for server-side callers.
  - Prefer `getDownloadUrlForTenant()` and `deleteForTenant()` in the public interface.
  - Add guard tests to ensure server routes never call raw methods.
- Acceptance criteria:
  - Archive HTTP handlers can only use tenant-scoped download/delete APIs.

#### AF-104 - Add regression protection for trusted-header bypasses

- Priority: P1
- Problem: current code is improved, but there is no repo-level gate preventing future `req.headers['x-tenant-id']` trust in server code.
- Files:
  - new lint script under `tools/`
  - `package.json`
- Action:
  - Add a grep/AST-based lint to block direct trust of `x-tenant-id` in server code outside an explicit allowlist.
- Acceptance criteria:
  - New server code cannot read tenant context directly from request headers without review.

#### AF-105 - Evaluate LLM queue tenant fairness

- Priority: P2
- Problem: `apps/runtime/src/services/llm/llm-queue.ts` uses a single global BullMQ queue (`llm-requests`), which risks noisy-neighbor behavior.
- Files:
  - `apps/runtime/src/services/llm/llm-queue.ts`
  - related queue config and metrics files
- Action:
  - Design and implement one of:
    - per-tenant concurrency caps
    - queue partitioning by tenant or plan tier
    - fair scheduling with explicit rate buckets
- Acceptance criteria:
  - The LLM queue has a documented tenant-fairness strategy.
  - The implementation surfaces per-tenant queue metrics.

### WS2 - Route and Service Verticalization

Objective: remove the worst route hotspots that drive both oversized-file and DB-in-route metrics.

#### AF-201 - Establish route extraction template

- Priority: P1
- Problem: there is no standard extraction shape, so every refactor risks inventing a different layering pattern.
- Files:
  - representative route(s)
  - new service/repo modules in affected apps
- Action:
  - Standardize on:
    - route: auth -> validate -> service -> response
    - service: orchestration/business rules
    - repo: persistence only
  - Add one short reference doc or code template.
- Acceptance criteria:
  - New extractions follow one repeatable pattern.

#### AF-202 - Search AI hotspot slice

- Priority: P1
- Target files:
  - `apps/search-ai/src/routes/crawl.ts`
  - `apps/search-ai/src/routes/kg-taxonomy.ts`
  - `apps/search-ai/src/routes/indexes.ts`
  - `apps/search-ai/src/routes/mappings.ts`
  - `apps/search-ai/src/routes/pipelines.ts`
- Why this slice:
  - Highest concentration of both size and DB-in-route debt
- Action:
  - Extract service/repo layers for at least `crawl.ts` and `kg-taxonomy.ts` first.
  - Move direct model usage out of the route files.
- Acceptance criteria:
  - `crawl.ts` and `kg-taxonomy.ts` each drop materially in LOC.
  - Direct DB access in those route files becomes zero.
  - Add slice-specific tests before moving on.

#### AF-203 - Runtime hotspot slice

- Priority: P1
- Target files:
  - `apps/runtime/src/routes/channel-connections.ts`
  - `apps/runtime/src/routes/platform-admin-tenants.ts`
  - `apps/runtime/src/routes/platform-admin-deals.ts`
  - `apps/runtime/src/routes/http-async-channel.ts`
- Why this slice:
  - High DB-in-route counts plus sensitive platform/admin behavior
- Action:
  - Extract services and repos.
  - Normalize auth, validation, response shaping, and logging.
- Acceptance criteria:
  - At least the first two files no longer access models directly.
  - Project/tenant scoping is explicit in extracted repos.

#### AF-204 - Studio proxy and project-settings slice

- Priority: P1
- Target files:
  - `apps/studio/src/app/api/projects/[id]/git/push/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/route.ts`
  - `apps/studio/src/app/api/projects/[id]/auth-profiles/**/route.ts`
  - `apps/studio/src/app/api/projects/[id]/module*/**/route.ts`
- Why this slice:
  - Studio carries the largest count of DB-in-route violations
- Action:
  - Push DB access behind repos/services where the route is not acting as a thin proxy.
  - Where Runtime should be the source of truth, move Studio to proxy mode instead of direct DB reads.
- Acceptance criteria:
  - The selected route cluster has zero direct model imports.

#### AF-205 - Ratchet the route gate by slice

- Priority: P1
- Problem: moving `no-db-in-routes` to hard-error repo-wide immediately would be too disruptive.
- Files:
  - `.dependency-cruiser.cjs`
  - optional focused scripts
- Action:
  - Promote the rule incrementally:
    - pilot directories -> error
    - remaining repo -> warn
- Acceptance criteria:
  - Refactored slices become regression-proof without blocking the entire monorepo at once.

### WS3 - Shared Package Decomposition

Objective: turn `packages/shared` from a coupling hub into a thin compatibility layer or decomposed set of focused packages.

#### AF-301 - Move database-backed repos out of `packages/shared`

- Priority: P1
- Current violating files:
  - `packages/shared/src/repos/mcp-server-config-repo.ts`
  - `packages/shared/src/repos/project-tool-repo.ts`
  - `packages/shared/src/repos/security-repo.ts`
- Action:
  - Relocate DB-backed repos into a more appropriate package.
  - Re-export temporarily only if needed to avoid a flag day.
- Acceptance criteria:
  - No repo implementation in `packages/shared` imports `@agent-platform/database`.

#### AF-302 - Move DB-coupled services out of `packages/shared`

- Priority: P1
- Current violating files:
  - `packages/shared/src/services/auth-profile/linked-app-validator.ts`
  - `packages/shared/src/services/auth-profile/oauth2-app-resolver.ts`
  - `packages/shared/src/services/auth-profile/token-refresh-service.ts`
  - `packages/shared/src/services/mcp-server-registry.ts`
  - `packages/shared/src/tools/resolve-tool-implementations.ts`
- Action:
  - Split by concern: auth-profile, MCP, tool-resolution, security.
- Acceptance criteria:
  - `packages/shared` no longer contains service implementations that require DB models.

#### AF-303 - Remove DB-coupled types from `packages/shared`

- Priority: P1
- Current violating files:
  - `packages/shared/src/types/mcp-server.ts`
  - `packages/shared/src/types/tools.ts`
  - `packages/shared/src/index.ts`
- Action:
  - Move domain-specific types to their owning packages.
  - Keep `shared-kernel` reserved for zero-dependency types and utilities.
- Acceptance criteria:
  - Type-only modules under `packages/shared` do not drag in database model imports transitively.

#### AF-304 - Reduce `@agent-platform/shared` import volume in apps

- Priority: P2
- Action:
  - Replace broad imports with narrower package imports during normal feature work.
  - Start with runtime and studio, which have the largest counts.
- Acceptance criteria:
  - Runtime and Studio import counts trend down release over release.

#### AF-305 - Ratchet `no-shared-to-database-direct`

- Priority: P1
- Action:
  - Once violating files are moved, change the depcruise rule:
    - `info` -> `warn`
    - then `warn` -> `error`
- Acceptance criteria:
  - `packages/shared` cannot re-acquire a database dependency.

### WS4 - Runtime Execution Core Simplification

Objective: break the runtime core into a true orchestration shell plus composable executors.

#### AF-401 - Define runtime/core decomposition target

- Priority: P1
- Problem: `runtime-executor.ts` and `flow-step-executor.ts` remain oversized without a single agreed extraction map.
- Files:
  - `apps/runtime/src/services/runtime-executor.ts`
  - `apps/runtime/src/services/execution/flow-step-executor.ts`
  - existing construct executors in `packages/compiler/src/platform/constructs/executors/`
- Action:
  - Produce an extraction map aligned with existing construct-layer executors.
  - Define which logic stays orchestration-only and which moves into sub-executors.
- Acceptance criteria:
  - The team has a written extraction plan tied to concrete modules.

#### AF-402 - Extract completion/routing boundaries first

- Priority: P1
- Why first:
  - High control-flow value
  - Good leverage for tracing and parity checks
- Candidate targets:
  - completion detection
  - handoff/delegate routing
  - flow transition decisions
- Acceptance criteria:
  - At least one meaningful chunk is removed from both oversized core files.

#### AF-403 - Add parity/contract tests for extracted execution behavior

- Priority: P1
- Problem: refactors in the execution core are risky without observable-behavior coverage.
- Action:
  - Capture behavior around:
    - responses
    - state mutation
    - trace emission
    - handoff/delegate outcomes
- Acceptance criteria:
  - Refactors are backed by contract-style tests instead of only internal unit tests.

#### AF-404 - Set staged LOC budgets

- Priority: P2
- Stage targets:
  - `runtime-executor.ts` <= 2500, then <= 2000, then <= 1500
  - `flow-step-executor.ts` <= 4000, then <= 3500, then <= 3000
- Acceptance criteria:
  - Each stage corresponds to a merged extraction, not formatting-only churn.

### WS5 - Trace Schema and STI Canonicalization

Objective: make trace typing and instrumentation consistent across runtime, studio, eventstore, and tooling.

#### AF-501 - Rename local trace wrappers so only canonical types are named `TraceEvent`

- Priority: P1
- Candidate files:
  - `apps/runtime/src/services/trace-store.ts`
  - `apps/runtime/src/services/adapters/trace-manager-adapter.ts`
  - `apps/runtime/src/types/index.ts`
  - `apps/studio/src/types/index.ts`
  - `packages/eventstore/src/migration/trace-bridge.ts`
  - `packages/mcp-debug/src/types.ts`
- Action:
  - Rename local storage/view models to names like:
    - `StoredTraceEvent`
    - `StudioTraceEvent`
    - `TraceBridgeEvent`
    - `McpDebugTraceEvent`
  - Keep canonical `TraceEvent` in `@agent-platform/shared-kernel`.
- Acceptance criteria:
  - Local wrappers no longer masquerade as canonical definitions.

#### AF-502 - Preserve typed re-exports where they add value

- Priority: P1
- Example:
  - `packages/compiler/src/platform/core/types.ts` type aliasing the canonical event is acceptable if the naming remains honest and does not create schema drift.
- Action:
  - Keep harmless aliases if needed.
  - Remove or rename only the cases that create confusion or duplicate schemas.
- Acceptance criteria:
  - The architecture metric reflects semantic duplication, not all mention sites.

#### AF-503 - Add missing STI boundaries

- Priority: P1
- Candidate boundaries:
  - agent enter
  - flow step enter
  - completion check
  - escalation
- Acceptance criteria:
  - Total `tracePath()` coverage exceeds the new floor.
  - The added wrappers correspond to actual debugging value, not filler.

#### AF-504 - Ratchet STI by event family, not only total count

- Priority: P2
- Action:
  - Consider separate floors for:
    - LLM/tool boundaries
    - flow/routing boundaries
    - agent lifecycle boundaries
- Acceptance criteria:
  - STI coverage grows in meaningful categories, not just via arbitrary wrapper count.

### WS6 - Enforcement and CI Hardening

Objective: move from "good local checks" to "reliable shared enforcement".

#### AF-601 - Promote architecture checks into CI stages

- Priority: P0
- Action:
  - Run the fitness suite in CI explicitly.
  - Run production boundary checks in CI explicitly.
  - Publish scorecard artifacts for visibility.
- Acceptance criteria:
  - New PRs cannot silently increase protected metrics.

#### AF-602 - Add AST/ESLint rules for architectural invariants

- Priority: P1
- Candidate invariants:
  - no database imports in route files
  - no direct `x-tenant-id` trust in server handlers
  - project-scoped repo functions must require `tenantId`
  - no raw archive-store path methods in HTTP handlers
- Acceptance criteria:
  - Critical architectural rules no longer depend only on regex.

#### AF-603 - Convert fixed slices into zero-regression zones

- Priority: P1
- Action:
  - When a route cluster or package slice is cleaned up, tighten the corresponding rule for that slice immediately.
- Acceptance criteria:
  - Debt does not reappear in already-remediated areas.

#### AF-604 - Add a scripted architecture baseline refresh

- Priority: P2
- Action:
  - Create a simple workflow to regenerate:
    - scorecard
    - boundary summary
    - fitness baseline notes
  - Save outputs under `docs/architecture/`
- Acceptance criteria:
  - Metric drift is visible without manually reconstructing it from multiple commands.

## Phased Delivery

### Phase 0 - Trust the Gate

Target: 3 to 5 days

- AF-001 scorecard output
- AF-002 header/assertion drift
- AF-003 split prod/test boundary signals
- AF-004 Dockerfile coverage as a real gate
- AF-005 TraceEvent metric repair
- AF-006 STI floor mismatch
- AF-601 CI wiring for existing checks

Exit criteria:

- The fitness suite passes or fails for reasons the team agrees are valid
- Production boundary-check output is readable and actionable
- Scorecard output is trustworthy enough to use in review threads

Ratchet updates unlocked:

- Keep or tighten the repaired fitness thresholds
- Make Dockerfile coverage truly blocking

### Phase 1 - Close Isolation Gaps

Target: 1 week

- AF-101 project-scoped LLM resolution hardening
- AF-102 repo-signature lint
- AF-103 tenant-safe archive interfaces
- AF-104 trusted-header regression lint

Exit criteria:

- Project-scoped LLM resolution queries always include `tenantId`
- No tenantless fallback remains for project settings/model resolution

Ratchet updates unlocked:

- Add a fitness or CI rule for project-scoped repo scoping

### Phase 2 - Remove the Worst Route Hotspots

Target: 2 to 4 weeks

- AF-201 extraction template
- AF-202 Search AI hotspot slice
- AF-203 Runtime hotspot slice
- AF-204 Studio route slice
- AF-205 slice-based route gating

Exit criteria:

- At least one major hotspot per app family is vertically sliced
- Refactored slices have zero direct DB access in route files

Ratchet updates unlocked:

- Promote `no-db-in-routes` from warn to error for cleaned slices

### Phase 3 - Decompose `packages/shared`

Target: 1 to 2 weeks

- AF-301 through AF-305

Exit criteria:

- `packages/shared` no longer depends on database
- app import counts begin shifting to narrower packages

Ratchet updates unlocked:

- Promote `no-shared-to-database-direct` to `warn`, then `error`

### Phase 4 - Simplify Runtime Core

Target: multi-sprint

- AF-401 through AF-404
- AF-501 through AF-504 in parallel where helpful

Exit criteria:

- Runtime core files shrink meaningfully
- Execution refactors are protected by parity/contract coverage

Ratchet updates unlocked:

- Lower LOC ceilings as each extraction lands
- Raise STI floors as each real boundary is instrumented

## Recommended Execution Order

If only a few items can be started immediately, use this order:

1. AF-001 through AF-006
2. AF-101
3. AF-102 and AF-104
4. AF-202 and AF-203
5. AF-301 through AF-305
6. AF-401 through AF-404

## Definition of Done for This Backlog

This remediation backlog is complete when all of the following are true:

- `architecture-fitness.test.ts` is both passing and trusted
- production `boundary-check` is suitable for CI gating
- project-scoped repo reads require `tenantId`
- at least the worst route hotspots no longer contain direct DB logic
- `packages/shared` is no longer a DB-coupled hub
- runtime-core LOC ratchets move down because code was actually extracted
- each completed slice tightens at least one architectural gate
