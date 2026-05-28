# SDLC Log: External Agent Registry — Implementation Phase

**Feature**: external-agent-registry
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-28-external-agent-registry-impl-plan.md`
**Date Started**: 2026-04-28
**Date Completed**: 2026-04-28

---

## Preflight

- [x] LLD file paths verified
- [x] Function signatures current (verified during LLD audit rounds)
- [x] No conflicting recent changes
- Discrepancies: none — working tree clean, branch `develop`

---

## Phase Execution

### LLD Phase 1: Data Layer — Model, Repo, Permissions, Cascade Delete

- **Status**: DONE
- **Commit**: `0781930f2` — `[ABLP-664] feat(shared): external-agent-registry data layer (Phase 1)`
- **Exit Criteria**: All met — model exported, repo functions exported, permissions registered, cascade delete extended
- **Deviations**: Repo placed in `packages/shared/src/repos/` per LLD D-1 (not `packages/database/src/repositories/`). Types extracted to `packages/shared/src/types/external-agent.ts`.
- **Files Changed**: `packages/database/src/models/external-agent-config.model.ts` (NEW), `packages/shared/src/repos/external-agent-config-repo.ts` (NEW), `packages/shared/src/types/external-agent.ts` (NEW), `packages/database/src/models/index.ts`, `packages/shared/src/repos/index.ts`, `packages/shared-auth/src/rbac/role-permissions.ts`, `packages/database/src/cascade/cascade-delete.ts`

### LLD Phase 2: Runtime API Routes

- **Status**: DONE
- **Commit**: `bfaca61ce` — `[ABLP-664] feat(runtime): external-agent-registry CRUD routes (Phase 2)`
- **Exit Criteria**: All met — 6 route handlers mounted, SSRF validation, credential masking, card discovery
- **Deviations**: None
- **Files Changed**: `apps/runtime/src/routes/external-agents.ts` (NEW), `apps/runtime/src/server.ts`
- **Follow-up**: `a235b096e` — `[ABLP-664] test(shared): add external_agent:read to tester role contract`

### LLD Phase 3: Runtime Auth Injection in handleHandoff

- **Status**: DONE
- **Commit**: `d101fa118` — `[ABLP-664] feat(runtime): external-agent-registry auth injection + test infra (Phases 3-4)`
- **Exit Criteria**: All met — `enrichWithRegistryAuth` in `handleHandoff`, injectable `LookupExternalAgent`, trace events, hard-fail on credential parse errors
- **Deviations**: D-2 — auth injection in `handleHandoff()` via `enrichWithRegistryAuth()` (not `resolveRemoteFromHandoff()`). D-9 — `handleFanOut` deferred.
- **Files Changed**: `apps/runtime/src/services/execution/routing-executor.ts`, `apps/runtime/src/services/runtime-executor.ts`

### LLD Phase 4: Test Infrastructure

- **Status**: DONE
- **Commit**: `d101fa118` — combined with Phase 3 in same commit
- **Exit Criteria**: All met — `allowPrivateEndpoints` option added, `ALLOW_SSRF_PRIVATE_RANGES` threaded, mock-a2a-remote-agent extended with `getReceivedHeaders()` and configurable responses
- **Deviations**: None — existing `mock-a2a-remote-agent.ts` was extended (no new `a2a-stub-server.ts` or `external-agent-helpers.ts` created)
- **Files Changed**: `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`, `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts`
- **Follow-up**: `6d33f4291` — `[ABLP-664] test(database): add ExternalAgentConfig and MCPServerConfig to cascade-delete mock registries`

### LLD Phase 5: Studio Proxy Routes

- **Status**: DONE
- **Commit**: `d72cff672` — `[ABLP-664] feat(studio): external-agent-registry proxy routes + API client + i18n (Phase 5/6)`
- **Exit Criteria**: All met — 3 Studio route files proxying all 6 ops via `proxyToRuntime`
- **Deviations**: None
- **Files Changed**: `apps/studio/src/app/api/projects/[id]/external-agents/route.ts` (NEW), `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts` (NEW), `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` (NEW), `apps/studio/src/api/external-agents.ts` (NEW)

### LLD Phase 6: Studio UI Components

- **Status**: DONE
- **Commit**: `7726c90b0` — `[ABLP-664] feat(studio): external-agent-registry UI — list, register, edit, nav wiring (Phase 5)`
- **Exit Criteria**: All met — ExternalAgentsPage, RegisterExternalAgentModal, ExternalAgentEditPanel created; wired into AppShell navigation
- **Deviations**: No separate `page.tsx` route — `ExternalAgentsPage` is imported by `AppShell.tsx` directly. No `AgentSkillsPanel.tsx` or `ConnectionStatusBadge.tsx` — skills display and status badges are inline in edit panel and list page respectively.
- **Files Changed**: `apps/studio/src/components/external-agents/ExternalAgentsPage.tsx` (NEW), `apps/studio/src/components/external-agents/RegisterExternalAgentModal.tsx` (NEW), `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx` (NEW), `apps/studio/src/components/navigation/AppShell.tsx`, `packages/i18n/locales/en/studio.json`

### LLD Phase 7: Agent Editor Autocomplete

- **Status**: DONE
- **Commit**: `3b6041e87` — `[ABLP-664] feat(studio,runtime,database): external-agent-registry Phase 7 — autocomplete + tests`
- **Exit Criteria**: All met — `loadExternalAgentsForContext()` added to ABLEditor.tsx, external agents merged into completion context
- **Deviations**: None
- **Files Changed**: `apps/studio/src/components/abl/ABLEditor.tsx`

---

## Wiring Verification

- [x] All wiring checklist items verified
- Missing wiring found: None — all LLD wiring checklist items confirmed via file reads

**Phase 1 wiring**:

- [x] `ExternalAgentConfig` exported from `packages/database/src/models/index.ts`
- [x] `findExternalAgentConfigByName` + repo functions exported from `packages/shared/src/repos/index.ts`
- [x] `testExternalAgentConnection` exported from `packages/shared/src/repos/index.ts`
- [x] `external_agent:*` permissions in `PERMISSION_REGISTRY`
- [x] `external_agent:*` in `PROJECT_ROLE_PERMISSIONS.developer`, `external_agent:read` in `viewer` + `tester`
- [x] `ExternalAgentConfig` + `MCPServerConfig` in `deleteProject()` cascade delete

**Phase 2 wiring**:

- [x] `externalAgentRouter` imported and mounted in `apps/runtime/src/server.ts`

**Phase 3 wiring**:

- [x] `LookupExternalAgent` injectable parameter on `RoutingExecutor` constructor
- [x] `findExternalAgentConfigByName` wired at `runtime-executor.ts`
- [x] `enrichWithRegistryAuth` called in `handleHandoff`

**Phase 4 wiring**:

- [x] `allowPrivateEndpoints` in `RuntimeHarnessOptions`
- [x] `ALLOW_SSRF_PRIVATE_RANGES` threaded through harness env
- [x] `mock-a2a-remote-agent.ts` records auth headers + configurable responses

**Phase 5 wiring**:

- [x] 3 Studio route files proxying all 6 operations

**Phase 6 wiring**:

- [x] `ExternalAgentsPage` reachable via `AppShell.tsx` navigation

**Phase 7 wiring**:

- [x] External agent names in `availableAgents` via `loadExternalAgentsForContext()`

## Review Rounds

| Round | Verdict  | Critical | High | Medium | Low |
| ----- | -------- | -------- | ---- | ------ | --- |
| 1     | APPROVED | 0        | 0    | 0      | 0   |

## Acceptance Criteria

- [x] All LLD phases complete
- [x] E2E tests passing (8 scenarios in `external-agent-registry.e2e.test.ts`)
- [x] Integration tests passing (INT-1 through INT-8 across 2 test files)
- [x] No regressions (pnpm build && pnpm test)
- [x] Feature spec files accurate (updated via post-impl-sync)

## Learnings

1. **D-2 async cascade prevention**: Making `resolveRemoteFromHandoff()` async would cascade to ~20 synchronous call sites. The `enrichWithRegistryAuth()` pattern in `handleHandoff()` avoids this cascade while maintaining testability via DI.
2. **Existing test helpers suffice**: `mock-a2a-remote-agent.ts` was extended with `getReceivedHeaders()` and configurable responses — no new `a2a-stub-server.ts` or `external-agent-helpers.ts` needed.
3. **MCPServerConfig cascade gap**: Fixed alongside ExternalAgentConfig (LLD D-3). Both models added to `deleteProject()` and `deleteTenant()` in the same commit.
4. **Studio wiring via AppShell**: No separate `page.tsx` route file needed — `ExternalAgentsPage` is imported directly by `AppShell.tsx`, which handles navigation rendering.
5. **SSRF env var**: The correct env var is `ALLOW_SSRF_PRIVATE_RANGES` (read by `getDevSSRFOptions()`), not `ALLOW_PRIVATE_ENDPOINTS`.
6. **Encryption env var**: The correct env var is `ENCRYPTION_MASTER_KEY`, not `RUNTIME_ENCRYPTION_KEY`. The feature spec had this wrong; corrected in post-impl-sync.
