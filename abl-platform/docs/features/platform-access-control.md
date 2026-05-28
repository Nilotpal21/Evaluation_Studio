# Feature Spec: Platform Access Control — Invitation Bypass & Email Allowlisting

- **Feature ID:** ABLP-1145
- **Status:** ALPHA
- **Owner:** Platform Engineering
- **Created:** 2026-05-20
- **Last Updated:** 2026-05-21

---

## 1. Problem Statement

Two gaps in platform access control:

1. Users invited to a workspace cannot sign up/login if their email domain is not on the platform allowlist — even though they have a valid invitation.
2. Platform admins cannot allowlist individual email addresses — only domains — making it impossible to grant access to users with free-provider emails (gmail.com, icloud.com, etc.).

## 2. Background & Context

Platform access is gated by `isEmailAllowedForAuth` in `packages/database/src/platform-access-policy.ts`, called at 9 auth routes before any user is created or authenticated. It previously only checked: platform admin → bootstrap super admin → allowed domain. No invitation awareness. No email-level allowlisting.

## 3. Requirements

### FR-1: Invitation Bypass

Users with a valid workspace invitation can sign up and log in even if their email domain is not on the platform allowlist. Applies to all authentication methods: email/password, Google, Microsoft, LinkedIn, OIDC, SAML.

### FR-2: Workspace Creation Restriction

Invited-only users (domain not allowlisted, email not allowlisted) cannot create new workspaces. Restriction is soft/policy-driven and lifts if the domain or email is later added to the allowlist.

### FR-3: Email-Level Allowlisting

Platform admins can allowlist individual email addresses. Allowlisted users get full platform access subject to standard RBAC and can create workspaces.

### FR-4: Admin UI for Email Allowlisting

Admin console exposes an "Allowed Emails" panel with add/remove functionality, consistent with the existing "Allowed Domains" panel.

## 4. Architecture

### Auth Gate Extension

`isEmailAllowedForAuth(email, opts?)` in `packages/database/src/platform-access-policy.ts` now checks:

1. Platform admin email
2. Bootstrap super admin email
3. Domain in `platform_allowed_domains`
4. Email in `platform_allowed_emails` (NEW)
5. Valid invite token in `workspace_invitations` (NEW — only if `opts.inviteToken` provided)

### JWT Claim

`canCreateWorkspace?: boolean` added to JWT payload. Computed at login time: `isSuperAdmin || canUserCreateWorkspace(email)`. Absent = `true` (backward compat). Only explicitly set to `false` for invited-only users.

### Database

New MongoDB collection `platform_allowed_emails` with model `PlatformAllowedEmail` mirroring `PlatformAllowedDomain` structure.

## 5. Data Model

### Collection: `platform_allowed_emails`

| Field           | Type                       | Description                       |
| --------------- | -------------------------- | --------------------------------- |
| `_id`           | String (uuidv7)            | Primary key                       |
| `email`         | String (lowercase, unique) | Normalized email address          |
| `status`        | 'active' \| 'revoked'      | Whether allowlist entry is active |
| `addedByUserId` | String                     | User who added this entry         |
| `createdAt`     | Date                       | Auto-timestamp                    |
| `updatedAt`     | Date                       | Auto-timestamp                    |

**Indexes:** `{ email: 1 }` unique; `{ status: 1, email: 1 }`

### JWT payload addition

| Field                | Type               | Default         |
| -------------------- | ------------------ | --------------- |
| `canCreateWorkspace` | boolean (optional) | absent = `true` |

## 6. API Surface

### Studio Auth API (new behavior)

