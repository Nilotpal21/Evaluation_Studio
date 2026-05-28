# LLD: Studio DB DSL Runtime Readiness Parity

**Status**: IN PROGRESS
**Date**: 2026-05-06

---

## 1. Design Decisions

| #   | Decision                                                                                                                                                                    | Rationale                                                                                                                                                 | Backward Compatibility                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Treat `ProjectRuntimeConfig` and `ProjectLLMConfig` as a single execution-readiness context anywhere a project working copy can export, sync, preview, compile, or execute. | `getProjectExportReadinessIssues` already owns both runtime-config and model-policy validation; callers were only partially supplying the context.        | Missing `ProjectLLMConfig` remains allowed and falls back to platform defaults; existing projects without a model-policy document keep working.    |
| D-2 | Preserve release-locked `project_runtime_config` when deploy-time module recompilation succeeds.                                                                            | Recompilation is still needed for consumer config/tool materialization, but it must not discard the publish-time runtime config embedded in `compiledIR`. | Legacy releases without `compiledIR.project_runtime_config` behave exactly as before.                                                              |
| D-3 | Route Studio read/AI validation compiles through the project-aware compiler context instead of rebuilding partial compiler options locally.                                 | The canonical helper already resolves sibling docs, config variables, behavior profiles, runtime config, prompt refs, and tool implementations.           | Read routes continue returning best-effort IR; context failures become warnings/errors in existing response fields instead of hard-breaking reads. |
| D-4 | Add narrow regression locks at each seam rather than broad snapshot rewrites.                                                                                               | These are propagation bugs; small tests catch future bypasses without freezing unrelated compiler output.                                                 | Tests assert contract-level behavior and avoid depending on incidental IR structure.                                                               |

## 2. File-Level Change Map

| File                                                            | Change                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/runtime/src/repos/project-repo.ts`                        | Add tenant/project-scoped `findProjectLLMConfig`.                                |
| `apps/runtime/src/services/project-working-copy-compiler.ts`    | Load and pass `llmConfig` into `evaluateProjectExecutionReadiness`.              |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`         | Fetch `ProjectLLMConfig` and pass it to export readiness.                        |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`       | Same as export route for git sync readiness.                                     |
| `apps/studio/src/app/api/projects/[id]/export/preview/route.ts` | Same as export route for export preview readiness.                               |
| `apps/studio/src/app/api/projects/[id]/bundle/route.ts`         | Same as export route for legacy bundle readiness.                                |
| `apps/studio/src/services/export-job-processor.ts`              | Same as export route for async export job readiness.                             |
| `apps/runtime/src/routes/project-io.ts`                         | Same as export route for runtime public project-io preview/export readiness.     |
| `apps/runtime/src/services/modules/deployment-build-service.ts` | Reapply release `project_runtime_config` onto successfully recompiled agent IRs. |
| `apps/studio/src/app/api/projects/[id]/topology/route.ts`       | Use `compileProjectAgentsForDiagnostics` for canonical project context.          |
| `apps/studio/src/app/api/agents/[name]/route.ts`                | Use project-aware diagnostic compile and `pickTargetIR` for legacy detail IR.    |
| `apps/studio/src/app/api/agents/apps/[domain]/route.ts`         | Use one project-aware diagnostic compile for all legacy app agent IRs.           |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`         | Use `buildStudioCompilerOptions` for full before/after validation compiles.      |

## 3. Implementation Slices

### Slice 1: Runtime Working-Copy Model Policy

**Goal**: Every `compileProjectWorkingCopy` caller inherits model-policy readiness without each route reimplementing it.

**Test Lock**:

- Add a Mongo-backed runtime unit test proving invalid `ProjectLLMConfig.operationTierOverrides` blocks working-copy compile before runtime execution.

**Exit Criteria**:

- `compileProjectWorkingCopy` passes both runtime config and LLM config to `evaluateProjectExecutionReadiness`.
- Absence of `ProjectLLMConfig` remains non-blocking.

### Slice 2: Export/Sync/Project-IO Readiness Parity

**Goal**: All export-like surfaces block invalid model policy the same way module release does.

**Test Lock**:

- Add Studio export route assertion that readiness receives `llmConfig`.
- Add runtime project-io assertion that readiness receives `llmConfig`.

**Exit Criteria**:

- Studio export, bundle, preview, git push, async export jobs, and runtime project-io preview/export pass `llmConfig`.
- Queries remain tenant/project scoped.

### Slice 3: Module Deployment Release Runtime Config Preservation

**Goal**: Deploy-time recompilation remains enabled but cannot erase release-locked runtime config.

**Test Lock**:

- Add deployment-build unit test that captures the stored snapshot and verifies mounted agent IR keeps `project_runtime_config` from `releaseDoc.compiledIR` after successful source recompilation.

**Exit Criteria**:

- Recompiled IR overlays cloned release runtime config by artifact agent name, with parsed-name fallback for compatibility.
- Releases without runtime config are unchanged.

### Slice 4: Studio Read/AI Canonical Compiler Context

**Goal**: Studio read and Arch AI validation surfaces stop constructing partial compiler options.

**Test Lock**:

- Add topology route assertion that the route calls the project-aware diagnostic compiler.
- Add Arch AI validation assertion that before/after compiles use `buildStudioCompilerOptions`-derived options.
- Extend legacy read route tests to assert project-aware IR path is used without changing response shape.

**Exit Criteria**:

- Topology, legacy agent detail/list, and Arch AI validation use canonical compiler options.
- Backward-compatible best-effort responses remain: failed context resolution degrades to response warnings/errors instead of throwing away the whole read path.

## 4. Wiring Checklist

- [ ] Runtime working-copy compiler reads canonical LLM config.
- [ ] Studio export-like surfaces include LLM config in readiness.
- [ ] Runtime project-io preview/export includes LLM config in readiness.
- [ ] Module recompilation receives release compiled IR context.
- [ ] Studio topology and legacy read routes import project-aware compile helpers.
- [ ] Arch AI validation imports canonical Studio compiler options.

## 5. Acceptance Criteria

- [ ] Scoped runtime build passes.
- [ ] Scoped Studio build attempted after edits; unrelated pre-existing failures are reported separately if present.
- [ ] Runtime tests for working-copy compiler, project-io route, and deployment build pass.
- [ ] Studio route/Arch AI tests pass.
- [ ] `npx prettier --write` runs on all changed files.
