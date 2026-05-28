# HLD: Workspace Invitations

**Feature Spec**: [docs/features/invitations.md](../features/invitations.md)
**Test Spec**: [docs/testing/invitations.md](../testing/invitations.md)
**Status**: CURRENT
**Date**: 2026-03-23

---

## 1. Problem Statement

Workspace administrators need a secure, role-aware mechanism to invite users into their tenant workspace. The current implementation (ALPHA) supports the full invitation lifecycle — create, accept (by token and by ID), revoke, auto-accept via SSO — but has architectural gaps: no transaction safety on acceptance, missing tenant scoping in the accept-by-ID path, inconsistent logging, and zero E2E test coverage. This HLD documents the existing architecture and prescribes hardening changes to bring the feature to BETA quality.

---

## 2. Alternatives Considered

### Alternative A: Current Architecture (Enhance In-Place)

**Description:** Keep the existing Next.js API route → service → repository → MongoDB architecture. Fix the identified gaps (transaction safety, tenant scoping, logging, tests) without structural changes.

**Pros:**

- Zero migration cost — all code paths already exist and work
- Minimal blast radius — changes are targeted fixes
- Aligns with existing Studio patterns

**Cons:**

- Next.js API routes tightly couple HTTP handling with business logic
- Email sending is synchronous in the request path — slow SMTP can block responses
- No service extraction — harder to test invitation logic in isolation

**Effort:** Small

### Alternative B: Extract Invitation Microservice

**Description:** Extract invitation logic into a standalone Express service (`apps/invitation-service`) with its own API, decoupled from Studio.

**Pros:**

- Clean service boundary
- Independent scaling and deployment
- Can serve Runtime and Admin in addition to Studio

**Cons:**

- Significant infrastructure overhead for a relatively simple feature
- Adds network hop and service discovery
- Invitations are inherently tied to the Studio auth/onboarding flow
- Over-engineering for current scale

**Effort:** Large

### Alternative C: BullMQ Worker for Async Email

**Description:** Keep the current route/service/repo architecture but offload email sending to a BullMQ job. Invitation creation returns immediately; email is sent asynchronously.

**Pros:**

- Faster API response times
- Built-in retry for email delivery failures
- Follows existing BullMQ patterns in the codebase

**Cons:**

- Adds Redis dependency and BullMQ worker process
- More complex failure modes (job stuck, Redis down)
- Marginal benefit at current invitation volume

**Effort:** Medium

### Recommendation

**Alternative A (Enhance In-Place)** is the right choice for BETA. The existing architecture is sound and follows established Studio patterns. The gaps are targeted fixes (transaction, scoping, logging), not structural problems. Alternative C (async email) should be reconsidered when invitation volume justifies it, but is not needed now.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      Studio (Next.js)                    │
│                                                          │
│  ┌──────────────┐    ┌─────────────────┐                │
│  │ Invite UI    │───►│ API Routes      │                │
│  │ /invite/:tok │    │ /api/workspaces/ │                │
│  │ /invitations │    │ /api/invitations │                │
│  │ MembersPage  │    └────────┬────────┘                │
│  └──────────────┘             │                          │
│                               ▼                          │
│                    ┌──────────────────┐                  │
│                    │ invitation-      │                  │
│                    │ service.ts       │                  │
│                    └─────┬──────┬─────┘                  │
│                          │      │                        │
│          ┌───────────────┘      └──────────────┐        │
│          ▼                                     ▼        │
│  ┌───────────────┐                 ┌──────────────────┐ │
│  │ workspace-    │                 │ email-templates  │ │
│  │ repo.ts       │                 │ + SMTP service   │ │
│  └───────┬───────┘                 └──────────────────┘ │
│          │                                               │
└──────────┼───────────────────────────────────────────────┘
           ▼
    ┌─────────────┐     ┌──────────────┐
    │  MongoDB    │     │ Auth Callbacks│
    │ workspace_  │     │ (SSO/OAuth/  │
    │ invitations │     │  email verify)│
    └─────────────┘     │     │         │
                        │     ▼         │
                        │ resolveUser-  │
                        │ Context...()  │
                        └───────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                    API Layer                          │
