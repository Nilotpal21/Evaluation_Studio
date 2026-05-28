# Feature Spec Audit: Workspace Management v1.0 Parity

**Phase**: FEATURE-SPEC
**Artifact**: `docs/features/workspace-management-v1-parity.md`
**Round**: 1 of 2
**Date**: 2026-04-09
**Auditor**: phase-auditor

---

VERDICT: NEEDS_REVISION

---

## Findings

### CRITICAL (must fix before next phase)

#### [FS-1] Template completeness -- 12 of 18 template sections missing

The spec has 7 informal sections (Problem Statement, Scope, Existing Infrastructure, Requirements, E2E Test Scenarios, Dependencies, Next Steps). The TEMPLATE.md defines 18 required sections. The following are entirely absent:

| Missing Section                                                                                        | Template Ref |
| ------------------------------------------------------------------------------------------------------ | ------------ |
| Goal Statement                                                                                         | Section 1    |
| Summary                                                                                                | Section 1    |
| User Stories                                                                                           | Section 3    |
| Feature Classification & Integration Matrix                                                            | Section 5    |
| Design Considerations                                                                                  | Section 6    |
| How to Consume (Studio UI / API / Admin)                                                               | Section 8    |
| Data Model                                                                                             | Section 9    |
| Key Implementation Files                                                                               | Section 10   |
| Configuration                                                                                          | Section 11   |
| Non-Functional Concerns (isolation, security, performance, reliability, observability, data lifecycle) | Section 12   |
| Delivery Plan / Work Breakdown                                                                         | Section 13   |
| Success Metrics                                                                                        | Section 14   |
| Open Questions                                                                                         | Section 15   |
| Gaps, Known Issues & Limitations                                                                       | Section 16   |
| Testing & Validation                                                                                   | Section 17   |

**Fix**: Restructure the document to follow TEMPLATE.md. Every section must be addressed, with N/A + justification if not applicable.

---

#### [FS-6] Tenant, project, and user isolation not addressed

Section 12 (Non-Functional Concerns) is entirely missing. This feature directly modifies tenant-level data (Tenant model, TenantMember model) and introduces user preferences (defaultTenantId, favoriteTenantIds). Without explicit isolation requirements:

- FR-1 (default workspace): Can user A set user B's default? The `PATCH /api/auth/preferences` endpoint needs explicit `userId` scoping.
- FR-2 (favorites): Same concern -- favorites must be per-user, never cross-user visible.
- FR-5 (workspace settings): `PATCH /api/workspaces/:tenantId` -- must verify the caller is a member of the tenant AND has OWNER/ADMIN role. The spec mentions "Only OWNER/ADMIN" but this is buried in FR-5, not formalized as an isolation requirement.
- FR-6 (workspace deletion): `DELETE /api/workspaces/:tenantId` -- the spec says "Only OWNER" but does not address: what happens to other tenants' references if the deleted tenant had cross-org links? What about the `organizationId` backlink?

**Fix**: Add Section 12 with explicit isolation requirements:

- User isolation: preferences (default, favorites) scoped to `userId`, cross-user access returns 404
- Tenant isolation: workspace settings/deletion require tenant membership verification, cross-tenant access returns 404
- Role-based access: enumerate which roles can perform which operations (OWNER, ADMIN, MEMBER)

---

#### [FS-2] Inaccurate code claim -- `GET /api/auth/tenants` response shape

The spec states (line 39):

> `GET /api/auth/tenants` (returns `{ tenantId, tenantName, role, orgId }`)

The route's OpenAPI response schema at `apps/studio/src/app/api/auth/tenants/route.ts:14-23` declares:

```typescript
z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
});
```

However, the actual service function `getUserTenants` at `apps/studio/src/services/auth-service.ts:413-429` returns `{ tenantId, tenantName, role, orgId }`. So the runtime response matches the spec, but the OpenAPI schema is divergent. The spec should note this OpenAPI/runtime discrepancy as a known issue, and also note that `slug` is NOT currently returned by this endpoint (but the OpenAPI schema claims it is).

**Fix**: Correct the description to note that:

1. The actual runtime response is `{ tenantId, tenantName, role, orgId }` (matches spec claim)
2. The OpenAPI schema at the route level is incorrect (claims `id, name, slug, role`)
3. FR-3 will need to add `memberCount` to this response, which should be reconciled with the schema fix

