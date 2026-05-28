# Post-Implementation Sync Log: Model Hub

**Date**: 2026-03-27
**Branch**: `feature/model-hub-auth-profile-gap-closure`
**Commits**: 33 commits ahead of `develop`

---

## Documents Updated

- `docs/features/model-hub.md` — Added `provider-cache.ts` to implementation files, `provider-cache-eviction.test.ts` to test table, fixed `FEATURE_HEALTH_CHECK_INTERVAL_HOURS` default (1 → 4)
- `docs/testing/model-hub.md` — Updated E2E coverage columns for FR-2/FR-4/FR-5 to Y, added `provider-cache-eviction.test.ts` to test file mapping
- `docs/plans/2026-03-22-model-hub-impl-plan.md` — Updated wiring checklist with actual status, added §8 Post-Implementation Notes documenting 6 plan deviations and phase completion status

## Coverage Delta

| Type              | Before (pre-branch)                        | After                                                                                                 |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Unit tests        | model-registry, session-llm-client-timeout | +budget-enforcement (17), +cache-invalidation (13), +health-service (6), +provider-cache-eviction (4) |
| Integration tests | 14 files covering FR-1 through FR-10       | Same 14 files (no new integration tests added)                                                        |
| E2E tests         | 0 model-hub E2E tests                      | +provisioning (7), +isolation (5), +overrides (5) = 17 E2E tests                                      |

## New Implementation Files

| File                          | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `budget-enforcement.ts`       | In-memory daily/monthly token budget enforcement with pre-debit/post-call correction |
| `model-cache-invalidation.ts` | Extended with ModelInvalidationTransport pub/sub + HMAC-SHA256 signing               |
| `model-health-service.ts`     | Extracted health check logic + setInterval periodic job                              |
| `provider-cache.ts`           | Dependency-free provider instance cache (extracted from session-llm-client.ts)       |

## Deviations from Plan

1. Health checks use `setInterval` instead of BullMQ repeatable worker (matches codebase pattern)
2. Budget enforcement is inline in `ModelResolutionService.resolve()`, not middleware-based
3. LLM usage routes dropped — 3 already existed with ClickHouse views
4. Provider cache extracted to `provider-cache.ts` for zero-mock testability
5. E2E test files placed in `__tests__/` top-level, not `__tests__/e2e/` subdirectory
6. Feature flag names use `FEATURE_ENABLE_*` prefix pattern

## Remaining Gaps

- Full browser/admin provisioning E2E across all provider variants (GAP-001)
- Cost/token alerting automation (GAP-003)
- Model deprecation migration tooling (GAP-006)
- On-premise LiteLLM proxy SSRF allowlists (GAP-008)
- Budget drift correction integration test (GAP-013)
