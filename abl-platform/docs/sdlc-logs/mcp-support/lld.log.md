# SDLC Log: MCP Support -- LLD

**Phase**: LLD (Phase 4)
**Date**: 2026-03-22
**Status**: COMPLETE

---

## What Was Done

Generated the MCP Support LLD + Implementation Plan (`docs/plans/2026-03-22-mcp-support-impl-plan.md`) with 3 phased implementation plan to progress from BETA to STABLE.

### Phases Defined

1. **Phase 1: E2E Test Foundation (P0, 3-5 days)**: Build live MCP HTTP fixture server and 5 E2E tests covering live server execution, auth forwarding, SSRF rejection, and delete cascade.
2. **Phase 2: Resilience and Auth-Profile Integration (P1, 2-3 days)**: Circuit breaker E2E, auth-profile-backed configs, schema drift detection, and selective import.
3. **Phase 3: Observability and Polish (P2, 2-3 days)**: TraceStore integration, structured audit logging, and optional stale tool detection UI.

### Key Deliverables

- 9 new test files across 3 phases
- 1 shared fixture server for all E2E tests
- 14 wiring verification points
- 5 risk items with mitigations
- 7-point Definition of Done for STABLE transition

## Key Implementation Decisions

1. **Fixture server location**: Placed in `packages/compiler/src/__tests__/fixtures/` because MCP protocol implementation lives in the compiler package.
2. **E2E test location**: Placed in `apps/runtime/src/__tests__/e2e/` for tests that exercise the full runtime path, and `apps/studio/src/__tests__/` for Studio-specific tests.
3. **Phase ordering**: Phase 1 is blocking because the fixture server is a prerequisite for Phases 2 and 3. Phases 2 and 3 can run in parallel.
4. **Circuit breaker testing**: Tests should use shorter reset periods (e.g., 1-2s instead of 30s) to avoid slow test suites.
5. **No new production code in Phase 1**: Only test infrastructure and E2E tests. Phase 3 adds observability to existing production code.

## Wiring Points Identified

14 wiring verification points ensure that E2E tests exercise real integration paths rather than mocked boundaries:

- Phase 1: 7 points (fixture protocol, registry loading, provider connection, executor normalization, auth forwarding, SSRF blocking, delete cascade)
- Phase 2: 4 points (circuit breaker persistence, auth-profile resolution, schema drift detection, selective import filtering)
- Phase 3: 3 points (TraceStore emission, audit hook wiring, stale tool UI comparison)

## Risk Assessment

The highest risk is fixture server protocol compliance (R1) because implementing an MCP server from scratch could introduce bugs that cause false test failures. Mitigation is to use the official MCP SDK if available or to thoroughly unit-test the fixture server itself.

## Estimated Timeline

Total: 7-11 days. Phase 1 is the critical path (3-5 days). Phases 2 and 3 can be parallelized (2-3 days each).
