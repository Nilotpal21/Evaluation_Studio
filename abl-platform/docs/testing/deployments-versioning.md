# Test Spec: Deployments & Versioning

**Feature Slug:** `deployments-versioning`
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Test Strategy Overview

The deployments-versioning feature spans multiple layers: database models, repository functions, service classes, Express routes, and Studio proxy routes. Testing follows a layered approach:

- **E2E Tests**: Full HTTP API round-trips through real Express middleware chains (auth, rate limiting, tenant isolation, project scope). No mocking of codebase components.
- **Integration Tests**: Service-level tests with real MongoDB (MongoMemoryServer) exercising version lifecycle, deployment creation, and snapshot operations.
- **Unit Tests**: Pure function tests for helpers (sourceHash computation, semver increment, snapshot diff, status transition validation).
- **Authorization Tests**: RBAC permission matrix validation for deployment and version endpoints.

## 2. Coverage Matrix

### 2.1 Agent Version Lifecycle

| Scenario                                                   | Type        | Priority | Status                            |
| ---------------------------------------------------------- | ----------- | -------- | --------------------------------- |
| Create version with valid DSL compiles and persists        | Integration | P0       | EXISTS (`version-routes.test.ts`) |
| Create version with invalid DSL returns compileErrors      | Integration | P0       | EXISTS                            |
| Create version deduplicates on same sourceHash             | Integration | P0       | EXISTS                            |
| Semver auto-increment from existing versions               | Unit        | P0       | EXISTS                            |
| Promote draft -> testing -> staged -> active -> deprecated | Integration | P0       | EXISTS                            |
| Reject invalid status transition (e.g., draft -> active)   | Integration | P0       | EXISTS                            |
| Optimistic lock conflict returns 422                       | Integration | P1       | EXISTS                            |
| List versions with pagination                              | Integration | P1       | EXISTS                            |
| Diff two versions returns both DSL contents                | Integration | P2       | EXISTS                            |
| Tool snapshot captured at version creation                 | Integration | P1       | PARTIAL                           |
| Config variable inclusion in sourceHash                    | Unit        | P1       | NOT TESTED                        |

### 2.2 Deployment Management

| Scenario                                          | Type        | Priority | Status                                  |
| ------------------------------------------------- | ----------- | -------- | --------------------------------------- |
| Create deployment with valid manifest             | Integration | P0       | EXISTS (`deployment-routes.test.ts`)    |
| Create deployment retires previous active         | Integration | P0       | EXISTS                                  |
| Create deployment with auto-versioning            | Integration | P0       | EXISTS                                  |
| Create deployment runs preflight validation       | Integration | P1       | PARTIAL                                 |
| Create deployment with force=true skips preflight | Integration | P1       | PARTIAL                                 |
| List deployments with environment/status filters  | Integration | P0       | EXISTS                                  |
| Get deployment detail includes channel count      | Integration | P1       | EXISTS                                  |
| Retire active deployment transitions to draining  | Integration | P0       | EXISTS                                  |
| Retire draining deployment transitions to retired | Integration | P0       | EXISTS                                  |
| Force-retire skips draining                       | Integration | P1       | EXISTS                                  |
| Retire cascades-deletes variable snapshot         | Integration | P1       | NOT TESTED                              |
| Rollback to previous deployment                   | Integration | P0       | EXISTS                                  |
| Promote deployment across environments            | Integration | P0       | EXISTS (`deployment-promotion.test.ts`) |
| Promote rejects same environment                  | Integration | P1       | EXISTS                                  |
| Promote rejects retired source                    | Integration | P1       | EXISTS                                  |
| Concurrent deployment to same env returns 409     | Integration | P1       | NOT TESTED                              |
| Channel auto-follow updates on new deployment     | Integration | P1       | EXISTS                                  |
| Compilation output cached at deployment time      | Integration | P1       | NOT TESTED                              |
| Missing env var references generate warnings      | Integration | P2       | NOT TESTED                              |

### 2.3 Settings Version Lifecycle

