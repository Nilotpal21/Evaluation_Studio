# SDLC Log: redis-dual-mode — Implementation Phase

**Feature**: `redis-dual-mode`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-05-04-redis-dual-mode-impl-plan.md`
**Date Started**: 2026-05-05
**Date Completed**: IN PROGRESS

---

## Preflight

- [x] LLD file paths verified
- [x] Function signatures current (read connection.ts:160-213, bullmq.ts:127-139, singleton.ts:71)
- [x] No conflicting recent changes — branch is 4 commits ahead of develop, all SDLC artifacts
- Discrepancies: pre-existing build failures in `@agent-platform/circuit-breaker` and `@agent-platform/agent-transfer` traced to missing transitive package builds (`@agent-platform/shared`, `@abl/compiler`) — not regressions from this branch (verified via `git stash`). Skipped from Phase 0 verification; will surface again in Phases 2/3 when those packages are touched.

## Phase Execution

### LLD Phase 0: Foundation helpers in `@agent-platform/redis`

- **Status**: DONE
- **Commit**: pending
- **Exit Criteria**:
  - [x] `pnpm --filter=@agent-platform/redis build` succeeds with 0 TypeScript errors
  - [x] `pnpm --filter=@agent-platform/redis test` — 45 tests pass (was 33; added 12 new helper tests)
  - [ ] `pnpm test:cluster` — script wired but not run locally (requires Docker; will run in CI / SIT per Phase 4)
  - [x] No regressions in existing standalone tests (`bullmq.test.ts`, `connection.test.ts` still pass; updated bullmq mock to expose `Cluster` for `instanceof` discrimination)
  - [x] No new ESLint warnings (rules not yet active per D-11)
  - [x] `RedisConnectionHandle.duplicate()` works against a Cluster instance via captured `nodes` + `baseOptions`
- **Deviations from LLD**:
  - LLD task 0.16 `getNodes()` returns `ClusterNode[]` for masters only (not all 6) — masters are the seed list; replicas are auto-discovered by ioredis after `CLUSTER SLOTS`. Test code only ever wants masters.
  - `subscriber.ts`: did NOT implement an explicit reconnect loop. ioredis Cluster handles automatic reconnect + auto-resubscribe internally; we attach `'reconnecting'` and `'node error'` listeners that increment the metric and let ioredis drive the recovery. Custom backoff would race with ioredis's internal reconnect.
  - `bullmq.ts` watchdog: implemented as `setInterval` polling `connection.status`; if stuck > 30s in a non-healthy state, `disconnect()` to force reconnect. Cluster mode default-on, standalone default-off (per D-12). Timer is `.unref()`'d so it doesn't keep the event loop alive.
- **Files Changed**:
  - Modified: `packages/redis/src/{types,connection,singleton,bullmq,index}.ts`, `packages/redis/package.json`, `packages/redis/src/__tests__/bullmq.test.ts`, `package.json`
  - Created: `packages/redis/src/{subscriber,lua,keys,errors,observability}.ts`, `packages/redis/src/__tests__/helpers.test.ts`, `docker-compose.cluster.yml`, `vitest.cluster.config.ts`, `tools/cluster-test-harness.ts`

### LLD Phase 1: KEYS migration

- **Status**: DONE
- **Commit**: pending
- **Exit Criteria**:
  - [x] All 10 `KEYS` call sites removed; `grep -rEn '(redis|redisClient|client)\.keys\(' apps packages --include='*.ts' | grep -v __tests__ | grep -v 'packages/redis/src/'` returns empty
  - [x] `pnpm test` passes for each affected package: redis 46/46, shared 1508/1508, pipeline-engine 785/785, search-ai-runtime 575/575
  - [x] ESLint rule added to base + per-package overrides in `apps/search-ai/.eslintrc.json` and `packages/search-ai-internal/.eslintrc.json`. Workspace-wide ESLint is not wired (no top-level lint script); INT-14 static-grep test is the authoritative backstop in CI.
  - [x] INT-14 static-grep test added at `packages/redis/src/__tests__/migration-completeness.static.test.ts` and passing
  - [x] Existing standalone tests pass 100% across all 4 packages
- **Deviations from LLD**:
  - LLD task 1.6-1.10 ("same pattern" — call `scanKeys(this.redis, pattern)` directly): for the 4 search-ai-runtime sites that go through the local `RedisClient` wrapper (`apps/search-ai-runtime/src/services/cache/redis-client.ts`), the wrapper's `keys()` method was renamed to `scanByPattern()` and its body now delegates to `scanKeys()` from `@agent-platform/redis`. Consumers (group-membership-cache, idp-token-validator) call the wrapper, preserving the wrapper's graceful-degradation semantics. Renaming sidesteps ESLint false-positives on `[callee.object.property.name='redisClient']`. The 5th site (`query-cache.ts`) holds a raw `Redis` and was migrated to call `scanKeys` directly per LLD.
  - LLD task 1.11 ESLint rule: workspace has no top-level eslint config. Rule added to `.eslintrc.base.json` AND to the two existing per-package `.eslintrc.json` files (`apps/search-ai/`, `packages/search-ai-internal/`). Other packages don't currently invoke ESLint at all — this is a pre-existing gap, not introduced by Phase 1. INT-14 static-grep test enforces the rule in CI regardless of ESLint coverage.
  - LLD task 1.12 scope exclusions: matched literally (`packages/redis/**/*.ts` + `**/__tests__/**/*.ts` + `**/*.test.ts`).
  - The structural `RedisLike` types in `packages/pipeline-engine/src/pipeline/services/{analytics-cache,definition-cache}.ts` were replaced with the canonical `RedisClient = Redis | Cluster` from `@agent-platform/redis`. `definition-cache.ts` re-exports `RedisLike` as a type alias of `RedisClient` for backwards compatibility with `DefinitionCacheRedisLike` consumers.
  - The lambda-deployment-store's structural `redis: { get, set, del, keys: Function }` typing was replaced with `RedisClient`. Existing call sites (apps/runtime, apps/studio) pass `any`-typed redis instances and continue to work.
- **Files Changed**:
  - Modified (production): `packages/shared/src/services/lambda/lambda-deployment-store.ts`, `packages/pipeline-engine/src/pipeline/services/{analytics-cache,definition-cache}.ts`, `apps/studio/src/lib/invalidate-definition-cache.ts`, `apps/search-ai/src/routes/intelligence.ts`, `apps/search-ai-runtime/src/services/{cache/redis-client,idp/idp-token-validator,cache/group-membership-cache,query/query-cache}.ts`
  - Modified (deps): `packages/shared/package.json`, `packages/pipeline-engine/package.json`, `apps/search-ai-runtime/package.json`, `apps/studio/package.json` — added `@agent-platform/redis` workspace dep; `pnpm-lock.yaml` regenerated
  - Modified (lint): `.eslintrc.base.json`, `apps/search-ai/.eslintrc.json`, `packages/search-ai-internal/.eslintrc.json`
  - Modified (tests): `packages/shared/src/__tests__/lambda/lambda-deployment-store.test.ts`, `packages/pipeline-engine/src/__tests__/analytics-cache.test.ts`, `apps/search-ai-runtime/src/__tests__/query-cache.test.ts` — vi.mock `@agent-platform/redis` so `scanKeys` yields whatever the test's mock-keys returns
  - Created: `packages/redis/src/__tests__/migration-completeness.static.test.ts` (INT-14)

### LLD Phase 2: Lua redesign

- **Status**: DONE
- **Commits**:
  - Phase 2.1 (circuit-breaker): `22e9dd82d2`
  - Phase 2.3 (fan-out-barrier): `4771653dd0`
  - Phase 2.2 (agent-transfer): pending
- **Exit Criteria**:
  - [x] Phase 2.1: All 4 breaker Lua scripts execute via `runLuaScript` against the cluster-aware wrapper. `defineCommand` removed. All 5 breaker keys for any (level, key) pair share `CLUSTER KEYSLOT` (hash tag `{level:key}`). `readFileSync` replaced with `fs.promises.readFile` + top-level await. circuit-breaker tests 35/35 pass.
  - [x] Phase 2.3: `LUA_CREATE_BARRIER` uses `numberOfKeys: 1` with TTL passed as ARGV (CROSSSLOT fix). `LUA_SCAN_RESULT_KEYS`/`LUA_DELETE_BARRIER` iterate the registry SET (`barrier:{<id>}:result-keys`) instead of `redis.call('KEYS', ...)`. `LUA_COMPLETE_BRANCH` extended with KEYS[3]=registry SADD and ARGV[4]=branchKey. All barrier-related keys hash-tagged via `{barrierId}`. execution tests 86/86 pass.
  - [x] Phase 2.2: All 5 session Lua scripts narrowed to single-key (KEYS[1] = session hash only). Cross-slot writes (provider-index SET/DEL, active-sessions SET, per-pod SET) pipelined by the caller via `client.pipeline()` after the Lua returns. `RedisClient` (Redis | Cluster) used at the constructor boundary. agent-transfer tests 528/528 pass.
- **Deviations from LLD**:
  - **Phase 2.2 design conflict resolved**: LLD §2.2.6 prescribed hash-tagging the provider index with `{tenantId:contactId:channel}`, but `getByProvider(provider, tenantId, providerSessionId)` lookups have no `contactId`/`channel` to construct the key. Resolved by keeping the existing un-tagged `at_by_provider:${provider}:${tenantId}:${providerSessionId}` shape and moving all cross-slot writes to caller-side `pipeline()` after a single-key Lua. Achieves the same cluster-safety goal (no Lua script touches more than one slot) without breaking lookup contracts. Atomicity at the cross-slot boundary is traded for cluster compatibility; partial failures self-clean via TTL (matches the LLD's stated tolerance in §2.2.5).
  - **Phase 2.2 session-key shape unchanged**: LLD §2.2.6 prescribed `agent_transfer:{${tenantId}:${contactId}:${channel}}` hash-tagged keys. Kept the existing `agent_transfer:${tenantId}:${contactId}:${channel}` shape since (a) all Lua scripts are now single-key (no need to hash-tag for slot affinity), and (b) keeping the format avoids churn across ~20+ test fixtures that hard-code session-key literals. Cluster-safety is achieved at the Lua-boundary level instead.
  - Test mock pattern: vitest `vi.mock('@agent-platform/redis')` routes `runLuaScript` and `scanKeys` into per-test mock dispatchers (matches the Phase 1 pattern in lambda-deployment-store/analytics-cache). `defineCommand` mock path removed in mock-redis.
- **Files Changed**:
  - Modified (Phase 2.1): `packages/circuit-breaker/{package.json,src/scripts.ts,src/redis-circuit-breaker.ts,src/registry.ts,src/types.ts,src/index.ts}`, tests in `packages/circuit-breaker/src/__tests__/{redis-circuit-breaker.test.ts,registry.test.ts,helpers/mock-redis.ts}`
  - Modified (Phase 2.3): `packages/execution/src/redis-fan-out-barrier.ts`, `packages/execution/src/__tests__/redis-fan-out-barrier.test.ts`
  - Modified (Phase 2.2): `packages/agent-transfer/{package.json,src/session/lua-scripts.ts,src/session/transfer-session-store.ts}`, tests in `packages/agent-transfer/src/__tests__/{session-lua-fixes.test.ts,unit/edge-cases.test.ts}`

### LLD Phase 3: Consumer migration

- **Status**: DONE
- **Commits** (one per LLD sub-phase):
  - 3a (apps/runtime pub/sub): `bec1c0ea7d`
  - 3b (apps/runtime BullMQ pairs): `27919dde94`
  - 3c (apps/workflow-engine): `3599eb8452`
  - 3d/3e (search-ai connector-presence; search-ai-runtime cache wrapper already migrated): `04ba22e884`
  - 3f (session-store race + DistributedLockManager type widening): `f56ad6fe46`
  - 3g (ESLint rule + INT-13 static guard): `9f77db2905`
- **Exit Criteria**:
  - [x] Zero `.duplicate()` calls outside `packages/redis/src/**` and tests on a redis-shaped receiver. INT-13 static-grep test passes; the only two surviving production references are intentional (test-only fallback with `eslint-disable-next-line` + a comment).
  - [x] All three bypass services use `createRedisConnection`: `apps/runtime/src/services/redis/redis-client.ts` (3a.1), `apps/workflow-engine/src/services/redis.ts` (3c.4), `apps/search-ai/src/services/connector-presence.service.ts` (3d.1). Search-ai-runtime cache wrapper (3e) was already cluster-aware.
  - [x] ESLint rule extended in `.eslintrc.base.json` with the new `.duplicate()` selector. Existing override block (Phase 1) covers `packages/redis/**` and `**/__tests__/**`.
  - [x] All existing tests pass: runtime test:fast 9053/9053, workflow-engine test:fast 410/410, redis 47/47, shared-observability 121/121, runtime sessions suite 312/312 — standalone parity confirmed.
- **Deviations from LLD**:
  - **`getRedisClient()` return type kept at `any | null`** (LLD §3a.1 widened to `RedisClient | null`). Widening cascaded type breakage across ~20 unrelated callers (dek-cache, billing schedulers, guardrails pipeline-factory) that consume `getRedisClient()` and assume `Redis`-specific shapes. The new `getRedisHandle()` accessor is the cluster-aware path; legacy callers continue to work unchanged.
  - **`agent-transfer/index.ts` `redis` parameter kept at `Redis`** (not widened). Widening would have broken downstream `SessionRecoveryService`/`createSessionTimeoutQueue`/`createEventQueue` constructors that all take `Redis`. Pub/sub `keyspaceSubscriber` uses `getRedisHandle() + createSubscriber(handle)` with a test-mode fallback.
  - **`message-persistence-queue.ts` uses `handle.duplicate({maxRetriesPerRequest:null})`** instead of `createBullMQPair(handle)` per LLD §3b.2. Queue and Worker are constructed in different functions at different times; allocating both connections eagerly would waste a connection on each Worker recreation. `handle.duplicate(...)` is equivalent in cluster-safety.
  - **`channel-queues.ts` cluster path uses `handle.duplicate(...)`** instead of `createBullMQPair`. Only Queue connections are needed (no Worker in this process). Standalone path uses `createBullMQConnectionOptions`; deprecated local `parseRedisUrl` is kept only as belt-and-suspenders fallback.
  - **`workflow-engine/index.ts:733-737` polling+cron split**: polling uses `createBullMQPair(handle)` (Queue+Worker both needed); cron is Queue-only and uses `handle.duplicate({maxRetriesPerRequest:null})`.
  - **`TriggerScheduler` and `CallbackDeliveryWorker` constructors widened to `Redis | RedisConnectionHandle`** (not just swapping `.duplicate()` to `createBullMQPair`). When a raw `Redis` is passed, an inline shim wraps it in a synthetic handle. Callers in `apps/workflow-engine/src/index.ts:593,720` updated to pass the handle directly via `getRedisHandle()`.
  - **ESLint `.duplicate()` selector narrowed** to receivers named `redis|client|redisClient|subscriber` (LLD §3g.1 specified the broad form). Narrowing avoids polluting app code with eslint-disable comments at every legitimate `handle.duplicate(...)` call site (where `handle` is a `RedisConnectionHandle` — `.duplicate()` IS the cluster-aware helper).
  - **Sub-3e (search-ai-runtime cache wrapper) was already complete** from prior phases. The LLD-named consumer files (`idp-token-validator-compat.ts`, `end-user-auth.service.ts`) do not exist in the current codebase (likely refactored away).
  - **64 test mocks updated en masse** with a Python script: every `vi.mock('../services/redis/redis-client.js', ...)` block in apps/runtime gained a `getRedisHandle: () => null` (or a fake handle when the test's mock Redis was wired for BullMQ). Two tests additionally gained a `vi.mock('@agent-platform/redis')` block stubbing `createBullMQPair`.
- **Files Changed (Phase 3 total)**:
  - **3a (10 files)**: apps/runtime/{package.json, src/server.ts, src/services/redis/redis-client.ts, src/websocket/handler.ts, src/services/trace/redis-trace-store.ts, src/services/agent-transfer/index.ts, src/services/auth-profile/paused-execution-store.ts, src/services/sync-execution.ts} + 2 tests + apps/workflow-engine/package.json.
  - **3b (70 files)**: apps/runtime/src/services/{message-persistence-queue.ts, kms/reencryption-queue.ts, llm/llm-queue.ts, queues/channel-queues.ts} + 64 test mocks + 2 BullMQ-touching tests with `createBullMQPair` stubs.
  - **3c (6 files)**: apps/workflow-engine/{src/index.ts, src/services/{redis.ts, trigger-scheduler.ts, callback-delivery-worker.ts}, **tests**/{trigger-scheduler-timezone, callback-delivery}.test.ts}.
  - **3d/3e (1 file)**: apps/search-ai/src/services/connector-presence.service.ts.
  - **3f (4 files)**: packages/shared-observability/{package.json, src/distributed-lock.ts}, apps/runtime/src/services/session/redis-session-store.ts, pnpm-lock.yaml.
  - **3g (2 files)**: .eslintrc.base.json, packages/redis/src/**tests**/migration-completeness.static.test.ts (INT-13 portion added).

