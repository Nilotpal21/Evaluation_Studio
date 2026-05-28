# Testing Guide: Unified Deployment Endpoints

**Feature**: [Unified Deployment Endpoints](../features/unified-deployment-endpoints.md)
**Status**: PLANNED
**Last Updated**: 2026-04-10

---

## Feature Metadata

- **Feature Status**: PLANNED
- **Packages**: `apps/runtime`, `packages/database`, `apps/studio`, `apps/workflow-engine`
- **Test Tier**: Tier 1 (core platform infrastructure)

---

## Current State

No tests exist yet. This testing guide defines the required coverage for implementation.

---

## Coverage Matrix

| FR    | Requirement                             | Unit | Integration | E2E | Manual |
| ----- | --------------------------------------- | ---- | ----------- | --- | ------ |
| FR-1  | DeploymentEndpoint model                | -    | -           | -   | -      |
| FR-2  | Auto-create endpoints during deployment | -    | -           | -   | -      |
| FR-3  | Unified ingress route                   | -    | -           | -   | -      |
| FR-4  | Existing URLs unchanged                 | -    | -           | -   | -      |
| FR-5  | Endpoint CRUD                           | -    | -           | -   | -      |
| FR-6  | Health tracking                         | -    | -           | -   | -      |
| FR-7  | TraceEvent emission                     | -    | -           | -   | -      |
| FR-8  | Endpoint status (paused -> 503)         | -    | -           | -   | -      |
| FR-9  | Studio Endpoints tab                    | -    | -           | -   | -      |
| FR-10 | Request-time version resolution         | -    | -           | -   | -      |
| FR-11 | Cleanup on deployment retirement        | -    | -           | -   | -      |
| FR-12 | Per-endpoint rate limiting              | -    | -           | -   | -      |

---

## E2E Test Scenarios

### E2E-1: SDK Channel Invocation via Unified URL

**Objective**: Verify that an SDK web chat conversation can be initiated through the deployment-scoped unified URL.

**Steps**:

1. Create a project with an agent and deploy to `dev` environment
2. Verify deployment auto-creates endpoints for linked SDK channels
3. `POST /api/v1/deployments/{slug}/endpoints/{chat-path}` with SDK auth (pk\_\* key)
4. Verify response streams through the full agent execution pipeline
5. Verify `endpoint.invoked` TraceEvent emitted with correct fields

**Auth Context**: SDK API key (`pk_*`)
**Isolation Check**: Attempt access with a different tenant's API key -> expect 404

### E2E-2: Workflow Trigger via Unified URL

**Objective**: Verify that a workflow trigger can fire through the deployment-scoped unified URL.

**Steps**:

1. Create a project with a workflow and webhook trigger, deploy to `dev`
2. Verify deployment auto-creates endpoint for the trigger registration
3. `POST /api/v1/deployments/{slug}/endpoints/{trigger-path}` with HMAC signature
4. Verify workflow execution starts in Restate
5. Verify execution record created with correct `deploymentId` and workflow version from manifest
6. Verify `endpoint.invoked` TraceEvent emitted

**Auth Context**: HMAC-SHA256 signature
**Isolation Check**: Attempt access with wrong HMAC secret -> expect 401

### E2E-3: Cross-Tenant Endpoint Isolation

**Objective**: Verify that endpoints are invisible across tenant boundaries.

**Steps**:

1. Create endpoint in tenant A's project deployment
2. Authenticated as tenant B, attempt `GET /api/projects/:projectId/deployment-endpoints` for tenant A's project -> expect 404
3. Attempt `POST /api/v1/deployments/{tenantA-slug}/endpoints/{path}` with tenant B credentials -> expect 404
4. Verify no information leakage in error responses (no deployment slug, project ID, or endpoint details)

### E2E-4: Endpoint Auto-Creation and Cleanup Lifecycle

**Objective**: Verify endpoints are created during deployment and cleaned up on retirement.

**Steps**:

1. Create a project with 2 SDK channels (followEnvironment=true) and 1 trigger registration
2. Deploy to `dev` environment
3. Verify 3 `DeploymentEndpoint` records created with correct `targetType` and `targetId`
4. Retire the deployment
5. Verify all 3 endpoints have `deletedAt` set (soft-deleted)
6. Create a new deployment to the same environment
7. Verify 3 new endpoint records created (not reusing old ones)

