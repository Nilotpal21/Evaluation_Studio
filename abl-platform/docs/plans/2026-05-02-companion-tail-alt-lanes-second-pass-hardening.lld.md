# LLD: Companion Tail Alternate-Lane Second-Pass Hardening

**Related Audit Context**: 2026-05-02 Studio -> DB -> DSL -> Runtime alternate-lane audit
**Related Plans**:

- `docs/plans/2026-05-02-companion-tail-parity-hardening.lld.md`
- `docs/plans/2026-05-02-working-copy-compile-parity-hardening.lld.md`
- `docs/plans/2026-05-02-agent-companion-versioning-packaging-hardening.lld.md`

**Status**: DONE
**Date**: 2026-05-02

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                             | Rationale                                                                                                                         | Alternatives Rejected                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D-1 | Treat agent `sourceHash` as companion-aware everywhere an agent draft, import plan, or export artifact is persisted. | Prompt-library refs still change compile/runtime behavior even when the DSL text is unchanged.                                    | Continuing to hash raw DSL in alternate lanes preserves stale identity and drift.   |
| D-2 | Keep route handlers thin and let repository/import planners own canonical hash computation.                          | Save routes should not fork identity logic from the shared draft/import seams.                                                    | Recomputing hashes independently in each route would recreate split-brain behavior. |
| D-3 | Use the same companion-complete state shape for Git pull diffing, import planning, async export, and bundle export.  | Alternate tooling lanes should not silently degrade fidelity relative to the hardened sync export/import paths.                   | Allowing each lane to project its own partial agent shape guarantees more drift.    |
| D-4 | Prefer project-io/export primitives over ad hoc bundle assembly.                                                     | The bundle surface should inherit the same manifest, lockfile, profile, locale, and companion rules as the canonical export path. | Maintaining a hand-rolled bundle path would keep it stale and lossy.                |
| D-5 | Audit after each iteration and roll findings forward into the next bounded slice.                                    | The remaining bugs are omission-driven and best found incrementally after each parity pass lands.                                 | One giant sweep without checkpoints risks mixing regressions with new findings.     |
| D-6 | Keep draft/database hashes and import/export `source_hash` values as separate but companion-aware hash domains.      | DB draft identity needs the full shared SHA contract, while lockfiles and validators must preserve the existing truncated format. | Reusing the draft hash helper for lockfiles silently changes the artifact contract. |

### Canonical Contract

The following must move together in all Studio/DB/DSL/runtime alternate lanes:

1. `ProjectAgent.dslContent`
2. `ProjectAgent.systemPromptLibraryRef`
3. Companion-aware `sourceHash`
4. Draft diagnostics / draft validation state
5. Exported manifest metadata
6. Import planner existing-state snapshots

---

## 2. File-Level Change Map

### New Files

