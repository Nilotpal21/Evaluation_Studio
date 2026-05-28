# LLD: Agent Companion Versioning / Packaging Hardening

**Feature Spec**: N/A (audit-driven hardening)
**HLD**: N/A (surgical parity follow-on)
**Test Spec**: N/A (slice-locked by focused Runtime / Studio / project-io regressions)
**Related Plans**:

- `docs/plans/2026-05-02-working-copy-compile-parity-hardening.lld.md`
- `docs/plans/2026-05-02-action-handler-end-to-end-hardening.lld.md`

**Status**: DONE
**Date**: 2026-05-02

---

## 1. Problem Statement

We confirmed four more end-to-end gaps where agent behavior depends on non-DSL companion inputs, but some lanes still reason from raw DSL-only snapshots:

1. Agent version dedup still ignores `ProjectAgent.systemPromptLibraryRef`, so a prompt-library-only change can reuse an older version hash.
2. Module release publish still validates agents in isolation, so valid intra-module `HANDOFF` / `DELEGATE` graphs can fail publish.
3. Packaged module runtime still trusts publish-time `compiledIR` too much, even though consumer-side config overrides are only known at deployment build time.
4. Project export/import still round-trips only DSL-centric agent fields, so prompt-library refs can be silently stripped even when DSL text is preserved.

The common failure mode is that `dslContent` is treated as the whole authored identity even when runtime behavior also depends on companion metadata stored outside the DSL.

---

## 2. Design Decisions

| #   | Decision                                                                                                         | Rationale                                                                                                                                        | Alternatives Rejected                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Define one explicit **agent companion metadata** contract for non-DSL agent inputs.                              | Prompt-library refs are persisted outside the DSL and need a stable shape anywhere we hash, export, package, or recompile agents.                | Re-teaching each caller about `systemPromptLibraryRef` independently would recreate omission drift.                             |
| D-2 | Version source hashes must include prompt-library companion identity and resolved content hash.                  | A prompt-ref-only edit changes runtime behavior and must force a new version or break dedup.                                                     | Hashing raw DSL only keeps split-brain dedup behavior alive.                                                                    |
| D-3 | Module publish must compile the **whole module graph once**, then package per-agent IR from that batch compile.  | Cross-agent validation depends on seeing sibling agents together; isolated per-agent compiles are structurally incapable of proving that.        | Keeping per-agent compile and patching validation messages afterward would still reject valid module graphs.                    |
| D-4 | Module deployment should prefer **recompiling from artifact sources + consumer config overrides** when possible. | Consumer-side config overrides are deployment-time inputs. Reusing publish-time `compiledIR` directly can freeze the wrong config-resolved view. | Baking source-project config values into portable releases would make overrides ineffective and couple releases to source envs. |
| D-5 | Module artifacts must preserve prompt-library companion snapshots needed for deploy-time recompilation.          | Prompt-library refs are source-project-scoped; deployment builds cannot rely on live access to the source project prompt library.                | Requiring runtime to look up source-project prompt versions at deploy time would be brittle and non-portable.                   |
| D-6 | Export/import manifests should carry companion metadata alongside agent identity metadata.                       | Prompt-library refs must survive authoring round-trips just like description, owner, and version metadata do.                                    | Sidecar-only files would work, but would add more moving parts than needed for one small portable agent contract.               |
| D-7 | Keep legacy module releases readable.                                                                            | Existing releases without companion metadata or deploy-time recompile inputs must still mount via the current `compiledIR` fallback path.        | Hard-cutting old releases would create avoidable production breakage.                                                           |

---

## 3. Canonical Companion Contract

The canonical non-DSL agent companion contract for this hardening slice is:

```ts
interface AgentPromptLibraryRefSnapshot {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
}

interface AgentCompanionMetadata {
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
  resolvedSystemPrompt?: string | null;
}
```

Rules:

1. `systemPromptLibraryRef` is the authored reference identity.
2. `resolvedHash` is the publish/version-time content fingerprint of the referenced prompt version.
3. `resolvedSystemPrompt` is the publish-time prompt template snapshot used when a portable artifact must recompile later without source-project prompt-library access.
4. Empty companion payloads normalize to `null` / omission so hashes remain deterministic.

---

## 4. Module Boundaries

