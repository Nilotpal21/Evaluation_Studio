# LLD: ABLP-976 Git Integration Lifecycle Gap Closure

**Related Audit Context**: ABLP-976 Git integration setup, auth profile, webhook, sync history, and full object lifecycle audit
**Related Design**: `/Users/prasannaarikala/projects/f-1/abl-platform/docs/architecture/runtime-deterministic-test-architecture.md`
**Related Plans**:

- `docs/plans/2026-03-12-git-versioning-sync.md`
- `docs/plans/2026-05-03-runtime-config-git-auth-hardening-plan.md`
- `docs/plans/2026-05-03-runtime-config-import-git-provisioning-hardening-plan.md`
- `docs/plans/2026-05-03-import-git-sync-truthfulness-hardening.lld.md`
- `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md`

**Status**: IMPLEMENTING - PHASES 1-6 LOCKED WITH E2E ENVIRONMENT GATES
**Date**: 2026-05-11

---

## 1. Scope And Current Test Baseline

This plan closes the Git integration gaps captured by the ABLP-976 scenario corpus. The current tests are intentionally target-contract tests: they compile and run, and their red cases are the implementation backlog.

### Current Focused Baseline

| Slice                                         |                         Current Result | Notes                                                                           |
| --------------------------------------------- | -------------------------------------: | ------------------------------------------------------------------------------- |
| Studio route/lib scenarios                    |                  39 passed / 85 failed | Setup, auth profile, lifecycle, history, webhook, status, credential resolution |
| Studio setup dialog scenarios                 |                    5 passed / 3 failed | PAT vocabulary, auth profile payload, unsupported credential filtering          |
| Database schema/index scenarios               |                    0 passed / 6 failed | Git sync history tenant field and tenant-aware indexes                          |
| project-io lifecycle/parser/service scenarios |                  33 passed / 21 failed | Full layer round trip, webhook parser, syncPath safety                          |
| **Total focused baseline**                    | **77 passed / 115 failed / 192 total** | Run after `pnpm build`                                                          |

### Current Focused Lock

After implementation phases 1-5, the focused lock is green:

| Slice                                         | Current Result | Notes                                                                                   |
| --------------------------------------------- | -------------: | --------------------------------------------------------------------------------------- |
| Studio route/lib scenarios                    | 125/125 passed | Setup, auth profile, lifecycle, history, webhook, status, credential resolution         |
| Studio setup dialog scenarios                 |     8/8 passed | Credential vocabulary, auth profile payload, unsupported credential filtering           |
| Database schema/index scenarios               |     6/6 passed | Git sync history tenant field and tenant-aware indexes                                  |
| project-io lifecycle/parser/service scenarios |   54/54 passed | Full layer preview acceptance, webhook parser, syncPath and unsafe remote path handling |

Remaining slice before final handoff is final audit. DB-backed webhook and stateful setup E2E coverage is wired but requires the appropriate environment variables.

### Thin E2E Lock

The Git E2E config now includes `apps/studio/e2e/git-lifecycle-boundary.spec.ts`.

| Slice                            |       Local Result | Notes                                                                                               |
| -------------------------------- | -----------------: | --------------------------------------------------------------------------------------------------- |
| Git unauthenticated API boundary |         1/1 passed | Proves real Studio transport rejects Git integration reads before project lookup                    |
| Git webhook non-leaky unknown    |    skipped locally | Requires `DATABASE_URL`; exercises real project lookup and should run in DB-backed E2E environments |
| Git stateful setup sentinels     | opt-in via env var | Set `ABLP976_GIT_E2E=1`; validates pre-persistence setup rejection against a real Studio project    |

Remaining slice before final handoff is final audit.

### Test-Time Strategy

Follow the deterministic architecture:

1. **Tier 1 scenario tests** stay broad and fast. Keep most Git lifecycle variants in route-level mocked seams, database schema assertions, and pure `project-io` tests.
2. **Tier 2 wiring tests** prove production route/service wiring reaches the fixed seams with production-shaped inputs. Keep these to 1-2 sentinel tests per major path.
3. **Tier 3 E2E tests** should be thin and sparse: one setup happy path, one permission/isolation path, one webhook auto-sync path, and one full push/pull round trip path after the lower tiers are green.

