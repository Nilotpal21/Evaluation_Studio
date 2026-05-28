# Prompt Library Runtime and Project-IO Hardening

## Goal

Close the remaining prompt-library gaps across runtime draft validation, prompt lifecycle safety, project export/import portability, and Studio structured agent edits so prompt-linked agents stay correct from authoring through execution.

## Design Principles

- Treat prompt-library state as a first-class compile dependency, not passive companion metadata.
- Keep draft readiness aligned with the same prompt/profile context that real working-copy compilation uses.
- Export/import prompt artifacts as portable project assets, not implicit external dependencies.
- Preserve prompt companion metadata losslessly across Studio, DB, and project-io surfaces.
- Fail closed when a prompt lifecycle action would strand working-copy agents on missing or archived refs.

## Slice Plan

1. Runtime draft metadata parity
   - Lock with `apps/runtime/src/__tests__/sessions/project-agent-draft-metadata.test.ts`.
   - Mirror runtime working-copy compile context inside `evaluateRuntimeProjectAgentDrafts()`:
     resolve prompt-library refs on parsed documents, materialize config-backed behavior profiles, and feed both prompt-resolution errors and profile parse errors into draft diagnostics.
   - Exit: runtime-owned draft writes mark prompt/profile-invalid agents as `error` instead of `valid`.

2. Prompt-library lifecycle safety and readiness invalidation
   - Lock with `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts` and `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`.
   - Add working-copy draft reference discovery for `ProjectAgent.systemPromptLibraryRef`, block archive/delete/promote transitions that would archive or remove a referenced version, and refresh persisted runtime draft metadata after prompt-library mutations.
   - Exit: prompt lifecycle APIs cannot silently strand working-copy agents, and persisted readiness updates immediately after prompt changes.

3. Portable prompt artifact export/import
   - Lock with `packages/project-io/src/__tests__/project-exporter.test.ts`, `packages/project-io/src/__tests__/project-importer-v2.test.ts`, `packages/project-io/src/__tests__/core-direct-apply-orchestrator.test.ts`, and `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`.
   - Introduce a first-class `prompts` layer with canonical prompt bundle files, assembler/disassembler support, direct-apply preview/apply support, and runtime/Studio export+import wiring.
   - Preserve prompt and version ids in exported artifacts so imported agents retain valid `systemPromptLibraryRef` pointers without ad hoc remapping.
   - Exit: a project export containing prompt-linked agents round-trips into a fresh project with prompt artifacts present and refs still resolvable.

4. Studio prompt companion metadata preservation
   - Lock with `apps/studio/src/__tests__/api-routes/api-project-agent-detail-routes.test.ts`.
   - Widen the Studio agent PATCH contract and prompt-picker plumbing to preserve optional prompt companion fields such as `resolvedHash`, while remaining forward-compatible with future prompt metadata.
   - Exit: structured agent edits no longer erase imported prompt companion metadata.

## Verification

- Run `npx prettier --write` on all changed files.
- Run targeted builds before targeted tests per repo policy.
- Verify focused runtime, project-io, and Studio suites for each locked slice.
- Record any broader repo-level build/typecheck blockers separately if they are pre-existing and outside this workstream.
