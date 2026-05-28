# LLD + Implementation Plan: Project Import/Export Integrity & Best-Effort Round-Trip

**Feature Spec**: `docs/features/project-import-export.md`
**Test Spec**: `docs/testing/project-import-export.md`
**HLD**: `docs/specs/project-import-export.hld.md`
**Supporting Design**: `docs/superpowers/specs/2026-03-27-import-preview-diagnostics-design.md`
**Status**: IN PROGRESS
**Date**: 2026-03-27

---

## 1. Design Decisions

| #   | Decision                                                                               | Rationale                                                                               | Alternatives Rejected                                                     |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D-1 | Scope this as an end-to-end import/export integrity fix, not a `project-io`-only patch | The bugs cross `packages/project-io` and Studio preview/apply/export routes             | Fixing only package internals would leave preview/apply UX misleading     |
| D-2 | Treat tool parse errors and compile diagnostics as non-blocking preview issues         | Users asked to warn and proceed, not reject import                                      | Keeping `syntaxErrors.length > 0` as a hard gate                          |
| D-3 | Normalize legacy single-tool `.tools.abl` files on import                              | Existing exported bundles already contain this shape                                    | Rejecting historical bundles                                              |
| D-4 | Canonicalize standalone tool export to strict `TOOLS:` files                           | V2 export must stop emitting tool payloads the importer cannot parse canonically        | Leaving stored one-tool DSL as archive payload                            |
| D-5 | Use best-effort honest export for agents                                               | Export must not block unhealthy projects, but must not lie with `.agent.yaml` filenames | Failing export on compile problems or keeping raw ABL under `.agent.yaml` |
| D-6 | Resolve `entryAgentName` via imported alias map before apply                           | Preview/apply must agree on the canonical imported agent identity                       | Writing raw `manifest.entry_agent` directly to project state              |

## 2. File-Level Change Map

### Modified Files

| File                                                                | Change Description                                                              | Risk   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| `packages/project-io/src/types.ts`                                  | Add preview issue metadata and broaden export format typing                     | Medium |
| `packages/project-io/src/import/tool-extractor.ts`                  | Add legacy single-tool normalization and extraction metadata                    | Medium |
| `packages/project-io/src/import/project-importer-v2.ts`             | Build preview issues, fallbacks, digest, and acknowledge semantics              | High   |
| `packages/project-io/src/import/import-validator.ts`                | Keep blocking safety checks separate from non-blocking diagnostics              | Medium |
| `packages/project-io/src/export/folder-builder.ts`                  | Support honest `.agent.abl` / `.agent.yaml` path generation                     | Medium |
| `packages/project-io/src/export/manifest-generator.ts`              | Use actual exported paths and non-uniform format reporting                      | Medium |
| `packages/project-io/src/export/layer-assemblers/types.ts`          | Pass serializer hooks through V2 export context                                 | Medium |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts` | Canonicalize tools and add best-effort agent YAML materialization               | High   |
| `packages/project-io/src/export/project-exporter.ts`                | Wire serializer hooks and derive manifest format honestly                       | High   |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`     | Return unified preview issues instead of hidden diagnostics                     | Medium |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`       | Require acknowledgement for non-blocking issues and resolve entry-agent aliases | High   |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`             | Supply compile/serialize hook for V2 export and expose export warnings          | Medium |
| `apps/studio/src/api/project-io.ts`                                 | Update import preview/apply client contracts                                    | Medium |
| `apps/studio/src/components/projects/ImportDialog.tsx`              | Render issues/fallbacks and support “Import Anyway” acknowledgement             | Medium |

### Test Files

| File                                                            | Coverage                                                 | Risk   |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| `packages/project-io/src/__tests__/tool-extractor.test.ts`      | Legacy tool normalization + parse error metadata         | Low    |
| `packages/project-io/src/__tests__/core-assembler.test.ts`      | Canonical tool export + honest agent fallback pathing    | Medium |
| `packages/project-io/src/__tests__/project-importer-v2.test.ts` | Issue model, preview gating, digest, fallback visibility | Medium |
| `apps/studio/src/__tests__/api-export-routes.test.ts`           | V2 export compile/fallback behavior                      | Medium |
| `apps/studio/src/__tests__/api-route-validation.test.ts`        | Import apply acknowledgement contract                    | Medium |
| `apps/studio/src/__tests__/import-dialog.test.tsx`              | Preview warning rendering + acknowledgement UX           | Medium |