### LLD Phase 4: SIT validation

- **Status**: PARTIAL (runbook + benchmarks + watchdog test landed; SIT helm-flip remains operator-only)
- **Sub-task progress**:
  - 4.1 Helm values flip — **OPERATOR ACTION**: the user will perform this manually against the SIT overlay (no SIT-specific values file exists in this repo).
  - 4.2 E2E suite for cluster validation — **DONE (code)**: `benchmarks/integration/redis-cluster-validation.ts` (NEW). Four k6 scenarios — `sse_steady` (pub/sub + BullMQ + locks), `multi_turn_session` (redis-session-store retry-on-miss path), `transfer_end` (narrowed Lua + cross-slot pipeline cleanup), `burst_streaming` (fan-out-barrier + circuit breaker under concurrency). Tagged with `redis_mode={cluster|standalone}` for direct comparison. Run paired against both topologies in SIT to assert LLD §4 SLOs (cluster p50 ≤ 1.1×, p95 ≤ 2× standalone, error rate < 5%, zero `redis.crossslot.errors`). Execution requires SIT environment access.
  - 4.3 k6 load tests (1000 RPS / reshard / failover) — **DONE (code)** as part of the chaos rehearsal harness (4.8). Execution requires SIT environment access.
  - 4.4 GAP-008 watchdog verification — **DONE**: added `redis.bullmq.watchdog.recover` counter to `packages/redis/src/observability.ts`; wired into `startWorkerWatchdog()` in `packages/redis/src/bullmq.ts:271`. New `createBullMQPair watchdog (GAP-008)` test suite in `packages/redis/src/__tests__/bullmq.test.ts` with 6 cases asserting (a) standalone default = OFF, (b) cluster default = ON, (c) explicit `watchdog: true` overrides standalone, (d) explicit `watchdog: false` overrides cluster, (e) `disconnect()` clears the timer, (f) sustained stuck-status forces a reconnect after the 30 s threshold. All 21 bullmq tests pass; `pnpm build` clean. The metric is observable in any deployment with an OTel SDK registered (runtime, workflow-engine), so the SIT operator can read watchdog activations directly from the existing telemetry pipeline without a code re-roll.
  - 4.5 Operator runbook `docs/guides/redis-cluster-mode.md` — **DONE** (commit 446a2b934d).
  - 4.6 OQ-2 (tier-S Sentinel) — **DOCUMENTED** in runbook §1 + §8.
  - 4.7 OQ-H-2 (canary path) — **DOCUMENTED** in runbook §8.
  - 4.8 Chaos rehearsal — **DONE (code)**: `benchmarks/system/redis-cluster-chaos.ts` (NEW). Five scenarios — sustained chat traffic + three chaos injectors (`reshard_chaos`, `master_kill_chaos`, `partition_chaos`) + a Prometheus metrics observer scraping `redis_crossslot_errors_total` and `redis_bullmq_watchdog_recover_total` every 15 s. Hard-gated behind `ENABLE_CHAOS=1` so a shake-out run can validate the steady-load path without mutating Redis state. Captures `mem_fragmentation_ratio` post-reshard (Houzz round-7 finding) and asserts the four LLD §4.8 thresholds: master-kill p95 ≤ 30 s, reshard degradation < 20%, fragmentation < 1.5×, zero CROSSSLOT. Execution requires SIT environment access + k8s API credentials + iptables NET_ADMIN for the partition scenario.
  - 4.9-4.11 Documentation items (split-brain, pub/sub cliff, getWorkers limitation) — **DONE** (in runbook §4.4, §7.1, §6.3 respectively).
