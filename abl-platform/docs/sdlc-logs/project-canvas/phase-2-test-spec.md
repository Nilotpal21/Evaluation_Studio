# SDLC Log: Project Canvas — Phase 2 (Test Spec)

> **Date**: 2026-03-22
> **Phase**: Test Spec
> **Artifact**: `docs/testing/project-canvas.md`

## Test Coverage Summary

| Category              | Count | Details                                             |
| --------------------- | ----- | --------------------------------------------------- |
| E2E scenarios         | 7     | E2E-1 through E2E-7                                 |
| Integration scenarios | 7     | INT-1 through INT-7                                 |
| Unit test suites      | 4     | UNIT-1 through UNIT-4                               |
| Edge cases documented | 7     | Error states, large projects, offline, localStorage |
| Performance criteria  | 5     | Render times, toggle speed, interaction latency     |

## Coverage Matrix

- 15/15 functional requirements covered
- 12/15 have E2E or integration coverage
- 3/15 have integration-only coverage (FR-05, FR-11, FR-14/15)
- All P0 requirements have E2E coverage

## Key Decisions

| #    | Decision                                                           | Rationale                                        |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------ |
| TD-1 | E2E tests use Playwright with real server                          | Matches existing Studio test pattern             |
| TD-2 | No vi.mock() in any E2E test                                       | Per CLAUDE.md E2E Test Standards                 |
| TD-3 | Integration tests use controlled API server, not mocked components | Real SWR, real stores, mock HTTP only            |
| TD-4 | Performance tests use Performance API marks                        | Built-in browser API, no external tooling needed |

## Audit Notes

- All 7 E2E scenarios interact via HTTP API only (no direct DB)
- No `vi.mock()` or `jest.mock()` in any E2E scenario
- Test data seeded via POST endpoints
- Real Express middleware chain in test servers
- Edge cases cover error states, large projects, offline mode, and localStorage unavailability