│                                                      │
│  workspaces/[tenantId]/invitations/route.ts          │
│    GET  → listInvitations()                          │
│    POST → createInvitation()                         │
│                                                      │
│  workspaces/[tenantId]/invitations/[id]/route.ts     │
│    DELETE → revokeInvitation()                        │
│                                                      │
│  invitations/[token]/route.ts                        │
│    GET  → getInvitationByToken()  [PUBLIC]            │
│                                                      │
│  invitations/accept/route.ts                         │
│    POST → acceptInvitation()                         │
│                                                      │
│  invitations/accept-by-id/route.ts                   │
│    POST → acceptInvitationById()                     │
│                                                      │
│  invitations/pending/route.ts                        │
│    GET  → findPendingInvitationsForEmail()           │
│                                                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│                  Service Layer                        │
│                                                      │
│  invitation-service.ts                               │
│    createInvitation()   — validate, hash, store, email│
│    acceptInvitation()   — verify, create member, JWT │
│    acceptInvitationById() — same, by ID              │
│    revokeInvitation()   — update status              │
│    listInvitations()    — tenant-scoped list         │
│    getInvitationByToken() — public details           │
│                                                      │
│  auth-service.ts                                     │
│    resolveUserContextOrAutoAcceptInvite()             │
│    — Called by all SSO/OAuth callbacks                │
│    — Auto-accepts 1 invite, redirects for 2+         │
│                                                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│               Repository Layer                       │
│                                                      │
│  workspace-repo.ts                                   │
│    createInvitation()                                │
│    findInvitationById()                              │
│    findInvitationByToken()                           │
│    findInvitationByTokenWithRelations()              │
│    findInvitationByEmail()                           │
│    findInvitations()                                 │
│    updateInvitation()                                │
│    deleteInvitation()                                │
│    createTenantMember()                              │
│                                                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│                    Data Layer                         │
│                                                      │
│  MongoDB: workspace_invitations                      │
│    Indexes: token(unique), tenantId+email(unique),   │
│             email, expiresAt(TTL)                    │
│                                                      │
│  MongoDB: tenant_members                             │
│    Created on acceptance                             │
│                                                      │
│  MongoDB: audit_events                               │
│    INVITATION_SENT, ACCEPTED, REVOKED                │
└─────────────────────────────────────────────────────┘
```

### Data Flow: Accept Invitation by Token

```
1. User clicks email link → GET /invite/:token (UI page)
2. UI fetches → GET /api/invitations/:token (public)
   └─ service.getInvitationByToken(token)
      └─ hashToken(token)
      └─ repo.findInvitationByTokenWithRelations(hash)
      └─ Return { email, role, workspaceName, inviterName }

3. User clicks "Accept" → POST /api/invitations/accept
   └─ requireAuth() — verify JWT
   └─ service.acceptInvitation(token, userId, email)
      ├─ hashToken(token)
      ├─ repo.findInvitationByTokenWithRelations(hash)
      ├─ Validate: status=pending, not expired, email matches
      ├─ repo.createTenantMember({ tenantId, userId, role })
      ├─ repo.updateInvitation(id, tenantId, { status: accepted })
      └─ Return { tenantId, role }
   └─ createTokenPair(user, tenantContext) — new JWT with tenantId
   └─ logAuditEvent(INVITATION_ACCEPTED)
   └─ Set refresh_token cookie
   └─ Return { tenantId, role, accessToken, expiresIn }
```

### Data Flow: SSO Auto-Accept

```
1. User authenticates via SSO (Google/SAML/OIDC/etc.)
2. Auth callback route calls:
   └─ resolveUserContextOrAutoAcceptInvite(userId, email)
      ├─ Check existing TenantMember — if exists, return context
      ├─ findPendingInvitations(email)
      │   ├─ 0 invitations → return null (proceed to onboarding)
      │   ├─ 1 invitation → auto-accept → return tenantContext
      │   └─ 2+ invitations → return { pendingInvitationChoice: true }
      └─ If pendingInvitationChoice → redirect to /invitations/choose
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

