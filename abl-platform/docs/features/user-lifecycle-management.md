# Feature: User Lifecycle Management

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `admin operations`, `governance`, `enterprise`
**Package(s)**: `apps/studio`, `packages/database`, `packages/shared`, `packages/config`
**Owner(s)**: `platform-team`
**Testing Guide**: `../testing/user-lifecycle-management.md`
**Last Updated**: 2026-04-09

---

## 1. Introduction / Overview

### Problem Statement

Workspace administrators have no ability to manage the lifecycle state of their members beyond basic role assignment and removal. When an employee is terminated, goes on leave, or exhibits suspicious activity, admins cannot immediately restrict their access without fully removing them from the workspace. There is no mechanism for admin-initiated account locking, no bulk operations for onboarding large teams, and no dashboard visibility into member status distribution. The existing temporal lockout from failed logins (`failedLoginAttempts` + `loginLockedUntil` on the User model) is automatic and time-bound but has no admin-facing controls or workspace-scoped status tracking.

### Goal Statement

Provide workspace administrators with complete member lifecycle controls: status tracking (active/suspended/locked), admin lock/unlock and suspension, a dashboard summary of member states, bulk operations for onboarding and management, configurable workspace settings (invitation expiry, default role, notification preferences), and event-driven email notifications for lifecycle changes.

### Summary

This feature adds a `status` field to the TenantMember model with three states (`active`, `suspended`, `locked`), introduces admin APIs for status transitions, enhances the members list with search/filter/pagination and summary counts, adds bulk invite (including CSV), bulk role change, and bulk remove operations, makes invitation expiry and default role configurable per workspace, and sends email notifications on member lifecycle events. Auth middleware is updated to check member status on every authenticated request (cached in Redis with 30s TTL), and refresh tokens are revoked on status transitions away from `active`.

---

## 2. Scope

### Goals

- Add workspace-scoped member status tracking with three states: `active | suspended | locked`
- Provide admin APIs and UI for locking, unlocking, suspending, and activating members
- Display dashboard summary counts (total, active, suspended, locked) in the admin members page
- Support bulk invite (JSON and CSV), bulk role change, and bulk remove operations
- Add search, filter, and pagination to the members list API and UI
- Send email notifications on member lifecycle events (added, removed, role changed, locked, unlocked)
- Make invitation expiry duration and default role configurable per workspace
- Enforce status checks in auth middleware with Redis caching for performance

### Non-Goals (Out of Scope)

- Active Directory sync to platform User records (AD sync currently feeds Neo4j for search-ai only)
- SCIM provisioning (no implementation exists)
- Profile field visibility controls (low priority for current phase)
- Password policy management (already exists via `packages/config/src/schemas/auth.schema.ts`)
- Real-time status propagation via Redis pub/sub (30s cache TTL is acceptable for v1)
- Per-user notification preferences (workspace-level toggle only in v1)

---

## 3. User Stories

1. As a **workspace admin**, I want to suspend a team member's account so that I can immediately prevent their access when they are terminated or on leave.
2. As a **workspace admin**, I want to bulk-invite team members from a CSV file so that I can onboard a large team without repetitive manual invitations.
3. As a **workspace admin**, I want to see a dashboard summary of member statuses (active, suspended, locked) so that I can monitor workspace health at a glance.
4. As a **locked user**, I want to receive an email notification when my account is locked so that I understand why I cannot access the workspace.
5. As a **workspace owner**, I want to configure invitation expiry duration and default role so that invitations follow our company's security policy.
6. As a **workspace admin**, I want to search and filter the members list by name, email, role, and status so that I can quickly find specific members in a large workspace.
7. As a **workspace admin**, I want to bulk-change roles for multiple members at once so that I can efficiently restructure team permissions.

---

## 4. Functional Requirements

