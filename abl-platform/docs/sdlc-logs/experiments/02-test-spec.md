# SDLC Log: Experiments — Phase 2 (Test Spec)

**Date**: 2026-03-23
**Artifact**: `docs/testing/experiments.md`
**Status**: COMPLETE

## Coverage Summary

- **Unit tests**: 5 suites, 26 test cases
- **Integration tests**: 9 scenarios (real HTTP, MongoMemoryServer, ClickHouse)
- **E2E tests**: 12 scenarios (full API lifecycle)
- **Performance tests**: 3 scenarios
- **Edge cases**: 7 documented

## Key Decisions

- E2E tests exercise real runtime HTTP API — no mocks, no direct DB access
- Integration tests use MongoMemoryServer for MongoDB and test ClickHouse instance
- Statistical method tests extend existing `experiment-results.test.ts`
- Session stickiness verified both at assignment time and across message interactions
- Guardrail auto-stop tested with seeded ClickHouse data to simulate metric breach

## Audit Findings

- Round 1: Verified all 24 FRs have at least one test coverage
- Round 2: Added EDGE-6 (ClickHouse unavailability) and EDGE-7 (concurrent start) after review
- Confirmed E2E tests follow the mandated pattern: no `vi.mock()`, no direct Mongoose model access, real Express servers
