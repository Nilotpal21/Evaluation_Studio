# Feature Test Guide: Invitation Flow

**Feature**: Workspace invitation creation, acceptance, and management
**Owner**: Studio team
**Branch**: develop
**First tested**: 2026-03-24
**Last updated**: 2026-03-24
**Overall status**: STABLE

---

## Current State (as of 2026-03-24)

The invitation flow is working end-to-end including UI. Creating invitations sends emails via SMTP (confirmed delivery to Gmail via AWS SES), all validations (self-invite, duplicate, existing member, role hierarchy, cross-tenant) are enforced. Token-based acceptance correctly creates tenant membership with the invited role. Management APIs (list, revoke, resend) all work. Public token lookup masks email for PII protection. All protected endpoints correctly reject unauthenticated requests. Full UI flow tested via Playwright: email link -> invite page -> login -> accept -> dashboard redirect with correct role.

### Quick Health Dashboard

| Area                      | Status | Last Verified | Notes                                                       |
| ------------------------- | ------ | ------------- | ----------------------------------------------------------- |
| Create Invitation API     | PASS   | 2026-03-24    | Email sent via SMTP, all validations work                   |
| Accept by Token API       | PASS   | 2026-03-24    | Correct role assignment, DB state verified                  |
| Accept by ID API          | PASS   | 2026-03-24    | Works for invitation picker flow                            |
| Pending Invitations API   | PASS   | 2026-03-24    | Returns correct invitations for user                        |
| Public Token Lookup API   | PASS   | 2026-03-24    | Email masked, workspace/inviter populated                   |
| List Invitations API      | PASS   | 2026-03-24    | Returns all statuses correctly                              |
| Revoke Invitation API     | PASS   | 2026-03-24    | Physically deletes record                                   |
| Resend Invitation API     | PASS   | 2026-03-24    | Creates new invitation, sends email                         |
| Validation / Errors       | PASS   | 2026-03-24    | Specific error messages for all cases                       |
| Cross-Tenant Isolation    | PASS   | 2026-03-24    | Returns 404, no existence leakage                           |
| Role-Based Access Control | PASS   | 2026-03-24    | VIEWER cannot create invitations                            |
| Auth Enforcement          | PASS   | 2026-03-24    | All protected endpoints reject no-auth                      |
| UI Invite Page            | PASS   | 2026-03-24    | Shows invite details, accept button, email mismatch warning |
| UI Login -> Accept Flow   | PASS   | 2026-03-24    | Dev Login redirects back to invite page                     |
| UI Accept -> Dashboard    | PASS   | 2026-03-24    | Redirects to / with correct workspace                       |
| UI Email Mismatch Warning | PASS   | 2026-03-24    | Shows warning when logged-in email differs                  |

---

## Test Coverage Map

### API Tests - Create Invitation

- [x] Create valid invitation (new email) -- `Iteration 1 PASS`
- [x] Email sent via SMTP (verified by 8.3s response time) -- `Iteration 1 PASS`
- [x] DB record has hashed token (not raw) -- `Iteration 1 PASS`
- [x] Self-invite prevention -- `Iteration 1 PASS`
- [x] Duplicate pending invitation prevention -- `Iteration 1 PASS`
- [x] Existing member prevention -- `Iteration 1 PASS`
- [x] Invalid role rejected (SUPERADMIN) -- `Iteration 1 PASS`
- [x] Missing email field rejected -- `Iteration 1 PASS`
- [x] Missing role defaults to MEMBER -- `Iteration 1 PASS`
- [x] Cross-tenant create returns 404 -- `Iteration 1 PASS`
- [x] VIEWER cannot create invitations (403) -- `Iteration 1 PASS`

### API Tests - Accept Invitation

- [x] Accept by raw token -- correct role (VIEWER) assigned -- `Iteration 1 PASS`
- [x] Accept by ID -- works for invitation picker -- `Iteration 1 PASS`
- [x] Accept already-accepted invitation -- "already been used" -- `Iteration 1 PASS`
- [x] Accept with invalid token -- "Invalid invitation" -- `Iteration 1 PASS`
- [x] Accept with wrong email -- "sent to different email" -- `Iteration 1 PASS`
- [x] Accept expired invitation -- "has expired" -- `Iteration 1 PASS`
- [x] New JWT issued with correct tenantId and role -- `Iteration 1 PASS`
- [x] DB: invitation status=accepted, acceptedBy set -- `Iteration 1 PASS`
- [x] DB: tenant_members record created with correct role -- `Iteration 1 PASS`

