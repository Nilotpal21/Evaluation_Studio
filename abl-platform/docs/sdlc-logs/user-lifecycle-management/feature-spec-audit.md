# Feature Spec Audit: User Lifecycle Management

VERDICT: **NEEDS_REVISION**

PHASE: FEATURE-SPEC
ARTIFACT: `docs/features/user-lifecycle-management.md`
ROUND: 1 of 2

---

## Findings

### CRITICAL (must fix before next phase)

#### [FS-1] Template completeness -- 10 of 18 TEMPLATE.md sections missing

The feature spec is a lean document with Problem Statement, Scope, Existing Infrastructure, Requirements, E2E Scenarios, Dependencies, and Next Steps. It is missing the following TEMPLATE.md sections entirely:

- Section 1 Introduction / Goal Statement / Summary
- Section 3 User Stories (minimum 3 required by FS-4)
- Section 5 Feature Classification & Integration Matrix
- Section 8 How to Consume (Studio UI, API tables)
- Section 9 Data Model (collections, fields, indexes)
- Section 10 Key Implementation Files
- Section 11 Configuration (env vars, runtime config)
- Section 12 Non-Functional Concerns (isolation, security, performance, reliability, observability, data lifecycle)
- Section 13 Delivery Plan / Work Breakdown (parent tasks with numbered subtasks)
- Section 14 Success Metrics
- Section 15 Open Questions
- Section 16 Gaps, Known Issues & Limitations
- Section 17 Testing & Validation
- Section 18 References

**Location**: entire document

**Fix**: Populate every required section from TEMPLATE.md. Sections that are genuinely N/A must include justification. The current document reads as a discovery note, not a complete feature spec.

---

#### [FS-6] Non-functional concerns completely absent -- tenant isolation, security, performance, session invalidation not addressed

The TEMPLATE.md section 12 requires explicit treatment of: isolation & multitenancy, security & compliance, performance & scalability, reliability & failure modes, observability, and data lifecycle. None of these are present.

Specific gaps:

1. **Session invalidation on lock/deactivate**: When `TenantMember.status` is set to non-active, existing JWTs remain valid until they expire. The spec introduces a DB query per authenticated request (FR-1 line 103: "if `TenantMember.status !== 'active'`, deny access") but does not discuss:
   - Performance impact of adding a MongoDB query to every authenticated request across all apps (Studio, Runtime, SearchAI)
   - Whether to use a Redis cache for status lookups
   - Whether to revoke existing refresh tokens on status change (note: `revokeUserRefreshTokens()` already exists in `auth-repo.ts:245`)
   - JWT short-circuit: whether active JWTs should be checked against a revocation list

2. **Tenant isolation for bulk operations**: Bulk invite, bulk role change, and bulk remove all accept arrays of IDs. The spec does not state that every `userId` in a bulk operation must be verified as a member of the target `tenantId` before mutation.

3. **Self-lock protection scope**: FR-2 line 111 says "Cannot lock/deactivate yourself or users with equal/higher role." The spec does not address:
   - What happens if the sole OWNER locks/deactivates all ADMINs and then needs support
   - Whether the last OWNER can be deactivated (this would orphan the workspace)
   - Cross-workspace impact: locking a user's TenantMember in workspace A should not affect their membership in workspace B (the spec hints at this with `TenantMember.status` but never states the invariant explicitly)

4. **Audit logging**: FR-2 mentions audit actions but does not specify the `tenantId` that should be included in every audit event (critical for tenant-scoped audit queries).

**Location**: missing section 12

**Fix**: Add a complete section 12 Non-Functional Concerns addressing all six subsections from TEMPLATE.md. At minimum:

- State the session invalidation strategy (revoke refresh tokens + short-lived JWT + optional Redis status cache)
- State the performance budget for the auth middleware DB query (e.g., "cached in Redis with 30s TTL")
- State the cross-workspace isolation invariant: "Locking TenantMember in workspace A does not affect the user's status in workspace B"
- State that bulk operations must verify all target userIds are members of the specified tenantId
- State that the last OWNER of a workspace cannot be locked or deactivated

