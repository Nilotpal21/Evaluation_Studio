# LLD: Import Revert And Export Runtime Config Hardening

**Status**: IN PROGRESS  
**Date**: 2026-05-04

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                       | Rationale                                                                                                 | Alternatives Rejected                                                                       |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| D-1 | Make revert runtime-config validation snapshot-aware in the shared import seam | Revert correctness depends on the exact snapshot files, not the current DB state                          | Route-only ad hoc validation would duplicate snapshot loading logic and invite future drift |
| D-2 | Expand export readiness from agent-only to project-level readiness             | Export/gitsync package the full working copy, including runtime config                                    | Keeping agent-only checks defers runtime-config breakage to later import/runtime execution  |
| D-3 | Reuse the canonical runtime-config validator for export checks                 | Import, direct save, and export should share one source of truth for prompt/model/runtime-config validity | A separate export-only validator would drift from save/import semantics                     |

### Key Interfaces

```ts
interface ResolveRevertPlanOptionsContext {
  snapshotFiles: Record<string, string>;
  basePlanOptions: CoreImportPlanOptionsV2;
}

interface ProjectExportReadinessIssue {
  kind: 'agent_draft' | 'runtime_config';
  agentName?: string;
  diagnostics: ProjectAgentDraftDiagnostic[];
}
```

## 2. File-Level Change Map

### Modified Files

| File                                                                       | Change                                                             | Risk   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| `packages/project-io/src/import/core-direct-apply-orchestrator.ts`         | Add snapshot-aware revert plan-option resolution hook              | Medium |
| `packages/project-io/src/__tests__/core-direct-apply-orchestrator.test.ts` | Lock revert snapshot validator wiring                              | Low    |
| `apps/studio/src/app/api/projects/[id]/import/revert/route.ts`             | Wire runtime-config validation derived from snapshot files         | Medium |
| `apps/studio/src/__tests__/api-routes/api-import-revert-route.test.ts`     | Assert revert passes snapshot-aware runtime-config validation hook | Low    |
| `packages/project-io/src/project-agent-export-readiness.ts`                | Expand shared export readiness to include runtime-config validity  | Medium |
| `packages/project-io/src/__tests__/project-agent-export-readiness.test.ts` | Lock project-level readiness diagnostics and payload shape         | Low    |
| `apps/studio/src/lib/project-agent-export-readiness.ts`                    | Re-export the shared readiness helper into Studio                  | Low    |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                    | Load runtime config and gate export on project-level readiness     | Medium |
| `apps/studio/src/app/api/projects/[id]/bundle/route.ts`                    | Same project-level readiness gate for bundle export                | Medium |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`                  | Same project-level readiness gate for git sync/export              | Medium |
| `apps/studio/src/__tests__/api-routes/api-export-routes.test.ts`           | Lock export blocking on runtime-config readiness failures          | Low    |
| `apps/studio/src/__tests__/api-routes/api-bundle-route.test.ts`            | Lock bundle blocking on runtime-config readiness failures          | Low    |
| `apps/studio/src/__tests__/api-routes/api-git-push-route.test.ts`          | Lock git push blocking on runtime-config readiness failures        | Low    |

## 3. Implementation Phases

### Phase 1: Snapshot-Aware Revert Validation

**Goal**: Revert uses the same runtime-config validation contract as preview/apply, against the exact snapshot being restored.

**Tasks**:

1. Add an optional shared revert hook to derive `planOptions` from decompressed snapshot files.
2. Cover the hook in `core-direct-apply-orchestrator` tests.
3. Update Studio import revert to pass a snapshot-derived `validateRuntimeConfigForSave`.
4. Lock the route contract in API tests.

**Exit Criteria**:

- [ ] Revert orchestration can derive plan options from decompressed snapshot files before planning.
- [ ] Studio import revert passes snapshot-aware runtime-config validation into the shared revert seam.
- [ ] Targeted revert package and route tests pass.

**Test Strategy**:

- Unit: `packages/project-io/src/__tests__/core-direct-apply-orchestrator.test.ts`
- Route: `apps/studio/src/__tests__/api-routes/api-import-revert-route.test.ts`

**Rollback**: Remove the optional revert hook and route wiring, restoring the prior direct `planOptions` behavior.

### Phase 2: Project-Level Export Readiness

**Goal**: Export, bundle, and git-push fail closed when runtime config is invalid, not just when agent drafts are invalid.

**Tasks**:

1. Expand Studio export readiness helper to compute project-level issues from agents plus runtime config.
2. Reuse `validateProjectRuntimeConfigWrite` with sanitized DB runtime-config documents.
3. Update export, bundle, and git-push routes to load runtime config and gate on the new readiness helper.
4. Add route tests for each surface to lock blocking behavior.

**Exit Criteria**:

- [ ] Runtime-config validity is checked with the canonical shared validator during export readiness.
- [ ] Export, bundle, and git-push routes block on runtime-config readiness failures with the shared payload shape.
- [ ] Targeted readiness and route tests pass.

**Test Strategy**:

- Unit/helper: `packages/project-io/src/__tests__/project-agent-export-readiness.test.ts`
- Route: `apps/studio/src/__tests__/api-routes/api-export-routes.test.ts`
- Route: `apps/studio/src/__tests__/api-routes/api-bundle-route.test.ts`
- Route: `apps/studio/src/__tests__/api-routes/api-git-push-route.test.ts`

**Rollback**: Revert the helper and route gating changes to agent-only readiness.

## 4. Wiring Checklist

- [ ] Shared revert seam exposes the snapshot-aware plan-option hook to all callers
- [ ] Studio import revert route uses the hook
- [ ] Export route loads runtime config and uses project-level readiness
- [ ] Bundle route loads runtime config and uses project-level readiness
- [ ] Git push route loads runtime config and uses project-level readiness
- [ ] Tests cover both the shared seam and the route entry points

## 5. Acceptance Criteria

- [ ] Revert no longer bypasses canonical runtime-config validation
- [ ] Export, bundle, and git push no longer package invalid runtime config as healthy
- [ ] `npx prettier --write` has been run on all touched files
- [ ] Build-first targeted verification passes before the affected tests run

## 6. Open Questions

1. If more revert callers are added later, should snapshot-derived validation become mandatory rather than optional?
2. Should project export readiness later absorb additional non-agent surfaces beyond runtime config, such as other execution-critical project documents?