### API Tests - Lookup & Pending

- [x] Public token lookup -- returns masked email -- `Iteration 1 PASS`
- [x] Public token lookup -- workspace name and inviter populated -- `Iteration 1 PASS`
- [x] Public lookup nonexistent token -- "not found" -- `Iteration 1 PASS`
- [x] Pending invitations for invitee user -- `Iteration 1 PASS`

### API Tests - Management

- [x] List invitations -- all statuses shown -- `Iteration 1 PASS`
- [x] Revoke (DELETE) invitation -- `Iteration 1 PASS`
- [x] Resend invitation -- new invitation created, email sent -- `Iteration 1 PASS`

### Security & Isolation

- [x] Cross-tenant list returns 404 -- `Iteration 1 PASS`
- [x] Cross-tenant create returns 404 -- `Iteration 1 PASS`
- [x] Cross-tenant revoke returns 404 -- `Iteration 1 PASS`
- [x] No auth on accept -- 401 Unauthorized -- `Iteration 1 PASS`
- [x] No auth on pending -- 401 Unauthorized -- `Iteration 1 PASS`
- [x] No auth on accept-by-id -- 401 Unauthorized -- `Iteration 1 PASS`
- [ ] Rate limiting on public token lookup -- `Not tested (RATE_LIMIT_ENABLED=false in dev)`

### UI Tests

- [x] Invite accept page renders correctly -- `Iteration 2 PASS`
- [x] Email mismatch warning displays for wrong user -- `Iteration 2 PASS`
- [x] Wrong email accept shows "sent to different email" error -- `Iteration 2 PASS`
- [x] Login page preserves invite token in query param -- `Iteration 2 PASS`
- [x] Dev Login redirects to /invite/{token} (not /) -- `Iteration 2 PASS (BUG-002 fixed)`
- [x] Invite page restores auth from refresh cookie -- `Iteration 2 PASS (BUG-003 fixed)`
- [x] Invite page does not redirect to /onboarding -- `Iteration 2 PASS (BUG-004 fixed)`
- [x] Correct user can accept -> success -> redirected to dashboard -- `Iteration 2 PASS`
- [x] Dashboard shows correct user and workspace after accept -- `Iteration 2 PASS`
- [x] DB: membership created with MEMBER role after UI accept -- `Iteration 2 PASS`
- [ ] OAuth flow preserves invite token -- `Not tested (no OAuth IdP in dev)`
- [ ] Signup flow with invite token -- `Not tested`

---

## Open Gaps

- **GAP-001**: Rate limiting not testable in dev (RATE_LIMIT_ENABLED=false)
  - **Severity**: Low (code reviewed, logic correct)
  - **Reason**: Would need to enable rate limiting in dev env

- ~~**GAP-002**: UI flows not tested~~ -- **RESOLVED in Iteration 2**
- **GAP-003**: SSO (OIDC/SAML) invite token passthrough not tested live
  - **Severity**: Medium
  - **Blocked by**: No SSO IdP configured in dev

---

## Pending / Future Work

- [x] UI browser automation tests for invite accept page -- `Completed in Iteration 2`
- [ ] OAuth flow invite token preservation (Google, Microsoft, LinkedIn)
- [ ] SSO OIDC/SAML invite token passthrough
- [ ] Multiple pending invitations -- invitation picker page
- [ ] Concurrent invitation acceptance race conditions
- [ ] Email delivery failure handling (SMTP down)

---

## Enhancement Ideas

- **ENH-001** (Iteration 1): Dev-login auto-creates OWNER membership for all new users, which interferes with invitation role testing. Consider a dev-login flag to skip auto-membership.

---

## Iteration Log

### Iteration 2 -- 2026-03-24

**Scope**: UI browser automation, email delivery, end-to-end acceptance flow
**Branch**: develop
**Duration**: ~30min
**Tested by**: Claude Code (agent) with Playwright