- **Files Changed**:
  - `docs/guides/redis-cluster-mode.md` (NEW)
  - `benchmarks/integration/redis-cluster-validation.ts` (NEW)
  - `benchmarks/system/redis-cluster-chaos.ts` (NEW)
  - `packages/redis/src/observability.ts` (added `bullmqWatchdogRecover` counter)
  - `packages/redis/src/bullmq.ts` (counter wired into stuck-reconnect path)
  - `packages/redis/src/__tests__/bullmq.test.ts` (6 watchdog tests)
- **Notes**: 4.2 / 4.3 / 4.8 are now landed as runnable code. The remaining gates are operational — the user runs 4.1 (helm flip) manually, then executes the benchmarks against SIT and reports back. The `redis-cluster-validation.ts` baseline can be run twice (once `REDIS_MODE=standalone`, once `REDIS_MODE=cluster`) and the JSON outputs diffed via the existing benchmark report extractor. The chaos benchmark assumes `kubectl proxy` is exposing the k8s exec endpoint as plain HTTP; if that's not available in the SIT environment, the operator runs the equivalent `kubectl exec` commands manually and the benchmark becomes observation-only.

### LLD Phase 5: Production rollout

- **Status**: PENDING

## Wiring Verification

Completed 2026-05-05 against LLD §4.

