# LLD Round 6 Audit: Project RBAC Management Layer

**Auditor**: lld-reviewer
**Date**: 2026-04-09
**Artifact**: `docs/plans/2026-04-09-project-rbac-management-impl-plan.md`
**Prior Rounds**: 5 (all CRITICAL/HIGH resolved per `lld.log.md`)
**Status**: Round 6 — final sweep

---

## Summary

The LLD is well-structured after 5 prior audit rounds. The critical architectural decisions (D-8 through D-17) are sound. The two-layer auth model, backfill strategy, and direct `Project.find()` approach are correctly specified. This round focuses on implementation-level accuracy that prior rounds may have missed.

---

## Findings

### F-1: `createdBy` field does not exist on `ProjectAgent` model

**Severity**: CRITICAL
**Category**: Implementation Feasibility
**Finding**: Task 1.7 specifies `findProjectAgentsByUser(projectId, userId)` that queries `ProjectAgent.find({ projectId, createdBy: userId })`. The `ProjectAgent` model (`packages/database/src/models/project-agent.model.ts`) does NOT have a `createdBy` field. The available fields are `ownerId` (nullable string) and `lastEditedBy` (nullable string).
**Evidence**:

- LLD line 307: `Queries ProjectAgent.find({ projectId, createdBy: userId })`
- `project-agent.model.ts` lines 23-24: `ownerId: string | null; ownerTeamId: string | null;` — no `createdBy`
- The `IProjectAgent` interface (lines 14-31) confirms the full schema — `createdBy` is absent

**Recommendation**: Change the query to `ProjectAgent.find({ projectId, ownerId: userId })`. Also update the deletion guard description in task 2.1 (line 374) from "user owns agents" to "user is agent owner via `ownerId`". Note that `ownerId` is nullable — agents may have `ownerId: null`, which means they wouldn't block any member removal. The LLD should specify behavior for agents with null `ownerId`.

---

### F-2: Cross-app import of `PROJECT_ROLE_PERMISSIONS` from runtime into studio

**Severity**: HIGH
**Category**: Architecture Compliance / Pattern Consistency
**Finding**: Task 2.7 (line 449) says the permission matrix route will derive its response from `PROJECT_ROLE_PERMISSIONS` in runtime `rbac.ts` — "import the constant and transform". Studio does not import from the runtime app; they are separate apps with no cross-dependency. The wiring checklist (line 892) hedges with "(or fetches via API)" but the primary instruction is a direct import.
**Evidence**:

- `PROJECT_ROLE_PERMISSIONS` is exported from `apps/runtime/src/middleware/rbac.ts:405`
- Studio's imports from runtime are limited to proxy URLs (`@/config/runtime`), never direct code imports
- No `@app/runtime` or similar import alias exists in studio's tsconfig

**Recommendation**: Either (a) move `PROJECT_ROLE_PERMISSIONS` to a shared package (e.g., `@agent-platform/shared/rbac`) so both apps can import it, or (b) duplicate the permission mapping as a constant in the studio route file with a comment noting it must stay in sync with runtime, or (c) have the permission matrix route call a runtime API endpoint. Option (a) is the architecturally correct solution. The LLD must specify which approach to use.

---

### F-3: `DELETE` with request body for bulk-remove endpoint

**Severity**: HIGH
**Category**: Pattern Consistency
**Finding**: Task 2.6 (line 440-442) specifies `DELETE /api/projects/:id/members/bulk` with a JSON body `{ userIds: [...] }`. HTTP DELETE with a body is technically allowed but discouraged by RFC 9110, and some clients/proxies strip the body. No other route in the studio app uses DELETE with a body — all existing DELETE handlers take the resource ID from the URL path.
**Evidence**:

- All existing `DELETE` exports in `apps/studio/src/app/api/projects/**/route.ts` use URL params, not request body
- RFC 9110 section 9.3.5: "A client SHOULD NOT generate content in a DELETE request"

**Recommendation**: Change to `POST /api/projects/:id/members/bulk-remove` with the same body. This is consistent with how other codebase patterns handle destructive bulk operations (e.g., `POST /:id/retire` for deployments). Update the LLD's file map — this would be a new route file `apps/studio/src/app/api/projects/[id]/members/bulk-remove/route.ts` rather than a DELETE handler in the bulk route.