Do not convert every scenario into E2E. The scenario corpus is the truth table; E2E proves transport and middleware only.

---

## 2. Design Decisions

| #   | Decision                                                                                    | Rationale                                                                                                        | Alternatives Rejected                                                                                        |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-1 | Normalize Git credential vocabulary at the Studio boundary.                                 | UI/API must not persist values outside the database enum or project-io contract.                                 | Letting downstream layers translate `pat`, `ours`, or `theirs` creates drift and opaque 500s.                |
| D-2 | Persist `authProfileId` as the lifecycle credential source of truth.                        | Push, pull, promote, webhook, status, and disconnect all need the same credential resolution path.               | Overloading `credentials.secretId` with an auth profile id breaks raw secret fallback and profile lifecycle. |
| D-3 | Make Git setup and mutation routes use the same `PROJECT_GIT` gate as lifecycle operations. | Creating/deleting Git integration is as privileged as push/pull.                                                 | Project read/write access alone is too broad.                                                                |
| D-4 | Add tenant scoping to Git sync history and Git integration uniqueness.                      | Studio routes already query by tenant; the schema and indexes must preserve that contract.                       | Relying on Mongoose strict-mode dropped fields or project-only indexes is not tenant-safe.                   |
| D-5 | Treat provider webhook payload parsing as provider-specific decision logic.                 | Bitbucket, GitHub, and GitLab have different payload semantics for changed files, tag pushes, and delete events. | Recomputing relevance generically in the route loses provider facts.                                         |
| D-6 | Close full object lifecycle parity through import support or explicit fail-closed staging.  | Default Git export includes non-core objects; pull must not silently drop them.                                  | Continuing asymmetric push/pull makes "synced" untrustworthy.                                                |
| D-7 | Keep audit/history errors sanitized but retain raw details in server logs only.             | Git credential failures often contain tenant ids, profile ids, tokens, or provider URLs.                         | Returning raw provider errors improves debugging but leaks internal or secret material.                      |
| D-8 | Add project-level Git operation coordination before broad E2E.                              | Push, pull, webhook auto-sync, and disconnect can otherwise race on the same integration state.                  | Depending on provider or Mongo last-write-wins leaves hidden corruption paths.                               |

---

## 3. File-Level Change Map

### Modified Production Files

| File                                                               | Change Description                                                                                                                                                                   | Risk   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `apps/studio/src/app/api/projects/[id]/git/route.ts`               | Normalize setup/PATCH payloads, enforce `PROJECT_GIT`, validate provider credentials before create, persist `authProfileId`, sanitize errors, unregister provider webhooks on delete | High   |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`        | Send backend credential vocabulary, send selected profiles as `authProfileId`, include supported Git auth profile types, preserve retry state                                        | Medium |
| `apps/studio/src/lib/git-credentials.ts`                           | Resolve auth profiles with project/tenant/personal scope, validate Git-compatible auth types, sanitize resolver failures                                                             | High   |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`          | Use profile-aware credentials, sanitize history/audit, classify protected-branch conflicts, coordinate per-project Git operations                                                    | High   |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`          | Use profile-aware credentials, preserve dry-run/apply semantics, avoid advancing `lastSyncCommit` on apply failure, coordinate operations                                            | High   |
| `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`       | Enforce ordered promotion transitions and sanitized credential/provider failures                                                                                                     | Medium |
| `apps/studio/src/app/api/projects/[id]/git/status/route.ts`        | Scope reads by tenant/project and expose non-leaky status/error payloads                                                                                                             | Medium |
| `apps/studio/src/app/api/projects/[id]/git/history/route.ts`       | Validate filters, add branch/status filters, stable tie-breaker sort, bounded/default limits                                                                                         | Medium |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`        | Trust provider relevance, handle secret rotation, idempotency/stale commits, tag/delete events, non-leaky 404s, sanitized failed history                                             | High   |
| `packages/database/src/models/git-sync-history.model.ts`           | Add `tenantId`, tenant-aware indexes, and any backfill/migration notes                                                                                                               | High   |
| `packages/database/src/models/git-integration.model.ts`            | Replace project-only unique index with tenant + project uniqueness; add rotation/disconnect fields if needed                                                                         | High   |
| `packages/project-io/src/git/webhook-handler.ts`                   | Provider-specific parser fixes and Bitbucket signature support                                                                                                                       | Medium |
| `packages/project-io/src/git/git-sync-service.ts`                  | Validate syncPath, prevent traversal, filter provider files outside configured syncPath, preserve canonical paths                                                                    | High   |
| `packages/project-io/src/import/core-direct-apply.ts`              | Add or wire full Git-pull import support for exported default layers, or keep unsupported layers explicitly blocking until implemented                                               | High   |
| `packages/project-io/src/import/core-direct-apply-orchestrator.ts` | Validate pulled file paths and enforce fail-closed import planning before apply                                                                                                      | High   |