| Module                                                           | Responsibility                                                                                | Depends On                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/services/version-service.ts`                   | Version creation, dedup hashing, prompt-ref-aware version identity                            | prompt-library resolution helper, agent version repo               |
| `packages/project-io/src/agent-companion-metadata.ts`            | Canonical normalize/serialize helpers for agent companion metadata                            | shared prompt-ref shape only                                       |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts` | Module-wide publish-time compile context assembly, prompt snapshot capture, release packaging | project agents, config vars, prompt-library resolution, compiler   |
| `packages/project-io/src/module-release/build-module-release.ts` | Release artifact builder that packages per-agent DSL, companion metadata, and compiled IR     | source-hash helper, tool materialization                           |
| `packages/project-io/src/module-release/source-hash.ts`          | Deterministic module source hash including companion metadata                                 | stable JSON hashing                                                |
| `apps/runtime/src/services/modules/deployment-build-service.ts`  | Deployment-time recompilation from module artifact sources with consumer config overrides     | compiler, parser, artifact tool definitions, module alias rewriter |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`          | Export route passes prompt companion metadata into v2 project manifests                       | project agent queries, project-io exporter                         |
| `packages/project-io/src/export/manifest-generator.ts`           | Manifest serialization of agent companion metadata                                            | project-io types                                                   |
| `packages/project-io/src/import/*`                               | Import diff/apply path preserves and writes prompt companion metadata                         | manifest parsing, apply operations, Studio adapter                 |

---

## 5. File-Level Change Map

### New Files

| File                                                                          | Purpose                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `docs/plans/2026-05-02-agent-companion-versioning-packaging-hardening.lld.md` | Durable plan for versioning / module packaging / export hardening |
| `packages/project-io/src/agent-companion-metadata.ts`                         | Shared normalize/hash helpers for prompt companion metadata       |

### Modified Files

| File                                                                           | Change                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/version-service.ts`                                 | Include prompt-library companion state in version source hashes                                |
| `apps/runtime/src/__tests__/version-service-ir-purity.test.ts`                 | Lock prompt-ref-only version hash changes and dedup behavior                                   |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`               | Build one module-wide compile context, capture prompt companion snapshots, pass precompiled IR |
| `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts`               | Lock module-wide compile wiring and prompt companion packaging                                 |
| `packages/project-io/src/module-release/build-module-release.ts`               | Package companion metadata and optionally consume precompiled IR                               |
| `packages/project-io/src/module-release/source-hash.ts`                        | Include companion metadata in deterministic release hashing                                    |
| `packages/project-io/src/__tests__/module-release-builder.test.ts`             | Lock companion metadata packaging and source-hash sensitivity                                  |
| `packages/database/src/models/module-release.model.ts`                         | Extend release artifact typing for agent companion metadata                                    |
| `apps/runtime/src/services/modules/deployment-build-service.ts`                | Prefer deploy-time recompilation from artifact sources; fall back to legacy compiled IR        |
| `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts` | Lock deploy-time recompilation using companion snapshots and config overrides                  |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                        | Select and forward prompt companion metadata during export                                     |
| `packages/project-io/src/types.ts`                                             | Extend manifest agent typing with companion metadata                                           |
| `packages/project-io/src/export/manifest-generator.ts`                         | Serialize manifest agent companion metadata                                                    |
| `packages/project-io/src/import/import-applier.ts`                             | Treat companion metadata changes as agent updates                                              |
| `packages/project-io/src/import/core-direct-apply.ts`                          | Carry companion metadata through import plan/apply                                             |
| `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`        | Lock export/import prompt companion round-trip                                                 |

---

## 6. Implementation Phases

### Phase 1: Version Hash Parity

**Goal**: Make prompt-library companion changes break version dedup.

**Tasks**:

1. Add red tests proving prompt-library-only changes must change `sourceHash`.
2. Include normalized prompt companion metadata in version hash input.
3. Keep tool/config hash inputs intact.

**Exit Criteria**:

- [x] `createVersion()` no longer deduplicates when only the prompt-library ref or resolved hash changes.
- [x] Existing tool/config hash behavior remains green.
- [x] `pnpm build --filter=@agent-platform/runtime` passes before Runtime tests.
- [x] Targeted Runtime version-service tests pass.

**Test Strategy**:

- Runtime unit/integration: `apps/runtime/src/__tests__/version-service-ir-purity.test.ts`

**Rollback**:

- Revert prompt-companion hash input changes only; no schema migration involved.

---

### Phase 2: Module Publish Companion Packaging

**Goal**: Publish module releases from one module-wide compile and persist prompt companion snapshots in the artifact.

**Tasks**:

1. Add red tests locking module-wide compile behavior and prompt companion packaging.
2. Load module agents with `systemPromptLibraryRef`.
3. Resolve prompt refs and capture `resolvedSystemPrompt` / `resolvedHash` snapshots.
4. Compile all module agents + standalone behavior profiles together.
5. Pass precompiled IR and companion metadata into `buildModuleRelease`.
6. Include companion metadata in module release source hashes.

**Exit Criteria**:

- [x] Valid intra-module handoff/delegate graphs are compiled from one batch context.
- [x] Module release artifacts persist prompt companion metadata per agent.
- [x] Module source hashes change when prompt companion snapshots change.
- [x] `pnpm build --filter=@agent-platform/project-io --filter=@agent-platform/studio` passes before targeted tests.
- [x] Targeted Studio + project-io module-release tests pass.

**Test Strategy**:

- Studio route: `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts`
- project-io unit: `packages/project-io/src/__tests__/module-release-builder.test.ts`

**Rollback**:

- Restore isolated publish-time compile path and remove artifact companion metadata.

---

### Phase 3: Module Deployment Recompile Parity

**Goal**: Make module deployment builds honor consumer config overrides while preserving prompt-library-backed system prompts.

**Tasks**:

1. Add red deployment-build tests for artifact-source recompilation with config overrides.
2. Parse artifact agent DSL + profile DSL during deployment build when artifact inputs are sufficient.
3. Rehydrate prompt companion snapshots onto parsed docs without reaching back to the source project prompt library.
4. Build `resolvedToolImplementations` from artifact tool definitions.
5. Recompile with merged consumer config overrides.
6. Keep legacy `compiledIR` fallback for older releases.

**Exit Criteria**:

- [x] Deployment builds prefer artifact-source recompilation when companion/tool inputs exist.
- [x] Consumer config overrides affect mounted agent IR without losing prompt-library-backed system prompts.
- [x] Legacy releases without companion metadata still mount via fallback.
- [x] `pnpm build --filter=@agent-platform/runtime` passes before deployment-build tests.
- [x] Targeted Runtime deployment-build tests pass.

**Test Strategy**:

- Runtime unit/integration: `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`

**Rollback**:

- Revert to the legacy `compiledIR`-only mount path while keeping artifact schema backward-compatible.

---

### Phase 4: Export / Import Round-Trip Parity

**Goal**: Preserve prompt companion metadata across Studio export/import.

**Tasks**:

1. Add red round-trip tests for exporting and re-importing `systemPromptLibraryRef`.
2. Extend manifest agent metadata to carry companion data.
3. Include prompt companion metadata in export route agent queries and manifest generation.
4. Extend import diff/apply planning so prompt companion changes produce agent updates even when DSL is unchanged.
5. Persist imported companion metadata through the Studio project-agent write adapter.

**Exit Criteria**:

- [x] Exported manifests contain prompt companion metadata for agents that use prompt-library refs.
- [x] Import preview/apply preserves prompt companion metadata.
- [x] Prompt-ref-only import updates are not treated as no-ops.
- [x] `pnpm build --filter=@agent-platform/project-io --filter=@agent-platform/studio` passes before targeted tests.
- [x] Targeted Studio/project-io round-trip tests pass.

**Test Strategy**:

- Studio route round-trip: `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`
- project-io import/export unit coverage as needed for diff/apply helpers

**Rollback**:

- Revert manifest companion fields and import/apply propagation while leaving unrelated export/import behavior unchanged.

---

## 7. Wiring Checklist

- [x] Version hashing reads prompt companion metadata after prompt resolution, not before.
- [x] Module publish route passes module-wide precompiled IR into the release builder.
- [x] Module release artifacts carry prompt companion metadata in a typed field.
- [x] Deployment build consumes artifact companion metadata before falling back to legacy compiled IR.
- [x] Export route selects `systemPromptLibraryRef` from `ProjectAgent`.
- [x] Manifest generation serializes companion metadata for each exported agent.
- [x] Import diff/apply paths detect and persist prompt companion changes even when DSL text is identical.

---

## 8. Acceptance Criteria

- [x] Prompt-library-only agent edits no longer deduplicate to stale agent versions.
- [x] Module publish no longer rejects valid intra-module routing graphs because of isolated compile context.
- [x] Packaged module deployment honors consumer config overrides without losing prompt-library-backed system prompts.
- [x] Studio export/import round-trips preserve prompt-library refs.
- [x] Targeted Runtime / Studio / project-io builds and regression tests are green.

---

## 9. Future-Ready Guardrails

- Any new non-DSL agent input must be added to the companion metadata contract first, then wired through versioning, packaging, and export/import surfaces from there.
- Portable artifacts should prefer storing enough source + companion data to recompile later, instead of assuming publish-time compiled IR is always the final runtime truth.
- Module deployment code should only use publish-time compiled IR as a compatibility fallback for older artifacts, not as the canonical path for newly published releases.
- Export/import round-trips must treat agent metadata changes as real authored changes even when `dslContent` is unchanged.

---

## 10. Verification

The implementation was locked slice by slice with build-first verification and focused regressions:

1. Phase 1: version hash parity
   - `pnpm build --filter=@agent-platform/runtime`
   - Targeted Runtime versioning tests passed for prompt-library-ref-aware dedup behavior.
2. Phase 2: module publish companion packaging
   - `pnpm build --filter=@agent-platform/project-io --filter=@agent-platform/studio`
   - Targeted Studio + project-io module release tests passed for module-wide compile context, packaged companion metadata, and source-hash sensitivity.
3. Phase 3: module deployment recompile parity
   - `pnpm build --filter=@agent-platform/runtime`
   - `pnpm --filter @agent-platform/runtime exec vitest run src/services/modules/__tests__/deployment-build-service.test.ts`
   - Result: `20/20` passing.
4. Phase 4: export/import round-trip parity
   - `pnpm build --filter=@agent-platform/project-io --filter=@agent-platform/studio`
   - `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/manifest-v2.test.ts src/__tests__/import-validators.test.ts`
   - Result: `98/98` passing.
   - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-project-io-roundtrip.test.ts`
   - Result: `1/1` passing.

Notes:

- The Studio build completed successfully during this slice, with the same existing Turbopack warnings around `apps/studio/src/app/api/abl/docs/route.ts`.
- No schema migration or branch-level rollout work was required for this hardening set.
