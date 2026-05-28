# LLD: Companion Tail Parity Hardening

**Related Audit Context**: 2026-05-02 Studio -> DB -> DSL -> Runtime execution tail audit
**Related Plans**:

- `docs/plans/2026-05-02-working-copy-compile-parity-hardening.lld.md`
- `docs/plans/2026-05-02-agent-companion-versioning-packaging-hardening.lld.md`
- `docs/plans/2026-05-02-project-agent-draft-metadata-hardening-impl-plan.md`
  **Status**: DONE
  **Date**: 2026-05-02

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                      | Rationale                                                                                                                   | Alternatives Rejected                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D-1 | Treat agent companion metadata as part of agent identity everywhere, not just versioning and deployment.      | Prompt-library refs live outside the DSL but still change compile/runtime behavior, export manifests, and hash identity.    | Continuing to hash and export only raw DSL preserves silent drift in non-DSL lanes.    |
| D-2 | Fail closed on YAML canonicalization when project-aware context is unavailable.                               | A `.agent.yaml` file containing non-canonical source DSL is a misleading artifact that creates downstream drift.            | Preserving the current suffix/content mismatch would keep Git and public export stale. |
| D-3 | Treat prompt companion metadata as part of draft identity and propagate it through every draft-state builder. | Prompt-library refs live outside the DSL but still affect saved identity, stale detection, and refresh correctness.         | Recomputing hashes from raw DSL alone keeps prompt-ref-only edits invisible.           |
| D-4 | Keep runtime public import/export aligned with the same companion contract already used by Studio export.     | Public project I/O is another production API surface and cannot lag behind Studio on prompt companion fidelity.             | Treating runtime public project-io as a lower-fidelity legacy path is not acceptable.  |
| D-5 | Harden the v2 core YAML export path project-wide, not per-agent.                                              | Canonical YAML must be derived from the project compilation set so sibling routing and config-backed documents are visible. | Isolated single-agent YAML materialization produces false canonical output.            |

### Canonical Companion Contract

The following inputs are compile-affecting companion inputs and must be preserved or considered together:

1. Agent DSL content from `ProjectAgent.dslContent`
2. Agent prompt companion metadata from `ProjectAgent.systemPromptLibraryRef`
3. Config-backed behavior profile DSL from `ProjectConfigVariable` keys prefixed with `profile:`
4. Project config variables used by compile-time substitution
5. Resolved prompt library version content used to materialize `systemPrompt`

### Module Boundaries