### Test Files Already Added Or Expanded

| File                                                                                    | Purpose                                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts`                | Setup/PATCH/DELETE contract, permissions, normalization, validation, audit, disconnect cleanup |
| `apps/studio/src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts` | Push/pull/promote auth profile propagation and lifecycle error semantics                       |
| `apps/studio/src/__tests__/api-routes/api-git-history-scenarios.test.ts`                | Tenant-scoped history filters, sorting, and limits                                             |
| `apps/studio/src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts`      | Webhook provider relevance, idempotency, rotation, sanitization, non-leaky errors              |
| `apps/studio/src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts` | Auth profile consumer references for Git integrations                                          |
| `apps/studio/src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts`     | Git status hidden path and non-leaky response behavior                                         |
| `apps/studio/src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts`           | Credential resolver scoping and auth type validation                                           |
| `apps/studio/src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx`  | Setup dialog payload and picker behavior                                                       |
| `packages/database/src/__tests__/git-integration-tenant-index.test.ts`                  | Tenant-aware Git integration unique index                                                      |
| `packages/database/src/__tests__/git-sync-history-tenant-scope.test.ts`                 | Sync history tenant field and indexes                                                          |
| `packages/project-io/src/__tests__/git-full-lifecycle-scenarios.test.ts`                | Full object layer pull/import parity and unsafe path rejection                                 |
| `packages/project-io/src/__tests__/git-webhook-hidden-path-scenarios.test.ts`           | Pure webhook parser/signature hidden paths                                                     |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`                            | syncPath traversal and out-of-scope file behavior                                              |

---

## 4. Implementation Phases

### Phase 0: Baseline And Test Harness Stabilization

**Goal**: Keep the scenario corpus executable and cheap while implementation proceeds.

**Tasks**:

1. Record the current focused baseline in this plan.
2. Keep tests target-contract style; only adjust assertions when the intended contract changes.
3. Add a single script or documented command group for focused Git verification.

**Exit Criteria**:

- [x] `pnpm build` passes before focused tests.
- [x] Focused Git scenario commands run in under 30 seconds excluding full build.
- [x] The red/green count is recorded after every implementation phase.

**Verification**:

- `pnpm build`
- Studio route/lib focused Vitest command
- Studio component focused Vitest command
- Database focused Vitest command
- project-io focused Vitest command

**Rollback**: Revert only test harness changes from this phase; keep product tests unless the contract is explicitly rejected.

---

### Phase 1: Data Model And Credential Contract

**Goal**: Make the persisted Git integration and sync history data model match every route query and lifecycle credential consumer.

**Tasks**:

1. Add `tenantId` to `GitSyncHistory` with required string validation.
2. Add tenant-aware sync history indexes for `{ projectId, tenantId, createdAt }` and `{ projectId, tenantId, status }`.
3. Replace `GitIntegration` project-only unique index with `{ tenantId, projectId }` uniqueness.
4. Update or document migration/backfill for existing Git sync history records and integration indexes.
5. Update `resolveGitCredentials()` to accept integration project context and profile scope rules:
   - project profile: same `projectId`
   - tenant profile: `{ projectId: null, scope: 'tenant' }`
   - personal profile: `{ scope: 'personal', createdBy: user.id }` only when a user principal is present
6. Validate Git-compatible profile auth types and produce sanitized errors.

**Files Touched**:

