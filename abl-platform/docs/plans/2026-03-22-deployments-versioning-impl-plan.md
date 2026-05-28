# LLD & Implementation Plan: Deployments & Versioning

**Feature Slug:** `deployments-versioning`
**Status:** ALPHA -> BETA target
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Depends On:** Feature Spec, Test Spec, HLD

---

## 1. Executive Summary

The Deployments & Versioning feature is substantially implemented. The core backend (models, services, routes, repos) covers agent versioning, workflow versioning, settings versioning, deployment lifecycle, variable snapshots, preflight validation, auto-versioning, and channel auto-follow. This LLD focuses on closing the gaps needed to promote from ALPHA to BETA: Studio deployment management UI, missing test coverage, audit log integration, and draining timeout automation.

## 2. Current State Assessment

### Implemented (ALPHA)

| Component                          | Status                          | LOC  | Test Coverage                        |
| ---------------------------------- | ------------------------------- | ---- | ------------------------------------ |
| `Deployment` model                 | Complete                        | 102  | Model tests                          |
| `AgentVersion` model               | Complete                        | 72   | Model tests                          |
| `WorkflowVersion` model            | Complete                        | 78   | Model tests                          |
| `ProjectSettingsVersion` model     | Complete                        | 90   | Model tests                          |
| `DeploymentVariableSnapshot` model | Complete                        | 113  | Model tests                          |
| `VersionService`                   | Complete                        | 645  | Route + authz tests                  |
| `WorkflowVersionService`           | Complete                        | 376  | Route + service tests                |
| `SettingsVersionService`           | Complete                        | 314  | Proxy routes only (no service tests) |
| `SnapshotService`                  | Complete                        | 203  | Service tests                        |
| `PreflightValidationService`       | Complete                        | ~100 | Partial                              |
| `deployment-repo.ts`               | Complete                        | 152  | Route tests (mocked)                 |
| `routes/deployments.ts`            | Complete                        | ~700 | Route + authz + promotion tests      |
| `DeployPanel` (Studio)             | Widget/SDK only                 | ~500 | Manual testing                       |
| Studio proxy routes                | Settings versions + git promote | ~100 | No tests                             |
| `useAgentVersions` hook            | Complete                        | 107  | No tests                             |
| `version-store.ts`                 | Complete                        | 37   | No tests                             |

### Gaps (Blocking BETA)

| Gap                                                                                 | Impact                                      | Priority |
| ----------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| G1: No Studio UI for deployment lifecycle (create, list, retire, rollback, promote) | Users cannot manage deployments from Studio | P0       |
| G2: No tests for SettingsVersionService                                             | Zero coverage on 4 endpoints                | P0       |
| G3: No cross-tenant E2E isolation tests for deployments                             | Tenant isolation unverified at DB level     | P0       |
| G4: No audit log integration for deployment events                                  | Compliance gap                              | P1       |
| G5: No draining timeout automation                                                  | Draining deployments stay indefinitely      | P1       |
| G6: Variable snapshot cascade delete untested                                       | Retirement cleanup unverified               | P1       |
| G7: No E2E test for concurrent deployment conflict (409)                            | Race condition handling unverified          | P1       |
| G8: Config variable inclusion in sourceHash untested                                | Dedup correctness unverified                | P2       |

## 3. Implementation Phases

### Phase 1: Test Coverage Gaps (P0)

**Goal**: Close critical test coverage gaps that block BETA confidence.

**Duration**: 2-3 days

#### 1.1 SettingsVersionService Integration Tests

**File**: `apps/runtime/src/__tests__/settings-version-service.test.ts`

**Test Cases**:

1. Create settings version from working copy -- verify record fields
2. Deduplication on same sourceHash -- verify returns existing version
3. Promote through lifecycle (draft -> testing -> staged -> active -> deprecated)
4. Reject invalid status transitions
5. Optimistic lock conflict returns 422
6. List versions with pagination -- verify ordering (createdAt desc)
7. Auto-increment version numbering

**Implementation Details**:

- Mock `findProjectSettings()` to return configurable settings
- Mock `createSettingsVersion`, `findSettingsVersion`, etc. from `project-settings-repo.ts`
- Test `SettingsVersionService` directly, not through routes
- Verify changelog validation (null, valid string, oversized string)

#### 1.2 Cross-Tenant Deployment E2E Tests

**File**: `apps/runtime/src/__tests__/deployment-tenant-isolation-e2e.test.ts`

**Test Cases**:

1. Tenant A creates deployment, Tenant B GET list returns empty
2. Tenant B GET specific deployment by ID returns 404
3. Tenant B POST retire returns 404
4. Tenant B POST rollback returns 404
5. Tenant A's deployment unchanged after Tenant B operations
6. Deployment creation scoped to correct tenant in DB query