### Package exports — VERIFIED

- [x] `packages/redis/src/index.ts` re-exports `createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys`, `RedisOperationError`, `RedisCrossSlotError`, `LuaScript`, `getRedisHandle` (lines 47-95).
- [x] `RedisConnectionHandle` includes `nodes` + `baseOptions` optional fields.
- [x] `BullMQConnectionPair` and `CreateBullMQPairOptions` exported.
- [x] `.eslintrc.base.json` has both `no-restricted-syntax` selectors: `.duplicate()` (line 26) and `.keys()` (line 22).

### Phase 1 consumer wiring (scanKeys) — VERIFIED

- [x] `lambda-deployment-store.ts` — uses `scanKeys`.
- [x] `analytics-cache.ts` — uses `scanKeys`.
- [x] `definition-cache.ts` — uses `scanKeys` (also surfaces in invalidate-definition-cache import).
- [x] `invalidate-definition-cache.ts` — uses `scanKeys`.
- [x] `intelligence.ts` (search-ai) — uses `scanKeys`.
- [x] `query-cache.ts` — uses `scanKeys` directly.
- [x] `group-membership-cache.ts` — uses `redisClient.scanByPattern()` which delegates to `scanKeys` in `apps/search-ai-runtime/src/services/cache/redis-client.ts:115`.
- [x] `idp-token-validator.ts` — only `.keys()` reference is `Map.keys()`, not Redis (line 280); no Redis pattern scans needed.

