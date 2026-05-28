# EventStore Test Spec - SDLC Log

> **Phase**: Test Spec (Phase 2)
> **Date**: 2026-03-22
> **Feature**: eventstore

## Summary

Generated test spec with:

- 14 existing unit tests documented (all passing)
- 10 coverage gaps identified with priority ranking
- 7 E2E test scenarios (exceeds minimum 5)
- 8 integration test scenarios (exceeds minimum 5)
- 4 security test scenarios (including cross-tenant wildcard)
- 3 performance test scenarios

## Key Decisions

1. E2E tests require real ClickHouse -- cannot substitute with MemoryEventStore for realistic coverage
2. Cross-tenant wildcard test (SEC-2) prioritized as P0 to verify the HIGH-severity finding
3. Integration tests use MemoryEventStore where ClickHouse is not needed
4. All E2E tests use HTTP API only -- no direct DB access, no mocking of codebase components
5. Analytics API E2E tests should live in `apps/runtime/src/__tests__/e2e/` since they test runtime routes

## Coverage Gap Analysis

The most critical gaps are:

1. **G-1** (ClickHouse write path) and **G-6** (tenant isolation) -- these are foundational
2. **G-9** (cross-tenant wildcard) -- HIGH severity security finding
3. **G-2** (Analytics API E2E) -- validates the entire read path
4. **G-3** (trace-emitter dual-write) and **G-4** (WAL recovery) -- validates resilience guarantees