---

#### [FS-2] Code grounding error -- `Tenant.settings` is typed, not `any`

The spec at line 168 states:

> Settings stored in `Tenant.settings` JSON field (already exists as `settings: any`)

Actual code in `packages/database/src/models/tenant.model.ts` line 54:

```typescript
settings: ITenantSettings | null; // TYPED (was: any)
```

The `ITenantSettings` interface (lines 32-43) already defines specific fields (`defaultLLMProvider`, `maxConcurrentSessions`, `enableAuditLogging`, etc.) plus an index signature `[key: string]: unknown`. The spec's claim that it's `any` is incorrect and would mislead implementation about backward compatibility.

**Location**: line 168

**Fix**: Update to: "Settings stored in `Tenant.settings` typed field (`ITenantSettings | null`). The interface has an index signature `[key: string]: unknown` allowing extensibility. New settings fields (`defaultRole`, `inviteExpiryDays`, `emailNotifications`) should be added to the `ITenantSettings` interface."

---

### HIGH (should fix)

#### [FS-4] No user stories -- minimum 3 required

The spec has zero user stories. TEMPLATE.md section 3 requires minimum 3, each with persona + capability + benefit format.

**Location**: missing section 3

**Fix**: Add at minimum:

1. As a **workspace admin**, I want to lock a team member's account so that I can immediately prevent access when an employee is terminated.
2. As a **workspace admin**, I want to bulk-invite team members from a CSV file so that I can onboard a large team without repetitive manual invitations.
3. As a **workspace admin**, I want to see a dashboard summary of user statuses so that I can monitor workspace health at a glance.
4. As a **locked user**, I want to receive an email notification when my account is locked so that I understand why I cannot access the workspace.
5. As a **workspace owner**, I want to configure invitation expiry and default role so that invitations follow our company's security policy.

---

#### [FS-5] No integration matrix -- minimum 2 related features required

The spec does not include TEMPLATE.md section 5 (Feature Classification & Integration Matrix). This feature interacts with:

- **Authentication** (depends on) -- lock/unlock directly modifies auth behavior
- **Invitations** (extends) -- configurable expiry, bulk invite extends the existing invitation system
- **RBAC/Permissions** (depends on) -- status check in auth middleware, role hierarchy enforcement
- **Email infrastructure** (depends on) -- new email templates, workspace-level toggle
- **Audit logging** (emits into) -- new audit actions for member lifecycle events
- **SSO** (shares data with) -- if a user logs in via SSO, is TenantMember.status still checked?

**Location**: missing section 5

**Fix**: Add the feature classification table and the related feature integration matrix with at least these 4 relationships, specifying the touchpoints and current state.

---

#### [FS-8] No delivery plan -- flat requirements without phased breakdown

The spec has no section 13 (Delivery Plan / Work Breakdown). The TEMPLATE.md requires parent tasks with numbered subtasks. This feature is substantial (new model field, middleware change, 4 new API routes, 3 bulk operation routes, 6 email templates, UI dashboard, settings page) and needs clear phasing.

**Location**: missing section 13

**Fix**: Add a phased delivery plan. Suggested structure:

1. Schema & model changes (1.1 TenantMember.status field, 1.2 ITenantSettings additions, 1.3 migration script)
2. Auth middleware status check (2.1 Studio middleware, 2.2 Runtime middleware, 2.3 Redis caching)
3. Lock/unlock/deactivate API (3.1 routes, 3.2 audit logging, 3.3 session invalidation)
4. Dashboard summary API + UI (4.1 aggregation endpoint, 4.2 MembersPage summary cards)
5. Bulk operations (5.1 bulk invite, 5.2 bulk role change, 5.3 bulk remove, 5.4 CSV parsing)
6. Search & filter (6.1 server-side filtering, 6.2 pagination, 6.3 UI filter controls)
7. Email notifications (7.1 new templates, 7.2 event-driven sending, 7.3 workspace toggle)
8. Configurable settings (8.1 settings API, 8.2 settings UI)

