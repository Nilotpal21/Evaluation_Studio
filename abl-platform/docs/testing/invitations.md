# Test Spec: Workspace Invitations

**Feature**: [Workspace Invitations](../features/invitations.md)
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## Current State

Invitation testing is limited to mock-based unit tests in `api-org-routes.test.ts` and email template tests. No E2E or integration tests exercise the real invitation lifecycle through HTTP. The SSO auto-accept integration is completely untested. Cross-tenant isolation and email-mismatch rejection need E2E coverage.

## Health Dashboard

| Area                 | Status     | Notes                                 |
| -------------------- | ---------- | ------------------------------------- |
| Unit tests           | PARTIAL    | Route handlers tested with mocks      |
| Integration tests    | NOT TESTED | No real-server tests                  |
| E2E tests            | NOT TESTED | No HTTP-level lifecycle tests         |
| Security / isolation | NOT TESTED | Cross-tenant, email mismatch untested |
| SSO integration      | NOT TESTED | Auto-accept and picker flow untested  |

---

## Coverage Matrix

| FR    | Description                              | Unit | Integration | E2E     | Manual | Status      |
| ----- | ---------------------------------------- | ---- | ----------- | ------- | ------ | ----------- |
| FR-1  | Create invitation (OWNER/ADMIN)          | PASS | PLANNED     | PLANNED | ---    | Partial     |
| FR-2  | Role hierarchy enforcement               | PASS | PLANNED     | PLANNED | ---    | Partial     |
| FR-3  | Reject if already a member               | PASS | PLANNED     | ---     | ---    | Partial     |
| FR-4  | Reject duplicate pending invitation      | PASS | PLANNED     | PLANNED | ---    | Partial     |
| FR-5  | Cryptographic token generation + hashing | ---  | PLANNED     | ---     | ---    | Not started |
| FR-6  | Branded invitation email                 | PASS | PLANNED     | ---     | ---    | Partial     |
| FR-7  | Accept by token                          | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-8  | Accept by ID (picker flow)               | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-9  | TenantMember creation + JWT issuance     | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-10 | SSO auto-accept single invitation        | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-11 | SSO redirect to picker (2+ invitations)  | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-12 | Revoke invitation                        | PASS | PLANNED     | PLANNED | ---    | Partial     |
| FR-13 | TTL-based expiration                     | ---  | PLANNED     | PLANNED | ---    | Not started |
| FR-14 | Audit events (sent/accepted/revoked)     | ---  | PLANNED     | ---     | ---    | Not started |
| FR-15 | Public get-by-token endpoint             | ---  | ---         | PLANNED | ---    | Not started |

---

## E2E Test Scenarios

All E2E tests run against real Next.js API routes with full middleware (auth, validation, audit logging). No mocks. No direct DB access. Data seeded via API calls.

### E2E-1: Full invitation lifecycle (create, accept by token, verify membership)

**Preconditions:** Tenant created, OWNER user authenticated, invitee user registered with known email
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` with OWNER auth header, body `{ "email": "invitee@example.com", "role": "MEMBER" }`
2. Assert response 201, body contains `{ invitation: { id, email, role: "MEMBER", status: "pending" } }`
3. Extract invitation token (via a test-only DB query helper OR by intercepting the email service)
4. GET `/api/invitations/:token` (no auth) — assert 200, body contains workspace name, role, inviter info
5. POST `/api/invitations/accept` with invitee auth header, body `{ "token": "<raw-token>" }`
6. Assert response 200, body contains `{ tenantId, role: "MEMBER", accessToken, expiresIn }`
7. Verify `Set-Cookie` header contains `refresh_token` with httpOnly flag
8. GET `/api/workspaces/:tenantId/members` with OWNER auth — assert invitee appears in member list with role MEMBER
9. GET `/api/workspaces/:tenantId/invitations` with OWNER auth — assert invitation status reflects acceptance

**Expected Result:** Full lifecycle completes; invitee becomes a workspace member; JWT scoped to workspace
**Auth Context:** OWNER for create/list, invitee for accept
**Isolation Check:** Cross-tenant invite list returns 403/404
**Covers:** FR-1, FR-5, FR-7, FR-9, FR-15

### E2E-2: Role hierarchy enforcement (ADMIN cannot invite OWNER)

**Preconditions:** Tenant with ADMIN user
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` with ADMIN auth, body `{ "email": "new@example.com", "role": "OWNER" }`
2. Assert response 403

