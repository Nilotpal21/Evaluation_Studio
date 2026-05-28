# LLD: Working-Copy Identity, Webhook Sync, and Provisioning Hardening

**Status**: IMPLEMENTED
**Date**: 2026-05-03
**Scope**: Studio to DB to DSL to runtime execution parity

---

## 1. Design Decisions

| #   | Decision                                                                                                                         | Rationale                                                                                                                                                                                                                                                    | Alternatives Rejected                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| D-1 | Raw DSL saves fail closed when the declared `AGENT:` / `SUPERVISOR:` name differs from the persisted record name.                | A header-only rename currently splits DB identity, route lookup, source hashes, and runtime entry selection. A rename needs an explicit rename flow that updates `name`, `agentPath`, references, entry-agent metadata, and uniqueness constraints together. | Silently changing the DB name during raw save; allowing mismatch and relying on runtime fallbacks.           |
| D-2 | The declared-name check lives in `project-io` and uses the canonical parser.                                                     | Studio and Runtime both already depend on `project-io` for draft metadata, and parser-backed behavior avoids regex drift.                                                                                                                                    | Per-route regex checks.                                                                                      |
| D-3 | Webhook auto-sync must invoke the same canonical pull planning/apply path as manual git pull before reporting processed success. | A webhook that only records intent leaves DB/runtime state stale while telling operators auto-sync exists.                                                                                                                                                   | Keeping the TODO response; duplicating a webhook-specific importer.                                          |
| D-4 | Export provisioning requirements are content-derived and shared across export, preview, bundle, git push, and async export.      | The manifest should describe what the package requires to run, not whatever configs happen to exist in the source project.                                                                                                                                   | Counting existing connector/MCP rows as requirements; leaving auth/profile requirements out of the manifest. |

## 2. Target Contracts

### Agent Identity

Raw DSL save accepts only drafts whose declared document name matches the persisted agent record name. Mismatches return a structured conflict and do not write `dslContent`, hashes, diagnostics, or draft metadata.

### Git Webhook Auto-Sync

When a verified webhook targets the configured branch and `autoSync` is enabled, Studio performs the same import preview/apply sequence used by manual git pull and advances sync state only after apply succeeds.

### Provisioning Metadata

All export surfaces report:

- `requiredEnvVars`: `{{env.*}}` and `{{secrets.*}}` references from agents, tools, and behavior profiles.
- `requiredAuthProfiles`: `AUTH:` / `auth_profile` references from agents and tools, with `referencedBy` provenance.
- `requiredConnectors`: `CONNECTOR:` directives from tool DSL.
- `requiredMcpServers`: `MCP_SERVER:` directives from tool DSL.

## 3. File-Level Change Map

### New Files

| File                                                                                | Purpose                          |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| `docs/plans/2026-05-03-working-copy-identity-webhook-provisioning-hardening.lld.md` | This LLD and implementation log. |

### Modified Files

