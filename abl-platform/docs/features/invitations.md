# Feature: Workspace Invitations

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `enterprise`, `admin operations`, `project lifecycle`
**Package(s)**: `apps/studio`, `packages/database`, `packages/shared`, `packages/i18n`
**Owner(s)**: `studio-team`
**Testing Guide**: `../testing/invitations.md`
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

Multi-tenant platforms require a controlled mechanism for workspace administrators to bring new users into their workspace. Without invitations, every user must create their own workspace during onboarding, and there is no way for admins to grant access to an existing workspace. This creates friction for teams that need to collaborate within a shared workspace and prevents organizations from managing who has access to their agent development environments.

### Goal Statement

Provide a secure, role-aware invitation system that allows workspace owners and admins to invite users by email, with support for automatic acceptance during SSO flows, email-link-based acceptance for direct invitees, and a multi-invitation picker for users with multiple pending invitations.

### Summary

Workspace Invitations enable OWNER and ADMIN role members to send email invitations to new or existing users, granting them a specific role (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER) upon acceptance. The system supports two acceptance flows: (1) token-based acceptance via an email link (`/invite/:token`), and (2) ID-based acceptance via an invitation picker page (`/invitations/choose`) for users with pending invitations discovered by email. SSO callbacks (Google, Microsoft, LinkedIn, SAML, OIDC) and email verification all integrate with a shared `resolveUserContextOrAutoAcceptInvite()` helper that auto-accepts a single pending invitation or redirects to the picker when multiple exist. Invitations expire after 7 days via a MongoDB TTL index and emit audit events at every lifecycle stage (sent, accepted, revoked).

---

## 2. Scope

### Goals

- Allow OWNER and ADMIN workspace members to invite users by email with a specific role
- Enforce role hierarchy to prevent privilege escalation (ADMINs cannot invite OWNERs)
- Support token-based acceptance via email link and ID-based acceptance via invitation picker
- Auto-accept single pending invitations during SSO/email-verification flows
- Present a picker page when a user has multiple pending invitations
- Send branded invitation emails with inviter name, workspace name, role, and accept link
- Revoke pending invitations (admin action)
- TTL-based automatic expiration of invitations after 7 days
- Audit log every invitation lifecycle event (sent, accepted, revoked)
- Issue workspace-scoped JWT tokens upon invitation acceptance

### Non-Goals (Out of Scope)

- Bulk invitation import (CSV/spreadsheet upload)
- Invitation approval workflows (two-step approval by a second admin)
- Custom invitation expiry duration per tenant or per invitation
- Invitation rate limiting per workspace (beyond general API rate limiting)
- Resend invitation functionality (admin must revoke and re-create)
- Project-level invitations (invitations are workspace/tenant-scoped only)
- External identity provider group-to-workspace mapping

---

## 3. User Stories

1. As a **workspace owner**, I want to invite a colleague by email so that they can join my workspace with a specific role.
2. As a **workspace admin**, I want to invite users as MEMBER, VIEWER, or OPERATOR roles so that I can onboard team members without granting owner-level access.
3. As an **invited user**, I want to click an email link and accept the invitation so that I can immediately access the workspace.
4. As an **invited user who signs up via SSO**, I want my pending invitation to be auto-accepted so that I skip the workspace creation flow.
5. As an **invited user with multiple pending invitations**, I want to see a picker page listing all invitations so that I can choose which workspace to join.
6. As a **workspace admin**, I want to view all pending invitations for my workspace so that I can track who has been invited.
7. As a **workspace admin**, I want to revoke a pending invitation so that I can withdraw access before it is accepted.

---

## 4. Functional Requirements

