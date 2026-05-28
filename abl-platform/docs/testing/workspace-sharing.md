# Test Spec: Workspace Sharing

**Feature**: Workspace member management, invitation lifecycle, and workspace switching
**Feature Spec**: [docs/features/workspace-sharing.md](../features/workspace-sharing.md)
**Owner**: Platform team
**Status**: IN PROGRESS
**Last Updated**: 2026-04-16

---

## Coverage Matrix

| FR    | Description                                     | Unit | Integration | E2E | Manual | Status         |
| ----- | ----------------------------------------------- | ---- | ----------- | --- | ------ | -------------- |
| FR-1  | Owners/admins list members and invitations      | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-2  | Create, resend, revoke, accept invitations      | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-3  | Role hierarchy enforcement                      | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-4  | Discover and accept invitations (token/ID)      | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-5  | List workspaces and switch tenant context       | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-6  | Audit logging for membership/invitation actions | N    | N           | N   | Y      | NOT TESTED     |
| FR-7  | Cryptographic token generation and hash storage | Y    | N           | N   | N      | PARTIAL        |
| FR-8  | Reject invite for existing member               | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-9  | Reject duplicate pending invitation             | Y    | N           | N   | N      | PARTIAL (unit) |
| FR-10 | TTL-based invitation expiry                     | N    | N           | N   | N      | NOT TESTED     |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Full Invitation Lifecycle via HTTP API

**Preconditions**: Two user accounts exist. User A owns a workspace. User B has no workspace membership.

**Steps**:

1. `POST /api/workspaces/:tenantId/invitations` as User A (OWNER) — invite User B's email as MEMBER
2. `GET /api/workspaces/:tenantId/invitations` as User A — verify invitation appears with status `pending`
3. `GET /api/invitations/pending` as User B — verify invitation appears in pending list
4. `POST /api/invitations/accept-by-id` as User B with the invitation ID
5. `GET /api/workspaces/:tenantId/members` as User A — verify User B now appears as MEMBER
6. `GET /api/auth/tenants` as User B — verify the new workspace appears in the list

**Expected Result**: User B becomes a member of User A's workspace with MEMBER role. A new JWT token pair is issued.

**Auth Context**: User A = OWNER of tenant-001. User B = authenticated user with no tenant membership.

**Isolation Check**: User B cannot see members of a different tenant (tenant-002) — must return 404.

### E2E-2: Role Hierarchy Enforcement Across All Roles

**Preconditions**: Workspace with OWNER (User A), ADMIN (User B), MEMBER (User C).

**Steps**:

1. `POST /api/workspaces/:tenantId/invitations` as User B (ADMIN) with role=OWNER — expect 403
2. `POST /api/workspaces/:tenantId/invitations` as User B (ADMIN) with role=ADMIN — expect 201
3. `POST /api/workspaces/:tenantId/invitations` as User B (ADMIN) with role=MEMBER — expect 201
4. `POST /api/workspaces/:tenantId/invitations` as User C (MEMBER) with any role — expect 403
5. `PATCH /api/workspaces/:tenantId/members/:userId` as User B (ADMIN) changing User C to OWNER — expect 403
6. `DELETE /api/workspaces/:tenantId/members/:ownerId` as User B (ADMIN) removing User A (OWNER) — expect 403

**Expected Result**: ADMINs cannot invite OWNERs or escalate roles beyond their own. MEMBERs cannot create invitations or modify memberships.

**Auth Context**: Three users with different roles in the same tenant.

**Isolation Check**: All operations must include tenantId in the request path and fail for mismatched tenantIds.

### E2E-3: Cross-Tenant Isolation for Membership and Invitations

**Preconditions**: Two tenants (tenant-001, tenant-002). User A is OWNER of tenant-001. User B is OWNER of tenant-002.

**Steps**:

1. `GET /api/workspaces/tenant-002/members` as User A (OWNER of tenant-001) — expect 404
2. `POST /api/workspaces/tenant-002/invitations` as User A — expect 404 or 403
3. `GET /api/workspaces/tenant-002/invitations` as User A — expect 404 or 403
4. `DELETE /api/workspaces/tenant-002/members/:userId` as User A — expect 404 or 403
5. `GET /api/workspaces/tenant-001/members` as User B (OWNER of tenant-002) — expect 404

