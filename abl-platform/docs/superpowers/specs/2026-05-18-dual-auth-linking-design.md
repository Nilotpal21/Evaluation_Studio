# Dual Auth Linking — Design Spec

**Date:** 2026-05-18
**Status:** Draft
**Scope:** Minimal — 3 file changes, no new endpoints, no migration

## Problem

Users who signed up via SSO (Google/Microsoft/LinkedIn) cannot set a password because:

1. `forgot-password` only sends reset emails to `authProvider === 'email'` users
2. `login` rejects password attempts for any user where `authProvider !== 'email'`
3. OAuth login rejects linking to accounts that already have a `passwordHash`

This means SSO users are locked into SSO-only, and email/password users cannot add SSO as a secondary login method.

## Decisions

| Decision   | Choice                                                                          | Rationale                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Scope      | Full bidirectional linking (SSO→password and email→SSO)                         | Users expect either login method to work                                                                                       |
| Removal    | No removal of linked methods                                                    | Simplest, no accidental lockout risk                                                                                           |
| UI         | No dedicated UI — natural flows only                                            | Forgot-password for SSO→password, OAuth login for email→SSO. Security settings page deferred.                                  |
| Data model | Keep `authProvider` as original method, derive capabilities from field presence | Zero migration, backward compatible. `passwordHash` presence = password login works. `googleId` presence = Google login works. |

## Design

### Change 1: Forgot Password — Send Reset to All Users

**File:** `apps/studio/src/app/api/auth/forgot-password/route.ts`

Remove the `authProvider === 'email'` gate. Any user with a valid email gets the reset link.

Add logging for visibility:

- SSO user requesting first-time password set (has no `passwordHash`)
- Non-existent email attempts (currently silent)

**Flow for SSO user:**

1. SSO user enters email on forgot-password page
2. Reset email sent (previously silently skipped)
3. User clicks link, lands on reset-password page
4. Sets new password → `passwordHash` stored (reset-password route already does this without checking `authProvider`)
5. User can now log in via SSO or email/password

### Change 2: Login — Gate on `passwordHash` Instead of `authProvider`

**File:** `apps/studio/src/app/api/auth/login/route.ts`

Replace:

```typescript
if (user.authProvider !== 'email') {
  return authError('Invalid email or password', 401);
}
```

With:

```typescript
if (!user.passwordHash) {
  log.info('Password login attempted for user without password', {
    userId: user.id,
    authProvider: user.authProvider,
  });
  return authError('Invalid email or password', 401);
}
```

This allows any user with a `passwordHash` to log in with email/password, regardless of how they originally signed up.

**Unchanged:** password verification (bcrypt), MFA flow, account lockout, email verification check, audit logging.

### Change 3: OAuth Auto-Linking — Link Instead of Reject

**File:** `apps/studio/src/services/auth-service.ts`

In `findOrCreateGoogleUser`, `findOrCreateMicrosoftUser`, and `findOrCreateLinkedInUser`: when an OAuth login matches an existing email/password user, **auto-link** instead of rejecting with 403.

Replace the `throw new AppError('An account with this email already exists...')` blocks with:

- Log the linking event
- Call `updateUser(existingUser.id, { googleId: profile.googleId })` (for Google)
- Update `lastLoginAt`, return the user

`authProvider` remains unchanged (preserves original signup method).

**Security rationale:** OAuth providers verify email ownership. If a user controls `user@example.com` on Google, they provably own that email address. Auto-linking is safe.

**Microsoft/LinkedIn note:** These providers don't have dedicated ID fields on the User model (unlike `googleId`). Linking works by email match only — the user record is found by email and the login succeeds. This is consistent with existing behavior for non-password users.

## What Does NOT Change

- User model schema — no new fields, no migration
- `authProvider` field — stays as original signup method, never mutated
- JWT payload — no new claims
- Reset-password route — already sets `passwordHash` without checking `authProvider`
- Signup route — still creates `authProvider: 'email'` users only
- MFA flow — works the same regardless of original provider
- Account lockout — applies to password login attempts regardless of provider
- Refresh token rotation — unchanged

## Derived Auth Method Logic

Instead of reading `authProvider` to determine what a user can do, check field presence:

| Field                          | If present | Meaning                             |
| ------------------------------ | ---------- | ----------------------------------- |
| `passwordHash`                 | non-null   | User can log in with email/password |
| `googleId`                     | non-null   | User can log in with Google         |
| email match on Microsoft OAuth | user found | User can log in with Microsoft      |
| email match on LinkedIn OAuth  | user found | User can log in with LinkedIn       |

`authProvider` becomes "how did this user originally sign up" — useful for audit/analytics but not for access control.

## Security Analysis

| Concern                               | Mitigation                                                            |
| ------------------------------------- | --------------------------------------------------------------------- |
| SSO user sets weak password           | Existing password strength validation in reset-password route         |
| Email enumeration via forgot-password | Generic response message already in place ("If an account exists...") |
| Account takeover via OAuth linking    | OAuth providers verify email ownership; auto-link is safe             |
| Timing attack on forgot-password      | Existing consistent-delay logic preserved                             |
| Brute force on new password login     | Existing account lockout + rate limiting applies                      |
| Password reuse                        | Existing `passwordHistory` check in reset-password route              |

## Files Changed

| File                                                    | Change                                                                                   | Lines affected         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| `apps/studio/src/app/api/auth/forgot-password/route.ts` | Remove authProvider gate, add logging                                                    | ~5 lines               |
| `apps/studio/src/app/api/auth/login/route.ts`           | Check `passwordHash` instead of `authProvider`                                           | ~5 lines               |
| `apps/studio/src/services/auth-service.ts`              | Auto-link in findOrCreateGoogleUser, findOrCreateMicrosoftUser, findOrCreateLinkedInUser | ~15 lines per function |

**Total:** ~40 lines changed across 3 files. No new files. No new endpoints. No migration.

## Future Work (Deferred)

- **Security settings page** (`/settings/security`) — UI to view linked auth methods
- `GET /api/user/auth-methods` endpoint — returns derived method list for the UI
- `microsoftId` / `linkedinId` fields on User model — ID-based linking parity with Google
- `authMethods` claim in JWT — if token-level enforcement is ever needed