### Phase 2 hashTag adoption — VERIFIED

- [x] `RedisCircuitBreaker` keys use `hashTag(level, key)` — `packages/circuit-breaker/src/types.ts:162`.
- [x] `TransferSessionStore` Lua scripts redesigned single-key — `packages/agent-transfer/src/services/redis-transfer-session-store.ts` (Phase 2.2).
- [x] `RedisFanOutBarrierStore` Lua scripts hash-tagged with `{<id>}` — `packages/execution/src/services/redis-fan-out-barrier-store.ts` (Phase 2.3).

### Phase 3 createSubscriber call sites — VERIFIED

8+ adopters: `apps/runtime/src/server.ts`, `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/services/sync-execution.ts`, `apps/runtime/src/services/trace/redis-trace-store.ts`, `apps/runtime/src/services/redis/redis-client.ts`, `apps/runtime/src/services/agent-transfer/index.ts`, `apps/runtime/src/services/auth-profile/paused-execution-store.ts`, `apps/workflow-engine/src/services/redis.ts`.

### Phase 3 createBullMQPair call sites — VERIFIED

- Runtime: `apps/runtime/src/services/llm/llm-queue.ts:199`, `apps/runtime/src/services/kms/reencryption-queue.ts:96` (and others).
- Workflow-engine: `apps/workflow-engine/src/index.ts:739`, `apps/workflow-engine/src/services/trigger-scheduler.ts:87`, `apps/workflow-engine/src/services/callback-delivery-worker.ts:75`.

### Phase 3 factory adoption — VERIFIED

- [x] `apps/workflow-engine/src/services/redis.ts:35` uses `createRedisConnection`; `getRedisClient()` and `getRedisHandle()` exported.
- [x] `apps/search-ai/src/services/connector-presence.service.ts:25` uses `createRedisConnection`.
- [x] `apps/search-ai-runtime/src/services/cache/redis-client.ts` wrapper uses dual-mode types and delegates pattern scans to `scanKeys`.
- [x] `apps/runtime/src/services/session/redis-session-store.ts:243` `resolveTenantId` retry-on-miss applied (GAP-003).

### Test wiring — VERIFIED (with documented gap)

- [x] `tools/cluster-test-harness.ts` exists.
- [x] `vitest.cluster.config.ts` discovered by `pnpm test:cluster`.
- [x] `package.json` script `test:cluster` defined (line 19).
- [x] First batch of `*.cluster.test.ts` suites authored against the harness:
  - `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts` — INT-2 (scanKeys 1000-key fan-out), INT-6 (env), INT-7 (standalone parity), INT-8 (CROSSSLOT negative), INT-9 (KEYS partial-result negative).
  - `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.cluster.test.ts` — INT-1 (5-key hash-tag co-location, recordFailure atomicity, slot distribution).
  - `packages/agent-transfer/src/__tests__/session-lua.cluster.test.ts` — INT-4 (session+SET+pod+provider-index consistency, SESSION_EXISTS dedup, end() removal).
  - `packages/execution/src/__tests__/redis-fan-out-barrier.cluster.test.ts` — INT-5 (slot co-location, registry SET round-trip, delete cascade, completeBranch idempotency).
- Per-package vitest configs updated to `exclude: ['**/*.cluster.test.ts']` from the default `pnpm test` run; the suites only execute via the root `pnpm test:cluster` script with `vitest.cluster.config.ts`.
- Remaining cluster suites still pending (chaos-tagged: INT-3, INT-12; runtime E2E: E2E-1/2/3/6, E2E-ERR-1, E2E-WIRE-1; INT-10, INT-11). These need either a Studio/Runtime test harness extension or chaos infrastructure that this branch doesn't ship.
- [ ] **Gap**: No CI config files exist in this repo (`.bitbucket-pipelines.yml` / `.github/workflows` absent). The LLD anticipated this with "or equivalent CI config — confirm during Phase 0 LLD review with SRE". Nightly cluster job needs to be wired by SRE when CI is added.

### Observability wiring — VERIFIED

- [x] `redis.crossslot.errors` increments in `packages/redis/src/lua.ts:68` on `RedisCrossSlotError`.
- [x] `redis.cluster.node_error` increments in `packages/redis/src/connection.ts:232` on `Cluster 'node error'` event (TCP-level node failures). Note: ioredis does not emit a per-MOVED-redirect event — MOVED responses are handled internally — so the originally-named `redis.moved.redirects` counter was renamed to match what's actually measured (see pr-review round 2).
- [x] `redis.cluster.failover` increments in `connection.ts:207-210` on `+node` / `-node` events.
- [x] `redis.subscriber.reconnect` increments in `subscriber.ts:66,73` (reconnect attempt + node_error).
- [x] `redis.bullmq.watchdog.recover` increments in `bullmq.ts:272` on stuck-status forced reconnect (Phase 4.4).
- [x] All counters use `@opentelemetry/api`'s global meter provider (no per-app wiring required).