1. **FR-1**: The system must add a `status` field to the TenantMember model with an enum of `active | suspended | locked`, defaulting to `active` for new members.
2. **FR-2**: The system must check `TenantMember.status` in auth middleware for every authenticated request and deny access with HTTP 403 (`MEMBER_SUSPENDED` or `MEMBER_LOCKED`) when status is not `active`.
3. **FR-3**: The system must provide admin APIs for status transitions: suspend, activate, lock, and unlock. Only OWNER and ADMIN roles may perform these operations. Admins must not be able to modify members with equal or higher roles.
4. **FR-4**: The system must prevent the last OWNER of a workspace from being suspended or locked (to avoid orphaning the workspace).
5. **FR-5**: The system must revoke all refresh tokens for a user (via `revokeUserRefreshTokens()` in `auth-repo.ts:245`) when their TenantMember status transitions away from `active`.
6. **FR-6**: The system must return dashboard summary counts (total, active, suspended, locked) in the members list API response.
7. **FR-7**: The system must support bulk invite via JSON array and CSV file upload, with a maximum of 100 invitations per request, using a partial success response pattern.
8. **FR-8**: The system must support bulk role change and bulk remove operations, skipping OWNER members and returning per-item success/failure results.
9. **FR-9**: The system must support server-side search (by name/email), filtering (by role, status), and pagination (`page`, `pageSize`) on the members list API.
10. **FR-10**: The system must send email notifications on member lifecycle events: member added, member removed, role changed, account locked, account unlocked, account suspended, account activated.
11. **FR-11**: The system must provide a workspace-level toggle (`emailNotifications`) that controls only informational notifications. Invitation emails, verification emails, and password reset emails are always sent regardless of the toggle setting.
12. **FR-12**: The system must allow workspace-level configuration of `inviteExpiryDays` (default: 7, range: 1-30) and `defaultRole` (default: `MEMBER`) via a settings API.
13. **FR-13**: The system must automatically set `TenantMember.status` to `locked` when the User-level temporal lock (`loginLockedUntil`) is triggered by failed login attempts, and revert to `active` when the temporal lock expires or an admin manually unlocks.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Suspended/locked members cannot access projects            |
| Agent lifecycle            | NONE         | Agents are project-scoped, not user-scoped                 |
| Customer experience        | SECONDARY    | End-users denied access see appropriate error messages     |
| Integrations / channels    | NONE         | Channel access is session-scoped, not member-status-scoped |
| Observability / tracing    | SECONDARY    | New audit events for lifecycle transitions                 |
| Governance / controls      | PRIMARY      | Core governance: who can access what, admin enforcement    |
| Enterprise / compliance    | PRIMARY      | Account suspension/lockout is compliance-critical          |
| Admin / operator workflows | PRIMARY      | Admin members page is the primary consumption surface      |

### Related Feature Integration Matrix

| Related Feature                                  | Relationship Type | Why It Matters                                                                  | Key Touchpoints                                 | Current State                          |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| [Authentication](sub-features/password-login.md) | depends on        | Lock/unlock modifies auth behavior; status check added to auth middleware       | `auth-repo.ts`, login route, refresh token flow | Temporal lockout exists, no admin lock |
| [Invitations](invitations.md)                    | extends           | Configurable expiry and bulk invite extend the existing invitation system       | `invitation-service.ts`, `INVITE_EXPIRY_DAYS`   | 7-day hardcoded expiry, single invite  |
| [Workspace Management](workspace-management.md)  | depends on        | Member status is workspace-scoped; RBAC role hierarchy enforced for transitions | `TenantMember` model, workspace member routes   | Role assignment exists, no status      |
| [Email Infrastructure](sub-features/email.md)    | depends on        | New email templates for lifecycle events; workspace toggle controls scope       | `email-templates.ts`, `createEmailService()`    | 3 templates exist, no lifecycle events |
| Audit Logging                                    | emits into        | New audit actions for all lifecycle transitions                                 | `audit-service.ts`, `AuditActions`              | `ACCOUNT_LOCKED` exists                |
| SSO                                              | shares data with  | SSO users must also be subject to TenantMember status checks in auth middleware | Auth middleware pipeline                        | SSO bypasses member status today       |

---

## 6. Design Considerations (Optional)

**Admin Members Page enhancements:**

- Summary cards at top: Total Members, Active, Suspended, Locked (with counts and color-coded indicators)
- Search input with debounced server-side search by name or email
- Filter dropdowns for role and status
- Bulk selection via checkboxes with bulk action toolbar (Change Role, Remove, Lock, Suspend)
- Status indicator badges on each member row
- CSV upload dialog for bulk invite with drag-and-drop support

**Status transition confirmation dialogs:**

- Lock/suspend actions require confirmation with explanation of impact
- Bulk operations show summary of affected members before confirmation

---

## 7. Technical Considerations (Optional)

### Status Enum Design (3 states)

