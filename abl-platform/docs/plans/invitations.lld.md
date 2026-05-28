# Invitations / Team Collaboration — Low-Level Design

## Task T-1: WorkspaceInvitation Model

### Files

- `packages/database/src/models/workspace-invitation.model.ts` — Mongoose schema and model

### Schema

```typescript
{
  _id: String (uuidv7),
  tenantId: String (required),
  email: String (required),
  role: String (required, enum: MEMBER/VIEWER/OPERATOR/ADMIN/OWNER),
  invitedBy: String | null,
  token: String (SHA-256 hash, required),
  status: String (required, enum: pending/accepted/expired/revoked, default: pending),
  expiresAt: Date (required),
  acceptedAt: Date | null,
  acceptedBy: String | null,
  _v: Number (default: 1),
  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

- `{ token: 1 }` (unique) — Fast lookup for accept-by-token
- `{ tenantId: 1, email: 1 }` (unique) — Prevent duplicate pending invitations
- `{ email: 1 }` — For pending invitation lookup by user email
- `{ expiresAt: 1 }` (TTL, expireAfterSeconds: 0) — Automatic cleanup

### Plugins

- `tenantIsolationPlugin` — Enforces tenantId in all queries

---

## Task T-2: Invitation Service

### Files

- `apps/studio/src/services/invitation-service.ts` — Core business logic

### Functions

- `createInvitation({ tenantId, email, role, invitedBy })` — Create invitation with role hierarchy check, duplicate detection, token generation, email sending, audit logging
- `acceptInvitation(token, userId, userEmail)` — Accept by raw token (hash + lookup + email match + create membership)
- `acceptInvitationById(invitationId, userId, userEmail)` — Accept by DB ID (for SSO auto-accept)
- `revokeInvitation(invitationId, tenantId)` — Mark invitation as revoked
- `listInvitations(tenantId)` — List all invitations with inviter details
- `getInvitationByToken(token)` — Get invitation details for public display

### Role Hierarchy

- OWNER: Can invite any role (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER)
- ADMIN: Can invite ADMIN, OPERATOR, MEMBER, VIEWER (not OWNER)
- Others: Cannot send invitations

### Token Security

- Raw token: `crypto.randomBytes(64).toString('hex')` (128 hex chars)
- Stored token: `hashToken(raw)` → SHA-256 hex digest
- Accept URL: `{frontendUrl}/invite/{rawToken}`

---

## Task T-3: Admin Routes

### Files

- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/route.ts` — GET (list), POST (create)
- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts` — DELETE (revoke)
- `apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/resend/route.ts` — POST (resend)

### Authorization

- All admin routes require `requireAuth` + admin role check (OWNER or ADMIN)
- Resend and revoke routes include tenant isolation check (`authResult.tenantId !== tenantId` returns 404)
- Uses `withOpenAPI` wrapper for OpenAPI spec generation

### Resend Flow

1. Find existing invitation by ID + tenantId
2. Reject if already accepted
3. Delete old invitation (frees unique index)
4. Create new invitation via `createInvitation` service (generates new token, sends new email)
5. Audit log (INVITATION_RESENT)

---

## Task T-4: User Routes

### Files

- `apps/studio/src/app/api/invitations/[token]/route.ts` — GET: public invitation details
- `apps/studio/src/app/api/invitations/accept/route.ts` — POST: accept by token (requires auth)
- `apps/studio/src/app/api/invitations/accept-by-id/route.ts` — POST: accept by ID (requires auth)
- `apps/studio/src/app/api/invitations/pending/route.ts` — GET: list pending for authenticated user

### Accept Flow (both paths)

1. Validate invitation exists and is pending
2. Check not expired
3. Verify email match
4. Check if user is already a member (idempotent)
5. Create tenant membership
6. Mark invitation as accepted
7. Generate new token pair scoped to workspace
8. Set refresh_token in httpOnly cookie
9. Audit log (INVITATION_ACCEPTED)

---

## Task T-5: SSO Auto-Accept Integration

### Files

- `apps/studio/src/app/api/sso/saml/callback/route.ts` — SAML callback calls acceptInvitationById
- `apps/studio/src/app/api/sso/oidc/callback/route.ts` — OIDC callback calls acceptInvitationById

### Flow

- After SSO user authentication, find pending invitations by email
- For each pending invitation, call `acceptInvitationById`
- User is added to all invited workspaces on first login

---

## Known Gaps

| Gap                                            | Severity | Notes                                                         |
| ---------------------------------------------- | -------- | ------------------------------------------------------------- |
| Non-transactional acceptance                   | Medium   | Member creation and invitation update are separate operations |
| console.log in pending and accept-by-id routes | Low      | Should use createLogger                                       |
| No rate limiting on create                     | Medium   | Admin could spam invitations                                  |
| Resend does not verify original inviter        | Low      | Any admin can resend any invitation                           |

## Exit Criteria

- Admin routes return correct status codes for auth/validation failures
- Invitation accept verifies email match
- TTL index expires invitations after 7 days
- Audit events logged for all lifecycle operations
- SSO callbacks auto-accept pending invitations