## 3. Implementation Phases

### Phase 1: Truthful Preview & Apply Acknowledgement

**Goal**: Show all import warnings/errors clearly and allow non-blocking proceed with explicit acknowledgement.

**Tasks**:

1. Add `canApply`, `requiresAcknowledgement`, `previewDigest`, `issues`, and issue counts to the v2 preview contract.
2. Surface tool parse errors and agent compile diagnostics in `importProjectV2`.
3. Update Studio preview/apply routes and client types to use the unified preview contract.
4. Update `ImportDialog` to render warnings/errors/fallbacks and require acknowledgement for non-blocking issues.

**Exit Criteria**:

- [ ] Tool parse failures appear in preview issues instead of being hidden
- [ ] `.agent.yaml` files receive compile diagnostics in preview
- [ ] Apply is blocked only for blocking issues or missing acknowledgement
- [ ] `pnpm build --filter=@agent-platform/project-io` passes
- [ ] `pnpm build --filter=@agent-platform/studio` passes

### Phase 2: Tool Round-Trip Integrity & Entry-Agent Alias Resolution

**Goal**: Make V2 tool payloads round-trip cleanly and keep apply identity resolution aligned with preview.

**Tasks**:

1. Teach `extractToolsFromFiles()` to normalize legacy single-tool `.tools.abl`.
2. Canonicalize standalone tool export into `TOOLS:` format.
3. Resolve entry-agent aliases against imported files before writing `Project.entryAgentName`.
4. Add warnings/fallbacks for legacy tool normalization and entry-agent alias resolution.

**Exit Criteria**:

- [ ] Historical single-tool `.tools.abl` files import without hard failure
- [ ] Exported standalone tool files parse via `parseToolFile()` with no normalization needed
- [ ] Apply writes the resolved imported entry-agent name instead of raw manifest alias
- [ ] `pnpm --filter @agent-platform/project-io test -- --run project-importer-v2 core-assembler` passes

### Phase 3: Honest Best-Effort Agent Export

**Goal**: Stop emitting non-YAML content under `.agent.yaml` while keeping export best-effort.

**Tasks**:

1. Pass a compile/serialize hook through V2 export.
2. Materialize agents as strict YAML when conversion succeeds.
3. Fall back to strict `.agent.abl` when YAML materialization fails.
4. Make manifest paths match actual exported file paths and mark the bundle format honestly.

**Exit Criteria**:

- [ ] No `.agent.yaml` file in a V2 export contains legacy uppercase ABL
- [ ] Failed YAML conversion downgrades to `.agent.abl` with warnings instead of failing export
- [ ] Manifest agent paths match the real files emitted
- [ ] `pnpm --filter @agent-platform/project-io test -- --run export-yaml core-assembler manifest-v2` passes

### Phase 4: Regression Coverage

**Goal**: Lock the behavior with targeted package and Studio tests.

**Tasks**:

1. Add package tests for tool normalization, preview issues, and export materialization.
2. Add Studio route/UI tests for preview/apply acknowledgement and export fallback warnings.
3. Run affected package builds and targeted tests, then broader package tests if clean.

**Exit Criteria**:

- [ ] New tests cover preview issues, legacy tool import, tool export canonicalization, entry-agent alias resolution, and honest YAML fallback
- [ ] `pnpm build --filter=@agent-platform/project-io` passes
- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] `pnpm --filter @agent-platform/project-io test -- --run` passes
- [ ] `pnpm --filter @agent-platform/studio test:node -- --runInBand` or targeted equivalent passes

## 4. Wiring Checklist

- [ ] New preview fields exported from `@agent-platform/project-io`
- [ ] Studio API client updated to the new preview/apply contract
- [ ] ImportDialog wired to the new issue/acknowledgement fields
- [ ] V2 export route passes compile hook into the export orchestrator
- [ ] Manifest generation uses actual materialized agent paths

## 5. Acceptance Criteria

- [ ] Import preview is truthful about tool errors, compile errors, fallbacks, and blocking conditions
- [ ] Non-blocking issues warn and allow proceed with explicit acknowledgement
- [ ] V2 tool export/import round-trips without `Expected TOOLS: section`
- [ ] Apply resolves imported entry-agent aliases consistently with preview
- [ ] V2 export remains best-effort and never emits legacy ABL under `.agent.yaml`
