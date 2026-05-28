# Test Specification: Workflow Versioning & Version-Aware Triggers

**Feature Spec**: `docs/features/sub-features/workflow-versioning.md`
**HLD**: `docs/specs/workflow-versioning.hld.md`
**LLD**: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md`
**Prior Design**: `docs/plans/2026-03-09-workflow-versioning-deployment-design.md` (superseded by feature spec)
**Status**: PARTIAL
**Last Updated**: 2026-04-16

---

## 1. Coverage Matrix

| FR    | Requirement                                          | Unit | Integration | E2E  | Manual | Status   |
| ----- | ---------------------------------------------------- | ---- | ----------- | ---- | ------ | -------- |
| FR-1  | Workflow as thin container                           | ✅   |             | ✅   |        | TESTED   |
| FR-2  | Atomic draft version creation                        | ✅   |             | ✅   |        | TESTED   |
| FR-3  | Exactly one draft per workflow                       | ✅   |             | ✅   |        | TESTED   |
| FR-4  | Draft always active                                  | ✅   |             | ✅   |        | TESTED   |
| FR-5  | Draft fully mutable                                  | ✅   |             | ✅   |        | TESTED   |
| FR-6  | Published version active/inactive states             | ✅   |             | ✅   |        | TESTED   |
| FR-7  | Published version frozen flow, mutable cron/event    | ✅   |             | ✅   |        | TESTED   |
| FR-8  | One trigger per version (independent registrations)  |      |             | ✅   |        | TESTED   |
| FR-9  | Activate registers triggers                          |      |             | ✅   |        | TESTED   |
| FR-10 | Deactivate deregisters triggers                      |      |             | ✅   |        | TESTED   |
| FR-11 | In-flight executions survive deactivation            |      | PLAN        |      |        | DEFERRED |
| FR-12 | Soft delete cascade                                  |      |             | ✅   |        | TESTED   |
| FR-13 | Per-trigger toggle on/off                            |      | PLAN        |      |        | DEFERRED |
| FR-14 | Default version resolution                           | ✅   |             | ✅   |        | TESTED   |
| FR-15 | Deploy via Operate > Deployments                     |      |             | ✅   |        | TESTED   |
| FR-16 | Auto mode snapshots draft version                    |      |             | ✅   |        | TESTED   |
| FR-17 | Environment-scoped event routing                     | ✅   | ✅          |      |        | TESTED   |
| FR-18 | Cron fires version's frozen flow                     |      | ✅          |      |        | TESTED   |
| FR-19 | Direct trigger-to-version binding (no deploy lookup) |      | ✅          | ✅   |        | TESTED   |
| FR-20 | Versions tab in Studio                               |      |             | PLAN | PLAN   | PARTIAL  |

### Actual Test File Mapping

| File                                                                                 | Versioning Tests | Type        | Covers                                                                                                                                                             | Status    |
| ------------------------------------------------------------------------------------ | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `apps/runtime/src/__tests__/workflow-versioning.e2e.test.ts`                         | 10               | e2e         | E2E-1, E2E-3, E2E-4, E2E-5, E2E-9, E2E-10, E2E-11, isolation                                                                                                       | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-triggers.e2e.test.ts`                   | 4                | e2e         | E2E-2, E2E-7, E2E-8, multi-active                                                                                                                                  | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-deployment.e2e.test.ts`                 | 2                | e2e         | E2E-6, snapshot, pagination                                                                                                                                        | PASSING   |
| `packages/shared/src/tools/__tests__/validate-workflow-tool-binding-version.test.ts` | 8                | integration | INT-11, version-aware binding, tenantId/projectId                                                                                                                  | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`                        | 23               | unit        | Service methods (create, activate, deactivate, soft-delete, diff, listVersions)                                                                                    | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`                         | 26               | integration | Route-level integration: createVersion, activate, deactivate, softDelete, validateMutableFields, listVersions, getVersion, getOrCreateDraft, resolveDefaultVersion | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-lifecycle.test.ts`                      | 3                | unit        | State transitions, draft guard                                                                                                                                     | PASSING   |
| `apps/runtime/src/__tests__/workflow-version-resolution.test.ts`                     | 8                | unit        | Default version resolution                                                                                                                                         | PASSING   |
| `packages/database/src/__tests__/model-workflow-version.test.ts`                     | 10               | unit        | Schema validation, indexes                                                                                                                                         | UPDATED   |
| `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts`                 | 8                | integration | Version-aware trigger fire                                                                                                                                         | REWRITTEN |
| `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`                     | 5                | integration | FR-17 partial: environment storage on registration                                                                                                                 | EXTENDED  |
| `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`                          | 4                | unit        | GAP-004 jobData version/env threading                                                                                                                              | NEW       |
| `packages/connectors/src/__tests__/cron-scheduler.test.ts`                           | 4                | unit        | GAP-001 cron version fields in jobData/startWorkflow                                                                                                               | NEW       |
| `packages/connectors/src/__tests__/polling-scheduler.test.ts`                        | 4                | unit        | GAP-001 polling version fields in jobData/startWorkflow                                                                                                            | NEW       |
| `packages/connectors/src/__tests__/webhook-handler.test.ts`                          | 2                | unit        | GAP-001 webhook workflowVersionId in startWorkflow                                                                                                                 | NEW       |
| `apps/workflow-engine/src/__tests__/trigger-version-frozen-flow.test.ts`             | 8                | integration | GAP-011 processJob + GAP-012 VERSION_INACTIVE guard                                                                                                                | NEW       |

