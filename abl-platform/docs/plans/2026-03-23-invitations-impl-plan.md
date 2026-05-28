# LLD + Implementation Plan: Workspace Invitations Hardening

**Feature Spec**: [docs/features/invitations.md](../features/invitations.md)
**HLD**: [docs/specs/invitations.hld.md](../specs/invitations.hld.md)
**Test Spec**: [docs/testing/invitations.md](../testing/invitations.md)
**Date**: 2026-03-23
**Status**: READY FOR IMPLEMENTATION

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                    | Rationale                                                                                             | Alternatives Rejected                      |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| D-1 | Use `withTransaction` for accept flow       | Existing pattern in `createWorkspaceWithOwner()`. Gracefully degrades to no-transaction on standalone | Manual compensating actions (over-complex) |
| D-2 | Fix tenant scoping via email verification   | `acceptInvitationById` already verifies email match; add tenantId to repo query as defense-in-depth   | Require tenantId from client (leaks info)  |
| D-3 | Replace console.error with createLogger     | Platform standard. Already used in workspace invitation route.                                        | Keep console.error (violates CLAUDE.md)    |
| D-4 | Align error envelope with platform standard | `{ success: false, error: { code, message } }` per CLAUDE.md                                          | Keep `{ error: string }` (inconsistent)    |
| D-5 | Test-after approach for hardening           | Existing code works; tests validate correctness of refactored code                                    | Test-first (would slow down small fixes)   |
| D-6 | Keep synchronous email in create path       | Per HLD recommendation — async email is premature optimization at current scale                       | BullMQ async email (over-complex for now)  |

### Key Interfaces & Types

No new interfaces needed. Existing `IWorkspaceInvitation` and service function signatures are sufficient. The changes are internal implementation fixes.

### Module Boundaries

```
invitation-service.ts (service layer)
  ├── Uses: workspace-repo.ts (data access)
  ├── Uses: auth-repo.ts (user lookups)
  ├── Uses: token-hash.ts (crypto)
  ├── Uses: email-templates.ts (email content)
  ├── Uses: audit-service.ts (event emission)
  └── Uses: withTransaction from @agent-platform/shared/repos (transaction support)

Route handlers (API layer)
  ├── Uses: invitation-service.ts
  ├── Uses: auth-service.ts (createTokenPair)
  ├── Uses: requireAuth from lib/auth
  └── Uses: createLogger from @abl/compiler/platform
```

---

## 2. File-Level Change Map

### Modified Files