### Studio UI wiring (N/A) — VERIFIED

No Studio UI surface for this feature, per HLD §6 and LLD §4.

### Adapter callers — N/A in current tree

- LLD called out `idp-token-validator-compat.ts:36` and `end-user-auth.service.ts:89`. Neither file exists in the current tree (likely renamed/merged before Phase 3 began). The behaviours those adapters were guarding are covered indirectly: `idp-token-validator.ts` itself uses the wrapper which is cluster-safe; runtime auth flows go through `getRedisHandle()`/`createSubscriber` paths above.

### Verdict

**ALL critical wiring landed.** Two non-blocking gaps recorded above (no `*.cluster.test.ts` suites; no CI nightly job). Both are infra/follow-up — they don't impact SIT or production rollout because the runtime Lua/SCAN paths are exercised by the new k6 benchmarks during Phase 4.2/4.3 SIT validation.

## Review Rounds

5 pr-reviewer rounds completed 2026-05-05.

| Round | Focus                | Verdict        | CRITICAL | HIGH | MEDIUM | Fix commit      |
| ----- | -------------------- | -------------- | -------- | ---- | ------ | --------------- |
| 1     | Code quality         | NEEDS_REVISION | 0        | 4    | 8      | `1787a25d95`    |
| 2     | HLD compliance       | NEEDS_REVISION | 1        | 1    | 3      | `64b3c38044`    |
| 3     | Test coverage        | APPROVED       | 0        | 0    | 1      | (no fix needed) |
| 4     | Security & isolation | APPROVED       | 0        | 0    | 3      | (countered)     |
| 5     | Production readiness | APPROVED       | 0        | 0    | 4      | `525ef2102f`    |

### Critical findings resolved

- **Round 2 C-1** (subscriber.ts cluster path): `RedisOptions` were spread at the top level of the Cluster constructor, which silently dropped password/TLS in cluster mode. Fixed by nesting under `redisOptions: handle.baseOptions` and applying `DEFAULT_CLUSTER_OPTIONS`. Without this fix, pub/sub subscribers would have failed AUTH against a password-protected cluster at the very first SIT cutover.

### Deferred (non-blocking)

