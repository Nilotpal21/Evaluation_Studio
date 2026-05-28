# LLD: Action Handler End-to-End Hardening

**Feature Spec**: N/A (audit-driven hardening)
**HLD**: N/A (surgical parity hardening)
**Test Spec**: N/A (slice-locked by targeted regressions in touched packages)
**Related Plan**: `docs/plans/2026-05-02-action-handler-canonical-hardening.lld.md`
**Status**: DONE (implemented 2026-05-02; focused slice locks green; broader build verification blocked by unrelated current-worktree failures)
**Date**: 2026-05-02

---

## 1. Problem Statement

The canonical action-handler runtime surface is now `do[]`, but the broader authoring and tooling path still had multiple end-to-end drift points:

- Studio flow saves rewrote `FLOW:` through a lossy visual serializer and could delete `ACTIONS`, `ON_ACTION`, `GATHER`, and other unsupported step metadata.
- `ACTION_HANDLERS:` was not recognized as a top-level splice boundary, so replacing `FLOW:` could swallow trailing agent-level handlers.
- The section-edit API accepted `FULL` edits from Studio, but the diff layer treated them like unknown sections and appended content instead of replacing the document.
- YAML export/import was stale against the modern contract: serializer emitted deprecated `mode`, did not emit canonical action-handler surfaces, and omitted step-level reasoning metadata.
- Dependency extraction and Studio topology views missed `HANDOFF` / `DELEGATE` edges authored inside step-level or agent-level action handlers.
- Runtime tests still locked mostly legacy top-level handler mirrors instead of canonical agent-level `do[]`.

This is the same “split-brain across authoring, serialization, and execution” class as the compiler issue we already fixed. The remaining hardening work needs one explicit contract across Studio, project-io, YAML, topology analysis, and runtime coverage.

---

## 2. Design Decisions

| #   | Decision                                                                                            | Rationale                                                                                                                                          | Alternatives Rejected                                                                     |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D-1 | Studio visual editors fail closed on lossy flow shapes.                                             | Preventing silent DSL deletion is more important than partial editability. Unsupported shapes remain viewable and editable through the DSL editor. | Continuing to allow best-effort FLOW saves would keep data-loss risk live.                |
| D-2 | `FULL` is an explicit whole-document edit contract, not an unknown section name.                    | Studio already emits `FULL`; the diff layer must honor it directly so definition saves are deterministic.                                          | Special-casing only the route would leave other project-io callers with the same footgun. |
| D-3 | `ACTION_HANDLERS` is a first-class top-level section everywhere sections are discovered or ordered. | Prevents collateral deletion during FLOW edits and keeps diff/replace semantics aligned with the DSL.                                              | Treating it as a FLOW sub-block would keep section-boundary bugs alive.                   |
| D-4 | YAML canonicalizes around per-step `reasoning` and handler `do[]`, with no top-level `mode`.        | The YAML path must match the runtime/compiler contract instead of reintroducing deprecated surfaces.                                               | Emitting both `mode` and canonical surfaces would preserve split-brain behavior.          |
| D-5 | Routing-edge analysis must include action-handler `HANDOFF` / `DELEGATE` calls.                     | Export manifests and Studio topology should reflect actual execution topology, not just top-level coordination blocks.                             | Limiting topology to top-level sections undercounts real runtime edges.                   |
| D-6 | Each seam is locked test-first, slice-by-slice.                                                     | The failure mode is omission drift; targeted regressions are the fastest way to keep future work honest.                                           | One broad end-to-end test would not localize which layer regressed.                       |

---

## 3. Module Boundaries