**Expected Result:** Privilege escalation prevented
**Auth Context:** ADMIN token
**Isolation Check:** N/A
**Covers:** FR-2

### E2E-3: Cross-tenant invitation isolation

**Preconditions:** Two tenants (A and B), each with OWNER users
**Steps:**

1. POST `/api/workspaces/:tenantA/invitations` with tenantA OWNER — create invitation
2. GET `/api/workspaces/:tenantA/invitations` with tenantB OWNER auth — assert 403 or 404
3. Extract invitationId from step 1
4. DELETE `/api/workspaces/:tenantA/invitations/:invitationId` with tenantB OWNER auth — assert 404

**Expected Result:** Tenant B cannot read or modify tenant A's invitations
**Auth Context:** Two separate tenant OWNER tokens
**Isolation Check:** Cross-tenant GET and DELETE both return 404/403
**Covers:** FR-1, FR-12

### E2E-4: Expired invitation rejection

**Preconditions:** Invitation created with past expiresAt (requires test helper to create with custom expiry OR time manipulation)
**Steps:**

1. Create invitation via API
2. Directly update expiresAt to past via test DB helper (acceptable: this seeds the precondition, test still verifies API behavior)
3. POST `/api/invitations/accept` with invitee auth, body `{ "token": "<token>" }`
4. Assert response 400, body contains expiry-related error message

**Expected Result:** Expired invitations cannot be accepted
**Auth Context:** Invitee token
**Isolation Check:** N/A
**Covers:** FR-7, FR-13

### E2E-5: Email mismatch rejection

**Preconditions:** Invitation for `alice@example.com`, authenticated user is `bob@example.com`
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` with OWNER auth, body `{ "email": "alice@example.com", "role": "MEMBER" }`
2. Extract token
3. POST `/api/invitations/accept` with `bob@example.com`'s auth, body `{ "token": "<token>" }`
4. Assert response 403

**Expected Result:** Users cannot accept invitations sent to different emails
**Auth Context:** Wrong-user token
**Isolation Check:** Email-based user isolation
**Covers:** FR-7

### E2E-6: Duplicate invitation rejection

**Preconditions:** Existing pending invitation for `test@example.com` in tenant
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` with OWNER auth, body `{ "email": "test@example.com", "role": "MEMBER" }`
2. Assert 201
3. POST `/api/workspaces/:tenantId/invitations` with OWNER auth, same body
4. Assert response 400, body contains duplicate message

**Expected Result:** Cannot create duplicate pending invitation for same tenant+email
**Auth Context:** OWNER token
**Isolation Check:** N/A
**Covers:** FR-4

### E2E-7: Accept by ID (picker flow)

**Preconditions:** Invitation created, invitee user authenticated
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` — create invitation for invitee
2. GET `/api/invitations/pending` with invitee auth — assert invitation appears in list with workspaceName, role, inviterName
3. Extract invitationId from response
4. POST `/api/invitations/accept-by-id` with invitee auth, body `{ "invitationId": "<id>" }`
5. Assert response 200, body contains `{ tenantId, role, accessToken, expiresIn }`
6. Verify `Set-Cookie` header contains refresh_token
7. GET `/api/invitations/pending` with invitee auth — assert empty list

**Expected Result:** Picker flow works end-to-end; invitee joins workspace
**Auth Context:** OWNER for create, invitee for accept
**Isolation Check:** N/A
**Covers:** FR-8, FR-9

### E2E-8: Revoke invitation and verify non-acceptable

**Preconditions:** Pending invitation exists
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` — create invitation
2. DELETE `/api/workspaces/:tenantId/invitations/:invitationId` with OWNER auth
3. Assert response 200, `{ success: true }`
4. POST `/api/invitations/accept` with invitee auth, body `{ "token": "<token>" }`
5. Assert response 400 (invitation no longer pending/exists)

**Expected Result:** Revoked invitations cannot be accepted
**Auth Context:** OWNER for revoke, invitee for accept attempt
**Isolation Check:** N/A
**Covers:** FR-12