---

#### [FS-2] Inaccurate code claim -- `settings: any` field

The spec does not explicitly claim `settings: any`, but the Data Model section is missing entirely. However, the Tenant model at `packages/database/src/models/tenant.model.ts:32-43,54` defines:

```typescript
export interface ITenantSettings {
  defaultLLMProvider?: string;
  maxConcurrentSessions?: number;
  enableAuditLogging?: boolean;
  enableClickHouse?: boolean;
  allowedDomains?: string[];
  webhookUrl?: string | null;
  codeToolsEnabled?: boolean;
  [key: string]: unknown;
}
// ...
settings: ITenantSettings | null; // Comment says: "TYPED (was: any)"
```

The `settings` field has already been migrated from `any` to `ITenantSettings | null`. If the spec references `settings: any` anywhere downstream (HLD, LLD), it will be wrong. The Data Model section must document the actual typed interface.

**Fix**: Add Section 9 (Data Model) documenting the `ITenantSettings` interface and noting it is already typed with an index signature for extensibility.

---

### HIGH (should fix)

#### [FS-4] No user stories

The TEMPLATE requires minimum 3 user stories with persona + capability + benefit. The spec has zero user stories. This makes it impossible to validate that the FRs cover real user needs.

**Fix**: Add at least 3 user stories, e.g.:

1. As a **platform user** with multiple workspaces, I want to **set one as my default** so that I **land in my most-used workspace on login without manual switching**.
2. As a **workspace owner**, I want to **rename my workspace and update its slug** so that the **workspace URL reflects our team's current name**.
3. As a **power user** managing 10+ workspaces, I want to **search and favorite workspaces** so that I can **quickly access the ones I use most**.

---

#### [FS-5] Integration matrix missing -- at least 2 related features required

No integration matrix is present. This feature interacts with at minimum:

| Related Feature                | Relationship                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Authentication & SSO           | depends on -- workspace switch issues new JWT, login resolves default workspace        |
| Organization management        | shares data with -- workspaces can belong to organizations, org-scoped creation exists |
| Project lifecycle              | emits into -- workspace deletion cascades to projects                                  |
| Member & invitation management | extends -- workspace settings page needs member/invitation visibility                  |

**Fix**: Add Section 5 with lifecycle/platform impact table and related feature integration matrix.

---

#### [FS-3] FR-1 through FR-6 use implementation language instead of testable requirement language

The FRs mix implementation details (specific endpoints, field names, MongoDB queries) with requirements. Per the TEMPLATE: "Use 'The system must...' language and avoid mixing requirements with implementation details."

Examples:

- FR-1 says "PATCH /api/auth/preferences -- set defaultTenantId" -- this is an implementation decision, not a requirement.
- FR-3 says "Member count: TenantMember.countDocuments({ tenantId })" -- this is a DB query, not a requirement.

**Fix**: Rewrite FRs as testable requirement statements:

- FR-1: "The system must allow an authenticated user to designate one workspace as their default. On login, if the user has a designated default and is still a member, the session must be scoped to that workspace."
- FR-3: "The system must display the number of active members per workspace in the workspace switcher. The system must provide client-side filtering when the user has 5 or more workspaces."

Keep the implementation details in a separate "Technical Considerations" section (Section 7).

---

#### [FS-8] No delivery plan / work breakdown

The TEMPLATE requires "parent tasks with numbered subtasks, not a flat list" (Section 13). The spec has no delivery plan.

**Fix**: Add Section 13 with phased delivery:

```
1. User preferences infrastructure
   1.1 Add defaultTenantId/favoriteTenantIds to User model (or create UserPreference collection)
   1.2 Create PATCH /api/auth/preferences endpoint
   1.3 Update login/token-refresh to respect defaultTenantId
2. Workspace switcher enhancements
   2.1 Add member count to GET /api/auth/tenants response
   2.2 Client-side search in switcher
   2.3 Favorite/default UI controls
   2.4 Create workspace button in switcher
3. Workspace settings page
   3.1 PATCH /api/workspaces/:tenantId route
   3.2 /settings/workspace UI page
   3.3 Slug change with uniqueness validation
4. Workspace deletion
   4.1 Cascading dependency analysis (projects, members, invitations)
   4.2 DELETE /api/workspaces/:tenantId with soft-delete
   4.3 Grace period/archive implementation
   4.4 Confirmation UI
```

