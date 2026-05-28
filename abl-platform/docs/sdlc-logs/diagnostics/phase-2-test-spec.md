# SDLC Log: Diagnostics -- Phase 2 (Test Spec)

> **Date:** 2026-03-22
> **Phase:** Test Spec
> **Artifact:** `docs/testing/diagnostics.md`

## Test Coverage Summary

- **7 E2E scenarios** (E2E-1 through E2E-7)
- **8 integration scenarios** (INT-1 through INT-8)
- **3 NFR test scenarios**
- **12/20 FRs covered** by E2E or integration tests
- **8 FRs deferred** to P2/UI/ClickHouse phases

## Key Design Decisions

| Decision                                | Rationale                                          |
| --------------------------------------- | -------------------------------------------------- |
| MongoMemoryServer for integration tests | Avoids external dependency, fast startup           |
| Real Redis for scheduling E2E           | BullMQ requires real Redis for repeatable jobs     |
| Express on port 0                       | Random port avoids conflicts in parallel test runs |
| No mocking of codebase components       | CLAUDE.md mandate: E2E tests exercise real system  |
| Webhook mock via local HTTP server      | Only external endpoints mocked, not codebase       |

## Coverage Gaps (Intentional Deferrals)

| FR                           | Why Deferred                                               |
| ---------------------------- | ---------------------------------------------------------- |
| FR-10 (Conversation Quality) | Requires ClickHouse integration; deferred to Phase 2 impl  |
| FR-13 (retry_connection)     | P2 priority; test when implemented                         |
| FR-14 (clear_cache)          | P2 priority; test when implemented                         |
| FR-15-17 (Studio/Admin UI)   | UI tests require separate test infrastructure (Playwright) |
| FR-19 (MCP tools)            | MCP tool tests have separate test harness                  |

## Audit Notes

- All E2E tests interact only via HTTP API
- No vi.mock() or jest.mock() in any scenario
- Tenant isolation verified in E2E-1, E2E-7, and NFR-3
- Auth middleware exercised in every E2E scenario
- SSRF protection explicitly tested in INT-7
