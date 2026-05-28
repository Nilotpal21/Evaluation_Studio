# LLD: Studio/DB/DSL/Runtime Gap Closure

**Status**: IN PROGRESS
**Date**: 2026-05-03

## 1. Scope

This plan closes the remaining end-to-end gaps where Studio authoring, import/export, persisted draft metadata, runtime configuration, and runtime execution still disagree about what is valid or what requires recompilation.

Already covered in the current tree:

- Import/runtime draft metadata refresh for agent writes
- Cross-agent draft metadata recompute for Studio agent mutations
- Config-variable invalidation for persisted draft metadata
- Runtime/studio prompt-library draft refresh for agent prompt refs
- Autosave requeue on failed section edits

Remaining implementation scope:

1. Runtime-config validation must become a single contract across direct save and import.
2. Runtime-config prompt refs must be treated as first-class prompt dependencies.
3. Working-copy compilation hash must include runtime-config state and runtime-config-owned prompt refs.
4. Studio identity editing must stop stripping prompt companion metadata on round-trip.

## 2. Design Decisions

| #   | Decision                                                                     | Rationale                                                                                                        |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D-1 | Introduce one shared runtime-config write validator in `packages/project-io` | Runtime save, Studio import, runtime import, webhook sync, and git pull must stop drifting.                      |
| D-2 | Make import-time runtime-config validation snapshot-aware                    | Imports must validate against the final imported prompt set, not only the destination DB’s pre-import state.     |
| D-3 | Reject archived prompt versions consistently for runtime-config prompt refs  | Agent prompt refs already fail closed on archived versions; runtime-config prompt refs must match that contract. |
| D-4 | Treat `ProjectRuntimeConfig` as a working-copy compilation dependency        | Runtime behavior already depends on it, so cache invalidation and compilation hash must too.                     |
| D-5 | Treat runtime-config prompt refs as prompt-library references                | Prompt archive/delete/promote guards must protect all execution surfaces, not only agent system prompts.         |
| D-6 | Prefer server-returned prompt companion metadata in Studio UI                | The server is the source of truth for companion fields such as `resolvedHash` and future metadata.               |

## 3. File-Level Change Map

### New Files

| File                                                               | Purpose                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/project-io/src/import/runtime-config-save-validation.ts` | Shared runtime-config validation and imported-prompt snapshot helpers |

### Modified Files

| File                                                                          | Change                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/project-io/src/import/index.ts`                                     | Export shared runtime-config validation utilities                                  |
| `apps/runtime/src/services/config/project-runtime-config-write-validation.ts` | Thin runtime wrapper around shared validator                                       |
| `apps/studio/src/lib/project-runtime-config-import-validation.ts`             | Thin Studio wrapper + snapshot-aware validator factory                             |
| `apps/runtime/src/routes/project-runtime-config.ts`                           | Use shared fail-closed runtime-config validation                                   |
| `apps/runtime/src/routes/project-io.ts`                                       | Wire snapshot-aware runtime-config validation into import preview/apply            |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`               | Wire snapshot-aware runtime-config validation into Studio preview                  |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`                 | Wire snapshot-aware runtime-config validation into Studio apply                    |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`                     | Use snapshot-aware runtime-config validation for git pull import                   |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`                   | Use snapshot-aware runtime-config validation for webhook import                    |
| `apps/runtime/src/channels/session-resolver.ts`                               | Add runtime-config and runtime-config prompt refs to working-copy compilation hash |
| `apps/runtime/src/services/prompt-library/prompt-library-service.ts`          | Include runtime-config prompt refs in lifecycle guards and reference reporting     |
| `apps/runtime/src/services/prompt-library/runtime-prompt-overrides.ts`        | Fail closed on archived runtime-config prompt refs                                 |
| `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx`         | Preserve server-returned prompt companion metadata                                 |

### Test Files

