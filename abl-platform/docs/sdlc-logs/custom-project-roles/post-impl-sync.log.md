# Post-Implementation Sync Log: Custom Project Roles

**Date**: 2026-04-14
**Feature**: custom-project-roles
**Tickets**: ABLP-254 (slices 1-6), ABLP-327 (RBAC service extraction + explicit access)

---

## Documents Updated

- [x] Feature spec: `docs/features/custom-project-roles.md`
  - Status: PLANNED -> ALPHA
  - Package(s): updated `packages/shared` -> `packages/shared-auth`
  - Section 5: Related feature integration matrix -- updated current states
  - Section 7: Resolved technical considerations (GAP-001, GAP-002 mitigated)
  - Section 8: Updated API tables with implementation status, added project member management APIs
  - Section 9: Updated ProjectMember data model (role enum expanded, schema guards, sparse index)
  - Section 10: Replaced "TO BE CREATED" placeholders with actual file paths; added Services/Repositories table; updated tests table with actual test files
  - Section 16: GAP-001/002/005 marked Mitigated; added GAP-006 through GAP-011 for remaining work
  - Section 17: Updated test coverage matrix with actual test files and status
  - Section 18: Updated references to reflect `shared-auth` package and all new source files
- [x] Test spec: `docs/testing/custom-project-roles.md` -- **created** (did not previously exist)
  - Coverage matrix for all 9 FRs
  - 6 E2E scenarios (all NOT YET IMPLEMENTED)
  - 5 integration scenarios (2 TESTED, 3 unit-level)
  - Unit test file inventory with approximate test counts
  - Critical gaps section
- [x] Testing index: `docs/testing/README.md`
  - Added entry #22a: Custom Project Roles -- IN PROGRESS (ALPHA) 04-14
- [x] LLD: `docs/plans/2026-04-09-project-rbac-management-impl-plan.md`
  - Status: REVIEWED -> IN PROGRESS (Phases 0-2 implemented, Phases 3-4 pending)
  - Added Section 9: Post-Implementation Notes with phase completion table and 6 deviations from plan

---

## Coverage Delta

| Type              | Before | After                             |
| ----------------- | ------ | --------------------------------- |
| Unit tests        | 0      | ~115 (across 8 test files)        |
| Integration tests | 0      | 2 (cache + permission resolution) |
| E2E tests         | 0      | 0 (critical gap)                  |

---

## Remaining Gaps

1. **E2E tests not written** -- all 6 scenarios are NOT TESTED. This blocks BETA promotion.
2. **Bulk endpoints** (bulk add, bulk role update, bulk remove) -- not implemented
3. **Role duplicate endpoint** (`POST .../duplicate`) -- not implemented
4. **Available members endpoint** (`GET .../available`) -- not implemented
5. **Permission matrix endpoint** (`GET .../roles/permissions`) -- not implemented
6. **UI layer** (role management page, permission matrix, member tab rewrite) -- not started
7. **GAP-003**: Permission cache 60s TTL propagation delay remains accepted limitation
8. **GAP-004**: ProjectMember lacks tenantId field -- cross-tenant validation joins through project

---

## Deviations from Plan

1. Route parameter `[memberId]` instead of `[userId]` for member routes
2. Service extraction into `ProjectMemberService` for testability (ABLP-327)
3. Project access hardened: non-admin non-members get 404 (security improvement)
4. Permission centralization to `shared-auth` package (not `shared`)
5. Custom role CRUD API implemented ahead of LLD schedule
6. Bulk endpoints deferred to a later phase
