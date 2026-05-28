# HLD: Workspace Sharing

**Feature Spec**: [docs/features/workspace-sharing.md](../features/workspace-sharing.md)
**Test Spec**: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)
**Status**: APPROVED
**Last Updated**: 2026-03-23

---

## 1. Problem Statement

Multi-user collaboration within a tenant workspace requires a controlled membership layer that supports invitation-based onboarding, role-based access control, and tenant-context switching. Without this, workspaces are single-user silos, teams cannot collaborate on agent development, and administrators lack the tooling to manage access at the workspace level.

The current implementation provides this layer through Studio APIs backed by MongoDB. This HLD documents the architecture as implemented, identifies architectural gaps, and proposes improvements.

---

## 2. Alternatives Considered

### Alternative A: Studio-Owned Control Plane (Current — Selected)

**Description**: Workspace sharing is entirely a Studio (Next.js) concern. Member management, invitation lifecycle, and workspace switching are handled by Studio API routes backed by MongoDB models. No Runtime involvement.

**Pros**:

- Simple deployment — no cross-service coordination needed
- Studio already owns auth/session, so tenant context is naturally managed
- Repository + service layer provides clean separation of concerns
- Invitation acceptance integrates directly with Studio auth flows (SSO, email verification)

**Cons**:

- Runtime has no awareness of workspace membership (cannot enforce member-level access)
- No event bus — downstream services cannot react to membership changes
- Invitation token handling has an inconsistency between route and service layer (GAP-001)

**Effort**: S (already implemented)

### Alternative B: Shared Service with Event Bus

**Description**: Extract workspace sharing into a shared service (`packages/workspace-service`) with a BullMQ/Redis event bus. Studio and Runtime both consume the service. Membership changes emit events that downstream services react to.

**Pros**:

- Runtime can enforce member-level access controls
- Event-driven architecture enables analytics, notifications, and audit without coupling
- Single source of truth for membership logic

**Cons**:

- Significantly higher complexity — new service, message queue, event schema
- Migration overhead from current Studio-only model
- Over-engineering for current scale (most workspaces have < 10 members)

**Effort**: L

### Recommendation

**Alternative A (current)** is appropriate for the current maturity stage. The feature works, is well-tested, and the Studio-only model is sufficient for the current user base. When Runtime needs workspace membership awareness (e.g., for per-member rate limiting or member-level audit), Alternative B should be revisited. The key gaps (GAP-001 token inconsistency, GAP-002 console.error usage, GAP-004 incomplete role enum) should be fixed within the current architecture.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      Studio (Next.js)                    │
│                                                          │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │ MembersPage  │  │ UserMenu       │  │ Invite Pages │ │
│  │ (Admin UI)   │  │ (Switcher)     │  │ (Accept UI)  │ │
│  └──────┬───────┘  └──────┬─────────┘  └──────┬───────┘ │
│         │                 │                    │          │
│         ▼                 ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────┐│
│  │              Studio API Routes (Next.js)              ││
│  │  /api/workspaces/:tenantId/members                   ││
│  │  /api/workspaces/:tenantId/invitations               ││
│  │  /api/invitations/accept | accept-by-id | pending    ││
│  │  /api/auth/tenants | /api/auth/tenants/switch        ││
│  └──────┬───────────────────────┬───────────────────────┘│
│         │                       │                         │
│         ▼                       ▼                         │
│  ┌──────────────┐  ┌────────────────────┐                │
│  │ workspace-   │  │ invitation-service │                │
│  │ repo.ts      │  │ auth-service.ts    │                │
│  │              │  │ workspace-service  │                │
│  └──────┬───────┘  └──────┬─────────────┘                │
│         │                 │                               │
│         ▼                 ▼                               │
│  ┌──────────────────────────────────────┐                │
│  │         MongoDB                       │                │
│  │  tenants | tenant_members |           │                │
│  │  workspace_invitations | users        │                │
│  └───────────────────────────────────────┘                │
│         │                                                 │
│         ▼                                                 │
│  ┌──────────────┐  ┌────────────────┐                    │
│  │ Email Service│  │ Audit Service  │                    │
│  │ (SMTP)       │  │ (logAuditEvent)│                    │
│  └──────────────┘  └────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Routes Layer                                             │
│                                                          │
│  members/route.ts ──────────────┐                       │
│  invitations/route.ts ──────────┤   ┌────────────────┐  │
│  invitations/accept/route.ts ───┤   │  requireAuth() │  │
│  invitations/accept-by-id/ ─────┤   │  (auth gate)   │  │
│  invitations/pending/route.ts ──┤   └────────────────┘  │
│  auth/tenants/route.ts ─────────┤                       │
│  auth/tenants/switch/route.ts ──┘                       │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│ Service Layer                                            │
│                                                          │
│  invitation-service.ts                                   │
│    - createInvitation()   - acceptInvitation()           │
│    - acceptInvitationById() - revokeInvitation()         │
│    - listInvitations()    - getInvitationByToken()       │
│                                                          │
│  auth-service.ts                                         │
│    - switchTenant()       - getUserById()                │
│    - createTokenPair()                                   │
│                                                          │
│  workspace-service.ts                                    │
│    - createWorkspace()    - generateUniqueSlug()          │
│    - createDefaultWorkspace()                            │
│                                                          │
│  audit-service.ts                                        │
│    - logAuditEvent()                                     │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│ Repository Layer                                         │
│                                                          │
│  workspace-repo.ts                                       │
│    - findTenantById/BySlug()                             │
│    - createTenant() / updateTenant()                     │
│    - createTenantMember() / findTenantMember()           │
│    - findTenantMembers() / updateTenantMember()          │
│    - deleteTenantMember() / countTenantMembers()         │
│    - createInvitation() / findInvitation*()              │
│    - updateInvitation() / deleteInvitation()             │
│    - createWorkspaceWithOwner() (transactional)          │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│ Data Layer (MongoDB)                                     │
│                                                          │
│  tenants (w/ auditTrailPlugin)                           │
│  tenant_members (unique: tenantId+userId)                │
│  workspace_invitations (TTL on expiresAt)                │
│  role_definitions (seeded per tenant)                    │
│  users                                                   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow: Invitation Acceptance (Token-Based)

