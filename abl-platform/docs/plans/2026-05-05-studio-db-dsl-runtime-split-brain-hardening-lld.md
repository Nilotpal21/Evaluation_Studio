# LLD: Studio DB DSL Runtime Split-Brain Hardening

**Status**: IMPLEMENTED
**Date**: 2026-05-05

---

## 1. Design Decisions

| #   | Decision                                                                                                        | Rationale                                                                                                                 | Alternatives Rejected                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D-1 | Treat `dslValidationStatus` with the same fail-closed predicate everywhere.                                     | Export, runtime launch, and legacy model fallback must agree on which draft DSL can influence execution.                  | Keeping ad-hoc checks such as `status === "error"` allows unvalidated legacy drafts to keep influencing runtime. |
| D-2 | Any `ProjectAgent.dslContent` writer must either refresh draft metadata or clear it to unvalidated.             | Stale `valid` metadata is worse than missing metadata because readiness gates trust it.                                   | Letting versioning paths update DSL without metadata refresh.                                                    |
| D-3 | Runtime session startup should use the same project-readiness scope as export when saved runtime config exists. | Runtime config is read during execution, so invalid saved config should not silently become defaults while export blocks. | Validating only at export/import time.                                                                           |
| D-4 | `ActionHandlerIR.do[]` remains canonical, but legacy mirrors must be populated from canonical actions.          | Runtime is correct on `do[]`, but diagnostics and older consumers still inspect top-level mirrors.                        | Requiring every consumer to migrate before preventing split-brain.                                               |

## 2. File-Level Change Map

### New Files

| File                                                                       | Purpose                                      |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| `docs/plans/2026-05-05-studio-db-dsl-runtime-split-brain-hardening-lld.md` | Future-ready design and implementation plan. |

### Modified Files

| File                                                                               | Change Description                                                           | Risk   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| `packages/project-io/src/project-agent-export-readiness.ts`                        | Export shared draft-blocking predicate.                                      | Low    |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                                    | Use shared predicate for legacy DSL-name model config fallback.              | Medium |
| `apps/runtime/src/services/stores/mongo-agent-registry.ts`                         | Refresh/clear ProjectAgent draft metadata after version registry DSL writes. | Medium |
| `apps/runtime/src/services/session/session-bootstrap.ts`                           | Use shared export/runtime readiness for project session loading.             | Medium |
| `apps/runtime/src/channels/pipeline/session-factory.ts`                            | Use shared export/runtime readiness for channel working-copy sessions.       | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                                        | Use shared export/runtime readiness for SDK legacy working-copy sessions.    | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                                    | Use shared export/runtime readiness for IR rebuild fallback.                 | Medium |
| `apps/runtime/src/services/deployment-resolver.ts`                                 | Use shared export/runtime readiness for deployment working-copy fallback.    | Medium |
| `apps/runtime/src/repos/project-repo.ts`                                           | Add scoped ProjectRuntimeConfig lookup for readiness checks.                 | Low    |
| `packages/compiler/src/platform/ir/action-handler-utils.ts`                        | Populate legacy mirrors from canonical `do[]`.                               | Medium |
| `packages/compiler/src/platform/ir/compiler.ts`                                    | Initialize action-handler mirrors from canonical actions at compile time.    | Medium |
| Focused tests under `packages/project-io`, `apps/runtime`, and `packages/compiler` | Lock each slice red-first.                                                   | Low    |

## 3. Implementation Phases

### Phase 1: Shared Draft Readiness Predicate

**Goal**: Make unvalidated draft blocking reusable and use it in model-resolution fallback.

**Tasks**:

1. Add/lock a project-io unit test for `isProjectAgentDraftReadinessBlocked`.
2. Add runtime integration coverage for `findAgentModelConfigByDslName` ignoring `null`/unknown statuses.
3. Replace the local `status === "error"` fallback guard with the shared predicate.

**Exit Criteria**:

- Project-io helper tests pass.
- Runtime repo integration test for DSL-name model fallback passes.

### Phase 2: ProjectAgent Write-Path Metadata Integrity

**Goal**: Ensure runtime versioning cannot leave stale valid metadata after changing draft DSL.

**Tasks**:

1. Add a MongoAgentRegistry regression test proving `saveVersion()` refreshes/invalidates metadata.
2. Route parent `ProjectAgent` version writes through runtime draft metadata refresh.
3. Preserve tenant/project scoping and avoid direct unscoped writes.

**Exit Criteria**:

- MongoAgentRegistry focused test passes.
- No new unrefreshed `ProjectAgent.dslContent` writer remains in the touched path.

### Phase 3: Runtime Session Readiness Parity

**Goal**: Session startup and export agree on agent/runtime-config readiness.

**Tasks**:

1. Add focused tests for project readiness helper covering runtime-config invalidity.
2. Reuse shared project readiness from runtime session startup instead of agent-only readiness.
3. Keep error surface sanitized and deterministic.

**Exit Criteria**:

- Session readiness tests pass.
- Existing project-io export readiness tests pass.

### Phase 4: Canonical Action Handler Mirror Parity

**Goal**: Ordered `do[]` handlers populate compatibility mirrors for older compiler/runtime consumers.

**Tasks**:

1. Add compiler tests for step `ON_ACTION DO` and agent `ACTION_HANDLERS DO` mirrors.
2. Update compiler mirror sync to derive mirrors from canonical actions even when legacy fields were absent.
3. Verify template/rich-content post-processing still updates both surfaces.

**Exit Criteria**:

- Compiler action-handler and template-resolution focused tests pass.

## 4. Wiring Checklist

- [x] Shared readiness predicate exported from `@agent-platform/project-io`.
- [x] Runtime model-resolution fallback imports the shared predicate.
- [x] Runtime session startup paths call shared project readiness when runtime config is present.
- [x] Runtime version registry refreshes ProjectAgent draft metadata after parent DSL writes.
- [x] Compiler action-handler mirrors are populated during compile and after template post-processing.

## 5. Acceptance Criteria

- [x] All four focused regression slices pass.
- [x] Affected package builds are attempted after formatting.
- [x] Remaining unrelated dirty work is not modified.