**All new tests follow CLAUDE.md test architecture rules** — no `vi.mock` of internal packages. E2E tests use real Express servers with full middleware chain via `startRuntimeServerHarness()`. Integration tests use DI test doubles (no `vi.mock`).

---

## 2. E2E Test Scenarios

> CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. All tests require real Express servers with full middleware chain (auth, RBAC, tenant isolation, validation).

### E2E-1: Full Version Lifecycle (Create → Edit → Deploy → Execute Frozen Flow)

- **Preconditions**: Authenticated user with `workflow:write` and `deployment:create` permissions. Project and tenant exist.
- **Auth Context**: JWT token with `tenantId`, `projectId`, `userId`.
- **Steps**:
  1. `POST /api/projects/:projectId/workflows` with `{ name: "e2e-lifecycle", description: "test" }` → 201. Capture `workflowId`.
  2. `GET /api/projects/:projectId/workflows/:workflowId` → 200. Assert response has NO `status`, `nodes`, `edges` fields on the workflow. Assert `draftVersion` is included with `version: "draft"`, `state: "active"`.
  3. `PATCH /api/projects/:projectId/workflows/:workflowId/versions/draft` with `{ definition: { nodes: [startNode, httpNodeA, endNode], edges: [...] } }` → 200.
  4. `POST /api/projects/:projectId/deployments` with `{ workflowVersionManifest: { "e2e-lifecycle": "auto" }, environment: "production" }` → 201. Capture deployed version name (e.g., `"v0.1.0"`).
  5. `GET /api/projects/:projectId/workflows/:workflowId/versions` → 200. Assert array contains `"draft"` and the deployed version. Assert deployed version has `state: "active"`, `publishedAt` is set, `definition.nodes` matches step 3.
  6. `PATCH /api/projects/:projectId/workflows/:workflowId/versions/draft` with modified nodes (change httpNodeA URL to different endpoint) → 200.
  7. `POST /api/v1/process/:workflowId?version=v0.1.0` → Execute. Assert execution used the **original** frozen flow (httpNodeA with original URL), NOT the modified draft.
- **Expected Result**: Published version's flow is immutable and used for execution regardless of subsequent draft edits.
- **Isolation Check**: Repeat step 2 with a different tenant's auth token → 404.
- **Covers**: FR-1, FR-2, FR-5, FR-7, FR-15, FR-16

### E2E-2: Version Activate/Deactivate with Trigger Registration

- **Preconditions**: Workflow exists with cron trigger definition on draft. Published version deployed.
- **Auth Context**: JWT token with `tenantId=T1`, `projectId=P1`, `userId=U1`, permission: `workflow:write`.
- **Steps**:
  1. `POST /api/projects/:projectId/workflows` with `{ name: "e2e-triggers" }` → 201.
  2. `PATCH /api/projects/:projectId/workflows/:workflowId/versions/draft` with `{ triggers: [{ type: "cron", config: { expression: "0 */5 * * * *" } }], definition: { nodes: [...], edges: [...] } }` → 200.
  3. `POST /api/projects/:projectId/deployments` with `{ workflowVersionManifest: { "e2e-triggers": "auto" }, environment: "staging" }` → 201. Capture version name.
  4. `POST /api/projects/:projectId/workflows/:workflowId/versions/:version/activate` → 200. Assert response includes `state: "active"`.
  5. `GET /api/projects/:projectId/workflows/:workflowId/versions/:version` → 200. Assert `state: "active"`. Verify trigger registrations exist by querying the trigger list endpoint.
  6. `POST /api/projects/:projectId/workflows/:workflowId/versions/:version/deactivate` → 200. Assert response includes `state: "inactive"`.
  7. `GET /api/projects/:projectId/workflows/:workflowId/versions/:version` → 200. Assert `state: "inactive"`. Verify trigger registrations are deregistered.
  8. `POST /api/projects/:projectId/workflows/:workflowId/versions/:version/activate` → 200 (re-activate). Assert triggers re-registered.
  9. `GET /api/projects/:projectId/workflows/:workflowId/versions/draft` → Assert draft triggers remain unchanged throughout.
- **Expected Result**: Activate registers triggers, deactivate deregisters, re-activate re-registers. Draft is unaffected.
- **Covers**: FR-6, FR-8, FR-9, FR-10

### E2E-3: Soft Delete Cascade

- **Preconditions**: Workflow with draft + 2 published versions, each with cron triggers.
- **Auth Context**: JWT token with `tenantId=T1`, `projectId=P1`, `userId=U1`, permission: `workflow:delete`.
- **Steps**:
  1. `POST /api/projects/:projectId/workflows` → create workflow. Capture `workflowId`.
  2. Add cron trigger to draft version.
  3. Deploy v1.0 via `POST /api/projects/:projectId/deployments`, activate it.
  4. Deploy v2.0 via `POST /api/projects/:projectId/deployments`, activate it.
  5. `DELETE /api/projects/:projectId/workflows/:workflowId` → 200.
  6. `GET /api/projects/:projectId/workflows/:workflowId` → 404 (soft deleted, excluded from default queries).
  7. `GET /api/projects/:projectId/workflows/:workflowId/versions` → 404 (parent deleted).
  8. `POST /api/v1/process/:workflowId` → 404 (deleted workflow cannot execute).
  9. `DELETE /api/projects/:projectId/workflows/:workflowId` → 200 (idempotent re-delete).
