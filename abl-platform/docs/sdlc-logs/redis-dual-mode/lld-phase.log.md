# LLD Phase Log — redis-dual-mode

**Slug**: `redis-dual-mode`
**Phase**: 4 of 6 (LLD)
**Owner**: Platform team
**Started**: 2026-05-04
**Worktree**: `.worktrees/redis-cluster-dual-mode`
**Branch**: `worktree-redis-cluster-dual-mode`
**Inputs**:

- Committed feature spec at `docs/features/redis-dual-mode.md`
- Committed test spec at `docs/testing/redis-dual-mode.md`
- Committed HLD at `docs/specs/redis-dual-mode.hld.md` (commit `06927a8bbd`)

---

## Oracle Phase

Oracle was skipped for the LLD. The HLD phase log noted that the `product-oracle` agent timed out during the previous SDLC step; the HLD captured the design decisions in §1-§9 and the test spec captured the test scenarios. The LLD work is file-level decomposition of those decisions, which is best done by reading the source directly. Auto-mode was active.

Source-grounding was performed directly:

- Read `packages/redis/src/{connection,bullmq,index,types,singleton}.ts`
- Read `packages/circuit-breaker/src/scripts.ts`
- Read `packages/agent-transfer/src/session/lua-scripts.ts`
- Read `packages/execution/src/redis-fan-out-barrier.ts`
- Grep-confirmed `.duplicate()` site count (~16 in apps/runtime, 7 in apps/workflow-engine, 2 in packages/redis/bullmq.ts)
- Grep-confirmed top-level `KEYS` site count (10 sites across 8 files)
- Read `.eslintrc.base.json` (existing `no-restricted-syntax` pattern)
- Verified two phantom paths from feature spec are absent on disk

## Audit Round 1 — lld-reviewer (NEEDS_CHANGES)

2 CRITICAL + 5 HIGH + 5 MEDIUM, all resolved:

- **CRITICAL #1**: Agent-transfer pipeline used `multi()` which throws `CROSSSLOT` in cluster mode for cross-slot keys. Fixed: D-5 + task 2.2.5 mandate `client.pipeline()` (per-key auto-routing, no atomicity); explicit code examples added.
- **CRITICAL #2**: `LUA_END_SESSION` narrowing would lose TOCTOU safety if caller pre-reads `provider`/`providerSessionId`/`ownerPod` outside Lua. Fixed: task 2.2.2 keeps the read-then-delete inside Lua, returning the tuple to the caller for the cross-slot pipeline.
- **HIGH**: Singleton lacked `getRedisHandle()` accessor; consumers couldn't obtain `RedisConnectionHandle` (with `nodes`/`baseOptions`). Fixed: new task 0.2b.
- **HIGH**: `message-bridge.ts:306` was a phantom path (zero `.duplicate()` calls). Fixed: removed from migration list with explanatory note.
- **HIGH**: `apps/runtime/src/services/redis/redis-client.ts:97-100` is a **fourth factory bypass** (constructs `Redis.Cluster` and `Redis` directly), not previously listed. Fixed: new task 3a.1 migrates it.
- **HIGH**: `singleton.ts:71` had `as Redis` cast on `.connect()` not addressed. Fixed: bundled into task 0.2b.
- **HIGH**: `LUA_CLAIM_SESSION` numberOfKeys reduction was ambiguous. Fixed: task 2.2.3 clarifies `numberOfKeys: 1`, ARGV unchanged, caller pipelines pod-set updates externally.
- **MEDIUM**: `scanKeys` dedupe Set unbounded. Fixed: JSDoc caveat per CLAUDE.md "in-memory Map needs bounds".
- **MEDIUM**: ioredis `Cluster` constructor cast too narrow. Fixed: task 0.2 widens to import `ClusterOptions` directly.
- **MEDIUM**: `runLuaScript` retry policy not documented. Fixed: task 0.6 documents no-retry on CROSSSLOT (programming error, not transient).
- **MEDIUM**: TraceStore emission missing on CROSSSLOT error. Fixed: task 0.6 specifies conditional `TraceStore.tryEmit` on error path.

## Audit Round 2 — lld-reviewer (NEEDS_CHANGES)

0 CRITICAL + 2 HIGH + 4 MEDIUM, all resolved:

- **HIGH**: Fan-out-barrier task 2.3.3 used a separate `multi()` for SADD instead of inlining inside existing `LUA_COMPLETE_BRANCH` Lua. Fixed: SADD added inside the existing Lua with new `KEYS[3]` for the registry SET; `numberOfKeys` 2 → 3.
- **HIGH**: ESLint custom-plugin infrastructure (`tools/eslint-rules/`) didn't exist in repo. Fixed: D-7 reversed to use `no-restricted-syntax` selectors directly in existing `.eslintrc.base.json` (mirrors existing `findById` pattern).
- **MEDIUM**: `channel-queues.ts` has zero `.duplicate()` calls — uses `parseRedisUrl` (fifth factory bypass). Fixed: task 3b.5 rewritten to use `createBullMQConnectionOptions` migration path.
- **MEDIUM**: Fan-out-barrier `RedisClient` is a local minimal interface, not the shared union. Fixed: task 2.3.5 clarified.
- **MEDIUM**: Circuit-breaker scripts have varying `numberOfKeys` (5/5/3/5). Fixed: task 2.1.2 lists exact values per script.
- **MEDIUM**: Cluster harness API didn't expose `getNodes()`. Fixed: task 0.16 adds `getNodes()` and `getUrl()`.

## Audit Round 3 — lld-reviewer (APPROVED with 3 MEDIUM)

- **MEDIUM**: `server.ts:2004` was in sub-3b (BullMQ) but the actual call is a pub/sub subscriber. Fixed: moved to sub-3a as new task 3a.8.
- **MEDIUM (cosmetic)**: HLD lint approach diverged from LLD. No code change; non-blocker.
- **MEDIUM (informational)**: `search-ai-runtime` cache wrapper already uses cursor SCAN. No code change needed; tracked as implementation note.

Round 3 returned APPROVED. All line-anchored patches verified against source files (25+ references re-checked).

## Audit Round 4 — phase-auditor (APPROVED with 4 MEDIUM)

- **MEDIUM XP-3**: Phase 2.1 "Files Touched" missed `types.ts` (where `breakerKeys()` lives). Fixed.
- **MEDIUM XP-3**: Phase 0 "Files Touched" missed `singleton.ts`. Fixed.
- **MEDIUM XP-1**: D-7 deviation from HLD §7 not flagged explicitly. Fixed: explicit deviation note added.
- **MEDIUM XP-3**: Fifth factory bypass discovered during LLD authoring not previously documented. Fixed: section 0 "Scope additions" appendix added.

Round 4 verified all 16 FRs and all 8 GAPs map to LLD tasks; all test scenarios (E2E + INT + UT + ERR) map to LLD tasks + test files; all HLD downstream consumers are covered; Phase 5 rollout matches HLD concern #10 exactly.

## Audit Round 5 — lld-reviewer (NEEDS_CHANGES, 1 CRITICAL + 2 MEDIUM)

- **CRITICAL**: `LUA_CREATE_BARRIER` (`packages/execution/src/redis-fan-out-barrier.ts:24-30`) passes TTL as `KEYS[2]` (string `"300"`). In cluster mode, `KEYS[1]` (barrier hash, slotted by `{barrierId}`) and `KEYS[2]` (literal `"300"`, slotted by hashing the string) are different slots → CROSSSLOT on every `create()`. Fixed: new task 2.3.0 moves TTL to ARGV, `numberOfKeys: 2 → 1`.
- **MEDIUM**: `LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` call sites need `numberOfKeys: 1 → 2` to pass the registry SET as second key. Fixed: tasks 2.3.1 and 2.3.2 expanded with explicit call-site changes and a `getRegistryKey()` helper.
- **MEDIUM**: Phase 0 has 17 sub-tasks (large for one session). Recorded; not split because each sub-task is small (10-30 LOC).

## Audit Rounds 6-8 — Parallel external-context audits

### Round 6 — platform audit (NEEDS_REVISION, 1 CRITICAL re-classified HIGH + 3 HIGH + 6 MEDIUM)

- **HIGH**: `observability.ts` reinvented metrics (custom `Counter`, `getCounter`, `setMetricsSink`) instead of using `@opentelemetry/api` directly (existing platform pattern in `packages/agent-transfer/src/observability/metrics.ts`). Fixed: task 0.9 replaced with direct OTel usage.
- **HIGH**: `errors.ts` should extend platform `AppError` (existing pattern: `CircuitOpenError extends AppError`). Fixed: section 1 errors.ts spec updated.
- **HIGH**: `readFileSync` async cascade not specified. Fixed: task 2.1.1 expanded with cascade through `getScripts()` / `registerScripts()`; lock decision (top-level await vs lazy resolve) at PR time.
- **HIGH (re-classed from CRITICAL)**: Fan-out-barrier `RedisClient` type clarification. Fixed: task 2.3.5 explicitly notes structural typing; one-line type-test in cluster integration test.
- **MEDIUM**: Phantom task 3a.7 (`sync-execution.ts` has no `.duplicate()` call). Fixed: task narrowed to comment-only update.
- **MEDIUM**: `DistributedLockManager` constructor `Redis` → `RedisClient` widening missing. Fixed: new task 3f.0.
- **MEDIUM**: `console.warn` violations in `redis-client.ts:48,118,176` not addressed in same-file edit. Fixed: task 3a.1 expanded with cleanup.
- **MEDIUM**: `LUA_END_SESSION` narrowed Lua should preserve `or ''` fallback for missing fields. Fixed: task 2.2.2 updated.
- **MEDIUM**: `LUA_UPDATE_SESSION` not mentioned (already cluster-safe single-key). Fixed: new task 2.2.4b.
- **MEDIUM**: ESLint `.keys()` selector would false-positive on `Object.keys(obj)`. Fixed: selector narrowed to specific receiver-name patterns; INT-14 grep is the authoritative backstop.