---

#### [FS-3] Status enum design -- `suspended` vs `inactive` is ambiguous

FR-1 defines four statuses:

- `active`: normal access
- `inactive`: "member exists but cannot access the workspace (soft-disable)"
- `suspended`: "admin-imposed restriction, cannot access workspace"
- `locked`: "auto-locked from failed attempts"

The difference between `inactive` and `suspended` is unclear. Both mean "admin prevents workspace access." The spec's own descriptions are nearly identical ("cannot access the workspace" vs "cannot access workspace"). This ambiguity will cause confusion during implementation and for admin users.

Additionally, `locked` overlaps with the existing temporal lock (`loginLockedUntil`). The spec at line 102 says locked "mirrors `loginLockedUntil` semantic" but `loginLockedUntil` is a User-level temporal lock that auto-expires, while `TenantMember.status = 'locked'` would be a workspace-scoped permanent flag. These are fundamentally different things. What happens when:

- `loginLockedUntil` expires but `TenantMember.status` is still `locked`?
- An admin manually locks a user (sets `status: locked`) -- does `loginLockedUntil` also get set?
- A user's `loginLockedUntil` triggers from failed attempts -- does `TenantMember.status` change to `locked`?

**Location**: lines 98-103

**Fix**: Either:

- **Option A**: Reduce to 3 states: `active | suspended | locked`. `suspended` = admin-imposed, `locked` = auto-locked from failed attempts. Drop `inactive` since it's identical to `suspended`.
- **Option B**: Keep 4 states but clearly differentiate: `inactive` = user chose to leave / was offboarded (reversible), `suspended` = admin disciplinary action (requires explicit admin unlock). Document the semantic distinction with concrete use-case examples.
- **For lock semantics**: Explicitly state that `TenantMember.status = 'locked'` is set automatically when `loginLockedUntil` is triggered and cleared automatically when the temporal lock expires OR when an admin manually unlocks. Alternatively, remove `locked` from TenantMember status entirely and keep temporal lock at the User level only.

---

#### [FS-10] Email toggle scope not defined

FR-6 line 159 says: "`Tenant.settings.emailNotifications: boolean` (default: true)". FR-7 line 167 repeats: "`emailNotifications`: enable/disable event emails (default: true)".

Neither specifies what "event emails" covers. Does `emailNotifications: false` suppress:

- Invitation emails? (These are transactional and critical for onboarding)
- Account locked/unlocked notifications? (Security-critical)
- All lifecycle emails including member added/removed?

If the toggle suppresses invitation emails, a workspace admin who disables notifications will break the invitation flow because invitees won't receive their accept links.

**Location**: lines 159, 167

**Fix**: Specify which email types are affected by the toggle. Recommended: invitation emails and password reset emails are always sent regardless of the toggle (they are transactional/security-critical). The toggle should only control informational notifications: member added, member removed, role changed, account locked, account unlocked.

---

#### [FS-3] Bulk invite CSV validation rules missing

FR-4 specifies CSV bulk invite with max 100 per request, but does not specify:

- CSV format (headers required? column order?)
- Email validation rules (regex? DNS check?)
- Duplicate handling within a single batch (if same email appears twice)
- Duplicate handling across batches (if email already has a pending invitation)
- File size limit
- Character encoding expectations

**Location**: lines 133-137

**Fix**: Add CSV format specification (e.g., "CSV with `email,role` headers, UTF-8 encoded, max 1MB"). Add duplicate handling: "Duplicate emails within the same batch are deduplicated. If the email already has a pending invitation, the existing invitation is preserved and the email is included in the `failed` response with reason `INVITATION_ALREADY_PENDING`."

---

#### Auth middleware change performance impact not addressed

