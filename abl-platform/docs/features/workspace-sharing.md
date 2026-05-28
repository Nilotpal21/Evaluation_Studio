# Feature: Workspace Sharing

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `customer experience`, `governance`, `admin operations`, `enterprise`
**Package(s)**: `apps/studio`, `packages/database`, `packages/shared`, `packages/shared-auth`, `packages/i18n`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

Without workspace sharing, tenant collaboration becomes manual and brittle: one user effectively owns the workspace, invitations are unmanaged, and switching between multiple tenant memberships is awkward or impossible. Teams that need shared access to agent development environments face friction, while platform administrators lack the tooling to enforce role boundaries and maintain auditability across multi-user workspaces.

### Goal Statement

Provide a secure tenant-collaboration layer that supports workspace membership management, invitation lifecycle management, and active-workspace switching while enforcing role hierarchy, tenant context, and audit visibility.

### Summary

Workspace Sharing is the tenant-collaboration feature that lets multiple users belong to the same workspace, receive role-based access, switch between multiple workspace memberships, and manage invitations to join a workspace. In the current architecture it is primarily a Studio control-plane feature backed by MongoDB tenant/member/invitation records.

The feature spans four closely related user flows: member management, invitation lifecycle, invitation acceptance, and active-workspace switching. Owners and admins can list members, change roles, remove members, invite new users, resend or revoke invitations, and audit those changes. End users can view pending invitations, accept an invite, and switch their current tenant context when they belong to more than one workspace.

This is intentionally scoped to workspace-level (tenant-level) sharing. It is not the same as project-level collaboration, organization/workspace linking, or public share links.

### Canonical Workspace Role Model

This feature spec is the canonical source for workspace-scoped membership behavior. In implementation terms, `workspace` and `tenant` are the same scope.

Built-in workspace roles are defined by `TENANT_ROLE_PERMISSIONS` in `packages/shared-auth/src/rbac/role-permissions.ts`:

| Role       | Primary use              | Typical capabilities                                                             |
| ---------- | ------------------------ | -------------------------------------------------------------------------------- |
| `OWNER`    | Full workspace control   | Full administrative control, billing, ownership transfer, workspace lifecycle    |
| `ADMIN`    | Workspace administration | Manage members, settings, models, secrets, connectors, and all projects in scope |
| `OPERATOR` | Production operations    | Monitor analytics/sessions, deploy environments, execute workflows/tools         |
| `MEMBER`   | Day-to-day building      | Build and test project-scoped resources in projects they can access              |
| `VIEWER`   | Read-only access         | Read-only visibility into workspace and project resources                        |

Notes:

- Workspace membership controls which tenant a user belongs to, but non-admin workspace members still need explicit project membership for project-scoped access.
- Workspace administration pages in Studio are only exposed to `OWNER` and `ADMIN` users. `OPERATOR`, `MEMBER`, and `VIEWER` collaborate through project-scoped settings and see an access-denied state instead of admin tabs if they navigate directly to workspace-admin routes.
- Workspace custom-role infrastructure exists in `TenantMember.customRoleId` and tenant permission resolution, but a dedicated workspace custom-role management surface is outside this feature. Project-scoped custom roles are documented in [Custom Project Roles](custom-project-roles.md).

---

## 2. Scope

### Goals

- Allow owners and admins to manage workspace members and invitations from Studio
- Enforce role hierarchy and tenant context during membership changes and invitation flows
- Let multi-workspace users list and switch their active tenant context safely
- Preserve auditability for invitation and membership lifecycle events
- Provide both token-based and ID-based invitation acceptance paths

### Non-Goals (Out of Scope)

- Project-level collaboration permissions (separate concern from workspace sharing)
- Public share-link or anonymous access flows
- Cross-tenant super-admin console outside Studio
- Bulk invitation import (CSV/spreadsheet)
- Custom invitation expiry duration per tenant or per invitation
- Invitation rate limiting beyond general API rate limiting

---

## 3. User Stories

1. As a **workspace owner**, I want to invite and manage teammates so that the workspace can be operated collaboratively.
2. As a **workspace admin**, I want to enforce role hierarchy while changing membership so that I cannot accidentally escalate or remove protected roles.
3. As a **user who belongs to multiple workspaces**, I want to switch active workspace context so that I can access the right tenant-scoped data and UI.
4. As an **invited user**, I want to click an email link and accept the invitation so that I can immediately access the workspace.
5. As an **invited user with multiple pending invitations**, I want to see a picker page listing all invitations so that I can choose which workspace to join.
6. As a **workspace admin**, I want to view all pending invitations for my workspace so that I can track who has been invited.
7. As a **workspace admin**, I want to revoke a pending invitation so that I can withdraw access before it is accepted.