- `active`: Normal access. Default state for new members.
- `suspended`: Admin-imposed restriction. Member cannot access the workspace. Used for terminations, leave, disciplinary actions. Only reversible by an OWNER or ADMIN explicitly activating the member.
- `locked`: Auto-locked from failed login attempts. Maps to the existing User-level `loginLockedUntil` temporal lock. When the User model's `loginLockedUntil` is set (after 5 failed attempts, 15-minute duration per `packages/config/src/schemas/auth.schema.ts:57-61`), the TenantMember status is automatically set to `locked`. When the temporal lock expires (checked on next login attempt) or an admin manually unlocks, status reverts to `active`.

**Relationship between User-level lock and TenantMember status:**

- When `loginLockedUntil` is set by `incrementFailedLoginAttempts()` (`auth-repo.ts:110-137`), the system also sets `TenantMember.status = 'locked'` for ALL workspaces where the user is a member (since the lock is User-level, it affects all workspaces).
- When `loginLockedUntil` expires naturally (checked in login route at `auth/login/route.ts:107-116`) and the user successfully logs in, `resetFailedLoginAttempts()` (`auth-repo.ts:154-161`) fires and all TenantMember records with `status: 'locked'` for that user are reverted to `active`.
- An admin can manually unlock a member in their workspace only (sets that single TenantMember back to `active`), which does NOT clear the User-level `loginLockedUntil`. The member can access that specific workspace but may still be locked in others.

### Existing Infrastructure

**User model fields (verified in `packages/database/src/models/user.model.ts`):**

| Field                 | Type           | Location | Notes                                 |
| --------------------- | -------------- | -------- | ------------------------------------- |
| `failedLoginAttempts` | `number`       | Line 50  | Auto-incremented on login failure     |
| `loginLockedUntil`    | `Date \| null` | Line 51  | Set after 5 failures, 15-min duration |
| `lastLoginAt`         | `Date \| null` | Line 48  | Updated on every successful login     |
| `mfa.failedAttempts`  | `number`       | Line 27  | Separate MFA lockout counter          |
| `mfa.lockedUntil`     | `Date \| null` | Line 28  | Separate MFA lockout expiry           |

**Lock/unlock infrastructure (verified in `apps/studio/src/repos/auth-repo.ts`):**

| Function                           | Lines   | Notes                                                     |
| ---------------------------------- | ------- | --------------------------------------------------------- |
| `lockUserAccount(userId, ms)`      | 142-149 | Sets `loginLockedUntil`; exists but no API route calls it |
| `resetFailedLoginAttempts(userId)` | 154-161 | Clears counter and lock; called on successful login       |
| `revokeUserRefreshTokens(userId)`  | 245-254 | Revokes all active refresh tokens for a user              |

**Email infrastructure (verified in `packages/shared/src/services/`):**

- `createEmailService()` at `email-service.ts:100` -- pluggable: AWS SES > Resend > SMTP > Console
- Three templates exist in `email-templates.ts`: `verificationEmail()` (line 49), `passwordResetEmail()` (line 78), `workspaceInvitationEmail()` (line 101)
- Missing templates: member added, member removed, role changed, account locked, account unlocked, account suspended, account activated

**Invitation system (verified in `apps/studio/src/services/invitation-service.ts`):**

- `INVITE_EXPIRY_DAYS = 7` hardcoded at line 26
- `VALID_INVITE_ROLES = ['MEMBER', 'VIEWER', 'OPERATOR']` at line 27; `ADMIN_CAN_INVITE` adds `'ADMIN'` at line 28
- Token: 64 random bytes SHA-256 hashed
- Status: `pending | accepted | expired | revoked`
- TTL index on `expiresAt` auto-deletes expired records

**Admin UI (verified in `apps/studio/src/components/admin/MembersPage.tsx`):**

- Members table with role dropdown (line 186: `handleChangeRole`) and remove button
- Single-email invite form (line 150: `handleInvite`)
- Invitations table with resend/revoke
- Missing: search, filter, status indicators, bulk operations, dashboard summary, pagination

**Auth config (verified in `packages/config/src/schemas/auth.schema.ts`):**

- `maxFailedAttempts`: default 5 (line 57)
- `lockDurationMs`: default 900000 / 15 minutes (line 58-61)

### CSV Bulk Invite Format