| File                                                                  | Change                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/project-io/src/project-agent-draft-metadata.ts`             | Add shared parser-backed declared-name validator.                   |
| `packages/project-io/src/export/provisioning-preview.ts`              | Replace config-row counting with content-derived provisioning scan. |
| `packages/project-io/src/export/env-var-scanner.ts`                   | Export connector/MCP scanners or equivalent shared helpers.         |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts` | Reject raw DSL header renames before save.                          |
| `apps/runtime/src/routes/project-agents.ts`                           | Reject raw DSL header renames before save.                          |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`           | Wire auto-sync to canonical pull apply path.                        |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`               | Use canonical provisioning helper.                                  |
| `apps/studio/src/app/api/projects/[id]/export/preview/route.ts`       | Use canonical provisioning helper.                                  |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`             | Use canonical provisioning helper.                                  |
| `apps/studio/src/app/api/projects/[id]/bundle/route.ts`               | Use canonical provisioning helper.                                  |
| `apps/studio/src/services/export-job-processor.ts`                    | Use canonical provisioning helper.                                  |
| `apps/runtime/src/routes/project-io.ts`                               | Use canonical provisioning helper and expose auth-profile preview.  |

## 4. Implementation Phases

### Phase 1: Raw DSL Identity Guard

**Goal**: Stop header-only renames from entering the DB.

**Tasks**:

1. Add a shared parser-backed validator in `project-io`.
2. Add Studio route regression for mismatched `AGENT:` header.
3. Add Runtime route regression for mismatched `AGENT:` header.
4. Wire both routes to return conflict without saving.

**Exit Criteria**:

- Studio route test proves `updateProjectAgent` is not called on mismatch.
- Runtime route test proves `updateProjectAgentDsl` is not called on mismatch.
- Existing matching-name saves keep passing.

### Phase 2: Canonical Provisioning Requirements

**Goal**: Make preview and manifest requirements describe DSL content truthfully.

**Tasks**:

1. Add project-io tests for auth-profile, connector, MCP, and profile env/secret extraction.
2. Extend the shared provisioning helper to return auth-profile requirements and content-derived connector/MCP names.
3. Wire Studio, Runtime, bundle, git push, and async export through the helper.

**Exit Criteria**:

- Project-io tests prove requirements come from DSL content.
- Studio/runtime export route tests prove auth/profile requirements reach preview and manifest inputs.

### Phase 3: Webhook Auto-Sync Apply

**Goal**: Make auto-sync webhooks mutate DB state through the same path as manual pull.

**Tasks**:

1. Add Studio webhook route test for `autoSync: true` invoking pull/apply and returning `processed: true`.
2. Reuse the canonical git pull planner/apply flow from the manual route.
3. Keep failure responses fail-closed and avoid advancing sync state when apply fails.

**Exit Criteria**:

- Webhook test proves the route no longer returns the pending TODO response on a valid auto-sync payload.
- Manual git pull tests remain green.

## 5. Verification Plan

Run build before tests per repo policy:

- `pnpm build --filter=@agent-platform/project-io`
- `pnpm build --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/studio exec tsc --noEmit`
- Focused project-io tests for draft metadata and provisioning.
- Focused runtime tests for project-agent DSL save.
- Focused Studio route tests for agent DSL save, export preview/routes, git push/bundle/async export, and webhook git routes.

## 6. Rollback

All changes are route/helper-level and can be reverted as one patch. No database migration is introduced. Existing projects with mismatched persisted name vs declared DSL name will become unable to save through raw DSL until they use or receive an explicit rename repair flow.

## 7. Acceptance Criteria

- [x] Raw DSL save mismatch is blocked in Studio and Runtime.
- [x] Runtime working-copy execution no longer receives newly saved mismatched identity drafts.
- [x] Export preview and manifests include content-derived auth, connector, MCP, and behavior-profile env/secret requirements.
- [x] Git webhook auto-sync applies changes through the canonical pull/import path.
- [x] Focused build and test gates pass after formatting, except Studio Next build/typecheck are blocked by pre-existing workspace state noted below.

## 8. Verification Results

- `pnpm build --filter=@agent-platform/project-io`: passed.
- `pnpm build --filter=@agent-platform/runtime`: passed.
- `pnpm build --filter=@agent-platform/studio`: blocked by an already-running `next build` lock owned by an active `pnpm --filter @agent-platform/studio build` process.
- `pnpm --filter @agent-platform/studio typecheck`: blocked by existing dirty-file error in `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/project-agent-draft-metadata.test.ts src/__tests__/layer-preview.test.ts`: passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-webhook-git-routes.test.ts src/__tests__/api-routes/api-export-preview-route.test.ts`: passed.
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/version-routes.test.ts --testNamePattern "PUT /:agentName/dsl"`: passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-project-agent-detail-routes.test.ts --testNamePattern "PUT /api/projects/:id/agents/:agentId/dsl"`: passed.