1. User clicks email link -> `GET /invite/:token` page loads
2. Page calls `GET /api/invitations/:token` (public) -> returns invitation details
3. User clicks "Accept" -> `POST /api/invitations/accept` with `{ token }`
4. Route calls `requireAuth()` to verify the user is logged in
5. Route calls `acceptInvitation(token, userId, userEmail)` in invitation-service
6. Service hashes the token and looks up the invitation record
7. Service verifies: status=pending, not expired, email matches
8. Service creates TenantMember record via workspace-repo
9. Service updates invitation status to 'accepted'
10. Route calls `createTokenPair()` to issue a new JWT scoped to the accepted workspace
11. Route sets refresh_token cookie and returns `{ tenantId, role, accessToken }`

### Sequence Diagram: Workspace Switching

```
User         Studio UI        API Route          auth-service       workspace-repo      MongoDB
 │               │                │                    │                  │                 │
 │  Click switch │                │                    │                  │                 │
 │──────────────>│                │                    │                  │                 │
 │               │ POST /switch   │                    │                  │                 │
 │               │ {tenantId}     │                    │                  │                 │
 │               │───────────────>│                    │                  │                 │
 │               │                │ requireAuth()      │                  │                 │
 │               │                │────────────────────│                  │                 │
 │               │                │ switchTenant(user,  │                  │                 │
 │               │                │   tenantId)        │                  │                 │
 │               │                │───────────────────>│                  │                 │
 │               │                │                    │ findTenantMember │                 │
 │               │                │                    │ (tenantId,userId)│                 │
 │               │                │                    │─────────────────>│                 │
 │               │                │                    │                  │ findOne({       │
 │               │                │                    │                  │  tenantId,      │
 │               │                │                    │                  │  userId})       │
 │               │                │                    │                  │────────────────>│
 │               │                │                    │                  │<────────────────│
 │               │                │                    │<─────────────────│                 │
 │               │                │                    │ sign JWT with    │                 │
 │               │                │                    │ tenantId + role  │                 │
 │               │                │<───────────────────│                  │                 │
 │               │ { accessToken, │                    │                  │                 │
 │               │   tenantId,    │                    │                  │                 │
 │               │   role }       │                    │                  │                 │
 │               │<───────────────│                    │                  │                 │
 │  Update auth  │                │                    │                  │                 │
 │  store + UI   │                │                    │                  │                 │
 │<──────────────│                │                    │                  │                 │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | How Addressed                                                                                                                                                                                                                    |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All member/invitation queries are scoped by `tenantId`. Route handlers compare `authResult.tenantId` with the path parameter and return 404 for mismatches. `workspace-repo.ts` methods take `tenantId` as a required parameter. |
| 2   | **Data Access Pattern** | Repository pattern via `workspace-repo.ts`. Services never import Mongoose models directly. Manual joins for user details (`findTenantMembers` with `includeUser` option). No caching layer currently.                           |
| 3   | **API Contract**        | Zod schemas for request/response validation. OpenAPI integration via `withOpenAPI()` wrapper. Error envelope: `{ error: string }` with appropriate HTTP status codes. No API versioning beyond endpoint paths.                   |
| 4   | **Security Surface**    | `requireAuth()` on all routes. Role hierarchy checks at both route and service layers. Invitation tokens are SHA-256 hashed (in service path). Email verification on acceptance. No SSRF risk (no user-provided URLs processed). |

### Behavioral Concerns

| #   | Concern           | How Addressed                                                                                                                                                                                                                                                                              |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | Safe error messages only (whitelist in `accept-by-id` route). AppError with ErrorCodes for structured errors in service layer. Route handlers catch and return generic messages for unexpected errors. Console.error in some routes (GAP-002).                                             |
| 6   | **Failure Modes** | Email delivery failure does not block invitation creation (fire-and-forget). MongoDB transaction failure in `createWorkspaceWithOwner` rolls back atomically. Acceptance partial state risk documented in `invitation-service.ts` (member creation + status update are not transactional). |
| 7   | **Idempotency**   | Duplicate invitation creation is blocked by unique index `{tenantId, email}`. Double acceptance returns "already been used". Member creation is idempotent (existing membership returns early). Workspace switching is inherently idempotent.                                              |
| 8   | **Observability** | Audit events via `logAuditEvent()` for invitation sent, accepted, revoked, and member role changes. Structured logging via `createLogger('invitations')` in some routes. GAP-002: some routes still use `console.error`.                                                                   |

### Operational Concerns

| #   | Concern                | How Addressed                                                                                                                                                                                                            |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | CRUD operations with simple MongoDB queries. Member listing joins are O(n) with batch user lookup. No pagination currently (works for < 1000 members). Invitation TTL index prevents unbounded growth.                   |
| 10  | **Migration Path**     | N/A — the feature is fully implemented. If migrating to Alternative B (shared service), the migration would involve: extract service, add event bus, redirect Studio routes to new service, deprecate old routes.        |
| 11  | **Rollback Plan**      | N/A — the feature is stable. Individual bug fixes can be reverted per-commit. Data model changes would require migration scripts.                                                                                        |
| 12  | **Test Strategy**      | Unit tests for service logic. Integration tests for service-repo-MongoDB boundaries. E2E tests for full HTTP API flows including auth, isolation, and role hierarchy. See test spec for 7 E2E + 6 integration scenarios. |

---

## 5. Data Model

### Existing Collections (No Changes Required)

**tenants**: Workspace identity. Fields: `_id`, `name`, `slug`, `ownerId`, `organizationId`, `status`, `retentionDays`, `settings`, `llmPolicy`. Plugin: `auditTrailPlugin`.

**tenant_members**: Workspace membership. Fields: `_id`, `tenantId`, `userId`, `role`, `customRoleId`. Unique index: `{tenantId, userId}`.

**workspace_invitations**: Invitation records. Fields: `_id`, `tenantId`, `email`, `role`, `invitedBy`, `token`, `status`, `expiresAt`, `acceptedAt`, `acceptedBy`. Unique indexes: `{token}`, `{tenantId, email}`. TTL index: `{expiresAt}`.

**role_definitions**: RBAC role definitions per tenant. Seeded from `SYSTEM_ROLES` during workspace creation.

### Key Relationships

```
tenants._id <── tenant_members.tenantId
users._id   <── tenant_members.userId
tenants._id <── workspace_invitations.tenantId
users._id   <── workspace_invitations.invitedBy
users._id   <── workspace_invitations.acceptedBy
```

---

## 6. API Design

### Existing Endpoints (No Changes Required)

All endpoints are documented in the feature spec (section 8). Key design patterns:

- **Auth**: All routes use `requireAuth()` from `@/lib/auth`
- **Tenant scoping**: Routes under `/api/workspaces/:tenantId/` verify `authResult.tenantId === tenantId`
- **Admin access**: Member/invitation management requires OWNER or ADMIN role
- **Zod validation**: Request bodies and path params validated with Zod schemas
- **OpenAPI**: Most routes wrapped with `withOpenAPI()` for auto-documentation

### Error Responses

| Status | Meaning               | Used When                                          |
| ------ | --------------------- | -------------------------------------------------- |
| 400    | Bad Request           | Invalid input, duplicate invitation, expired       |
| 401    | Unauthorized          | Missing or invalid auth token                      |
| 403    | Forbidden             | Insufficient role, cross-tenant access, escalation |
| 404    | Not Found             | Resource not found or cross-tenant (no leakage)    |
| 500    | Internal Server Error | Unexpected failures                                |

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Invitation sent: `AuditActions.INVITATION_SENT` with `{ inviteeEmail, role }`
- Invitation accepted: `AuditActions.INVITATION_ACCEPTED` with `{ role, acceptMethod }`
- Member role changed and removed: logged via audit service
- IP address and user agent captured from request headers

### Rate Limiting

No invitation-specific rate limiting. General API rate limiting applies. This is acceptable for current scale but should be revisited if invitation abuse becomes a concern.

### Caching

No caching layer for membership or invitation data. All queries go directly to MongoDB. This is acceptable for current scale (< 100 members per workspace).

### Encryption

- Invitation tokens are SHA-256 hashed before storage (in `invitation-service.ts`)
- JWT tokens for workspace context are signed with the platform JWT secret
- No encryption at rest beyond MongoDB's native encryption (if configured)

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency    | Risk   | Notes                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------- |
| Studio auth   | Low    | `requireAuth()`, JWT issuance, session management — stable and mature  |
| MongoDB       | Low    | Document storage for tenants, members, invitations — well-established  |
| Email service | Medium | SMTP delivery for invitation emails — external dependency, can fail    |
| Audit service | Low    | `logAuditEvent()` — fire-and-forget, failure does not block operations |

### Downstream (Depends on This Feature)

| Consumer       | Impact | Notes                                                                    |
| -------------- | ------ | ------------------------------------------------------------------------ |
| Project access | Medium | `project-access.ts` checks tenant membership to authorize project access |
| SDK resources  | Low    | Workspace context determines which SDK/channel resources are visible     |
| Studio nav     | Low    | Navigation and sidebar content is scoped by active tenant context        |

---

## 9. Open Questions & Decisions Needed

1. **Token inconsistency (GAP-001)**: The route handler uses `crypto.randomUUID()` while the service uses `crypto.randomBytes(64).toString('hex')` + SHA-256 hash. Should this be unified? **Decision: DECIDED — yes, unify to service-layer token generation. Route should delegate to invitation-service.**
2. **Member listing pagination**: Currently returns all members in a single response. Should pagination be added? **Decision: DECIDED — defer until a workspace exceeds 100 members. No known workspaces at that scale.**
3. **Event bus for membership changes**: Should membership changes emit events? **Decision: DECIDED — not needed now. Revisit when Runtime needs membership awareness.**
4. **Incomplete role enum in switchTenantResponseSchema (GAP-004)**: The response schema only includes OWNER, ADMIN, MEMBER. **Decision: DECIDED — fix to include all 5 roles (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER).**

---

## 10. References

- Feature spec: [docs/features/workspace-sharing.md](../features/workspace-sharing.md)
- Test spec: [docs/testing/workspace-sharing.md](../testing/workspace-sharing.md)
- System roles: `packages/database/src/constants/system-roles.ts`
- Invitation service: `apps/studio/src/services/invitation-service.ts`
- Workspace repo: `apps/studio/src/repos/workspace-repo.ts`
