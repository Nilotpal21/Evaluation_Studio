# SDLC Log: Circuit Breaker — Phase 2: Test Spec

**Date:** 2026-03-22
**Phase:** Test Spec
**Feature:** Circuit Breaker (#44)

## Summary

Generated test specification for circuit breaker feature. Defines 8 E2E test scenarios and 7 integration test scenarios covering all P0 and P1 functional requirements.

## Test Counts

- **E2E scenarios:** 8
  - E2E-CB-1: LLM circuit opens after threshold
  - E2E-CB-2: LLM provider fallback
  - E2E-CB-3: HTTP tool circuit opens
  - E2E-CB-4: Health API returns correct state
  - E2E-CB-5: Admin force-reset
  - E2E-CB-6: Half-open probe after timeout
  - E2E-CB-7: Half-open probe failure re-opens
  - E2E-CB-8: Tenant isolation (cross-tenant independence)
- **Integration scenarios:** 7
  - INT-CB-1: Registry wired into SessionLLMClient
  - INT-CB-2: DSL config override
  - INT-CB-3: Event system
  - INT-CB-4: Redis unavailability fallback
  - INT-CB-5: BreakerHandle getMetrics
  - INT-CB-6: TenantHealth aggregation
  - INT-CB-7: Concurrent half-open probe limiting

## Key Design Decisions

1. **E2E tests use real Express servers on random ports** with full middleware chain — no middleware mocking
2. **Only external third-party services are mocked** (LLM providers, tool endpoints) via HTTP interceptors
3. **Tenant seeding via POST endpoints** in E2E, never direct DB access
4. **Redis may be mocked with ioredis-mock** in integration tests for deterministic control, but E2E should use real Redis when available
5. **Existing unit tests in packages/circuit-breaker are sufficient** for state machine logic — no need to duplicate

## Coverage Gaps (Accepted)

- FR-CB-3 (MCP) and FR-CB-4 (SearchAI) are P1 — test scenarios deferred until implementation
- FR-CB-14 (pipeline consolidation) and FR-CB-15 (Studio UI) are P2 — out of test scope
- TraceEvent emission (FR-CB-10) verified indirectly via event listener tests rather than full trace pipeline E2E