- **Query-level enforcement**: All invitation queries in `workspace-repo.ts` include `tenantId` in the filter (`findInvitations(tenantId)`, `updateInvitation(id, tenantId)`, `deleteInvitation(id, tenantId)`).
- **Unique compound index**: `{ tenantId: 1, email: 1 }` ensures per-tenant uniqueness.
- **Cross-tenant access**: DELETE handler checks `authResult.tenantId !== params.tenantId` → returns 404.
- **Gap (GAP-001)**: `acceptInvitationById()` calls `findInvitationById(invitationId)` without tenantId. **Fix**: Pass the invitation's tenantId into the query after email verification (the email match already gates access, but defense-in-depth requires query-level scoping).

#### 2. Data Access Pattern

- **Repository pattern**: `workspace-repo.ts` encapsulates all MongoDB queries. No direct model imports in routes or services.
- **Manual joins**: Relations (tenant name, inviter name) fetched via separate queries rather than MongoDB aggregation. Acceptable for current scale (invitations are low-volume).
- **No caching**: Invitation data is always read fresh from MongoDB. TTL-based expiration makes caching unnecessary.

#### 3. API Contract

- **Request shapes**: Zod schemas validate all inputs (email format, role enum).
- **Response envelope**: Routes return `{ invitation: {...} }` or `{ invitations: [...] }` for success; `{ error: string }` for errors.
- **Status codes**: 201 (created), 200 (success), 400 (bad request), 401 (unauth), 403 (forbidden), 404 (not found), 500 (server error).
- **OpenAPI**: Routes use `withOpenAPI()` wrapper for auto-generated Swagger documentation.
- **Gap**: Error responses use `{ error: string }` instead of the platform standard `{ success: false, error: { code, message } }`. **Fix**: Align with standard error envelope.

#### 4. Security Surface

- **Token security**: 64 random bytes, SHA-256 hashed before storage. Raw token only in email.
- **Auth**: All mutation endpoints use `requireAuth()`. Public GET-by-token endpoint reveals only invitation metadata (no token hash, no internal IDs).
- **Privilege escalation**: Role hierarchy enforced in both service layer and route handler.
- **Input validation**: Zod schemas validate email format and role enum values.
- **XSS prevention**: Email template uses `escapeHtml()` for all user-provided values.

### Behavioral Concerns

#### 5. Error Model

| Error Condition               | HTTP Status | User Message                                        | Recovery Action              |
| ----------------------------- | ----------- | --------------------------------------------------- | ---------------------------- |
| Invalid/expired token         | 400         | "This invitation has expired"                       | Request new invitation       |
| Already accepted              | 400         | "This invitation has already been used"             | Navigate to workspace        |
| Email mismatch                | 403         | "This invitation was sent to a different email"     | Sign in with correct account |
| Already a member              | 400         | "User is already a member of this workspace"        | Navigate to workspace        |
| Duplicate pending invitation  | 400         | "An invitation has already been sent to this email" | Revoke and re-create         |
| Non-admin creating invitation | 403         | "Insufficient permissions"                          | Contact workspace admin      |
| Privilege escalation attempt  | 403         | "Admins cannot invite users with OWNER role"        | Choose a lower role          |

#### 6. Failure Modes

| Failure                      | Impact                                                         | Mitigation                          |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| MongoDB down                 | All invitation operations fail                                 | Standard app-level health checks    |
| SMTP down                    | Invitation created but email not sent                          | No retry; user has no way to accept |
| Partial acceptance (GAP-003) | TenantMember created but invitation not updated, or vice versa | **Fix**: Use MongoDB transaction    |
| Token hash collision         | Near-zero probability (SHA-256, 64-byte input)                 | Unique index on token catches it    |

#### 7. Idempotency

