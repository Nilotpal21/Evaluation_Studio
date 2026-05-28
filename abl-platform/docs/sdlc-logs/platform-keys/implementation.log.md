# SDLC Log: Platform Keys — Implementation Phase

**Feature**: platform-keys
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-12-platform-keys-phase2-impl-plan.md`
**Date Started**: 2026-04-12
**Date Completed**: 2026-04-12

---

## Preflight

- [x] LLD file paths verified against current repo state
- [x] Function/component signatures re-read from source before implementation
- [x] Recent history inspected (`git log --oneline -5`)
- [x] Work stayed on the current branch; no branch switch or branch creation
- [x] Incremental package builds run before targeted test commands
- Discrepancies:
  - `packages/shared-auth` does not currently depend on `@abl/compiler/platform`; unknown-scope warnings follow the package's existing fallback pattern instead of introducing a new dependency during this phase.
  - Runtime project-agent routes expose `GET` and `PUT /:agentName/dsl`, not the `POST` write path implied by the LLD example. Runtime verification used the real write-protected route.
  - The Studio test harness initially lacked the scopes/member/agent setup required by Phase 2 E2E coverage; this was resolved by extending the harness and adding a test-only legacy-key seed route.
  - Runtime project RBAC initially let owner-created API keys inherit project-owner authority via `createdBy`. This was fixed in `apps/runtime/src/middleware/rbac.ts` so API keys are authorized by `projectScope + ctx.permissions`, not creator membership.
  - Review-round automation from the `implement` playbook was not executed via delegated reviewer agents in this turn; scoped local verification was used instead.

## Phase Execution

### LLD Phase 1: Scope Registry in shared-auth

- **Status**: COMPLETED
- **Commit**: deferred in this turn
- **Exit Criteria**:
  - `pnpm build --filter=@agent-platform/shared-auth` ✅
  - `pnpm --filter=@agent-platform/shared-auth test -- platform-key-scopes` ✅
- **Deviations**:
  - Kept unknown-scope warning transport on the package's existing logger pattern instead of adding a new dependency.
- **Files Changed**:
  - `packages/shared-auth/src/scopes/platform-key-scopes.ts`
  - `packages/shared-auth/src/scopes/scope-validation.ts`
  - `packages/shared-auth/src/scopes/index.ts`
  - `packages/shared-auth/src/index.ts`
  - `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts`

### LLD Phase 2: Studio Route Updates + Ceiling Check

- **Status**: COMPLETED
- **Commit**: deferred in this turn
- **Exit Criteria**:
  - `pnpm build --filter=@agent-platform/studio` ✅
  - `pnpm --filter=@agent-platform/studio exec vitest run src/__tests__/platform-keys-api.e2e.test.ts` ✅
  - Phase 2 API/unit suites (`platform-keys-unit.test.ts`, `platform-keys-api.test.ts`) were already green in the earlier targeted run; no Studio route changes were made after the runtime-only RBAC fix.
- **Deviations**:
  - Added a harness-only `POST /__test/seed-platform-key` route so E2E-15 could seed legacy colon-scoped keys without direct DB access in the E2E file.
- **Files Changed**:
  - `apps/studio/src/app/api/keys/route.ts`
  - `apps/studio/src/app/api/keys/[keyId]/route.ts`
  - `apps/studio/src/app/api/keys/platform-key-utils.ts`
  - `apps/studio/src/app/api/keys/scopes/route.ts`
  - `apps/studio/src/__tests__/helpers/studio-api-harness.ts`
  - `apps/studio/src/__tests__/platform-keys-api.test.ts`
  - `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`
  - `apps/studio/src/__tests__/platform-keys-unit.test.ts`

### LLD Phase 3: Runtime Scope Expansion (4 apps)

- **Status**: COMPLETED
- **Commit**: deferred in this turn
- **Exit Criteria**:
  - `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai --filter=@agent-platform/search-ai-runtime --filter=@agent-platform/workflow-engine` ✅
  - `pnpm --filter=@agent-platform/runtime exec vitest run --config vitest.integration.config.ts src/__tests__/sessions/repos-data.test.ts -t "auth-repo: resolveApiKey"` ✅
  - `pnpm --filter=@agent-platform/runtime exec vitest run src/__tests__/auth/middleware/rbac.test.ts` ✅
  - `pnpm --filter=@agent-platform/search-ai exec vitest run src/__tests__/search-ai-middleware.test.ts` ✅
  - `pnpm --filter=@agent-platform/studio exec vitest run src/__tests__/platform-keys-api.e2e.test.ts` ✅ (E2E-14 and E2E-15)
- **Deviations**:
  - Scope expansion alone was insufficient because project RBAC still treated API keys like creator users. Added an API-key-specific branch in `evaluateProjectPermission()` so read-only keys do not inherit project-owner write access from `createdBy`.
- **Files Changed**:
  - `apps/runtime/src/repos/auth-repo.ts`
  - `apps/runtime/src/middleware/rbac.ts`
  - `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`
  - `apps/runtime/src/__tests__/sessions/repos-data.test.ts`
  - `apps/search-ai/src/middleware/auth.ts`
  - `apps/search-ai/src/__tests__/search-ai-middleware.test.ts`
  - `apps/search-ai-runtime/src/middleware/auth.ts`
  - `apps/search-ai-runtime/package.json`
  - `apps/workflow-engine/src/index.ts`
  - `apps/workflow-engine/package.json`

### LLD Phase 4: UI Updates

- **Status**: COMPLETED
- **Commit**: deferred in this turn
- **Exit Criteria**:
  - `pnpm build --filter=@agent-platform/studio` ✅
  - Dynamic scope loading, category grouping, legacy-scope fallback rendering, and 403 denied-scope toast handling are wired in `PlatformKeysTab.tsx`
- **Deviations**:
  - Followed the LLD's Option A: server-side ceiling enforcement with client toast handling, not client-side disabling from the scopes endpoint.
- **Files Changed**:
  - `apps/studio/src/components/settings/PlatformKeysTab.tsx`
  - `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx`
  - `apps/studio/package.json`
  - `apps/studio/next-env.d.ts`

## Wiring Verification

- [x] `packages/shared-auth/src/index.ts` exports the new scopes barrel
- [x] `GET /api/keys/scopes` is mounted in Studio and the Studio API harness
- [x] `checkScopeCeiling` is used by both platform key write routes
- [x] `expandScopesToPermissions` is used by all four `resolveApiKey` implementations
- [x] `PlatformKeysTab` reads scopes from the Studio API instead of hardcoding them

## Review Loop

- Reviewer-agent rounds were deferred in this turn.
- Local verification completed through targeted builds plus focused runtime and Studio test suites.

## Acceptance Verification

- **Builds**:
  - `pnpm build --filter=@agent-platform/shared-auth` ✅
  - `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai --filter=@agent-platform/search-ai-runtime --filter=@agent-platform/workflow-engine` ✅
  - `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio` ✅
- **Tests**:
  - `pnpm --filter=@agent-platform/shared-auth test -- platform-key-scopes` ✅
  - `pnpm --filter=@agent-platform/search-ai exec vitest run src/__tests__/search-ai-middleware.test.ts` ✅
  - `pnpm --filter=@agent-platform/runtime exec vitest run src/__tests__/auth/middleware/rbac.test.ts` ✅
  - `pnpm --filter=@agent-platform/runtime exec vitest run --config vitest.integration.config.ts src/__tests__/sessions/repos-data.test.ts -t "auth-repo: resolveApiKey"` ✅
  - `pnpm --filter=@agent-platform/studio exec vitest run src/__tests__/platform-keys-api.e2e.test.ts` ✅
- **Acceptance status**:
  - Phase 2 LLD implementation is functionally complete for the registry, ceiling enforcement, runtime scope expansion, backwards compatibility, and Studio UI path.
  - Full monorepo `pnpm test` was not run; verification stayed scoped to the packages and suites touched by this feature.
  - Runtime analytics and pipeline-analytics routes now enforce project-wide access through `analytics:read`, while session-targeted analytics queries continue to use `resolveProjectSessionAccess(..., 'session:read')`.