| Module                                                              | Responsibility                                                            | Depends On                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/runtime/src/routes/project-io.ts`                             | Public import/export parity for companion metadata                        | runtime models, `@agent-platform/project-io`, runtime draft helpers |
| `packages/project-io/src/export/*`                                  | Truthful legacy export behavior and project-aware v2 YAML materialization | compiler, manifest generator, prompt companion metadata             |
| `packages/project-io/src/project-agent-draft-metadata.ts`           | Shared draft metadata hashing with companion-aware source identity        | compiler, companion hash helpers                                    |
| `apps/studio/src/lib/abl/project-agent-draft-metadata.ts`           | Studio-side draft-state builders that preserve prompt companion metadata  | project-io evaluator                                                |
| `apps/runtime/src/services/session/project-agent-draft-metadata.ts` | Runtime-side draft-state builders that preserve prompt companion metadata | runtime tool resolution, project-io evaluator                       |
| `apps/studio/src/lib/arch-ai/tools/*`                               | Diagnostic tools using project-aware compile context                      | Studio project-aware compile helper                                 |

---

## 2. File-Level Change Map

### New Files

| File                                                                   | Purpose                                                              | LOC Estimate |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| `apps/studio/src/__tests__/arch-ai/validate-agent.test.ts`             | Lock `validate_agent` onto project-aware diagnostic compile parity   | 120          |
| `apps/studio/src/__tests__/arch-ai/diagnose-project.test.ts`           | Lock `diagnose_project` onto project-aware diagnostic compile parity | 120          |
| `apps/studio/src/lib/arch-ai/tools/project-aware-diagnostic-report.ts` | Shared mapping/merge helpers for project-aware diagnostic findings   | 90           |

### Modified Files

| File                                                                | Change Description                                                                      | Risk   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| `docs/plans/2026-05-02-companion-tail-parity-hardening.lld.md`      | This implementation plan                                                                | Low    |
| `apps/runtime/src/routes/project-io.ts`                             | Preserve `systemPromptLibraryRef` through export preview/apply/export                   | High   |
| `packages/project-io/src/export/project-exporter.ts`                | Include companion metadata and emit truthful source-vs-YAML export artifacts            | Medium |
| `packages/project-io/src/git/git-sync-service.ts`                   | Stop assuming canonical YAML is available without compile context                       | Medium |
| `packages/project-io/src/export/agent-export-materializer.ts`       | Add project-aware YAML materialization path for v2 core exports                         | High   |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts` | Materialize requested YAML from the full project compilation set and include companions | High   |
| `packages/project-io/src/project-agent-draft-metadata.ts`           | Hash companion metadata and accept prepared documents/errors/warnings                   | High   |
| `apps/studio/src/lib/abl/project-agent-draft-metadata.ts`           | Build prepared draft documents with prompt refs, profiles, and tool context             | High   |
| `apps/runtime/src/services/session/project-agent-draft-metadata.ts` | Build runtime prepared draft documents with prompt refs, profiles, and tool context     | High   |
| `apps/studio/src/lib/arch-ai/tools/validate-agent.ts`               | Compile diagnostics through the project-aware context seam and surface context findings | Medium |
| `apps/studio/src/lib/arch-ai/tools/diagnose-project.ts`             | Compile diagnostics through the project-aware context seam and surface context findings | Medium |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts`                 | Run semantic checks through the same project-aware context seam                         | Medium |

### Test Files

| File                                                                       | Lock Added                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/project-io-routes.test.ts`                     | Runtime public import/export round-trips `systemPromptLibraryRef`                                  |
| `packages/project-io/src/__tests__/project-exporter.test.ts`               | Legacy export manifests keep companion metadata                                                    |
| `packages/project-io/src/__tests__/export-yaml.test.ts`                    | YAML export preserves truthful file extensions when canonicalization is unavailable                |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`               | Git sync stops emitting misleading `.agent.yaml` output without a compiler context                 |
| `packages/project-io/src/__tests__/agent-export-materializer.test.ts`      | Project-aware YAML materialization uses sibling/profile/prompt context                             |
| `packages/project-io/src/__tests__/core-assembler.test.ts`                 | v2 core assembler exports canonical YAML from the full project context and keeps prompt companions |
| `packages/project-io/src/__tests__/project-agent-draft-metadata.test.ts`   | Draft metadata source hashes change when prompt companions change                                  |
| `apps/studio/src/__tests__/project-repo-draft-metadata.test.ts`            | Studio draft refresh remains wired for companion-only updates                                      |
| `apps/studio/src/__tests__/project-agent-draft-metadata.test.ts`           | Studio draft-state helpers preserve prompt companion metadata                                      |
| `apps/runtime/src/__tests__/sessions/project-agent-draft-metadata.test.ts` | Runtime draft-state helpers preserve prompt companion metadata and hash identity                   |
| `apps/studio/src/__tests__/arch-ai/validate-agent.test.ts`                 | `validate_agent` reuses project-aware compile context                                              |
| `apps/studio/src/__tests__/arch-ai/diagnose-project.test.ts`               | `diagnose_project` reuses project-aware compile context                                            |
| `apps/studio/src/__tests__/arch-ai/health-check.test.ts`                   | Semantic health-check uses the same project-aware compile context                                  |

---

## 3. Implementation Phases

### Phase 1: Runtime Public Project I/O Companion Parity

**Goal**: Preserve `systemPromptLibraryRef` across runtime public export/import and direct-apply state loading.

**Tasks**:

1. Add runtime route locks for exported manifest companions and imported persistence
2. Include `systemPromptLibraryRef` in runtime route export queries and `ProjectData`
3. Include `systemPromptLibraryRef` in the direct-apply current-state snapshot
4. Persist `systemPromptLibraryRef` in create/update agent operations
5. Thread imported companion refs into runtime draft metadata evaluation

**Exit Criteria**:

- [x] Runtime public export includes `manifest.agents[*].systemPromptLibraryRef`
- [x] Runtime public import persists `ProjectAgent.systemPromptLibraryRef`
- [x] Runtime direct-apply preview compares existing/imported prompt companions
- [x] `apps/runtime/src/__tests__/project-io-routes.test.ts` passes

**Rollback**: Revert runtime route companion fields and restore DSL-only behavior.

---

### Phase 2: Export And Git YAML Hardening

**Goal**: Make export artifacts truthful and make v2 YAML materialization use full project context.

**Tasks**:

1. Add exporter/Git/materializer/core-assembler failing locks
2. Extend legacy `ProjectData.agents` to carry `systemPromptLibraryRef`
3. Preserve companion metadata in legacy manifest output
4. Change legacy YAML export fallback to truthful source format instead of mislabeled `.agent.yaml`
5. Update Git sync expectations to use truthful export output
6. Add a project-aware YAML materialization path for v2 core export:
   - compile all agents together
   - append behavior profiles
   - resolve prompt-library refs before compile
7. Include companion metadata in v2 core agent selection where required by the materializer

**Exit Criteria**:

- [x] Legacy export manifests preserve prompt-library refs
- [x] Legacy export no longer emits `.agent.yaml` files with raw non-YAML source
- [x] Git sync uses truthful exported file paths/content
- [x] v2 core YAML export compiles from the full project document set
- [x] `packages/project-io` exporter/materializer/core-assembler tests pass

**Rollback**: Restore legacy exporter fallback behavior and isolated per-agent materialization.

---

### Phase 3: Draft Metadata Companion-Aware Identity

**Goal**: Make persisted draft metadata and `sourceHash` sensitive to prompt companions across Studio/runtime draft-state builders and persistence lanes.

**Tasks**:

1. Add shared evaluator locks for companion-aware source hashing
2. Extend `ProjectAgentDraftState` to carry prompt companion metadata
3. Extend shared evaluator to hash DSL plus normalized companion payload
4. Thread companion metadata through Studio/runtime draft-state builders and import helpers
5. Recompute persisted source hashes for companion-only mutations in Studio repo updates
6. Keep persisted refresh flows wired for companion-only mutations

**Exit Criteria**:

- [x] Prompt-ref-only edits change `sourceHash`
- [x] Studio/runtime draft-state builders preserve prompt companion metadata
- [x] Companion-only mutations recompute persisted source hashes
- [x] Shared, Studio, and Runtime draft metadata tests pass

**Rollback**: Revert to DSL-only hashing and caller-local parsing.

---

### Phase 4: Studio Arch Diagnostic Compile Parity

**Goal**: Make Arch diagnostic tools compile through the same project-aware context contract used by Studio compile surfaces.

**Tasks**:

1. Add failing tests for `validate_agent`, `diagnose_project`, and semantic `health-check`
2. Create a reusable full-project diagnostic compile helper from the Studio project-aware compile seam
3. Switch `validate_agent` to use the project-aware helper and preserve parse error reporting
4. Switch `diagnose_project` to use the same helper
5. Switch semantic `health-check` compilation to the same helper
6. Keep degraded-warning behavior explicit when project-aware context cannot be built

**Exit Criteria**:

- [x] `validate_agent` and `diagnose_project` use project-aware compile context
- [x] Semantic `health-check` uses the same context contract
- [x] Arch diagnostic tests pass with prompt/profile-aware compilation locks

**Rollback**: Restore raw `compileABLtoIR(parsedDocs)` usage in the three tools.

---

## 4. Wiring Checklist

- [x] Runtime public project-io route exports and imports companion metadata
- [x] Legacy exporter manifest includes companion metadata
- [x] Git sync uses the hardened export behavior
- [x] v2 core assembler YAML export calls the new project-aware materializer
- [x] Shared draft metadata evaluator hashes companion-aware agent identity
- [x] Studio and Runtime draft metadata wrappers pass companion metadata through draft-state builders
- [x] `validate-agent`, `diagnose-project`, and `health-check` all use the project-aware diagnostic compile seam

---

## 5. Acceptance Criteria

- [x] All four slices are implemented with tests written first
- [x] Focused `project-io` and Runtime builds pass before focused tests
- [x] Studio typecheck passes before focused tests; full `next build` remains blocked by an unrelated concurrent build lock in the shared worktree
- [x] No remaining known path drops `systemPromptLibraryRef` across the audited lanes covered by this plan
- [x] YAML export surfaces are truthful about whether canonical materialization actually happened
- [x] Draft metadata and Arch diagnostics use the same companion-aware project context family as runtime-facing compile paths