Alternatively, if the LLD prefers keeping bulk operations on a single route file, use `POST /api/projects/:id/members/bulk` with an `action` discriminator field: `{ action: 'add' | 'update-role' | 'remove', ... }`. But the separate-route approach is simpler.

---

### F-4: `simulate:*` and `analytics:read` permissions are not enforced anywhere

**Severity**: MEDIUM
**Category**: Completeness
**Finding**: The `tester` role (task 1.5, lines 278-296) includes `simulate:*` and `analytics:read` permissions. However, no route in the runtime currently calls `requireProjectPermission(req, res, 'simulate:...')` or `requireProjectPermission(req, res, 'analytics:read')`. The tester role's differentiation from viewer is therefore inoperative at the permission enforcement level — both roles would have identical effective access.
**Evidence**:

- Grep for `simulate:` and `analytics:read` in `apps/runtime/src/` returns 0 matches
- The `session:create` permission IS enforced, which does differentiate tester from viewer

**Recommendation**: This is acceptable for the current scope since `session:create` provides the key tester capability (simulation). Add a note in the LLD's Open Questions section that `simulate:*` and `analytics:read` are forward-looking permissions that will be enforced when the respective features add RBAC checks. No code change needed — just documentation clarity.

---

### F-5: `PATCH /api/projects/:id/members/bulk` for bulk role update uses non-standard HTTP method

**Severity**: MEDIUM
**Category**: Pattern Consistency
**Finding**: Task 2.6 uses `PATCH` on the bulk route for role updates. While technically valid, the existing codebase exclusively uses `PATCH` for single-resource updates with path-identified resources. Bulk operations use `POST` everywhere else.
**Evidence**:

- Lines 437-439: `PATCH /api/projects/:id/members/bulk — bulk update roles`
- All existing PATCH handlers in studio routes operate on a single resource identified by URL params

**Recommendation**: Change to `POST /api/projects/:id/members/bulk-update-role` for consistency. Or if keeping the single bulk route file, use POST with action discriminator as described in F-3.

---

### F-6: Bulk route file has POST + PATCH + DELETE on same path — Next.js routing concern

**Severity**: MEDIUM
**Category**: Implementation Feasibility
**Finding**: Task 2.6 puts three HTTP methods on `apps/studio/src/app/api/projects/[id]/members/bulk/route.ts`: POST (bulk add), PATCH (bulk update), DELETE (bulk remove). Next.js app router supports multiple exported method handlers per route file, so this is technically fine. However, combined with F-3 and F-5, this creates an unusual pattern.
**Evidence**: Lines 432-442

**Recommendation**: If F-3 and F-5 are accepted (switching to separate POST routes), this finding is resolved automatically. If the current design is kept, it works — just note it's a departure from the existing pattern where each route file typically has 1-2 methods.

---

### F-7: Response envelope inconsistency — `ProjectMembersListResponse` uses `members` key instead of `data`

**Severity**: LOW
**Category**: API Quality
**Finding**: The `GET /api/projects/:id/members` response uses `{ success: true, members: [...], summary: {...} }` (line 110-117). The existing studio API convention uses `successJson(key, data)` which produces `{ success: true, [key]: data }`. This is actually consistent — `successJson('members', membersArray)` would produce `{ success: true, members: [...] }`. The `summary` field is an additional top-level key. This should use the pattern: `{ success: true, members: [...], summary: {...} }` which requires `NextResponse.json()` directly rather than `successJson()`.
**Evidence**: Line 393 specifies the standard pattern; line 457-459 adds summary which extends beyond `successJson`.

**Recommendation**: The LLD should note that the members list endpoint uses `NextResponse.json()` directly (like `actionJson`) rather than `successJson()`, since it needs both `members` and `summary` as top-level keys. Or wrap summary inside the members response: `{ success: true, data: { members: [...], summary: {...} } }` using `successJson('data', { members, summary })`.

---

### F-8: Phase 0 backfill lacks tenant scoping on `Project.find()`