| File                                                                                | Change Description                                                                                     | Risk   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| `apps/studio/src/services/invitation-service.ts`                                    | Wrap acceptInvitation/acceptInvitationById in withTransaction; add tenantId to findInvitationById call | Medium |
| `apps/studio/src/app/api/invitations/accept/route.ts`                               | Replace console.error with createLogger; align error envelope                                          | Low    |
| `apps/studio/src/app/api/invitations/accept-by-id/route.ts`                         | Replace console.error with createLogger; align error envelope                                          | Low    |
| `apps/studio/src/app/api/invitations/pending/route.ts`                              | Replace console.error with createLogger                                                                | Low    |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` | Replace console.error with createLogger                                                                | Low    |

### New Files

| File                                                                   | Purpose                                        | LOC Estimate |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ------------ |
| `apps/studio/src/__tests__/integration/invitation-service.int.test.ts` | Integration tests for invitation service layer | ~300         |
| `apps/studio/src/__tests__/e2e/invitations-lifecycle.e2e.test.ts`      | E2E tests for full invitation lifecycle        | ~400         |
| `apps/studio/src/__tests__/e2e/invitations-security.e2e.test.ts`       | E2E tests for security/isolation scenarios     | ~250         |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Transaction Safety & Tenant Scoping Fixes

**Goal**: Eliminate the two HIGH-severity gaps (GAP-001, GAP-003) in the invitation acceptance flow.

**Tasks**:

1.1. Import `withTransaction` from `@agent-platform/shared/repos` in `invitation-service.ts`
1.2. Wrap `acceptInvitation()` logic (createTenantMember + updateInvitation) in `withTransaction()`, passing the session to both operations
1.3. Wrap `acceptInvitationById()` logic in `withTransaction()` similarly
1.4. In `acceptInvitationById()`, after finding the invitation by ID, pass the invitation's `tenantId` to subsequent `createTenantMember` and `updateInvitation` calls (already done — verify this; the gap is the initial `findInvitationById` call not having tenantId)
1.5. Fix `findInvitationById` call in `acceptInvitationById()`: Since we don't have tenantId at call time (it's the return value), keep the current pattern but add a comment documenting why — the email verification provides equivalent security. The real fix is that `updateInvitation` already requires tenantId.

**Files Touched**:

- `apps/studio/src/services/invitation-service.ts` — Add withTransaction to accept flows

**Exit Criteria**:

- [ ] `acceptInvitation()` uses `withTransaction()` for createTenantMember + updateInvitation
- [ ] `acceptInvitationById()` uses `withTransaction()` for createTenantMember + updateInvitation
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] Existing unit tests in `api-org-routes.test.ts` still pass
- [ ] Manual verification: accepting an invitation creates member and updates status atomically

**Test Strategy**:

- Unit: Existing mock-based tests verify no regressions
- Integration: Covered in Phase 3

**Rollback**: Revert the withTransaction wrapper. Non-transactional behavior is the current ALPHA state.

---

### Phase 2: Logging & Error Envelope Alignment

**Goal**: Replace all `console.error` with `createLogger()` and align error responses with platform standard.

**Tasks**:

2.1. In `apps/studio/src/app/api/invitations/accept/route.ts`: Replace `console.error` with `log.error()` using `createLogger('invitations-accept')`
2.2. In `apps/studio/src/app/api/invitations/accept-by-id/route.ts`: Replace `console.error` with `log.error()` using `createLogger('invitations-accept-by-id')`
2.3. In `apps/studio/src/app/api/invitations/pending/route.ts`: Replace `console.error` with `log.error()` using `createLogger('invitations-pending')`
2.4. In `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts`: Replace `console.error` with `log.error()` using `createLogger('invitations-revoke')`
2.5. Verify all `log.error()` calls use the correct pattern: `log.error('message', { err: error instanceof Error ? error.message : String(error) })`

**Files Touched**:

- `apps/studio/src/app/api/invitations/accept/route.ts`
- `apps/studio/src/app/api/invitations/accept-by-id/route.ts`
- `apps/studio/src/app/api/invitations/pending/route.ts`
- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts`

**Exit Criteria**:

- [ ] Zero `console.error` or `console.log` calls in any invitation route file
- [ ] All route files import and use `createLogger()` from `@abl/compiler/platform`
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] Existing tests pass

**Test Strategy**:

- Unit: Existing tests verify no regressions
- Manual: Trigger an error path and verify structured log output

**Rollback**: Revert logger changes. No functional impact.

---

### Phase 3: Integration Tests

**Goal**: Add real-MongoDB integration tests for the invitation service layer.

**Tasks**:

3.1. Create `apps/studio/src/__tests__/integration/invitation-service.int.test.ts`
3.2. Implement INT-1 (acceptance creates TenantMember) from test spec
3.3. Implement INT-2 (role hierarchy validation) from test spec
3.4. Implement INT-3 (duplicate invitation prevention) from test spec
3.5. Implement INT-4 (token hashing and lookup) from test spec
3.6. Implement INT-7 (already-a-member rejection) from test spec
3.7. Implement INT-6 (audit event emission) from test spec — or defer if audit service setup is complex

**Files Touched**:

- `apps/studio/src/__tests__/integration/invitation-service.int.test.ts` (NEW)

**Exit Criteria**:

- [ ] At least 5 integration tests pass against MongoMemoryServer
- [ ] Tests use real invitation-service.ts and workspace-repo.ts (no vi.mock for codebase components)
- [ ] Tests verify DB state (TenantMember creation, invitation status updates)
- [ ] `pnpm test --filter=studio` passes (new tests included)

**Test Strategy**:

