# Post-Implementation Sync Log: redis-dual-mode

**Feature**: Redis Dual-Mode Support (Standalone + Cluster)
**Phase**: POST-IMPL-SYNC
**Date**: 2026-05-05
**PR**: #885 (`worktree-redis-cluster-dual-mode` → `develop`)
**Commits**: 36

---

## Documents Updated

- [x] Feature spec: `docs/features/redis-dual-mode.md` — Status PLANNED → ALPHA; GAP-003/004/005/008 → Mitigated; §17 testing table updated with actual ✅/❌; §10 test files updated; Last Updated 2026-05-05
- [x] Test spec: `docs/testing/redis-dual-mode.md` — Status PLANNED → IN PROGRESS; LLD ref updated; coverage matrix ✅/❌ corrected; test file mapping with EXISTS/MISSING columns; iteration log added
- [x] Testing index: `docs/testing/README.md` — Row 102 status PLANNED → IN PROGRESS with accurate test counts
- [x] HLD: `docs/specs/redis-dual-mode.hld.md` — Status DRAFT → APPROVED; Post-Implementation Notes section added with 7 design deviations and 4 resolved open questions
- [x] LLD: `docs/plans/2026-05-04-redis-dual-mode-impl-plan.md` — Status DRAFT → IN PROGRESS (Phases 0-4 DONE; Phase 5 PENDING)
- [x] Post-impl-sync log: `docs/sdlc-logs/redis-dual-mode/post-impl-sync.log.md` (this file)
- [x] Package learnings: `packages/redis/agents.md` (NEW), `packages/circuit-breaker/agents.md` (NEW), `packages/agent-transfer/agents.md` (appended), `packages/execution/agents.md` (appended)

## Coverage Delta

| Type                           | Before (PLANNED) | After (ALPHA)                                                                         |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| Unit tests (redis package)     | 33               | 47+                                                                                   |
| Unit tests (bullmq watchdog)   | 0                | 5 (+ 17 BullMQ pair = 22 total)                                                       |
| Cluster integration test files | 0                | 5 files                                                                               |
| Static migration guards        | 0                | 2 (INT-13 no .duplicate(), INT-14 no KEYS)                                            |
| Test infrastructure            | 0                | docker-compose.cluster.yml + tools/cluster-test-harness.ts + vitest.cluster.config.ts |
| E2E cluster tests              | 0                | 0 (pending)                                                                           |
| Chaos / failover benchmarks    | 0                | 2 coded (benchmarks/integration/ + benchmarks/system/); execution requires SIT        |

## Remaining Gaps

- **E2E test files** (8 planned, 0 written): All E2E cluster test files still MISSING. Requires Studio + Runtime test harness extension against a real 6-node cluster.
- **INT-3** (createBullMQPair failover survival): Partially covered by watchdog unit tests; full cluster failover integration test pending.
- **INT-10** (Lua BUSY timeout), **INT-11** (session resolve race), **INT-12** (scanKeys chaos): Pending.
- **Phase 5** (production rollout): Tier-M/L/XL helm flip is an operator action after SIT validation.
- **CI wiring**: No `.bitbucket-pipelines.yml` in repo; nightly `pnpm test:cluster` must be wired by SRE.

## Deviations from Plan

| #   | Deviation                                                                                                         | Impact                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Agent-transfer session-key shape unchanged (no hash tags on keys)                                                 | Positive — ~20 test fixtures preserved; cluster-safety achieved at Lua-boundary level instead |
| 2   | Provider-index key un-tagged; cross-slot writes pipelined outside Lua                                             | Acceptable — eventual consistency for advisory indexes; documented in FR-9 and HLD §12        |
| 3   | `getRedisClient()` return type kept at `any \| null`; new `getRedisHandle()` added                                | Avoids cascading ~20 type breaks in unrelated callers                                         |
| 4   | `message-persistence-queue.ts` + `channel-queues.ts` use `handle.duplicate()` instead of `createBullMQPair`       | Deferred — Queue-only paths where eager pairing wastes a connection                           |
| 5   | `trigger-scheduler.ts` / `callback-delivery-worker.ts` have backward-compat `Redis \| RedisConnectionHandle` shim | Cluster callers pass handle and take `createBullMQPair` path; standalone fallback is safe     |
| 6   | `subscriber.ts` uses ioredis auto-reconnect instead of custom loop                                                | Correct — custom backoff would race with ioredis internals                                    |
| 7   | GAP-008 watchdog scaffolded in Phase 0; OTel counter wired in Phase 4                                             | Clean separation; watchdog logic in `bullmq.ts`, counter in `observability.ts`                |