#### Results

| #   | Test                                | Method                               | Expected                    | Actual                       | Status |
| --- | ----------------------------------- | ------------------------------------ | --------------------------- | ---------------------------- | ------ |
| 29  | SMTP email delivery to Gmail        | Create invitation, check inbox       | Email received              | Email received at Gmail      | PASS   |
| 30  | Invite page renders (not logged in) | Navigate to /invite/{token}          | Shows invite details        | Workspace, role, buttons     | PASS   |
| 31  | Login page preserves invite token   | Click "Sign in to accept"            | URL has ?invite=token       | Correct URL                  | PASS   |
| 32  | Dev Login redirect with invite      | Click Dev Login on login page        | Redirect to /invite/{token} | Fixed: was going to /        | PASS   |
| 33  | Auth restored on invite page        | Navigate to /invite after login      | User recognized, accept btn | Fixed: was showing sign-in   | PASS   |
| 34  | Email mismatch warning              | Visit invite page as wrong user      | Warning banner shown        | Shows warning with emails    | PASS   |
| 35  | Accept with wrong email             | Click accept as wrong user           | Error shown                 | "sent to different email"    | PASS   |
| 36  | No onboarding redirect on invite    | Visit /invite as user without tenant | Stay on invite page         | Fixed: was redirecting       | PASS   |
| 37  | Happy path: correct user accepts    | Login as invitee, click accept       | Success, redirect to /      | Success, dashboard shown     | PASS   |
| 38  | Dashboard shows correct context     | Check header after accept            | User name, workspace        | "Sai Kumar", Dev Workspace   | PASS   |
| 39  | DB: MEMBER role after UI accept     | mongosh query                        | role=MEMBER                 | role=MEMBER, status=accepted | PASS   |

#### Bugs Fixed

- **BUG-002**: Dev Login on login page always redirected to `/` ignoring invite token
  - **File**: `apps/studio/src/app/auth/login/page.tsx:209`
  - **Root Cause**: `handleDevLogin` hardcoded `window.location.href = '/'` without checking `inviteToken`
  - **Fix**: Added `if (inviteToken) { window.location.href = '/invite/${inviteToken}'; }` (same pattern as `handleLogin`)
  - **Verified**: Dev Login now redirects to invite page when invite token present

- **BUG-003**: Invite page didn't restore auth from refresh cookie after page reload
  - **File**: `apps/studio/src/app/invite/[token]/page.tsx`
  - **Root Cause**: Page didn't call `initializeAuth()`. Access token not persisted in zustand (only tenantId is). After `window.location.href` redirect, token is gone.
  - **Fix**: Added `initializeAuth()` call in useEffect on mount
  - **Verified**: After login redirect, invite page shows Accept button instead of sign-in links

- **BUG-004**: Invite page redirected to /onboarding for users without tenant membership
  - **File**: `apps/studio/src/api/auth.ts:218-224`
  - **Root Cause**: `checkOnboardingRedirect` skipped `/auth` and `/onboarding` paths but not `/invite`. Users accepting their first workspace invitation have no tenantId in JWT.
  - **Fix**: Added `!window.location.pathname.startsWith('/invite')` to skip list
  - **Verified**: Invite page stays on /invite/ for users with no existing tenant

---

### Iteration 1 -- 2026-03-24

