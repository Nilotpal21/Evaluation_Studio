# Test Specification: Platform Keys Management

**Feature Spec**: [`docs/features/sub-features/platform-keys.md`](../../features/sub-features/platform-keys.md)
**HLD**: [`docs/specs/platform-keys.hld.md`](../../specs/platform-keys.hld.md)
**LLD**: [`docs/plans/2026-04-11-platform-keys-impl-plan.md`](../../plans/2026-04-11-platform-keys-impl-plan.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-12

---

## 1. Coverage Matrix

### Phase 1 — CRUD & UI (DONE)

| FR    | Description                                                   | Unit    | Integration     | E2E             | Manual     | Status  |
| ----- | ------------------------------------------------------------- | ------- | --------------- | --------------- | ---------- | ------- |
| FR-01 | Tabbed Settings UI (SDK Keys / Platform Keys)                 | -       | -               | -               | NOT TESTED | IMPL    |
| FR-02 | SDK Keys tab renders existing content unchanged               | -       | -               | -               | NOT TESTED | IMPL    |
| FR-03 | Platform Keys list filtered by projectId, revoked, expired    | -       | ✅ INT-2        | ✅ E2E-4, E2E-7 | -          | PASSING |
| FR-04 | Key row: name, prefix, scope badges, dates                    | -       | -               | ✅ E2E-1        | NOT TESTED | PASSING |
| FR-05 | POST /api/keys creates ApiKey with abl\_ prefix, SHA-256 hash | ✅ UT-1 | ✅ INT-1, INT-3 | ✅ E2E-1        | -          | PASSING |
| FR-06 | Raw key returned once, never retrievable again                | -       | ✅ INT-1        | ✅ E2E-1        | -          | PASSING |
| FR-07 | Scope multi-select from predefined list, min 1 required       | ✅ UT-2 | ✅ INT-6        | ✅ E2E-5        | -          | PASSING |
| FR-08 | Expiration picker presets (none, 30d, 90d, custom)            | ✅ UT-3 | ✅ INT-2        | ✅ E2E-7        | -          | PASSING |
| FR-09 | Multi-project selection, current project pre-selected         | -       | ✅ INT-10       | ✅ E2E-10       | -          | PASSING |
| FR-10 | PATCH updates name/scopes only, rejects projectIds            | -       | ✅ INT-3        | ✅ E2E-6        | -          | PASSING |
| FR-11 | DELETE soft-revokes (revokedAt), preserves document           | -       | ✅ INT-4        | ✅ E2E-2        | -          | PASSING |
| FR-12 | Revoke confirmation dialog with trigger warning               | -       | -               | -               | NOT TESTED | IMPL    |
| FR-13 | GET lists active keys with 100-item safety cap                | -       | ✅ INT-8        | ✅ E2E-1        | -          | PASSING |
| FR-14 | Auth: requireAuth + requireSdkProjectAccess on all routes     | -       | ✅ INT-5        | ✅ E2E-3, E2E-8 | -          | PASSING |
| FR-15 | WebhookKeyCreationModal uses /api/keys (not /api/sdk/keys)    | -       | -               | ✅ E2E-9        | -          | PASSING |
| FR-16 | WebhookQuickStart shows abl\_ prefix                          | -       | -               | -               | NOT TESTED | IMPL    |

### Phase 2 — Scope Architecture (PLANNED)

| FR    | Description                                                            | Unit          | Integration       | E2E               | Manual | Status  |
| ----- | ---------------------------------------------------------------------- | ------------- | ----------------- | ----------------- | ------ | ------- |
| FR-17 | Scope registry as typed constant in shared-auth                        | ✅ UT-5, UT-6 | ✅ INT-11         | -                 | -      | PLANNED |
| FR-18 | Scope categories: execution, management, analytics, admin (10 scopes)  | ✅ UT-5       | ✅ INT-11         | ✅ E2E-16         | -      | PLANNED |
| FR-19 | POST /api/keys performs creation-time ceiling check                    | ✅ UT-7       | ✅ INT-12, INT-13 | ✅ E2E-11, E2E-12 | -      | PLANNED |
| FR-20 | PATCH /api/keys/:keyId enforces ceiling check on scope updates         | ✅ UT-7       | ✅ INT-14         | ✅ E2E-13         | -      | PLANNED |
| FR-21 | Dot-separated scope identifiers (distinct from colon-separated RBAC)   | ✅ UT-5       | ✅ INT-11         | -                 | -      | PLANNED |
| FR-22 | resolveApiKey expands scopes to RBAC permissions via registry          | ✅ UT-8       | ✅ INT-15         | ✅ E2E-14         | -      | PLANNED |
| FR-23 | Studio dialogs render scopes from shared registry, grouped by category | -             | -                 | -                 | MANUAL | PLANNED |
| FR-24 | resolveApiKey in runtime expands scopes, flows to ctx.permissions      | ✅ UT-8       | ✅ INT-15         | ✅ E2E-14         | -      | PLANNED |
| FR-25 | GET /api/keys/scopes returns full scope registry                       | -             | ✅ INT-16         | ✅ E2E-16         | -      | PLANNED |

---

## 2. E2E Test Scenarios (MANDATORY)

All E2E tests use `startStudioApiHarness()` from `apps/studio/src/__tests__/helpers/studio-api-harness.ts` with MongoMemoryServer. Auth tokens obtained via `POST /api/auth/dev-login`. Projects created via `POST /api/projects`. No mocks. Real HTTP requests against real middleware chain.

### Phase 1 E2E Scenarios (DONE — E2E-1 through E2E-10)

### E2E-1: Create platform key and verify in list

- **Preconditions**: Authenticated user with project write access. Project created via API.
- **Steps**:
  1. `POST /api/keys` with `{ name: "My Workflow Key", scopes: ["workflow:execute"], projectIds: ["<projectId>"] }`
  2. Assert 201 response with `{ id, key, prefix, name, scopes, projectIds }` where `key` starts with `abl_`, `prefix` is first 8 chars of `key`
  3. `GET /api/keys?projectId=<projectId>` with same auth
  4. Assert response contains 1 key with matching `id`, `name`, `prefix`, `scopes` and NO `key` field (raw key not exposed in list)
- **Expected Result**: Key created with `abl_` prefix; visible in list without raw key; correct scopes and project association
- **Auth Context**: Tenant A, Project X, user is project owner
- **Isolation Check**: Raw key never appears in GET response
- **Covers**: FR-05, FR-06, FR-13

### E2E-2: Revoke key and verify exclusion from list

- **Preconditions**: Platform key exists (created via setup)
- **Steps**:
  1. `DELETE /api/keys/<keyId>` with project write auth
  2. Assert 200 response
  3. `GET /api/keys?projectId=<projectId>`
  4. Assert response keys array does NOT contain the revoked key
- **Expected Result**: Revoked key excluded from active list; document preserved in DB (soft-delete via `revokedAt`)
- **Auth Context**: Same tenant/project/user as creation
- **Isolation Check**: Revoked key invisible but not hard-deleted
- **Covers**: FR-11, FR-03

### E2E-3: Cross-tenant isolation returns 404

- **Preconditions**: Two separate tenant contexts (two dev-login calls with different emails). Tenant A has a project with a platform key.
- **Steps**:
  1. Tenant A: `POST /api/auth/dev-login` -> get tokenA. Create project A. Create platform key.
  2. Tenant B: `POST /api/auth/dev-login` (different email) -> get tokenB.
  3. Tenant B: `GET /api/keys?projectId=<projectA-id>` with tokenB -> assert 404
  4. Tenant B: `PATCH /api/keys/<keyId>` with tokenB and `{ name: "hijacked" }` -> assert 404
  5. Tenant B: `DELETE /api/keys/<keyId>` with tokenB -> assert 404
- **Expected Result**: All cross-tenant operations return 404 (not 403, no existence disclosure)
- **Auth Context**: Tenant A (owner), Tenant B (attacker)
- **Isolation Check**: Cross-tenant access returns 404 for GET, PATCH, DELETE
- **Covers**: FR-14, Core Invariant #1

### E2E-4: Cross-project isolation

- **Preconditions**: Single tenant with two projects (X and Y). Platform key created with `projectIds: [projectX]`.
- **Steps**:
  1. Create project X and project Y under the same tenant
  2. `POST /api/keys` with `projectIds: [projectX]`
  3. `GET /api/keys?projectId=<projectX>` -> assert key is present
  4. `GET /api/keys?projectId=<projectY>` -> assert key is NOT present (empty list)
- **Expected Result**: Key only visible when querying the project it is scoped to
- **Auth Context**: Same user with access to both projects
- **Isolation Check**: `projectIds` array filter correctly scopes visibility
- **Covers**: FR-03, FR-14

### E2E-5: Scope validation rejects unknown scopes

- **Preconditions**: Authenticated user with project write access
- **Steps**:
  1. `POST /api/keys` with `{ name: "Bad Key", scopes: ["admin:delete"], projectIds: ["<projectId>"] }` -> assert 400
  2. `POST /api/keys` with `{ name: "Empty Scopes", scopes: [], projectIds: ["<projectId>"] }` -> assert 400
- **Expected Result**: Invalid scopes rejected with 400; empty scopes rejected with 400
- **Auth Context**: Authenticated user, project owner
- **Isolation Check**: N/A (validation test)
- **Covers**: FR-07

### E2E-6: Edit key name and scopes, verify projectIds immutable

- **Preconditions**: Platform key exists with `scopes: ["workflow:execute"]`
- **Steps**:
  1. `PATCH /api/keys/<keyId>` with `{ name: "Updated Name", scopes: ["workflow:execute", "workflow:read"] }`
  2. Assert 200 with updated fields in response
  3. `GET /api/keys?projectId=<projectId>` -> verify key has new name and both scopes
  4. `PATCH /api/keys/<keyId>` with `{ projectIds: ["<otherProjectId>"] }` -> assert 400
- **Expected Result**: Name and scopes editable; projectIds change rejected with 400
- **Auth Context**: Authenticated user, project owner
- **Covers**: FR-10

### E2E-7: Expired key excluded from list

- **Preconditions**: Authenticated user with project write access
- **Steps**:
  1. `POST /api/keys` with `expiresAt` set to a past date
  2. `GET /api/keys?projectId=<projectId>` -> assert expired key NOT in response
  3. `POST /api/keys` with `expiresAt` set to a future date
  4. `GET /api/keys?projectId=<projectId>` -> assert future key IS in response
- **Expected Result**: Expired keys filtered out; non-expired keys visible
- **Auth Context**: Authenticated user, project owner
- **Covers**: FR-03, FR-08

### E2E-8: Unauthenticated request returns 401

- **Preconditions**: None
- **Steps**:
  1. `GET /api/keys?projectId=<anyId>` with NO Authorization header -> assert 401
  2. `POST /api/keys` with NO Authorization header -> assert 401
- **Expected Result**: All routes reject unauthenticated requests
- **Auth Context**: No auth
- **Covers**: FR-14

### E2E-9: Workflow trigger key creation contract test

- **Preconditions**: Authenticated user with project write access
- **Steps**:
  1. `POST /api/keys` with `{ name: "Webhook: My Workflow", scopes: ["workflow:execute"], projectIds: ["<projectId>"] }` (matches payload shape WebhookKeyCreationModal sends)
  2. Assert 201 with `key` starting with `abl_`
  3. `GET /api/keys?projectId=<projectId>`
  4. Assert the created key is listed with `workflow:execute` scope
- **Expected Result**: API contract supports the WebhookKeyCreationModal migration payload
- **Auth Context**: Authenticated user, project owner
- **Covers**: FR-15, FR-16

### E2E-10: Multi-project key visible in both projects

- **Preconditions**: Authenticated user with write access to two projects (X and Y)
- **Steps**:
  1. Create project X and project Y
  2. `POST /api/keys` with `{ name: "Multi-Project Key", scopes: ["workflow:execute"], projectIds: ["<projectX>", "<projectY>"] }`
  3. Assert 201 with `projectIds` containing both project IDs
  4. `GET /api/keys?projectId=<projectX>` -> assert key is present
  5. `GET /api/keys?projectId=<projectY>` -> assert key is present
  6. Create project Z -> `GET /api/keys?projectId=<projectZ>` -> assert key is NOT present
- **Expected Result**: Key visible in all projects listed in `projectIds`, invisible in others
- **Auth Context**: Authenticated user, owner of all projects
- **Isolation Check**: `$in` query correctly matches multi-project keys
- **Covers**: FR-09

### Phase 2 E2E Scenarios (PLANNED — E2E-11 through E2E-16)

### E2E-11: Ceiling check blocks VIEWER from creating key with agents.write scope

- **Preconditions**: Two users in the same tenant. User A is workspace OWNER. User B is workspace VIEWER (invited via API). Both have project access.
- **Steps**:
  1. User A (OWNER): `POST /api/auth/dev-login` -> tokenA. Create project.
  2. Invite User B as VIEWER to the workspace. User B obtains tokenB via dev-login.
  3. User B (VIEWER): `POST /api/keys` with `{ name: "Viewer Key", scopes: ["agents.write"], projectIds: ["<projectId>"] }` -> assert **403**
  4. Assert response body contains `{ error: "Scope ceiling exceeded", code: "SCOPE_CEILING_EXCEEDED", denied: ["agents.write"] }`
  5. User B (VIEWER): `POST /api/keys` with `{ name: "Viewer Read Key", scopes: ["workflows.read"], projectIds: ["<projectId>"] }` -> assert **201** (VIEWER has `workflow:read` permission)
  6. `GET /api/keys?projectId=<projectId>` with tokenB -> assert only the read-scope key exists
- **Expected Result**: VIEWER blocked from `agents.write` (requires `agent:create` which is ADMIN-only), allowed `workflows.read` (VIEWER has `workflow:read`)
- **Auth Context**: Tenant A, VIEWER role user B
- **Isolation Check**: Ceiling check prevents privilege escalation
- **Covers**: FR-19, US-10

### E2E-12: ADMIN ceiling check allows management scopes, blocks analytics.read

- **Preconditions**: User with ADMIN workspace role.
- **Steps**:
  1. ADMIN user: `POST /api/keys` with `{ name: "Admin Management Key", scopes: ["agents.write", "deployments.write", "workflows.execute"], projectIds: ["<projectId>"] }` -> assert **201**
  2. Assert returned key has all 3 scopes
  3. ADMIN user: `POST /api/keys` with `{ name: "Admin Analytics Key", scopes: ["analytics.read"], projectIds: ["<projectId>"] }` -> assert **403** (`analytics:read` not in ADMIN's tenant role permissions — ADMIN has resource wildcards for project, agent, tool, workflow, deployment, etc. but not analytics; only OWNER passes via `*:*`)
  4. Assert 403 response lists `analytics.read` as the denied scope
- **Expected Result**: ADMIN can grant management/execution scopes they have permission for; blocked from `analytics.read` which requires OWNER
- **Auth Context**: Tenant A, ADMIN role user
- **Isolation Check**: Ceiling correctly maps ADMIN permissions
- **Covers**: FR-19, FR-18

### E2E-13: PATCH ceiling check blocks scope escalation

- **Preconditions**: OPERATOR user creates a key with `workflows.execute` scope (allowed). Then tries to PATCH the scopes to include `agents.write` (requires ADMIN).
- **Steps**:
  1. OPERATOR user: `POST /api/keys` with `{ name: "Op Key", scopes: ["workflows.execute"], projectIds: ["<projectId>"] }` -> assert 201
  2. OPERATOR user: `PATCH /api/keys/<keyId>` with `{ scopes: ["workflows.execute", "agents.write"] }` -> assert **403**
  3. Assert 403 response identifies `agents.write` as the scope beyond the OPERATOR ceiling
  4. `GET /api/keys?projectId=<projectId>` -> verify key still has original `["workflows.execute"]` scope (unchanged)
- **Expected Result**: PATCH enforces ceiling check identically to POST; original scopes preserved after rejection
- **Auth Context**: Tenant A, OPERATOR role user
- **Isolation Check**: PATCH cannot be used to escalate scope beyond creator's RBAC ceiling
- **Covers**: FR-20

### E2E-14: Scope expansion verified via runtime HTTP — key created in Studio, used at Runtime

- **Preconditions**: Studio API harness running. A runtime HTTP endpoint that requires a specific permission (e.g., `GET /api/projects/:id/agents` requires `agent:read`).
- **Steps**:
  1. OWNER user: `POST /api/keys` with `{ name: "Runtime Key", scopes: ["agents.read"], projectIds: ["<projectId>"] }` -> assert 201, capture raw key
  2. Use raw key as `Authorization: Bearer abl_...` against runtime `GET /api/projects/<projectId>/agents` -> assert **200** (proves `agents.read` expanded to `agent:read`)
  3. Use same raw key against runtime `POST /api/projects/<projectId>/agents` (requires `agent:create`) -> assert **403** (proves key has only read, not write)
  4. Create a second key: `POST /api/keys` with `scopes: ["agents.write"]` -> capture raw key
  5. Use second key against runtime `POST /api/projects/<projectId>/agents` -> assert **200** (proves `agents.write` expanded to include `agent:create`)
- **Expected Result**: Scopes created in Studio correctly expand to RBAC permissions at runtime; requests succeed/fail based on expanded permissions
- **Auth Context**: Runtime auth context (bearer token, not JWT)
- **Isolation Check**: Key with `agents.read` cannot perform write operations — expanded permissions are bounded
- **Covers**: FR-22, FR-24
- **Note**: Requires runtime server started alongside Studio harness. If runtime harness is not available, this test is deferred and covered at integration level by INT-15 (direct `resolveApiKey` function call).

### E2E-15: Backwards compatibility — legacy colon-separated scopes at runtime

- **Preconditions**: A legacy key with colon-separated scopes exists in the database (seeded via direct DB insert, since Phase 2 API only accepts dot-separated scopes per D-3 decision). A new key created via Phase 2 API.
- **Steps**:
  1. Seed a legacy key directly in MongoDB with `scopes: ["workflow:execute", "workflow:read"]` (colon-separated), valid `keyHash`, `prefix`, `tenantId`, `projectIds`, `createdBy`. This simulates a key created before Phase 2.
  2. `GET /api/keys?projectId=<projectId>` -> verify legacy key is listed with `scopes: ["workflow:execute", "workflow:read"]`
  3. Create a new key via Phase 2 API: `POST /api/keys` with `{ name: "New Key", scopes: ["workflows.execute"], projectIds: ["<projectId>"] }` -> assert 201
  4. `GET /api/keys?projectId=<projectId>` -> verify both keys coexist (legacy colon-separated and new dot-separated formats)
  5. Use legacy key as `Authorization: Bearer abl_...` against a runtime endpoint requiring `workflow:execute` -> assert **200** (colon-separated scopes pass through as RBAC permissions)
  6. Use new key against the same endpoint -> assert **200** (dot-separated scopes expand to include `workflow:execute`)
- **Expected Result**: Both legacy and new scope formats work at runtime; existing Phase 1 keys continue to authenticate
- **Auth Context**: Runtime auth context for steps 5-6; Studio auth for steps 2-4
- **Isolation Check**: Legacy keys don't gain extra permissions during expansion
- **Covers**: FR-22, backwards compatibility (Section 7 of feature spec), GAP-011
- **Note**: Step 1 uses direct DB insert (not API) because Phase 2 Zod schema only accepts dot-separated registry scopes. This is the correct approach for testing backwards compatibility of pre-existing data. Unknown scope expansion (fail-closed) tested at integration level in INT-15 since it also requires direct DB seeding.

### E2E-16: Scope registry discovery endpoint

- **Preconditions**: Authenticated user (any role)
- **Steps**:
  1. `GET /api/keys/scopes` with valid auth token
  2. Assert 200 response containing an array/object of scope definitions
  3. Assert each scope entry has: `scope` (string), `label` (string), `description` (string), `category` (string)
  4. Assert at least 10 scopes are present (per FR-18: workflows.execute, workflows.read, chat.execute, agents.read, agents.write, deployments.read, deployments.write, sessions.read, analytics.read, tenant.read)
  5. Assert categories include: `execution`, `management`, `analytics`, `admin`
  6. Assert `requiredPermissions` is NOT exposed in the response (internal detail)
  7. `GET /api/keys/scopes` with NO auth -> assert 401
- **Expected Result**: Scope registry discoverable by authenticated users; internal RBAC mapping not leaked
- **Auth Context**: Any authenticated user for success; unauthenticated for 401
- **Isolation Check**: No `requiredPermissions` exposed (prevents reverse-engineering of RBAC structure)
- **Covers**: FR-25, FR-17, FR-18

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests use the Studio API harness with MongoMemoryServer. They test route handler logic against real MongoDB with real auth middleware. No mocks of internal components.

### Phase 1 Integration Scenarios (DONE — INT-1 through INT-10)

### INT-1: POST /api/keys creates correct ApiKey document

- **Boundary**: Studio API route -> MongoDB (ApiKey model)
- **Setup**: Start harness, dev-login, create project
- **Steps**:
  1. `POST /api/keys` with `{ name: "Test Key", scopes: ["workflow:execute", "workflow:read"], projectIds: ["<projectId>"] }`
  2. Query MongoDB: `ApiKey.findOne({ name: "Test Key" })`
  3. Assert document has: `keyHash` (64-char hex), `prefix` (starts with `abl_`, 8 chars), `clientId` (starts with `plt-`), correct `scopes`, `projectIds`, `createdBy`, `tenantId`, `revokedAt: null`, `environments: []`
  4. Independently compute SHA-256 of the raw key from the POST response, verify it matches stored `keyHash`
- **Expected Result**: All fields correctly populated per FR-05 algorithm; hash matches runtime expectations
- **Failure Mode**: Incorrect hash algorithm or prefix length causes runtime auth failure
- **Covers**: FR-05, SEC-6

### INT-2: GET /api/keys filters by projectId, revoked, and expired

- **Boundary**: Studio API route -> MongoDB query
- **Setup**: Create 4 keys via POST:
  - Key A: active, `projectIds: [projX]` (should appear)
  - Key B: active, `projectIds: [projY]` (should NOT appear for projX)
  - Key C: revoked (`revokedAt` set), `projectIds: [projX]` (should NOT appear)
  - Key D: expired (`expiresAt` in past), `projectIds: [projX]` (should NOT appear)
- **Steps**:
  1. `GET /api/keys?projectId=<projX>`
  2. Assert response contains only Key A
- **Expected Result**: Correct filtering by projectId, revokedAt, and expiresAt
- **Failure Mode**: Missing filter condition leaks revoked/expired/cross-project keys
- **Covers**: FR-03, FR-13

### INT-3: PATCH /api/keys/:keyId updates name and scopes, rejects projectIds

- **Boundary**: Studio API route -> MongoDB update
- **Setup**: Create a key via POST
- **Steps**:
  1. `PATCH /api/keys/<keyId>` with `{ name: "New Name", scopes: ["workflow:read"] }`
  2. Assert 200 with updated fields
  3. Query MongoDB: verify `name` and `scopes` changed, `projectIds` unchanged
  4. `PATCH /api/keys/<keyId>` with `{ projectIds: ["other-project"] }` -> assert 400
- **Expected Result**: Name/scopes editable; projectIds immutable
- **Failure Mode**: Allowing projectIds edit widens key access scope (security)
- **Covers**: FR-10

### INT-4: DELETE /api/keys/:keyId soft-revokes, preserves document

- **Boundary**: Studio API route -> MongoDB update
- **Setup**: Create a key via POST
- **Steps**:
  1. `DELETE /api/keys/<keyId>` -> assert 200
  2. Query MongoDB: assert document exists with `revokedAt` set to a recent timestamp
  3. `DELETE /api/keys/<keyId>` again -> assert 404 (already revoked; `revokedAt: null` guard in query filter excludes revoked keys)
  4. Query MongoDB: assert `revokedAt` unchanged from step 2 (original timestamp preserved for audit trail)
- **Expected Result**: Soft-delete preserves document; second revoke returns 404 to preserve original `revokedAt` timestamp
- **Failure Mode**: Hard delete would break audit trail
- **Covers**: FR-11

### INT-5: Auth middleware rejects unauthenticated and unauthorized requests

- **Boundary**: Studio API route -> requireAuth + requireSdkProjectAccess
- **Setup**: Start harness, create project under tenant A
- **Steps**:
  1. `POST /api/keys` with NO auth header -> assert 401
  2. `POST /api/keys` with invalid JWT -> assert 401
  3. `GET /api/keys?projectId=<projA>` with valid JWT from tenant B -> assert 404
  4. `POST /api/keys` with valid JWT but user has no project membership -> assert 404
- **Expected Result**: Missing auth -> 401; wrong tenant/no access -> 404
- **Failure Mode**: Leaking 403 discloses resource existence
- **Covers**: FR-14

### INT-6: Zod validation rejects invalid payloads

- **Boundary**: Studio API route -> Zod schema validation
- **Setup**: Start harness, dev-login, create project
- **Steps**:
  1. `POST /api/keys` with missing `name` field -> assert 400
  2. `POST /api/keys` with `scopes: []` (empty) -> assert 400
  3. `POST /api/keys` with `scopes: ["admin:nuke"]` (unknown scope) -> assert 400
  4. `POST /api/keys` with `expiresAt: "not-a-date"` -> assert 400
  5. `GET /api/keys` with missing `projectId` query param -> assert 400
  6. All 400 responses must have `{ error: { code, message } }` shape (not empty `{}`)
- **Expected Result**: All invalid inputs rejected with structured error responses
- **Failure Mode**: Missing validation allows bad data in DB
- **Covers**: FR-07, FR-08, FR-14

### INT-7: Tenant isolation enforced at query level

- **Boundary**: Studio API route -> MongoDB query with tenantId filter
- **Setup**: Start harness, dev-login as two separate tenants, each creates a project and a platform key
- **Steps**:
  1. Tenant A creates a key in project A
  2. Tenant B attempts `GET /api/keys?projectId=<projectA>` -> assert 404
  3. Tenant B attempts `PATCH /api/keys/<keyA>` -> assert 404
  4. Tenant B attempts `DELETE /api/keys/<keyA>` -> assert 404
- **Expected Result**: All cross-tenant operations return 404 (tenantId filter prevents access)
- **Failure Mode**: Missing tenantId in query filter leaks keys across tenants
- **Covers**: FR-14, Core Invariant #1

### INT-8: 100-item safety cap on GET

- **Boundary**: Studio API route -> MongoDB query with .limit(100)
- **Setup**: Bulk-insert 105 active ApiKey documents via `ApiKey.insertMany()` (direct model access in test setup)
- **Steps**:
  1. `GET /api/keys?projectId=<projectId>`
  2. Assert response `keys` array length is exactly 100
- **Expected Result**: Safety cap prevents unbounded responses
- **Failure Mode**: Missing `.limit(100)` returns all 105 keys
- **Covers**: FR-13

### INT-9: Non-existent key returns 404 for PATCH and DELETE

- **Boundary**: Studio API route -> MongoDB query
- **Setup**: Start harness, dev-login, create project
- **Steps**:
  1. `PATCH /api/keys/nonexistent-uuid` with `{ name: "test" }` -> assert 404
  2. `DELETE /api/keys/nonexistent-uuid` -> assert 404
- **Expected Result**: Operations on non-existent keys return 404
- **Failure Mode**: Returning 200 for non-existent key is misleading
- **Covers**: FR-10, FR-11

### INT-10: Multi-project key appears in MongoDB with correct projectIds array

- **Boundary**: Studio API route -> MongoDB (ApiKey model)
- **Setup**: Start harness, dev-login, create two projects (X and Y)
- **Steps**:
  1. `POST /api/keys` with `{ name: "Multi Key", scopes: ["workflow:execute"], projectIds: ["<projectX>", "<projectY>"] }`
  2. Query MongoDB: `ApiKey.findOne({ name: "Multi Key" })`
  3. Assert `projectIds` array contains both `projectX` and `projectY`
  4. `GET /api/keys?projectId=<projectX>` -> assert key returned (matched via `$in`)
  5. `GET /api/keys?projectId=<projectY>` -> assert key returned (matched via `$in`)
- **Expected Result**: Multi-project key stored correctly and retrievable via either project
- **Failure Mode**: Incorrect `$in` query or single-value `projectIds` storage
- **Covers**: FR-09

### Phase 2 Integration Scenarios (PLANNED — INT-11 through INT-16)

### INT-11: Scope registry validation — Zod schema generated from registry

- **Boundary**: Studio API route -> Zod schema derived from `PLATFORM_KEY_SCOPES`
- **Setup**: Start harness, dev-login, create project
- **Steps**:
  1. `POST /api/keys` with `{ name: "Registry Key", scopes: ["workflows.execute"], projectIds: ["<projectId>"] }` -> assert 201 (new dot-separated scope accepted)
  2. `POST /api/keys` with `{ name: "Multi Scope", scopes: ["agents.read", "sessions.read"], projectIds: ["<projectId>"] }` -> assert 201 (any valid registry scopes accepted, if user has ceiling)
  3. `POST /api/keys` with `{ name: "Invalid", scopes: ["invalid.scope"], projectIds: ["<projectId>"] }` -> assert 400 (not in registry)
  4. `POST /api/keys` with `{ name: "Mixed", scopes: ["workflows.execute", "not.real"], projectIds: ["<projectId>"] }` -> assert 400 (one invalid scope fails entire request)
  5. Query MongoDB after step 1: verify `scopes` field stores `["workflows.execute"]` (dot-separated, not expanded)
- **Expected Result**: Only registry-defined scopes accepted; scopes stored as-is (expansion happens at runtime, not at creation)
- **Failure Mode**: Hardcoded Zod enum rejects new scopes; or scopes expand prematurely at creation time
- **Covers**: FR-17, FR-18, FR-21

### INT-12: Ceiling check — VIEWER role blocked from agents.write

- **Boundary**: Studio API route -> `getPermissionCeiling(tenantRole)` + `hasPermission()` -> MongoDB
- **Setup**: Start harness. Create tenant with OWNER user A and VIEWER user B (via workspace invite). Create project accessible to both.
- **Steps**:
  1. User B (VIEWER): `POST /api/keys` with `{ name: "Viewer Key", scopes: ["agents.write"], projectIds: ["<projectId>"] }` -> assert **403**
  2. Assert response: `{ error: "Scope ceiling exceeded", code: "SCOPE_CEILING_EXCEEDED", denied: ["agents.write"] }`
  3. Query MongoDB: verify NO new ApiKey document was created (ceiling check rejects before DB write)
  4. User A (OWNER): `POST /api/keys` with same payload -> assert **201** (OWNER has all permissions via `*:*`)
- **Expected Result**: Ceiling check prevents VIEWER from granting scopes requiring `agent:create`; OWNER bypasses via wildcard
- **Failure Mode**: Missing ceiling check allows privilege escalation; check happens after DB write (partial state)
- **Covers**: FR-19

### INT-13: Ceiling check — 5 role combinations coverage

- **Boundary**: Studio API route -> ceiling check logic
- **Setup**: Start harness. Create 5 users with different tenant roles: VIEWER, MEMBER, OPERATOR, ADMIN, OWNER. Each user has project access.
- **Steps**:
  1. VIEWER + `agents.write` scope -> assert **403** (requires `agent:create`, only ADMIN+ has it)
  2. OPERATOR + `workflows.execute` scope -> assert **201** (OPERATOR has `workflow:execute` L66-67)
  3. MEMBER + `workflows.execute` scope -> assert **403** (MEMBER lacks `workflow:execute`)
  4. ADMIN + `analytics.read` scope -> assert **403** (`analytics:read` not in ADMIN role; only OWNER via `*:*`)
  5. OWNER + all 10 scopes simultaneously -> assert **201** (OWNER has `*:*` wildcard)
- **Expected Result**: Each role combination correctly evaluated against `getPermissionCeiling()`
- **Failure Mode**: Incorrect permission mapping or missing wildcard handling
- **Covers**: FR-19, FR-18

### INT-14: PATCH ceiling check blocks scope escalation

- **Boundary**: Studio API route -> ceiling check -> MongoDB update
- **Setup**: Start harness. OPERATOR user creates key with `workflows.execute` (allowed).
- **Steps**:
  1. OPERATOR: `POST /api/keys` with `{ scopes: ["workflows.execute"] }` -> assert 201
  2. OPERATOR: `PATCH /api/keys/<keyId>` with `{ scopes: ["workflows.execute", "agents.write"] }` -> assert **403**
  3. Query MongoDB: verify key still has `scopes: ["workflows.execute"]` (unchanged)
  4. OPERATOR: `PATCH /api/keys/<keyId>` with `{ scopes: ["workflows.execute", "workflows.read"] }` -> assert **200** (OPERATOR has both)
  5. Query MongoDB: verify key now has `scopes: ["workflows.execute", "workflows.read"]`
- **Expected Result**: PATCH applies ceiling check to the new scope set, not just the delta
- **Failure Mode**: PATCH only checks new scopes (not full set), allowing escalation by keeping existing scopes
- **Covers**: FR-20

### INT-15: resolveApiKey scope expansion with real MongoDB

- **Boundary**: Runtime auth repo -> MongoDB (ApiKey model) -> scope expansion logic
- **Setup**: Start harness. Create keys with different scope combinations via API. The `resolveApiKey` function signature is `resolveApiKey(keyHash: string, prefix: string)` — callers must compute `SHA-256(rawKey)` and extract the 8-char prefix before calling.
- **Steps**:
  1. Create key with `scopes: ["workflows.execute"]` via POST, capture raw key
  2. Compute `keyHash = SHA-256(rawKey)`, extract `prefix = rawKey.slice(0, 8)`, call `resolveApiKey(keyHash, prefix)`
  3. Assert returned record has expanded permissions: `["workflow:read", "workflow:execute"]`
  4. Create key with `scopes: ["agents.read", "deployments.write"]` via POST, capture raw key
  5. Compute hash/prefix, call `resolveApiKey(keyHash2, prefix2)`
  6. Assert expanded permissions: `["agent:read", "deployment:read", "deployment:create"]` (deduplicated)
  7. Insert legacy key directly with `scopes: ["workflow:execute"]` (colon-separated) — direct DB insert required to simulate pre-Phase 2 keys
  8. Call `resolveApiKey(legacyKeyHash, legacyPrefix)`
  9. Assert permissions: `["workflow:execute"]` (passthrough, no expansion)
  10. Insert key with `scopes: ["unknown.scope"]` — direct DB insert (API would reject unknown scopes)
  11. Call `resolveApiKey(unknownKeyHash, unknownPrefix)`
  12. Assert permissions: `[]` (fail-closed)
  13. Assert a warning was logged for the unknown scope
- **Expected Result**: Expansion works for dot-separated (registry lookup), colon-separated (passthrough), and unknown (empty + warning)
- **Failure Mode**: Missing expansion logic causes 403 at runtime; missing passthrough breaks Phase 1 keys
- **Covers**: FR-22, FR-24
- **Note**: Steps 7 and 10 use direct DB insert (via Mongoose model) because these edge cases cannot be created through the Phase 2 API. This is acceptable at integration level per E2E/integration test boundary rules.

### INT-16: GET /api/keys/scopes returns registry without internal fields

- **Boundary**: Studio API route -> scope registry constant
- **Setup**: Start harness, dev-login
- **Steps**:
  1. `GET /api/keys/scopes` with valid auth -> assert 200
  2. Assert response contains at least 10 scope entries
  3. Assert each entry has `scope`, `label`, `description`, `category` fields
  4. Assert NO entry has `requiredPermissions` field (internal detail, not exposed)
  5. Assert response shape is consistent (all entries have same keys)
  6. `GET /api/keys/scopes` with no auth -> assert 401
- **Expected Result**: Registry exposed for UI consumption without leaking RBAC mapping
- **Failure Mode**: Leaking `requiredPermissions` reveals internal RBAC structure
- **Covers**: FR-25

---

## 4. Unit Test Scenarios

### Phase 1 Unit Tests (DONE — UT-1 through UT-4)

### UT-1: Key generation algorithm

- **Module**: Key generation utility (extracted from route handler)
- **Input**: `crypto.randomBytes(24)` with known return value
- **Expected Output**:
  - `rawKey`: starts with `abl_`, followed by 48 hex chars
  - `prefix`: first 8 chars of rawKey (e.g., `abl_a1b2`)
  - `keyHash`: SHA-256 hex of rawKey string (deterministic, verifiable)

### UT-2: Scope validation function

- **Module**: Scope validation utility
- **Input/Expected**:
  - `["workflow:execute"]` -> valid
  - `["workflow:execute", "workflow:read"]` -> valid
  - `["admin:delete"]` -> invalid
  - `[]` -> invalid (empty)
  - `["workflow:execute", "admin:delete"]` -> invalid (one bad scope)

### UT-3: Expiration date calculation from presets

- **Module**: Expiration resolver utility
- **Input/Expected**:
  - `"none"` -> `null`
  - `"30d"` -> `Date.now() + 30 * 24 * 60 * 60 * 1000` (within 1s tolerance)
  - `"90d"` -> `Date.now() + 90 * 24 * 60 * 60 * 1000` (within 1s tolerance)
  - `"custom"` with ISO date -> parsed `Date` object

### UT-4: ClientId generation format

- **Module**: ClientId generator
- **Input**: Called without arguments
- **Expected Output**: String matching pattern `plt-<uuidv7>` where the uuidv7 portion is a valid UUIDv7

### Phase 2 Unit Tests (PLANNED — UT-5 through UT-8)

### UT-5: Scope registry completeness and structure

- **Module**: `packages/shared-auth/src/scopes/platform-key-scopes.ts`
- **Input**: Import `PLATFORM_KEY_SCOPES` constant
- **Expected**:
  - Registry contains at least 10 scope entries
  - Every entry has `scope`, `label`, `description`, `category`, `requiredPermissions` fields
  - `scope` uses dot-separated format (matches `/^\w+\.\w+$/`)
  - `category` is one of: `execution`, `management`, `analytics`, `admin`
  - `requiredPermissions` is a non-empty array of colon-separated RBAC permissions
  - All `requiredPermissions` values exist in `PERMISSION_REGISTRY` from `role-permissions.ts` (verified via import)
  - No duplicate scope keys

### UT-6: Scope registry category grouping

- **Module**: `packages/shared-auth/src/scopes/platform-key-scopes.ts`
- **Input**: Group scopes by `category`
- **Expected**:
  - `execution` category contains: `workflows.execute`, `workflows.read`, `chat.execute`
  - `management` category contains: `agents.read`, `agents.write`, `deployments.read`, `deployments.write`, `sessions.read`
  - `analytics` category contains: `analytics.read`
  - `admin` category contains: `tenant.read`

### UT-7: Ceiling check pure function

- **Module**: `packages/shared-auth/src/scopes/scope-validation.ts` — `checkScopeCeiling()`
- **Input/Expected** (all using real `getPermissionCeiling()` and `hasPermission()`). Return type is a discriminated union: `{ allowed: true }` on success, `{ allowed: false, denied: string[] }` on failure.
  - `checkScopeCeiling(['workflows.read'], 'viewer')` -> `{ allowed: true }`
  - `checkScopeCeiling(['agents.write'], 'viewer')` -> `{ allowed: false, denied: ['agents.write'] }`
  - `checkScopeCeiling(['workflows.execute'], 'operator')` -> `{ allowed: true }`
  - `checkScopeCeiling(['workflows.execute'], 'member')` -> `{ allowed: false, denied: ['workflows.execute'] }`
  - `checkScopeCeiling(['analytics.read'], 'admin')` -> `{ allowed: false, denied: ['analytics.read'] }`
  - `checkScopeCeiling(['workflows.execute', 'agents.read', 'analytics.read', 'tenant.read', 'deployments.write', 'sessions.read', 'agents.write', 'deployments.read', 'workflows.read', 'chat.execute'], 'owner')` -> `{ allowed: true }` (OWNER has `*:*`)
  - `checkScopeCeiling(['agents.write', 'analytics.read'], 'admin')` -> `{ allowed: false, denied: ['analytics.read'] }` (partial denial — only the failing scopes listed)

### UT-8: Scope expansion pure function

- **Module**: `packages/shared-auth/src/scopes/scope-validation.ts` — `expandScopesToPermissions()`
- **Input/Expected**:
  - `expandScopesToPermissions(['workflows.execute'])` -> `['workflow:read', 'workflow:execute']`
  - `expandScopesToPermissions(['agents.read', 'agents.write'])` -> `['agent:read', 'agent:create', 'agent:update']` (deduplicated — `agent:read` appears in both but listed once)
  - `expandScopesToPermissions(['workflow:execute'])` -> `['workflow:execute']` (colon-separated passthrough)
  - `expandScopesToPermissions(['unknown.scope'])` -> `[]` (unknown scopes grant nothing)
  - `expandScopesToPermissions(['workflows.execute', 'workflow:read'])` -> `['workflow:read', 'workflow:execute']` (mixed formats, deduplicated)
  - `expandScopesToPermissions([])` -> `[]` (empty input)

---

## 5. Security & Isolation Tests

### Phase 1 Security Tests (DONE)

### SEC-1: Cross-tenant key access returns 404

- **Test**: Tenant B attempts GET/PATCH/DELETE on tenant A's key
- **Expected**: 404 on all operations (not 403 -- no existence disclosure)
- **Implementation**: Part of E2E-3

### SEC-2: Cross-project key visibility

- **Test**: Key scoped to project X not visible when querying project Y
- **Expected**: Empty list, not 404 (the project exists, just no keys match)
- **Implementation**: Part of E2E-4

### SEC-3: Unauthenticated access returns 401

- **Test**: All 4 endpoints (GET, POST, PATCH, DELETE) called without auth header
- **Expected**: 401 on all
- **Implementation**: Part of E2E-8

### SEC-4: Raw key never retrievable after creation

- **Test**: Create key via POST (raw key in response). Call GET list. Call PATCH. Verify no response ever includes the raw `key` field again.
- **Expected**: Only POST response contains `key`; all subsequent responses have `prefix` only
- **Implementation**: Part of E2E-1

### SEC-5: Scope injection prevention

- **Test**: POST with scopes containing injection-style values (`["workflow:execute; DROP TABLE"]`, `["__proto__"]`)
- **Expected**: 400 validation error (Zod rejects unknown scopes)
- **Implementation**: Part of INT-6

### SEC-6: Key hash correctness (runtime compatibility)

- **Test**: Create key via POST, extract raw key, compute SHA-256 hash independently, verify it matches the stored `keyHash` in MongoDB
- **Expected**: Hashes match so key will work with runtime resolveApiKey
- **Implementation**: Part of INT-1

### Phase 2 Security Tests (PLANNED)

### SEC-7: Privilege escalation via scope — ceiling check

- **Test**: VIEWER creates key with `agents.write` scope (requires ADMIN+ permissions)
- **Expected**: 403 with structured error listing denied scopes; no key created in DB
- **Implementation**: Part of E2E-11, INT-12

### SEC-8: Privilege escalation via PATCH — scope upgrade

- **Test**: OPERATOR creates key with `workflows.execute`, then PATCHes to add `agents.write`
- **Expected**: 403 on PATCH; original scopes preserved
- **Implementation**: Part of E2E-13, INT-14

### SEC-9: RBAC mapping not leaked via scopes endpoint

- **Test**: `GET /api/keys/scopes` returns scope metadata but NOT `requiredPermissions`
- **Expected**: Response contains `scope`, `label`, `description`, `category` only; no RBAC details
- **Implementation**: Part of E2E-16, INT-16

### SEC-10: Fail-closed for unknown scopes at runtime

- **Test**: Key with unknown scope string goes through `resolveApiKey`
- **Expected**: Unknown scope expands to zero permissions (fail-closed); warning logged
- **Implementation**: Part of E2E-15, INT-15

### SEC-11: Cross-tenant ceiling check isolation

- **Test**: Tenant A's ADMIN creates a key. Tenant B's ADMIN attempts to create a key referencing Tenant A's project.
- **Expected**: 404 (tenant isolation prevents access regardless of ceiling result)
- **Implementation**: Part of INT-7 (tenant isolation test covers this — ceiling check only runs after tenant scope verification)

---

## 6. Performance & Load Tests

Not required for v1. Platform keys are low-cardinality (tens per project). The 100-item safety cap (INT-8) provides a ceiling. Scope expansion is an in-memory map lookup (sub-microsecond). Ceiling check uses in-memory `hasPermission()` (no DB queries). Performance testing deferred until usage metrics justify it.

---

## 7. Test Infrastructure

### Required Services

- **MongoMemoryServer**: In-process MongoDB (provided by `startStudioApiHarness()`)
- **No Redis**: Feature does not use Redis
- **No Docker**: All tests run in-process
- **No external services**: Zero third-party dependencies to mock

### Data Seeding

All seeding done via API calls through the harness, with specific exceptions for edge cases:

1. `POST /api/auth/dev-login` -> creates user + tenant, returns JWT
2. `POST /api/projects` -> creates project under the tenant
3. For cross-tenant tests: second dev-login with different email
4. For role-based tests (Phase 2): workspace invitation + role assignment via API
5. Direct model insert ONLY for: INT-8 (bulk 105 keys), INT-15 (legacy colon-separated scopes, unknown scopes — cannot be created via Phase 2 API)

### Role Setup for Phase 2 Ceiling Tests

Ceiling check tests require users with specific tenant roles (VIEWER, MEMBER, OPERATOR, ADMIN, OWNER). Setup via:

1. User A: `POST /api/auth/dev-login` -> OWNER (default for workspace creator)
2. User B (VIEWER): Invite via workspace invitations API (`POST /api/workspaces/:tenantId/invitations` with `{ email: "viewer@test.com", role: "viewer" }`), then `POST /api/auth/dev-login` as User B (dev-login auto-accepts via `resolveUserContextOrAutoAcceptInvite`)
3. User C (OPERATOR): Same invitation pattern with `role: 'operator'`
4. User D (ADMIN): Same invitation pattern with `role: 'admin'`
5. User E (MEMBER): Same invitation pattern with `role: 'member'`

The workspace invitations route (`/api/workspaces/:tenantId/invitations`) is already mounted in the test harness. No additional route mounting needed for role assignment.

### Environment Variables

Set by `startStudioApiHarness()` automatically:

| Variable      | Test Value                          | Notes                          |
| ------------- | ----------------------------------- | ------------------------------ |
| `MONGODB_URL` | `mongodb://localhost:<random>/test` | MongoMemoryServer URL          |
| `JWT_SECRET`  | `test-secret`                       | For dev-login token generation |
| `NODE_ENV`    | `test`                              | Standard test mode             |

### CI Configuration

No special CI changes needed. Tests run with `pnpm test --filter=@agent-platform/studio`. MongoMemoryServer downloads MongoDB binary on first run (cached in CI).

### Harness Extension Required

The existing `startStudioApiHarness()` needs routes mounted for Phase 2:

```typescript
// Add to importStudioSdkRoutes():
const platformKeysScopesRoute = await import('../../app/api/keys/scopes/route');

// Add to mountSdkRoutes():
wrapRoute(app, '/api/keys/scopes', platformKeysScopesRoute);
```

Phase 1 routes (`/api/keys`, `/api/keys/:keyId`) are already mounted. Role-based test setup uses the already-mounted `/api/workspaces/:tenantId/invitations` route with `role` parameter. Dev-login as the invitee auto-accepts via `resolveUserContextOrAutoAcceptInvite`. No additional route mounting needed for role assignment.

---

## 8. Test File Mapping

| Test File                                                        | Type        | Covers                                                                                   |
| ---------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/platform-keys-api.test.ts`            | integration | Phase 1 INT-1 to INT-10 (DONE) + Phase 2 INT-11 to INT-16                                |
| `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`        | e2e         | Phase 1 E2E-1 to E2E-10 (DONE) + Phase 2 E2E-11 to E2E-16                                |
| `apps/studio/src/__tests__/platform-keys-unit.test.ts`           | unit        | Phase 1 UT-1 to UT-4 (DONE)                                                              |
| `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts` | unit        | **NEW** — Phase 2 UT-5 to UT-8 (scope registry, ceiling check, expansion pure functions) |

---

## 9. Open Testing Questions

1. Should we add a Playwright browser E2E test for the tabbed UI (FR-01, FR-04, FR-12, FR-23), or is manual verification sufficient for the UI components?
2. The `startStudioApiHarness()` role-based testing (VIEWER, MEMBER, OPERATOR roles) requires workspace invitation flow. Is this fully functional in the harness, or does it need new helper functions?
3. E2E-14 requires a runtime HTTP server alongside Studio. If a runtime harness isn't practical for Phase 2, the test defers to INT-15 (direct function call) with reduced confidence. Should we invest in a dual-harness (Studio + Runtime)?
4. `chat.execute`, `sessions.read`, and `analytics.read` scopes are OWNER-only due to GAP-012 (tenant-only ceiling). Should ceiling tests for these scopes be marked as "expected to change" when project-level ceiling is added?
5. Should backwards compatibility tests (E2E-15, INT-15) be tagged as regression tests that run on every PR, or only on changes touching the scope expansion code path?
6. E2E-15 assumes Phase 2 Zod schema accepts both legacy colon-separated and new dot-separated scopes for backwards compatibility at creation time. If the implementation restricts creation to registry keys only (dot-separated), steps 1-2 should use direct DB insert (per INT-15 pattern). The feature spec's backwards compat section (Section 7) only addresses runtime expansion, not creation-time acceptance — this needs a design decision during LLD.
7. Dev-login rate limiter may trigger 429 after ~10 calls per harness session. INT-13 alone requires 5 role-specific dev-login calls, plus E2E-11/12/13 add more. Tests should consolidate dev-login calls and share workspace/project setups across related test cases. See `apps/studio/agents.md` platform keys learnings.