- **Expected Result**: All versions marked deleted, all triggers deregistered, workflow inaccessible, re-delete is idempotent.
- **Isolation Check**: Verify a different workflow in the same project is unaffected.
- **Covers**: FR-12

### E2E-4: Default Version Resolution via Process API

- **Preconditions**: Workflow exists with draft and 2 published versions.
- **Auth Context**: API key auth (external caller pattern) with `tenantId` and `projectId`.
- **Steps**:
  1. Create workflow with draft flow containing `{ output: "draft" }` in end node output mapping.
  2. Deploy v1.0 with flow containing `{ output: "v1" }`, activate it.
  3. Deploy v2.0 with flow containing `{ output: "v2" }`, activate it.
  4. `POST /api/v1/process/:workflowId` (no version param) → Assert output is `"v2"` (latest active by `publishedAt`).
  5. `POST /api/v1/process/:workflowId?version=v1.0` → Assert output is `"v1"` (explicit version).
  6. Deactivate v2.0.
  7. `POST /api/v1/process/:workflowId` (no version) → Assert output is `"v1"` (v2 inactive, falls back to v1).
  8. Deactivate v1.0.
  9. `POST /api/v1/process/:workflowId` (no version) → Assert output is `"draft"` (no active published, fallback to draft).
  10. `POST /api/v1/process/:workflowId?version=v1.0` → 404 (v1 is inactive, explicit version must be active).
  11. `POST /api/v1/process/:workflowId?version=nonexistent` → 404.
- **Expected Result**: Resolution chain: latest active published → earlier active published → draft fallback. Explicit version must be active or 404.
- **Covers**: FR-14

### E2E-5: Cross-Tenant and Cross-Project Isolation for Versions

- **Preconditions**: Two tenants (A, B) with separate projects. Workflow exists in tenant-A/project-A.
- **Auth Context**: Separate JWT tokens for tenant-A and tenant-B.
- **Steps**:
  1. As tenant-A: `POST /api/projects/:projectIdA/workflows` → create workflow, deploy v1.0, activate.
  2. As tenant-B: `GET /api/projects/:projectIdA/workflows/:workflowId/versions` → 404.
  3. As tenant-B: `POST /api/projects/:projectIdA/workflows/:workflowId/versions/v1.0/activate` → 404.
  4. As tenant-B: `POST /api/v1/process/:workflowId` → 404.
  5. As tenant-A but project-B: `GET /api/projects/:projectIdB/workflows/:workflowId/versions` → 404.
  6. As tenant-A but project-B: `POST /api/projects/:projectIdB/workflows/:workflowId/versions/v1.0/deactivate` → 404.
  7. As tenant-A/project-A: all operations succeed normally (sanity check).
- **Expected Result**: All cross-scope access returns 404 (not 403, not empty list). Same-scope access works.
- **Covers**: Feature spec Section 12.1 (Isolation)

### E2E-6: Deploy Workflow Version via Operate > Deployments

- **Preconditions**: Workflow with draft flow. User with `deployment:create` permission.
- **Auth Context**: JWT token with `tenantId=T1`, `projectId=P1`, `userId=U1`, permissions: `workflow:write`, `deployment:create`.
- **Steps**:
  1. Create workflow and set up draft with nodes/edges and cron trigger.
  2. `POST /api/projects/:projectId/deployments` with `{ workflowVersionManifest: { "wf-name": "auto" }, environment: "production" }` → 201. Capture version name.
  3. `GET /api/projects/:projectId/workflows/:workflowId/versions/:version` → 200. Assert `environment: "production"`, `state: "active"`, `publishedAt` is set, `publishedBy` is the authenticated user.
  4. Assert `definition.nodes` matches draft's nodes at time of deployment (frozen snapshot).
  5. Assert `triggers` array matches draft's trigger definitions (frozen for webhook, mutable for cron).
  6. `POST /api/projects/:projectId/deployments` with explicit version name: `{ workflowVersionManifest: { "wf-name": "v2.0" }, environment: "staging" }` → 201.
  7. `GET /api/projects/:projectId/workflows/:workflowId/versions` → Assert draft + 2 published versions exist.
  8. Attempt deployment without `deployment:create` permission → 403.
- **Expected Result**: Deployment creates frozen published version from draft snapshot. Both auto and explicit naming work. RBAC enforced.
- **Covers**: FR-15, FR-16

### E2E-7: Cron Trigger Fires Version's Frozen Flow (Not Draft)

- **Preconditions**: Workflow with HTTP node in draft. Published version v1.0 with cron trigger.
- **Auth Context**: System/internal auth for trigger fire path.
- **Steps**:
  1. Create workflow with HTTP node pointing to mock external endpoint A.
  2. Deploy v1.0, activate it with cron trigger.
  3. Modify draft's HTTP node to point to mock external endpoint B.
  4. Simulate cron trigger fire for v1.0 (via TriggerScheduler processing or wait for scheduled fire).
  5. Assert execution called endpoint A (v1.0's frozen flow), NOT endpoint B (draft's modified flow).
  6. Assert execution metadata includes `workflowVersion: "v1.0"`.
- **Expected Result**: Cron fires the version's frozen flow, not the current draft.
- **Covers**: FR-18, FR-19

### E2E-8: Per-Trigger Toggle and Published Version Toggle Block