**Severity**: LOW
**Category**: Architecture Compliance
**Finding**: Phase 0 (line 191) queries `Project.find({}, { _id: 1, ownerId: 1 })` — a global unscoped query. While this is intentional for a one-time backfill, it deviates from the core invariant that every query includes `tenantId`.
**Evidence**: CLAUDE.md core invariant #1: "Every query includes tenantId."

**Recommendation**: Acceptable for a one-time backfill script. Add a comment in the LLD task 0.1 explicitly noting this is a global administrative operation, and that production queries in the repo file must always scope by tenant. The backfill function should NOT be exposed as a regular API endpoint.

---

### F-9: Missing `tenantId` on `ProjectMember` model — implicit isolation gap

**Severity**: LOW
**Category**: Architecture Compliance
**Finding**: The `ProjectMember` model lacks a `tenantId` field. Tenant isolation is achieved indirectly through `projectId` (projects are tenant-scoped). This means cross-tenant queries on `ProjectMember` are possible if a `projectId` is guessed. However, all access paths in the LLD verify tenant ownership first (via `requireProjectAccess` or `findProjectByIdAndTenant`), so this is defense-in-depth rather than a functional gap.
**Evidence**: `project-member.model.ts` — no `tenantId` field in schema

**Recommendation**: No change needed for this LLD. Note as a future improvement: adding `tenantId` to `ProjectMember` would enable direct tenant-scoped queries and add defense-in-depth. This is consistent with how `ProjectAgent` has `tenantId` even though it's also project-scoped.

---

### F-10: E2E scenario 11 tests `GET /available` returning 403 for viewer, but the LLD's auth model is unclear

**Severity**: LOW
**Category**: Cross-Phase Consistency
**Finding**: Scenario 11 (line 780-781) expects `GET /api/projects/:id/members/available` to return 403 for a viewer. Task 2.4 (line 412) says this endpoint requires "service-level admin check". But the route level uses `requireTenantAuth + requireProjectAccess` which grants access to all same-tenant users. The 403 would come from the service layer calling `assertCallerCanManageMembers`. This is consistent with D-10/D-11 but the scenario should explicitly note the response comes from the service layer, not the route middleware.
**Evidence**: Lines 409-413 vs line 780-781

**Recommendation**: No code change needed. The scenario is correct in its expected behavior — just ensure the implementation calls `assertCallerCanManageMembers` in the `available` endpoint handler before returning results.

---

### F-11: Missing SWR cache invalidation strategy

**Severity**: LOW
**Category**: Frontend State & UX
**Finding**: The LLD's Phase 3 (task 3.2) says "Re-fetch after every mutation" but does not specify the mechanism. The checklist item "LLD specifies SWR cache invalidation strategy after mutations" is not met. The studio uses direct fetch (via `apiFetch`) not SWR, so this may not apply. But the LLD should specify whether the members list uses polling, manual refetch, or state management.
**Evidence**: Line 531: "Re-fetch after every mutation (add/remove/role change) to keep list current"

**Recommendation**: Specify that the component uses a `useEffect` dependency on a mutation counter (or similar mechanism) to trigger refetch. Alternatively, if the component uses `useState` + `fetchProjectMembers()` directly, specify that each mutation callback calls `fetchProjectMembers()` in its `.then()` handler.

---

## Checklist Verification

### Architecture Compliance

- [x] Tenant isolation: `findUserAccessibleProjects` scopes by `tenantId`, `findProjectByIdAndTenant` used for all project lookups
- [x] Project scoping: `requireProjectAccess` on every route, `projectId` in every member query
- [x] Cross-scope returns 404: documented in D-11, enforced by `requireProjectAccess`
- [x] Auth: uses `requireTenantAuth`/`requireAuth` from `@/lib/auth`, not custom JWT verification
- [x] Stateless: no pod-local state, reads from MongoDB
- [x] Traceability: audit events for all member operations (ADDED, REMOVED, ROLE_CHANGED, BULK_ADDED)

### Pattern Consistency

