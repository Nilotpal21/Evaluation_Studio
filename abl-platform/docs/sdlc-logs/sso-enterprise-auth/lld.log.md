# SDLC Log: SSO Enterprise Auth -- LLD

**Phase**: 4 (Low-Level Design + Implementation Plan)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                         | Classification | Resolution                                                                                                                         |
| --- | -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Implementation order preference? | DECIDED        | Routes first (Phase 1), then security hardening (Phase 2), then polish (Phase 3), then tests (Phase 4-5), then force-SSO (Phase 6) |
| 2   | Which JWKS library to use?       | DECIDED        | `jose` (lighter than `openid-client`, handles JWKS caching, widely used)                                                           |
| 3   | Where to put JWKS verifier?      | DECIDED        | `apps/studio/src/services/sso/jwks-verifier.ts` (SSO concern, not shared-auth)                                                     |
| 4   | Database migration needed?       | ANSWERED       | No. Existing Organization model already has ssoConfigs/domainMappings schemas                                                      |
| 5   | Feature flags needed?            | DECIDED        | No. SSO is opt-in per org config. Force-SSO is opt-in per org setting                                                              |
| 6   | Test database strategy?          | DECIDED        | MongoMemoryServer for CI, Docker MongoDB for local dev                                                                             |

## Files Created

- `docs/plans/2026-03-22-sso-enterprise-auth-impl-plan.md` -- LLD with 6 phases, exit criteria, wiring checklist
- `docs/sdlc-logs/sso-enterprise-auth/lld.log.md` -- This log

## Phases Summary

| Phase | Name                          | Key Deliverables                                          | Risk   |
| ----- | ----------------------------- | --------------------------------------------------------- | ------ |
| 1     | Missing Route Implementations | 8 new route handlers (exchange, config CRUD, domain CRUD) | Low    |
| 2     | OIDC JWKS Verification        | Close GAP-001 with proper ID token signature verification | Medium |
| 3     | Logging Standardization       | Fix GAP-003/GAP-006, add Map size guards                  | Low    |
| 4     | Unit Tests                    | 4 test files covering PKCE, SSRF, MFA, encryption         | Low    |
| 5     | Integration Tests             | 4 test files covering state store, domain, MFA, auth code | Medium |
| 6     | Force-SSO + Admin             | Force-SSO login enforcement, admin portal SSO status      | Medium |

## Review Summary

Round 1 -- Architecture compliance:

- All routes use existing repo layer (org-repo, auth-repo, mfa-repo) -- no direct DB access
- Auth middleware via Next.js route-level checks -- consistent with existing patterns
- Encryption via EncryptionService -- consistent with MFA secret storage
- Logging via createLogger -- platform standard

Round 2 -- Pattern consistency:

- Route handlers follow existing Next.js API route patterns (GET/POST/PUT/DELETE exports)
- Service layer follows existing SSO service patterns (sso-types, sso-state-store)
- Test file naming follows existing convention (`__tests__/unit/`, `__tests__/integration/`)

Round 3 -- Completeness:

- Every FR from feature spec maps to at least one phase task
- File paths verified against actual codebase structure
- Wiring checklist covers all new modules and imports

Round 4 -- Cross-phase consistency:

- LLD implements all HLD concerns
- Test strategy matches test spec scenarios
- Phase dependencies are linear (no circular)

Round 5 -- Final sweep:

- Each phase is independently deployable
- Rollback strategies defined for each phase
- Exit criteria are measurable (not "it works")
- All tasks completable in one session