- **Preconditions**: Workflow with cron trigger on draft and on an active published version. One inactive published version.
- **Auth Context**: JWT token with `tenantId=T1`, `projectId=P1`, `userId=U1`, permission: `workflow:write`.
- **Steps**:
  1. Create workflow with cron trigger on draft, toggle it ON. Verify trigger is registered.
  2. Toggle draft trigger OFF → 200. Verify trigger deregistered.
  3. Toggle draft trigger ON → 200. Verify trigger re-registered.
  4. Deploy v1.0, activate it. Toggle v1.0's trigger OFF → 200. Toggle ON → 200.
  5. Deactivate v1.0. Attempt to toggle v1.0's trigger ON → 400/422 (blocked for inactive versions per FR-13).
- **Expected Result**: Toggle works on draft and active published versions. Blocked on inactive versions.
- **Covers**: FR-13

### E2E-9: Unauthenticated and Expired Auth Requests

- **Preconditions**: Workflow with published version exists.
- **Auth Context**: No auth token / expired JWT / invalid API key.
- **Steps**:
  1. `GET /api/projects/:projectId/workflows/:workflowId/versions` with NO Authorization header → 401.
  2. `POST /api/projects/:projectId/workflows/:workflowId/versions/v1.0/activate` with expired JWT → 401.
  3. `POST /api/projects/:projectId/workflows/:workflowId/versions/v1.0/deactivate` with invalid API key → 401.
  4. `PATCH /api/projects/:projectId/workflows/:workflowId/versions/draft` with NO Authorization header → 401.
  5. `DELETE /api/projects/:projectId/workflows/:workflowId` with expired JWT → 401.
  6. `POST /api/v1/process/:workflowId` with invalid API key → 401.
  7. Repeat step 1 with valid auth but missing `workflow:read` permission → 403.
  8. `POST /api/projects/:projectId/deployments` with valid auth but missing `deployment:create` → 403.
- **Expected Result**: All unauthenticated requests return 401. Insufficient permissions return 403. No information leakage in error responses.
- **Covers**: Security & isolation

---

## 3. Integration Test Scenarios

> Integration tests verify service boundaries with real dependencies (MongoDB via MongoMemoryServer, Express with middleware). Only external third-party services (BullMQ, Restate) may use test doubles via DI.

### INT-1: Atomic Workflow + Draft Version Creation

- **Boundary**: Runtime route handler → WorkflowVersionService → MongoDB
- **Setup**: Real Express app on random port with auth middleware. MongoMemoryServer with `workflows` and `workflow_versions` collections.
- **Steps**:
  1. `POST /api/projects/:projectId/workflows` with `{ name: "int-1" }`.
  2. Query `workflows` collection — assert document exists with NO `status`, `nodes`, `edges`, `triggers` fields.
  3. Query `workflow_versions` collection — assert one document with `workflowId` matching, `version: "draft"`, `state: "active"`, `publishedAt: null`.
  4. Attempt to create a second draft for the same workflow — assert unique index violation or application-level prevention.
- **Expected Result**: Workflow + draft created atomically. Only one draft exists per workflow.
- **Failure Mode**: If creation partially fails (workflow created but draft not), verify rollback — no orphaned workflow without draft.
- **Covers**: FR-1, FR-2, FR-3

### INT-2: resolveDefaultVersion Logic

- **Boundary**: WorkflowVersionService → MongoDB (compound index query)
- **Setup**: MongoMemoryServer with pre-seeded versions: draft, v1.0 (active, published 2h ago), v2.0 (active, published 1h ago), v3.0 (inactive, published 30m ago).
- **Steps**:
  1. `resolveDefaultVersion(tenantId, projectId, workflowId)` → returns v2.0 (latest active published by `publishedAt` desc).
  2. Set v2.0 to `state: "inactive"` → `resolveDefaultVersion()` returns v1.0.
  3. Set v1.0 to `state: "inactive"` → `resolveDefaultVersion()` returns draft.
  4. Set v1.0 back to `state: "active"` → returns v1.0.
  5. Mark v1.0 as `deleted: true` → returns draft (deleted versions excluded).
- **Expected Result**: Resolution follows latest-active-published → draft fallback chain. Deleted and inactive versions excluded.
- **Failure Mode**: Incorrect index usage could return wrong order. Verify `explain()` uses the compound index.
- **Covers**: FR-14

### INT-3: Version Activation Registers Triggers, Deactivation Deregisters

- **Boundary**: WorkflowVersionService → TriggerRegistration model → BullMQ (via DI test double)
- **Setup**: MongoMemoryServer. BullMQ test double that captures `scheduleCron()`/`unschedule()` calls. Pre-seeded workflow with draft + published v1.0 (inactive) with cron and app-event trigger definitions.
- **Steps**:
  1. Call `activate(tenantId, projectId, workflowId, "v1.0")`.
  2. Assert `WorkflowVersion.state` changed to `"active"`.
  3. Assert `TriggerRegistration` documents created with `workflowVersionId` = v1.0's `_id`, `workflowVersion: "v1.0"`, `status: "active"`.
  4. Assert BullMQ test double received `scheduleCron()` call with correct cron expression.
  5. Call `deactivate(tenantId, projectId, workflowId, "v1.0")`.
  6. Assert `WorkflowVersion.state` changed to `"inactive"`.
  7. Assert `TriggerRegistration` documents updated to `status: "inactive"`.
  8. Assert BullMQ test double received `unschedule()` call.
  9. Verify draft version's state and triggers are unchanged throughout.