- **Format**: CSV with `email,role` headers, UTF-8 encoded, maximum 1MB file size
- **Email validation**: Standard RFC 5322 validation via Zod `z.string().email()`. No DNS verification.
- **Duplicate handling within batch**: Deduplicate by email (case-insensitive). Last occurrence wins for role assignment.
- **Duplicate handling across batches**: If the email already has a pending invitation for this workspace, include it in the `failed` response with reason `INVITATION_ALREADY_PENDING`.
- **Role defaults**: If `role` column is empty or absent, use `Tenant.settings.defaultRole` (default: `MEMBER`).

### Email Notification Toggle Scope

`Tenant.settings.emailNotifications: boolean` (default: `true`) controls ONLY informational notifications:

- Member added to workspace
- Member removed from workspace
- Role changed
- Account locked / unlocked / suspended / activated

The following are ALWAYS sent regardless of the toggle (transactional/security-critical):

- Invitation emails (contain accept link required for onboarding)
- Email verification emails
- Password reset emails

### Settings Storage

Settings are stored in `Tenant.settings` typed field (`ITenantSettings | null`, verified at `packages/database/src/models/tenant.model.ts:54`). The `ITenantSettings` interface (lines 32-43) defines specific fields plus an index signature `[key: string]: unknown` allowing extensibility. New settings fields (`defaultRole`, `inviteExpiryDays`, `emailNotifications`) should be added to the `ITenantSettings` interface.

---

## 8. How to Consume

### Studio UI

- **Members Page** (`/admin/members`): Enhanced with status badges, summary cards, search/filter, bulk operations toolbar, and CSV upload dialog. Accessible to OWNER and ADMIN roles.
- **Workspace Settings Page** (`/admin/settings`): New section for member management settings: default role dropdown, invitation expiry slider (1-30 days), email notifications toggle.
- **Member Actions**: Click member row for status transition actions (Lock, Suspend, Activate, Unlock) based on current status and role permissions.

### API (Runtime)

Not applicable. Member lifecycle management is a Studio-side admin concern. Runtime receives tenant context from JWT and does not directly query TenantMember status (relies on auth middleware check at the Studio/gateway layer).

### API (Studio)

