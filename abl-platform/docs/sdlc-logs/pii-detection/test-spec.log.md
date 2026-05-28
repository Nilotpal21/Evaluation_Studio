# SDLC Log: PII Detection Test Spec

**Phase**: 2 - Test Spec
**Date**: 2026-03-22
**Output**: `docs/testing/pii-detection.md`

---

## Clarifying Questions & Decisions

| #   | Question                                             | Classification | Answer                                                                                                                          |
| --- | ---------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk?                          | DECIDED        | FR-2 (custom patterns) and FR-6 (output filtering) -- both have E2E gaps and involve DB + runtime integration                   |
| 2   | What is the current test coverage baseline?          | ANSWERED       | ~14 test files, ~90+ individual tests covering unit + integration. E2E gap for pattern CRUD API                                 |
| 3   | What external dependencies need mocking?             | ANSWERED       | MongoDB (mocked in unit tests via `vi.mock`), encryption service (mocked in vault tests). No external PII detection services    |
| 4   | What auth/permission combinations need E2E coverage? | INFERRED       | `pii-pattern:read` and `pii-pattern:write` permissions. Cross-tenant 404 isolation. Based on `pii-patterns.ts` route middleware |
| 5   | Are there race conditions or concurrency scenarios?  | DECIDED        | Random replacement cache is module-level global (GAP-002) but low risk. Vault is per-session so no concurrency issue            |
| 6   | What data seeding is required for E2E?               | INFERRED       | Tenant + project + user with PII permissions via standard test harness. Based on runtime test patterns                          |
| 7   | What critical user journeys need E2E?                | DECIDED        | Pattern CRUD lifecycle, cross-tenant isolation, streaming PII, custom pattern detection at runtime, invalid pattern rejection   |

---

## Test Files Verified

All test files listed in the inventory were confirmed to exist in the codebase via Glob searches:

- `packages/compiler/src/__tests__/security/` -- 6 test files (detector, vault, registry, streaming, encrypted, audit)
- `packages/compiler/src/__tests__/guardrails/providers/` -- 2 test files (builtin-pii, builtin-pii-e2e)
- `packages/compiler/src/__tests__/enterprise/` -- 1 test file (pii-guard)
- `apps/runtime/src/__tests__/` -- 6 test files (output-filter, pattern-loader, sandbox-escape, testpattern-redos, integration, session-vault)
- `packages/database/src/__tests__/` -- 1 test file (pii-audit-log)

---

## Self-Audit Checklist

- [x] Coverage matrix includes all 15 FRs from feature spec
- [x] 7 E2E scenarios documented (exceeds minimum 5)
- [x] 7 integration scenarios documented (exceeds minimum 5)
- [x] All existing test files inventoried with status
- [x] Gaps identified with severity and recommendations
- [x] E2E rules followed: real servers, no mocks, HTTP API only
- [x] How-to-run section with exact commands
