# Implementation Log: ABLP-976 Git Integration Lifecycle Gap Closure

**Plan**: `docs/plans/2026-05-11-ablp-976-git-integration-lifecycle-gap-closure.lld.md`
**Started**: 2026-05-11

## Preflight

- Working tree was already dirty with the ABLP-976 target-contract tests and one modified `git-sync-service.test.ts` from the test-locking pass.
- Proceeding slice-by-slice on the current branch as requested; no branch switch or branch creation performed.
- Phase 1 target files exist:
  - `packages/database/src/models/git-sync-history.model.ts`
  - `packages/database/src/models/git-integration.model.ts`
  - `apps/studio/src/lib/git-credentials.ts`

## Phase 1: Data Model And Credential Contract

**Status**: Complete

### Changes

- Added `tenantId` to `GitSyncHistory` interface and schema.
- Replaced Git sync history indexes with tenant-aware route indexes.
- Replaced Git integration project-only unique index with `{ tenantId, projectId }`.
- Extended `resolveGitCredentials()` with optional project/user context while keeping existing callers compatible.
- Scoped auth profile lookup to project and tenant profiles when project context is supplied.
- Added Git-compatible auth profile type validation and sanitized auth profile resolver errors.

### Verification

- `npx prettier --write packages/database/src/models/git-sync-history.model.ts packages/database/src/models/git-integration.model.ts apps/studio/src/lib/git-credentials.ts docs/sdlc-logs/ablp-976-git-integration-lifecycle-gap-closure/implementation.log.md` passed.
- `pnpm build` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts` passed: 6/6.
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts` passed: 6/6.

### Notes

- Tightened the project-only unique-index test assertion because the earlier `objectContaining({ projectId: 1 })` assertion also matched the correct `{ tenantId: 1, projectId: 1 }` index.

## Phase 2: Git Setup UI And CRUD Boundary

**Status**: Complete

### Changes

- Updated the setup UI to send backend credential vocabulary (`token` instead of `pat`) and persist selected auth profiles as top-level `authProfileId`.
- Included only token-compatible auth profile types in the Git picker; `ssh_key` is intentionally excluded until Git providers support SSH end to end.
- Added `PROJECT_GIT` permission enforcement to Git integration GET/POST/PATCH/DELETE.
- Normalized setup/PATCH credentials, conflict strategies, repository URLs, and sync paths at the route boundary.
- Validated provider credentials before persistence and cleaned up partially created integrations if project pointer updates fail.
- Added sanitized integration serialization for GET/POST/PATCH responses, including legacy read normalization and webhook secret removal.
- Unregistered provider webhooks before disconnect deletion and preserved the integration when provider cleanup fails.
- Updated the Studio project-io API client types to match the backend Git integration contract.

### Verification

- `npx prettier --write apps/studio/src/app/api/projects/[id]/git/route.ts apps/studio/src/components/settings/GitIntegrationTab.tsx apps/studio/src/api/project-io.ts apps/studio/src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts` passed.
- `pnpm build` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts` passed: 62/62.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx` passed: 8/8.

### Notes

- The initial Phase 2 route run exposed raw persisted response shape on GET. Added a shared serializer rather than letting each handler redact independently.

## Phase 3: Lifecycle Route Parity

**Status**: Complete

### Changes

- Added deterministic Git history query validation for `direction`, `status`, `branch`, limit bounds, and `{ createdAt: -1, _id: -1 }` sorting.
- Recorded failed push and pull history with sanitized error text, including credential-resolution failures before remote writes.
- Preserved successful push/pull outcomes when post-state audit logging or runtime cache invalidation fails.
- Classified protected-branch push failures as conflict responses.
- Avoided advancing `lastSyncCommit` when a push creates a pull request instead of updating the default branch directly.
- Enforced ordered promotion transitions before credential resolution.

### Verification

- `npx prettier --write apps/studio/src/app/api/projects/[id]/git/history/route.ts apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts apps/studio/src/app/api/projects/[id]/git/promote/route.ts apps/studio/src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts` passed: 26/26.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-history-scenarios.test.ts` passed: 8/8.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts` passed: 1/1.
- `pnpm build` passed.

### Notes

- Operation coordination is still tracked in the plan as a follow-up within the lifecycle family; no existing focused lock covers it yet.

## Phase 4: Webhook Provider Semantics And Idempotency

**Status**: Complete

### Changes

- Updated provider webhook parsing for Bitbucket `sha256=` signatures, Bitbucket branch selection, GitHub/GitLab tag pushes, and branch delete events.
- Made the webhook route trust provider `payload.isRelevant` instead of recomputing relevance from changed files.
- Added previous webhook secret support during rotation grace windows.
- Added webhook idempotency for already synced commits and duplicate deliveries.
- Returned non-leaky 404s for unknown projects and projects without Git integrations.
- Recorded sanitized failed history for webhook credential, preview, and apply failures.

### Verification