| Method   | Path                                                 | Purpose                                                      |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/api/workspaces/:tenantId/members`                  | List members with search, filter, pagination, summary counts |
| `POST`   | `/api/workspaces/:tenantId/members/:userId/suspend`  | Admin suspends a member                                      |
| `POST`   | `/api/workspaces/:tenantId/members/:userId/activate` | Admin activates a suspended/locked member                    |
| `POST`   | `/api/workspaces/:tenantId/members/:userId/lock`     | Admin locks a member                                         |
| `POST`   | `/api/workspaces/:tenantId/members/:userId/unlock`   | Admin unlocks a member                                       |
| `POST`   | `/api/workspaces/:tenantId/members/bulk-invite`      | Bulk invite (JSON or CSV)                                    |
| `PATCH`  | `/api/workspaces/:tenantId/members/bulk`             | Bulk role change                                             |
| `DELETE` | `/api/workspaces/:tenantId/members/bulk`             | Bulk remove                                                  |
| `PATCH`  | `/api/workspaces/:tenantId/settings`                 | Update workspace settings                                    |
| `GET`    | `/api/workspaces/:tenantId/settings`                 | Get workspace settings                                       |

**Query parameters for `GET /members`:**

| Param      | Type   | Description                            |
| ---------- | ------ | -------------------------------------- |
| `search`   | string | Partial match on name or email         |
| `role`     | string | Filter by role (e.g., `ADMIN`)         |
| `status`   | string | Filter by status (e.g., `suspended`)   |
| `page`     | number | Page number (default: 1)               |
| `pageSize` | number | Items per page (default: 20, max: 100) |

**Response shape for `GET /members`:**

```json
{
  "members": [...],
  "summary": {
    "total": 45,
    "active": 40,
    "suspended": 3,
    "locked": 2
  },
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

### Admin Portal

Not applicable in v1. Admin portal does not manage workspace-level member status.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. Member lifecycle management is an admin-only concern. Channel and SDK interactions are session-scoped and do not directly interact with TenantMember status.

---

## 9. Data Model

### Collections / Tables

```text
Collection: tenant_members (modification)
New Fields:
  - status: string (enum: 'active' | 'suspended' | 'locked', default: 'active', required)
  - lastActiveAt: Date | null (updated on authenticated request, default: null)
New Indexes:
  - { tenantId: 1, status: 1 }  -- for dashboard summary aggregation
  - { userId: 1, status: 1 }    -- for cross-workspace status updates on login lock
Existing Indexes (unchanged):
  - { tenantId: 1, userId: 1 } (unique)
  - { userId: 1 }
  - { customRoleId: 1 }
```

```text
Collection: tenants (modification to ITenantSettings interface)
New Settings Fields (added to ITenantSettings):
  - settings.defaultRole: string (default: 'MEMBER', one of: 'MEMBER' | 'VIEWER' | 'OPERATOR')
  - settings.inviteExpiryDays: number (default: 7, min: 1, max: 30)
  - settings.emailNotifications: boolean (default: true)
```

### Key Relationships

- `TenantMember.status` is workspace-scoped: a user locked in workspace A is NOT affected in workspace B. Each TenantMember record has its own independent status.
- `User.loginLockedUntil` is user-scoped: when triggered by failed login attempts, it sets `TenantMember.status = 'locked'` across ALL workspaces for that user.
- `RefreshToken.userId` is used by `revokeUserRefreshTokens()` to invalidate sessions on status change.
- `Tenant.settings` stores workspace-level configuration consumed by invitation service and email notification logic.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                  | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/database/src/models/tenant-member.model.ts` | Add `status` field and new indexes to TenantMember schema              |
| `packages/database/src/models/tenant.model.ts`        | Add new fields to `ITenantSettings` interface                          |
| `packages/shared/src/services/email-templates.ts`     | Add lifecycle notification email templates                             |
| `packages/config/src/schemas/auth.schema.ts`          | Auth lockout config (read-only: `maxFailedAttempts`, `lockDurationMs`) |

### Routes / Handlers

| File                                                                                    | Purpose                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/studio/src/repos/auth-repo.ts`                                                    | `lockUserAccount()` (line 142), `revokeUserRefreshTokens()` (line 245) |
| `apps/studio/src/services/invitation-service.ts`                                        | Extend for configurable expiry and bulk invite                         |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/suspend/route.ts`  | Suspend member endpoint                                                |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/activate/route.ts` | Activate member endpoint                                               |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/lock/route.ts`     | Lock member endpoint                                                   |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/unlock/route.ts`   | Unlock member endpoint                                                 |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/bulk-invite/route.ts`       | Bulk invite endpoint                                                   |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/members/bulk/route.ts`              | Bulk role change and remove                                            |
| New: `apps/studio/src/app/api/workspaces/[tenantId]/settings/route.ts`                  | Workspace settings CRUD                                                |

### UI Components

| File                                                           | Purpose                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/studio/src/components/admin/MembersPage.tsx`             | Enhance with status badges, summary cards, search, filter, bulk ops |
| New: `apps/studio/src/components/admin/MemberSummaryCards.tsx` | Dashboard summary cards component                                   |
| New: `apps/studio/src/components/admin/BulkInviteDialog.tsx`   | CSV upload and bulk invite dialog                                   |
| New: `apps/studio/src/components/admin/MemberStatusBadge.tsx`  | Status indicator badge component                                    |

### Jobs / Workers / Background Processes

| File | Purpose                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| N/A  | No background jobs in v1. Email sending is fire-and-forget in the request handler. |

### Tests

| File                                                             | Type        | Coverage Focus                   |
| ---------------------------------------------------------------- | ----------- | -------------------------------- |
| New: `apps/studio/src/__tests__/member-lifecycle-status.test.ts` | integration | Status transition API endpoints  |
| New: `apps/studio/src/__tests__/member-lifecycle-bulk.test.ts`   | integration | Bulk invite, role change, remove |
| New: `apps/studio/src/__tests__/member-lifecycle-e2e.test.ts`    | e2e         | Full lifecycle through HTTP API  |

---

## 11. Configuration

### Environment Variables

| Variable                    | Default    | Description                                            |
| --------------------------- | ---------- | ------------------------------------------------------ |
| `AUTH_LOCKOUT_MAX_ATTEMPTS` | `5`        | Failed-login threshold before timed lockout (existing) |
| `AUTH_LOCKOUT_DURATION_MS`  | `900000`   | Lockout duration in milliseconds / 15 min (existing)   |
| `REDIS_URL`                 | (required) | Redis connection for member status cache               |

No new environment variables are introduced. All new settings are workspace-level (stored in `Tenant.settings`).

### Runtime Configuration

- `Tenant.settings.defaultRole`: Workspace-level default role for new members via invitation (default: `MEMBER`)
- `Tenant.settings.inviteExpiryDays`: Workspace-level invitation expiry in days (default: 7, range: 1-30)
- `Tenant.settings.emailNotifications`: Workspace-level toggle for informational lifecycle emails (default: `true`)

### DSL / Agent IR / Schema

Not applicable. Member lifecycle management does not affect agent configuration, compiler IR, or DSL schemas.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern                            | Requirement / Expectation                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation                   | Every query in member lifecycle routes must include `tenantId`. Cross-tenant access returns 404.                                                                                                             |
| Cross-workspace independence       | Suspending/locking a TenantMember in workspace A must NOT affect the same user's TenantMember in workspace B. Each TenantMember record has independent status.                                               |
| Bulk operation tenant verification | Every `userId` in a bulk operation (bulk role change, bulk remove) must be verified as a member of the target `tenantId` before mutation. Non-members are silently skipped and reported in the failure list. |
| User isolation                     | Members can only view/manage members within their own workspace. Cross-workspace member enumeration returns 404.                                                                                             |
| Last OWNER protection              | The last OWNER of a workspace cannot be suspended, locked, or removed. The system must count active OWNERs before allowing any OWNER status transition.                                                      |

### Security & Compliance

- **Session invalidation on status change**: When `TenantMember.status` transitions away from `active`, the system must call `revokeUserRefreshTokens(userId)` (verified at `auth-repo.ts:245-254`) to invalidate all active refresh tokens. JWTs are short-lived (15 minutes per auth config) and expire naturally -- no JWT revocation list is needed.
- **Auth middleware status check**: Auth middleware checks `TenantMember.status` on every authenticated request. Non-active status returns HTTP 403 with code `MEMBER_SUSPENDED` or `MEMBER_LOCKED`.
- **Role hierarchy enforcement**: Only OWNER and ADMIN roles can perform status transitions. An admin cannot modify a member with equal or higher role. Self-modification is forbidden (cannot lock/suspend yourself).
- **Audit logging**: All lifecycle transitions emit audit events with `tenantId`, `userId`, `performedBy`, `action`, and `previousStatus`. Actions: `MEMBER_SUSPENDED`, `MEMBER_ACTIVATED`, `MEMBER_LOCKED`, `MEMBER_UNLOCKED`, `MEMBER_BULK_INVITED`, `MEMBER_BULK_ROLE_CHANGED`, `MEMBER_BULK_REMOVED`.
- **CSV upload security**: CSV files are validated for size (max 1MB), encoding (UTF-8), and content (email format validation per row). No server-side file storage -- parsed in memory and discarded.

### Performance & Scalability

- **Auth middleware status cache**: `TenantMember.status` is cached in Redis with key pattern `member-status:{tenantId}:{userId}` and a 30-second TTL. This avoids a MongoDB query on every authenticated request. Status change operations (suspend, activate, lock, unlock) must invalidate the corresponding cache entry immediately.
- **Dashboard summary**: Uses MongoDB `$group` aggregation on `{ tenantId, status }`. The new compound index `{ tenantId: 1, status: 1 }` ensures this is a covered index scan.
- **Bulk operations**: Maximum 100 items per bulk request. Bulk invite processes invitations sequentially to avoid email provider rate limits. Bulk role change and remove use `bulkWrite()` for atomicity.
- **Search**: Text search on `name` and `email` uses a regex match (case-insensitive). For workspaces with 100+ members, the existing `{ tenantId: 1, userId: 1 }` index is sufficient. A text index may be added in a future phase if search performance degrades.

### Reliability & Failure Modes

- **Email delivery failures**: Email notifications are fire-and-forget. Failures are logged but do not block the primary operation (status change, role change, etc.). No retry mechanism in v1.
- **Partial success pattern**: Bulk operations return `{ succeeded: [...], failed: [{ email/userId, reason }] }`. The caller can inspect failures and retry individually.
- **Cache invalidation race**: If Redis cache invalidation fails after a status change, the stale cache entry expires within 30 seconds. This is an acceptable delay for security (refresh tokens are already revoked, so the user cannot obtain new access tokens).
- **Concurrent status transitions**: Status change operations use `findOneAndUpdate()` with the current status as a filter condition to prevent conflicting concurrent transitions.

### Observability

- **Audit events**: All lifecycle transitions are logged via the existing `logAuditEvent()` in `audit-service.ts`. New actions added to the `AuditActions` enum.
- **Logging**: All status transitions log at INFO level with `tenantId`, `userId`, `performedBy`, `fromStatus`, `toStatus`.
- **Error logging**: Failed bulk operations log individual failures at WARN level.
- **Metrics (future)**: Status distribution per workspace can be derived from audit event aggregation. No custom metrics in v1.

### Data Lifecycle

- **Status field**: Persisted indefinitely as part of the TenantMember document. No TTL.
- **`lastActiveAt`**: Updated on authenticated requests (throttled to once per minute to avoid write amplification). No TTL.
- **Audit events**: Subject to existing audit log retention policy (`Tenant.retentionDays`, default 7 days).
- **Cache entries**: Redis `member-status:{tenantId}:{userId}` keys have a 30-second TTL and are auto-evicted.
- **Cascade on member removal**: When a TenantMember is hard-deleted (via remove or bulk-remove), the cache entry is invalidated and refresh tokens are revoked. The User record is not affected (user may be a member of other workspaces).

---

## 13. Delivery Plan / Work Breakdown

1. **Schema and model changes**
   1.1 Add `status` field (enum: `active | suspended | locked`, default: `active`) and `lastActiveAt` field to TenantMember model
   1.2 Add new indexes: `{ tenantId: 1, status: 1 }` and `{ userId: 1, status: 1 }`
   1.3 Add `defaultRole`, `inviteExpiryDays`, `emailNotifications` to `ITenantSettings` interface
   1.4 Write migration script to set `status: 'active'` on all existing TenantMember records

2. **Auth middleware status check**
   2.1 Add Redis cache layer for member status (`member-status:{tenantId}:{userId}`, 30s TTL)
   2.2 Add status check to Studio auth middleware (deny with 403 if not active)
   2.3 Add cache invalidation helper called by all status transition operations

3. **Status transition APIs**
   3.1 Implement suspend/activate/lock/unlock endpoints with role hierarchy checks
   3.2 Implement last-OWNER protection guard
   3.3 Add refresh token revocation on status transition away from active
   3.4 Add audit event logging for all transitions
   3.5 Wire TenantMember status update into `incrementFailedLoginAttempts()` flow (auto-lock)
   3.6 Wire TenantMember status revert into `resetFailedLoginAttempts()` flow (auto-unlock on login)

4. **Dashboard summary API and UI**
   4.1 Add `$group` aggregation to members list endpoint for summary counts
   4.2 Build `MemberSummaryCards` component
   4.3 Add status badges to member rows in `MembersPage`

5. **Search, filter, and pagination**
   5.1 Add query parameter parsing and MongoDB filter construction
   5.2 Add pagination logic with total count
   5.3 Add search/filter UI controls to `MembersPage`

6. **Bulk operations**
   6.1 Implement bulk invite endpoint (JSON array support)
   6.2 Add CSV parsing with validation (format, size, dedup, email validation)
   6.3 Implement bulk role change endpoint
   6.4 Implement bulk remove endpoint
   6.5 Build `BulkInviteDialog` component with CSV upload
   6.6 Add bulk selection and bulk action toolbar to `MembersPage`

7. **Email notifications**
   7.1 Create new email templates: `memberAddedEmail()`, `memberRemovedEmail()`, `roleChangedEmail()`, `accountLockedEmail()`, `accountUnlockedEmail()`, `accountSuspendedEmail()`, `accountActivatedEmail()`
   7.2 Add fire-and-forget email sending to status transition and member management handlers
   7.3 Respect `Tenant.settings.emailNotifications` toggle (skip informational emails when false)

8. **Configurable workspace settings**
   8.1 Implement settings GET/PATCH endpoints with Zod validation
   8.2 Update `invitation-service.ts` to read `inviteExpiryDays` from tenant settings (fallback to 7)
   8.3 Update invitation creation to use `defaultRole` from tenant settings when role not specified
   8.4 Build settings UI section in workspace admin page

---

## 14. Success Metrics

| Metric                                  | Baseline       | Target       | How Measured                                          |
| --------------------------------------- | -------------- | ------------ | ----------------------------------------------------- |
| Time to restrict member access          | Manual removal | < 30 seconds | Status change + cache TTL expiry                      |
| Bulk invite completion (100 users)      | N/A (manual)   | < 10 seconds | API response time measurement                         |
| Dashboard summary load time             | N/A            | < 200ms      | API response time for aggregation query               |
| Auth middleware latency impact          | 0ms (no check) | < 5ms        | Redis cache hit latency                               |
| Admin support tickets for member access | Baseline TBD   | -50%         | Support ticket tracking tagged with member-management |
| Email notification delivery rate        | N/A            | > 95%        | Email service success/failure logging                 |

---

## 15. Open Questions

1. Should `TenantMember.status` changes be propagated to Runtime in real-time (via Redis pub/sub) or is the 30s cache TTL acceptable for denying access to suspended/locked members?
2. Should bulk remove operations hard-delete TenantMember records or soft-delete by setting a terminal status? Hard-delete is simpler but loses audit trail; soft-delete requires a `removed` status.
3. Should email notifications be queued via BullMQ for reliability and rate limiting, or is synchronous fire-and-forget acceptable for v1?
4. For SSO users, should admin suspend/lock override SSO access? Currently the auth middleware pipeline would need to check TenantMember status after SSO token validation.
5. Should the `lastActiveAt` field update be throttled (e.g., once per minute) to avoid write amplification on high-frequency API consumers?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                          | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No real-time status propagation -- locked/suspended users retain access for up to 30s (cache TTL)    | Medium   | Open   |
| GAP-002 | Email notifications are fire-and-forget with no retry -- delivery is not guaranteed                  | Medium   | Open   |
| GAP-003 | No per-user notification preferences -- only workspace-level toggle                                  | Low      | Open   |
| GAP-004 | `lockUserAccount()` in `auth-repo.ts:142-149` exists but has no API route calling it -- must wire up | High     | Open   |
| GAP-005 | No text index for member search -- regex search may degrade for workspaces with 1000+ members        | Low      | Open   |
| GAP-006 | SSO integration with member status check is not yet designed                                         | High     | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                        | Coverage Type | Status     | Test File / Note                |
| --- | --------------------------------------------------------------- | ------------- | ---------- | ------------------------------- |
| 1   | Admin suspends member; member's next API call returns 403       | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 2   | Admin activates suspended member; member can access again       | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 3   | Dashboard summary returns correct counts by status              | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 4   | Bulk invite 5 emails; 2 invalid; partial success response       | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 5   | Bulk role change skips OWNER; updates others                    | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 6   | Filter members by status=suspended returns only suspended       | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 7   | Role change triggers email via ConsoleEmailService log capture  | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 8   | Configurable invite expiry: set 14 days, verify invitation      | e2e           | NOT TESTED | member-lifecycle-e2e.test.ts    |
| 9   | Last OWNER cannot be suspended (returns 400)                    | integration   | NOT TESTED | member-lifecycle-status.test.ts |
| 10  | Refresh tokens revoked when member is suspended                 | integration   | NOT TESTED | member-lifecycle-status.test.ts |
| 11  | Redis cache invalidated on status change                        | integration   | NOT TESTED | member-lifecycle-status.test.ts |
| 12  | Cross-workspace isolation: suspend in A does not affect B       | integration   | NOT TESTED | member-lifecycle-status.test.ts |
| 13  | CSV bulk invite: valid format, dedup, size limit                | integration   | NOT TESTED | member-lifecycle-bulk.test.ts   |
| 14  | Email toggle off suppresses informational but not transactional | integration   | NOT TESTED | member-lifecycle-bulk.test.ts   |
| 15  | Self-suspend prevention: admin cannot suspend themselves        | integration   | NOT TESTED | member-lifecycle-status.test.ts |

### Testing Notes

E2E tests must exercise the real system through its HTTP API -- no mocks, no direct DB access. Start Express on random ports with full middleware chain (auth, rate limiting, tenant isolation, validation). Use `ConsoleEmailService` stdout capture for email verification in E2E tests (not mock verification). Integration tests should test real service boundaries with Redis and MongoDB.

> Full testing details: `../testing/user-lifecycle-management.md`

---

## 18. References

- Design docs: (pending HLD at `docs/specs/user-lifecycle-management.hld.md`)
- Related feature docs: [Workspace Management](workspace-management.md), [Invitations](invitations.md), [Password Login](sub-features/password-login.md)
- Source references: `packages/database/src/models/tenant-member.model.ts`, `packages/database/src/models/tenant.model.ts`, `apps/studio/src/repos/auth-repo.ts`, `packages/shared/src/services/email-templates.ts`, `apps/studio/src/services/invitation-service.ts`
- v1.0 parity reference: https://docs.kore.ai/agent-platform/administration/user-management
- Audit findings: `docs/sdlc-logs/user-lifecycle-management/feature-spec-audit.md`