| Scenario                                          | Type        | Priority | Status     |
| ------------------------------------------------- | ----------- | -------- | ---------- |
| Create settings version from working copy         | Integration | P0       | NOT TESTED |
| Settings version deduplication on same sourceHash | Integration | P1       | NOT TESTED |
| Promote settings version through lifecycle        | Integration | P0       | NOT TESTED |
| List settings versions with pagination            | Integration | P1       | NOT TESTED |

### 2.4 Workflow Version Lifecycle

| Scenario                                          | Type        | Priority | Status                                     |
| ------------------------------------------------- | ----------- | -------- | ------------------------------------------ |
| Create workflow version from working copy         | Integration | P0       | EXISTS (`workflow-version-routes.test.ts`) |
| Workflow version deduplication on same sourceHash | Integration | P1       | EXISTS                                     |
| Promote workflow version through lifecycle        | Integration | P0       | EXISTS                                     |
| Reject invalid status transitions                 | Integration | P1       | EXISTS                                     |
| Definition size limit enforced                    | Integration | P2       | NOT TESTED                                 |

### 2.5 Deployment Variable Snapshots

| Scenario                                          | Type        | Priority | Status                              |
| ------------------------------------------------- | ----------- | -------- | ----------------------------------- |
| Create snapshot captures env vars and config vars | Integration | P0       | EXISTS (`snapshot-service.test.ts`) |
| Snapshot stores raw ciphertext (not decrypted)    | Integration | P0       | EXISTS                              |
| Snapshot deduplicates namespace membership        | Integration | P1       | EXISTS                              |
| Compute diff between two snapshots                | Unit        | P1       | EXISTS                              |
| Environment-specific override wins over base var  | Integration | P1       | NOT TESTED                          |

### 2.6 Authorization & Isolation

| Scenario                                        | Type | Priority | Status                               |
| ----------------------------------------------- | ---- | -------- | ------------------------------------ |
| deployment:create requires admin role           | E2E  | P0       | EXISTS (`deployments-authz.test.ts`) |
| deployment:read allowed for all project members | E2E  | P0       | EXISTS                               |
| deployment:retire requires admin role           | E2E  | P0       | EXISTS                               |
| version:create requires developer role          | E2E  | P0       | EXISTS (`versions-authz.test.ts`)    |
| version:read allowed for all project members    | E2E  | P0       | EXISTS                               |
| version:promote requires developer role         | E2E  | P0       | EXISTS                               |
| Cross-tenant access returns 404                 | E2E  | P0       | NOT TESTED                           |
| Cross-project access returns 404                | E2E  | P0       | NOT TESTED                           |

### 2.7 Git-Based Promotion

| Scenario                            | Type        | Priority | Status     |
| ----------------------------------- | ----------- | -------- | ---------- |
| Promote main -> staging creates PR  | Integration | P1       | NOT TESTED |
| Reject invalid branch names         | Unit        | P1       | NOT TESTED |
| Reject same source/target branch    | Unit        | P1       | NOT TESTED |
| Missing git integration returns 400 | Integration | P1       | NOT TESTED |

## 3. E2E Test Scenarios (Minimum 5)

E2E tests exercise the real system through HTTP API with full middleware chain. No mocking of codebase components. Real Express server on random port.

### E2E-1: Full Deployment Lifecycle

**Description**: Create agent version, deploy to dev, verify active, retire with draining, verify retired.

**Steps**:

1. POST `/api/projects/:projectId/agents/:agentName/versions` with valid DSL
2. Verify 201, version created with status "draft"
3. POST `/api/projects/:projectId/agents/:agentName/versions/:version/promote` to "active"
4. POST `/api/projects/:projectId/deployments` with the active version
5. Verify 201, deployment created with status "active", endpoint slug generated
6. GET `/api/projects/:projectId/deployments` verify deployment listed
7. GET `/api/projects/:projectId/deployments/:id` verify detail with channel count
8. POST `/api/projects/:projectId/deployments/:id/retire` (no force)
9. Verify deployment transitions to "draining"
10. POST `/api/projects/:projectId/deployments/:id/retire` again
11. Verify deployment transitions to "retired"

**Assertions**: Status transitions correct, endpointSlug unique, previousDeploymentId chain correct.