1. **FR-1**: The system must allow OWNER and ADMIN role members to create an invitation by providing an email and an optional role (defaulting to MEMBER).
2. **FR-2**: The system must enforce role hierarchy during invitation creation: OWNERs can invite any role; ADMINs can invite ADMIN, OPERATOR, MEMBER, VIEWER but not OWNER.
3. **FR-3**: The system must reject invitation creation if the target email already belongs to an active workspace member.
4. **FR-4**: The system must reject invitation creation if a pending, non-expired invitation already exists for the same tenant+email combination.
5. **FR-5**: The system must generate a cryptographically random 64-byte token, store its SHA-256 hash, and send the raw token in the invitation email link.
6. **FR-6**: The system must send a branded HTML email containing the inviter name, workspace name, assigned role, and a clickable accept URL.
7. **FR-7**: The system must allow an authenticated user to accept an invitation via the raw token, verifying: (a) token maps to a pending invitation, (b) invitation is not expired, (c) accepting user's email matches the invitation email.
8. **FR-8**: The system must allow an authenticated user to accept an invitation by its database ID (used by the invitation picker flow), with the same validation rules as FR-7 minus the token lookup.
9. **FR-9**: Upon successful acceptance, the system must create a TenantMember record and issue a new JWT token pair scoped to the accepted workspace.
10. **FR-10**: The system must auto-accept a single pending invitation during SSO/email-verification flows via `resolveUserContextOrAutoAcceptInvite()`.
11. **FR-11**: When a user has 2+ pending invitations during SSO/email-verification, the system must redirect to the invitation picker page (`/invitations/choose`).
12. **FR-12**: The system must allow OWNER and ADMIN role members to revoke (delete) a pending invitation.
13. **FR-13**: The system must automatically expire invitations after 7 days using a MongoDB TTL index on the `expiresAt` field.
14. **FR-14**: The system must emit audit events for invitation_sent, invitation_accepted, and invitation_revoked actions.
15. **FR-15**: The system must expose a public (unauthenticated) endpoint to retrieve invitation details by raw token, enabling the invite landing page to display workspace/inviter info before the user signs in.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                               |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Invitations grant workspace access; projects live within workspaces |
| Agent lifecycle            | NONE         | No direct agent impact                                              |
| Customer experience        | SECONDARY    | Streamlines team onboarding                                         |
| Integrations / channels    | NONE         | Not channel-aware                                                   |
| Observability / tracing    | SECONDARY    | Audit events emitted                                                |
| Governance / controls      | PRIMARY      | Role-based access control, privilege escalation prevention          |
| Enterprise / compliance    | PRIMARY      | Tenant isolation, audit logging, SSO integration                    |
| Admin / operator workflows | PRIMARY      | Core admin workflow for member management                           |

### Related Feature Integration Matrix

| Related Feature                                 | Relationship Type | Why It Matters                                              | Key Touchpoints                                             | Current State |
| ----------------------------------------------- | ----------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| [SSO / Enterprise Auth](sso-enterprise-auth.md) | depends on        | SSO callbacks trigger auto-accept or picker redirect        | `resolveUserContextOrAutoAcceptInvite()` in auth-service.ts | Implemented   |
| [Audit Logging](audit-logging.md)               | emits into        | Every invitation lifecycle event is audit-logged            | `logAuditEvent()` with INVITATION_SENT/ACCEPTED/REVOKED     | Implemented   |
| [Workspace Sharing](workspace-sharing.md)       | extends           | Invitations are the primary mechanism for workspace sharing | TenantMember creation upon acceptance                       | Implemented   |
| [Billing & Usage](billing.md)                   | shares data with  | Member count affects billing seat calculations              | TenantMember count post-acceptance                          | Planned       |

---

## 6. Design Considerations

- **Invite Landing Page** (`/invite/:token`): Fetches invitation details via public endpoint, shows workspace name, inviter, and role. If user is authenticated, shows "Accept" button. If not, shows "Sign up to accept" and "Sign in to accept" links that preserve the invitation token in the URL.
- **Invitation Picker Page** (`/invitations/choose`): Lists all pending invitations for the authenticated user's email. Each card shows workspace name, role, inviter, and expiration. User can accept one or create their own workspace.
- **MembersPage Component** (`MembersPage.tsx`): Admin-facing page with SWR-based data fetching showing current members and pending invitations, with an inline invite form.
- **i18n**: All user-facing strings in `packages/i18n/locales/en/studio.json` under `auth.invite` and `admin.members` namespaces.

---

## 7. Technical Considerations