- **Expected Result**: Activation creates registrations and schedules. Deactivation updates registrations and unschedules. Draft unaffected.
- **Covers**: FR-8, FR-9, FR-10

### INT-4: Soft Delete Cascade with MongoDB Transaction

- **Boundary**: WorkflowVersionService → MongoDB transaction (workflows + workflow_versions + trigger_registrations)
- **Setup**: MongoMemoryServer in replica set mode. Pre-seeded: workflow + draft + v1.0 (active, 2 triggers) + v2.0 (active, 1 trigger). BullMQ test double.
- **Steps**:
  1. Call soft delete for `workflowId`.
  2. Assert `workflows` document has `deleted: true`, `deletedAt` set.
  3. Assert all 3 `workflow_versions` documents have `deleted: true`.
  4. Assert all 3 `trigger_registrations` have `status: "deleted"` or are deregistered.
  5. Assert BullMQ test double received `unschedule()` for each cron trigger (best-effort).
  6. Simulate BullMQ failure (test double throws on unschedule) — assert MongoDB transaction still commits (best-effort cleanup).
  7. Verify `resolveDefaultVersion()` returns null/404 after deletion.
  8. Call soft delete again — assert idempotent (200, no error).
- **Expected Result**: Transaction atomically marks all documents deleted. BullMQ cleanup is best-effort. Idempotent re-delete.
- **Covers**: FR-12

### INT-5: Environment-Scoped Event Routing (5-Case Matrix)

- **Boundary**: TriggerEngine → TriggerRegistration query → environment matching logic
- **Setup**: MongoMemoryServer. Pre-seeded trigger registrations: v1.0 trigger with `environment: "production"`, v2.0 trigger with `environment: "staging"`, draft trigger with `environment: null`.
- **Steps** (verify all 5 cases from FR-17):
  1. Fire event with `environment: "production"` → assert only v1.0's trigger fires (production == production).
  2. Fire event with `environment: "production"` → assert v2.0's trigger does NOT fire (production != staging).
  3. Fire event with `environment: "production"` → assert draft trigger does NOT fire (production != null).
  4. Fire event with `environment: null` (Studio test event) → assert only draft trigger fires (null == null).
  5. Fire event with `environment: null` → assert v1.0's trigger does NOT fire (null != production).
  6. Fire event with `environment: "staging"` → assert only v2.0's trigger fires.
- **Expected Result**: Events fire triggers only when both environments are equal (including both null).
- **Covers**: FR-17

### INT-6: Published Version Immutability (Frozen vs Mutable Fields)

- **Boundary**: Runtime route → WorkflowVersionService → MongoDB
- **Setup**: Real Express app. MongoMemoryServer. Pre-seeded workflow with published v1.0 (active).
- **Steps**:
  1. `PATCH /versions/v1.0` with `{ definition: { nodes: [...modified...] } }` → 400/422 (flow is frozen).
  2. `PATCH /versions/v1.0` with `{ triggers: [{ type: "webhook", config: {...modified...} }] }` → 400/422 (webhook triggers frozen).
  3. `PATCH /versions/v1.0` with `{ triggers: [{ type: "cron", config: { expression: "0 0 * * * *" } }] }` → 200 (cron schedule is mutable).
  4. `PATCH /versions/v1.0` with `{ definition: { envVars: {...} } }` → 400 (envVars frozen per D-1).
  5. `PATCH /versions/draft` with `{ definition: { nodes: [...modified...] } }` → 200 (draft is fully mutable).
  6. `PATCH /versions/draft` with `{ triggers: [{ type: "webhook", config: {...} }] }` → 200 (draft webhooks are mutable).
- **Expected Result**: Published versions reject changes to frozen fields (flow, webhook triggers), accept changes to mutable fields (cron, app-event, details). Draft accepts all changes.
- **Covers**: FR-5, FR-7

### INT-7: Cron processJob Loads Version Flow (Not Working Copy)

- **Boundary**: TriggerScheduler.processJob() → WorkflowVersion model → Restate (via DI test double)
- **Setup**: MongoMemoryServer. Pre-seeded: workflow with draft nodes `[A, B, C]`, v1.0 with frozen nodes `[X, Y, Z]`. Trigger registration for v1.0 with `workflowVersionId`. Restate test double capturing `startWorkflow()` calls.
- **Steps**:
  1. Simulate `processJob()` with job data containing the v1.0 trigger registration's ID and `workflowVersionId`.
  2. Assert `processJob()` loaded `WorkflowVersion` with `_id = workflowVersionId`, NOT the Workflow document.
  3. Assert Restate `startWorkflow()` received nodes `[X, Y, Z]` (v1.0 frozen flow), NOT `[A, B, C]` (draft).
  4. Simulate `processJob()` where `workflowVersionId` points to a deleted version → assert skipped execution, logged warning.
  5. Simulate `processJob()` where trigger status is `"inactive"` → assert skipped (safety net check).
- **Expected Result**: processJob always uses version's frozen flow via workflowVersionId. Safety nets prevent ghost executions.
- **Covers**: FR-18, FR-19

### INT-8: Concurrent Activate/Deactivate (Optimistic Locking)

- **Boundary**: WorkflowVersionService → MongoDB (optimistic lock via `_v` field)
- **Setup**: MongoMemoryServer. Pre-seeded: v1.0 (inactive).
- **Steps**:
  1. Read v1.0's current `_v` value.
  2. Initiate two concurrent operations: `activate(v1.0)` and `deactivate(v1.0)` (only one valid since it starts inactive, but tests the lock).
  3. One operation succeeds, the other gets an optimistic lock conflict error (version mismatch).
  4. Verify final state is consistent (either active or inactive, not corrupted).
  5. Retry the failed operation — succeeds with updated `_v`.
