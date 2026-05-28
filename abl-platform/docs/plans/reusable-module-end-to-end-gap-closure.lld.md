# Reusable Module End-to-End Gap Closure LLD

Date: 2026-05-02
Status: Focused implementation verified

## Goal

Close the remaining hidden gaps in reusable project modules across the full path:

Studio import and upgrade -> dependency database record -> deployment DSL/materialized snapshot -> runtime session creation -> tool execution.

The target behavior is deterministic, fail-closed, and future-ready for richer module contracts without relying on stale preview state or duplicated symbol naming rules.

## Current Findings

1. Import preview and confirm now resolve selectors, validate alias format, and detect mounted symbol collisions before persistence.
2. Dependency list re-resolves environment selectors and exposes update availability without mutating stored dependency records.
3. Upgrade persistence still updates `resolvedReleaseId`, `resolvedVersion`, and `contractSnapshot`, but not the selector. Version-pinned dependencies can therefore display version `2.0.0` after upgrade while deployment selector resolution can still mount the old release.
4. Upgrade preview uses human-readable `alias.name` mounted symbols while deployment/runtime use canonical `alias__name`, making collision and diff output inconsistent.
5. Upgrade preview does not expose target-release mounted symbol collisions, and upgrade confirm does not block a target release that introduces colliding mounted agents/tools.
6. Deployment resolver merges module snapshot tools into `resolvedTools`, but runtime session/tool wiring is driven by `compilationOutput.agents[*].tools`. A mounted tool that only exists in `resolvedTools` can be visible in the deployment result yet not executable by the session.

## Design Contract

1. `selector` is the durable source of deploy-time resolution. Any explicit upgrade by `targetReleaseId` rewrites the dependency to a deterministic version selector: `{ type: "version", value: targetRelease.version }`.
2. `resolvedReleaseId` and `resolvedVersion` are denormalized audit/display fields. They must always match the persisted selector after explicit upgrades.
3. Mounted symbol names are always canonical `alias__symbolName` across preview, confirm, deployment, and runtime.
4. Upgrade preview must report target-release mounted collisions before users confirm.
5. Upgrade confirm must re-check collisions inside the write path and fail closed before mutating the dependency.
6. Runtime session creation must materialize module-resolved tool definitions into each agent IR that references those mounted tool names, preserving agent-specific DSL behavior fields while replacing the stub with the executable binding.
7. Tool execution wiring remains compilation-output based after materialization, so downstream runtime paths keep a single executable source of truth.

## Test-First Slices

### Slice 1: Upgrade Selector Persistence

Locking test:

- `PATCH /api/projects/:id/module-dependencies/:dependencyId` asserts `findOneAndUpdate` sets `selector: { type: "version", value: targetRelease.version }`.

Implementation:

- Add selector rewrite to the upgrade `$set`.
- Include selector in response data for observability.

Exit criteria:

- Focused Studio upgrade route test passes.

### Slice 2: Upgrade Collision and Canonical Symbol Preview

Locking tests:

- Diff preview reports added mounted symbols as `alias__name`.
- Diff preview reports collisions for target-release added mounted symbols.
- Upgrade confirm returns `409` and does not mutate when target release introduces mounted symbol collisions.

Implementation:

- Reuse `findMountedSymbolCollisions()` from the import route in diff and upgrade confirm.
- Extend diff response with `collisions`.
- Block upgrade confirm on non-empty collisions.

Exit criteria:

- Existing import collision behavior remains unchanged.
- Focused Studio upgrade/diff route tests pass.

### Slice 3: Runtime Module Tool Materialization

Locking test:

- `createSessionFromResolved()` receives a resolved deployment with `resolvedTools.payments__lookup` and an agent IR that references a stub tool of the same name. The created session and compilation output contain the executable resolved tool definition, and tool wiring receives that resolved definition.

Implementation:

- Add a helper in runtime session creation to merge `resolved.resolvedTools` into `agents` and `compilationOutput.agents`.
- Preserve DSL behavior fields such as `on_result`, `on_error`, `store_result`, `context_access`, auth/consent/PII/confirmation metadata when replacing stubs.
- Store `resolvedTools` on `RuntimeSession` for provenance/debugging.

Exit criteria:

- Focused runtime session/tool wiring test passes.
- Existing module deployment resolver tests still pass.

## Verification Plan

Run build before tests, per repository contract:

1. `pnpm build --filter=@agent-platform/studio`
2. `pnpm --dir apps/studio exec vitest run --config vitest.node.config.ts src/__tests__/api-routes/api-module-upgrade.test.ts`
3. `pnpm build --filter=@agent-platform/runtime`
4. `pnpm --dir apps/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/agent-registry-isolation.test.ts`

Before committing, run:

1. `npx prettier --write <changed files>`
2. `pnpm build`
3. `pnpm test`

## Verification Performed

1. `npx prettier --write docs/plans/reusable-module-end-to-end-gap-closure.lld.md apps/studio/src/__tests__/api-routes/api-module-upgrade.test.ts apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts apps/runtime/src/__tests__/agent-registry-isolation.test.ts apps/runtime/src/services/execution/types.ts apps/runtime/src/services/runtime-executor.ts`
2. `pnpm build --filter=@agent-platform/studio` passed. Existing Turbopack warnings remain for `apps/studio/src/app/api/abl/docs/route.ts`.
3. `pnpm --dir apps/studio exec vitest run --config vitest.node.config.ts src/__tests__/api-routes/api-module-upgrade.test.ts` passed: 17 tests.
4. `pnpm build --filter=@agent-platform/runtime` passed.
5. `pnpm --dir apps/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/agent-registry-isolation.test.ts` passed: 15 tests.