- **Token Security**: Raw tokens are 64 random bytes (hex-encoded = 128 chars). Only the SHA-256 hash is stored in MongoDB. The raw token is sent once in the email and used for lookup via `hashToken()` in `lib/token-hash.ts`.
- **Duplicate Prevention**: A unique compound index on `{ tenantId, email }` prevents duplicate invitations. Expired/revoked/accepted invitations are deleted before creating a new one.
- **Atomicity Gap**: The `acceptInvitation()` function creates a TenantMember and updates the invitation status in two separate operations without a transaction. A failure between them could leave partial state. This is documented in the code with a comment acknowledging the gap.
- **SSO Integration**: All 6 auth callback routes (Google, Microsoft, LinkedIn, SAML, OIDC, email verification) call `resolveUserContextOrAutoAcceptInvite()` from `auth-service.ts` to handle invitation auto-acceptance.
- **Console.log Usage**: Several route handlers use `console.error` instead of `createLogger`. This should be fixed (see GAP-002).

---

## 8. How to Consume

### Studio UI

| Route                 | Purpose                                  | Auth Required |
| --------------------- | ---------------------------------------- | ------------- |
| `/invite/:token`      | Invitation landing page (accept/sign-up) | No (public)   |
| `/invitations/choose` | Multi-invitation picker page             | Yes           |
| Admin > Members page  | Member management with invite form       | Yes (ADMIN+)  |

### API (Runtime)

N/A — Invitations are a Studio-only feature.

### API (Studio)

| Method | Path                                                  | Purpose                                   |
| ------ | ----------------------------------------------------- | ----------------------------------------- |
| GET    | `/api/workspaces/:tenantId/invitations`               | List invitations for a workspace          |
| POST   | `/api/workspaces/:tenantId/invitations`               | Create a new invitation                   |
| DELETE | `/api/workspaces/:tenantId/invitations/:invitationId` | Revoke an invitation                      |
| GET    | `/api/invitations/:token`                             | Get invitation details by token (public)  |
| POST   | `/api/invitations/accept`                             | Accept invitation by raw token            |
| POST   | `/api/invitations/accept-by-id`                       | Accept invitation by database ID          |
| GET    | `/api/invitations/pending`                            | List pending invitations for current user |

### Admin Portal

Workspace member management is exposed in the Studio MembersPage component. No separate admin portal routes exist for invitations.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — Invitations are not channel-aware. This is a workspace administration feature only.

---

## 9. Data Model

### Collections / Tables

```text
Collection: workspace_invitations
Fields:
  - _id: string (UUIDv7, auto-generated)
  - tenantId: string (required, indexed)
  - email: string (required, indexed)
  - role: string (required, enum: pending/accepted/expired/revoked — NOTE: this is the assigned role like MEMBER/ADMIN)
  - invitedBy: string | null (userId of inviter)
  - token: string (required, SHA-256 hash of raw token)
  - status: string (required, enum: pending/accepted/expired/revoked)
  - expiresAt: Date (required, TTL indexed)
  - acceptedAt: Date | null
  - acceptedBy: string | null (userId of acceptor)
  - _v: number (version, default 1)
  - createdAt: Date (auto via timestamps)
  - updatedAt: Date (auto via timestamps)
Indexes:
  - { token: 1 } (unique) — fast lookup by hashed token
  - { tenantId: 1, email: 1 } (unique) — prevent duplicate invitations
  - { email: 1 } — find pending invitations for a user across tenants
  - { expiresAt: 1 } (TTL, expireAfterSeconds: 0) — automatic document removal
```

### Key Relationships

