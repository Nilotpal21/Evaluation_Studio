# LLD + Implementation Plan: Workspace Sharing

**Feature Spec**: [docs/features/workspace-sharing.md](../features/workspace-sharing.md)
**HLD**: [docs/specs/workspace-sharing.hld.md](../specs/workspace-sharing.hld.md)
**Test Spec**: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)
**Date**: 2026-03-23
**Status**: APPROVED

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                 | Rationale                                                                                                                                            | Alternatives Rejected                                                        |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| D1  | Unify invitation creation to use `invitation-service.ts` | GAP-001: route handler uses `crypto.randomUUID()` while service uses 64-byte random + SHA-256 hash. Unifying to service eliminates security surface. | Keep both paths (risk of weaker tokens), add hashing in route (duplication). |
| D2  | Fix `switchTenantResponseSchema` role enum               | GAP-004: response schema only has OWNER/ADMIN/MEMBER, missing OPERATOR/VIEWER. Users with those roles get validation errors.                         | Leave as-is (breaks for OPERATOR/VIEWER users).                              |
| D3  | Replace `console.error` with `createLogger()`            | GAP-002: structured logging is a platform invariant. Some routes use `console.error`.                                                                | Leave as-is (violates coding standards).                                     |
| D4  | Add member role change and removal routes                | Feature spec lists PATCH/DELETE for `/:tenantId/members/:userId` but no route exists. Members page UI needs these.                                   | Only support role change via MembersPage direct-to-DB (violates API-first).  |
| D5  | Keep acceptance non-transactional                        | `invitation-service.ts` creates member then updates invitation separately. Adding a transaction adds complexity for a rare race condition.           | Wrap in `withTransaction()` (overhead for edge case).                        |

### Key Interfaces & Types

```typescript
// Existing — no changes needed
interface IWorkspaceInvitation {
  _id: string;
  tenantId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  token: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
}

interface ITenantMember {
  _id: string;
  tenantId: string;
  userId: string;
  role: string;
  customRoleId: string | null;
}

// Modified — switchTenantResponseSchema
const switchTenantResponseSchema = z.object({
  accessToken: z.string(),
  tenantId: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
  orgId: z.string().nullable().optional(),
});
```

### Module Boundaries

| Module                  | Responsibility                                      | Dependencies                             |
| ----------------------- | --------------------------------------------------- | ---------------------------------------- |
| `workspace-repo.ts`     | Data access for tenants, members, invitations       | MongoDB models                           |
| `invitation-service.ts` | Invitation lifecycle (create, accept, revoke, list) | workspace-repo, auth-repo, email service |
| `workspace-service.ts`  | Workspace creation and slug generation              | workspace-repo                           |
| `auth-service.ts`       | Tenant listing, switching, JWT issuance             | workspace-repo                           |
| Route handlers          | HTTP request handling, auth, validation             | Services, repos                          |

---

## 2. File-Level Change Map

### New Files

| File                                                                                       | Purpose                                      | LOC Estimate |
| ------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------ |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/route.ts`                  | PATCH (role change) + DELETE (remove member) | ~120         |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/resend/route.ts` | POST (resend invitation with fresh token)    | ~80          |
| `apps/studio/src/__tests__/workspace-sharing.e2e.test.ts`                                  | E2E test suite for workspace sharing         | ~400         |
| `apps/studio/src/__tests__/invitation-service.integration.test.ts`                         | Integration tests for invitation service     | ~250         |
| `apps/studio/src/__tests__/member-management.integration.test.ts`                          | Integration tests for member management      | ~200         |

### Modified Files

