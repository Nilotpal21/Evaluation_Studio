# Platform Access Control — Invitation Bypass & Email Allowlisting Design

**Date:** 2026-05-20  
**Ticket:** ABLP-1145  
**Status:** IMPLEMENTED — implementation complete 2026-05-21; ALPHA

---

## Background

Two requirements expand platform access control:

1. **Invitation bypass** — users invited to a workspace can sign up and log in even if their email domain is not on the platform allowlist. They are restricted from _creating_ workspaces until their domain or email is explicitly allowlisted (soft/policy-driven restriction).
2. **Email-level allowlisting** — admins can allowlist individual email addresses (e.g. `john@gmail.com`) for platforms where users bring personal/free-provider emails. Allowlisted emails get full platform access subject to standard RBAC; they can also create workspaces.

Both requirements apply to all authentication methods (email/password, Google, Microsoft, LinkedIn, OIDC, SAML).

---

## Current State

### Access gating — `isEmailAllowedForAuth`

`packages/database/src/platform-access-policy.ts: isEmailAllowedForAuth(email, opts?)` is the single gate called at 8 routes before any user is created or authenticated. It checks, in order:

1. `isPlatformAdminEmail` — `platform_admins` collection
2. `isBootstrapPlatformAdminEmail` — `SUPER_ADMIN_USER_IDS` env + User lookup
3. Domain match against `platform_allowed_domains` + `DEFAULT_ALLOWED_DOMAINS`

There is **no invitation awareness** in this gate.

### Existing MongoDB models (packages/database)

| Collection                 | Model                   | Purpose                     |
| -------------------------- | ----------------------- | --------------------------- |
| `platform_allowed_domains` | `PlatformAllowedDomain` | Custom sign-in domains      |
| `platform_admins`          | `PlatformAdmin`         | Admin console access emails |
| `platform_access_requests` | `PlatformAccessRequest` | Pending access requests     |

### JWT claims

`JWTPayload` in `auth-service.ts` carries: `sub`, `email`, `type`, `tokenClass`, `tenantId`, `role`, `orgId`, `isSuperAdmin`. No workspace-creation eligibility claim exists.

### Workspace creation

- `POST /api/auth/create-workspace` only limits by `maxWorkspaces` (default 10) — no allowlist check.
- `UserMenu.tsx`, `/onboarding`, `/invitations/choose` all show "Create workspace" unconditionally.

### Admin UI

Three panels: **Allowed Domains** · **Platform Admins** · **Pending Access Requests**. No email allowlisting.

---

## Approach

**Approach 1 (chosen): Mirror `PlatformAllowedDomain` pattern.**  
Add a new `PlatformAllowedEmail` model that exactly mirrors `PlatformAllowedDomain`. Extend `isEmailAllowedForAuth` with an optional `inviteToken` parameter. Compute `canCreateWorkspace` at login time and embed it in the JWT.

**Approach 2 (rejected): Unified AllowEntry model.**  
Single collection with `type: 'domain' | 'email'`. Rejected because it would require migrating the existing domain UI/API and loses separate TTL/index semantics.

**Approach 3 (rejected): Embed allowed emails in a settings document.**  
No audit trail, no per-entry lifecycle, poor scalability.

---

## Design

### 1. Database Layer — `packages/database`

#### 1a. New model: `PlatformAllowedEmail`

New file: `packages/database/src/models/platform-allowed-email.model.ts`

```typescript
interface IPlatformAllowedEmail {
  _id: string; // uuidv7
  email: string; // normalized lowercase, indexed unique
  status: 'active' | 'revoked';
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}
// collection: 'platform_allowed_emails'
// indexes: { email: 1 } unique, { status: 1, email: 1 }
// plugin: auditTrailPlugin
```

Exported from `packages/database/src/models/index.ts`.

#### 1b. New functions in `platform-access-policy.ts`