| Route                              | Change                                                |
| ---------------------------------- | ----------------------------------------------------- |
| `POST /api/auth/signup`            | Accepts `inviteToken?: string`; passes to domain gate |
| `POST /api/auth/login`             | Accepts `inviteToken?: string`; passes to domain gate |
| `POST /api/auth/resolve-account`   | Accepts `inviteToken?: string`; passes to domain gate |
| `GET /api/auth/callback` (Google)  | Reads `oauth_invite` cookie before domain check       |
| `GET /api/auth/microsoft/callback` | Same                                                  |
| `GET /api/auth/linkedin/callback`  | Same                                                  |
| `GET /api/sso/oidc/callback`       | Same                                                  |
| `GET /api/sso/saml/callback`       | Same                                                  |
| `POST /api/auth/create-workspace`  | Returns 403 when `canCreateWorkspace === false`       |
| `GET /api/auth/me`                 | Returns `canCreateWorkspace: boolean`                 |

### Admin API (new)

| Route                | Method | Auth   | Description                                          |
| -------------------- | ------ | ------ | ---------------------------------------------------- |
| `/api/access/emails` | GET    | VIEWER | Returns full access policy including `allowedEmails` |
| `/api/access/emails` | POST   | ADMIN  | Add email to allowlist; body: `{ email: string }`    |
| `/api/access/emails` | DELETE | ADMIN  | Remove email; query param: `?email=...`              |

## 7. Key Implementation Files

| File                                                                   | Purpose                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/database/src/models/platform-allowed-email.model.ts`         | Mongoose model for email allowlist entries                                   |
| `packages/database/src/platform-access-policy.ts`                      | Core policy functions: email CRUD, invite validation, canUserCreateWorkspace |
| `packages/database/src/__tests__/platform-access-policy-email.test.ts` | Integration tests (17)                                                       |
| `apps/studio/src/lib/platform-auth-policy.ts`                          | Studio wrapper exposing new DB functions                                     |
| `apps/studio/src/services/auth-service.ts`                             | JWT claim computation (createTokenPair, buildTokenPair, switchTenant)        |
| `apps/studio/src/lib/auth.ts`                                          | AuthenticatedUser.canCreateWorkspace decoded from JWT                        |
| `apps/studio/src/store/auth-store.ts`                                  | User.canCreateWorkspace in auth store                                        |
| `apps/studio/src/app/api/auth/me/route.ts`                             | /me returns canCreateWorkspace                                               |
| `apps/studio/src/app/api/auth/create-workspace/route.ts`               | Server-side 403 gate                                                         |
| `apps/studio/src/components/auth/UserMenu.tsx`                         | UI gate for Create Workspace button                                          |
| `apps/studio/src/app/onboarding/page.tsx`                              | Restricted message for canCreateWorkspace=false                              |
| `apps/studio/src/app/invitations/choose/page.tsx`                      | Gates create-workspace links                                                 |
| `apps/admin/src/app/api/access/emails/route.ts`                        | Admin email allowlist API                                                    |
| `apps/admin/src/app/(dashboard)/access/page.tsx`                       | Admin UI Allowed Emails panel                                                |

## 8. Testing Status

| Coverage Type                | Count | Status  |
| ---------------------------- | ----- | ------- |
| Integration tests (DB layer) | 17    | PASS    |
| E2E tests (HTTP API)         | 0     | planned |
| UI manual verification       | 0     | planned |

**Status justification (ALPHA):** Implementation complete across all 9 auth routes, JWT claim, auth store, admin API, and admin UI. Build passes. 17 integration tests passing. No E2E tests written yet — required for BETA promotion.

## 9. Known Gaps

| Gap                                                   | Severity | Status                   |
| ----------------------------------------------------- | -------- | ------------------------ |
| No E2E test suite for invitation bypass flows         | HIGH     | OPEN — required for BETA |
| No E2E test for workspace creation 403 enforcement    | HIGH     | OPEN — required for BETA |
| No E2E test for admin email allowlist API             | MEDIUM   | OPEN                     |
| No UI tests for restricted onboarding/UserMenu states | MEDIUM   | OPEN                     |

## 10. Migration / Rollout

- No data migration — new collection only
- `canCreateWorkspace` absent in existing JWTs → treated as `true` → no regression
- After deploy, invited-only users who re-authenticate receive `canCreateWorkspace: false` in new tokens
- Platform admins and bootstrap super admins always get `canCreateWorkspace: true`