### Round 7 — industry research (6 RISK + 2 IMPROVEMENT + 2 GAP)

- **RISK**: `retryDelayOnFailover` rationale conflated with `retryDelayOnMoved` (ioredis #1189). Fixed: task 0.3 expanded with both options, `retryDelayOnMoved: 50` set explicitly.
- **RISK**: ioredis 5.9.x slots-cache infinite loop (#1766) and refresh failures after upgrade (#2071). Resolution: documented in task 0.3 + Phase 4 runbook covers `slotsRefreshInterval` mitigation if symptoms appear.
- **RISK**: BullMQ #2964 is more severe than the LLD's "conditional watchdog" suggests — it manifests reliably on every reconnect. Fixed: D-12 reversed to default `watchdog: true` for cluster mode.
- **GAP**: BullMQ `getWorkers()` undercount (#3340). Fixed: new task 4.11 — audit + document.
- **IMPROVEMENT**: BullMQ queue prefix must use hash-tag form. Fixed: task 0.5 documents `prefix: '{...}'` requirement.
- **RISK**: Pub/sub O(N) cost at scale (Redis #2672). Fixed: new task 4.10 — quantify threshold + document. GAP-007 follow-up reaffirmed.
- **RISK**: `cluster-require-full-coverage: 'no'` split-brain write-loss. Fixed: new task 4.9 — explicit runbook section.
- **GAP**: `enableOfflineQueue` memory pressure (ioredis #581). Fixed: task 0.3 documents trade-off.
- **IMPROVEMENT**: Chaos rehearsal before tier-M (Houzz retrospective). Fixed: new task 4.8 — explicit chaos exercise + jemalloc fragmentation gating.
- **IMPROVEMENT**: Pod-level canary within tier (Houzz / Inngest). Fixed: new task 5.4b + OQ-LLD-7.

### Round 8 — OSS library audit (no GPL candidates; 2 viable adoptions)

- **`cluster-key-slot` (Apache-2.0, 8.2M weekly DL)**: Adopted as dev-dependency for test slot-equality assertions. Replaces hand-rolled CRC16 comparison with one-liners.
- **`@testcontainers/redis` (MIT, 560k weekly DL)**: Optional adoption for harness lifecycle (saves ~1.5 dev-days; eliminates `docker-compose.cluster.yml`). Recorded as OQ-LLD-8; default chosen is `docker-compose.cluster.yml` for parity with existing platform pattern (`docker-compose.yml`).
- All other surfaces: no viable OSS replacement; build custom (~4.5 dev-days total).

## Decisions Captured in LLD

- **D-1**: Helper file structure — three new files (`subscriber.ts`, `lua.ts`, `keys.ts`) + extended `bullmq.ts`. Mirrors existing module shape.
- **D-2**: `createSubscriber` cluster path captures node list + base options on the handle; replays them via `new Cluster(...)`. Avoids ioredis private-API reflection.
- **D-3**: `runLuaScript` uses `client.eval()` exclusively; ioredis manages `EVALSHA` + `NOSCRIPT` fallback transparently.
- **D-4**: `scanKeys` cluster path uses `client.nodes('master')` + per-node SCAN with in-iterator dedupe Set.
- **D-5 (revised)**: Agent-transfer split-Lua uses `client.pipeline()` (NOT `multi()`) for cross-slot writes; per-session Lua keeps TOCTOU safety by reading-then-deleting inside same Lua and returning the tuple.
- **D-6**: Fan-out-barrier registry SET inside existing `LUA_COMPLETE_BRANCH` (atomic; no separate pipeline).
- **D-7 (revised)**: Two `no-restricted-syntax` selectors in existing `.eslintrc.base.json` — no custom ESLint plugin. Mirrors existing `findById` pattern.
- **D-8**: ioredis `Cluster` configured with `maxRedirections: 16`, `slotsRefreshTimeout: 1000`, `retryDelayOnFailover: 500`, `retryDelayOnMoved: 50`, `scaleReads: 'master'`, `enableOfflineQueue: true`.
- **D-9**: `BullMQConnectionPair.{queueConnection, workerConnection}` widened from `Redis` to `RedisClient`.
- **D-10**: `RedisConnectionHandle` adds optional `nodes` + `baseOptions` fields.
- **D-11**: Lint hooks introduced at end of Phase 1 (KEYS) and end of Phase 3 (duplicate) — not Phase 0 — so migration phases land without lint noise.
- **D-12 (revised)**: BullMQ watchdog default `true` for cluster mode (per round-7 #2964 severity), `false` for standalone.
- **D-13**: `readFileSync` remediation bundled into Phase 2.1 (same edit as `defineCommand` removal).
- **D-14**: `ClusterTestHarness` lives in `tools/cluster-test-harness.ts`; consolidates boot/flush/failover dance.

## Files Created / Modified

- Created: `docs/plans/2026-05-04-redis-dual-mode-impl-plan.md` (full LLD — 6 phases, 14 design decisions, 30+ new files in change map, 50+ modified files with line-anchored patches, complete wiring checklist, Round 6-8 findings appendix)
- Created: `docs/sdlc-logs/redis-dual-mode/lld-phase.log.md` (this file)

## Counts (Quality Gates)

| Gate                            | Required | Actual                                                                                       | Status |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------- | ------ |
| Implementation phases           | ≥ 2      | 6                                                                                            | ✅     |
| Design decisions                | ≥ 1      | 14                                                                                           | ✅     |
| File-level change map           | Required | Present (~30 NEW + ~50 MODIFIED with line anchors)                                           | ✅     |
| Wiring checklist                | Required | Comprehensive (package exports, P1/P2/P3 consumer wiring, test wiring, observability wiring) | ✅     |
| Acceptance criteria per phase   | All      | All 6 phases have measurable exit criteria                                                   | ✅     |
| FR traceability (FR-1..FR-16)   | All 16   | 16                                                                                           | ✅     |
| GAP coverage (GAP-001..GAP-008) | All 8    | 8                                                                                            | ✅     |
| Test scenario coverage          | All      | E2E + INT + UT + ERR all mapped                                                              | ✅     |
| Audit rounds                    | 5+3      | 8 (5 sequential + 3 parallel)                                                                | ✅     |
| Open questions                  | ≥ 1      | 8 (OQ-LLD-1..OQ-LLD-8 + carries from HLD)                                                    | ✅     |

## Open Questions Persisting Beyond This Phase

1. **OQ-LLD-1**: Confirm SIT helm-values path (assumed `deploy/helm-values/sit/values.yaml`).
2. **OQ-LLD-2**: `sync-execution.ts` `.duplicate()` caller audit — confirmed comment-only; covered by 3a.8.
3. **OQ-LLD-3**: `server.ts:2004` audit — confirmed pub/sub subscriber; covered by 3a.8.
4. **OQ-LLD-4**: ESLint scope (first-party only) — accepted default.
5. **OQ-LLD-5**: INT-3 chaos tagging (nightly-only) — accepted recommendation.
6. **OQ-LLD-6**: Carries forward HLD's persistent OQs (OQ-1 timeline, OQ-2 Sentinel direction, OQ-4 lint severity confirmed `error`, OQ-5 dashboard ownership, OQ-H-1/2/3).
7. **OQ-LLD-7** (NEW): Pod-level canary within tier — operational option pending Phase 4 SIT outcomes.
8. **OQ-LLD-8** (NEW): Cluster harness lifecycle — `@testcontainers/redis` vs `docker-compose.cluster.yml`. Default: docker-compose; implementer may switch during Phase 0.

## Next Phase

Run `/implement redis-dual-mode` to begin Phase 0 (foundation helpers in `@agent-platform/redis`). The implementation should:

- Start with Phase 0 (helpers + Docker harness + cluster integration tests for the helpers themselves) before any consumer migration.
- Verify line-anchored references against `git log -1` of each cited file immediately before touching it (CHANGELOG drift prevention).
- Apply the OSS dependencies recorded in Round 8: add `cluster-key-slot` as a dev-dependency.
- Phase 0 has 17 sub-tasks; consider splitting into 0A (source) and 0B (infrastructure + tests) at the implementer's discretion.

Per CLAUDE.md context-management: run `/compact` before invoking `/implement`.