- `packages/database/src/models/git-sync-history.model.ts`
- `packages/database/src/models/git-integration.model.ts`
- `apps/studio/src/lib/git-credentials.ts`
- Model exports/migration files if the repo uses a migration lane for index changes

**Exit Criteria**:

- [x] Database schema/index tests pass.
- [x] Credential resolver hidden-path tests pass.
- [x] No sync history create/query path drops `tenantId`.
- [x] No error returned by credential resolver includes tenant id, auth profile id, or secret id.

**Rollback**: Revert schema/index changes and restore resolver signature; do not deploy without an index rollback step if a migration was applied.

---

### Phase 2: Git Setup UI And CRUD Boundary

**Goal**: Make setup, update, read, and disconnect enforce the same contract the lifecycle routes depend on.

**Tasks**:

1. Normalize `credentials.type: 'pat'` to backend `token` at the UI and API boundary.
2. Normalize conflict strategy values:
   - `manual` -> `manual`
   - `ours` -> `local_wins`
   - `theirs` -> `remote_wins`
3. Persist `authProfileId` as its own field on create/PATCH and do not overload `credentials.secretId`.
4. Include only supported token-compatible Git auth profile types in the picker; do not expose SSH until provider factories can consume SSH material end to end.
5. Enforce `PROJECT_GIT` permission on GET/POST/PATCH/DELETE for `/api/projects/[id]/git`.
6. Validate provider/repository/credentials before persistence and return 400-level sanitized errors.
7. Normalize repository URLs and reject credential-bearing URLs or SSRF-like hosts.
8. Normalize and validate `syncPath`.
9. Redact secret material from GET responses and audit metadata.
10. On DELETE, unregister provider webhook using resolved credentials before deleting integration; preserve integration for retry if provider cleanup fails.

**Files Touched**:

- `apps/studio/src/components/settings/GitIntegrationTab.tsx`
- `apps/studio/src/app/api/projects/[id]/git/route.ts`

**Exit Criteria**:

- [x] `api-git-ablp976-scenarios.test.ts` setup/CRUD cases pass.
- [x] `git-integration-setup-dialog.scenarios.test.tsx` passes.
- [x] Provider validation failures do not create integrations or update project pointers.
- [x] Existing integration reads never expose `secretId`, token, webhook secret, or provider raw error details.

**Rollback**: Restore previous route payload handling and UI submit behavior; delete any partially created integration during rollback validation.

---

### Phase 3: Lifecycle Route Parity And Operation Coordination

**Goal**: Make push, pull, promote, history, and status reliable after setup succeeds.

**Tasks**:

1. Thread `authProfileId` through push, pull, promote, status, and webhook credential resolution.
2. Record failed sync history exactly once for credential/provider/apply failures.
3. Sanitize all failed history and user-visible route responses.
4. Keep dry-run pull preview-only: no apply, no history record, no `lastSyncCommit`.
5. On pull apply failure, set failed status/error but do not advance `lastSyncCommit`.
6. Classify branch protection failures as a conflict/actionable 409 rather than generic 500.
7. Enforce ordered promotion transitions:
   - allow `main -> staging`
   - allow `staging -> production`
   - reject direct skips and reverse promotion before credential resolution