- `tenantId` references `tenants._id` — the workspace the invitation is for
- `invitedBy` references `users._id` — the admin who sent the invitation
- `acceptedBy` references `users._id` — the user who accepted the invitation
- Upon acceptance, a new `tenant_members` document is created linking the user to the workspace

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                              | Purpose                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/studio/src/services/invitation-service.ts`  | Invitation lifecycle: create, accept, acceptById, revoke, list, getByToken |
| `apps/studio/src/services/auth-service.ts`        | `resolveUserContextOrAutoAcceptInvite()` SSO integration                   |
| `packages/shared/src/services/email-templates.ts` | `workspaceInvitationEmail()` HTML template generation                      |
| `packages/i18n/src/emails.ts`                     | Email i18n message catalog (INVITE_SUBJECT, INVITE_BODY, etc.)             |

### Routes / Handlers

| File                                                                                | Purpose                          |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts`                | GET (list) + POST (create)       |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` | DELETE (revoke)                  |
| `apps/studio/src/app/api/invitations/[token]/route.ts`                              | GET invitation by token (public) |
| `apps/studio/src/app/api/invitations/accept/route.ts`                               | POST accept by token             |
| `apps/studio/src/app/api/invitations/accept-by-id/route.ts`                         | POST accept by ID                |
| `apps/studio/src/app/api/invitations/pending/route.ts`                              | GET pending invitations for user |

### UI Components

| File                                               | Purpose                                      |
| -------------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/app/invite/[token]/page.tsx`      | Invitation landing page (accept/signup flow) |
| `apps/studio/src/app/invitations/choose/page.tsx`  | Multi-invitation picker page                 |
| `apps/studio/src/components/admin/MembersPage.tsx` | Admin members + invitations management       |

### Jobs / Workers / Background Processes

| File | Purpose                                                          |
| ---- | ---------------------------------------------------------------- |
| N/A  | Expiration handled by MongoDB TTL index, not a background worker |

### Tests

| File                                                    | Type        | Coverage Focus                      |
| ------------------------------------------------------- | ----------- | ----------------------------------- |
| `apps/studio/src/__tests__/api-org-routes.test.ts`      | unit (mock) | Route handler logic for invitations |
| `packages/shared/src/__tests__/email-templates.test.ts` | unit        | Email template generation           |
| `packages/database/src/__tests__/model-misc.test.ts`    | unit        | Model schema validation             |

### Data Model

| File                                                         | Purpose                         |
| ------------------------------------------------------------ | ------------------------------- |
| `packages/database/src/models/workspace-invitation.model.ts` | Mongoose schema and model       |
| `apps/studio/src/repos/workspace-repo.ts`                    | Repository layer (CRUD + joins) |

---

## 11. Configuration

### Environment Variables

| Variable       | Default    | Description                                    |
| -------------- | ---------- | ---------------------------------------------- |
| `FRONTEND_URL` | (required) | Base URL for invitation accept links in emails |
| `SMTP_HOST`    | (required) | SMTP server for sending invitation emails      |
| `SMTP_PORT`    | `587`      | SMTP port                                      |
| `SMTP_USER`    | (required) | SMTP authentication username                   |
| `SMTP_PASS`    | (required) | SMTP authentication password                   |
| `SMTP_FROM`    | (required) | From address for invitation emails             |

### Runtime Configuration

- Invitation expiry is hardcoded at 7 days (`INVITE_EXPIRY_DAYS = 7` in `invitation-service.ts`)
- Valid roles for non-OWNER inviters: `['MEMBER', 'VIEWER', 'OPERATOR', 'ADMIN']` (hardcoded)
- No feature flags or per-tenant configuration exists for invitations

### DSL / Agent IR / Schema

N/A — Invitations are not part of the agent DSL or IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | All invitation queries include `tenantId`. Cross-tenant access to invitations returns 404. Unique index on `{ tenantId, email }` enforces per-tenant uniqueness. Delete and update operations use `findOneAndDelete/Update({ _id, tenantId })`. |
| Project isolation | N/A — Invitations are workspace-scoped, not project-scoped.                                                                                                                                                                                     |
| User isolation    | Token-based acceptance verifies `invitation.email === acceptingUser.email`. ID-based acceptance does the same check. Pending invitations endpoint filters by the authenticated user's email only.                                               |

### Security & Compliance