- **Expected Result**: Optimistic locking prevents concurrent state corruption. Retryable conflicts.
- **Covers**: Feature spec Section 12.4 (Reliability)

### INT-9: Draft Deactivation Rejection

- **Boundary**: WorkflowVersionService → validation logic
- **Setup**: MongoMemoryServer. Pre-seeded: workflow with draft version.
- **Steps**:
  1. `POST /versions/draft/deactivate` → 400/422 with error: `{ code: "DRAFT_ALWAYS_ACTIVE", message: "Draft version cannot be deactivated" }`.
  2. `DELETE /versions/draft` → 400/422 with error: draft cannot be deleted independently.
  3. Verify draft `state` is still `"active"` after both rejected operations.
- **Expected Result**: Draft version is always active. No mechanism to deactivate or delete it independently.
- **Covers**: FR-4

### INT-10: Deployment Auto-Mode Snapshots Draft WorkflowVersion

- **Boundary**: Deployment route → WorkflowVersionService.createVersion() → MongoDB
- **Setup**: Real Express app. MongoMemoryServer. Pre-seeded: workflow with draft version containing specific nodes/edges/triggers.
- **Steps**:
  1. `POST /api/projects/:projectId/deployments` with `{ workflowVersionManifest: { "wf": "auto" } }`.
  2. Assert new `WorkflowVersion` created with `version` auto-incremented (e.g., "v0.1.0").
  3. Assert new version's `definition.nodes` and `definition.edges` match draft's current definition (frozen snapshot).
  4. Assert new version's `triggers` array matches draft's triggers.
  5. Assert new version has `publishedAt` set, `publishedBy` set to authenticated user, `state: "active"`.
  6. Modify draft's nodes, then deploy again with `"auto"` → new version has updated nodes. Previous version unchanged.
  7. Deploy when draft is unchanged since last deploy → assert `sourceHash` dedup returns existing version (no duplicate).
- **Expected Result**: Auto mode snapshots from draft WorkflowVersion (not Workflow document). Dedup prevents duplicate versions.
- **Covers**: FR-15, FR-16

### INT-11: Workflow-as-Tool Binding Validation

- **Boundary**: `validate-workflow-tool-binding.ts` → WorkflowVersion query
- **Setup**: MongoMemoryServer. Pre-seeded: workflow with no status field (thin container), draft version, one active published version.
- **Steps**:
  1. Call `validateWorkflowToolBinding()` for workflow with active published version → passes validation.
  2. Deactivate published version (only draft remains) → passes validation (draft is active).
  3. Soft-delete workflow → fails validation with appropriate error.
  4. Call with workflow that has `status: 'active'` (old model, migration Phase 1) → still passes (backward compatible).
- **Expected Result**: Tool binding checks version state, not workflow-level status. Handles both old and new models during migration.
- **Covers**: GAP-008

### INT-12: In-Flight Execution Survives Version Deactivation

- **Boundary**: WorkflowVersionService (deactivate) → WorkflowExecution (in-progress) → Restate (via DI test double)
- **Setup**: MongoMemoryServer. Restate test double that captures `startWorkflow()` and supports a controllable execution completion. Pre-seeded: workflow with published v1.0 (active, cron trigger).
- **Steps**:
  1. Start an execution against v1.0 via the trigger fire path. Assert execution is created with `status: "running"` and `workflowVersion: "v1.0"`.
  2. While execution is in-flight, call `deactivate(tenantId, projectId, workflowId, "v1.0")` → 200.
  3. Assert `WorkflowVersion.state` changed to `"inactive"`.
  4. Assert trigger registrations deregistered (cron unscheduled).
  5. Allow the in-flight execution to complete (signal the Restate test double).
  6. Assert execution completes successfully with `status: "completed"` — deactivation did NOT abort it.
  7. Attempt a NEW trigger fire for v1.0 → assert skipped (version inactive, no triggers registered).
  8. Verify `processJob()` safety net: simulate a cron fire with the now-inactive trigger registration → assert no execution created.
- **Expected Result**: Running executions complete despite version deactivation. Only NEW executions are prevented.
- **Failure Mode**: If deactivation cancels running executions, data loss occurs. The test verifies the isolation boundary between version lifecycle and execution lifecycle.
- **Covers**: FR-11

---

## 4. Unit Test Scenarios

> Pure function tests — input → output, no side effects, zero mocks needed.

### UT-1: Default Version Resolution Sort Logic

- **Module**: `WorkflowVersionService.resolveDefaultVersion()` (extracted pure sort/filter function)
- **Input**: Array of versions: `[{ version: "draft", state: "active", publishedAt: null }, { version: "v1.0", state: "active", publishedAt: "2026-04-10" }, { version: "v2.0", state: "inactive", publishedAt: "2026-04-12" }, { version: "v3.0", state: "active", publishedAt: "2026-04-14" }]`
- **Expected Output**: `"v3.0"` (latest active published by publishedAt desc). With v3.0 inactive: `"v1.0"`. With all inactive: `"draft"`.

### UT-2: Environment Matching Predicate

- **Module**: Environment matching function (extracted from trigger engine)
- **Input/Output pairs** (from FR-17 decision table):
  - `("production", "production")` → `true`
  - `("production", "staging")` → `false`
  - `("production", null)` → `false`
  - `(null, null)` → `true`
  - `(null, "production")` → `false`