## Auditor Verdict

APPROVED (1 round, no CRITICAL findings). HIGH findings resolved before commit. MEDIUM findings resolved (agents.md created, FR-11 coverage claim corrected, GAP-008 phase attribution corrected).

---

## Sync Round 2 — 2026-05-06 (Cluster E2E Test Suite Authored)

**Trigger**: 5 cluster E2E/integration test files committed (`session-redis.cluster.e2e.test.ts`, `scan-keys.cluster.e2e.test.ts`, `session-resolve-race.cluster.test.ts`, `scan-keys-failover.chaos.cluster.test.ts`, `trigger-roundtrip.cluster.e2e.test.ts`) and pushed to `origin/worktree-redis-cluster-dual-mode` (PR #885).

### Documents Updated

- [x] Feature spec `docs/features/redis-dual-mode.md`:
  - §17 row 10: `NOT TESTED ❌` → `TESTED ✅` (19 tests, cluster-layer)
  - §17 row 2 + GAP-008: corrected bullmq count to 21 (6 watchdog + 15 pair)
  - Last Updated: 2026-05-05 → 2026-05-06
- [x] Test spec `docs/testing/redis-dual-mode.md`:
  - File mapping: 5 new rows marked EXISTS (previously MISSING)
  - Bullmq count corrected to 21 (6 watchdog + 15 pair)
  - Iteration log 2026-05-06: added E2E-1 cluster-layer deviation
- [x] Testing index `docs/testing/README.md`:
  - Row 102: INT column (7 INT + 1 chaos + 2 static + 21 unit), E2E column (3 authored + 3 deferred), status updated to 05-06

### Coverage Delta (Round 2)

| Type                         | Before    | After                                            |
| ---------------------------- | --------- | ------------------------------------------------ |
| Unit tests (bullmq watchdog) | 5 (stale) | 6 watchdog (corrected count)                     |
| E2E cluster tests            | 0         | 3 files (E2E-1, E2E-6, E2E-WIRE-1)               |
| Integration cluster tests    | 5         | 9 (added INT-11, INT-12 + 2 others as int-level) |
| Chaos tests                  | 0         | 1 (INT-12 @chaos, graceful failover mid-scan)    |

### Remaining Gaps (after Round 2)

- **E2E-2** (cross-pod pub/sub chaos): Deferred — requires two-pod WebSocket simulation
- **E2E-3** (agent transfer HTTP): Deferred — requires full agent pipeline + LLM mock
- **E2E-ERR-1** (Studio UI form errors): Deferred — requires Playwright + Studio dev stack
- **INT-3** (createBullMQPair failover survival): Watchdog unit tests cover GAP-008; full cluster failover integration pending
- **INT-10** (Lua BUSY timeout): Pending — requires script-injection harness
- **Phase 5** (production rollout): Tier-M/L/XL helm flip; pending SIT validation

### Auditor Verdict (Round 2)

APPROVED (1 round). HIGH findings (PS-1 test count imprecision: 14→19 for session-redis, 22→21 for bullmq) resolved. MEDIUM findings (E2E-1 deviation in iteration log, README column semantics) resolved.

---

## Sync Round 3 — 2026-05-06 (Phase B PR-Review Fixes)

**Trigger**: PR #885 Phase B fix commits pushed — resolves 5 review findings discovered during `/pr-review` of the cluster E2E test suite. Phase-auditor (Round 3) identified a 6th missed file (`callback-delivery.test.ts`) which was fixed in the same sync round.

### Documents Updated

- [x] Feature spec `docs/features/redis-dual-mode.md`:
  - §10 Domain/Core Logic: added `distributed-lock.ts` (LuaScript fix) and `singleton.ts` (getRedisInitError) rows
  - §10 Jobs/Workers: added `outbox-poller.ts` and `trigger-scheduler.ts` DI rows; updated `redis-client.ts` row (cluster-safe del + getdel type fix)
  - §10 Tests: added 5 cluster E2E test files (E2E-1, E2E-6, INT-11, INT-12, E2E-WIRE-1) + 2 vitest config files
  - §17 Testing Notes: added DI pattern note + vitest tier correction note
- [x] Test spec `docs/testing/redis-dual-mode.md`:
  - §10 Iteration Log: added Round 3 (Phase B fixes — DI, cluster-safe del, LuaScript type, getRedisInitError, vitest tiers)
- [x] Testing index `docs/testing/README.md`:
  - Row 102: status note updated to mention Phase B fixes
- [x] HLD `docs/specs/redis-dual-mode.hld.md`:
  - Post-Implementation Notes (2026-05-06): 7-item Phase B fix summary added

### Coverage Delta (Round 3)

| Type                       | Before | After                                                              |
| -------------------------- | ------ | ------------------------------------------------------------------ |
| Platform mock violations   | 5      | 0 (resolved via DI pattern for `createBullMQPairFn?` in 3 classes) |
| Cluster-safe paths         | —      | +1 (`redis-client.ts` del now per-key loop)                        |
| getRedisInitError export   | ❌     | ✅ (`packages/redis/src/singleton.ts` + index.ts)                  |
| LuaScript type compliance  | ❌     | ✅ (`distributed-lock.ts` now uses named `LuaScript` constants)    |
| Vitest tier correctness    | ❌     | ✅ (cluster/e2e globs recursive; routes/**tests** in correct tier) |
| E2E cluster test scenarios | 3      | 3 (unchanged — Phase B did not add new scenarios)                  |

### Remaining Gaps (after Round 3)

- **E2E-2** (cross-pod pub/sub chaos), **E2E-3** (agent transfer HTTP), **E2E-ERR-1** (Studio UI): Deferred
- **INT-3** (createBullMQPair failover), **INT-10** (Lua BUSY): Pending
- **Phase 5** (production rollout): Tier-M/L/XL helm flip pending SIT validation

### Auditor Verdict (Round 3)

APPROVED (1 round). HIGH finding PS-1 (`callback-delivery.test.ts` still had `vi.mock('@agent-platform/redis')`) resolved: added `CallbackDeliveryDeps.createBullMQPairFn?` DI dep to `callback-delivery-worker.ts` and removed the mock from the test. All 8 tests pass. MEDIUM finding PS-4 (getRedisInitError consumers not identified) acknowledged — no consumer exists yet; this is a forward-looking export for health-check endpoints in a follow-up feature.

---

## Sync Round 4 — 2026-05-06 (Phase B PR-Review Fixes — develop-branch gates)

**Trigger**: Full Phase A re-review of PR #885 using the develop-branch `/pr-review` skill (4 additional trigger-conditional gates: `reliability`, `scalability`, `observability`, `data-lifecycle`; 9 new sub-checks). Two findings identified; Phase B fixes applied and pushed as commit `780cd3e697`.

### Findings Fixed

| #   | Severity | Gate           | Finding                                                                                                                                                                    | Fix                                                                                           |
| --- | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | MEDIUM   | `scalability`  | `del(...keys)` in analytics-cache, definition-cache, and studio's invalidate-definition-cache throws CROSSSLOT in cluster mode (multi-key DEL across different hash slots) | Replaced with per-key loop `for (const k of keys) await client.del(k)` in all 3 files         |
| 2   | LOW      | `code-quality` | `emitEvent(event: any)` in `packages/circuit-breaker/src/redis-circuit-breaker.ts:322` weakens type safety where `BreakerEvent` union type is available                    | Added `type BreakerEvent` import; changed signature to `emitEvent(event: BreakerEvent): void` |

### Files Changed

- `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts` — `del(...keys)` → per-key loop
- `packages/pipeline-engine/src/pipeline/services/definition-cache.ts` — `del(...keys)` → per-key loop
- `apps/studio/src/lib/invalidate-definition-cache.ts` — `del(...keys)` → per-key loop
- `packages/circuit-breaker/src/redis-circuit-breaker.ts` — `any` → `BreakerEvent` (+ import)

### New Gate Results (all 4 new gates — PASS)

- **reliability**: timeouts on all outbound calls (15s callback, 5s session), circuit breaker package is primary deliverable, BullMQ exponential backoff, idempotent operations (`NX` flag, `completeBranch` per-key). PASS.
- **scalability**: no N+1, `scanKeys` bounded by `maxKeys`, all Maps operationally bounded, connections are startup singletons. MEDIUM finding (multi-key del) now FIXED.
- **observability**: 6 OTel counters, `createLogger()` throughout, pessimistic `initialized = false` default, `pingRedis()` health check in workflow-engine. PASS.
- **data-lifecycle**: N/A — no new DB models, no new PII fields; all Redis keys have explicit TTLs.

### Remaining Gaps (after Round 4)

- **E2E-2** (cross-pod pub/sub chaos), **E2E-3** (agent transfer HTTP), **E2E-ERR-1** (Studio UI): Deferred
- **INT-3** (createBullMQPair failover), **INT-10** (Lua BUSY): Pending
- **Phase 5** (production rollout): Tier-M/L/XL helm flip pending SIT validation

### Auditor Verdict (Round 4)

APPROVED. MEDIUM finding (3× multi-key `del()` CROSSSLOT) and LOW finding (`any` type in `emitEvent`) both resolved. All 18 trigger-conditional gates evaluated; all applicable gates PASS. PR is ready to merge.

---

## Round 5 — Whole-Codebase Data-Flow Audit Sync (2026-05-10)

**Trigger**: User requested a fresh `/post-impl-sync` after running two more rounds of `data-flow-audit` (rounds 3+4) over the entire codebase, not just the dual-mode feature surface. The audit caught five CRITICAL cross-slot pipelines plus a HIGH config-coercion bug — all closed in the same change set.

### Documents Updated

- [x] **Feature spec** (`docs/features/redis-dual-mode.md`):
  - `Last Updated` 2026-05-06 → 2026-05-10.
  - §10 added 8 file rows for the 2026-05-10 reshapes (trace-store, session-recovery, bulk-crawl, intelligence, env-mapping, 2× admin coerceValue copies).
  - §16 added GAP-009 (cross-slot pipelines, Mitigated), GAP-010 (coerceValue REDIS_URL split, Mitigated), GAP-011 (CONFIG SET notify-keyspace-events, Documented).
  - §17 added rows 13–17 for the new regression tests + the two unit-test gaps that remain open.

- [x] **Test spec** (`docs/testing/redis-dual-mode.md`):
  - `Status` IN PROGRESS → PARTIAL; `Last Updated` 2026-05-06 → 2026-05-10.
  - Coverage matrix: added GAP-009 (PARTIAL) and GAP-010 (TESTED) rows.
  - §4 added UT-GAP-010, UT-GAP-009-A, UT-GAP-009-B and a UT-GAP-009-GAPS callout for the bulk-crawl + intelligence unit-test gaps.
  - §10 Iteration Log: appended 2026-05-10 entry with reshape table, coverage delta, deviations, gaps.

- [x] **Testing index** (`docs/testing/README.md`):
  - `Last Updated` 2026-05-07 → 2026-05-10.
  - Row 102 (Redis Dual-Mode): unit count bumped (+5 cross-slot regression unit tests, 2 gaps); status banner switched to PARTIAL 05-10 with audit summary.

- [x] **HLD** (`docs/specs/redis-dual-mode.hld.md`):
  - Appended a new "Post-Implementation Notes (2026-05-10) — Whole-Codebase Data-Flow Audit (Rounds 3+4)" section listing every site, the reshape, and standalone-parity verification.

- [x] **LLD** (`docs/plans/2026-05-04-redis-dual-mode-impl-plan.md`):
  - `Status` updated to reference the closed Rounds 3+4 audit and the audit log path.
  - `Last Updated` 2026-05-05 → 2026-05-10.

### Coverage Delta (Round 5 only)

| Type                                                      | Before (post-Round 4) | After (post-Round 5)                               |
| --------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| Unit tests — coerceValue cluster URL (GAP-010)            | 0                     | 2                                                  |
| Unit tests — trace-store split pipeline (GAP-009-A)       | 0                     | 1 (mock + assertion updated; full file 32/32 pass) |
| Unit tests — recovery parallel HGETALL/EXISTS (GAP-009-B) | 0                     | 2 (assertions rewritten; full file 6/6 pass)       |
| Cluster integration tests for the 5 reshape sites         | 0                     | 0 (recommended follow-up)                          |
| Open coverage gaps (carried)                              | 0 cross-slot          | 2 (bulk-crawl DEL, intelligence per-page GET)      |

### Production Code Changes (this round)

| File                                                              | Change                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/trace/redis-trace-store.ts`            | Split pipeline so `xadd+expire` target only the streamKey; `publish` is a separate top-level call.                                                                           |
| `packages/agent-transfer/src/session/session-recovery-service.ts` | HGETALL pipeline → `Promise.all` per session key. EXISTS pipeline → `Promise.all` per heartbeat. SREM pipeline (single set) preserved.                                       |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts`                 | Per-URL DEL pipeline → `Promise.all`.                                                                                                                                        |
| `apps/search-ai/src/routes/intelligence.ts`                       | Per-page GET pipeline → `Promise.all` with `[err, val]` shape preserved.                                                                                                     |
| `packages/config/src/env-mapping.ts`                              | `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}`; `coerceValue(value, envKey?)` skips comma-split when `envKey` is in the set; `mapEnvToConfig` threads `envKey` through. |
| `apps/admin/src/app/api/config/route.ts` and `…/diff/route.ts`    | Same guard added to the inlined Turbopack-workaround copies; "keep in sync" comment added.                                                                                   |

### Tests Updated / Added (this round)

- `apps/runtime/src/__tests__/redis-trace-store.test.ts` — mock now exposes top-level `publish`; assertion checks `mock.redis.publish`. 32/32 pass.
- `packages/agent-transfer/src/__tests__/unit/recovery-sscan-pipeline.test.ts` — assertions rewritten to verify `redis.hgetall` / `redis.exists` called per key (no pipeline). 6/6 pass.
- `packages/config/src/__tests__/env-mapping.test.ts` — added 2 regression tests for REDIS_URL + MONGODB_URI seed-list shape. 19/19 pass.

### Build Verification

`pnpm build --filter` green for `@agent-platform/{redis, config, agent-transfer, runtime, search-ai, admin}`.

### Deviations from Plan

None. The reshape is mechanically equivalent to the prior pipelines in standalone mode (no behavior change). Cluster mode now routes per-key as ioredis Cluster guarantees by contract.

### Remaining Gaps (after Round 5)

- **GAP-009 unit-test coverage** for `bulk-crawl-worker` and `intelligence.ts` per-page GET (cluster-safe paths). Carried forward as low-priority follow-up; both paths are best-effort cleanup with no callers depending on result shape.
- **GAP-009 cluster integration tests** against `tools/cluster-test-harness.ts` for any of the five reshape sites (no CROSSSLOT under cluster). Carried forward.
- **Existing items unchanged**: E2E-2, E2E-3, E2E-ERR-1 deferred; INT-3, INT-10 pending; Phase 5 helm flip pending SIT validation.

### Status

Feature stays at **ALPHA**. Promotion to BETA still depends on Phase 5 helm flip and SIT chaos validation; the dual-mode toggle now works end-to-end at the platform layer with no known cluster-mode CROSSSLOT or config-validation regressions.

**Audit log**: `docs/sdlc-logs/redis-dual-mode/data-flow-audit.md` (Rounds 3+4 appended).