---

## 4. Functional Requirements

1. **FR-1**: The system must allow OWNER and ADMIN role members to list workspace members and invitations.
2. **FR-2**: The system must allow authorized users to create, resend, revoke, and accept workspace invitations.
3. **FR-3**: The system must enforce role hierarchy for invite, role-change, and member-removal operations (OWNERs can invite any role; ADMINs can invite ADMIN, OPERATOR, MEMBER, VIEWER but not OWNER).
4. **FR-4**: The system must let authenticated users discover pending invitations and accept them through token-based or ID-based flows.
5. **FR-5**: The system must allow users with multiple memberships to list available workspaces and switch active tenant context, re-issuing a tenant-scoped JWT.
6. **FR-6**: The system must record audit-relevant invitation and membership actions via `logAuditEvent()`.
7. **FR-7**: The system must generate a cryptographically random token for each invitation, store its hash, and embed the raw token in the invitation email link.
8. **FR-8**: The system must reject invitation creation if the target email already belongs to an active workspace member.
9. **FR-9**: The system must reject invitation creation if a pending, non-expired invitation already exists for the same tenant+email combination.
10. **FR-10**: The system must automatically expire invitations after 7 days via a MongoDB TTL index on `expiresAt`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                   |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workspace membership controls which projects become visible inside the selected tenant context.                         |
| Agent lifecycle            | NONE         | The feature does not directly change runtime execution behavior.                                                        |
| Customer experience        | SECONDARY    | Customer teams use it to collaborate in shared workspaces, but it is still an operator/admin-facing control-plane flow. |
| Integrations / channels    | NONE         | The feature is not channel-specific.                                                                                    |
| Observability / tracing    | SECONDARY    | Audit logging is a core part of the membership and invitation lifecycle.                                                |
| Governance / controls      | PRIMARY      | Role hierarchy, tenant context, and invitation ownership are governance controls.                                       |
| Enterprise / compliance    | SECONDARY    | Multi-user workspace administration is a baseline enterprise readiness feature.                                         |
| Admin / operator workflows | PRIMARY      | Members page, invitation management, and workspace switcher are the main user-facing surfaces.                          |

### Related Feature Integration Matrix

| Related Feature                               | Relationship Type   | Why It Matters                                                                            | Key Touchpoints                                      | Current State        |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| [Invitations](invitations.md)                 | extends             | Workspace sharing builds on the invitation lifecycle model.                               | invitation-service.ts, workspace-invitation.model.ts | Active integration   |
| [SSO/Enterprise Auth](sso-enterprise-auth.md) | shares auth context | Invitation acceptance and workspace switching rely on Studio auth/session flows.          | tenant-scoped JWT issuance, authenticated acceptance | Active integration   |
| [SDK](sdk.md)                                 | gates access to     | Workspace context determines which tenant-scoped SDK/channel resources a user can manage. | tenant switching, Studio resource visibility         | Indirect integration |

---

## 6. Design Considerations (Optional)

- `MembersPage` (`apps/studio/src/components/admin/MembersPage.tsx`) balances member management and pending invitation workflows in one admin surface.
- `UserMenu` (`apps/studio/src/components/auth/UserMenu.tsx`) exposes workspace switching as a lightweight, always-available control rather than a separate settings page.
- Invitation acceptance needs both public token lookup (`/api/invitations/:token`) and authenticated acceptance flows (`/api/invitations/accept`, `/api/invitations/accept-by-id`).

---

## 7. Technical Considerations (Optional)

- The feature is Studio-owned; there is no dedicated Runtime API surface today.
- Membership, invitation, and workspace-switch behavior spans repo (`workspace-repo.ts`), service (`invitation-service.ts`, `auth-service.ts`), auth, and email concerns.
- Invitation creation in the route handler (`workspaces/[tenantId]/invitations/route.ts`) currently writes directly through the repo path using `crypto.randomUUID()`, while resend uses `invitation-service.ts` which generates a 64-byte random token and SHA-256 hashes it. This inconsistency is a known gap (GAP-001).
- Role hierarchy is enforced in both the route handler and the service layer (dual enforcement).

---

## 8. How to Consume

### Studio UI