- [x] Repo functions follow `ensureDb()` + dynamic import + `normalizeId` pattern (matching `project-repo.ts`)
- [x] Routes use `withOpenAPI` wrapper (matching existing project sub-routes)
- [x] Permission resolution uses `hasPermission` from `@/lib/permission-resolver` (verified import path)
- [x] `createLogger` specified for both new modules
- [x] File paths match Next.js app router conventions (`[id]`, `[userId]`)
- [x] Error handling uses `ErrorCode` constants from `@/lib/api-response`

### API Quality

- [x] All responses use standard envelope `{ success, [key] }` or `{ success: false, errors }`
- [x] All route params validated with Zod `.safeParse()`
- [x] Bulk array inputs validate element types and enforce max size (`.max(50)`)
- [x] No stub endpoints — all routes have specified logic

### i18n

- [x] Namespace: `settings.members.*` — consistent with existing `settings.*` pattern
- [x] 35+ translation keys specified covering all UI states including bulk ops, search, permission matrix
- [x] Role labels use i18n keys (`roles.admin`, `roles.developer`, `roles.tester`, `roles.viewer`)
- [x] Status values not applicable (members don't have status)
- [x] `useTranslations('settings')` continues using `next-intl` (no migration needed)

### Frontend State & UX

- [x] API client uses `apiFetch` + `handleResponse` from `@/lib/api-client`
- [x] Loading states specified: spinner on initial load, mutation buttons disabled during async
- [x] Error states specified: inline error messages, toast for success

### Completeness

- [x] All 4 problems from the problem statement have corresponding implementation tasks
- [x] All new files listed in file-level change map with LOC estimates
- [x] All modified files listed with specific change descriptions
- [x] Wiring checklist is comprehensive (25 items)
- [x] 18 E2E scenarios cover CRUD, bulk, auth, cross-tenant, deletion guard, search/filter, permissions
- [x] Phase dependencies are correct: 0 (backfill) -> 1 (data) -> 2 (API) -> 3 (UI) -> 4 (E2E)
- [x] Exit criteria for each phase are specific and verifiable

### Domain-Specific

- [x] No pipeline stages, connectors, or BullMQ flows affected
- [x] No in-memory Maps introduced (existing `memberCache` in runtime has TTL/max already)

### Task Independence

- [x] Phases are sequential (not parallel), so file overlap between phases is acceptable
- [x] No hidden dependencies within phases

---

## Verdict: CONDITIONAL PASS

**Blocking issues**: 1 CRITICAL (F-1), 2 HIGH (F-2, F-3)

The LLD is architecturally sound and thoroughly reviewed through 5 prior rounds. The remaining findings are implementation-level accuracy issues that were likely introduced during the extensive revision process:

1. **F-1 (CRITICAL)**: `createdBy` field doesn't exist on `ProjectAgent` — must be changed to `ownerId`. Simple fix but would cause a runtime error if implemented as written.

2. **F-2 (HIGH)**: Cross-app import of `PROJECT_ROLE_PERMISSIONS` — needs architectural decision on where to place the shared constant.

3. **F-3 (HIGH)**: `DELETE` with body for bulk remove — switch to `POST` for consistency with codebase patterns.

Once these three are resolved, the LLD is ready for implementation.

---

## Implementation Notes

1. The `ProjectAgent.ownerId` field is nullable — the deletion guard should treat `null` ownerId as "no owner" (does not block removal). Specify this in the service logic.

2. The `memberCache` in runtime has a 5-second TTL. After Studio adds/removes a member, the runtime RBAC check will reflect the change within 5 seconds. This is documented and acceptable.

3. The existing `project-services.test.ts` uses `vi.mock` for `@/repos/project-repo`. Adding `project-member-repo` as a new dependency to `project-service.ts` will require updating this test's mock setup. The LLD's exit criteria (line 325) correctly calls this out.

4. The `findUserAccessibleProjects` function returns bare `Project` documents that lack `_count.agents`. The LLD correctly identified this (R4 finding) and added explicit `ProjectAgent.countDocuments` enrichment. Verify this is implemented.

5. For the permission matrix, strongly recommend option (a) from F-2: extract `PROJECT_ROLE_PERMISSIONS` to `@agent-platform/shared/rbac` or `@agent-platform/shared-auth/rbac` where `hasPermission` already lives. Both apps already depend on this package.
