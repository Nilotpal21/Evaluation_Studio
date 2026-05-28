# Feature Test Guide: Platform Access Control

**Feature**: Invitation bypass + email-level allowlisting for platform access control
**Owner**: Platform Engineering
**Branch**: ABLP-1145-platform-access-requests-fix
**First tested**: 2026-05-21
**Last updated**: 2026-05-21
**Overall status**: IN PROGRESS

---

## Current State (as of 2026-05-21)

Implementation complete across all 9 auth routes, JWT claim chain, auth store, admin API, and admin UI. Build passes. 17 integration tests at the DB policy layer are passing. No E2E tests have been written yet — all E2E coverage is planned and required before BETA promotion.

### Quick Health Dashboard

| Area                                           | Status | Last Verified  | Notes                        |
| ---------------------------------------------- | ------ | -------------- | ---------------------------- |
| DB policy functions (email CRUD, invite check) | PASS   | 2026-05-21     | 17 integration tests passing |
| isEmailAllowedForAuth invite bypass            | PASS   | 2026-05-21     | Integration tests            |
| canUserCreateWorkspace                         | PASS   | 2026-05-21     | Integration tests            |
| JWT canCreateWorkspace claim                   | —      | Not E2E tested | Build verified               |
| /me route canCreateWorkspace                   | —      | Not E2E tested | Build verified               |
| create-workspace 403 gate                      | —      | Not E2E tested | Build verified               |
| inviteToken in email/password routes           | —      | Not E2E tested | Build verified               |
| inviteToken in OAuth callbacks                 | —      | Not E2E tested | Build verified               |
| inviteToken in OIDC/SAML callbacks             | —      | Not E2E tested | Build verified               |
| Admin emails API (GET/POST/DELETE)             | —      | Not E2E tested | Build verified               |
| Admin UI Allowed Emails panel                  | —      | Not UI tested  | Build verified               |
| UI gate (UserMenu, onboarding, invitations)    | —      | Not UI tested  | Build verified               |

---

## Test Coverage Map

### Integration Tests (DB layer) — `packages/database/src/__tests__/platform-access-policy-email.test.ts`

- [x] addAllowedEmail stores normalized email → isAllowlistedEmail finds it — `2026-05-21 PASS`
- [x] addAllowedEmail rejects invalid email — `2026-05-21 PASS`
- [x] revokeAllowedEmail removes access — `2026-05-21 PASS`
- [x] revokeAllowedEmail returns false for unknown email — `2026-05-21 PASS`
- [x] listAllowedEmails returns only active entries — `2026-05-21 PASS`
- [x] hasValidInvitationForEmail — valid pending invite → true — `2026-05-21 PASS`
- [x] hasValidInvitationForEmail — wrong token → false — `2026-05-21 PASS`
- [x] hasValidInvitationForEmail — expired invite → false — `2026-05-21 PASS`
- [x] hasValidInvitationForEmail — wrong email → false — `2026-05-21 PASS`
- [x] isEmailAllowedForAuth — domain-allowed email (no invite) → true — `2026-05-21 PASS`
- [x] isEmailAllowedForAuth — allowlisted individual email → true — `2026-05-21 PASS`
- [x] isEmailAllowedForAuth — non-allowed domain, no invite → false — `2026-05-21 PASS`
- [x] isEmailAllowedForAuth — non-allowed domain + valid invite → true — `2026-05-21 PASS`
- [x] isEmailAllowedForAuth — non-allowed domain + expired invite → false — `2026-05-21 PASS`
- [x] canUserCreateWorkspace — domain-allowlisted → true — `2026-05-21 PASS`
- [x] canUserCreateWorkspace — email-allowlisted → true — `2026-05-21 PASS`
- [x] canUserCreateWorkspace — invited-only (no domain/email) → false — `2026-05-21 PASS`

### E2E Tests (HTTP API) — Not yet written

- [ ] Invited user (non-allowlisted domain) can signup via email/password with valid inviteToken
- [ ] Invited user can login via email/password with valid inviteToken
- [ ] Invited user via Google OAuth can authenticate
- [ ] Invited user via OIDC/SAML can authenticate
- [ ] Invited user cannot call POST /api/auth/create-workspace (403)
- [ ] Invited user's JWT contains canCreateWorkspace: false
- [ ] Allowlisted email user can signup without invite
- [ ] Allowlisted email user can call POST /api/auth/create-workspace (200)
- [ ] Admin: POST /api/access/emails adds email to allowlist
- [ ] Admin: GET /api/access/emails returns allowedEmails array
- [ ] Admin: DELETE /api/access/emails removes email from allowlist
- [ ] Expired invite token → 403 on signup
- [ ] After domain added to allowlist, previously invited-only user gets canCreateWorkspace: true on next login

### UI Tests — Not yet written

- [ ] UserMenu does not show "Create workspace" when canCreateWorkspace=false
- [ ] Onboarding page shows restricted message when canCreateWorkspace=false
- [ ] invitations/choose page hides create-workspace links when canCreateWorkspace=false
- [ ] Admin Allowed Emails panel renders, add/remove work

---

## Open Gaps

- **GAP-001**: No E2E test suite for invitation bypass flows
  - **Severity**: HIGH
  - **Required for**: BETA promotion

- **GAP-002**: No E2E test for workspace creation 403 enforcement
  - **Severity**: HIGH
  - **Required for**: BETA promotion

- **GAP-003**: No E2E test for admin email allowlist API
  - **Severity**: MEDIUM

- **GAP-004**: No UI tests for restricted states (UserMenu, onboarding, invitations/choose)
  - **Severity**: MEDIUM

---

## Iteration Log

### Iteration 1 — 2026-05-21

**Scope**: Full implementation (DB model, policy functions, JWT claim, auth store, auth routes, OAuth callbacks, admin API, admin UI)
**Branch**: ABLP-1145-platform-access-requests-fix
**Duration**: ~1 session (subagent-driven development)
**Tested by**: Claude Code (agent)

#### Results

| #    | Test                        | Method                     | Expected | Actual     | Status |
| ---- | --------------------------- | -------------------------- | -------- | ---------- | ------ |
| 1-17 | DB policy integration tests | vitest + MongoMemoryServer | 17 pass  | 17/17 pass | PASS   |

#### Bugs Fixed During Implementation

- **BUG-001**: `switchTenant` in auth-service.ts did not propagate `canCreateWorkspace`
  - **Fix**: Added `canCreate = isSuperAdmin || canUserCreateWorkspace(user.email)` in `switchTenant`
  - **Commit**: `77f1ae5bb5`

- **BUG-002**: New DB policy functions not re-exported from `packages/database/src/index.ts`
  - **Fix**: Added 6 new exports to package index
  - **Commit**: `98b68999e0`

- **BUG-003**: OIDC and SAML callbacks missing inviteToken threading
  - **Fix**: Moved `oauth_invite` cookie read before `isEmailAllowedForAuth` in both files
  - **Commit**: `819eb32b3f`

---

## Test Environment

Runtime: localhost:3112 (PM2)
Studio: localhost:5173 (PM2, turbopack + LIGHT_DEV=1)
Admin: localhost:3003 (PM2, webpack)
MongoDB: localhost:27017/abl_platform (local)