- **Members admin page**: `MembersPage` displays current members, pending invitations, invite form, role changes, member removal, resend, and revoke actions.
- **Workspace switcher**: `UserMenu` lazily loads available workspaces and switches the active tenant context.
- **Workspace admin navigation**: `AdminSidebar` and `AppShell` only surface workspace administration pages to OWNER/ADMIN users; non-admin members collaborate through project settings instead.
- **Invitation pages**: invite acceptance flows consume public token lookup plus authenticated acceptance endpoints. Token-based: `/invite/:token`. Picker-based: `/invitations/choose`.

### API (Runtime)

There is no dedicated Runtime API surface for workspace sharing today. The feature is owned by Studio APIs.

### API (Studio)

| Method | Path                                                         | Purpose                                                     |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------- |
| GET    | `/api/workspaces/:tenantId/members`                          | List workspace members                                      |
| PATCH  | `/api/workspaces/:tenantId/members/:userId`                  | Change a member role                                        |
| DELETE | `/api/workspaces/:tenantId/members/:userId`                  | Remove a workspace member                                   |
| GET    | `/api/workspaces/:tenantId/invitations`                      | List workspace invitations                                  |
| POST   | `/api/workspaces/:tenantId/invitations`                      | Create a workspace invitation                               |
| POST   | `/api/workspaces/:tenantId/invitations/:invitationId/resend` | Resend an invitation with a fresh token/expiry              |
| DELETE | `/api/workspaces/:tenantId/invitations/:invitationId`        | Revoke an invitation                                        |
| GET    | `/api/invitations/:token`                                    | Public invitation lookup by token                           |
| GET    | `/api/invitations/pending`                                   | List pending invitations for the authenticated user's email |
| POST   | `/api/invitations/accept`                                    | Accept invitation by raw token                              |
| POST   | `/api/invitations/accept-by-id`                              | Accept invitation by DB ID                                  |
| GET    | `/api/auth/tenants`                                          | List workspaces/tenants for the current user                |
| POST   | `/api/auth/tenants/switch`                                   | Switch active workspace/tenant context                      |

### Admin Portal

Workspace sharing is managed through Studio's tenant/admin experience rather than a separate admin portal.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is not channel-specific. Its main integration point is tenant context: switching workspaces changes which projects, channels, and other tenant-scoped resources the user can see.

---

## 9. Data Model

### Collections / Tables

```text
Collection: tenants
Purpose: Workspace identity and top-level tenant metadata
Fields:
  - _id: string (UUIDv7)
  - name: string (required)
  - slug: string (required, unique)
  - ownerId: string (required)
  - organizationId: string | null
  - status: enum('active', 'suspended', 'archived', 'transferring')
  - retentionDays: number (default 7)
  - settings: Mixed | null
  - llmPolicy: embedded | null
Indexes:
  - { slug: 1 } unique
  - { organizationId: 1 }
  - { ownerId: 1 }
  - { status: 1 }
```

```text
Collection: tenant_members
Purpose: Workspace membership and role assignment
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - userId: string (required)
  - role: string (required) — one of OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
  - customRoleId: string | null
Indexes:
  - { tenantId: 1, userId: 1 } unique
  - { userId: 1 }
  - { customRoleId: 1 }
```

```text
Collection: workspace_invitations
Purpose: Pending/accepted/revoked/expired workspace invitations
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - email: string (required)
  - role: string (required)
  - invitedBy: string | null
  - token: string (required) — SHA-256 hash of raw token
  - status: enum('pending', 'accepted', 'expired', 'revoked')
  - expiresAt: Date (required)
  - acceptedAt: Date | null
  - acceptedBy: string | null
Indexes:
  - { token: 1 } unique
  - { tenantId: 1, email: 1 } unique
  - { email: 1 }
  - { expiresAt: 1 } TTL (expireAfterSeconds: 0)
```

### Key Relationships