---

#### [FS-10] FR-6 workspace deletion scope is underspecified -- cascading concerns

FR-6 (workspace deletion) says "Pre-deletion check: warn about number of projects, members, and agents that will be affected" but does not specify:

1. **What exactly gets deleted?** Projects, sessions, agents, deployments, pipeline configs, LLM credentials, search indexes, connector configs -- all are tenant-scoped.
2. **Cascading delete order**: Some resources have cross-references (sessions reference projects, deployments reference agents). Delete order matters.
3. **Data export**: Users may need to export data before deletion. This is not mentioned.
4. **Active sessions**: What happens to users currently working in a workspace being deleted? Are they kicked out immediately?
5. **Soft-delete vs hard-delete**: The spec says "soft-delete (set status: 'archived') or hard-delete" -- which is it? This is a critical design decision that should be a firm requirement, not "or".

The Tenant model already has `status: 'active' | 'suspended' | 'archived' | 'transferring'` (tenant.model.ts:91-95), so `archived` status exists, but the implications of archiving are not defined.

**Fix**: Split FR-6 into sub-requirements:

- FR-6a: The system must soft-delete (archive) a workspace on owner request, setting status to 'archived'
- FR-6b: Archived workspaces must be excluded from workspace lists and login resolution
- FR-6c: The system must provide a 30-day grace period before permanent deletion
- FR-6d: Permanent deletion must cascade to: [enumerate all tenant-scoped collections]
- FR-6e: Active sessions in an archived workspace must be terminated within [N] minutes

---

#### [FS-2] Inaccurate claim -- create-workspace is NOT restricted to onboarding

The spec states (line 45):

> `POST /api/auth/create-workspace` -- only accessible from `/onboarding` page (no-workspace flow)

This is inaccurate. The API endpoint at `apps/studio/src/app/api/auth/create-workspace/route.ts` requires authentication (`requireAuth`) and checks the 10-workspace limit, but has NO restriction to the onboarding flow. Any authenticated user can call it. The onboarding page is simply the only UI that currently calls it.

**Fix**: Change to: "`POST /api/auth/create-workspace` -- currently called only from the `/onboarding` page UI, but the API has no onboarding-specific guard. FR-4 can reuse this endpoint directly from the switcher."

---

#### [FS-7] Data model section missing -- new collections/fields not specified

The spec proposes:

- New field on User model: `defaultTenantId: string | null` (or separate UserPreference collection)
- New field: `favoriteTenantIds: string[]` (max 3)
- Potential new collection: `UserPreference`

None of these are formally specified with fields, types, indexes, and migration strategy. The "or" in "User model or UserPreference collection" is an unresolved design decision that should be decided at the feature spec level.

**Fix**: Add Section 9 with:

- Decision: User model extension vs. separate UserPreference collection (with pros/cons)
- If User model: specify new fields, indexes, backward compatibility
- If UserPreference: full collection spec with tenantId scoping, indexes

---

### MEDIUM (recommended)

#### [FS-9] Testing section missing -- no link to testing guide

The spec has 7 E2E scenarios (which exceeds the minimum 5, good) but has no formal Testing & Validation section (Section 17), no link to the testing guide location, and no coverage expectations.

**Fix**: Add Section 17 with:

- Required test coverage table mapping each FR to scenarios
- Link: `../testing/workspace-management-v1-parity.md`
- Note: E2E scenarios in the spec should be expanded in the test spec with preconditions, steps, expected results, and auth context

---

#### [FS-10] Favorite workspaces limit of 3 not justified

FR-2 sets `favoriteTenantIds: string[]` with max 3 but provides no rationale for the limit. Is this a v1.0 parity requirement? A UX decision? A technical constraint?

**Fix**: Add justification in FR-2 or in Open Questions. If the limit comes from v1.0 product docs, cite it. If it is a UX decision, note it can be configured.

---

#### [FS-2] Minor inaccuracy -- `createDefaultWorkspace()` status

The spec says (line 69):

