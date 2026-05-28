# LLD: Import, Git Sync, and Preview Truthfulness Hardening

**Related Audit Context**: 2026-05-03 Studio -> DB -> DSL -> Runtime execution import/git/export-preview audit
**Related Plans**:

- `docs/plans/2026-05-03-export-surface-canonical-parity-hardening.lld.md`
- `docs/plans/2026-05-02-companion-tail-parity-hardening.lld.md`
  **Status**: DONE
  **Date**: 2026-05-03

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                           | Rationale                                                                                                   | Alternatives Rejected                                                                               |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| D-1 | Keep the current direct-apply import lane, but make it explicitly layer-aware and fail closed.     | The main bug is silent partial behavior. We can fix that now without pretending unsupported layers apply.   | Continuing to accept canonical layered imports while silently dropping non-core layers is not safe. |
| D-2 | Add optional import layer selection to the shared contract now, even before full staged cutover.   | This keeps the route/API shape future-ready and lets callers intentionally scope imports to supported data. | Hard-coding all callers to auto-detect forever would force another contract change later.           |
| D-3 | Treat git pull as an orchestration of the canonical import preview/apply seam, not a custom path.  | Manual import and git pull must compute the same preview, blocking issues, and write behavior.              | Keeping a separate legacy git-pull importer guarantees drift and false “synced” states.             |
| D-4 | Preview provisioning must match the export manifest contract, including auth-profile dependencies. | Export preview should tell users what export will require before they download or sync anything.            | Showing only env/connectors/MCP data leaves connection/auth setup as another hidden failure mode.   |
| D-5 | Git change summaries should describe every changed importable surface, not only agents/locales.    | Sync history is an operator surface; it must reflect tools, profiles, MCP, model-policy, and eval changes.  | Keeping agent-only summaries makes successful pulls look smaller and safer than they really were.   |
| D-6 | Re-audit the earlier agent-model-config export concern before changing that seam.                  | The current schema is already tenant-scoped, so this specific finding did not reproduce in the live tree.   | Shipping speculative export changes would add noise and risk without fixing a confirmed bug.        |

### Direct-Apply Import Contract

The main Studio/runtime import routes will continue to use the direct-apply seam for this slice, but only under these rules:

1. The request may include `layers?: LayerName[]`.
2. If `layers` is omitted, the importer auto-detects layers from the uploaded files.
3. The direct-apply seam only activates `core` and `evals` in this slice.
4. If any other layer remains in scope after layer selection, preview must surface a blocking issue and apply must not mutate data.
5. A caller may intentionally import only `core` (or `core + evals`) from a larger layered export by passing `layers`.

### Git Pull Contract

`POST /api/projects/:id/git/pull` must behave as:

1. Pull remote files once.
2. Build the same import preview contract used by manual import.
3. If `dryRun=true`, return the preview only.
4. If `dryRun=false`, apply the pulled files through the same direct-apply seam before updating sync history/integration metadata.
5. Only mark the sync successful after the apply succeeds.

### Preview Provisioning Contract

Runtime and Studio export preview responses must include:

- `requiredEnvVars`
- `requiredConnectors`
- `requiredMcpServers`
- `requiredAuthProfiles`

Those fields must describe the same provisioning contract the export manifest carries.

---

## 2. File-Level Change Map

### Modified Files

| File                                                                    | Change Description                                                                            | Risk   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| `docs/plans/2026-05-03-import-git-sync-truthfulness-hardening.lld.md`   | This implementation plan                                                                      | Low    |
| `packages/project-io/src/import/core-direct-apply.ts`                   | Add layer selection, unsupported-layer blocking, and filtered direct-apply operation planning | High   |
| `packages/project-io/src/import/core-direct-apply-orchestrator.ts`      | Thread layer selection through preview/apply orchestration                                    | Medium |
| `packages/project-io/src/git/git-sync-service.ts`                       | Add pulled-file transport seam for canonical Studio git-pull orchestration                    | High   |
| `packages/project-io/src/export/project-exporter.ts`                    | Populate manifest/export preview provisioning with auth-profile requirements                  | Medium |
| `packages/project-io/src/export/index.ts`                               | Re-export any new provisioning helpers if needed                                              | Low    |
| `packages/project-io/src/__tests__/core-direct-apply.test.ts`           | Lock unsupported-layer blocking and layer selection behavior                                  | High   |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`            | Lock canonical git-pull previewing and richer change summaries                                | High   |
| `apps/runtime/src/routes/project-io.ts`                                 | Accept import `layers`, expose preview provisioning metadata, and thread layer selection      | High   |
| `apps/runtime/src/__tests__/project-io-routes.test.ts`                  | Lock runtime import/export preview route behavior                                             | High   |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`         | Accept import `layers` and use the shared fail-closed direct-import contract                  | Medium |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`           | Accept import `layers` and use the shared fail-closed direct-import contract                  | Medium |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`               | Apply pulled files before recording success and expand existing-state coverage                | High   |
| `apps/studio/src/app/api/projects/[id]/export/preview/route.ts`         | Return provisioning preview fields alongside layer metadata                                   | Medium |
| `apps/studio/src/api/project-io.ts`                                     | Extend import/export/git client contracts                                                     | Medium |
| `apps/studio/src/components/projects/ExportDialog.tsx`                  | Render provisioning requirements in the export preview UI                                     | Medium |
| `apps/studio/src/__tests__/api-routes/api-export-preview-route.test.ts` | Lock Studio export preview provisioning metadata                                              | Medium |
| `apps/studio/src/__tests__/api-routes/api-git-pull-route.test.ts`       | Lock git pull apply-before-success and richer existing-state/change behavior                  | High   |
| `apps/studio/src/__tests__/components/export-dialog.test.tsx`           | Lock provisioning UI rendering                                                                | Medium |
| `packages/i18n/locales/en/studio.json`                                  | Add export preview provisioning labels                                                        | Low    |