- **Create**: Not idempotent — duplicate calls rejected by unique index on `{ tenantId, email }`.
- **Accept**: Not idempotent — second accept fails with "already used". If user is already a member, invitation is marked accepted and existing membership returned.
- **Revoke (DELETE)**: Idempotent at the DB level (findOneAndDelete returns null for already-deleted).

#### 8. Observability

- **Audit events**: `INVITATION_SENT`, `INVITATION_ACCEPTED`, `INVITATION_REVOKED` with metadata (userId, tenantId, IP, userAgent, invitee email, role).
- **Logging**: `createLogger('invitations')` in the workspace-scoped routes. **Gap (GAP-002)**: Other routes use `console.error`.
- **No metrics**: No counters for invitation send rate, acceptance rate, or expiration rate. **Future**: Add Prometheus counters.

### Operational Concerns

#### 9. Performance Budget

| Operation         | Target Latency | Payload Size Limit | Notes                                |
| ----------------- | -------------- | ------------------ | ------------------------------------ |
| Create invitation | <500ms         | ~1KB request       | Includes SMTP send (synchronous)     |
| Accept invitation | <200ms         | ~1KB request       | Two DB writes + JWT generation       |
| List invitations  | <100ms         | ~50KB response     | No pagination (max ~1000 per tenant) |
| Get by token      | <50ms          | ~500B response     | Single indexed query                 |

#### 10. Migration Path

No data migration needed. The schema and indexes already exist in production (ALPHA). The hardening changes (transaction, scoping, logging) are backwards-compatible code changes with no schema modifications.

#### 11. Rollback Plan

All hardening changes are backwards-compatible:

- Transaction support: If MongoDB replica set is not available, fall back to non-transactional writes (current behavior).
- Tenant scoping fix: More restrictive query — no data loss on rollback.
- Logger fix: Cosmetic change — no functional impact on rollback.

#### 12. Test Strategy

| Test Type       | Count | What It Covers                                                                   |
| --------------- | ----- | -------------------------------------------------------------------------------- |
| E2E             | 10    | Full HTTP lifecycle, cross-tenant isolation, auth, security                      |
| Integration     | 8     | Service boundaries, repo layer, SSO auto-accept                                  |
| Unit            | 4     | Token hashing, email templates, schema validation                                |
| Coverage target | ---   | 80% line coverage for invitation-service.ts, workspace-repo invitation functions |

Tests described in [docs/testing/invitations.md](../testing/invitations.md). Key principle: E2E tests use real HTTP calls, no mocks, no direct DB access.

---

## 5. Data Model

### Existing Collection: workspace_invitations

No schema changes required for BETA. Current schema is correct and complete.

```
workspace_invitations {
  _id: string (UUIDv7)
  tenantId: string (required)
  email: string (required)
  role: string (required)
  invitedBy: string | null
  token: string (SHA-256 hash, required)
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  expiresAt: Date (required)
  acceptedAt: Date | null
  acceptedBy: string | null
  _v: number
  createdAt: Date
  updatedAt: Date
}

Indexes:
  { token: 1 }                    UNIQUE — token lookup
  { tenantId: 1, email: 1 }      UNIQUE — duplicate prevention
  { email: 1 }                   — cross-tenant email lookup
  { expiresAt: 1 }               TTL (expireAfterSeconds: 0)
```

### Related Collections (No Changes)

- `tenant_members`: Created on acceptance (`{ tenantId, userId, role }`)
- `audit_events`: Events emitted on lifecycle transitions
- `users`: Referenced by `invitedBy` and `acceptedBy`
- `tenants`: Referenced by `tenantId`

---

## 6. API Design

### Existing Endpoints (No Changes to Contract)

