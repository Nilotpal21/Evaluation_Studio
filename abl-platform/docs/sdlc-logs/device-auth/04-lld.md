# SDLC Log: Device Auth -- Phase 4 (LLD)

**Date**: 2026-03-23
**Phase**: LLD + Implementation Plan
**Artifact**: `docs/plans/2026-03-23-device-auth-impl-plan.md`

## Summary

Generated phased implementation plan with 4 phases, 15 tasks total, clear exit criteria per phase, and a dependency graph.

## Phase Breakdown

| Phase | Name              | Tasks | Dependencies | Key Deliverables                                  |
| ----- | ----------------- | ----- | ------------ | ------------------------------------------------- |
| 1     | Hardening         | 5     | None         | TOCTOU fix, logger, rate limiter cap, test fix    |
| 2     | Audit Logging     | 2     | Phase 1      | 5 audit event types emitted                       |
| 3     | Integration Tests | 3     | Phase 1      | Auth middleware, concurrent poll, hash roundtrip  |
| 4     | E2E Tests         | 5     | Phase 1-3    | Happy path, deny, consumed, token validation, 401 |

## Key Technical Details

1. **TOCTOU fix (1.1)**: Replace separate find + update with atomic `findOneAndUpdate({ consumedAt: null })` to prevent concurrent poll race
2. **Rate limiter cap (1.3)**: Add `MAX_RATE_LIMIT_ENTRIES = 10,000` with proactive eviction before reject
3. **Test mock fix (1.4)**: Change `req.user = { sub }` to `{ id }` to match actual AuthUser interface
4. **Concurrent poll test (3.2)**: Use `Promise.allSettled` with 5 concurrent requests; assert exactly 1 gets tokens

## Gaps Targeted for Closure

| Gap     | Description                             | Phase | Task    |
| ------- | --------------------------------------- | ----- | ------- |
| GAP-003 | console.error instead of createLogger   | 1     | 1.2     |
| GAP-006 | Route test mock discrepancy (sub vs id) | 1     | 1.4     |
| GAP-007 | TOCTOU race in pollDeviceToken          | 1     | 1.1     |
| GAP-008 | Rate limiter Map no max-size            | 1     | 1.3     |
| GAP-009 | No audit logging                        | 2     | 2.1-2.2 |

## Audit Round 1 (Self-Review)

- All phases have measurable exit criteria (not just "it works")
- Task granularity is appropriate (each completable in one session)
- Dependency graph prevents out-of-order execution
- Risk register covers timing, flakiness, and behavioral changes
- Wiring checklist identifies 4 remaining integration points