- `tenant_members.tenantId` -> `tenants._id`
- `tenant_members.userId` -> `users._id`
- `workspace_invitations.tenantId` -> `tenants._id`
- `workspace_invitations.invitedBy` / `acceptedBy` -> `users._id`
- Accepting an invitation creates a `tenant_members` record and updates the invitation status

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                         | Purpose                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/studio/src/repos/workspace-repo.ts`                    | Tenant/member/invitation persistence and lookup helpers         |
| `apps/studio/src/services/invitation-service.ts`             | Invitation lifecycle, email delivery, token hashing, acceptance |
| `apps/studio/src/services/auth-service.ts`                   | Workspace listing and active-tenant switching                   |
| `apps/studio/src/services/workspace-service.ts`              | Workspace creation and slug generation                          |
| `packages/database/src/models/workspace-invitation.model.ts` | Invitation schema, unique constraints, TTL expiry               |
| `packages/database/src/models/tenant.model.ts`               | Tenant schema, audit trail plugin                               |
| `packages/database/src/models/tenant-member.model.ts`        | Tenant member schema and indexes                                |
| `packages/database/src/constants/system-roles.ts`            | RBAC role definitions (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER)  |

### Routes / Handlers

| File                                                                                | Purpose                                |
| ----------------------------------------------------------------------------------- | -------------------------------------- |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/route.ts`                    | List members (GET)                     |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts`                | List and create invitations (GET/POST) |
| `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` | Revoke invitation (DELETE)             |
| `apps/studio/src/app/api/invitations/[token]/route.ts`                              | Public token lookup (GET)              |
| `apps/studio/src/app/api/invitations/accept/route.ts`                               | Accept by token (POST)                 |
| `apps/studio/src/app/api/invitations/accept-by-id/route.ts`                         | Accept by invitation ID (POST)         |
| `apps/studio/src/app/api/invitations/pending/route.ts`                              | List pending invitations (GET)         |
| `apps/studio/src/app/api/auth/tenants/route.ts`                                     | List user workspaces (GET)             |
| `apps/studio/src/app/api/auth/tenants/switch/route.ts`                              | Switch active workspace (POST)         |

### UI Components

| File                                                     | Purpose                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/studio/src/components/admin/MembersPage.tsx`       | Workspace members/invitations admin surface                               |
| `apps/studio/src/components/auth/UserMenu.tsx`           | Workspace switcher and active-workspace display                           |
| `apps/studio/src/components/navigation/AdminSidebar.tsx` | Workspace-admin navigation, only visible to OWNER/ADMIN                   |
| `apps/studio/src/components/navigation/AppShell.tsx`     | Access-gated admin-shell routing and fallback state for non-admin members |
| `apps/studio/src/app/invite/[token]/page.tsx`            | Token-based invitation acceptance page                                    |
| `apps/studio/src/app/invitations/choose/page.tsx`        | Multi-invitation picker page                                              |

### Tests

| File                                                          | Type             | Coverage Focus                       |
| ------------------------------------------------------------- | ---------------- | ------------------------------------ |
| `apps/studio/src/__tests__/api-org-routes.test.ts`            | unit/integration | Workspace member and invitation APIs |
| `apps/studio/src/__tests__/auth-services.test.ts`             | unit             | Invitation service logic             |
| `apps/studio/src/__tests__/workspace-admin-pages.e2e.test.ts` | UI/API harness   | Admin page endpoint patterns         |

---

## 11. Configuration

### Environment Variables

| Variable       | Default       | Description                                               |
| -------------- | ------------- | --------------------------------------------------------- |
| `FRONTEND_URL` | local app URL | Used when generating invitation acceptance URLs in emails |

### Runtime Configuration

- Invitation emails use the resolved frontend URL to build `/invite/:token` acceptance links.
- Role hierarchy is enforced in route/service code rather than a separate policy config object.
- Workspace switching re-issues JWT access tokens scoped to the selected tenant.
- Invitation expiry is hardcoded to 7 days (`INVITE_EXPIRY_DAYS = 7` in `invitation-service.ts`).
- Valid invite roles are constrained: `VALID_INVITE_ROLES = ['MEMBER', 'VIEWER', 'OPERATOR']` plus ADMIN/OWNER with hierarchy checks.

### DSL / Agent IR / Schema

Workspace sharing is not authored in ABL. It is a Studio/auth/database feature.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Workspace sharing does not own project-level ACLs, but switching tenant context must gate which project-scoped resources become visible.                                 |
| Tenant isolation  | Member, invitation, and switch operations must stay scoped to the addressed `tenantId`, and cross-tenant access must not mutate or reveal other tenant membership state. |
| User isolation    | Invitation acceptance verifies the authenticated user's email, and users cannot modify protected membership state outside their role boundaries.                         |

### Security & Compliance

- Tenant-scoped lookups protect membership and invitation operations
- Role hierarchy checks block privilege escalation
- Invitation acceptance verifies email ownership against the authenticated user
- Invitation records expire automatically through the TTL index
- Invitation tokens are SHA-256 hashed before storage (in `invitation-service.ts`; note GAP-001 about route-level inconsistency)

### Performance & Scalability

The feature is lightweight and CRUD-oriented. Main costs come from user/inviter joins and email sending on invite/resend flows. Member listing uses manual joins (`findTenantMembers` with `includeUser` option).

### Reliability & Failure Modes

- Invitation delivery depends on shared email service behavior
- Acceptance and switch flows fail safely when tokens are invalid, invitations are missing, or membership is not present
- `accept-by-id` route surfaces safe error messages only (whitelist approach to prevent information leakage)