### E2E-9: Unauthenticated user cannot create or accept invitations

**Preconditions:** None
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` without auth header — assert 401
2. POST `/api/invitations/accept` without auth header — assert 401
3. POST `/api/invitations/accept-by-id` without auth header — assert 401
4. GET `/api/invitations/pending` without auth header — assert 401
5. GET `/api/invitations/:token` without auth header — assert 200 (this endpoint IS public)

**Expected Result:** Mutation endpoints require auth; public read endpoint does not
**Auth Context:** No auth for all except step 5
**Isolation Check:** Auth boundary enforcement
**Covers:** FR-7, FR-15

### E2E-10: Non-admin user cannot create invitations

**Preconditions:** Tenant with MEMBER-role user
**Steps:**

1. POST `/api/workspaces/:tenantId/invitations` with MEMBER auth, body `{ "email": "new@example.com" }`
2. Assert response 403

**Expected Result:** Only OWNER and ADMIN can invite
**Auth Context:** MEMBER token
**Isolation Check:** Permission enforcement
**Covers:** FR-1

---

## Integration Test Scenarios

Integration tests run against real MongoDB (MongoMemoryServer) with real service and repo layers. No mocks of codebase components.

### INT-1: Invitation service creates TenantMember on acceptance

**Boundary:** invitation-service.ts + workspace-repo.ts + MongoDB
**Setup:** MongoMemoryServer, seed tenant + OWNER user + invitee user
**Steps:**

1. Call `createInvitation({ tenantId, email: invitee.email, role: 'MEMBER', invitedBy: owner.id })`
2. Verify returned object has status 'pending', valid expiresAt
3. Query workspace_invitations collection — verify token is hashed (not raw)
4. Call `acceptInvitation(rawToken, invitee.id, invitee.email)`
5. Query tenant_members collection — verify TenantMember record exists with correct role
6. Query workspace_invitations — verify status is 'accepted', acceptedAt and acceptedBy set

**Expected Result:** Full acceptance flow creates membership and updates invitation
**Failure Mode:** If MongoDB is down, both create and accept throw connection errors
**Covers:** FR-7, FR-9

### INT-2: Role hierarchy validation in service layer

**Boundary:** invitation-service.ts + workspace-repo.ts + MongoDB
**Setup:** MongoMemoryServer, seed tenant with ADMIN-role inviter member
**Steps:**

1. Call `createInvitation({ ..., role: 'OWNER', invitedBy: adminUser.id })`
2. Assert throws AppError with FORBIDDEN code
3. Call `createInvitation({ ..., role: 'MEMBER', invitedBy: adminUser.id })`
4. Assert succeeds and returns invitation object
5. Call `createInvitation({ ..., role: 'ADMIN', invitedBy: adminUser.id })`
6. Assert succeeds (ADMIN can invite ADMIN)

**Expected Result:** ADMIN blocked from OWNER invite, allowed for MEMBER/ADMIN
**Failure Mode:** If findTenantMember returns null for inviter, throws FORBIDDEN
**Covers:** FR-2

### INT-3: Duplicate invitation prevention via unique index

**Boundary:** workspace-repo.ts + MongoDB unique index
**Setup:** MongoMemoryServer, seed tenant
**Steps:**

1. Call `createInvitation({ tenantId, email: 'dup@example.com', ... })`
2. Call `createInvitation({ tenantId, email: 'dup@example.com', ... })` again
3. Assert second call throws (either MongoDB duplicate key error or service-layer check)
4. Call `deleteInvitation(firstInvite.id, tenantId)` — remove first
5. Call `createInvitation({ tenantId, email: 'dup@example.com', ... })` — assert succeeds

**Expected Result:** Unique index on { tenantId, email } prevents duplicates
**Failure Mode:** MongoDB duplicate key error E11000
**Covers:** FR-4

### INT-4: Token hashing and secure lookup

**Boundary:** invitation-service.ts + token-hash.ts + workspace-repo.ts
**Setup:** MongoMemoryServer
**Steps:**

1. Call `createInvitation()` — this generates a raw token internally and stores hash
2. Note: the raw token is sent via email, so intercept the email call to capture it
3. Call `getInvitationByToken(rawToken)` — assert returns correct invitation
4. Call `getInvitationByToken('wrong-token-value')` — assert returns null
5. Query DB directly — verify stored token differs from raw token (it's SHA-256)

**Expected Result:** Only the correct raw token resolves to the invitation
**Failure Mode:** Hash mismatch returns null
**Covers:** FR-5

### INT-5: Email template generation with XSS prevention

**Boundary:** email-templates.ts + i18n
**Setup:** No DB needed
**Steps:**

1. Call `workspaceInvitationEmail({ inviterName: '<script>alert(1)</script>', workspaceName: 'Test & Co', role: 'ADMIN', acceptUrl: 'https://app.example.com/invite/abc' })`
2. Assert HTML contains escaped inviter name (`&lt;script&gt;` not `<script>`)
3. Assert HTML contains escaped workspace name (`Test &amp; Co`)
4. Assert HTML contains clickable accept URL
5. Assert subject line contains workspace name

**Expected Result:** Email template properly escapes HTML and includes all required info
**Failure Mode:** N/A (pure function)
**Covers:** FR-6

### INT-6: Audit event emission on invitation lifecycle

**Boundary:** invitation-service.ts + audit-service.ts + MongoDB
**Setup:** MongoMemoryServer, audit collection
**Steps:**

1. Create invitation — query audit_events for `INVITATION_SENT` with correct tenantId, userId, metadata
2. Accept invitation — query audit_events for `INVITATION_ACCEPTED` with correct metadata
3. Create another invitation, then revoke — query audit_events for `INVITATION_REVOKED`

**Expected Result:** Each lifecycle stage emits a correctly structured audit event
**Failure Mode:** If audit service throws, invitation operation may still succeed (audit is best-effort in current impl)
**Covers:** FR-14

### INT-7: Already-a-member rejection

**Boundary:** invitation-service.ts + workspace-repo.ts + MongoDB
**Setup:** MongoMemoryServer, seed tenant + user who is already a member
**Steps:**

1. Call `createInvitation({ email: existingMember.email, ... })`
2. Assert throws AppError with BAD_REQUEST code and "already a member" message

**Expected Result:** Cannot invite existing workspace members
**Failure Mode:** N/A
**Covers:** FR-3

### INT-8: SSO auto-accept single invitation flow

**Boundary:** auth-service.ts (resolveUserContextOrAutoAcceptInvite) + invitation-service.ts + workspace-repo.ts
**Setup:** MongoMemoryServer, seed user with no tenant membership, 1 pending invitation
**Steps:**

1. Call `resolveUserContextOrAutoAcceptInvite(userId, userEmail)`
2. Assert returns `{ tenantContext: { tenantId, role }, pendingInvitationChoice: false }`
3. Verify TenantMember record exists
4. Verify invitation status is accepted

**Expected Result:** Single pending invitation auto-accepted during SSO
**Failure Mode:** If invitation is expired, returns null tenantContext
**Covers:** FR-10

---

## Unit Test Scenarios

### UNIT-1: hashToken produces consistent SHA-256 output

**Module:** `lib/token-hash.ts`
**Input:** Known token string
**Expected Output:** SHA-256 hex digest, same output on repeated calls

### UNIT-2: workspaceInvitationEmail returns correct structure

**Module:** `packages/shared/src/services/email-templates.ts`
**Input:** `{ inviterName: 'Alice', workspaceName: 'TestCo', role: 'MEMBER', acceptUrl: 'https://...' }`
**Expected Output:** `{ subject: string, html: string }` with both non-empty

### UNIT-3: Zod schema validation for invitation creation

**Module:** Route-level Zod schemas
**Input:** `{ email: 'not-an-email' }`, `{ email: 'valid@example.com', role: 'INVALID' }`
**Expected Output:** Validation errors for invalid email and invalid role

### UNIT-4: Invitation model schema validation

**Module:** `packages/database/src/models/workspace-invitation.model.ts`
**Input:** Document missing required fields (tenantId, email, token, expiresAt)
**Expected Output:** Mongoose validation errors

---

## Security & Isolation Tests

- [PLANNED] Cross-tenant invitation access returns 404 (E2E-3)
- [PLANNED] Cross-tenant invitation revocation returns 404 (E2E-3)
- [PLANNED] Email mismatch during acceptance returns 403 (E2E-5)
- [PLANNED] Unauthenticated access to mutation endpoints returns 401 (E2E-9)
- [PLANNED] Non-admin (MEMBER/VIEWER) cannot create invitations returns 403 (E2E-10)
- [PLANNED] ADMIN cannot invite with OWNER role returns 403 (E2E-2)
- [PLANNED] Public get-by-token endpoint does not leak sensitive data (token hash, invitedBy userId)
- [PLANNED] Input validation rejects malformed email addresses
- [PLANNED] Expired invitation tokens cannot be used for acceptance

---

## Performance & Load Tests

Not required for initial ALPHA/BETA. Future considerations:

- Concurrent invitation creation for the same email (race condition on unique index)
- Large invitation list response times (>1000 pending invitations per tenant)
- Token hash computation latency under load

---

## Test Infrastructure

### Required Services

- **MongoDB**: MongoMemoryServer for integration tests, Docker MongoDB for E2E
- **SMTP**: Mock SMTP server (e.g., nodemailer mock transport) for email verification in integration tests. For E2E, intercept email service or use a test helper to extract tokens from DB.

### Data Seeding Strategy

For E2E tests, seed via API calls:

1. Create tenant + OWNER via onboarding API or direct DB seed helper
2. Register invitee user via signup API
3. Create invitations via the invitation API under test

For integration tests, seed via repo layer:

1. `createTenant()` / `createTenantMember()` in workspace-repo
2. User creation via auth-repo
3. Direct model calls for edge cases (expired invitations)

### Environment Variables

```env
DATABASE_URL=mongodb://localhost:27017/test-invitations
FRONTEND_URL=http://localhost:5173
SMTP_HOST=localhost
SMTP_PORT=1025
JWT_SECRET=test-secret
JWT_REFRESH_SECRET=test-refresh-secret
```

### CI Configuration

- Integration tests run as part of `pnpm test --filter=studio`
- E2E tests require MongoDB (Docker service in CI)
- No external SMTP dependency (mocked transport)

---

## Test File Mapping

| Test File (Planned)                                                | Type        | Covers                                   |
| ------------------------------------------------------------------ | ----------- | ---------------------------------------- |
| `apps/studio/src/__tests__/api-org-routes.test.ts`                 | unit (mock) | FR-1, FR-2, FR-3, FR-4, FR-12 (existing) |
| `packages/shared/src/__tests__/email-templates.test.ts`            | unit        | FR-6 (existing)                          |
| `apps/studio/src/__tests__/e2e/invitations-lifecycle.e2e.test.ts`  | e2e         | FR-1, FR-5, FR-7, FR-9, FR-15            |
| `apps/studio/src/__tests__/e2e/invitations-security.e2e.test.ts`   | e2e         | FR-2, FR-12 (cross-tenant, permissions)  |
| `apps/studio/src/__tests__/e2e/invitations-picker.e2e.test.ts`     | e2e         | FR-8, FR-10, FR-11                       |
| `apps/studio/src/__tests__/integration/invitation-service.test.ts` | integration | FR-3, FR-4, FR-5, FR-7, FR-9, FR-14      |
| `apps/studio/src/__tests__/integration/invitation-sso.test.ts`     | integration | FR-10, FR-11                             |

---

## Open Testing Questions

1. How to intercept the raw invitation token in E2E tests without direct DB access? Options: (a) mock the email service transport to capture the token, (b) expose a test-only endpoint, (c) use a DB seed helper (not ideal for E2E).
2. How to test TTL-based expiration (FR-13) in E2E? MongoDB TTL index runs every 60 seconds — tests would need to either (a) seed with past expiresAt and verify rejection, or (b) wait for TTL cleanup (too slow for CI).
3. Should SSO auto-accept (FR-10, FR-11) be tested via the actual SSO callback endpoints or via the `resolveUserContextOrAutoAcceptInvite()` function directly? The former is true E2E but requires OAuth mock setup; the latter tests the core logic.
4. The existing `api-org-routes.test.ts` uses `vi.mock()` extensively. Should it be kept as-is (unit-level regression) or replaced by E2E tests?

---

## Iteration Log

_No test iterations yet. First iteration expected during implementation phase._