| File                                                                                | Coverage                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/project-io/src/__tests__/runtime-config-save-validation.test.ts`          | Shared validator behavior, imported prompt snapshot acceptance, archived prompt rejection |
| `apps/runtime/src/__tests__/project-runtime-config-route.test.ts`                   | Direct runtime-config route validation parity                                             |
| `apps/runtime/src/__tests__/project-io-routes.test.ts`                              | Runtime import preview/apply wiring for runtime-config validation                         |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`                 | Working-copy hash invalidation for runtime config and prompt refs                         |
| `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`               | Runtime-config prompt references surfaced in prompt-library references                    |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts` | Archive/delete/promote guards block on runtime-config prompt refs                         |
| `apps/studio/src/__tests__/project-runtime-config-import-validation.test.ts`        | Studio snapshot-aware validation and portable tenant model normalization                  |
| `apps/studio/src/__tests__/api-routes/api-webhook-git-routes.test.ts`               | Webhook path keeps runtime-config validator wired                                         |
| `apps/studio/src/__tests__/api-routes/api-git-pull-route.test.ts`                   | Git pull path keeps runtime-config validator wired                                        |
| `apps/studio/src/__tests__/api-routes/api-project-agent-detail-routes.test.ts`      | Identity editor/server prompt companion metadata round-trip                               |

## 4. Implementation Slices

### Slice 1: Shared Runtime-Config Validation

**Goal**: direct save and import use one runtime-config validity contract.

**Tasks**:

1. Add shared validator + imported prompt snapshot helper in `packages/project-io`.
2. Make runtime route and Studio import wrappers call the shared validator.
3. Reject archived prompt versions in the shared validator.
4. Preserve portable tenant-model import normalization in the shared path.

**Exit Criteria**:

- [ ] Shared validator accepts imported prompt bundles without requiring preexisting DB rows.
- [ ] Shared validator rejects archived runtime-config prompt refs.
- [ ] Runtime route and runtime/studio import paths all use the same validator contract.

### Slice 2: Import Parity Wiring

**Goal**: every import entrypoint validates runtime config against imported prompt bundles.

**Tasks**:

1. Build snapshot-aware validator closures from uploaded file maps.
2. Wire closures into runtime import preview/apply.
3. Wire closures into Studio import preview/apply, git pull, and webhook sync.

**Exit Criteria**:

- [ ] Runtime and Studio import preview/apply both pass `validateRuntimeConfigForSave`.
- [ ] Git-based import paths also use the snapshot-aware validator.
- [ ] Self-contained imports with prompt bundles validate successfully.

### Slice 3: Runtime Prompt Dependency Hardening

**Goal**: runtime-config prompt refs participate in cache invalidation and lifecycle safety.

**Tasks**:

1. Add runtime-config state to working-copy compilation hash inputs.
2. Union runtime-config prompt refs into prompt-version hash inputs.
3. Extend prompt-library reference scans and lifecycle guards to include runtime config.
4. Fail closed in runtime prompt override resolution for archived refs.

**Exit Criteria**:

- [ ] Runtime-config changes force working-copy refresh.
- [ ] Runtime-config prompt version changes force working-copy refresh.
- [ ] Prompt archive/delete/promote is blocked when runtime config still references the prompt.

### Slice 4: Studio Prompt Companion Metadata

**Goal**: Studio editing no longer strips prompt companion metadata.

**Tasks**:

1. Update identity editor types to permit passthrough prompt companion metadata.
2. Prefer the server PATCH response over reconstructing local prompt refs from picker data.
3. Add regression coverage for preserving `resolvedHash`.

**Exit Criteria**:

- [ ] Re-saving an agent’s prompt selection preserves `resolvedHash`.
- [ ] Client-side state mirrors server-returned prompt companion metadata after PATCH.

## 5. Verification

- `pnpm build --filter @agent-platform/project-io`
- `pnpm build --filter @agent-platform/runtime`
- `pnpm --filter @agent-platform/project-io test:fast ...`
- `pnpm --filter @agent-platform/runtime test:fast ...`
- `pnpm --filter @agent-platform/studio test:fast ...`
- `npx prettier --write <changed files>`

## 6. Risks

- Import validation now depends on prompt bundle parsing, so malformed prompt bundle files must still fail with actionable validation output instead of generic runtime-config errors.
- Working-copy hash expansion must avoid pulling volatile metadata fields that would cause needless session refresh churn.