**Implementation Details**:

- Start real Express server on random port
- Use two different `tenantContext` configurations
- Must use real MongoDB (MongoMemoryServer) for genuine tenant isolation verification
- Seed project/agent data for both tenants independently

#### 1.3 Additional Critical Unit Tests

**File**: `apps/runtime/src/__tests__/version-service-unit.test.ts`

**Test Cases**:

1. sourceHash includes config variables
2. sourceHash without config variables matches raw DSL hash
3. sourceHash with same config vars in different order produces same hash
4. Concurrent version creation retry behavior (mock E11000)

**Exit Criteria**:

- [ ] SettingsVersionService has >= 7 passing tests
- [ ] Cross-tenant E2E has >= 6 passing tests
- [ ] sourceHash unit tests passing
- [ ] `pnpm test --filter=runtime` passes with no regressions

---

### Phase 2: Studio Deployment Management UI (P0)

**Goal**: Provide Studio UI for full deployment lifecycle management.

**Duration**: 3-5 days

#### 2.1 Deployment API Client

**File**: `apps/studio/src/api/deployments.ts`

**Functions**:

```typescript
export async function listDeployments(
  projectId: string,
  filters?: { environment?: string; status?: string },
): Promise<DeploymentListResponse>;
export async function getDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentDetailResponse>;
export async function createDeployment(
  projectId: string,
  params: CreateDeploymentParams,
): Promise<CreateDeploymentResponse>;
export async function retireDeployment(
  projectId: string,
  deploymentId: string,
  force?: boolean,
): Promise<RetireDeploymentResponse>;
export async function rollbackDeployment(
  projectId: string,
  deploymentId: string,
): Promise<RollbackDeploymentResponse>;
export async function promoteDeployment(
  projectId: string,
  deploymentId: string,
  targetEnvironment: string,
): Promise<PromoteDeploymentResponse>;
```

**Types**:

```typescript
interface DeploymentSummary {
  id: string;
  projectId: string;
  environment: 'dev' | 'staging' | 'production';
  status: 'active' | 'draining' | 'retired';
  label: string | null;
  endpointSlug: string;
  entryAgentName: string;
  agentVersionManifest: Record<string, string>;
  createdAt: string;
  createdBy: string;
}
```

#### 2.2 Studio Proxy Routes

**Files**:

- `apps/studio/src/app/api/projects/[id]/deployments/route.ts` -- GET (list) + POST (create)
- `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/route.ts` -- GET (detail)
- `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/retire/route.ts` -- POST
- `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/rollback/route.ts` -- POST
- `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/promote/route.ts` -- POST

Each proxy route follows the existing pattern in `settings/versions/route.ts`:

1. `requireTenantAuth(request)`
2. `requireProjectAccess(projectId, user)`
3. Forward to `${getRuntimeUrl()}/api/projects/${projectId}/deployments/...`
4. Pass `Authorization` and `X-Tenant-Id` headers

#### 2.3 Deployment Management Components

**File**: `apps/studio/src/components/deployments/DeploymentManager.tsx`

**Component Tree**:

```
DeploymentManager
  ├── DeploymentHeader (title, create button)
  ├── EnvironmentTabs (dev | staging | production)
  ├── DeploymentList
  │   └── DeploymentCard (status badge, manifest, actions)
  ├── CreateDeploymentDialog
  │   ├── Agent version selector (from useAgentVersions)
  │   ├── Entry agent selector
  │   ├── Environment selector
  │   └── Auto-version toggle
  └── DeploymentDetailPanel
      ├── Status timeline (active -> draining -> retired)
      ├── Version manifest table
      ├── Channel count
      └── Action buttons (retire, rollback, promote)
```

**Hooks**:

- `useDeployments(projectId, environment?)` -- SWR hook for deployment list
- Reuse existing `useAgentVersions` for version selection in create dialog

#### 2.4 Navigation Integration

**File**: `apps/studio/src/config/navigation.ts`

Add "Deployments" navigation item under project context, gated by `deployment:read` permission.

**Exit Criteria**:

- [ ] Deployment list page renders with environment tabs
- [ ] Create deployment dialog submits to API and refreshes list
- [ ] Retire/rollback/promote actions work from deployment cards
- [ ] Studio build passes (`pnpm build --filter=studio`)
- [ ] Navigation item visible and functional

---

### Phase 3: Audit Log Integration (P1)

**Goal**: Emit audit events for all deployment lifecycle operations.

**Duration**: 1-2 days

#### 3.1 Audit Event Definitions

**File**: `apps/runtime/src/services/audit-helpers.ts` (extend existing)

**New Functions**:

```typescript
export async function auditDeploymentCreated(params: {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  userId: string;
  agentVersionManifest: Record<string, string>;
}): Promise<void>;

export async function auditDeploymentRetired(params: {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  userId: string;
  previousStatus: string;
}): Promise<void>;

export async function auditDeploymentRolledBack(params: {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  rolledBackToId: string;
  userId: string;
}): Promise<void>;

export async function auditDeploymentPromoted(params: {
  tenantId: string;
  projectId: string;
  sourceDeploymentId: string;
  targetDeploymentId: string;
  fromEnvironment: string;
  toEnvironment: string;
  userId: string;
}): Promise<void>;
```

#### 3.2 Wire Audit Calls into Routes

**File**: `apps/runtime/src/routes/deployments.ts`

Add audit calls after successful operations:

- After `createDeployment()` success -> `auditDeploymentCreated()`
- After retire success -> `auditDeploymentRetired()`
- After rollback success -> `auditDeploymentRolledBack()`
- After promote success -> `auditDeploymentPromoted()`

All audit calls wrapped in try/catch (non-fatal, like existing pattern in version routes).

**Exit Criteria**:

- [ ] Audit events emitted for create, retire, rollback, promote
- [ ] Audit calls are non-fatal (wrapped in try/catch)
- [ ] Existing deployment route tests pass (audit functions mocked)

---

### Phase 4: Draining Timeout Automation (P1)

**Goal**: Automatically retire draining deployments after a configurable timeout.

**Duration**: 1-2 days

#### 4.1 Draining Monitor Worker

**File**: `apps/runtime/src/services/deployment-draining-monitor.ts`

**Implementation**:

```typescript
const DRAINING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default
const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds

export class DeploymentDrainingMonitor {
  private interval: NodeJS.Timeout | null = null;

  start(): void {
    this.interval = setInterval(() => this.checkDrainingDeployments(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async checkDrainingDeployments(): Promise<void> {
    // Find all deployments in 'draining' status where drainingStartedAt + DRAINING_TIMEOUT_MS < now
    // For each: transition to 'retired', cascade-delete snapshot
  }
}
```

**Configuration**: `DEPLOYMENT_DRAINING_TIMEOUT_MS` env var (default 5 minutes).

#### 4.2 Wire into Runtime Startup

**File**: `apps/runtime/src/index.ts` or startup sequence

Start the draining monitor on app initialization, stop on graceful shutdown.

**Exit Criteria**:

- [ ] Draining deployments auto-retire after timeout
- [ ] Timeout configurable via env var
- [ ] Monitor starts/stops cleanly with app lifecycle
- [ ] Integration test verifies auto-retirement

---

### Phase 5: Remaining Test Coverage (P1-P2)

**Goal**: Close all remaining test gaps identified in the Test Spec.

**Duration**: 2-3 days

#### 5.1 Variable Snapshot Cascade Delete Test

**Test Cases**:

1. Retire deployment -> verify associated snapshot deleted
2. Retire deployment with no snapshot -> no error
3. Force-retire -> snapshot deleted immediately

#### 5.2 Concurrent Deployment Conflict Test

**Test Cases**:

1. Two concurrent POST to same projectId+environment -> one 201, one 409
2. Retry logic on client side

#### 5.3 Compilation Output Caching Test

**Test Cases**:

1. Deploy -> verify `SessionService.cacheCompilationOutput()` called
2. Deploy -> verify `SessionService.cacheAgentIR()` called per agent
3. Cache failure -> deployment still succeeds

#### 5.4 Missing Env Var Warning Test

**Test Cases**:

1. DSL references `{{env.API_KEY}}`, no env var defined -> warning in response
2. DSL references `{{env.API_KEY}}`, env var defined -> no warning
3. No env var references -> no env var check

#### 5.5 Git Promotion Tests

**Test Cases**:

1. Valid promotion (main -> staging) -> success
2. Invalid branch name -> 400
3. Same source/target -> 400
4. Missing git integration -> 400
5. Credential resolution failure -> 500

**Exit Criteria**:

- [ ] All P0 test gaps closed
- [ ] All P1 test gaps closed
- [ ] `pnpm test --filter=runtime` passes with no regressions
- [ ] No test uses `vi.mock()` on codebase components in E2E test files

## 4. Wiring Checklist

| #   | Component                           | Wired To                  | Status    | Phase   |
| --- | ----------------------------------- | ------------------------- | --------- | ------- |
| 1   | Studio deployment API client        | Runtime deployment routes | NOT WIRED | Phase 2 |
| 2   | Studio proxy routes for deployments | Runtime API               | NOT WIRED | Phase 2 |
| 3   | DeploymentManager component         | Studio project layout     | NOT WIRED | Phase 2 |
| 4   | Navigation "Deployments" item       | Studio sidebar            | NOT WIRED | Phase 2 |
| 5   | Audit events                        | Deployment route handlers | NOT WIRED | Phase 3 |
| 6   | Draining monitor                    | Runtime startup/shutdown  | NOT WIRED | Phase 4 |
| 7   | SettingsVersionService tests        | CI pipeline               | NOT WIRED | Phase 1 |
| 8   | Cross-tenant E2E tests              | CI pipeline               | NOT WIRED | Phase 1 |