- **Token handling**: Raw tokens are never stored. Only SHA-256 hashes are persisted. Raw token transmitted once via email.
- **Privilege escalation prevention**: Role hierarchy enforced at creation time (ADMINs cannot create OWNER invitations).
- **Auth requirements**: All mutation endpoints require authentication via `requireAuth()`. Only the GET-by-token endpoint is public.
- **Audit trail**: All lifecycle events emit audit events with userId, tenantId, IP, and user-agent.
- **Cross-tenant check**: DELETE handler explicitly checks `authResult.tenantId !== params.tenantId` and returns 404.
- **Gap**: The `findInvitationById()` repo function accepts an optional `tenantId` parameter. When called without it (as in `acceptInvitationById` via `invitation-service.ts`), tenant scoping is not enforced at the query level. See GAP-001.

### Performance & Scalability

- **Indexes**: Four indexes cover all query patterns (token lookup, tenant+email uniqueness, email-only lookup, TTL).
- **TTL expiration**: MongoDB handles expired document cleanup automatically.
- **No pagination**: `findInvitations()` returns all invitations for a tenant without pagination. Acceptable for current scale but may need cursor-based pagination at >1000 invitations per tenant.

### Reliability & Failure Modes

- **Email delivery failure**: If SMTP fails, the invitation record is still created in the database. The user will not receive the email, but the invitation exists. No retry mechanism.
- **Atomicity gap**: `acceptInvitation()` creates TenantMember and updates invitation status in two separate operations. A crash between them could leave an accepted invitation without a member record (or vice versa). See GAP-003.
- **Idempotency**: Accepting an already-accepted invitation returns an error. Re-inviting after revocation works (old record deleted, new one created).

### Observability

- **Audit events**: `INVITATION_SENT`, `INVITATION_ACCEPTED`, `INVITATION_REVOKED` via `logAuditEvent()`.
- **Logging**: Route handlers use `createLogger('invitations')` in the list/create route; other routes use `console.error` (gap).
- **No metrics**: No invitation-specific metrics (send rate, acceptance rate, expiration rate) are tracked.

### Data Lifecycle

- **TTL**: Invitations expire and are automatically deleted by MongoDB after `expiresAt` passes (TTL index with `expireAfterSeconds: 0`).
- **Retention**: Accepted invitations are updated in-place (status=accepted) but will also be TTL-deleted when expiresAt passes. This means accepted invitation records are not preserved long-term. Audit events provide the permanent record.
- **Deletion cascade**: No cascade — revoking an invitation does not affect existing TenantMember records.

---

## 13. Delivery Plan / Work Breakdown

1. **Core invitation CRUD** (DONE)
   1.1 Mongoose model with indexes (`workspace-invitation.model.ts`)
   1.2 Repository layer (`workspace-repo.ts` invitation operations)
   1.3 Service layer (`invitation-service.ts` — create, accept, revoke, list)
   1.4 API routes (workspace-scoped list/create/delete)

2. **Token-based acceptance flow** (DONE)
   2.1 Public GET-by-token endpoint
   2.2 Authenticated POST accept-by-token endpoint
   2.3 Invite landing page UI (`/invite/:token`)

3. **SSO auto-accept integration** (DONE)
   3.1 `resolveUserContextOrAutoAcceptInvite()` helper
   3.2 Integration into all 6 auth callback routes
   3.3 Invitation picker page (`/invitations/choose`)
   3.4 Accept-by-ID endpoint for picker flow

4. **Email delivery** (DONE)
   4.1 `workspaceInvitationEmail()` template
   4.2 i18n strings for invitation emails
   4.3 SMTP integration via `createEmailService()`

5. **Admin UI** (DONE)
   5.1 MembersPage component with invitation list
   5.2 Inline invite form with role selection
   5.3 Revoke invitation action

6. **Hardening & gaps** (TODO)
   6.1 Fix `console.error` usage in route handlers (use `createLogger`)
   6.2 Add transaction support to `acceptInvitation()` for atomicity
   6.3 Enforce tenant scoping in `acceptInvitationById()` repo call
   6.4 Add E2E tests for invitation lifecycle
   6.5 Add integration tests for SSO auto-accept flow
   6.6 Add resend invitation capability

---

## 14. Success Metrics