### E2E-2: Rollback Flow

**Description**: Deploy v1, deploy v2 (retires v1), rollback to v1, verify v1 manifest restored.

**Steps**:

1. Create agent version v0.1.0, deploy to staging
2. Create agent version v0.1.1, deploy to staging (auto-retires v0.1.0 deployment)
3. GET `/api/projects/:projectId/deployments` verify v0.1.1 active, v0.1.0 retired
4. POST `/api/projects/:projectId/deployments/:v2DeploymentId/rollback`
5. Verify new deployment created with v0.1.0 manifest, previous v0.1.1 deployment retired

**Assertions**: Rollback creates new deployment (not status revert), manifest matches v1.

### E2E-3: Cross-Environment Promotion

**Description**: Deploy to dev, promote to staging, verify independent deployments in each env.

**Steps**:

1. Create agent version, deploy to "dev"
2. POST `/api/projects/:projectId/deployments/:devDeploymentId/promote` with `{ targetEnvironment: "staging" }`
3. Verify new staging deployment created with same manifest
4. GET deployments filtered by environment="dev" -- 1 active
5. GET deployments filtered by environment="staging" -- 1 active
6. Verify staging deployment has `promotedFromDeploymentId` = dev deployment id

**Assertions**: Both environments have independent active deployments, promotion link correct.

### E2E-4: Auto-Versioning on Deploy

**Description**: Deploy with `"auto"` version manifest, verify version auto-created from working copy.

**Steps**:

1. Create a project agent with DSL content (working copy)
2. POST `/api/projects/:projectId/deployments` with `agentVersionManifest: { myAgent: "auto" }`
3. Verify 201, deployment created
4. GET `/api/projects/:projectId/agents/myAgent/versions` verify a version was auto-created
5. Verify auto-created version has changelog "Auto-created for deployment"
6. Verify deployment manifest has the auto-created version string (not "auto")

**Assertions**: Auto-versioning transparent, version created with proper changelog, deployment manifest resolved.

### E2E-5: Tenant Isolation

**Description**: Verify tenant A cannot access tenant B's deployments or versions.

**Steps**:

1. As tenant A: create version, create deployment
2. As tenant B: GET `/api/projects/:projectId/deployments` returns empty (or 404)
3. As tenant B: GET `/api/projects/:projectId/deployments/:tenantADeploymentId` returns 404
4. As tenant B: POST `/api/projects/:projectId/deployments/:tenantADeploymentId/retire` returns 404
5. As tenant A: verify their deployment is still active (not affected by tenant B's operations)

**Assertions**: Cross-tenant returns 404 (not 403), no data leakage.

### E2E-6: Preflight Validation Gate

**Description**: Deploy with preflight errors blocks unless force=true.

**Steps**:

1. Create an agent version with configuration that triggers preflight warnings/errors
2. POST `/api/projects/:projectId/deployments` without force
3. If preflight errors: verify 422 with `preflightReport`
4. POST `/api/projects/:projectId/deployments` with `force: true`
5. Verify 201, deployment created despite preflight errors

**Assertions**: Preflight gate enforced, force=true overrides, preflightReport included in response.

### E2E-7: RBAC Permission Enforcement

**Description**: Verify deployment operations enforce correct RBAC permissions.

**Steps**:

1. As project viewer: POST create deployment -- verify 403
2. As project viewer: GET list deployments -- verify 200
3. As project developer: POST create version -- verify 201
4. As project developer: POST create deployment -- verify 403 (only admin)
5. As project admin: POST create deployment -- verify 201
6. As project admin: POST retire deployment -- verify 200

**Assertions**: Permission matrix enforced per role.

## 4. Integration Test Scenarios (Minimum 5)

Integration tests exercise service internals with real MongoDB (MongoMemoryServer) but may mock external dependencies (compiler, LLM).

### INT-1: Version Service Lifecycle

**Description**: Test VersionService create, dedup, promote, and nextVersion with real MongoDB.

**Setup**: MongoMemoryServer, seed ProjectAgent record.

**Steps**:

1. `versionService.createVersion()` with valid DSL -- verify record created with status "draft"
2. `versionService.createVersion()` with same DSL -- verify deduplication (same sourceHash)
3. `versionService.promoteVersion()` draft -> testing -- verify status updated
4. `versionService.promoteVersion()` testing -> staged -> active -- verify chain
5. `versionService.promoteVersion()` active -> deprecated -- verify terminal
6. `versionService.promoteVersion()` deprecated -> anything -- verify rejection
7. `versionService.nextVersion()` -- verify semver increment
8. `versionService.listVersions()` -- verify pagination and ordering

**Assertions**: All lifecycle states reachable via valid transitions, invalid transitions rejected.

### INT-2: Deployment Creation with Variable Snapshot

**Description**: Test deployment creation flow including variable snapshot creation.

**Setup**: MongoMemoryServer, seed Project, ProjectAgent, AgentVersion, EnvironmentVariable, ProjectConfigVariable records.

**Steps**:

1. Create deployment via repo function
2. Call `createDeploymentSnapshot()` for the deployment
3. Verify snapshot contains env vars (raw ciphertext) and config vars (plaintext)
4. Verify snapshot hash computed correctly
5. Verify snapshot linked to deployment via `variableSnapshotId`

**Assertions**: Snapshot immutable, ciphertext preserved, namespace memberships denormalized.

### INT-3: Settings Version Service

**Description**: Test SettingsVersionService create, dedup, promote with real MongoDB.

**Setup**: MongoMemoryServer, seed Project with settings.

**Steps**:

1. `settingsVersionService.createVersion()` -- verify record created
2. `settingsVersionService.createVersion()` again without changes -- verify dedup
3. `settingsVersionService.promoteVersion()` through lifecycle
4. `settingsVersionService.listVersions()` -- verify ordering
5. Verify optimistic lock conflict handling

**Assertions**: Settings captured from working copy, dedup works, lifecycle valid.

### INT-4: Workflow Version Service

**Description**: Test WorkflowVersionService create, dedup, promote with real MongoDB.

**Setup**: MongoMemoryServer, seed Workflow record.

**Steps**:

1. `workflowVersionService.createVersion()` -- verify definition snapshot
2. Verify sourceHash uses canonical JSON (key-sorted)
3. `workflowVersionService.promoteVersion()` through lifecycle
4. `workflowVersionService.diffVersions()` -- verify both versions returned
5. Verify definition size limit enforcement

**Assertions**: Definition captured from working copy, canonical hash stable, diff returns both.

### INT-5: Deployment Repo Tenant Isolation

**Description**: Test that deployment repo functions enforce tenant isolation at query level.

**Setup**: MongoMemoryServer, create deployments for two different tenants.

**Steps**:

1. Create deployment for tenant A in project P1
2. Create deployment for tenant B in project P2
3. `findDeploymentById(deploymentId, projectId, tenantA)` -- verify found
4. `findDeploymentById(deploymentId, projectId, tenantB)` -- verify null (not found)
5. `listDeployments(projectId, tenantA)` -- verify only tenant A's deployments
6. `findActiveDeployment(projectId, tenantA)` -- verify isolation
7. `retirePreviousActiveDeployment(projectId, tenantB)` -- verify no effect on tenant A

**Assertions**: Every query scoped by tenantId, cross-tenant returns null/empty.

### INT-6: Snapshot Diff Computation

**Description**: Test `computeSnapshotDiff()` pure function with various scenarios.

**Steps**:

1. Compute diff with identical snapshots -- verify no changes
2. Add new env var to target -- verify in `added`
3. Remove env var from target -- verify in `removed`
4. Change env var value -- verify in `changed` with `valueChanged: true`
5. Same for config vars
6. Mixed changes (add + remove + change) in single diff

**Assertions**: Diff correctly categorizes all change types.

### INT-7: Concurrent Version Creation Retry

**Description**: Test that version creation retries on duplicate key collision.

**Setup**: MongoMemoryServer, seed with existing version.

**Steps**:

1. Force a duplicate key collision by pre-creating a version with the expected next version number
2. Call `versionService.createVersion()` -- should retry with incremented version
3. Verify version created with retried version number
4. Verify retry logged

**Assertions**: Retry handles E11000 gracefully, up to MAX_DUPLICATE_KEY_RETRIES.

## 5. Unit Test Scenarios

### UNIT-1: sourceHash Computation

- DSL-only hash matches expected SHA-256 prefix
- DSL + config vars produces different hash than DSL alone
- Config var ordering is deterministic (sorted keys)

### UNIT-2: Semver Auto-Increment

- Empty version list returns "0.1.0"
- `["0.1.0", "0.1.1"]` returns "0.1.2"
- Non-semver strings are skipped
- Highest version found regardless of order

### UNIT-3: Status Transition Validation

- All valid transitions accepted
- All invalid transitions rejected
- `isValidStatus()` rejects non-enum values

### UNIT-4: Endpoint Slug Generation

- Contains projectId prefix (first 8 chars)
- Contains environment name
- Has timestamp and random components
- Two calls produce different slugs

### UNIT-5: Deep Sort Keys (Workflow Hash)

- Objects sorted by key at all nesting levels
- Arrays preserved in order
- Primitive values unchanged

## 6. Test Infrastructure Requirements

### For E2E Tests

- Real Express server started on `{ port: 0 }`
- Full middleware chain: `authMiddleware` -> `requireProjectScope` -> `tenantRateLimit` -> route handler
- Seed data via HTTP API (POST endpoints), not direct DB access
- Test users with different roles (admin, developer, viewer)
- Separate tenant contexts for isolation tests

### For Integration Tests

- MongoMemoryServer for isolated MongoDB instance
- Real Mongoose models (no mocking database layer)
- May mock external services (compiler for version creation if DSL parsing is too slow)
- Cleanup between tests (drop collections or use unique project/tenant IDs)

### For Unit Tests

- No external dependencies
- Pure function testing
- Fast execution (< 1ms per test)

## 7. Existing Test Files

| File                                                                         | Type                       | Coverage                                           |
| ---------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| `apps/runtime/src/__tests__/deployment-routes.test.ts`                       | Integration (mocked repos) | Create, list, get, retire, rollback                |
| `apps/runtime/src/__tests__/deployments-authz.test.ts`                       | RBAC                       | Permission matrix for all deployment endpoints     |
| `apps/runtime/src/__tests__/deployment-promotion.test.ts`                    | Integration (mocked repos) | Cross-environment promotion                        |
| `apps/runtime/src/__tests__/deployment-pipeline.e2e.test.ts`                 | E2E (with real LLM)        | Full pipeline: DSL -> compile -> deploy -> session |
| `apps/runtime/src/__tests__/deployment-resolver.test.ts`                     | Unit                       | Deployment resolution logic                        |
| `apps/runtime/src/__tests__/version-routes.test.ts`                          | Integration (mocked repos) | Version CRUD and promotion                         |
| `apps/runtime/src/__tests__/versions-authz.test.ts`                          | RBAC                       | Permission matrix for version endpoints            |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`                 | Integration                | Workflow version CRUD                              |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`                | Integration                | Workflow version service                           |
| `apps/runtime/src/__tests__/services/snapshot-service.test.ts`               | Integration                | Snapshot creation and diff                         |
| `packages/database/src/__tests__/model-deployment-workflow-manifest.test.ts` | Unit                       | Model serialization                                |

## 8. Gaps & Priorities

### High Priority (Must Test Before BETA)

1. **Cross-tenant E2E isolation** -- Existing authz tests mock repos; need real DB verification
2. **Settings version lifecycle** -- No tests exist for SettingsVersionService
3. **Concurrent deployment conflict (409)** -- E11000 handling untested at route level
4. **Variable snapshot cascade delete** -- Retirement should clean up snapshots
5. **Config variable inclusion in sourceHash** -- Dedup with config vars untested

### Medium Priority

6. Compilation output caching at deployment time
7. Missing env var reference warnings
8. Environment-specific variable override in snapshots
9. Git-based branch promotion
10. Deployment creation with workflow version manifest validation

### Low Priority

11. Definition size limit for workflow versions
12. Changelog size limit validation
13. DSL size limit validation at route level