FR-1 line 103 says: "Status checks in auth middleware: if `TenantMember.status !== 'active'`, deny access with appropriate error."

This adds a MongoDB query to every authenticated request. The current auth middleware validates JWTs (stateless) and resolves tenant context (potentially cached). Adding a `TenantMember.findOne({ userId, tenantId })` query on every request is a significant performance change.

**Location**: line 103

**Fix**: Address in the non-functional performance section. Specify caching strategy: "TenantMember status is cached in Redis with key `member-status:{tenantId}:{userId}` and a 30-second TTL. Status change operations (lock, unlock, deactivate, activate) must invalidate this cache entry."

---

### MEDIUM (recommended)

#### [FS-9] No testing section

TEMPLATE.md section 17 requires a testing section with coverage expectations and a link to the testing guide. The spec has an "E2E Test Scenarios" section (good, 8 scenarios -- exceeds minimum 5) but no coverage matrix, no link to `docs/testing/user-lifecycle-management.md`, and no mention of integration test expectations.

**Location**: missing section 17

**Fix**: Add section 17 with a coverage matrix referencing the 8 E2E scenarios, state that integration tests are required for each API endpoint, and add link: "Full testing details: `../testing/user-lifecycle-management.md`"

---

#### No success metrics

TEMPLATE.md section 14 requires success metrics with baseline, target, and measurement method. The spec has none.

**Location**: missing section 14

**Fix**: Add success metrics. Examples:

- "Admin can lock a member and the member is denied access within 30 seconds (cache TTL)"
- "Bulk invite of 100 users completes within 10 seconds"
- "Dashboard summary loads within 200ms"

---

#### No open questions

TEMPLATE.md section 15 requires at least 1 open question. The spec has none. This is a smell for a feature this complex.

**Location**: missing section 15

**Fix**: Add genuine open questions. Candidates:

1. Should `TenantMember.status` changes be propagated to Runtime in real-time (via Redis pub/sub) or is a 30s cache TTL acceptable?
2. Should bulk remove operations hard-delete TenantMember records or soft-delete (set status to a terminal state)?
3. Should email notifications be async (queued via BullMQ) or synchronous fire-and-forget?
4. For SSO users, should admin lock override SSO access?

---

#### [FS-7] Data model not specified

TEMPLATE.md section 9 requires collection definitions with fields, types, and indexes. The spec mentions adding fields in the "What's missing on models" table and in FR-1/FR-7 but does not give a complete data model specification with indexes.

**Location**: missing section 9

**Fix**: Add section 9 with:

```
Collection: tenant_members (modification)
New Fields:
  - status: string (enum: active|inactive|suspended|locked, default: 'active', indexed)
  - lastActiveAt: Date | null
New Indexes:
  - { tenantId: 1, status: 1 } (for dashboard summary aggregation)

Collection: tenants (modification)
Modified Fields:
  - settings.defaultRole: string (default: 'MEMBER')
  - settings.inviteExpiryDays: number (default: 7, min: 1, max: 30)
  - settings.emailNotifications: boolean (default: true)
```

---

#### E2E scenario 7 may be untestable as written

E2E scenario 7 at line 179: "Email notification on role change -- Change Bob's role -> Bob receives email notification (or verify email service called)."

The parenthetical "(or verify email service called)" suggests mocking the email service, which violates E2E test standards (no mocks). In a real E2E test, you would either:

- Use a test email service (like Mailhog/Mailpit) and query its API for received messages
- Use the ConsoleEmailService and capture stdout

**Location**: line 179

**Fix**: Rewrite as: "Change Bob's role -> verify ConsoleEmailService logs the notification OR query the test email capture service (Mailpit) for the role change email."

---

## Cross-Phase Consistency