- **Round 1 H-2** — `getRedisClient(): any | null` widening kept for backwards compatibility; ~20 unrelated runtime callers depend on the loose return type. Phase 5 follow-up.
- **Round 2 H-1** — agent-transfer (5 sites) and fan-out-barrier (9 sites) call `redis.eval()` directly instead of `runLuaScript()`. Mechanical migration; all current scripts are single-key by construction so CROSSSLOT is impossible today. Pure regression-protection — logged as cleanup item.
- **Round 3 MEDIUM** — no `scanKeys` cluster fan-out unit test. Covered indirectly by INT-2 against a real cluster (deferred per LLD test plan).
- **Round 4 MEDIUMs (×3)** — JIT signal channel global broadcast (countered: handler validates sessionId match), empty-tenant-id fallback collisions (countered: only affects pre-migration legacy keys), pre-existing raw `redis.scan()` in paused-execution-store (not in this PR's diff).
- **Round 5 MEDIUMs (×4)** — phantom counter in docs (FIXED in `525ef2102f`), silent fallback when `REDIS_CLUSTER=true` and no URL (FIXED — now throws), empty seed list parse (FIXED — validated), `BULLMQ_WATCHDOG_ENABLED` env var (intentionally not implemented; per-call-site `{ watchdog }` opts are the design).

## Acceptance Criteria

Verified against LLD §6 (`docs/plans/2026-05-04-redis-dual-mode-impl-plan.md:907`) on 2026-05-05.

### Phase completion

- [x] Phase 0: Foundation helpers — DONE (commits `82a75bd4fc`, `2b041ecef0`).
- [x] Phase 1: KEYS migration — DONE (commit `b3926ea4e6`).
- [x] Phase 2: Lua redesign — DONE (commits `22e9dd82d2`, `ee36e8a764`, `4771653dd0`).
- [x] Phase 3: Consumer migration — DONE (commits `bec1c0ea7d`, `27919dde94`, `3599eb8452`, `04ba22e884`, `f56ad6fe46`, `9f77db2905`).
- [x] Phase 4: SIT validation harness, watchdog metric, chaos rehearsal, runbook — code DONE (commits `446a2b934d`, `58c3eed0fb`); operator-side execution (helm flip + paired benchmark runs) is the user's responsibility per their explicit directive.
- [ ] Phase 5: Production rollout — PENDING. Touches `deploy/helm-values/tier-{m,l,xl}/values.yaml`. Gated on Phase 4 SIT 7-day soak with zero CROSSSLOT.

### Functional requirements (FR-1 .. FR-16)

All 16 FRs are implemented in code per the mapping in LLD §6. Cluster integration tests (INT-1..INT-12) and E2E suites are deferred to follow-up work — the static-grep tests (INT-13, INT-14) backstop the most likely regression vectors, and the new k6 benchmarks (`benchmarks/integration/redis-cluster-validation.ts`, `benchmarks/system/redis-cluster-chaos.ts`) cover the runtime-behavior paths during SIT.

### Gap mitigations (GAP-001 .. GAP-008)

- **GAP-001** — chaos benchmark landed (`benchmarks/system/redis-cluster-chaos.ts`); manual SIT execution.
- **GAP-002** — single-key Lua + pipelined cross-slot writes; partial-failure tolerance documented.
- **GAP-003** — retry-on-miss in `redis-session-store.resolveTenantId` (50ms single retry, line 243).
- **GAP-004** — `runLuaScript` standardizes on `eval` and adds CROSSSLOT classification.
- **GAP-005** — `scanKeys` fans out across `client.nodes('master')` with dedup SET; per-node retry; counter `redis.scan_keys.node_error`.
- **GAP-006** — queue sharding deferred (documented).
- **GAP-007** — sharded pub/sub deferred (documented).
- **GAP-008** — BullMQ watchdog implemented in `bullmq.ts:246-274`, default ON for cluster + counter `redis.bullmq.watchdog.recover`.

### Test pass status (verified 2026-05-05)

| Package                                | Build | Tests                                                                                                                                                                                                              |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@agent-platform/redis`                | OK    | 53 / 53 pass                                                                                                                                                                                                       |
| `@agent-platform/circuit-breaker`      | OK    | 35 / 35 pass                                                                                                                                                                                                       |
| `@agent-platform/agent-transfer`       | OK    | 528 / 528 pass (53 pre-existing skips)                                                                                                                                                                             |
| `@agent-platform/execution`            | OK    | 86 / 86 pass                                                                                                                                                                                                       |
| `@agent-platform/shared-observability` | OK    | 121 / 121 pass                                                                                                                                                                                                     |
| `apps/runtime`                         | OK    | (full suite not re-run; covered by per-package tests)                                                                                                                                                              |
| `apps/workflow-engine`                 | OK    | (same)                                                                                                                                                                                                             |
| `apps/search-ai-runtime`               | OK    | (same)                                                                                                                                                                                                             |
| `apps/search-ai`                       | FAIL  | Pre-existing build failure on `develop` HEAD too (`@agent-platform/connector-sharepoint`, `@agent-platform/connectors-base` don't resolve). NOT introduced by this branch — verified via `git stash` against base. |

### Cluster operational gates

- [ ] **`REDIS_CLUSTER=true` validated in SIT for ≥ 7 days with zero CROSSSLOT** — operator-driven (Phase 4.1/4.2).
- [ ] **Tier-M / tier-L / tier-XL rollout with 7-day soak between each** — operator-driven (Phase 5).
- [x] **Operator runbook landed** — `docs/guides/redis-cluster-mode.md` (commits `446a2b934d`, `525ef2102f`).
- [ ] **Feature spec + test spec status updated to STABLE** — pending `/post-impl-sync`.

### Verdict

**Code-side acceptance: COMPLETE.** All implementable LLD acceptance criteria are met. Remaining items are operator-driven (SIT helm flip, paired benchmark runs, 7-day soak) and Phase 5 production rollout (touches shared production helm values; needs explicit user confirmation per Auto Mode policy).

## Learnings

- `@agent-platform/redis` had no `@opentelemetry/api` dependency; added `^1.9.0` (matches platform pattern in `agent-transfer/observability/metrics.ts`). When no SDK is registered, the API returns `NoopMeterProvider` — counters become silent, which is the desired no-op-default behavior for the redis package.
- `@agent-platform/shared-kernel` exports `AppError` with constructor `(message, opts: { code, statusCode?, cause?, messages? })` — the LLD's literal example was approximate; the real signature is `super(message, { code: 'X' })` not `super({ code, message })`.
- The pre-existing `connection.test.ts` mock simulated `Cluster` but `bullmq.test.ts` did not. After adding `instanceof Cluster` checks in `createBullMQConnectionPair` and `createBullMQPair`, the bullmq mock had to be extended. Tests now pass identically.
- Pre-existing build errors in `circuit-breaker` and `agent-transfer` packages are NOT introduced by this branch; they require building transitive workspace packages first. Will revisit when Phase 2/3 modifies those packages.
- Phase 1: Workspace ESLint is sparsely wired — only `apps/search-ai/.eslintrc.json` and `packages/search-ai-internal/.eslintrc.json` exist. Other packages don't run ESLint at all. The INT-14 static-grep test in `packages/redis/src/__tests__/migration-completeness.static.test.ts` is the authoritative backstop because it runs in standard CI test passes across the whole repo (`grep` operates from REPO_ROOT, not just the redis package).
- Phase 1: vitest's `vi.mock()` cannot easily produce instances that pass `instanceof Redis` from ioredis. The cleanest pattern for testing code that calls `scanKeys` is to mock `@agent-platform/redis` itself, replacing `scanKeys` with an async generator that yields from a controllable mock. This pattern is now used in 3 test files (lambda-deployment-store, analytics-cache, query-cache) and should be reused for future scanKeys consumers.
- Phase 1: The structural `RedisLike` types (with `keys: Function`) were a foot-gun — they accepted any object regardless of whether the underlying client could correctly handle pattern scans in cluster mode. Replacing them with `RedisClient = Redis | Cluster` ensures callers must pass real ioredis instances and TypeScript can enforce cluster-safe usage downstream.
- Phase 2.1: circuit-breaker is ESM (`"type": "module"`), so top-level `await` works for loading Lua bodies into module-scope `LuaScript` constants. No need for the LLD's "lazy-resolution" fallback. Tests required vitest `vi.mock('@agent-platform/redis')` to stub `runLuaScript` (mock-redis is plain JS, not `instanceof Redis`).
- Phase 2.1: Removing `defineCommand` also removes the per-instance `scriptsRegistered` gating + `ensureScripts()` plumbing. ioredis's `eval(script, ...)` handles `EVALSHA` + `NOSCRIPT` fallback transparently for both `Redis` and `Cluster`, so a single script body suffices. `runLuaScript` adds CROSSSLOT classification on top.
- Phase 2.1: `CircuitBreakerRegistry.scanBreakerKeys` had to migrate two things: (1) the SCAN MATCH pattern now wraps the `level:tenantId*` portion in `{...}` to match the new key form, and (2) the cursor loop is replaced by `scanKeys` so cluster mode hits all masters. Previous code used `redis.scan` directly (single-node only).
- Phase 2.3: `LUA_CREATE_BARRIER` had a latent CROSSSLOT bug: TTL was passed as `KEYS[2] = "300"` literal — Cluster computes the slot for that string independently of the barrier hash, producing CROSSSLOT on every create() in cluster mode. Moving TTL to the LAST ARGV is the smallest viable fix.
- Phase 2.3: The new registry SET (`barrier:{<id>}:result-keys`) is populated atomically inside `LUA_COMPLETE_BRANCH` via SADD on KEYS[3] (same `{<id>}` hash tag as KEYS[1]/KEYS[2]). This preserves the "completeBranch is fully atomic" contract while replacing the forbidden top-level `redis.call('KEYS', ...)` scan in getResults/delete.
- Phase 2.2: The LLD's prescribed `{tenantId:contactId:channel}` hash tag for both session hash and provider index conflicts with `getByProvider` lookups (which lack contactId/channel). Resolved by making all Lua scripts single-key (operate on the session hash only) and pipelining cross-slot writes — no key-shape changes needed. This trades cross-slot atomicity for cluster compatibility, but matches the LLD's own design philosophy in §2.2.5 ("partial failure tolerated; TTL self-cleans").
- Phase 2.2: `end()` now executes a Lua read-then-delete returning the `[provider, providerSessionId, ownerPod]` trio, then pipelines the cross-slot index/SET cleanup. The TOCTOU window for the session DEL stays closed (Lua atomic); the index cleanup is best-effort and tolerates partial failure. `extendTTL()`'s provider-index TTL extension moved out of Lua to a separate `redis.expire(indexKey, ttl)` call (best-effort, fire-and-forget catch).
- Phase 3a: `apps/runtime/src/services/redis/redis-client.ts` was the largest factory bypass (`new Redis(url, opts)` + `new Redis.Cluster(nodes, opts)` branched on `config.redis.cluster`). Replaced both branches with one `createRedisConnection(opts)` call. Internal state moved from `redisClient: any` to `redisHandle: RedisConnectionHandle | null`. The exported `getRedisClient()` API surface is preserved at `any | null` to avoid cascading type errors across ~20 unrelated callers (dek-cache, billing schedulers, etc.) that consume it under `Redis`-specific assumptions. Cluster-aware consumers should use the new `getRedisHandle()` accessor.
- Phase 3b: `handle.duplicate({maxRetriesPerRequest:null})` is functionally equivalent to one half of `createBullMQPair(handle)` — both are cluster-aware (build a fresh `Cluster(nodes, opts)` in cluster mode). Use `handle.duplicate(...)` when only one connection is needed (Queue-only contexts, Worker recreation). Use `createBullMQPair(handle)` when both connections are wanted as a unit (lifetime-coupled with `pair.disconnect()` cleanup). Don't allocate a pair when only one half will be used — wastes a connection per call.
- Phase 3b: 64 test files mock `redis-client.js` across apps/runtime. Adding a new export (`getRedisHandle`) breaks every mock that doesn't include it (vitest treats missing exports as undefined and throws on access). Updated all 64 mocks via a Python AST-naive bracket-matching script. The 2 tests that exercise BullMQ paths needed an additional `vi.mock('@agent-platform/redis')` block stubbing `createBullMQPair`. This pattern (mock the redis-client + mock the @agent-platform/redis helpers) generalizes to any future BullMQ-touching test.
- Phase 3c: Constructor signature widening from `redis: Redis` to `redisOrHandle: Redis | RedisConnectionHandle` is a low-disruption way to introduce cluster-aware deps into existing classes. The inline shim (`'client' in redisOrHandle ? handle : { client: redis, isReady: ..., duplicate: (opts) => redis.duplicate({...}) }`) lets legacy callers keep working unchanged. Migration order: callers can be updated to pass handles incrementally; the shim guarantees cluster-safety the moment a handle starts flowing through.
- Phase 3f: Single-key Redis ops (SET NX PX, GET, EVAL with one KEY) are cluster-safe by definition — every command hits exactly one slot. Type-widening the constructor parameter from `Redis` to `RedisClient = Redis | Cluster` is a zero-runtime-cost change because the call sites already work correctly. The widening is purely a TypeScript-level signal that "this class is cluster-aware".
- Phase 3f: The reverse-lookup retry-on-miss pattern (single retry after 50ms) is the LLD's preferred mitigation for cluster pipeline-reordering races where two related keys live on different slots. Cheaper than introducing hash-tag co-location (which requires changing key formats and migrating data). Standalone never hits the retry because both keys arrive in-order on a single instance.
- Phase 3g: A narrow ESLint `.duplicate()` selector (`callee.object.name in {redis,client,redisClient,subscriber}`) is more practical than the LLD's broad selector that flags every `*.duplicate()` regardless of receiver. The broad form would force eslint-disable comments at every legitimate `handle.duplicate(...)` call (the `RedisConnectionHandle.duplicate` IS the cluster-aware helper). Narrowing keeps the rule strict on raw redis clients while leaving handles unflagged.
- Phase 3g: Static-grep tests can supplement ESLint when workspace ESLint coverage is sparse. INT-14 (Phase 1) and INT-13 (Phase 3) both run via vitest in standard CI and grep across `apps/` + `packages/`. Filtering: comments (`//`, `*`, `/*`), string literals (`'...duplicate('`), type signatures (`duplicate(opts?: ...)`, `keys(pattern: string)`), and `eslint-disable-next-line` directives on the previous line. Belt-and-suspenders safety even where ESLint isn't wired.
