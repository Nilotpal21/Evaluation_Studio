# Post-Implementation Sync Log: ABLP-1145

**Feature**: Platform Access Control — Invitation Bypass & Email Allowlisting
**Date**: 2026-05-21
**Branch**: ABLP-1145-platform-access-requests-fix
**Commits**: 14 (48b10ae..819eb32)

## Documents Updated

- Created: `docs/features/platform-access-control.md` — feature spec (ALPHA)
- Created: `docs/testing/platform-access-control.md` — test spec (IN PROGRESS)
- Updated: `docs/testing/README.md` — added ABLP-1145 entry
- Updated: `docs/superpowers/specs/2026-05-20-platform-access-control-design.md` — status IMPLEMENTED
- Updated: `docs/superpowers/plans/2026-05-20-platform-access-control.md` — all tasks marked complete

## Coverage Delta

| Type                          | Before | After |
| ----------------------------- | ------ | ----- |
| Unit tests                    | 0      | 0     |
| Integration tests (DB policy) | 0      | 17    |
| E2E tests                     | 0      | 0     |

## Deviations from Plan

1. **`switchTenant` gap**: Plan did not cover `switchTenant` in auth-service.ts — discovered during review that it also creates tokens but didn't compute `canCreateWorkspace`. Fixed in commit `77f1ae5`.

2. **Package index re-exports**: Plan did not explicitly include updating `packages/database/src/index.ts`. Caught during spec compliance review and fixed.

3. **OIDC/SAML callbacks**: Plan's Task 7 only covered Google/Microsoft/LinkedIn. Final code review found OIDC and SAML callbacks also needed `inviteToken` threading. Fixed in commit `819eb32`.

4. **`audit-logger.ts` update**: Plan did not mention updating admin audit logger with new action types. Implementer proactively added `platform_email_allow` and `platform_email_revoke` action types.

## Remaining Gaps

- GAP-001: No E2E tests for invitation bypass flows (HIGH — required for BETA)
- GAP-002: No E2E test for workspace creation 403 (HIGH — required for BETA)
- GAP-003: No E2E test for admin email allowlist API (MEDIUM)
- GAP-004: No UI tests for restricted states (MEDIUM)
