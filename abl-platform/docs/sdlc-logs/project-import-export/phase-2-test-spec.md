# Phase 2: Test Spec — project-import-export

> **Date:** 2026-03-23
> **Status:** COMPLETE

## Summary

Generated test spec with 12 E2E scenarios and 10 integration scenarios for the Project Import/Export feature. All E2E tests interact ONLY via HTTP API with real servers, real MongoDB, real Redis -- no mocks of codebase components.

## Key Findings

- **60 existing unit test files** all PASSING -- strong unit coverage already.
- **Critical gap**: The existing route test file (`project-io-routes.test.ts`) mocks ALL dependencies including DB models, the project-io package itself, and Redis. It provides zero confidence in the real middleware chain.
- **No tenant isolation E2E tests exist** -- a cross-tenant access attempt has never been tested through real auth.
- **No concurrent import E2E** with real Redis distributed locking.

## Metrics

| Metric                   | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| E2E Scenarios            | 12                                                     |
| Integration Scenarios    | 10                                                     |
| Existing Unit Test Files | 60                                                     |
| Critical Coverage Gaps   | 3 (real HTTP E2E, tenant isolation, concurrent import) |
| High Coverage Gaps       | 3 (large payload, import rollback, v1-v2 migration)    |

## Audit Findings

Self-audit performed. All E2E scenarios verified to:

- Use real Express server on random port
- NOT use vi.mock() or jest.mock()
- NOT directly access DB models
- Only interact via HTTP endpoints
- Test all content types (DSL, JSON manifests, lockfiles)

## Files Changed

- Created: `docs/testing/project-import-export.md`
- Created: `docs/sdlc-logs/project-import-export/phase-2-test-spec.md`