| Metric                       | Baseline | Target | How Measured                                |
| ---------------------------- | -------- | ------ | ------------------------------------------- |
| Invitation acceptance rate   | N/A      | >70%   | Audit events: accepted / sent ratio         |
| Time to first workspace join | N/A      | <2 min | Timestamp delta: invitation_sent → accepted |
| SSO auto-accept success rate | N/A      | >95%   | Auth callback logs: auto-accept vs picker   |
| Invitation-related errors    | N/A      | <1%    | Error logs from invitation API routes       |

---

## 15. Open Questions

1. Should accepted invitation records be preserved beyond the TTL for historical reporting, or is the audit log sufficient?
2. Should invitation expiry be configurable per-tenant (e.g., enterprise tenants may want 30-day invitations)?
3. Should there be a "resend invitation" action that reuses the same invitation record with a refreshed token and expiry, rather than requiring revoke + re-create?
4. What happens when a user accepts an invitation but already has a different workspace selected as their active tenant? Should the UI auto-switch tenants?
5. Should the invitation email include a decline link, or is ignoring the email sufficient?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | `acceptInvitationById()` in invitation-service.ts calls `findInvitationById(invitationId)` without tenantId, bypassing tenant-scoped query | High     | Open   |
| GAP-002 | Several route handlers (accept, accept-by-id, pending, revoke) use `console.error` instead of `createLogger()`                             | Medium   | Open   |
| GAP-003 | `acceptInvitation()` creates TenantMember and updates invitation in two separate operations without a transaction                          | High     | Open   |
| GAP-004 | No E2E tests exist for the invitation lifecycle; existing tests in `api-org-routes.test.ts` use `vi.mock()` extensively                    | High     | Open   |
| GAP-005 | No pagination on `findInvitations()` — returns all invitations for a tenant                                                                | Low      | Open   |
| GAP-006 | TTL index deletes accepted invitation records, losing the historical record (only audit events remain)                                     | Medium   | Open   |
| GAP-007 | No email delivery retry mechanism — if SMTP fails, invitation email is lost                                                                | Medium   | Open   |
| GAP-008 | CREATE invitation route duplicates role hierarchy validation logic that also exists in `invitation-service.ts`                             | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                      | Coverage Type | Status     | Test File / Note                      |
| --- | --------------------------------------------- | ------------- | ---------- | ------------------------------------- |
| 1   | Create invitation (happy path)                | unit          | PASS       | `api-org-routes.test.ts` (mock-based) |
| 2   | Create invitation (role hierarchy)            | unit          | PASS       | `api-org-routes.test.ts` (mock-based) |
| 3   | Accept invitation by token                    | e2e           | NOT TESTED |                                       |
| 4   | Accept invitation by ID (picker flow)         | e2e           | NOT TESTED |                                       |
| 5   | Revoke invitation                             | unit          | PASS       | `api-org-routes.test.ts` (mock-based) |
| 6   | SSO auto-accept single invitation             | e2e           | NOT TESTED |                                       |
| 7   | SSO redirect to picker (multiple invitations) | e2e           | NOT TESTED |                                       |
| 8   | Expired invitation rejection                  | e2e           | NOT TESTED |                                       |
| 9   | Cross-tenant invitation access (404)          | e2e           | NOT TESTED |                                       |
| 10  | Email mismatch rejection                      | e2e           | NOT TESTED |                                       |
| 11  | Email template generation                     | unit          | PASS       | `email-templates.test.ts`             |

### Testing Notes

Current test coverage is limited to mock-based unit tests in `api-org-routes.test.ts` and email template tests. No E2E or integration tests exercise the real invitation lifecycle through HTTP. The SSO auto-accept integration is completely untested. Cross-tenant isolation and email-mismatch rejection need E2E coverage.

> Full testing details: `../testing/invitations.md`

---

## 18. References

- Design docs: `docs/archive/plans-2026-02/2026-02-24-sso-auto-accept-invitations-design.md`
- Auth architecture: `docs/security/STUDIO_AUTH.md`
- Database schema: `packages/database/src/models/workspace-invitation.model.ts`
- Related feature docs: [Workspace Sharing](workspace-sharing.md), [SSO / Enterprise Auth](sso-enterprise-auth.md), [Audit Logging](audit-logging.md)
