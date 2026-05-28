# SDLC Log: Model Hub -- LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: Low-Level Design + Implementation Plan
**Status**: Complete

## Decision Log

| Question                          | Classification | Answer                                                                                                                                                                                                            |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation order?             | DECIDED        | Phase 1: Policy enforcement (addresses highest-severity gap GAP-005). Phase 2: Cache invalidation (operational gap GAP-011). Phase 3: Health checks (operational gap GAP-007). Phase 4: E2E tests (coverage gap). |
| Middleware vs inline enforcement? | DECIDED        | Middleware-based policy enforcement, not inline in `ModelResolutionService`. Separation of concerns: resolution finds the model, middleware enforces governance.                                                  |
| Cache invalidation mechanism?     | DECIDED        | Redis pub/sub with graceful degradation. Minimal change vs full Redis config layer (Alternative B in HLD).                                                                                                        |
| Health check approach?            | DECIDED        | BullMQ repeatable worker (integrates with existing worker infrastructure) vs external cron (operational overhead).                                                                                                |
| Feature flags?                    | DECIDED        | All new enforcement features behind flags. `ENABLE_LLM_POLICY_ENFORCEMENT` (default false), `ENABLE_HEALTH_CHECKS` (default false).                                                                               |
| New schemas needed?               | ANSWERED       | No new collections needed. All gap closure uses existing fields in existing collections. Verified against database models.                                                                                        |
| Test strategy for E2E?            | DECIDED        | Real Express server on random port, full middleware chain, HTTP API only. No `vi.mock()`, no direct DB access. LLM provider layer can be mocked as an external third-party service via dependency injection.      |

## Files Created

- `docs/plans/2026-03-22-model-hub-impl-plan.md` -- Full LLD with 4 phases, file change map, wiring checklist

## Review Summary

### Round 1 -- Architecture Compliance

- [x] All new routes use `authMiddleware` and `tenantRateLimit`
- [x] Policy enforcement uses `tenantIsolationPlugin`-backed queries
- [x] No direct `findById` usage -- all queries include tenant/project scope
- [x] Cross-scope access returns 404 (not 403)
- [x] Feature flags provide rollback safety

### Round 2 -- Pattern Consistency

- [x] Routes follow existing pattern (OpenAPI router, Zod validation, standard error envelope)
- [x] Worker follows existing BullMQ worker pattern
- [x] Cache invalidation follows existing Redis pub/sub patterns
- [x] Tests follow existing test file naming and structure

### Round 3 -- Completeness

- [x] Every FR covered by at least one implementation task
- [x] File paths are exact (verified against codebase structure)
- [x] All signatures reference real types from the codebase
- [x] Exit criteria are measurable (specific test commands, build commands)

### Round 4 -- Cross-Phase Consistency

- [x] LLD implements HLD recommendations (policy middleware, Redis pub/sub, health check worker)
- [x] E2E test scenarios match test spec (E2E-1, E2E-2, E2E-4, E2E-5, E2E-7)
- [x] Gap closure targets match feature spec (GAP-005, GAP-007, GAP-011)

### Round 5 -- Final Sweep

- [x] Wiring checklist covers all new files and integrations
- [x] No task requires more than one session to complete
- [x] Each phase is independently deployable and testable
- [x] Rollback strategy defined for each phase
- [x] No TODO stubs -- all tasks have specific deliverables