> `createDefaultWorkspace()` in workspace-service appears unused

This is confirmed accurate -- the function is exported at `apps/studio/src/services/workspace-service.ts:48` but never imported outside test files. However, calling it "appears unused" is soft language. It IS unused in production code. The spec should note whether FR-4 intends to use it or if it should be cleaned up.

**Fix**: Change to: "`createDefaultWorkspace()` in workspace-service is exported but never imported in production code (only referenced in tests). Consider removing or repurposing for FR-4."

---

#### [HD-10] No open questions -- overconfidence smell

The spec has no Open Questions section. For a feature touching auth flow, data model changes, cascading deletes, and user preferences, there should be genuine open questions. Examples:

- Should `defaultTenantId` live on the User model or in a separate collection?
- How should workspace deletion interact with active billing subscriptions?
- Should archived workspaces be visible to owners during the grace period?
- What happens to workspace-level API keys when a workspace is deleted?

**Fix**: Add Section 15 with at least 3 open questions.

---

## Cross-Phase Consistency

- [XP-1] N/A -- this is the first phase; no prior artifacts exist
- [XP-2] -- The spec as written would NOT enable a quality test spec because: (a) FRs mix requirements with implementation, making it hard to derive test scenarios; (b) no isolation requirements means test spec will miss auth/isolation tests; (c) no data model means test spec cannot verify schema changes
- [XP-3] -- Scope is reasonable; no creep detected. The "Request access to unlisted workspaces" deferral is well-justified.
- [XP-4] -- Terminology is mostly consistent (workspace/tenant used interchangeably is intentional and documented in existing code)
- [XP-5] -- `apps/studio/agents.md` has no workspace-specific learnings; `packages/database/agents.md` has no tenant model gotchas relevant to this feature. No conflicts.

## Verified

- [x] UserMenu.tsx lines 169-242 -- CONFIRMED. The workspace switcher section spans lines 169-242 exactly as claimed.
- [x] `findDefaultTenantMembership()` returns oldest by createdAt -- CONFIRMED at `auth-repo.ts:369-380`: `.sort({ createdAt: 1 })` returns oldest first.
- [x] `updateTenant()` exists in workspace-repo without API route -- CONFIRMED. Function at `workspace-repo.ts:70-92`, no `PATCH /api/workspaces/:tenantId` route exists (only member/invitation sub-routes).
- [x] Per-user workspace limit of 10 -- CONFIRMED at `create-workspace/route.ts:89`: `authConfig?.workspace?.maxPerUser ?? 10`.
- [x] `findTenantMembershipsByUserId()` ignores `select` option -- CONFIRMED at `workspace-repo.ts:189-197`: accepts `opts.select` but never uses it in the query.
- [x] `createWorkspaceWithOwner()` at workspace-repo.ts:350-409 -- CONFIRMED at lines 350-409, transactional tenant + member + seed.
- [x] `POST /api/auth/create-workspace` endpoint exists -- CONFIRMED at `apps/studio/src/app/api/auth/create-workspace/route.ts`.
- [x] `POST /api/organizations/:orgId/workspaces` endpoint exists -- CONFIRMED at `apps/studio/src/app/api/organizations/[orgId]/workspaces/route.ts`.
- [x] Tenant model has status enum including 'archived' -- CONFIRMED at `tenant.model.ts:91-95`.
- [x] 7 E2E scenarios provided (exceeds minimum 5) -- CONFIRMED.
- [x] localStorage persistence via Zustand persist middleware -- CONFIRMED at `auth-store.ts:5`: "Only tenantId is persisted".
- [x] FR-1 default workspace does not conflict with localStorage persistence -- The localStorage persists last-used tenantId for page reloads; FR-1's server-side default is for login/token-refresh when no localStorage exists. These are complementary, not conflicting.

## Notes for Next Round

Focus areas for re-audit after fixes:

1. **Template completeness** -- verify all 18 sections are addressed
2. **Isolation requirements in Section 12** -- verify tenant/user/role isolation is explicit
3. **Data model in Section 9** -- verify the defaultTenantId/favoriteTenantIds storage decision is made
4. **FR-6 cascading delete specification** -- verify sub-requirements enumerate affected collections
5. **Delivery plan structure** -- verify parent tasks with numbered subtasks