### UT-3: Version Name Auto-Increment

- **Module**: `WorkflowVersionService` version numbering function
- **Input**: Existing versions `["v0.1.0", "v0.1.1"]`
- **Expected Output**: Next version = `"v0.1.2"`

### UT-4: Source Hash Stability (deepSortKeys)

- **Module**: Hash computation function
- **Input**: Two objects with same keys in different order: `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }`
- **Expected Output**: Same SHA-256 hash for both

### UT-5: Mutability Check for Published Versions

- **Module**: Validation function that checks which fields are mutable on published versions
- **Input**: `{ fieldPath: "definition.nodes", versionType: "published" }` → `false` (frozen)
- **Input**: `{ fieldPath: "triggers[cron].config.expression", versionType: "published" }` → `true` (mutable)
- **Input**: `{ fieldPath: "definition.nodes", versionType: "draft" }` → `true` (draft is fully mutable)

### UT-6: Thin Container Validation

- **Module**: Zod schema for Workflow create/update
- **Input**: `{ name: "test", status: "active", nodes: [...] }` → Validation strips `status`, `nodes` (not accepted on thin container)
- **Input**: `{ name: "test", description: "d", tags: ["a"] }` → Passes (only metadata fields)

---

## 5. Security & Isolation Tests

### Tenant Isolation

- [ ] `GET /workflows/:wfId/versions` with cross-tenant auth → 404
- [ ] `POST /versions/:v/activate` with cross-tenant auth → 404
- [ ] `POST /versions/:v/deactivate` with cross-tenant auth → 404
- [ ] `DELETE /workflows/:wfId` with cross-tenant auth → 404
- [ ] `POST /api/v1/process/:wfId` with cross-tenant API key → 404
- [ ] `resolveDefaultVersion()` never returns versions from other tenants

### Project Isolation

- [ ] `GET /workflows/:wfId/versions` with wrong projectId → 404
- [ ] Version activation in project-A does not register triggers in project-B
- [ ] Soft delete in project-A does not cascade to same-named workflow in project-B
- [ ] `resolveDefaultVersion()` scoped to projectId (compound index enforces)

### User / RBAC

- [ ] `POST /deployments` without `deployment:create` permission → 403
- [ ] `PATCH /versions/:v` without `workflow:write` permission → 403
- [ ] `DELETE /workflows/:wfId` without `workflow:delete` permission → 403
- [ ] `GET /versions` without `workflow:read` permission → 403
- [ ] API key auth with insufficient scopes → 403

### Auth Boundary

- [ ] Unauthenticated request to any version endpoint → 401
- [ ] Expired JWT token → 401
- [ ] Invalid API key → 401

### Input Validation

- [ ] `PATCH /versions/:v` with `definition.nodes` on published version → 400/422 (frozen field)
- [ ] `POST /versions/draft/deactivate` → 400/422 (draft always active)
- [ ] `POST /workflows` with empty name → 400
- [ ] Version name with special characters (SQL injection, XSS payloads) → sanitized or rejected
- [ ] Oversized definition payload → 413 or 400 (MAX_DEFINITION_SIZE)

---

## 6. Performance & Load Tests

### Scenarios (if applicable)

| Scenario                             | Metric       | Target              | Tool |
| ------------------------------------ | ------------ | ------------------- | ---- |
| `resolveDefaultVersion()` under load | p99 latency  | < 50ms              | k6   |
| Concurrent version activations       | Success rate | 100% (no deadlocks) | k6   |
| Cron trigger fire throughput         | Triggers/sec | > 100/sec           | k6   |
| Soft delete cascade (10+ versions)   | Total time   | < 2 seconds         | k6   |

### Index Performance Verification

- [ ] `EXPLAIN` on `resolveDefaultVersion()` query shows compound index scan, not collection scan
- [ ] `EXPLAIN` on `listVersions()` query shows index usage
- [ ] `EXPLAIN` on tenant isolation queries shows `tenantId` prefix in index

---

## 7. Test Infrastructure

### Required Services

| Service         | Port  | Purpose                                            | Required For     |
| --------------- | ----- | -------------------------------------------------- | ---------------- |
| MongoDB         | 27018 | Data persistence (via Docker or MongoMemoryServer) | All tests        |
| Redis           | 6380  | BullMQ trigger scheduling                          | Integration, E2E |
| Restate         | 8091  | Workflow execution runtime                         | E2E only         |
| Runtime         | 3112  | REST API server                                    | E2E only         |
| Workflow Engine | 9081  | Trigger processing, execution handling             | E2E only         |
| Studio          | 5173  | UI E2E (Playwright)                                | UI E2E only      |

### Data Seeding

**For integration tests** (MongoMemoryServer):

```typescript
// Seed helper pattern
async function seedVersionedWorkflow(db: Connection) {
  const workflow = await db.collection('workflows').insertOne({
    _id: uuidv7(), tenantId: 'tenant-1', projectId: 'project-1',
    name: 'test-wf', description: 'test', deleted: false,
    createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(),
  });
  const draftVersion = await db.collection('workflow_versions').insertOne({
    _id: uuidv7(), tenantId: 'tenant-1', projectId: 'project-1',
    workflowId: workflow.insertedId, version: 'draft', state: 'active',
    definition: { nodes: [...], edges: [...], envVars: {}, inputSchema: null, outputSchema: null },
    triggers: [], deleted: false, publishedAt: null, publishedBy: null,
    createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(),
  });
  return { workflow, draftVersion };
}
```