### E2E-5: Existing Channel URLs Remain Functional

**Objective**: Verify that deploying with unified endpoints does not break existing channel-specific webhook URLs.

**Steps**:

1. Create a project with a Slack channel connection, deploy
2. Verify endpoint auto-created for the Slack connection
3. Send a message via the existing Slack webhook URL (`/api/v1/channels/slack/webhook/:identifier`)
4. Verify message processed successfully (session created, agent responds)
5. Verify the existing URL path is unchanged and functional

### E2E-6: Version Resolution via Unified URL Serves Pinned Version

**Objective**: Verify that invoking an endpoint via the unified URL serves the agent/workflow version pinned by the deployment, not the latest working copy.

**Steps**:

1. Create a project with an agent, create agent version v1 with specific behavior
2. Deploy to `dev` pinning agent to v1
3. Update the agent's working copy to v2 (different behavior)
4. Invoke the endpoint via `POST /api/v1/deployments/{slug}/endpoints/{path}`
5. Verify the response matches v1 behavior (deployment-pinned), not v2 (working copy)
6. Create a new deployment pinning v2
7. Invoke the same endpoint path on the new deployment slug
8. Verify the response now matches v2 behavior

**Auth Context**: SDK API key
**Isolation Check**: N/A (version resolution, not isolation)

---

## Integration Test Scenarios

### INT-1: Endpoint CRUD with Project Isolation

**Objective**: Verify endpoint CRUD respects project boundaries.

**Steps**:

1. Create endpoints in project A's deployment
2. List endpoints from project B's context -> returns empty (not project A's endpoints)
3. Attempt to PATCH endpoint from project A using project B's auth -> 404
4. Attempt to DELETE endpoint from project A using project B's auth -> 404

### INT-2: Health Status State Machine

**Objective**: Verify health tracking transitions correctly.

**Steps**:

1. Create an endpoint in `active` status
2. Simulate 5 consecutive errors (errorThreshold=5) via endpoint invocations
3. Verify status transitions to `degraded`
4. Simulate 1 successful invocation
5. Verify `consecutiveErrors` resets to 0 and status transitions back to `active`

### INT-3: Paused Endpoint Returns 503

**Objective**: Verify paused endpoints reject traffic with correct status.

**Steps**:

1. Create and invoke an endpoint successfully
2. PATCH endpoint status to `paused`
3. Attempt invocation -> expect 503 with `{ success: false, error: { code: 'ENDPOINT_PAUSED', message: '...' } }`
4. PATCH endpoint status to `active`
5. Invoke successfully again

### INT-4: Per-Endpoint Rate Limiting

**Objective**: Verify per-endpoint rate limits override tenant defaults.

**Steps**:

1. Create an endpoint with `rateLimitRpm: 2`
2. Make 2 requests -> both succeed
3. Make 3rd request within the same minute -> expect 429

### INT-5: TraceEvent Content Verification

**Objective**: Verify `endpoint.invoked` trace events contain all required fields.

**Steps**:

1. Invoke an endpoint successfully
2. Query TraceStore for `endpoint.invoked` events
3. Verify event contains: `endpointId`, `deploymentId`, `deploymentSlug`, `path`, `targetType`, `targetId`, `authMode`, `durationMs`, `httpStatus` (200), no `errorCode`
4. Invoke an endpoint that fails
5. Verify error event contains `httpStatus` (4xx/5xx) and `errorCode`

### INT-6: Endpoint Resolution Performance

**Objective**: Verify endpoint resolution uses indexed queries.

**Steps**:

1. Create 100 endpoints across 10 deployments
2. Resolve an endpoint by slug + path
3. Verify resolution uses the `{ deploymentId, path }` compound index (query explain plan)
4. Verify resolution time < 5ms

---

## Test Infrastructure Notes

- E2E tests must start real Express servers on random ports with full middleware chain
- No `vi.mock` or `jest.mock` of platform components
- Workflow trigger tests require a Restate test instance or mock external Restate endpoint via DI
- TraceEvent verification requires reading from the real TraceStore (MongoDB)
- Rate limiting tests require a Redis instance