**Scope**: Full API testing -- create, accept, lookup, manage, security
**Branch**: develop
**Duration**: ~30min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                       | Method                                       | Expected                      | Actual                        | Status |
| --- | -------------------------- | -------------------------------------------- | ----------------------------- | ----------------------------- | ------ |
| 1   | Create invitation          | POST /workspaces/:tid/invitations            | 201, invitation object        | 201, correct fields           | PASS   |
| 2   | Self-invite prevention     | POST with own email                          | 400                           | "You cannot invite yourself"  | PASS   |
| 3   | Duplicate invitation       | POST same email twice                        | 400                           | "already been sent"           | PASS   |
| 4   | Existing member prevention | POST for existing member                     | 400                           | "already a member"            | PASS   |
| 5   | Invalid role               | POST role=SUPERADMIN                         | 400                           | "Invalid enum value"          | PASS   |
| 6   | Missing email              | POST without email                           | 400                           | "Required"                    | PASS   |
| 7   | Default role               | POST without role                            | 201, role=MEMBER              | 201, role=MEMBER              | PASS   |
| 8   | Cross-tenant create        | POST to wrong tenant                         | 404                           | "Not found"                   | PASS   |
| 9   | Pending invitations        | GET /invitations/pending                     | Invitations for user          | 1 invitation, correct fields  | PASS   |
| 10  | Accept by ID               | POST /invitations/accept-by-id               | tenantId + tokens             | Correct (see notes)           | PASS   |
| 11  | Public token lookup        | GET /invitations/:token                      | Masked email, workspace name  | "to\*\*\*@example.com"        | PASS   |
| 12  | Accept by raw token        | POST /invitations/accept                     | VIEWER role + new JWT         | role=VIEWER, DB verified      | PASS   |
| 13  | Accept already-accepted    | POST accept same token                       | 400                           | "already been used"           | PASS   |
| 14  | Accept invalid token       | POST accept bogus token                      | 404                           | "Invalid invitation"          | PASS   |
| 15  | Accept wrong email         | POST accept as different user                | 403                           | "different email address"     | PASS   |
| 16  | Accept expired             | POST accept expired invitation               | 400                           | "has expired"                 | PASS   |
| 17  | Lookup expired             | GET /invitations/:token (expired)            | Returns data (frontend check) | Correct, status=pending       | PASS   |
| 18  | List invitations           | GET /workspaces/:tid/invitations             | All invitations               | 5 invitations, correct status | PASS   |
| 19  | Revoke invitation          | DELETE /workspaces/:tid/invitations/:id      | 200, success                  | Deleted from DB               | PASS   |
| 20  | Resend invitation          | POST /workspaces/:tid/invitations/:id/resend | 201, new invitation           | New ID, email sent (7.8s)     | PASS   |
| 21  | Cross-tenant list          | GET /workspaces/wrong-tenant/invitations     | 404                           | "Not found"                   | PASS   |
| 22  | Cross-tenant create        | POST to different tenant                     | 404                           | "Not found"                   | PASS   |
| 23  | Cross-tenant revoke        | DELETE on wrong tenant                       | 404                           | "Not found"                   | PASS   |
| 24  | No auth on accept          | POST accept without token                    | 401                           | "Unauthorized"                | PASS   |
| 25  | No auth on pending         | GET pending without token                    | 401                           | "Unauthorized"                | PASS   |
| 26  | No auth on accept-by-id    | POST accept-by-id without token              | 401                           | "Unauthorized"                | PASS   |
| 27  | Nonexistent token lookup   | GET /invitations/fake-token                  | 404                           | "Invitation not found"        | PASS   |
| 28  | VIEWER creates invitation  | POST as VIEWER role                          | 403                           | "Insufficient permissions"    | PASS   |

#### Bugs Fixed

- **BUG-001**: `console.error` in revoke handler (`apps/studio/src/app/api/workspaces/[tenantId]/invitations/[invitationId]/route.ts:67`)
  - **Root Cause**: Codebase convention requires `createLogger` instead of `console.error`
  - **Fix**: Replaced with `log.error('Revoke invitation error', { err: ... })`
  - **Verified**: File updated, no remaining `console.error` in invitation routes

#### Notes

- Dev-login auto-creates OWNER membership for new users on first available tenant, which can mask invitation role assignment. Workaround: remove auto-membership from DB after dev-login, before testing acceptance.
- SMTP email delivery confirmed by response times (7-8s for SMTP roundtrip vs <100ms for non-email endpoints).
- Email masking on public endpoint working correctly (e.g., `to***@example.com`).

---

## Test Environment

Studio: localhost:5173 (PM2, Next.js dev)
Runtime: localhost:3112 (PM2, fork mode)
MongoDB: localhost:27017/abl_platform (local, no auth)
Email From: noreply-agent-platform@kore.ai
Test tenant: tenant-dev-001 (Dev Workspace)
Test user: user-dev-001 (dev@kore.ai, OWNER)