**For E2E tests** (real API):

```typescript
// Seed via HTTP API
async function seedWorkflowWithVersions(apiClient: ApiClient) {
  const wf = await apiClient.post('/api/projects/:pid/workflows', { name: 'e2e-wf' });
  await apiClient.patch(`/api/projects/:pid/workflows/${wf.id}/versions/draft`, {
    definition: { nodes: testNodes, edges: testEdges },
    triggers: [{ type: 'cron', config: { expression: '0 */5 * * * *' } }],
  });
  const deploy = await apiClient.post('/api/projects/:pid/deployments', {
    workflowVersionManifest: { 'e2e-wf': 'auto' },
    environment: 'production',
  });
  return { workflowId: wf.id, versionName: deploy.versionName };
}
```

### Environment Variables

| Variable                           | Test Value                         | Purpose                                     |
| ---------------------------------- | ---------------------------------- | ------------------------------------------- |
| `WORKFLOW_VERSION_MIGRATION_PHASE` | `2`                                | Run tests against the final (clean) model   |
| `MONGODB_URI`                      | dynamic                            | MongoMemoryServer URI for integration tests |
| `REDIS_URL`                        | `redis://:localdev@localhost:6380` | BullMQ for trigger scheduling               |

### CI Configuration

- **Unit tests**: Run in `vitest.config.ts` (fast tier, no external dependencies)
- **Integration tests**: Run in `vitest.integration.config.ts` (requires MongoMemoryServer, optional Redis)
- **E2E tests**: Run in `vitest.e2e.config.ts` or Playwright (requires full Docker stack)
- New test files must be added to both `vitest.integration.config.ts` includes AND `vitest.fast.config.ts` excludes

---

## 8. Test File Mapping

| Test File                                                                            | Type        | Covers                     | Status    |
| ------------------------------------------------------------------------------------ | ----------- | -------------------------- | --------- |
| `apps/runtime/src/__tests__/workflow-versioning.e2e.test.ts`                         | e2e         | E2E-1 to E2E-5, E2E-9      | DONE      |
| `apps/runtime/src/__tests__/workflow-version-triggers.e2e.test.ts`                   | e2e         | E2E-2, E2E-7, E2E-8        | DONE      |
| `apps/runtime/src/__tests__/workflow-version-deployment.e2e.test.ts`                 | e2e         | E2E-6                      | DONE      |
| `packages/shared/src/tools/__tests__/validate-workflow-tool-binding-version.test.ts` | integration | INT-11 (GAP-008)           | DONE      |
| `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts`                 | integration | FR-19, version-aware fire  | REWRITTEN |
| `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`                     | integration | FR-17                      | EXTENDED  |
| `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`                          | unit        | GAP-004 jobData threading  | DONE      |
| `packages/connectors/src/__tests__/cron-scheduler.test.ts`                           | unit        | GAP-001 cron version       | DONE      |
| `packages/connectors/src/__tests__/polling-scheduler.test.ts`                        | unit        | GAP-001 polling version    | DONE      |
| `packages/connectors/src/__tests__/webhook-handler.test.ts`                          | unit        | GAP-001 webhook version    | DONE      |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`                        | unit        | Service methods            | REWRITTEN |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`                         | unit        | Route handlers             | REWRITTEN |
| `apps/runtime/src/__tests__/workflow-version-lifecycle.test.ts`                      | unit        | State transitions          | REWRITTEN |
| `apps/runtime/src/__tests__/workflow-version-resolution.test.ts`                     | unit        | Default version resolution | REWRITTEN |
| `packages/database/src/__tests__/model-workflow-version.test.ts`                     | unit        | Schema, indexes            | UPDATED   |
| `apps/runtime/src/__tests__/workflow-version-activate-deactivate.test.ts`            | integration | FR-8, FR-9, FR-10          | PLANNED   |
| `apps/runtime/src/__tests__/workflow-version-inflight.test.ts`                       | integration | FR-11                      | PLANNED   |
| `apps/studio/e2e/workflows/workflow-versioning.spec.ts`                              | ui-e2e      | FR-20, E2E UI journeys     | PLANNED   |

---

## 9. Open Testing Questions

1. **TQ-1**: Should integration tests for FR-12 (cascade delete) use MongoMemoryServer in replica-set mode for real transaction testing, or is single-node sufficient for the atomicity guarantee? Replica-set mode is slower but more production-like.
2. **TQ-2**: How should E2E tests verify BullMQ trigger registration without direct queue inspection? Options: (a) expose a debug endpoint for trigger status, (b) check TriggerRegistration collection state via a GET endpoint, (c) wait for cron fire and verify execution created.
3. **TQ-3**: For E2E-7 (cron fires frozen flow), what's the acceptable wait time for a cron trigger to fire in the test? A 5-minute cron expression is too slow. Options: (a) use a 1-second cron for test, (b) manually trigger processJob via internal API, (c) use a webhook trigger instead.
4. **TQ-4**: Should migration Phase 1 (dual-write) have its own test suite, or is testing Phase 2 (clean model) sufficient? Phase 1 is transitional, but bugs during migration could be severe.
5. **TQ-5**: The existing `workflow-version-routes.test.ts` has 6 `vi.mock` calls. Should it be deleted and rewritten from scratch, or incrementally fixed by replacing mocks with real dependencies?