```typescript
// Allowlisted email CRUD (mirrors domain equivalents)
listAllowedEmails(): Promise<PlatformAccessPolicy['allowedEmails']>
addAllowedEmail(email: string, actorUserId: string): Promise<void>
revokeAllowedEmail(email: string): Promise<boolean>

// Internal check used by isEmailAllowedForAuth and canCreateWorkspace
isAllowlistedEmail(email: string): Promise<boolean>

// Invite token validation
hasValidInvitationForEmail(email: string, inviteToken: string): Promise<boolean>
  // resolves token hash → looks up TenantInvitation with status 'pending'
  // checks invitation.email === normalized email
  // checks invitation.expiresAt > now
  // returns boolean — does NOT accept/consume the invite

// Updated: add inviteToken option
isEmailAllowedForAuth(
  email: string,
  opts?: { bootstrapUserIds?: readonly string[]; inviteToken?: string }
): Promise<boolean>
  // check order:
  // 1. isPlatformAdminEmail
  // 2. isBootstrapPlatformAdminEmail
  // 3. domain in allowlist
  // 4. isAllowlistedEmail           ← NEW
  // 5. hasValidInvitationForEmail    ← NEW (only if inviteToken provided)

// Workspace creation eligibility — does NOT consider invite tokens
canUserCreateWorkspace(
  email: string,
  opts?: { bootstrapUserIds?: readonly string[] }
): Promise<boolean>
  // returns true if:
  // - isPlatformAdminEmail
  // - isBootstrapPlatformAdminEmail
  // - domain in allowlist
  // - isAllowlistedEmail
  // Invite tokens do NOT grant workspace creation eligibility.
```

#### 1c. Update `PlatformAccessPolicy` interface

Add `allowedEmails: Array<{ id, email, addedByUserId, createdAt }>` field.

Update `listAccessPolicy()` to include `allowedEmails` alongside existing fields.

---

### 2. Studio Auth Layer — `apps/studio`

#### 2a. JWT: add `canCreateWorkspace` claim

In `auth-service.ts`:

```typescript
// JWTPayload — add optional field
interface JWTPayload {
  // ... existing fields ...
  canCreateWorkspace?: boolean; // absent means true (backward compat)
}
```

`createAccessToken` is currently synchronous. The `canCreateWorkspace` check requires a DB call, so it cannot be embedded in `createAccessToken` directly. Instead, the callers that already call `canUserCreateWorkspace` DB-side (login, OAuth callback, `createTokenPair`) pass it as an option:

```typescript
// createAccessToken signature — add option
function createAccessToken(
  user,
  tenantContext?,
  options?: {
    isSuperAdmin?: boolean;
    canCreateWorkspace?: boolean; // NEW — caller computes before calling
  },
);

// Callers: compute before calling createTokenPair/createAccessToken
const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email, { bootstrapUserIds }));
createAccessToken(user, tenantContext, { isSuperAdmin, canCreateWorkspace: canCreate });
```

This keeps `createAccessToken` synchronous and puts the DB call responsibility in the callers that already have async context.

**Token backward compatibility**: `canCreateWorkspace` absent in older tokens → treat as `true` (existing sessions unaffected). Only new tokens explicitly set `false` for invited-only users.

#### 2b. Thread `inviteToken` through all 8 auth routes

Each route that calls `isEmailAllowedForAuth` must extract the invite token and pass it.

| Route                             | Invite token source                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/signup`           | Request body: `inviteToken?: string`                                                                                   |
| `POST /api/auth/login`            | Request body: `inviteToken?: string`                                                                                   |
| `GET /api/auth/resolve-account`   | Query param: `invite`                                                                                                  |
| `GET /api/auth/callback` (Google) | Cookie: `oauth_invite` (already read; needs to be passed before the domain check, which currently happens at line 127) |
| Microsoft callback                | Same pattern as Google                                                                                                 |
| LinkedIn callback                 | Same pattern                                                                                                           |
| OIDC callback                     | Same pattern                                                                                                           |
| SAML callback                     | Same pattern                                                                                                           |

All callback routes already read `oauth_invite` cookie **after** the domain check. The fix is to read it **before** and pass to `isEmailAllowedForAuth`.

#### 2c. `create-workspace` route: enforce `canCreateWorkspace`

Add claim check after `requireAuth`:

```typescript
if (user.canCreateWorkspace === false) {
  return authError(
    'Workspace creation is not available for your account. Contact your administrator.',
    403,
  );
}
```

#### 2d. UI: gate "Create workspace" on `canCreateWorkspace`

Three locations:

- `apps/studio/src/components/auth/UserMenu.tsx` — the "Create workspace" button in the user dropdown
- `apps/studio/src/app/onboarding/page.tsx` — the "Create a new workspace" option
- `apps/studio/src/app/invitations/choose/page.tsx` — the "Create workspace instead" link

Gate: show only when `user.canCreateWorkspace !== false` (backward compat: undefined/absent → show).

Restricted users see a tooltip/note: _"Workspace creation requires an allowlisted domain or email. Contact your platform administrator."_

#### 2e. Expose `canCreateWorkspace` on `/api/auth/me`

Update the `/api/auth/me` response shape to include `canCreateWorkspace: boolean` derived from the JWT claim. This is what the UI reads.

---

### 3. Admin Layer — `apps/admin`

#### 3a. API routes

New routes under `apps/admin/src/app/api/access/emails/`:

> **Implementation note:** Route paths were simplified from the original design (`allowed-emails/[id]`) to `emails?email=...` for consistency with the existing domains route. Delete takes an `?email=` query param instead of an ID path segment, matching the domain revocation pattern.

```
GET  /api/access/emails
     → full PlatformAccessPolicy (includes allowedEmails array)