| Method | Path                                                  | Auth     | Purpose                     | Response                                     |
| ------ | ----------------------------------------------------- | -------- | --------------------------- | -------------------------------------------- |
| GET    | `/api/workspaces/:tenantId/invitations`               | Required | List workspace invitations  | `{ invitations: [...] }`                     |
| POST   | `/api/workspaces/:tenantId/invitations`               | Required | Create invitation           | `{ invitation: {...} }`                      |
| DELETE | `/api/workspaces/:tenantId/invitations/:invitationId` | Required | Revoke invitation           | `{ success: true }`                          |
| GET    | `/api/invitations/:token`                             | Public   | Get invitation details      | `{ invitation: {...} }`                      |
| POST   | `/api/invitations/accept`                             | Required | Accept by token             | `{ tenantId, role, accessToken, expiresIn }` |
| POST   | `/api/invitations/accept-by-id`                       | Required | Accept by ID (picker flow)  | `{ tenantId, role, accessToken, expiresIn }` |
| GET    | `/api/invitations/pending`                            | Required | List user's pending invites | `{ invitations: [...] }`                     |

### Error Response Alignment (Hardening Change)

Current: `{ error: "message" }`
Target: `{ success: false, error: { code: "INVITATION_EXPIRED", message: "This invitation has expired" } }`

This aligns with the platform standard error envelope.

---

## 7. Cross-Cutting Concerns

### Audit Logging

Already implemented via `logAuditEvent()`:

- `INVITATION_SENT`: metadata includes invitee email, assigned role
- `INVITATION_ACCEPTED`: metadata includes accepted role, accept method (token/picker)
- `INVITATION_REVOKED`: metadata includes invitation ID, invitee email

### Rate Limiting

No invitation-specific rate limiting. General Studio API rate limiting applies. Consider adding per-tenant invitation rate limit in the future (e.g., max 50 invitations per hour per tenant).

### Caching

No caching. All reads go to MongoDB. Invitation data is low-volume and frequently mutated (status changes), making caching counterproductive.

### Encryption

- **At rest**: MongoDB encryption at rest (infrastructure-level).
- **In transit**: HTTPS for all API calls. SMTP TLS for email delivery.
- **Token security**: Raw tokens are 64 cryptographic random bytes. Only SHA-256 hashes stored in DB.

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                | Risk   | Notes                                        |
| ------------------------- | ------ | -------------------------------------------- |
| MongoDB                   | Medium | Core data store; no fallback                 |
| SMTP service              | Medium | Email delivery; no retry on failure          |
| Auth system (requireAuth) | Low    | Well-established, shared across all features |
| i18n package              | Low    | Email string localization                    |

### Downstream (Depends On This Feature)

| Dependent                         | Impact | Notes                                       |
| --------------------------------- | ------ | ------------------------------------------- |
| SSO callbacks (all 6 auth routes) | High   | Call resolveUserContextOrAutoAcceptInvite() |
| MembersPage admin UI              | Medium | Displays and manages invitations            |
| Billing (future)                  | Low    | Member count affects seat calculations      |

---

## 9. Open Questions & Decisions Needed

1. **Transaction support**: MongoDB sessions require replica set. Verify that all environments (dev, staging, prod) run replica sets. If not, implement compensating actions instead.
2. **Error envelope migration**: Should the error response format change be done across all Studio routes at once, or invitation-specific first?
3. **Accepted invitation retention**: The TTL index deletes accepted invitations. Should we remove accepted/revoked invitations from TTL by clearing expiresAt on status change?
4. **Email delivery failure UX**: When SMTP fails, should the API return success (invitation created) or error? Current behavior: swallows email error, returns success.

---

## 10. References

- Feature spec: [docs/features/invitations.md](../features/invitations.md)
- Test spec: [docs/testing/invitations.md](../testing/invitations.md)
- SSO auto-accept design: [docs/archive/plans-2026-02/2026-02-24-sso-auto-accept-invitations-design.md](../archive/plans-2026-02/2026-02-24-sso-auto-accept-invitations-design.md)
- Auth architecture: [docs/security/STUDIO_AUTH.md](../security/STUDIO_AUTH.md)
- Data model: [packages/database/src/models/workspace-invitation.model.ts](../../packages/database/src/models/workspace-invitation.model.ts)