### Observability

Audit events capture key admin actions via `logAuditEvent()` with `AuditActions.INVITATION_SENT`, `AuditActions.INVITATION_ACCEPTED`. Some route-level logging still uses `console.error` instead of structured logging (GAP-002).

### Data Lifecycle

- Invitation records expire automatically through the TTL index on `expiresAt`
- Accepted and revoked invitations remain part of the audit/history surface until data-retention policies remove them

---

## 13. Delivery Plan / Work Breakdown

1. Core data model
   1.1 Tenant, TenantMember, WorkspaceInvitation models with indexes
   1.2 System role definitions (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER)
2. Repository layer
   2.1 workspace-repo.ts CRUD operations for tenant, member, invitation
   2.2 Transaction support for workspace+owner creation
3. Service layer
   3.1 invitation-service.ts lifecycle (create, accept, revoke, list)
   3.2 workspace-service.ts creation and slug generation
   3.3 auth-service.ts workspace listing and tenant switching
4. API routes
   4.1 Member management routes (GET, PATCH, DELETE)
   4.2 Invitation lifecycle routes (GET, POST, DELETE, resend)
   4.3 Public invitation acceptance routes (token, ID, pending)
   4.4 Tenant listing and switching routes
5. Studio UI
   5.1 MembersPage admin surface
   5.2 UserMenu workspace switcher
   5.3 Invitation acceptance pages (token-based, picker)

---

## 14. Success Metrics

| Metric                         | Baseline | Target  | How Measured                        |
| ------------------------------ | -------- | ------- | ----------------------------------- |
| Workspace member count > 1     | 0%       | 50%     | Percentage of active tenants        |
| Invitation acceptance rate     | N/A      | > 70%   | accepted / (accepted + expired)     |
| Workspace switch latency       | N/A      | < 500ms | API response time for tenant/switch |
| Role escalation attempt blocks | N/A      | 100%    | Audit log analysis                  |

---

## 15. Open Questions

1. Should the invitation creation in the route handler be consolidated to use `invitation-service.ts` instead of direct repo calls (resolving GAP-001)?
2. Should invitation expiry be configurable per-tenant rather than hardcoded to 7 days?
3. Should workspace sharing emit events to an event bus for downstream consumers (e.g., analytics, notifications)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Invitation creation in `workspaces/[tenantId]/invitations/route.ts` uses `crypto.randomUUID()` directly while `invitation-service.ts` generates a 64-byte random token and SHA-256 hashes it. Not unified. | High     | Open   |
| GAP-002 | Some workspace/invitation routes still use `console.error` instead of structured logging via `createLogger()`.                                                                                             | Low      | Open   |
| GAP-003 | Invitation acceptance by raw token and expired-invitation flows are not fully verified in automated tests.                                                                                                 | Medium   | Open   |
| GAP-004 | The `switchTenantResponseSchema` in `auth/tenants/switch/route.ts` has a limited role enum (`OWNER`, `ADMIN`, `MEMBER`) that excludes `OPERATOR` and `VIEWER`.                                             | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                            | Coverage Type | Status     | Test File / Note         |
| --- | --------------------------------------------------- | ------------- | ---------- | ------------------------ |
| 1   | Member listing with role/tenant enforcement         | integration   | PASS       | `api-org-routes.test.ts` |
| 2   | Invitation create/list/resend/revoke lifecycle      | integration   | PASS       | `api-org-routes.test.ts` |
| 3   | Role hierarchy enforcement (escalation prevention)  | integration   | PASS       | `api-org-routes.test.ts` |
| 4   | Invitation acceptance by ID                         | integration   | PASS       | `auth-services.test.ts`  |
| 5   | Invitation acceptance by raw token                  | e2e           | NOT TESTED | GAP-003                  |
| 6   | Workspace switching with JWT re-issuance            | integration   | PASS       | `auth-services.test.ts`  |
| 7   | Cross-tenant isolation (404 on cross-tenant access) | e2e           | NOT TESTED | Needed                   |
| 8   | Expired invitation rejection                        | e2e           | NOT TESTED | GAP-003                  |

### Testing Notes

Current coverage is strong for happy-path integration scenarios. Gaps exist in E2E testing for token-based acceptance, expired invitations, and cross-tenant isolation at the HTTP level.

> Full testing details: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)

---

## 18. References

- Feature matrix: `docs/feature-matrix.md`
- Related features: [Invitations](invitations.md), [SSO/Enterprise Auth](sso-enterprise-auth.md), [SDK](sdk.md)
- Testing guide: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)