- Integration: MongoMemoryServer with real service + repo layers
- No mocks of codebase components; only external services (SMTP) mocked via DI

**Rollback**: Delete the test file. No production code changes.

---

### Phase 4: E2E Tests

**Goal**: Add HTTP-level E2E tests for the invitation lifecycle and security scenarios.

**Tasks**:

4.1. Create `apps/studio/src/__tests__/e2e/invitations-lifecycle.e2e.test.ts`
4.2. Implement E2E-1 (full lifecycle: create, accept by token, verify membership)
4.3. Implement E2E-6 (duplicate invitation rejection)
4.4. Implement E2E-7 (accept by ID / picker flow)
4.5. Create `apps/studio/src/__tests__/e2e/invitations-security.e2e.test.ts`
4.6. Implement E2E-2 (role hierarchy enforcement)
4.7. Implement E2E-3 (cross-tenant isolation)
4.8. Implement E2E-5 (email mismatch rejection)
4.9. Implement E2E-9 (unauthenticated access returns 401)
4.10. Implement E2E-10 (non-admin returns 403)

**Files Touched**:

- `apps/studio/src/__tests__/e2e/invitations-lifecycle.e2e.test.ts` (NEW)
- `apps/studio/src/__tests__/e2e/invitations-security.e2e.test.ts` (NEW)

**Exit Criteria**:

- [ ] At least 8 E2E tests pass against real Next.js API routes
- [ ] Tests use HTTP requests with auth headers (no vi.mock, no direct DB access)
- [ ] Cross-tenant isolation test verifies 404 response
- [ ] Email mismatch test verifies 403 response
- [ ] `pnpm test --filter=studio` passes (all new tests included)

**Test Strategy**:

- E2E: Real HTTP calls against Next.js API routes with full middleware chain
- No mocking codebase components
- Data seeded via API calls or minimal DB helpers for preconditions

**Rollback**: Delete the test files. No production code changes.

---

## 4. Wiring Checklist

All code changes in Phases 1-2 modify existing files — no new modules need wiring.

- [x] `withTransaction` already exported from `@agent-platform/shared/repos` (used in `createWorkspaceWithOwner`)
- [x] `createLogger` already available from `@abl/compiler/platform`
- [x] Routes already registered (Next.js file-system routing)
- [x] Models already exported from `@agent-platform/database/models`
- [ ] New test files in Phase 3-4 need to be discoverable by vitest (place in `__tests__/integration/` and `__tests__/e2e/` matching vitest config)
- [ ] Verify vitest config includes integration test paths (check `vitest.config.ts` in `apps/studio/`)

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. Schema is stable.

### Feature Flags

None required. All changes are backwards-compatible hardening.

### Configuration Changes

No new environment variables. No new config keys. The `withTransaction` utility auto-detects replica set availability.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] GAP-001 (tenant scoping) documented with defense-in-depth analysis
- [ ] GAP-003 (transaction safety) resolved — acceptance uses withTransaction
- [ ] GAP-002 (console.error) resolved — all routes use createLogger
- [ ] 5+ integration tests passing against real MongoDB
- [ ] 8+ E2E tests passing against real HTTP API
- [ ] Cross-tenant isolation verified in E2E
- [ ] Email mismatch verified in E2E
- [ ] Auth enforcement (401/403) verified in E2E
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] `pnpm test --filter=studio` passes all tests
- [ ] Feature spec updated with implementation details (via post-impl-sync)
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. **Vitest config for E2E**: Does the Studio vitest config support separate E2E test configurations (different timeout, setup files)? May need a `vitest.config.e2e.ts` or test path filtering.
2. **MongoMemoryServer availability**: Is MongoMemoryServer already a dev dependency for Studio, or does it need to be added?
3. **SMTP mock strategy for integration tests**: Should we use `jest-mock-smtp`, nodemailer `createTestAccount`, or inject a mock transport via constructor parameter?
4. **Token extraction in E2E**: For E2E-1, we need the raw invitation token. The cleanest approach is to mock the email transport to capture it, or to add a test-only query helper.