- `npx prettier --write packages/project-io/src/git/webhook-handler.ts apps/studio/src/app/api/webhooks/git/[projectId]/route.ts apps/studio/src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts` passed.
- `pnpm --filter @agent-platform/project-io build` passed.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-webhook-hidden-path-scenarios.test.ts` passed: 6/6.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts` passed: 20/20.
- `pnpm build` passed.

### Notes

- Webhook duplicate delivery protection is currently process-local. This locks duplicate handling in the route behavior but should move to distributed storage before relying on it across multiple Studio pods.

## Phase 5: Full Object Git Pull Parity And Import Safety

**Status**: Complete With Residual Follow-Up

### Changes

- Added strict `syncPath` validation before provider calls, including absolute paths, encoded malformed paths, duplicate slash segments, and `.` / `..` traversal.
- Filtered provider file listings to the configured sync path before canonical import planning.
- Added pulled-file path validation in direct-apply orchestration so unsafe remote filenames fail before state loading or adapter planning.
- Expanded the direct-apply supported layer list to the default Git export surface: `core`, `connections`, `prompts`, `guardrails`, `workflows`, `evals`, `search`, `channels`, and `vocabulary`.

### Verification

- `npx prettier --write packages/project-io/src/git/git-sync-service.ts packages/project-io/src/import/core-direct-apply.ts packages/project-io/src/import/core-direct-apply-orchestrator.ts` passed.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-sync-service.test.ts src/__tests__/git-full-lifecycle-scenarios.test.ts` passed: 48/48.
- `pnpm build` passed.

### Notes

- The layer parity lock now prevents the preview path from rejecting default Git export layers as unsupported. The actual write-applier depth for non-core object families still deserves a follow-up audit so the final lifecycle contract is not merely "accepted by preview" but fully applied object-by-object.

## Combined Focused Lock

**Status**: Passing

### Verification

- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-git-history-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts` passed: 125/125.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx` passed: 8/8.
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts` passed: 6/6.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-full-lifecycle-scenarios.test.ts src/__tests__/git-webhook-hidden-path-scenarios.test.ts src/__tests__/git-sync-service.test.ts` passed: 54/54.

### Residual Gaps At This Point

- Phase 6 thin E2E had not yet been added at this checkpoint; current locks were focused scenario/unit/component tests, not black-box workflow E2E.
- Full non-core object apply semantics need a deeper object-by-object audit after the preview-layer gate change.

## Phase 6: Thin Git Boundary E2E

**Status**: Complete With Environment-Gated Coverage

### Changes

- Added `apps/studio/e2e/git-lifecycle-boundary.spec.ts`, a thin API-only Playwright suite for real Studio transport/middleware coverage.
- Wired the new boundary spec into `apps/studio/e2e/playwright-git.config.ts` alongside the existing live Bitbucket lifecycle spec.
- Added an unauthenticated Git integration read sentinel that runs locally without DB state.
- Added a DB-backed non-leaky webhook unknown-project sentinel, skipped locally when `DATABASE_URL` is absent.
- Added opt-in authenticated setup sentinels for credential-bearing repository URLs and unsafe `syncPath` values. These run only with `ABLP976_GIT_E2E=1` to keep default E2E execution fast and avoid accidental stateful mutations.
- Fixed a hidden route regression discovered while adding E2E assertions: `GET /api/projects/:id/git` was acquiring the disconnect operation lock and never releasing it. GET now remains non-mutating and lock-free.

### Verification

- `npx prettier --write apps/studio/src/app/api/projects/[id]/git/route.ts apps/studio/e2e/git-lifecycle-boundary.spec.ts apps/studio/e2e/playwright-git.config.ts` passed.
- `pnpm --filter @agent-platform/studio build` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-git-history-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts` passed: 125/125.
- `pnpm --filter @agent-platform/studio exec playwright test -c e2e/playwright-git.config.ts e2e/git-lifecycle-boundary.spec.ts --list` passed: 4 tests discovered.
- `pnpm --filter @agent-platform/studio exec playwright test -c e2e/playwright-git.config.ts e2e/git-lifecycle-boundary.spec.ts` passed locally against `next start`: 1 passed, 3 skipped. Skips were expected because the local server had no working `DATABASE_URL` and stateful setup checks require `ABLP976_GIT_E2E=1`.
- Final companion lock after Phase 6 remained green:
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx` passed: 8/8.
  - `pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts` passed: 6/6.
  - `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-full-lifecycle-scenarios.test.ts src/__tests__/git-webhook-hidden-path-scenarios.test.ts src/__tests__/git-sync-service.test.ts` passed: 54/54.

### Residual Gaps Before Final Handoff

- DB-backed webhook E2E and stateful setup E2E need to run in an environment with `DATABASE_URL`; local default run only locks the no-auth transport sentinel.
- Full non-core object apply semantics need a deeper object-by-object audit after the preview-layer gate change.

## Final Audit Pass

**Status**: No Remaining Known P1 From Original ABLP-976 Findings; Residual P2/Pending Verification Items Remain

### Original Findings

- PAT credential enum mismatch: closed. UI/API normalize `pat` to persisted `token`.
- Auth profile selection not persisted: closed. Setup writes top-level `authProfileId`, and lifecycle consumers resolve through that field.
- SSH profile picker filtering: closed by excluding `ssh_key` from the Git picker and credential contract until provider credential resolution supports SSH material end to end.
- Git setup permission enforcement: closed. CRUD setup route enforces `PROJECT_GIT`.
- Sync history tenant scoping: closed. Model has `tenantId`, and history create/query paths include tenant scope.
- Bitbucket webhook relevance: closed. Route trusts parser `payload.isRelevant`.
- Default exported layer pull asymmetry: closed at the preview gate. Full object-by-object apply semantics still need follow-up verification for non-core families.
- Conflict strategy divergence: closed. API normalizes `ours/theirs` to `local_wins/remote_wins`.
- Provider credential validation before persistence: closed. Setup validates provider connection before creating the integration.

### Hidden-Path Audit

- Operation coordination: mutating push, pull apply, promote, webhook apply, and disconnect are coordinated; GET was audited and corrected to remain lock-free.
- Webhook hidden paths: relevance, stale/duplicate commits, secret rotation, tag/delete events, sanitized failed history, and non-leaky unknown project responses have scenario coverage.
- Path safety: `syncPath`, unsafe pulled filenames, and out-of-scope provider files have scenario coverage.
- Tenant/index safety: Git integration and sync history tenant-aware indexes are locked.
- E2E: thin API-only Playwright boundary coverage is wired. Local run passed the no-auth sentinel and skipped DB/stateful checks by design.

### Residual Items

- Git SSH auth profiles are out of scope for the current Git lifecycle. Current provider APIs are token-shaped, so SSH must remain hidden/rejected until implemented end to end.
- Run DB-backed webhook and stateful setup E2E in a configured environment with `DATABASE_URL` and, when desired, `ABLP976_GIT_E2E=1`.
- Perform a deeper non-core object apply audit for connections, guardrails, workflows, search, channels, and vocabulary to prove not just preview acceptance but final write semantics.

## Post-Rebase Verification

**Status**: Passing

### Changes

- Rebasing onto `origin/KI0326/feat/audit-worker` completed successfully with Git autostash applied.
- Refreshed pnpm workspace links after the rebase with `pnpm install`; this restored local package links for the upstream CLI `arch` command dependencies without tracked file changes.

### Verification

- `pnpm build` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-git-history-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts` passed: 125/125.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx` passed: 8/8.
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts` passed: 6/6.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-full-lifecycle-scenarios.test.ts src/__tests__/git-webhook-hidden-path-scenarios.test.ts src/__tests__/git-sync-service.test.ts` passed: 54/54.

### Residual Gaps At This Point

- Phase 6 thin E2E had not yet been added at this checkpoint; current locks were focused scenario/unit/component tests, not black-box workflow E2E.
- Full non-core object apply semantics need a deeper object-by-object audit after the preview-layer gate change.

## Phase 3 Addendum: Operation Coordination

**Status**: Complete

### Changes

- Added `apps/studio/src/lib/git-operation-lock.ts`, a Git-specific project operation lock that uses Redis distributed locking when Studio Redis is available and falls back to bounded process-local locking for local/dev execution.
- Wired the lock around mutating Git operations for the same `{ tenantId, projectId }`: push, pull apply, promote, webhook auto-sync apply, and disconnect.
- Kept non-mutating paths out of the coordinator, including dry-run pull, status, and history.
- Added a concurrent mutation sentinel that holds an in-flight push and verifies a second same-project mutation returns `423` with `GIT_OPERATION_IN_PROGRESS`.

### Verification

- `npx prettier --write apps/studio/src/lib/git-operation-lock.ts apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts apps/studio/src/app/api/projects/[id]/git/promote/route.ts apps/studio/src/app/api/projects/[id]/git/route.ts apps/studio/src/app/api/webhooks/git/[projectId]/route.ts apps/studio/src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts docs/plans/2026-05-11-ablp-976-git-integration-lifecycle-gap-closure.lld.md docs/sdlc-logs/ablp-976-git-integration-lifecycle-gap-closure/implementation.log.md` passed.
- `pnpm --filter @agent-platform/studio build` passed.
- `pnpm build` passed.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-git-history-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts` passed: 125/125.
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx` passed: 8/8.
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts` passed: 6/6.
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-full-lifecycle-scenarios.test.ts src/__tests__/git-webhook-hidden-path-scenarios.test.ts src/__tests__/git-sync-service.test.ts` passed: 54/54.

### Residual Gaps At This Point

- Phase 6 thin E2E had not yet been added at this checkpoint; current locks were focused scenario/unit/component tests, not black-box workflow E2E.
- Full non-core object apply semantics need a deeper object-by-object audit after the preview-layer gate change.
