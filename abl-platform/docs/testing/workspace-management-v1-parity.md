# Test Spec: Workspace Management v1.0 Parity

**Feature Spec**: [docs/features/workspace-management-v1-parity.md](../features/workspace-management-v1-parity.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-14

---

## Coverage Matrix

| FR    | Description                           | Unit | Integration (mocked) | Real E2E | Notes                                                           |
| ----- | ------------------------------------- | ---- | -------------------- | -------- | --------------------------------------------------------------- |
| FR-1  | Default Workspace                     | --   | --                   | --       | `PATCH /api/auth/preferences` not yet built                     |
| FR-2  | Favorite Workspaces                   | --   | --                   | --       | `PATCH /api/auth/preferences` not yet built                     |
| FR-3  | Workspace Search                      | --   | --                   | --       | Client-side search UI not yet implemented                       |
| FR-4  | Workspace Metadata (member count)     | --   | --                   | --       | `memberCount` not wired to tenants response                     |
| FR-5  | Create Workspace from Switcher        | --   | --                   | --       | UI button exists (ABLP-339), no test coverage                   |
| FR-6  | Workspace Settings (name, slug)       | --   | 12 tests             | --       | `api-workspace-settings.test.ts`                                |
| FR-7  | Workspace Soft-Delete (archive)       | --   | 25 tests             | --       | `api-soft-delete.test.ts`                                       |
| FR-8  | Grace Period (30 days)                | --   | 3 tests              | --       | `api-soft-delete.test.ts` (within/expired)                      |
| FR-9  | Permanent Deletion Cascade            | --   | --                   | --       | Background job not yet implemented                              |
| FR-10 | Deletion Confirmation Dialog          | --   | --                   | --       | UI not yet implemented                                          |
| --    | Member lifecycle (lock/suspend/deact) | --   | 45 tests             | --       | `api-user-lifecycle.test.ts`                                    |
| --    | Member role changes and removal       | --   | 17 tests             | --       | `api-workspace-lifecycle-e2e.test.ts`                           |
| --    | Project member RBAC                   | 22   | 10 tests             | --       | `project-member-service.test.ts`, `api-project-members.test.ts` |
| --    | Route handler RBAC gates              | --   | 14 tests             | --       | `route-handler-rbac.test.ts`                                    |
| --    | Workspace name sanitization           | 4    | --                   | --       | `workspace-name.test.ts`                                        |

## E2E Scenarios (Planned -- Real HTTP Tests)

None implemented yet. All current tests use `vi.mock` for internal modules.

**Priority scenarios for real E2E:**

1. Workspace archive/restore lifecycle via HTTP API with full middleware chain
2. Member lock/suspend/deactivate/reactivate via HTTP API
3. Cross-tenant isolation -- user in workspace A cannot access workspace B resources
4. Project member RBAC -- add/update/remove members through project API
5. Workspace settings update -- slug uniqueness validation through real database

## Integration Scenarios (Mocked Route Handlers)

All 149 current tests exercise route handler logic with mocked database operations. They validate:

- Request validation (Zod schema parsing)
- Permission gating (OWNER/ADMIN role checks)
- Error responses (404 concealment, 400 validation, 403 forbidden, 409 conflict, 410 expired)
- State transition guards (e.g., "only active members can be locked")
- Cross-tenant isolation (tenant context mismatch returns 404)
- Cascade behavior (workspace archive cascades to projects)

**Limitations**: These tests cannot catch auth middleware gaps, database-level race conditions, index constraint violations, or serialization bugs.

## Unit Test Scenarios

26 unit tests cover:

- Project member service permission hierarchy (22 tests)
- Workspace name sanitization (4 tests)

## Test File Mapping

| File                                                                       | Lines | Tests | Type        |
| -------------------------------------------------------------------------- | ----- | ----- | ----------- |
| `apps/studio/src/__tests__/api-routes/api-user-lifecycle.test.ts`          | 1399  | 45    | integration |
| `apps/studio/src/__tests__/api-routes/api-workspace-lifecycle-e2e.test.ts` | 1232  | 17    | integration |
| `apps/studio/src/__tests__/project-member-service.test.ts`                 | 553   | 22    | unit        |
| `apps/studio/src/__tests__/api-routes/api-workspace-settings.test.ts`      | 408   | 12    | integration |
| `apps/studio/src/__tests__/api-routes/api-project-members.test.ts`         | 350   | 10    | integration |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`          | 288   | 14    | integration |
| `apps/studio/src/__tests__/api-routes/api-soft-delete.test.ts`             | ~600  | 25    | integration |
| `apps/studio/src/lib/__tests__/workspace-name.test.ts`                     | 23    | 4     | unit        |

## Summary

| Type                 | Tests | Status                         |
| -------------------- | ----- | ------------------------------ |
| Unit                 | 26    | Passing                        |
| Integration (mocked) | 123+  | Passing                        |
| Real E2E (HTTP API)  | 0     | Not yet implemented            |
| **Total**            | 149+  | Handler logic covered, E2E gap |

## Remaining Gaps

1. **No real HTTP E2E tests** -- all tests mock internal modules. Priority: archive/restore lifecycle, member lifecycle, cross-tenant isolation.
2. **FR-1/FR-2 untested** -- default workspace and favorites not yet implemented.
3. **FR-3/FR-4 untested** -- search and member count UI not yet implemented.
4. **FR-9/FR-10 untested** -- permanent deletion cascade and confirmation dialog not yet implemented.
5. **FR-5 no test** -- create workspace from switcher has UI button but no test.