- [XP-1] N/A -- This is Phase 1, no prior-phase artifacts exist
- [XP-2] **FAIL** -- The artifact does not enable the next phase (test spec) adequately because FRs lack testable precision. FR-1 does not specify error codes/messages for each status. FR-4 does not specify CSV format. FR-6 does not specify which emails the toggle controls.
- [XP-3] N/A -- First phase, no scope lock to check
- [XP-4] **WARN** -- The spec uses "workspaces" in API paths (`/api/workspaces/:tenantId/`) which is the established convention, but also says "workspace-level setting" while the model is `Tenant`. Ensure consistent terminology.
- [XP-5] **PASS** -- `packages/database/agents.md` reviewed. No directly contradicting learnings, but the TenantMember model's tenant isolation plugin usage (line 47) should be noted when adding status field.

## Verified

- [x] `failedLoginAttempts` field exists on User model (line 50 of user.model.ts) -- **CONFIRMED**
- [x] `loginLockedUntil` field exists on User model (line 51 of user.model.ts) -- **CONFIRMED**
- [x] `lastLoginAt` field exists on User model (line 48 of user.model.ts) -- **CONFIRMED**
- [x] `mfa.failedAttempts` / `mfa.lockedUntil` embedded fields exist (lines 27-28 of user.model.ts) -- **CONFIRMED**
- [x] No `status` field on TenantMember model -- **CONFIRMED** (tenant-member.model.ts has only: \_id, tenantId, userId, role, customRoleId, \_v, timestamps)
- [x] `lockUserAccount()` at auth-repo.ts lines 142-149 -- **CONFIRMED** (exact line numbers match)
- [x] `resetFailedLoginAttempts()` at auth-repo.ts lines 154-161 -- **CONFIRMED** (exact line numbers match)
- [x] `ACCOUNT_LOCKED` audit action exists in audit-service.ts -- **CONFIRMED** (line 46)
- [x] Login route checks `loginLockedUntil > now` returning HTTP 423 with code `ACCOUNT_LOCKED` -- **CONFIRMED** (login/route.ts lines 107-116)
- [x] `INVITE_EXPIRY_DAYS = 7` hardcoded at invitation-service.ts line 26 -- **CONFIRMED**
- [x] `createEmailService()` pluggable with SES/Resend/SMTP/Console -- **CONFIRMED** (email-service.ts in packages/shared)
- [x] Email templates exist for verification, password reset, workspace invitation -- **CONFIRMED** (email-templates.ts exports all three)
- [x] Missing templates for member added, role changed, account locked/unlocked -- **CONFIRMED** (only 3 templates exist)
- [x] `Tenant.settings` field exists -- **CONFIRMED** but typed as `ITenantSettings | null`, not `any` (tenant.model.ts line 54)
- [x] MembersPage.tsx exists with members table, invite form, invitations table -- **CONFIRMED** (apps/studio/src/components/admin/MembersPage.tsx)
- [x] No bulk operations exist -- **CONFIRMED** (no bulk routes found)
- [x] 5 max failed attempts, 15-min lock duration -- **CONFIRMED** (auth-constants.ts lines 127-128)
- [x] `lockUserAccount()` has no API route calling it -- **CONFIRMED** (only referenced in auth-repo.ts itself)

## Notes for Next Round

Focus areas for R2 re-audit after fixes:

1. **Section completeness**: Verify all 18 TEMPLATE.md sections are populated
2. **Status enum design**: Verify the `inactive` vs `suspended` ambiguity is resolved with clear semantic distinction or reduction to 3 states
3. **Lock semantics**: Verify the relationship between User-level `loginLockedUntil` and TenantMember-level `status: locked` is explicitly documented
4. **Session invalidation strategy**: Verify the non-functional section addresses JWT/refresh-token invalidation on status change
5. **Performance budget**: Verify the auth middleware DB query has a caching strategy
6. **Email toggle scope**: Verify which email types are controlled by the toggle vs always-send
7. **Cross-workspace isolation**: Verify the invariant that TenantMember status in workspace A does not affect workspace B is stated
8. **`Tenant.settings` code grounding**: Verify the `ITenantSettings` type reference is accurate