| File                                                                                | Change Description                                                                  | Risk |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts`                | Delegate invitation creation to `invitation-service.ts` instead of direct repo call | Med  |
| `apps/studio/src/app/api/auth/tenants/switch/route.ts`                              | Fix role enum in `switchTenantResponseSchema` to include OPERATOR/VIEWER            | Low  |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/route.ts`                    | Replace `console.error` with `createLogger()`                                       | Low  |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` | Replace `console.error` with `createLogger()`                                       | Low  |
| `apps/studio/src/app/api/invitations/accept-by-id/route.ts`                         | Replace `console.error` with `createLogger()`                                       | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Fix Known Gaps (GAP-001, GAP-002, GAP-004)

**Goal**: Resolve the three highest-priority gaps without adding new functionality.

**Tasks**:

1.1. Modify `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts` to delegate invitation creation to `invitation-service.ts` instead of calling `createInvitation` from workspace-repo directly with `crypto.randomUUID()`.

1.2. Fix `apps/studio/src/app/api/auth/tenants/switch/route.ts` to expand the `switchTenantResponseSchema` role enum from `['OWNER', 'ADMIN', 'MEMBER']` to `['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']`.

1.3. Replace `console.error` with `createLogger()` in:

- `apps/studio/src/app/api/workspaces/[tenantId]/members/route.ts` (line 74)
- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` (line 67)
- `apps/studio/src/app/api/invitations/accept-by-id/route.ts` (line 77)
- `apps/studio/src/app/api/auth/tenants/switch/route.ts` (line 61)

**Files Touched**:

- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts` — delegate to service
- `apps/studio/src/app/api/auth/tenants/switch/route.ts` — fix role enum + logging
- `apps/studio/src/app/api/workspaces/[tenantId]/members/route.ts` — fix logging
- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` — fix logging
- `apps/studio/src/app/api/invitations/accept-by-id/route.ts` — fix logging

**Exit Criteria**:

- [ ] Invitation creation route uses `createInvitation()` from `invitation-service.ts` for token generation and hashing
- [ ] `switchTenantResponseSchema` includes all 5 roles
- [ ] No `console.error` calls remain in any workspace-sharing route file
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Existing tests pass: `api-org-routes.test.ts`, `auth-services.test.ts`

**Test Strategy**:

- Unit: Verify existing tests still pass after refactor
- Integration: Verify invitation creation still produces valid tokens

**Rollback**: Revert the 5 file modifications. No data model changes.

### Phase 2: Add Missing Member Management Routes

**Goal**: Create the PATCH and DELETE routes for member role change and removal.

**Tasks**:

2.1. Create `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/route.ts` with:

- `PATCH` handler for role change (verify admin access, enforce hierarchy, update TenantMember)
- `DELETE` handler for member removal (verify admin access, prevent self-removal, prevent OWNER removal by non-OWNER)

  2.2. Add Zod schemas for request/response validation on both handlers.

  2.3. Wrap both handlers with `withOpenAPI()` for documentation.

  2.4. Add audit logging for role change and member removal actions.

**Files Touched**:

- `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/route.ts` — NEW

**Exit Criteria**:

- [ ] `PATCH /api/workspaces/:tenantId/members/:userId` changes a member's role with hierarchy enforcement
- [ ] `DELETE /api/workspaces/:tenantId/members/:userId` removes a member with OWNER protection
- [ ] Both routes have Zod validation, `withOpenAPI()`, `requireAuth()`, and audit logging
- [ ] Role hierarchy: ADMIN cannot escalate to OWNER, cannot remove OWNER
- [ ] Self-modification: users cannot change their own role or remove themselves
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Unit: Role hierarchy validation logic
- Integration: Full route handler tests with mock auth context

**Rollback**: Delete the new route file. No existing files modified.

### Phase 3: Add Invitation Resend Route

**Goal**: Create the resend endpoint that generates a fresh token and re-sends the invitation email.

**Tasks**:

3.1. Create `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/resend/route.ts` with:

- `POST` handler that: looks up the invitation, verifies it's pending, deletes it, creates a new one via `invitation-service.ts`

  3.2. Add audit logging for resend action.

**Files Touched**:

- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/resend/route.ts` — NEW

**Exit Criteria**:

- [ ] `POST /api/workspaces/:tenantId/invitations/:invitationId/resend` creates a fresh invitation for the same email
- [ ] Old invitation is deleted, new one has fresh token and expiry
- [ ] Route has Zod validation, `withOpenAPI()`, `requireAuth()`, and audit logging
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Integration: Test resend creates new invitation with different token

**Rollback**: Delete the new route file. No existing files modified.

### Phase 4: Integration Tests

**Goal**: Implement the 6 integration test scenarios from the test spec.

**Tasks**:

4.1. Create `apps/studio/src/__tests__/invitation-service.integration.test.ts` covering INT-1, INT-2.

4.2. Create `apps/studio/src/__tests__/member-management.integration.test.ts` covering INT-5, INT-6.

4.3. Verify existing tests in `api-org-routes.test.ts` cover INT-3 (workspace creation transaction) and INT-4 (tenant switching).

**Files Touched**:

- `apps/studio/src/__tests__/invitation-service.integration.test.ts` — NEW
- `apps/studio/src/__tests__/member-management.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] INT-1 through INT-6 are covered (6 integration scenarios)
- [ ] All integration tests pass with `pnpm test --filter=studio`
- [ ] No `vi.mock()` of codebase components (only external email service)
- [ ] Tests use MongoMemoryServer or equivalent for real MongoDB interaction

**Test Strategy**: This IS the test implementation phase.

**Rollback**: Delete the new test files. No production code modified.

### Phase 5: E2E Tests

**Goal**: Implement the 7 E2E test scenarios from the test spec.

**Tasks**:

5.1. Create `apps/studio/src/__tests__/workspace-sharing.e2e.test.ts` covering E2E-1 through E2E-7.

5.2. Set up test infrastructure: Studio server on random port, test user creation, JWT token generation for auth context.

5.3. Each E2E test interacts only via HTTP API (no direct DB access, no mocks of codebase components).

**Files Touched**:

- `apps/studio/src/__tests__/workspace-sharing.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] E2E-1 through E2E-7 are covered (7 scenarios)
- [ ] Tests start a real Studio server on a random port
- [ ] Tests interact only via HTTP API
- [ ] No `vi.mock()` of codebase components
- [ ] Cross-tenant tests verify 404 (not 403)
- [ ] All E2E tests pass

**Test Strategy**: This IS the E2E test implementation phase.

**Rollback**: Delete the new test file. No production code modified.

---

## 4. Wiring Checklist

- [ ] New member management route (`[userId]/route.ts`) is at the correct Next.js file-system route path — Next.js auto-discovers, no manual registration needed
- [ ] New resend route (`[invitationId]/resend/route.ts`) is at the correct path
- [ ] New routes export named HTTP method handlers (`PATCH`, `DELETE`, `POST`)
- [ ] New routes use `withOpenAPI()` wrapper for API documentation
- [ ] Invitation creation in route handler delegates to `invitation-service.ts`
- [ ] All new routes use `requireAuth()` for authentication
- [ ] All new routes include audit logging via `logAuditEvent()`
- [ ] Test files follow the naming convention: `*.test.ts` or `*.e2e.test.ts`
- [ ] Test files are in `apps/studio/src/__tests__/` directory

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. All collections and indexes already exist.

### Feature Flags

Not needed. The changes are backward-compatible fixes and missing route additions.

### Configuration Changes

No new environment variables or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 gaps (GAP-001, GAP-002, GAP-003, GAP-004) are resolved
- [ ] Member management routes (PATCH, DELETE) exist and enforce role hierarchy
- [ ] Invitation resend route exists and generates fresh tokens
- [ ] 6 integration tests pass
- [ ] 7 E2E tests pass
- [ ] No regressions in existing tests (`api-org-routes.test.ts`, `auth-services.test.ts`)
- [ ] Feature spec updated with new routes and test coverage
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. Should the E2E tests start a full Next.js dev server or use a lightweight Express wrapper? **Decision: DECIDED — use Next.js test utilities if available, otherwise supertest with the route handlers directly. The key requirement is that the full middleware chain (auth, validation) executes.**
2. Should integration tests for invitation-service mock the email service? **Decision: DECIDED — yes, email service is an external dependency and can be mocked via dependency injection. This is the only acceptable mock in the test suite.**