---

## 3. Implementation Phases

### Phase 1: Truthful Direct Import Contract

**Goal**: Make the shared direct-import lane layer-aware and fail closed instead of silently partial.

**Tasks**:

1. Add failing `project-io` tests for unsupported non-direct layers and explicit `layers` selection
2. Extend the shared direct-import plan options with optional `layers`
3. Filter planned operations by selected supported layers (`core`, `evals`)
4. Add a blocking preview issue when unsupported layers remain in scope
5. Thread `layers` through runtime and Studio import preview/apply request parsing

**Exit Criteria**:

- [ ] Direct-import preview/apply accepts optional layer selection
- [ ] Non-supported layers produce a blocking issue instead of silent partial apply
- [ ] Runtime and Studio import routes thread the same layer contract to the shared seam
- [ ] Focused `project-io` + runtime route tests pass

**Rollback**: Remove `layers` request handling and restore the previous auto-detect direct-import behavior.

---

### Phase 2: Export Preview Provisioning Parity

**Goal**: Make export preview surfaces describe the same provisioning contract as canonical export.

**Tasks**:

1. Add failing route/UI tests for provisioning fields in runtime + Studio preview
2. Populate export manifest/preview auth-profile requirements from connection export metadata
3. Return required env vars, connectors, MCP servers, and auth profiles from runtime preview
4. Mirror those fields in Studio preview and client types
5. Render provisioning requirements in the Studio export dialog

**Exit Criteria**:

- [ ] Runtime export preview includes the full provisioning contract
- [ ] Studio export preview mirrors the same provisioning fields
- [ ] Export dialog renders the provisioning summary without breaking layer selection
- [ ] Focused Studio/runtime tests pass

**Rollback**: Remove provisioning fields from preview responses/UI and restore the earlier metadata-only preview.

---

### Phase 3: Canonical Git Pull Apply & Summary Parity

**Goal**: Make git pull use the same canonical preview/apply contract as manual import and only report success after persistence.

**Tasks**:

1. Add failing `GitSyncService` tests for canonical previewing and non-agent change summaries
2. Add a transport-only `pullProjectFiles()` seam and move Studio git pull onto the shared direct-import plan builder
3. Return pulled files plus a richer change summary to the Studio route
4. Expand Studio git pull existing-state loading to include model-policy / eval / MCP surfaces covered by direct apply
5. On non-dry-run pull, apply the pulled files through the shared direct-import seam before recording success
6. Record truthful change summaries and only advance `lastSyncCommit` after apply success

**Exit Criteria**:

- [ ] Studio git pull no longer relies on the legacy importer path and reuses pulled-file transport + canonical direct-import planning/apply
- [ ] Studio non-dry-run pull writes remote changes before sync success is recorded
- [ ] Sync history summaries include non-agent importable surfaces
- [ ] Focused `project-io` + Studio git-pull tests pass

**Rollback**: Restore preview-only git pull behavior and the earlier legacy summary contract.

---

## 4. Wiring Checklist

- [ ] Runtime import preview/apply routes pass `layers` through to the shared import seam
- [ ] Studio import preview/apply routes pass `layers` through to the shared import seam
- [ ] Runtime export preview response schema matches the new provisioning payload
- [ ] Studio export preview route and client types match runtime provisioning fields
- [ ] Studio export dialog renders provisioning data from the updated client contract
- [ ] Studio git pull route reuses the shared direct-import apply seam before persisting sync metadata
- [ ] Git pull history/status surfaces continue to consume the updated summary contract safely

---

## 5. Acceptance Criteria

- [ ] Direct import is truthful: unsupported layers are blocked instead of silently ignored
- [ ] Import callers can intentionally scope to supported layers with a stable request contract
- [ ] Git pull success means the DB/runtime-facing state was actually updated
- [ ] Git pull summaries include the non-agent surfaces touched by the import
- [ ] Export preview shows the same provisioning requirements users will see in export artifacts
- [ ] Tests are added before each code slice and affected packages are built before focused tests

## 6. Verification Plan

- `pnpm build --filter=@agent-platform/project-io`
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/core-direct-apply.test.ts src/__tests__/git-sync-service.test.ts`
- `pnpm build --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/project-io-routes.test.ts`
- `pnpm --filter @agent-platform/studio exec tsc --noEmit`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-export-preview-route.test.ts src/__tests__/api-routes/api-git-pull-route.test.ts src/__tests__/components/export-dialog.test.tsx`
