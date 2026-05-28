# SDLC Log: Platform Admin -- Phase 4 (LLD)

- **Date:** 2026-03-22
- **Feature:** platform-admin (#41)
- **Phase:** Low-Level Design / Implementation Plan
- **Artifact:** `docs/plans/2026-03-22-platform-admin-impl-plan.md`

## Summary

Generated phased implementation plan with 7 phases, explicit exit criteria, dependency graph, wiring checklist, and risk mitigation.

## Phase Breakdown

| Phase | Name                           | Priority | Duration | Key Deliverables                                  |
| ----- | ------------------------------ | -------- | -------- | ------------------------------------------------- |
| 1     | Security Hardening             | P0       | 2-3 days | JWT verify, rate limiting, CSRF, path traversal   |
| 2     | Structured Logging             | P1       | 1-2 days | createLogger migration, zero console.log          |
| 3     | E2E Test Infrastructure        | P0       | 3-4 days | 25+ real HTTP E2E tests, test server, JWT factory |
| 4     | Error Handling Standardization | P1       | 1-2 days | Error envelope, proxy helpers                     |
| 5     | Audit Logging Enhancement      | P1       | 1-2 days | 22 action types, audit on all routes              |
| 6     | User Management Page           | P2       | 2-3 days | User list, detail, role management                |
| 7     | Documentation Sync             | P2       | 0.5 day  | Feature spec, test spec, README updates           |

**Total estimated: 11-17 days**

## Key Findings

1. **JWT not verified** -- `decodeJwt()` used instead of `jwtVerify()`, allowing forged tokens
2. **No rate limiting** on any endpoint, including authentication
3. **No CSRF protection** beyond sameSite cookies
4. **Existing E2E tests mock fetch** -- need complete rewrite with real HTTP
5. **Only 2 audit actions defined** -- need 22 for complete coverage
6. **Error responses inconsistent** -- mix of `{ error }` and `{ success, error }`

## Wiring Checklist Items

- 7 items for new API routes
- 6 items for new dashboard pages
- 4 items for new shared modules

## Dependencies Identified

- `createLogger` from `@abl/compiler/platform` -- must verify import path works in admin app
- Runtime API endpoints for user management -- may need to be created in Runtime first
- Test infrastructure -- Next.js test server setup is non-trivial
