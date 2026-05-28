# SDLC Log: Invitations — Test Spec

**Phase**: Test Spec (Phase 2)
**Date**: 2026-03-23
**Status**: Complete

## Oracle Decisions

All clarifying questions answered via code analysis.

### Test Scope & Priorities

- **Highest risk FRs?** ANSWERED — FR-7 (accept by token), FR-9 (membership creation), FR-10 (SSO auto-accept). These involve multiple service interactions with no transaction safety.
- **Current coverage?** ANSWERED — Mock-based unit tests only (`api-org-routes.test.ts`). No E2E or integration tests.
- **External dependencies?** DECIDED — SMTP mocked via transport layer (not vi.mock). MongoDB via MongoMemoryServer for integration, Docker for E2E.

### E2E Scenarios

- **Critical journeys?** ANSWERED — Full lifecycle (create-accept-verify), picker flow, SSO auto-accept. Code evidence: 3 acceptance paths in routes.
- **Auth combinations?** ANSWERED — OWNER, ADMIN, MEMBER, unauthenticated. Code evidence: role checks in route handlers.
- **Cross-feature?** INFERRED — SSO callbacks are cross-feature but tested at the service boundary level rather than full SSO flow.

### Integration Boundaries

- **Service boundaries?** ANSWERED — invitation-service.ts <-> workspace-repo.ts <-> MongoDB; auth-service.ts <-> invitation-service.ts (SSO).
- **Race conditions?** INFERRED — Concurrent create for same email hits unique index; concurrent accept has atomicity gap (GAP-003).
- **Isolation scenarios?** ANSWERED — Cross-tenant returns 404; email mismatch returns 403. Code evidence: explicit checks in route handlers.

## Files Created/Updated

- `docs/testing/invitations.md` — Expanded from placeholder to full test spec
- `docs/sdlc-logs/invitations/test-spec.log.md` — This log

## Audit Summary

### Round 1 — Coverage & Completeness

- 10 E2E scenarios (exceeds minimum 5)
- 8 integration scenarios (exceeds minimum 5)
- 4 unit test scenarios
- 9 security & isolation test items
- All 15 FRs appear in coverage matrix
- Test file mapping with 7 planned test files
- 4 open testing questions documented

### Round 2 — Alignment

- E2E scenarios cover all user stories from feature spec
- Integration boundaries match data flow (service -> repo -> DB)
- Highest-risk FRs (FR-7, FR-9, FR-10) covered by both E2E and integration scenarios
- Security tests cover cross-tenant (404), email mismatch (403), auth (401), permissions (403)