| File                                                              | Purpose                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/project-repo-draft-metadata.test.ts`  | Lock runtime `updateProjectAgentDsl()` onto companion-aware draft recompute behavior |
| `apps/studio/src/__tests__/api-routes/api-git-pull-route.test.ts` | Lock Git pull preview state onto prompt-companion parity                             |
| `apps/studio/src/__tests__/services/export-job-processor.test.ts` | Lock async export worker onto companion-complete manifest and agent metadata         |
| `apps/studio/src/__tests__/api-routes/api-git-push-route.test.ts` | Lock Studio Git push onto canonical export-backed file generation                    |

### Modified Files

| File                                                                          | Change                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `docs/plans/2026-05-02-companion-tail-alt-lanes-second-pass-hardening.lld.md` | This plan                                                                        |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts`         | Stop overriding repo-owned companion-aware hash computation                      |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts`        | Stop overriding repo-owned companion-aware hash computation                      |
| `apps/runtime/src/repos/project-repo.ts`                                      | Preserve prompt companion in runtime DSL-save draft recompute                    |
| `packages/project-io/src/import/core-direct-apply.ts`                         | Compute companion-aware agent operation hashes                                   |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`                     | Include prompt companions in existing-state diff input                           |
| `apps/studio/src/services/export-job-processor.ts`                            | Preserve prompt companions in async export job data                              |
| `apps/studio/src/app/api/projects/[id]/bundle/route.ts`                       | Replace lossy bundle assembly with canonical export-backed bundle generation     |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`                     | Route Git push through canonical export output instead of legacy file maps       |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                       | Preserve prompt companions in sync export `agentData`                            |
| `packages/project-io/src/export/project-exporter.ts`                          | Carry prompt companions through export inputs and legacy lockfile metadata       |
| `packages/project-io/src/export/lockfile-generator.ts`                        | Keep lockfile agent hashes companion-aware without changing `source_hash` format |
| `packages/project-io/src/import/import-validator.ts`                          | Verify companion-aware agent hashes against the truncated lockfile contract      |
| `packages/project-io/src/git/git-sync-service.ts`                             | Accept canonical pre-exported project files for Git push                         |
| `packages/project-io/src/project-agent-draft-metadata.ts`                     | Split full draft identity hash from truncated artifact hash helper               |

### Test Locks

| File                                                                           | Lock                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-routes/api-project-agent-detail-routes.test.ts` | DSL save route no longer overrides companion-aware hash                 |
| `apps/studio/src/__tests__/api-routes/api-agent-edit-route.test.ts`            | Surgical edit route no longer overrides companion-aware hash            |
| `apps/runtime/src/__tests__/project-repo-draft-metadata.test.ts`               | Runtime DSL save keeps prompt companion during metadata recompute       |
| `packages/project-io/src/__tests__/core-direct-apply.test.ts`                  | Import planner hashes prompt-ref-only agent changes correctly           |
| `apps/studio/src/__tests__/api-routes/api-git-pull-route.test.ts`              | Git pull preview diff sees local prompt companions                      |
| `apps/studio/src/__tests__/services/export-job-processor.test.ts`              | Async export preserves prompt companions for large projects             |
| `apps/studio/src/__tests__/api-routes/api-bundle-route.test.ts`                | Bundle route exports canonical files instead of lossy agent list output |
| `apps/studio/src/__tests__/api-routes/api-git-push-route.test.ts`              | Git push emits canonical export-backed files and companion metadata     |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`                   | Git sync accepts canonical project files without regressing legacy push |
| `packages/project-io/src/__tests__/project-exporter.test.ts`                   | Export lockfiles change on prompt-ref-only edits                        |
| `packages/project-io/src/__tests__/import-validator-v2.test.ts`                | Import validation accepts companion-aware truncated agent hashes        |
| `packages/project-io/src/__tests__/export-utils.test.ts`                       | V1 lockfile agent hashes stay truncated while reflecting companions     |
| `packages/project-io/src/__tests__/lockfile-v2.test.ts`                        | V2 lockfile agent hashes stay truncated while reflecting companions     |

---

## 3. Implementation Iterations

### Iteration 1: Save And Import Identity Parity

**Goal**: Make save/import agent identity fully companion-aware.

**Tasks**:

1. Add failing locks for Studio DSL save route and surgical edit route.
2. Add a failing lock for runtime `updateProjectAgentDsl()`.
3. Add a failing lock for `buildCoreImportApplyPlanV2()` prompt-ref-only hash changes.
4. Remove raw `computeSourceHash(...)` overrides from Studio save routes and return persisted hash from repo results.
5. Preserve `systemPromptLibraryRef` in runtime DSL-save override projection.
6. Compute agent import operation hashes with the shared companion-aware hash helper.

**Exit Criteria**:

- [ ] Studio save routes do not pass raw `sourceHash` overrides into `updateProjectAgent()`
- [ ] Runtime DSL save preserves the edited agent’s current prompt companion during metadata recompute
- [ ] Prompt-ref-only import changes produce new agent operation hashes
- [ ] `pnpm --filter @agent-platform/project-io build` passes
- [ ] `pnpm --filter @agent-platform/runtime build` passes
- [ ] `pnpm --filter @agent-platform/studio exec tsc --noEmit` passes
- [ ] Focused Iteration 1 tests pass

**Rollback**: Restore route-local DSL-only hashing and runtime override shape.

---

### Iteration 2: Export, Git, And Bundle Alternate-Lane Parity

**Goal**: Make large-project export, Git pull, and bundle export use the canonical companion-complete contract.

**Tasks**:

1. Add failing locks for Git pull existing-state projection, async export worker metadata, and bundle export.
2. Include `systemPromptLibraryRef` in Git pull `existingState.agents`.
3. Include `systemPromptLibraryRef` in async export worker `agentData` and manifest agent metadata.
4. Replace bundle route’s lossy runtime-agent-list assembly with canonical export-backed file generation.
5. Keep locale behavior and streaming/zip response behavior intact.

**Exit Criteria**:

- [ ] Git pull preview state includes local prompt companions
- [ ] Async export preserves prompt companions in manifest/agent metadata for large projects
- [ ] Bundle export no longer depends on `GET /api/projects/:projectId/agents` returning DSL content
- [ ] Focused Iteration 2 tests pass
- [ ] Relevant builds/typechecks pass again after the slice

**Rollback**: Restore prior route/worker bundle wiring.

---

### Iteration 3: Git Push And Lockfile Contract Parity

**Goal**: Make Git push and lockfile verification follow the same companion-aware contract without changing artifact format.

**Tasks**:

1. Add failing locks for Studio Git push, export metadata propagation, and companion-aware import validation.
2. Route Studio Git push through `exportProjectV2(...)` and pass canonical files into `GitSyncService.push(...)`.
3. Preserve `systemPromptLibraryRef` in the sync export route so v1 export metadata and lockfiles stay companion-complete.
4. Split full draft `sourceHash` from truncated import/export `source_hash` and use the truncated helper in lockfile generation and validation.
5. Re-run scoped verification and perform one final audit.

**Exit Criteria**:

- [x] Canonical Git push no longer depends on the legacy relative-file builder
- [x] Export metadata and Git sync preserve prompt companions
- [x] Lockfile generation and import verification agree on companion-aware truncated agent hashes
- [x] Iteration 3 tests are green
- [ ] Final audit is complete and documented in the user-facing summary

**Rollback**: Revert the Iteration 3 slice commit only.

---

## 4. Wiring Checklist

- [ ] Studio save routes rely on repo-owned hash computation
- [ ] Runtime repo draft recompute path carries prompt companions through override projection
- [ ] Core direct-apply planner uses companion-aware agent hashes
- [ ] Git pull existing-state builder includes prompt companions
- [ ] Async export worker passes prompt companions to export/project-io
- [ ] Bundle route is wired to canonical export primitives instead of metadata-only agent list output
- [x] Git push passes canonical exported files into `GitSyncService`
- [x] Lockfile generator and import validator share the same companion-aware artifact hash semantics

---

## 5. Acceptance Criteria

- [x] Three iterations completed with tests-first locking
- [x] Each iteration ends with a scoped verification pass and a commit under `ABLP-791`
- [x] Each iteration is followed by a fresh end-to-end audit
- [ ] Final remaining issues, if any, are reported with concrete file/line references

## 6. Verification Summary

- [x] `pnpm --filter @agent-platform/project-io build`
- [x] `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-sync-service.test.ts src/__tests__/project-exporter.test.ts src/__tests__/import-validator-v2.test.ts src/__tests__/lockfile-v2.test.ts src/__tests__/export-utils.test.ts` (`182/182`)
- [x] `pnpm --filter @agent-platform/studio exec tsc --noEmit`
- [x] `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-pull-route.test.ts src/__tests__/services/export-job-processor.test.ts src/__tests__/api-routes/api-bundle-route.test.ts src/__tests__/api-routes/api-git-push-route.test.ts` (`5/5`)
- [ ] `pnpm --filter @agent-platform/studio build` remains blocked by another active `next build` process in the shared worktree