**Expected Result**: No cross-tenant access is possible. Responses do not leak existence of other tenants.

**Auth Context**: Each user authenticates with a JWT scoped to their own tenant.

**Isolation Check**: This IS the isolation test — cross-tenant returns 404 (not 403) to prevent existence leakage.

### E2E-4: Workspace Switching with JWT Re-issuance

**Preconditions**: User A is a member of two workspaces (tenant-001 as OWNER, tenant-002 as MEMBER).

**Steps**:

1. `GET /api/auth/tenants` as User A — expect both workspaces listed with correct roles
2. `POST /api/auth/tenants/switch` as User A with `{ tenantId: "tenant-002" }` — expect new accessToken
3. Decode the new accessToken and verify `tenantId` = tenant-002 and `role` = MEMBER
4. `POST /api/auth/tenants/switch` as User A with `{ tenantId: "tenant-nonexistent" }` — expect 403
5. `POST /api/auth/tenants/switch` as User A with `{ tenantId: "" }` — expect 400

**Expected Result**: Switching workspaces issues a new JWT scoped to the target tenant. Invalid switches fail cleanly.

**Auth Context**: User A with membership in two tenants.

**Isolation Check**: After switching, subsequent requests should be scoped to the new tenant context.

### E2E-5: Invitation Acceptance by Raw Token

**Preconditions**: User A (OWNER) creates an invitation. User B receives the token (simulated).

**Steps**:

1. `POST /api/workspaces/:tenantId/invitations` as User A — create invitation for User B's email
2. Extract the invitation token from the response (or from the invitation record)
3. `GET /api/invitations/:token` — verify invitation details are returned (public lookup)
4. `POST /api/invitations/accept` as User B with `{ token: "<raw-token>" }` — expect success
5. `GET /api/workspaces/:tenantId/members` as User A — verify User B is now listed
6. `POST /api/invitations/accept` as User B with the same token — expect 400 "already been used"

**Expected Result**: Token-based acceptance creates membership and prevents double acceptance.

**Auth Context**: User B must be authenticated and their email must match the invitation email.

**Isolation Check**: Acceptance with a mismatched email returns 400 "different email address".

### E2E-6: Expired Invitation Rejection

**Preconditions**: An invitation is created with a short TTL (or manually expired).

**Steps**:

1. Create an invitation record directly in the database with `expiresAt` set to a past date
2. `GET /api/invitations/pending` as the invited user — verify the expired invitation does not appear (or appears as expired)
3. `POST /api/invitations/accept-by-id` with the expired invitation ID — expect 400 "invitation has expired"

**Expected Result**: Expired invitations cannot be accepted.

**Auth Context**: Authenticated user whose email matches the invitation.

**Isolation Check**: N/A (this tests temporal validity, not isolation).

### E2E-7: Invitation Revocation and Re-invitation

**Preconditions**: User A (OWNER) has created an invitation for User B.

**Steps**:

1. `GET /api/workspaces/:tenantId/invitations` as User A — verify invitation exists
2. `DELETE /api/workspaces/:tenantId/invitations/:invitationId` as User A — revoke it
3. `GET /api/workspaces/:tenantId/invitations` as User A — verify invitation status is revoked
4. `POST /api/invitations/accept-by-id` as User B with the revoked invitation ID — expect 400
5. `POST /api/workspaces/:tenantId/invitations` as User A — re-invite User B
6. `GET /api/invitations/pending` as User B — verify new invitation appears

**Expected Result**: Revoked invitations cannot be accepted. New invitations can be created after revocation.

**Auth Context**: User A as OWNER, User B as the invited user.

**Isolation Check**: Revocation is scoped to the tenant — cannot revoke invitations in other tenants.

---

## Integration Test Scenarios (Minimum 5)

### INT-1: invitation-service.ts — Create Invitation with Role Hierarchy

**Boundary**: invitation-service.ts -> workspace-repo.ts -> MongoDB

**Setup**: MongoDB instance with seeded tenant, users, and memberships.

**Steps**:

1. Call `createInvitation({ tenantId, email, role: 'MEMBER', invitedBy: ownerId })` — expect success
2. Call `createInvitation({ tenantId, email: sameEmail, role: 'MEMBER', invitedBy: ownerId })` — expect error (duplicate)
3. Call `createInvitation({ tenantId, email, role: 'OWNER', invitedBy: adminId })` — expect error (hierarchy)
4. Verify the invitation record in MongoDB has a SHA-256 hashed token
5. Verify the invitation email was sent (mock email service)

**Expected Result**: Service enforces uniqueness, hierarchy, and produces hashed tokens.

**Failure Mode**: If MongoDB is down, the create call should throw (not silently succeed).

### INT-2: invitation-service.ts — Accept Invitation with Membership Creation

**Boundary**: invitation-service.ts -> workspace-repo.ts -> MongoDB

**Setup**: Existing pending invitation in MongoDB.

**Steps**:

1. Call `acceptInvitation(rawToken, userId, userEmail)` — expect success with tenantId and role
2. Verify a TenantMember record was created in MongoDB
3. Verify the invitation status changed to 'accepted' with acceptedAt and acceptedBy
4. Call `acceptInvitation(rawToken, userId, userEmail)` again — expect error "already been used"
5. Call `acceptInvitation(rawToken, userId, wrongEmail)` — expect error "different email"

**Expected Result**: Acceptance atomically creates membership and updates invitation status.

**Failure Mode**: If member creation fails, the invitation status should not be marked as accepted (partial state risk documented in code).

### INT-3: workspace-repo.ts — createWorkspaceWithOwner Transaction

**Boundary**: workspace-repo.ts -> MongoDB (multi-document transaction)

**Setup**: Clean MongoDB state.

**Steps**:

1. Call `createWorkspaceWithOwner(tenantData, { role: 'OWNER' })` — expect tenant + member + roles created
2. Verify the tenant record exists with correct slug and ownerId
3. Verify a TenantMember record exists linking the owner to the tenant
4. Verify SYSTEM_ROLES (5 roles) were seeded as RoleDefinition records for this tenant
5. Verify idempotency: creating a workspace with a duplicate slug fails cleanly

**Expected Result**: Transaction creates all three record types atomically.

**Failure Mode**: If the transaction fails mid-way, no partial records should exist.

### INT-4: auth-service.ts — switchTenant Membership Verification

**Boundary**: auth-service.ts -> workspace-repo.ts -> MongoDB + JWT issuance

**Setup**: User with memberships in two tenants.

**Steps**:

1. Call `switchTenant(user, tenantId1)` — expect new access token scoped to tenant-001
2. Decode the returned token and verify tenant context fields
3. Call `switchTenant(user, nonMemberTenantId)` — expect error "Not a member of this tenant"
4. Verify the error does not leak the existence of the target tenant

**Expected Result**: Switch only succeeds for tenants where the user has membership.

**Failure Mode**: If the JWT signing key is misconfigured, the function should throw rather than return an invalid token.

### INT-5: Member Management — Role Change and Removal Constraints

**Boundary**: workspaces/[tenantId]/members route handlers -> workspace-repo.ts -> MongoDB

**Setup**: Workspace with OWNER, ADMIN, and MEMBER users.

**Steps**:

1. As OWNER, change MEMBER to VIEWER — expect success
2. As OWNER, change ADMIN to MEMBER — expect success
3. As ADMIN, change MEMBER to VIEWER — expect success
4. As ADMIN, change MEMBER to OWNER — expect 403
5. As ADMIN, remove OWNER — expect 403
6. As MEMBER, change any role — expect 403
7. As OWNER, remove self — expect 400

**Expected Result**: Role hierarchy is enforced at every mutation point.

**Failure Mode**: If the membership lookup returns stale data (e.g., cached), hierarchy checks may pass incorrectly.

### INT-6: Invitation Route — Dual Enforcement of Role Hierarchy

**Boundary**: invitations route handler + invitation-service.ts

**Setup**: Workspace with ADMIN and OWNER users.

**Steps**:

1. Via route handler `POST /api/workspaces/:tenantId/invitations` as ADMIN, invite with role=OWNER — expect 403
2. Via invitation-service `createInvitation()` as ADMIN, invite with role=OWNER — expect error
3. Verify both enforcement points block the same escalation patterns