POST /api/access/emails
     body: { email: string }
     → full PlatformAccessPolicy (updated)

DELETE /api/access/emails?email=<address>
     → full PlatformAccessPolicy (updated), or 404 if not found
```

All routes behind the existing `withAdminRoute` middleware (VIEWER for GET, ADMIN for POST/DELETE).

Input validation: `z.string().email().max(254)` via Zod. Errors return `{ success: false, error: string }` with 400 status.

#### 3b. Update `GET /api/access` (policy endpoint)

Include `allowedEmails` in the response by calling `listAllowedEmails()`.

#### 3c. Admin UI — new "Allowed Emails" panel

Layout: **Option A — 4 separate panels** (consistent with existing 3-panel design)

```
[ Allowed Domains ]  [ Allowed Emails ]
[ Platform Admins ]  [ Pending Requests ]
```

The Allowed Emails panel mirrors Allowed Domains:

- Title: "Allowed Emails"
- Lists each email with "Remove" action
- "+ Add email" inline input with validation
- Empty state: _"No individual emails added. Users must have an allowlisted domain to sign up."_

---

### 4. Error Messages (UX)

| Scenario                            | HTTP | Message                                                                                           |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| Email/domain not allowed, no invite | 403  | "This email domain is not approved for platform access." (existing)                               |
| Invite expired or invalid           | 403  | "This invitation is no longer valid. Request a new invitation from your workspace administrator." |
| Workspace creation blocked          | 403  | "Workspace creation is not available for your account. Contact your administrator."               |
| Email already in platform_admins    | 400  | "This email is already a platform admin. Platform admins have full access."                       |

---

### 5. Testing

**E2E scenarios (minimum 5):**

1. Non-allowlisted user with valid invite token can sign up via email/password
2. Non-allowlisted user with valid invite token can log in via Google OAuth
3. Non-allowlisted invited user cannot call `POST /api/auth/create-workspace` (403)
4. Non-allowlisted invited user does NOT see "Create workspace" in UI
5. Admin adds email to allowed list → user can now log in AND create workspace
6. Admin adds domain → invited user's `canCreateWorkspace` becomes `true` on next login

**Integration scenarios:**

1. `hasValidInvitationForEmail` returns false for expired invite
2. `hasValidInvitationForEmail` returns false for wrong email
3. `isEmailAllowedForAuth` returns true for allowlisted email (no invite needed)
4. `canUserCreateWorkspace` returns false for invited-only user
5. `canUserCreateWorkspace` returns true for allowlisted-email user

---

### 6. Non-Goals

- Admins cannot "promote" an allowed email to have invite-bypass privileges from the admin console — that is handled by the invitation system
- No notification email when admin adds an email to the allowlist (out of scope)
- No bulk import of allowed emails (out of scope)
- `canCreateWorkspace` does NOT apply to workspace-join flows (inviting someone to an existing workspace they can join) — only to creating new workspaces

---

### 7. Migration / Rollout

- No data migration required — new model, new column
- `canCreateWorkspace` absent in existing JWTs → treated as `true` → no regression for existing users
- After deploy, invited-only users who re-authenticate will receive `canCreateWorkspace: false` in their new tokens
- Existing platform admin emails and bootstrap super admins always get `canCreateWorkspace: true`
