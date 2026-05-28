# LLD: Reusable Module Symbol and Release Lifecycle Parity

**Status**: IMPLEMENTED
**Date**: 2026-05-03
**Audit Thread**: Studio -> DB -> DSL -> runtime execution for reusable project modules

## 1. Fresh Audit Findings

### GAP-001: Studio collision checks used split agent/tool namespaces

Studio preview and confirm-import checked mounted module agents only against local agents, and mounted module tools only against local tools. Runtime deployment builds use a single local symbol set containing both project agents and project tools. This let Studio accept imports that could later fail during deployment if a mounted tool name collided with a local agent name, or a mounted agent name collided with a local tool name.

### GAP-002: Runtime did not flag internal mounted-name collisions

The runtime alias rewriter checked mounted names against existing consumer symbols, but did not flag collisions created inside the module itself. A module artifact with an agent and tool sharing the same artifact key could mount both as `alias__name`, violating the runtime's global symbol namespace contract.

### GAP-003: Deployment release reload missed the archive guard

`resolveSelector(...)` only returns non-archived releases, but the deployment build service reloaded the resolved release by ID without an `archivedAt` filter. If a release was archived after selector resolution but before artifact load, the deployment build could still snapshot an archived release.

## 2. Future-Ready Contract

### Symbol Namespace Contract

Mounted reusable-module symbols are globally unique within a consumer project deployment. Agents and tools share one mounted namespace for collision purposes, even though they are stored in separate runtime maps.

| Layer                 | Responsibility                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| Studio preview        | Report collisions for every mounted symbol against local agents and tools. |
| Studio confirm import | Fail closed on the same collision rules as preview.                        |
| Runtime alias rewrite | Fail deployment on external or internal mounted-name collisions.           |
| Snapshot payload      | Store only collision-free mounted agents/tools.                            |

### Release Lifecycle Contract

Selector resolution and artifact load must both enforce non-archived release state. The second check closes the race between pointer/version resolution and deployment snapshot materialization.

## 3. Slice Implementation Plan

### Slice 1: Studio Global Collision Lock

1. Add failing route tests for mounted tool-to-local-agent collisions in preview and confirm import.
2. Change the shared collision utility to collect all mounted symbols from provided agents and tools.
3. Query both `ProjectAgent` and `ProjectTool` using that full mounted symbol list.
4. Preserve existing mounted symbol response shape so UI clients do not need a contract migration.

### Slice 2: Runtime Internal Collision Lock

1. Add a failing alias rewriter test where a module agent and tool share the same artifact key.
2. Detect duplicate mounted names across the module's own agent and tool artifact keys.
3. Return the duplicate mounted name in `collisions` so the existing deployment-build error path blocks snapshot creation.

### Slice 3: Archived Release Reload Lock

1. Add a failing deployment build test where selector resolution succeeds but release reload should treat the release as archived.
2. Add `archivedAt: { $in: [null, undefined] }` to the runtime release reload query.
3. Keep the existing `RELEASE_NOT_FOUND` diagnostic code and broaden the message to "not found or archived".

## 4. Verification

- [x] Red lock observed: Studio confirm import returned `201` for a mounted tool/local agent collision.
- [x] Red lock observed: Studio preview returned no collision for a mounted tool/local agent collision.
- [x] Red lock observed: runtime alias rewriter returned no collision for internal agent/tool mounted-name overlap.
- [x] Red lock observed: runtime deployment build snapshotted a release after selector resolution despite the reload race.
- [x] Focused Studio collision tests pass.
- [x] Focused runtime symbol/lifecycle tests pass.

## 5. Rollback

Revert the collision utility and runtime alias/deployment build changes. No DB migration is required because the patch only tightens validation and deploy-time materialization.