**Expected Result**: Role hierarchy is consistently enforced at both the route and service layers.

**Failure Mode**: If one layer is bypassed (e.g., direct service call from another code path), the other layer must still block escalation.

---

## Unit Test Scenarios

### UNIT-1: Token Hashing

**Module**: `apps/studio/src/lib/token-hash.ts`
**Input**: A raw token string (e.g., 64-byte hex)
**Expected Output**: SHA-256 hash of the input, consistent across calls with the same input.

### UNIT-2: Slug Generation

**Module**: `apps/studio/src/services/workspace-service.ts`
**Input**: Workspace name "My Team Workspace"
**Expected Output**: Slug like "my-team-workspace" or "my-team-workspace-<suffix>" if duplicate.

### UNIT-3: Invitation Email Template

**Module**: `packages/shared/src/services/email-templates.ts`
**Input**: `{ inviterName, workspaceName, role, acceptUrl }`
**Expected Output**: HTML email with all parameters interpolated, including the accept link.

### UNIT-4: Role Hierarchy Validation

**Module**: Route handler inline logic + invitation-service.ts
**Input**: Various inviter role + target role combinations
**Expected Output**: OWNER can invite any role. ADMIN can invite ADMIN/OPERATOR/MEMBER/VIEWER but not OWNER. Others cannot invite.

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 404 (E2E-3)
- [ ] Cross-project access returns 404 — N/A (feature is tenant-scoped, not project-scoped)
- [ ] Cross-user access returns 404 (for user-owned resources) — Invitation acceptance verifies email match
- [x] Missing auth returns 401 — All routes use `requireAuth()`
- [x] Insufficient permissions returns 403 — Role hierarchy enforcement (E2E-2)
- [x] Input validation rejects malformed data — Email validation, role enum validation

---

## Performance & Load Tests

Not applicable for the current scope. The feature is CRUD-oriented with low throughput requirements. If workspace size grows beyond 1000 members, member listing pagination should be tested.

---

## Test Infrastructure

### Required Services

- MongoDB (via MongoMemoryServer for unit/integration tests, or Docker for E2E)
- Studio app server on random port for E2E tests

### Data Seeding Strategy

- Create tenant via `createWorkspaceWithOwner()`
- Create users via direct model insertion
- Create memberships via `createTenantMember()`
- Create invitations via `createInvitation()` from workspace-repo

### Environment Variables

| Variable       | Value                   | Purpose                          |
| -------------- | ----------------------- | -------------------------------- |
| `FRONTEND_URL` | `http://localhost:PORT` | Invitation email link generation |
| `JWT_SECRET`   | test-secret             | Token signing for test auth      |
| `MONGODB_URI`  | from test setup         | Database connection              |

### CI Configuration

- Tests run as part of `apps/studio` test suite
- E2E tests should be tagged and runnable separately
- MongoDB memory server for fast CI execution

---

## Test File Mapping

| Test File                                                                  | Type             | Covers                                                                 |
| -------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-routes/api-org-routes.test.ts`              | unit/harness     | Workspace members + invitations route contracts                        |
| `apps/studio/src/__tests__/invitation-service.test.ts`                     | unit             | Invitation lifecycle service rules                                     |
| `apps/studio/src/__tests__/auth-services.test.ts`                          | unit             | Tenant switching, auth token context, invitation-related auth flows    |
| `apps/studio/src/__tests__/workspace-admin-pages.e2e.test.ts`              | UI fetch harness | Workspace-admin page request construction and response handling        |
| `apps/studio/src/__tests__/api-routes/api-workspace-lifecycle-e2e.test.ts` | route harness    | Workspace/user lifecycle invariants and tenant isolation               |
| `apps/studio/src/__tests__/components/admin-sidebar-access.test.tsx`       | unit             | UI regression: workspace-admin navigation hidden for non-admin members |

---

## Open Testing Questions

1. Can the invitation token-based acceptance flow be tested end-to-end without actually sending an email? The token would need to be extracted from the database or returned in the API response during test mode.
2. Should the TTL expiry (FR-10) be tested by manipulating MongoDB TTL index behavior or by setting short expiry times in test configuration?
3. Is there a test helper for creating authenticated request contexts (JWT with specific tenant/role) for E2E tests?