## 5. Risk Registry

| Risk                                               | Impact | Likelihood | Mitigation                                                      | Phase   |
| -------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------- | ------- |
| Studio deployment UI introduces new auth bugs      | P0     | Low        | Proxy routes follow established pattern; RBAC tested            | Phase 2 |
| Draining monitor misses deployments during restart | P1     | Medium     | On startup, check for stale draining deployments                | Phase 4 |
| Large deployment list causes slow Studio rendering | P2     | Low        | Pagination already implemented; add virtual scrolling if needed | Phase 2 |
| Audit log volume spikes during CI/CD               | P2     | Low        | Audit events are async fire-and-forget                          | Phase 3 |
| MongoMemoryServer flakiness in E2E tests           | P1     | Medium     | Use unique project/tenant IDs per test; cleanup in afterEach    | Phase 1 |

## 6. BETA Promotion Criteria

All of the following must be true:

- [ ] Phase 1 exit criteria met (test coverage gaps closed)
- [ ] Phase 2 exit criteria met (Studio deployment UI functional)
- [ ] Phase 3 exit criteria met (audit events emitted)
- [ ] Phase 4 exit criteria met (draining timeout automated)
- [ ] Phase 5 exit criteria met (remaining test gaps closed)
- [ ] No P0 or P1 bugs open
- [ ] `pnpm build` succeeds across all packages
- [ ] `pnpm test` passes across all packages (excluding known pre-existing failures)
- [ ] Feature spec status updated to BETA
- [ ] Test spec coverage matrix updated

## 7. File Change Summary

### New Files

| File                                                                                 | Phase | Purpose                       |
| ------------------------------------------------------------------------------------ | ----- | ----------------------------- |
| `apps/runtime/src/__tests__/settings-version-service.test.ts`                        | 1     | SettingsVersionService tests  |
| `apps/runtime/src/__tests__/deployment-tenant-isolation-e2e.test.ts`                 | 1     | Cross-tenant E2E              |
| `apps/runtime/src/__tests__/version-service-unit.test.ts`                            | 1     | sourceHash + retry unit tests |
| `apps/studio/src/api/deployments.ts`                                                 | 2     | Deployment API client         |
| `apps/studio/src/app/api/projects/[id]/deployments/route.ts`                         | 2     | List + Create proxy           |
| `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/route.ts`          | 2     | Get detail proxy              |
| `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/retire/route.ts`   | 2     | Retire proxy                  |
| `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/rollback/route.ts` | 2     | Rollback proxy                |
| `apps/studio/src/app/api/projects/[id]/deployments/[deploymentId]/promote/route.ts`  | 2     | Promote proxy                 |
| `apps/studio/src/components/deployments/DeploymentManager.tsx`                       | 2     | Main deployment UI            |
| `apps/studio/src/components/deployments/DeploymentCard.tsx`                          | 2     | Deployment card component     |
| `apps/studio/src/components/deployments/CreateDeploymentDialog.tsx`                  | 2     | Create dialog                 |
| `apps/studio/src/components/deployments/DeploymentDetailPanel.tsx`                   | 2     | Detail view                   |
| `apps/studio/src/hooks/useDeployments.ts`                                            | 2     | SWR hook for deployments      |
| `apps/runtime/src/services/deployment-draining-monitor.ts`                           | 4     | Draining timeout worker       |

### Modified Files

| File                                         | Phase | Changes                        |
| -------------------------------------------- | ----- | ------------------------------ |
| `apps/studio/src/config/navigation.ts`       | 2     | Add Deployments nav item       |
| `apps/runtime/src/services/audit-helpers.ts` | 3     | Add deployment audit functions |
| `apps/runtime/src/routes/deployments.ts`     | 3     | Wire audit calls               |
| `apps/runtime/src/index.ts`                  | 4     | Start/stop draining monitor    |
| `docs/features/deployments-versioning.md`    | All   | Update status to BETA          |
| `docs/testing/deployments-versioning.md`     | 5     | Update coverage matrix         |

## 8. Dependency Graph

```
Phase 1 (Tests) ──────────┐
                           │
Phase 2 (Studio UI) ──────┤──> Phase 5 (Remaining Tests)
                           │
Phase 3 (Audit Logs) ─────┤
                           │
Phase 4 (Draining) ────────┘
```

Phases 1-4 can be parallelized. Phase 5 depends on all prior phases being complete (tests cover features from phases 2-4).