8. Add stable history filters for direction, branch, and status with deterministic sort `{ createdAt: -1, _id: -1 }`.
9. Add a project-scoped Git operation coordinator:
   - one active push/pull/webhook apply/disconnect per `{ tenantId, projectId }`
   - short TTL and safe release
   - 409 or 423 for concurrent mutation, with non-mutating status/history reads still allowed

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/git/push/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/status/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/history/route.ts`
- New small helper if needed, for example `apps/studio/src/lib/git-operation-lock.ts`

**Exit Criteria**:

- [x] `api-git-auth-profile-lifecycle-scenarios.test.ts` passes.
- [x] `api-git-history-scenarios.test.ts` passes.
- [x] `api-git-status-hidden-path-scenarios.test.ts` passes.
- [x] Concurrent mutation sentinel tests prove only one operation mutates integration state.

**Rollback**: Disable the operation coordinator behind a narrow config flag only if it blocks production; credential propagation and sanitization are not optional rollback candidates.

---

### Phase 4: Webhook Provider Semantics And Idempotency

**Goal**: Make webhook auto-sync honor provider payload semantics and avoid duplicate or stale applies.

**Tasks**:

1. Update `parseWebhookPayload()` for provider-specific semantics:
   - Bitbucket pushes are relevant even without changed files.
   - Bitbucket multiple changes select the matching sync branch in route logic.
   - GitHub/GitLab tag pushes and branch deletes return ignored payloads, not parse errors.
2. Support Bitbucket `sha256=` webhook signatures.
3. In the route, trust parser `isRelevant`; do not recompute relevance from empty changed files for Bitbucket.
4. Support previous webhook secret during rotation grace window.
5. Add idempotency by delivery id when present and by `{ projectId, branch, commitSha }` fallback.
6. Skip commits already equal to `integration.lastSyncCommit`.
7. Return non-leaky 404s for missing projects and missing integrations.
8. Record sanitized failed history for credential resolution and import/apply failures.

**Files Touched**:

- `packages/project-io/src/git/webhook-handler.ts`
- `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`
- `packages/database/src/models/git-integration.model.ts` if secret rotation fields are added
- Optional webhook delivery/idempotency storage if an existing model is not sufficient

**Exit Criteria**:

- [x] `git-webhook-hidden-path-scenarios.test.ts` passes.
- [x] `api-webhook-git-bitbucket-scenarios.test.ts` passes.
- [x] Duplicate webhook deliveries do not call pull/apply twice.
- [x] Previous webhook secret acceptance expires deterministically.

**Rollback**: Disable previous-secret acceptance and idempotency storage only if migration/storage fails; provider parser fixes should remain.

---

### Phase 5: Full Object Git Pull Parity And Import Safety

**Goal**: Make Git push/export and Git pull/import symmetric for default project objects, or explicitly block unsupported objects without false success.

**Tasks**:

1. Reject unsafe pulled file paths before preview planning:
   - parent traversal
   - absolute paths
   - encoded traversal
   - duplicate slash segments where canonicalization is ambiguous
2. Validate `syncPath` in `GitSyncService` before provider calls.
3. Filter provider files outside configured `syncPath` before import planning.
4. Decide the implementation lane for default exported layers:
   - preferred: add direct-apply support for connections, guardrails, workflows, search, channels, and vocabulary
   - interim: remove unsupported layers from default Git push or block pull with clear preview issues until those layer appliers exist
5. Keep `core`, `prompts`, and `evals` pull-importable through existing direct-apply support.
6. Extend change summaries to include every importable surface touched by Git pull.

**Files Touched**:

- `packages/project-io/src/git/git-sync-service.ts`
- `packages/project-io/src/import/core-direct-apply.ts`
- `packages/project-io/src/import/core-direct-apply-orchestrator.ts`
- Existing layer assembler/disassembler/import helpers for each object family
- Studio pull route if returned preview/change summary shapes need widening

**Exit Criteria**:

- [x] `git-sync-service.test.ts` syncPath/path-boundary cases pass.
- [x] `git-full-lifecycle-scenarios.test.ts` passes under the chosen full-lifecycle contract.
- [ ] A default Git push artifact can be pulled without silently dropping objects.
- [x] Unsafe remote file names never reach adapter write plans.

**Rollback**: If full layer support is too large for one release, keep the fail-closed unsupported-layer guard and split layer appliers into follow-up PRs.

---

### Phase 6: Thin E2E And Final Audit

**Goal**: Add only the E2E tests needed to prove real middleware/transport/persistence wiring, then re-audit.

**Tasks**:

1. Add or update 4-6 black-box E2E tests after scenario tests are green:
   - setup with auth profile persists and reads back redacted integration
   - non-Git project member cannot mutate Git integration
   - webhook auto-sync applies once for a provider payload
   - dry-run pull does not mutate state
   - full push/pull round trip for a representative project object set
   - cross-tenant integration/history access returns non-leaky 404
2. Avoid direct DB access in E2E; seed/assert through public HTTP APIs only.
3. Run a targeted audit against the original nine findings plus the hidden-path findings from this plan.
4. Update docs/testing coverage tables with current type vs target type.

**Files Touched**:

- `apps/studio/e2e/git-lifecycle-boundary.spec.ts`
- `apps/studio/e2e/playwright-git.config.ts`
- Testing docs if this work changes the coverage matrix

**Exit Criteria**:

- [x] All focused scenario suites pass.
- [x] Thin E2E suite is wired without mocks or DB access in the test code; local no-auth sentinel passes and DB-backed/stateful sentinels are environment-gated.
- [ ] ABLP-976 audit rerun shows no remaining P1 lifecycle gaps.
- [x] `pnpm build` passes.

**Rollback**: Remove only new E2E specs if the environment is unstable; keep lower-tier tests as the source of implementation truth.

---

## 5. Verification Commands

Run build first, then focused suites. Keep the focused loop fast while implementing; run broader package tests before handoff.

```bash
pnpm build
pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-git-history-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-auth-profile-git-consumers-scenarios.test.ts src/__tests__/api-routes/api-git-status-hidden-path-scenarios.test.ts src/__tests__/lib/git-credentials-hidden-path-scenarios.test.ts
pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/git-integration-setup-dialog.scenarios.test.tsx
pnpm --filter @agent-platform/database exec vitest run src/__tests__/git-sync-history-tenant-scope.test.ts src/__tests__/git-integration-tenant-index.test.ts
pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/git-full-lifecycle-scenarios.test.ts src/__tests__/git-webhook-hidden-path-scenarios.test.ts src/__tests__/git-sync-service.test.ts
```

After the scenario suites are green, add the small E2E slice and run only those E2E files plus the relevant package fast tests.

---

## 6. Wiring Checklist

- [x] Git integration CRUD route imports and enforces `StudioPermission.PROJECT_GIT`.
- [x] Git setup UI sends `token` and `authProfileId` in the route contract expected by the API.
- [x] Credential resolver callers pass tenant id, auth profile id, and project/user context consistently.
- [x] Git sync history model exports include `tenantId` and tenant-aware indexes.
- [x] Git integration unique indexes are tenant-aware in schema and migration.
- [x] Push/pull/promote/webhook routes record sync history with tenant id.
- [x] Webhook route uses parser `isRelevant` and provider-specific branch semantics.
- [x] Webhook idempotency storage, if new, is exported and indexed.
- [x] Git operation coordinator is used by all mutating lifecycle routes.
- [ ] Full object import appliers are exported and reachable from `core-direct-apply`.
- [x] Studio route response types and client types reflect any widened history/status/pull payloads.
- [x] E2E workflow docs are updated if workflow E2E coverage is added. No workflow E2E files were changed.

---

## 7. Acceptance Criteria

- [x] All 193 focused Git scenario tests pass or are intentionally updated to a reviewed revised contract.
- [ ] The original ABLP-976 findings are closed:
  - PAT enum mismatch
  - missing `authProfileId`
  - Unsupported credential filtering
  - missing Git permission gate
  - missing sync history tenant field
  - Bitbucket webhook relevance
  - default layer pull asymmetry
  - conflict strategy vocabulary drift
  - missing provider validation before persistence
- [ ] Hidden-path gaps are closed:
  - webhook idempotency and stale commits
  - secret rotation
  - tag/delete event handling
  - path traversal and syncPath boundary safety
  - protected branch conflicts
  - promotion ordering
  - sanitized audit/history surfaces
  - tenant-aware indexes
  - operation coordination
- [x] Thin E2E proves real middleware for the critical paths without duplicating the scenario corpus; persistence-path E2E is wired and environment-gated.
- [ ] Final audit is recorded with residual risks and test gaps.

---

## 8. Open Questions

1. Should SSH auth profiles be supported for Git provider operations in a future slice after provider factories can consume SSH profile material?
2. Should full object layer pull parity be implemented in one PR, or split by object family after the fail-closed guard is in place?
3. Should webhook idempotency reuse an existing webhook delivery model, or add a Git-specific idempotency record with `{ tenantId, projectId, provider, deliveryId, commitSha }`?
4. What response code should concurrent Git mutations use consistently: 409 Conflict or 423 Locked?
5. Is `main -> staging -> production` the complete promotion topology, or should environments be read from project environment configuration before enforcing transitions?
