# Test Spec Log: workspace-sharing

**Phase**: 2 — Test Spec
**Date**: 2026-03-23
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                         | Classification | Answer                                                                                                                                                                                                               |
| --- | -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What are the highest-risk FRs?   | INFERRED       | FR-3 (role hierarchy) and FR-4 (invitation acceptance) are highest risk — privilege escalation and authentication boundary. Based on existing GAP-001 (token inconsistency) and GAP-003 (untested token acceptance). |
| 2   | What external deps need mocking? | DECIDED        | Only the email service needs mocking (external SMTP). MongoDB is tested with MongoMemoryServer. JWT signing uses test secrets.                                                                                       |
| 3   | Current test coverage baseline?  | ANSWERED       | `api-org-routes.test.ts` and `auth-services.test.ts` exist. No true E2E tests against running servers. `workspace-admin-pages.e2e.test.ts` mocks global fetch (not real E2E).                                        |
| 4   | Test environment setup?          | INFERRED       | MongoMemoryServer for integration. Express/Next on random ports for E2E. Based on existing patterns in other test files in the repo.                                                                                 |
| 5   | Cross-feature interactions?      | ANSWERED       | Auth service (JWT issuance), audit logging, email service. No runtime/channel interactions.                                                                                                                          |

## Files Created

- `docs/testing/workspace-sharing.md` — Test spec with coverage matrix, 7 E2E scenarios, 6 integration scenarios
- `docs/sdlc-logs/workspace-sharing/test-spec.log.md` — This log

## Review Findings

### Round 1 — Coverage & Completeness

- 7 E2E scenarios (exceeds minimum 5)
- 6 integration scenarios (exceeds minimum 5)
- All 10 FRs appear in coverage matrix
- E2E scenarios specify auth context
- E2E scenarios do NOT reference mocks or direct DB access
- Integration scenarios specify service boundaries
- Security & isolation section filled with specific checks
- Test file mapping has planned paths

### Round 2 — Alignment

- E2E-1 covers the critical invitation lifecycle (user story 1, 4, 5)
- E2E-2 covers role hierarchy (user story 2, FR-3)
- E2E-3 covers tenant isolation (non-functional concern)
- E2E-4 covers workspace switching (user story 3, FR-5)
- E2E-5 covers token acceptance (FR-4, FR-7, GAP-003)
- E2E-6 covers expiry (FR-10, GAP-003)
- E2E-7 covers revocation and re-invitation (FR-2)
- Integration boundaries match data flow: service -> repo -> MongoDB