| Module                                           | Responsibility                                                                                       | Depends On                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio` visual editor compatibility        | Detect lossy flow shapes, surface warnings, block unsafe saves, preserve DSL fallback path           | compiled IR, editor save adapter, section-edit API |
| `packages/project-io` diff + dependency analysis | Preserve section boundaries, honor full-document replacements, extract routing edges from source DSL | raw DSL text, optional parser-derived semantics    |
| `packages/core` YAML parser                      | Parse modern flow/action-handler YAML into the same AST contract as ABL                              | AST types                                          |
| `packages/language-service` YAML serializer      | Emit canonical YAML that round-trips through the parser and matches current IR semantics             | modern IR shape                                    |
| `apps/studio` topology ops                       | Surface routing graph edges from parsed action handlers                                              | parsed AST, project agent loader                   |
| `apps/runtime` tests                             | Lock canonical agent-level handler behavior end-to-end                                               | runtime executor, compiled agents                  |

---

## 4. File-Level Change Map

### New Files

| File                                                               | Purpose                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `docs/plans/2026-05-02-action-handler-end-to-end-hardening.lld.md` | Durable slice plan for Studio → YAML → topology → runtime hardening |
| `apps/studio/src/lib/abl/flow-visual-editor-compat.ts`             | Flow visual-editor compatibility analysis and save-block rules      |
| `apps/studio/src/__tests__/flow-visual-editor-compat.test.ts`      | Red/green lock for unsupported FLOW metadata detection              |
| `apps/studio/src/__tests__/arch-ai/topology-ops.test.ts`           | Locks Studio topology extraction for action-handler edges           |

### Modified Files

| File                                                                 | Change                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/project-io/src/diff/section-splicer.ts`                    | Add `ACTION_HANDLERS` boundary support and explicit `FULL` replacement semantics                                            |
| `packages/project-io/src/__tests__/section-splicer.test.ts`          | Lock `ACTION_HANDLERS` boundaries and `FULL` replacement                                                                    |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`            | Wire flow compatibility analysis into banners, read-only mode, and save blocking                                            |
| `apps/studio/src/components/agent-editor/AgentEditorBanners.tsx`     | Show flow compatibility warnings alongside gather warnings                                                                  |
| `apps/studio/src/__tests__/components/agent-editor-banners.test.tsx` | Lock flow compatibility banners                                                                                             |
| `packages/core/src/parser/yaml-parser.ts`                            | Parse step reasoning fields plus step/agent action handlers in YAML flow documents                                          |
| `packages/core/src/__tests__/yaml-flow-parser.test.ts`               | Lock modern YAML flow/action-handler parsing                                                                                |
| `packages/language-service/src/serialize-yaml.ts`                    | Emit canonical YAML for reasoning steps, step `actions`, `on_action`, and top-level `action_handlers`; stop emitting `mode` |
| `packages/language-service/src/__tests__/serialize-yaml.test.ts`     | Lock canonical YAML serialization and no-`mode` output                                                                      |
| `packages/project-io/src/dependencies/dependency-extractor.ts`       | Extract action-handler handoff/delegate edges                                                                               |
| `packages/project-io/src/__tests__/dependency-extractor.test.ts`     | Lock dependency extraction for action-handler edges                                                                         |
| `apps/studio/src/lib/arch-ai/tools/topology-ops.ts`                  | Include action-handler edges in topology reads                                                                              |
| `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`             | Lock canonical agent-level `do[]` fallback behavior                                                                         |
| `apps/runtime/src/__tests__/action-handlers-integration.test.ts`     | Lock canonical agent-level `do[]` dispatch behavior                                                                         |

---

## 5. Implementation Phases

### Phase 1: Studio Save Hardening

**Goal**: Make Studio fail closed instead of destructively rewriting FLOW definitions.

**Tasks**:

1. Add red tests for `ACTION_HANDLERS` section boundaries and `FULL` replacements in `project-io`.
2. Add flow visual-compatibility analysis mirroring the gather safety pattern.
3. Surface flow compatibility warnings in Studio and make the Flow editor read-only when a save would be lossy.
4. Block visual FLOW saves when unsupported metadata exists, while still allowing full DSL saves.

**Exit Criteria**:

- [x] `ACTION_HANDLERS` is identified as its own splice boundary.
- [x] `FULL` edits replace the document instead of appending.
- [x] Unsupported FLOW metadata produces Studio warnings and blocks flow-only saves.
- [x] Targeted Studio + project-io tests pass.

**Test Strategy**:

- Unit: `section-splicer`, `flow-visual-editor-compat`, `AgentEditorBanners`
- Integration: Studio save-path guard through `AgentEditor` logic

**Rollback**:

- Revert the flow compatibility gating and `FULL` semantics; no persisted data migration is involved.

### Phase 2: YAML Contract Modernization

**Goal**: Make YAML export/import match the canonical runtime/compiler contract.

**Tasks**:

1. Add red parser tests for step reasoning plus step/agent action-handler YAML shapes.
2. Add red serializer tests for no-`mode` output and canonical action-handler emission.
3. Parse `reasoning`, `goal`, `available_tools`, `exit_when`, `max_turns`, `actions`, and `on_action` in YAML flow steps.
4. Serialize top-level `action_handlers`, step `actions`, step `on_action`, and step reasoning fields.
5. Remove deprecated `mode` emission from YAML serialization.

**Exit Criteria**:

- [x] Serializer no longer emits top-level `mode`.
- [x] Canonical flow/action-handler YAML round-trips through parser + serializer for the supported surfaces.
- [x] Targeted core + language-service tests pass.

**Test Strategy**:

- Unit: `yaml-flow-parser`, `serialize-yaml`
- Integration: serializer output parses cleanly via `parseYamlABL`

**Rollback**:

- Revert serializer/parser canonical additions together so the YAML contract stays internally consistent.

### Phase 3: Routing Edge Extraction

**Goal**: Make export manifests and topology views see action-handler routing edges.

**Tasks**:

1. Add red dependency-extractor tests for `ACTION_HANDLERS` and step-level `ON_ACTION DO` routing edges.
2. Add red topology-ops tests for parser-derived action-handler edges.
3. Extend dependency extraction to detect handler `HANDOFF` / `DELEGATE` targets without regressing existing top-level scans.
4. Extend Studio topology reads to include both top-level and action-handler edges.

**Exit Criteria**:

- [x] Dependency extraction reports handler `handoff` / `delegate` edges.
- [x] Studio topology reads include handler routing edges.
- [x] Targeted project-io + Studio topology tests pass.

**Test Strategy**:

- Unit: `dependency-extractor`, `topology-ops`

**Rollback**:

- Revert the extractor changes only; authored DSL remains unchanged.

### Phase 4: Canonical Runtime Coverage

**Goal**: Lock the runtime around agent-level canonical handler `do[]`.

**Tasks**:

1. Convert agent-level runtime tests from legacy mirror fields to canonical `do[]`.
2. Keep step-level regression cases unchanged as controls.
3. Confirm agent-level fallback and precedence behavior still hold with canonical handlers.

**Exit Criteria**:

- [x] Runtime integration/E2E tests assert canonical `do[]` behavior.
- [x] No runtime implementation change is needed unless tests prove otherwise.

**Test Strategy**:

- Integration: `action-handlers-integration.test.ts`
- E2E-style runtime executor: `action-handlers.e2e.test.ts`

**Rollback**:

- Revert test-only canonical locks if they expose an unrelated runtime regression that needs separate triage.

---

## 6. Wiring Checklist

- [x] Studio editor save path calls the new flow compatibility guard before serializing FLOW edits.
- [x] `AgentEditorBanners` receives flow compatibility warnings in both page and slide-over modes.
- [x] `section-splicer` recognizes `ACTION_HANDLERS` during section discovery and replacement.
- [x] YAML serializer output remains parseable by `parseYamlABL`.
- [x] Dependency extractor and Studio topology both account for handler routing edges.
- [x] Runtime tests exercise the canonical agent-level handler surface.

---

## 7. Acceptance Criteria

- [x] Studio no longer silently drops unsupported FLOW metadata on save.
- [x] Full-definition saves perform whole-document replacement.
- [x] `ACTION_HANDLERS` is preserved across FLOW replacements.
- [x] YAML export/import supports canonical step reasoning and action-handler surfaces without emitting deprecated `mode`.
- [x] Dependency extraction and Studio topology include action-handler routing edges.
- [x] Runtime tests lock canonical agent-level `do[]` behavior.
- [x] Focused test lanes for touched packages pass.
- [ ] Broader touched-package build verification is fully clean in the current worktree.

---

## 8. Future-Ready Guardrails

- New visual-editor surfaces must ship with an explicit compatibility analyzer before they are allowed to rewrite raw DSL sections.
- New section-edit meta-operations must be explicit contracts (`FULL`, future bulk edits), not overloaded unknown section names.
- Any future action-handler surface added to ABL must be wired in four places together:
  - parser / AST
  - serializer / authoring
  - topology / dependency extraction
  - runtime regression coverage
- YAML must only emit fields that the YAML parser accepts as canonical steady-state contract.

---

## 9. Verification Notes

### Focused Green Lanes

- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/section-splicer.test.ts src/__tests__/dependency-extractor.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/flow-visual-editor-compat.test.ts src/__tests__/components/agent-editor-banners.test.tsx src/__tests__/arch-ai/topology-ops.test.ts`
- `pnpm --filter @abl/core exec vitest run src/__tests__/yaml-flow-parser.test.ts`
- `pnpm --filter @abl/language-service exec vitest run src/__tests__/serialize-yaml.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts src/__tests__/action-handlers-integration.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/action-handlers.e2e.test.ts`

### Broader Build Blockers Outside This Slice

- Root filtered `pnpm build --filter=@abl/core --filter=@abl/language-service --filter=@agent-platform/project-io --filter=@agent-platform/studio --filter=@agent-platform/runtime` is currently blocked by unrelated existing worktree errors:
  - `packages/shared/src/tools/resolve-tool-implementations.ts` references mismatched symbols during downstream `@abl/eventstore` build.
  - `packages/shared/src/index.ts` has duplicate `ProjectToolType` exports during a focused turbo build.
  - `apps/runtime` has unrelated type errors in `guardrails/pipeline-factory.ts` and `llm/model-resolution.ts`.
  - `apps/studio` currently fails production build on unrelated `packages/project-io/dist` resolution and existing Turbopack tracing warnings.
