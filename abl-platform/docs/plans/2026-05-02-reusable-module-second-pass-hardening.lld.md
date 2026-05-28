# LLD: Reusable Module Studio-to-Runtime Second-Pass Hardening

**Status**: IMPLEMENTED
**Date**: 2026-05-02
**Related Plan**: `docs/plans/2026-05-02-reusable-module-e2e-hardening-impl-plan.md`

---

## 1. Design Contract

Reusable module execution must be deterministic, portable, and fail-closed from Studio publish through deployment snapshot resolution and runtime execution.

1. Deployment module snapshots are deployment-scoped overlays. They must never mutate shared compilation caches or bleed mounted agents/tools across deployments.
2. Module release artifacts must stay portable. Publish must not persist source-project `{{config.*}}` substitutions into `compiledIR`.
3. Deploy-time module materialization must surface every warning/error produced during recompile, not silently downgrade diagnostics.
4. A corrupt deployment module snapshot is a deployment integrity failure, not a local-only fallback.
5. Environment selector lifecycle checks must use live selector/snapshot state, not stale denormalized dependency fields.
6. Contract prerequisites must be surfaced consistently across preview, upgrade, and deploy.
7. Snapshot hashes must represent behavior-affecting mounted content, including overrides and rewritten definitions.

---

## 2. Decision Log

| #   | Decision                                                                                                           | Rationale                                                                                                            | Alternatives Rejected                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D-1 | Clone cached `CompilationOutput` before applying module overlays.                                                  | The cache is tenant-agnostic and shared by hash; mutating it creates cross-deployment contamination.                 | Keying local compilation cache by deployment id, which defeats compile cache reuse.                              |
| D-2 | Keep publish-time `compiledIR` portable by compiling module releases without project config variable substitution. | Consumers must provide their own config context at mount time. Source project values must not leak into fallback IR. | Scrubbing after substitution, which cannot reliably distinguish literal author text from resolved config values. |
| D-3 | Preserve recompile diagnostics on success.                                                                         | Warnings are part of the deploy contract; dropping them hides future runtime failures.                               | Only logging warnings, which is invisible to deployment callers.                                                 |
| D-4 | Throw on corrupt module snapshots.                                                                                 | Serving a partial graph from a deployment that claims module dependencies is unsafe and hard to debug.               | Continue local-only fallback, which silently changes behavior.                                                   |
| D-5 | Resolve environment selectors live for lifecycle checks.                                                           | Denormalized `resolvedReleaseId` is a snapshot of import time and can be stale after pointer moves.                  | Mutating dependency rows on read, which creates surprising write behavior and version churn.                     |
| D-6 | Enforce env/MCP prerequisites at deployment when environment context is available.                                 | Preview warnings are not a production guarantee; deployment is the last safe fail-closed boundary.                   | Waiting until runtime tool execution, where failures become user-visible.                                        |

---

## 3. Slice Plan

### Slice 1: Runtime Cache Isolation

**Goal**: Module overlays are per-resolution copies and cannot mutate cached local compilation outputs.

**Files**

- `apps/runtime/src/services/deployment-resolver.ts`
- `apps/runtime/src/__tests__/tools-deployment/deployment-resolver.test.ts`

**Test Lock**

- Two deployments sharing one compilation hash but different module snapshots resolve independently.
- The cached compilation object remains local-only after both resolutions.

**Exit Criteria**

- [x] Targeted resolver test fails before implementation and passes after implementation.
- [x] Mounted agents remain available in `result.compilationOutput.agents` for session registry and tool wiring.

### Slice 2: Portable Publish Artifacts

**Goal**: Module publish validates DSL without baking source project config values into release `compiledIR`.

**Files**

- `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`
- `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts`

**Test Lock**

- Publish route does not pass non-profile `ProjectConfigVariable` values to `compileABLtoIR`.
- Behavior profile config documents are still included as documents, not `config_variables`.

### Slice 3: Deploy Diagnostics and Snapshot Integrity

**Goal**: Deploy callers see recompile warnings and corrupt snapshots fail closed.

**Files**

- `apps/runtime/src/services/modules/deployment-build-service.ts`
- `apps/runtime/src/services/deployment-resolver.ts`
- `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`
- `apps/runtime/src/__tests__/tools-deployment/module-preview.integration.test.ts`
- `apps/runtime/src/__tests__/tools-deployment/module-preview.unit.test.ts`

**Test Lock**

- Recompile success with unresolved config templates returns `UNRESOLVED_CONFIG_VARIABLE` diagnostics.
- Corrupt compressed module snapshots reject deployment resolution.

### Slice 4: Lifecycle and Prerequisite Parity

**Goal**: Studio lifecycle APIs and deployment preflight use the same live contract.

**Files**

- `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts`
- `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts`
- `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`
- `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`
- `apps/studio/src/__tests__/api-routes/api-module-consumers.test.ts`
- `apps/runtime/src/services/modules/deployment-build-service.ts`
- `apps/runtime/src/routes/deployments.ts`

**Test Lock**

- Preview reports env var and MCP server prerequisites.
- Archive ignores stale environment-selector denormalized release ids after the pointer moved.
- Archive and consumer active-deployment checks consider active/draining deployments, not retained retired snapshots.
- Deployment build fails when required env vars or MCP servers are missing for the target consumer project/environment.

### Slice 5: Behavioral Snapshot Hashing

**Goal**: Snapshot hash changes when mounted behavior changes.

**Files**

- `apps/runtime/src/services/modules/deployment-build-service.ts`
- `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`

**Test Lock**

- Snapshot hash includes dependency metadata, config overrides, mounted agent IR, and mounted tool definitions.

---

## 4. Wiring Checklist

- [x] Deployment resolver cache-hit path clones before module overlay.
- [x] Deployment resolver DB path caches local compilation before overlay and resolves with an overlay copy.
- [x] Runtime session creation still sees mounted agents/tools through `compilationOutput`.
- [x] Studio publish still packages behavior profiles and prompt companions.
- [x] Deployment route passes target environment into module build preflight.
- [x] Promotion fallback module build passes target environment into preflight.
- [x] Studio preview, upgrade, and deployment emit prerequisite parity for config/auth/connectors/env/MCP.

---

## 5. Acceptance Criteria

- [x] Focused runtime resolver tests pass.
- [x] Focused deployment build tests pass.
- [x] Focused Studio module route tests pass.
- [x] `pnpm build --filter=@agent-platform/runtime` passes.
- [x] `pnpm build --filter=@agent-platform/studio` passes.
- [x] `npx prettier --write <changed files>` has been run before final handoff.
